import * as THREE from 'three';
import { RNG } from '../noise';

export interface ScatterItem {
  x: number;
  z: number;
  y: number;
  scale: number;
  kind: 'round' | 'conifer' | 'rock' | 'bush' | 'stump';
  color: THREE.Color;
  rot: number;
}

export interface NatureTile {
  cx: number;
  cz: number;
  near: THREE.Group;
  casters: THREE.InstancedMesh[];
  shadow: boolean;
  lod: 0 | 1 | 2;
}

/**
 * Every tree outside the near-LOD bubble, drawn from three world-wide instanced
 * meshes instead of two meshes per tile. Per-tile far meshes cost ~194 draw
 * calls to draw 8-triangle trees; this costs 3.
 */
export interface FarForest {
  meshes: THREE.InstancedMesh[];
  /** Rebuild the visible set. `hidden` returns true for tiles drawn at near LOD. */
  update(hidden: (x: number, z: number) => boolean): void;
}

function jitter(g: THREE.BufferGeometry, amount: number, rng: RNG) {
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), p.getY(i), p.getZ(i));
    const l = v.length();
    v.normalize().multiplyScalar(l * (1 + (rng() - 0.5) * amount));
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export interface NatureSet {
  group: THREE.Group;
  tiles: NatureTile[];
  far: FarForest;
  stats: { round: number; conifer: number; rocks: number; bushes: number };
}

/**
 * Builds tile-grouped instanced meshes with two LODs so distant forests cost a
 * fraction of the triangles and whole tiles can be frustum / distance culled.
 */
export function buildNature(items: ScatterItem[], rng: RNG, tileSize = 1200): NatureSet {
  const group = new THREE.Group();
  const buckets = new Map<string, ScatterItem[]>();
  for (const it of items) {
    const key = `${Math.round(it.x / tileSize)},${Math.round(it.z / tileSize)}`;
    let arr = buckets.get(key);
    if (!arr) buckets.set(key, (arr = []));
    arr.push(it);
  }

  // --- detailed geometry
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.32, 2.4, 7);
  trunkGeo.translate(0, 1.2, 0);
  const canopyGeo = jitter(new THREE.IcosahedronGeometry(1.95, 1), 0.26, rng);
  canopyGeo.translate(0, 3.7, 0);
  const canopy2Geo = jitter(new THREE.IcosahedronGeometry(1.35, 1), 0.26, rng);
  canopy2Geo.translate(0.75, 4.75, 0.4);
  const cTrunkGeo = new THREE.CylinderGeometry(0.14, 0.3, 1.8, 6);
  cTrunkGeo.translate(0, 0.9, 0);
  const cone = (r: number, h: number, y: number) => {
    const g = new THREE.ConeGeometry(r, h, 8);
    g.translate(0, y, 0);
    return g;
  };
  const cones = [cone(1.75, 3.4, 2.7), cone(1.32, 3.0, 4.6), cone(0.86, 2.5, 6.3)];
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const bushGeo = jitter(new THREE.IcosahedronGeometry(1, 0), 0.35, rng);
  const stumpGeo = new THREE.CylinderGeometry(0.42, 0.52, 0.9, 8);
  stumpGeo.translate(0, 0.45, 0);
  // --- far LOD geometry (one primitive per tree)
  const farCanopy = new THREE.IcosahedronGeometry(2.3, 0);
  farCanopy.translate(0, 3.6, 0);
  const farCone = new THREE.ConeGeometry(1.7, 6.6, 6);
  farCone.translate(0, 3.6, 0);

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
  const rockMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });

  const stats = { round: 0, conifer: 0, rocks: 0, bushes: 0 };
  const tiles: NatureTile[] = [];
  const dummy = new THREE.Object3D();

  for (const [key, list] of buckets) {
    const [kx, kz] = key.split(',').map(Number);
    const near = new THREE.Group();
    const casters: THREE.InstancedMesh[] = [];
    const byKind = (k: ScatterItem['kind']) => list.filter((i) => i.kind === k);
    const round = byKind('round');
    const conifer = byKind('conifer');
    const rocks = byKind('rock');
    const bushes = byKind('bush');
    const stumps = byKind('stump');
    stats.round += round.length;
    stats.conifer += conifer.length;
    stats.rocks += rocks.length;
    stats.bushes += bushes.length;

    const make = (parent: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, arr: ScatterItem[], colorOf: (i: ScatterItem) => THREE.Color, caster: boolean) => {
      if (!arr.length) return;
      const mesh = new THREE.InstancedMesh(geo, mat, arr.length);
      arr.forEach((it, i) => {
        dummy.position.set(it.x, it.y, it.z);
        dummy.rotation.set(0, it.rot, 0);
        dummy.scale.set(it.scale, it.scale * (0.9 + (i % 5) * 0.05), it.scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, colorOf(it));
      });
      mesh.computeBoundingSphere();
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      parent.add(mesh);
      if (caster) casters.push(mesh);
    };

    make(near, trunkGeo, trunkMat, round, () => new THREE.Color(0x5b4330), true);
    make(near, canopyGeo, leafMat, round, (i) => i.color, true);
    make(near, canopy2Geo, leafMat, round, (i) => i.color.clone().multiplyScalar(1.12), false);
    make(near, cTrunkGeo, trunkMat, conifer, () => new THREE.Color(0x4a3626), false);
    cones.forEach((g, ci) => make(near, g, leafMat, conifer, (i) => i.color.clone().multiplyScalar(1 + ci * 0.07), ci === 0));
    make(near, rockGeo, rockMat, rocks, (i) => i.color, true);
    make(near, bushGeo, leafMat, bushes, (i) => i.color, false);
    make(near, stumpGeo, trunkMat, stumps, () => new THREE.Color(0x6b4f33), false);

    group.add(near);
    tiles.push({ cx: kx * tileSize, cz: kz * tileSize, near, casters, shadow: false, lod: 0 });
  }

  /* --- the whole world's distant trees, in three draw calls --- */
  const farRound = items.filter((i) => i.kind === 'round');
  const farConifer = items.filter((i) => i.kind === 'conifer');
  const farRocks = items.filter((i) => i.kind === 'rock' && i.scale > 1.4);
  const farCanopyMesh = new THREE.InstancedMesh(farCanopy, leafMat, Math.max(1, farRound.length));
  const farConeMesh = new THREE.InstancedMesh(farCone, leafMat, Math.max(1, farConifer.length));
  const farRockMesh = new THREE.InstancedMesh(rockGeo, rockMat, Math.max(1, farRocks.length));
  const farMeshes = [farCanopyMesh, farConeMesh, farRockMesh];
  for (const m of farMeshes) {
    m.castShadow = false;
    m.receiveShadow = true;
    m.frustumCulled = false; // one batch covering the realm; culling is by tile below
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
  }

  const far = {
    kind: 'far',
    meshes: farMeshes,
    update(hidden: (x: number, z: number) => boolean) {
      const fill = (mesh: THREE.InstancedMesh, list: ScatterItem[], tint: number) => {
        let n = 0;
        const c = new THREE.Color();
        for (const it of list) {
          if (hidden(it.x, it.z)) continue;
          dummy.position.set(it.x, it.y, it.z);
          dummy.rotation.set(0, it.rot, 0);
          dummy.scale.set(it.scale, it.scale, it.scale);
          dummy.updateMatrix();
          mesh.setMatrixAt(n, dummy.matrix);
          mesh.setColorAt(n, c.copy(it.color).multiplyScalar(tint));
          n++;
        }
        mesh.count = n;
        mesh.visible = n > 0;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      };
      fill(farCanopyMesh, farRound, 0.92);
      fill(farConeMesh, farConifer, 0.95);
      fill(farRockMesh, farRocks, 1);
    },
  };
  // start fully populated; the world rebuilds it as tiles enter the near bubble
  far.update(() => false);

  return { group, tiles, far, stats };
}

/** Circling birds around each settlement — cheap instanced wings for atmosphere. */
export function createBirds(rng: RNG, perCenter: number, centers: { x: number; z: number }[]) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.9, 0, 0, 0, 0, -0.25, 0.9, 0, 0, 0, 0.12, 0.35], 3));
  geo.setIndex([0, 1, 3, 1, 2, 3]);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2c2a28, roughness: 1, side: THREE.DoubleSide });
  const count = perCenter * centers.length;
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.frustumCulled = false;
  const data: { c: THREE.Vector3; r: number; a: number; sp: number; y: number }[] = [];
  for (const ctr of centers) {
    for (let i = 0; i < perCenter; i++) {
      data.push({
        c: new THREE.Vector3(ctr.x + (rng() - 0.5) * 900, 0, ctr.z + (rng() - 0.5) * 900),
        r: 30 + rng() * 90,
        a: rng() * Math.PI * 2,
        sp: 0.12 + rng() * 0.2,
        y: 60 + rng() * 90,
      });
    }
  }
  const dummy = new THREE.Object3D();
  return {
    mesh,
    update(t: number, cam: THREE.Vector3, baseY: (x: number, z: number) => number) {
      data.forEach((d, i) => {
        const far = Math.abs(d.c.x - cam.x) > 1500 || Math.abs(d.c.z - cam.z) > 1500;
        if (far) {
          dummy.scale.setScalar(0.0001);
        } else {
          d.a += d.sp * 0.016;
          const x = d.c.x + Math.cos(d.a) * d.r;
          const z = d.c.z + Math.sin(d.a) * d.r;
          dummy.position.set(x, baseY(x, z) + d.y + Math.sin(t * 0.4 + i) * 3, z);
          dummy.rotation.set(0, -d.a, Math.sin(t * 9 + i) * 0.35);
          dummy.scale.setScalar(1.6);
        }
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
