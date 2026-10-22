/**
 * Headless sanity checks for the world layout and the interaction/quest layer.
 * Run with:  npx tsx scripts/verify-world.ts
 *
 * This is deliberately outside src/ so it is never bundled into the game.
 */
import * as THREE from 'three';
import {
  villages, buildRoadNetwork, buildFarms, farms, roads, terrainHeight, waterDist,
  riverQuery, roadQuery, WATCHTOWER_SITES, WILDERNESS_SPECS, ALL_LOCATIONS, LAKE, FORT, WORLD_HALF,
  plazaRadius,
} from '../src/three/world/land';
import { InteractionSystem } from '../src/three/world/interactables';
import { buildVillage, planVillage, type BuildCtx } from '../src/three/world/villageBuilder';
import { buildFortIronspire, buildLakeEldermere, buildWhisperingWeald, buildGoldenMeadow, buildWatchtower } from '../src/three/world/wilderness';
import { Collector } from '../src/three/geometry';
import type { Obb } from '../src/three/buildings';

const t0 = performance.now();
buildRoadNetwork();
buildFarms();
const genMs = performance.now() - t0;

console.log('=== LAYOUT ===');
console.log(`world half: ${WORLD_HALF} m · settlements: ${ALL_LOCATIONS.length} (${villages.length} villages, ${WILDERNESS_SPECS.length} wild) · roads: ${roads.length} (${(roads.reduce((a, r) => a + r.length, 0) / 1000).toFixed(1)} km) · farms: ${farms.length}`);
console.log(`roads+farms generation: ${genMs.toFixed(0)} ms`);

let bad = 0;
for (const v of villages) {
  const h = terrainHeight(v.x, v.z);
  const wet = waterDist(v.x, v.z);
  const far = Math.hypot(v.x, v.z);
  const ok = Number.isFinite(h) && wet > 2 && far < WORLD_HALF - 300;
  if (!ok) bad++;
  console.log(
    `${ok ? 'ok ' : 'BAD'} ${v.id.padEnd(11)} (${String(v.x).padStart(5)},${String(v.z).padStart(5)}) r=${String(v.r).padStart(3)} ` +
    `centreY=${h.toFixed(1).padStart(7)} plateauY=${v.groundY.toFixed(1).padStart(7)} waterDist=${wet.toFixed(1)}`,
  );
}

for (const w of WATCHTOWER_SITES) {
  const h = terrainHeight(w.x, w.z);
  const wet = waterDist(w.x, w.z);
  const ok = Number.isFinite(h) && wet > 2;
  if (!ok) bad++;
  console.log(`${ok ? 'ok ' : 'BAD'} ${w.id.padEnd(18)} (${String(w.x).padStart(5)},${String(w.z).padStart(5)}) y=${h.toFixed(1)} waterDist=${wet.toFixed(1)}`);
}

let minH = Infinity;
let maxH = -Infinity;
let nan = 0;
let steep = 0;
for (let i = 0; i < 400; i++) {
  for (let j = 0; j < 400; j++) {
    const x = (i / 399) * 2 * WORLD_HALF - WORLD_HALF;
    const z = (j / 399) * 2 * WORLD_HALF - WORLD_HALF;
    const h = terrainHeight(x, z);
    if (!Number.isFinite(h)) nan++;
    minH = Math.min(minH, h);
    maxH = Math.max(maxH, h);
    if (h > 380) steep++;
  }
}
// each settlement must have a road reaching its square
for (const v of villages) {
  let best = Infinity;
  for (const r of roads) {
    for (const smp of r.samples) best = Math.min(best, Math.hypot(smp.x - v.x, smp.z - v.z));
  }
  if (best > 120) { bad++; console.log(`BAD ${v.id}: nearest road ${best.toFixed(0)} m away`); }
  else console.log(`ok  ${v.id.padEnd(11)} nearest road ${best.toFixed(0)} m from the square`);
}

// landmark spacing: no two named places may overlap
for (let i = 0; i < ALL_LOCATIONS.length; i++) {
  for (let j = i + 1; j < ALL_LOCATIONS.length; j++) {
    const a = ALL_LOCATIONS[i];
    const b = ALL_LOCATIONS[j];
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < a.r + b.r + 40) { bad++; console.log(`BAD overlap ${a.id} ↔ ${b.id} (${d.toFixed(0)} m)`); }
  }
}

console.log(`terrain samples: 160k · min ${minH.toFixed(0)} m · max ${maxH.toFixed(0)} m · NaN ${nan} · above 380 m: ${steep}`);
console.log(`watchtowers registered as locations: ${WILDERNESS_SPECS.filter((s) => s.type === 'watchtower').map((s) => s.id).join(', ')}`);

// --- height sampling throughput (chunk budget sizing) -------------------
const N = 20000;
const pts = new Float32Array(N * 2);
for (let i = 0; i < N; i++) {
  pts[i * 2] = (Math.random() * 2 - 1) * (WORLD_HALF - 500);
  pts[i * 2 + 1] = (Math.random() * 2 - 1) * (WORLD_HALF - 500);
}
const b0 = performance.now();
let acc = 0;
for (let i = 0; i < N; i++) acc += terrainHeight(pts[i * 2], pts[i * 2 + 1]);
const bMs = performance.now() - b0;
console.log(`\n=== PERF ===\nterrainHeight: ${N} samples in ${bMs.toFixed(0)} ms → ${(bMs / N * 1000).toFixed(2)} µs/sample (checksum ${acc.toFixed(0)})`);
const perChunk = (bMs / N) * (43 * 43 * 2); // heights + groundColor→riverQuery
console.log(`estimated terrain cost per 300 m chunk (43² samples ×2): ~${perChunk.toFixed(1)} ms`);

// --- interaction + quest engine ---------------------------------------
console.log('\n=== INTERACTION ===');
const mat = () => new THREE.MeshStandardMaterial();
const mats: Record<string, THREE.Material> = {
  stone: mat(), plaster: mat(), wood: mat(), flat: mat(), cobble: mat(),
  thatch: mat(), rock: mat(), slate: mat(), tiles: mat(),
};
const inter = new InteractionSystem(mats);
console.log(`interior cells: ${[...inter.cells.keys()].join(', ')} · interactables: ${inter.all.length}`);

// register an exterior door on a fictional cottage at the plaza edge
inter.registerDoor({
  id: 'door_test', title: 'Cathedral of St. Alder',
  x: 0, y: 0, z: 0, rot: 0, doorZ: 14.75, interior: 'cathedral',
});

const dialogueLog: string[] = [];
const questLog: string[] = [];
inter.onDialogue = (d) => { if (d) dialogueLog.push(`${d.speaker} :: ${d.questUpdate ?? d.title}`); };
inter.onQuestChange = (q) => questLog.push(q.map((x) => `${x.id}:${x.status}:${x.stepIndex}`).join(' | '));

const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);

function look(from: THREE.Vector3, at: THREE.Vector3) {
  cam.position.copy(from);
  cam.lookAt(at);
  cam.updateMatrixWorld();
  inter.update(cam);
}

// stand 2 m in front of the door looking at it
look(new THREE.Vector3(0, 1.7, 16.9), new THREE.Vector3(0, 1.4, 14.75));
console.log(`door detected: ${inter.activeTarget?.id ?? 'none'}`);

let teleported: string | null = null;
inter.interact((x, z, y) => { teleported = `${x.toFixed(0)},${z.toFixed(0)},${y.toFixed(1)}`; });
console.log(`entered: ${inter.currentInterior} · teleport → ${teleported} · group visible: ${inter.group.visible}`);
console.log(`interior ground: ${inter.interiorGroundHeight(12000, 0)} · walkable override: ${inter.interiorGroundHeight(12000, 0) !== null}`);

// walk to the NPC and talk (quest step 1)
const npc = inter.all.find((i) => i.id === 'npc_cathedral')!;
look(new THREE.Vector3(npc.pos.x, npc.pos.y, npc.pos.z + 2), npc.pos);
console.log(`npc detected: ${inter.activeTarget?.id ?? 'none'} (${inter.activeTarget?.title})`);
inter.interact(() => {});
console.log(`quests after talk: ${questLog.at(-1)}`);
console.log(`dialogue: ${dialogueLog.at(-1)}`);

// talk to the NPC again -> should be an ordinary greeting, step must not advance
inter.interact(() => {});
console.log(`double-talk step: ${questLog.at(-1)}`);

// exit
const ex = inter.all.find((i) => i.id === 'exit_cathedral')!;
look(new THREE.Vector3(ex.pos.x, ex.pos.y, ex.pos.z - 1.5), ex.pos);
console.log(`exit detected: ${inter.activeTarget?.id ?? 'none'}`);
inter.interact((x, z, y) => { teleported = `${x.toFixed(1)},${z.toFixed(1)},${y.toFixed(1)}`; });
console.log(`exited → ${teleported} · currentInterior=${inter.currentInterior} · group visible=${inter.group.visible}`);

// quest chain: tavern then keep should complete quest 1
inter.currentInterior = 'tavern';
const greta = inter.all.find((i) => i.id === 'npc_tavern')!;
look(new THREE.Vector3(greta.pos.x, greta.pos.y, greta.pos.z + 2), greta.pos);
inter.interact(() => {});
inter.currentInterior = 'keep';
const vane = inter.all.find((i) => i.id === 'npc_keep')!;
look(new THREE.Vector3(vane.pos.x, vane.pos.y, vane.pos.z + 2), vane.pos);
inter.interact(() => {});
const q1 = inter.quests.find((q) => q.id === 'q_reliquary')!;
console.log(`q_reliquary → ${q1.status} (step ${q1.stepIndex}/${q1.steps.length}) · ${dialogueLog.at(-1)}`);

// quest 2 chain: longhouse -> cottage
for (const id of ['npc_longhouse', 'npc_cottage'] as const) {
  const npc2 = inter.all.find((i) => i.id === id)!;
  inter.currentInterior = id === 'npc_longhouse' ? 'longhouse' : 'cottage';
  look(new THREE.Vector3(npc2.pos.x, npc2.pos.y, npc2.pos.z + 2), npc2.pos);
  inter.interact(() => {});
}
const q2 = inter.quests.find((q) => q.id === 'q_hearth_fires')!;
console.log(`q_hearth_fires → ${q2.status} (step ${q2.stepIndex}/${q2.steps.length}) · ${dialogueLog.at(-1)}`);

const doorOk = inter.all.filter((i) => i.kind === 'enter_interior').length > 0;


/* ------------------------------------------------------------------
 *  Build the real settlement + wilderness geometry headless and check
 *  that every registered door is actually reachable and that no door id
 *  collides with another.
 * ------------------------------------------------------------------ */
console.log('\n=== DOORS (real generation) ===');
{
  const mats2: Record<string, THREE.Material> = {};
  for (const k of ['stone', 'stoneDark', 'stoneDS', 'plaster', 'tiles', 'slate', 'thatch', 'wood', 'canvas', 'glass', 'glassChurch', 'lampglass', 'leaf', 'rock', 'water', 'fountainWater', 'cobble', 'dirt', 'packed', 'soil', 'flat', 'crop0', 'crop1', 'crop2', 'crop3', 'tuft0', 'tuft1', 'tuft2', 'tuft3', 'awning0', 'awning1', 'awning2', 'awning3']) {
    mats2[k] = mat();
  }
  const inter2 = new InteractionSystem(mats2);
  const obbs: Obb[] = [];
  const ctx: BuildCtx = {
    c: new Collector(),
    rng: mulberry(4242),
    obbs,
    trees: [],
    hedges: [],
    flowers: [],
    lamps: [],
    dynamics: [],
    theme: villages[0].theme,
    interactions: inter2,
    plaza: () => {},
  };
  villages.forEach((v, i) => {
    ctx.c = new Collector();
    ctx.theme = v.theme;
    buildVillage(v, planVillage(v, mulberry(1013 + i * 7717)), ctx);
  });
  const wctx = { c: new Collector(), rng: mulberry(77), obbs, trees: [], lamps: [], soldierPatrols: [], interactions: inter2 };
  buildLakeEldermere(wctx as never);
  buildWhisperingWeald(wctx as never);
  buildFortIronspire(wctx as never);
  buildGoldenMeadow(wctx as never);
  for (const site of WATCHTOWER_SITES) buildWatchtower(wctx as never, site);

  const byKind = inter2.all.reduce<Record<string, number>>((acc, it) => ({ ...acc, [it.kind]: (acc[it.kind] ?? 0) + 1 }), {});
  console.log(`interactables: ${JSON.stringify(byKind)} (total ${inter2.all.length}, buildings ${obbs.length})`);

  const ids = new Set<string>();
  let dupes = 0;
  for (const it of inter2.all) {
    if (ids.has(it.id)) { dupes++; console.log(`BAD duplicate id ${it.id}`); }
    ids.add(it.id);
  }

  // is any point inside a building (with the player's 0.65 m capsule)?
  const blocked = (x: number, z: number) => {
    for (const o of obbs) {
      const c = Math.cos(o.rot);
      const s = Math.sin(o.rot);
      const dx = x - o.cx;
      const dz = z - o.cz;
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      if (Math.abs(lx) < o.hw + 0.65 && Math.abs(lz) < o.hd + 0.65) return true;
    }
    return false;
  };
  let unreachable = 0;
  let badReturn = 0;
  for (const it of inter2.all) {
    if (it.kind !== 'enter_interior') continue;
    let free = false;
    for (let ring = 1; ring <= 3 && !free; ring++) {
      for (let a = 0; a < 24 && !free; a++) {
        const ang = (a / 24) * Math.PI * 2;
        const px = it.pos.x + Math.cos(ang) * ring * 0.7;
        const pz = it.pos.z + Math.sin(ang) * ring * 0.7;
        if (!blocked(px, pz) && Math.hypot(px - it.pos.x, pz - it.pos.z) <= it.radius) free = true;
      }
    }
    if (!free) { unreachable++; console.log(`BAD unreachable door ${it.id}`); }
    const r = it.returnDoor!;
    if (blocked(r.x, r.z)) { badReturn++; console.log(`BAD return point inside geometry for ${it.id}`); }
  }
  console.log(`doors: ${inter2.all.filter((i) => i.kind === 'enter_interior').length} · unreachable: ${unreachable} · blocked returns: ${badReturn} · duplicate ids: ${dupes}`);
  if (unreachable || badReturn || dupes) bad += 1;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log(`\nresult: ${bad === 0 && nan === 0 && q1.status === 'completed' && q2.status === 'completed' && doorOk ? 'PASS' : 'CHECK FAILURES ABOVE'}`);
