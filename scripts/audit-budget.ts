/*
 * Offline budget audit — the "measure before you optimise" step of
 * docs/game-ready-plan.md. Builds the real world headlessly and reports, per
 * layer, how many draw calls and triangles the renderer would submit if that
 * layer were fully visible.
 *
 *   npx tsx scripts/audit-budget.ts            # balanced preset, 3 viewpoints
 *   npx tsx scripts/audit-budget.ts --json     # machine-readable
 *
 * The online equivalent (renderer.info per group) lands in Step 1 of the plan;
 * this is the headless baseline it will be compared against.
 */
import * as THREE from 'three';
import {
  villages, buildRoadNetwork, buildFarms, roads, WATCHTOWER_SITES, terrainHeight, roadQuery,
} from '../src/three/world/land';
import { fbm } from '../src/three/noise';
import { buildVillage, planVillage, type BuildCtx } from '../src/three/world/villageBuilder';
import {
  buildFortIronspire, buildLakeEldermere, buildWhisperingWeald, buildGoldenMeadow, buildWatchtower,
} from '../src/three/world/wilderness';
import { InteractionSystem } from '../src/three/world/interactables';
import { Collector } from '../src/three/geometry';
import { createRoadMeshes } from '../src/three/world/chunks';
import { createTrees } from '../src/three/nature';
import type { Obb } from '../src/three/buildings';
import type { TreeSpec } from '../src/three/nature';

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface LayerStat { calls: number; tris: number }

function meshStats(o: THREE.Object3D, out: LayerStat) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry as THREE.BufferGeometry;
    const tri = g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
    const n = (m as THREE.InstancedMesh).isInstancedMesh
      ? (m as THREE.InstancedMesh).count
      : 1;
    out.calls += 1;
    out.tris += tri * n;
  });
}

function statsOf(o: THREE.Object3D): LayerStat {
  const s: LayerStat = { calls: 0, tris: 0 };
  meshStats(o, s);
  return s;
}

const MAT_KEYS = ['stone', 'stoneDark', 'stoneDS', 'plaster', 'tiles', 'slate', 'thatch', 'wood', 'canvas',
  'glass', 'glassChurch', 'lampglass', 'leaf', 'rock', 'water', 'fountainWater', 'cobble', 'dirt', 'packed',
  'soil', 'flat', 'crop0', 'crop1', 'crop2', 'crop3', 'tuft0', 'tuft1', 'tuft2', 'tuft3',
  'awning0', 'awning1', 'awning2', 'awning3'];

const t0 = performance.now();
buildRoadNetwork();
buildFarms();

const mats: Record<string, THREE.Material> = {};
for (const k of MAT_KEYS) mats[k] = new THREE.MeshStandardMaterial();
const inter = new InteractionSystem(mats);
const obbs: Obb[] = [];

// --- settlements ---------------------------------------------------------
const settlementRoot = new THREE.Group();
const settlementCollectors: Collector[] = [];
villages.forEach((v, i) => {
  const ctx: BuildCtx = {
    c: new Collector(), rng: mulberry(1013 + i * 7717), obbs, trees: [], hedges: [], flowers: [],
    lamps: [], dynamics: [], theme: v.theme, interactions: inter, plaza: () => {},
  };
  buildVillage(v, planVillage(v, mulberry(1013 + i * 7717)), ctx);
  settlementCollectors.push(ctx.c);
  for (const m of ctx.c.build(mats)) settlementRoot.add(m);
});

// --- wilderness landmarks ------------------------------------------------
const wildRoot = new THREE.Group();
{
  const wc = new Collector();
  const wctx = { c: wc, rng: mulberry(77), obbs, trees: [], lamps: [], soldierPatrols: [], interactions: inter };
  buildLakeEldermere(wctx as never);
  buildWhisperingWeald(wctx as never);
  buildFortIronspire(wctx as never);
  buildGoldenMeadow(wctx as never);
  for (const site of WATCHTOWER_SITES) buildWatchtower(wctx as never, site);
  for (const m of wc.build(mats)) wildRoot.add(m);
}

// --- roads ---------------------------------------------------------------
const roadGroup = createRoadMeshes({ cobble: null, dirt: null, stone: null } as never, roads);

// --- nature (the real scatter budget) ------------------------------------
/*
 * A single representative tile is not enough: forest density varies by an
 * order of magnitude across the map. This replays the acceptance test from
 * world.ts (forest probability from the same fbm, plus road clearing) on a
 * 25 m grid, so each tile around a viewpoint gets its own expected tree count.
 */
const TILE = 1200;
const WORLD_HALF = 4000;
const NEAR_R = 2400; // world.ts: tiles closer than this draw the near LOD
const FAR_R = 9500;

/** Probability that the scatter accepts a tree at (x, z) — mirrors world.ts. */
function treeChance(x: number, z: number) {
  const h = terrainHeight(x, z);
  if (h > 380) return 0;
  const forest = fbm(x * 0.00045 + 13, z * 0.00045 + 29, 3);
  const p = forest > 0.55 ? 0.55 : forest > 0.48 ? 0.14 : 0.03;
  if (roadQuery(x, z).d < 5) return 0;
  for (const v of villages) if (Math.hypot(x - v.x, z - v.z) < v.r + 50) return 0;
  return p;
}

/** Expected trees in a tile, from a 25 m sample grid (20000 scatter attempts). */
function treesInTile(tcx: number, tcz: number) {
  const step = 25;
  const x0 = tcx * TILE - TILE / 2;
  const z0 = tcz * TILE - TILE / 2;
  let sum = 0;
  let n = 0;
  for (let x = x0; x < x0 + TILE; x += step) {
    for (let z = z0; z < z0 + TILE; z += step) {
      sum += treeChance(x, z);
      n++;
    }
  }
  // density-independent: the expected count is the mean chance, not the sample
  // count, because the real scatter tries a fixed 20000 points map-wide
  return (sum / n) * TILE * TILE * (20000 / ((WORLD_HALF - 400) * 2) ** 2);
}

let treeSpecs: TreeSpec[] = [];
const TREE_TRI_NEAR = 130; // measured from createTrees: trunk + two canopies
const TREE_TRI_FAR = 8;

function natureForTile(): { callsNear: number; callsFar: number } {
  // build one sample tree set to read the real per-tile draw call counts
  treeSpecs = [];
  const rng = mulberry(4242);
  for (let i = 0; i < 400; i++) {
    const conifer = rng() < 0.45;
    treeSpecs.push({
      x: (rng() - 0.5) * TILE, z: (rng() - 0.5) * TILE, y: 0, scale: 1,
      kind: conifer ? 'conifer' : 'round', color: new THREE.Color(0xffffff), rot: 0,
    });
  }
  const g = createTrees(treeSpecs, mulberry(7));
  const s = { calls: 0, tris: 0 };
  meshStats(g, s);
  return { callsNear: s.calls, callsFar: 2 };
}

const perTileCalls = natureForTile();

function visibleNature(camX: number, camZ: number) {
  const r = Math.ceil(FAR_R / TILE) + 1;
  const tx = Math.round(camX / TILE);
  const tz = Math.round(camZ / TILE);
  let nearTiles = 0, farTiles = 0, nearTrees = 0, farTrees = 0;
  let calls = 0;
  for (let i = -r; i <= r; i++) {
    for (let j = -r; j <= r; j++) {
      const cx = (tx + i) * TILE;
      const cz = (tz + j) * TILE;
      const d = Math.hypot(cx - camX, cz - camZ);
      if (d > FAR_R) continue;
      const trees = treesInTile(tx + i, tz + j);
      if (trees < 1) continue;
      const near = d < NEAR_R;
      // far trees now come from 3 world-wide instanced meshes, not per tile
      if (near) { nearTiles++; nearTrees += trees; calls += perTileCalls.callsNear; }
      else { farTiles++; farTrees += trees; }
    }
  }
  calls += 3;
  return {
    calls,
    tris: nearTrees * TREE_TRI_NEAR + farTrees * TREE_TRI_FAR,
    nearTiles, farTiles,
    nearTrees: Math.round(nearTrees), farTrees: Math.round(farTrees),
  };
}

// --- report --------------------------------------------------------------
const fixed: Record<string, LayerStat> = {
  settlements: statsOf(settlementRoot),
  wilderness: statsOf(wildRoot),
  roads: statsOf(roadGroup),
};

// Three viewpoints, as in the plan's Step 1 exit test.
const viewpoints = [
  { name: 'Mildvar square', x: 0, z: 0 },
  { name: 'village lane', x: 0, z: -110 },
  { name: 'hilltop (600 m out)', x: 700, z: 700 },
];

const report = viewpoints.map((v) => {
  const nat = visibleNature(v.x, v.z);
  const layers: Record<string, LayerStat> = {
    ...fixed,
    [`nature (${nat.nearTiles} near tiles + 3 far batches)`]: { calls: nat.calls, tris: nat.tris },
  };
  const total = Object.values(layers).reduce((a, l) => ({ calls: a.calls + l.calls, tris: a.tris + l.tris }), { calls: 0, tris: 0 });
  return { name: v.name, layers, total, nat };
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ report, perTileCalls, genMs: performance.now() - t0 }, null, 2));
} else {
  const pad = (t: string, n: number) => t.padEnd(n);
  console.log(`\n=== VISIBLE-WORLD BUDGET (headless build, ${(performance.now() - t0).toFixed(0)} ms, from seed data) ===`);
  for (const r of report) {
    console.log(`\n${r.name}  ·  ${r.nat.nearTrees} near trees / ${r.nat.farTrees} far`);
    console.log(`${pad('  layer', 40)}${pad('draw calls', 12)}${pad('triangles', 14)}`);
    for (const [k, v] of Object.entries(r.layers)) {
      console.log(`${pad('  ' + k, 40)}${pad(String(v.calls), 12)}${pad((v.tris / 1000).toFixed(0) + 'k', 14)}`);
    }
    console.log(`${pad('  TOTAL', 40)}${pad(String(r.total.calls), 12)}${pad((r.total.tris / 1e6).toFixed(2) + 'M', 14)}`);
  }
  const worst = report.reduce((a, b) => (b.total.tris > a.total.tris ? b : a));
  console.log(`\nworst view: ${worst.name} · ${worst.total.calls} calls · ${(worst.total.tris / 1e6).toFixed(2)} M tris`);
  console.log(`budget (balanced preset): < 300 calls · < 2.0 M tris`);
  console.log(worst.total.calls < 300 && worst.total.tris < 2e6 ? 'WITHIN BUDGET' : 'OVER BUDGET — Step 1 + Step 2 of the plan are required');
}
