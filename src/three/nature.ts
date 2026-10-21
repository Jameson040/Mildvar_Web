import * as THREE from 'three';
import { RNG, range, pick } from './noise';

export interface TreeSpec {
  x: number;
  y: number;
  z: number;
  scale: number;
  kind: 'round' | 'conifer';
  color: THREE.Color;
  rot: number;
}

const GREENS = [0x4f8a2e, 0x5c9a36, 0x3f7a2a, 0x6aa63c, 0x4b8f3f, 0x7bb04a];
const AUTUMN = [0xd98b2b, 0xc96a24, 0xe0a33a, 0xb85a28, 0xd7742c];
const CONIFER = [0x2f5f2a, 0x356b30, 0x2a5527, 0x3d7336];

export function treeColor(rng: RNG, kind: TreeSpec['kind']) {
  if (kind === 'conifer') return new THREE.Color(pick(rng, CONIFER));
  return new THREE.Color(rng() < 0.2 ? pick(rng, AUTUMN) : pick(rng, GREENS));
}

function jitterGeometry(g: THREE.BufferGeometry, amount: number, rng: RNG) {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
    const l = v.length();
    v.normalize().multiplyScalar(l * (1 + (rng() - 0.5) * amount));
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export function createTrees(specs: TreeSpec[], rng: RNG) {
  const group = new THREE.Group();
  const round = specs.filter((s) => s.kind === 'round');
  const conifer = specs.filter((s) => s.kind === 'conifer');
  const dummy = new THREE.Object3D();

  // Round trees: trunk + canopy (two lumps)
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.3, 2.2, 7);
  trunkGeo.translate(0, 1.1, 0);
  const canopyGeo = jitterGeometry(new THREE.IcosahedronGeometry(1.9, 1), 0.25, rng);
  canopyGeo.translate(0, 3.6, 0);
  const canopy2Geo = jitterGeometry(new THREE.IcosahedronGeometry(1.3, 1), 0.25, rng);
  canopy2Geo.translate(0.7, 4.6, 0.4);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4330, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });

  if (round.length) {
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, round.length);
    const canopies = new THREE.InstancedMesh(canopyGeo, leafMat, round.length);
    const canopies2 = new THREE.InstancedMesh(canopy2Geo, leafMat, round.length);
    round.forEach((s, i) => {
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, s.rot, 0);
      dummy.scale.setScalar(s.scale);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      canopies.setMatrixAt(i, dummy.matrix);
      canopies2.setMatrixAt(i, dummy.matrix);
      canopies.setColorAt(i, s.color);
      canopies2.setColorAt(i, s.color.clone().multiplyScalar(1.12));
    });
    for (const m of [trunks, canopies, canopies2]) {
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
  }

  if (conifer.length) {
    const cTrunk = new THREE.CylinderGeometry(0.15, 0.28, 1.6, 6);
    cTrunk.translate(0, 0.8, 0);
    const cone1 = new THREE.ConeGeometry(1.7, 3.2, 8);
    cone1.translate(0, 2.6, 0);
    const cone2 = new THREE.ConeGeometry(1.3, 2.8, 8);
    cone2.translate(0, 4.4, 0);
    const cone3 = new THREE.ConeGeometry(0.85, 2.4, 8);
    cone3.translate(0, 6.0, 0);
    const trunks = new THREE.InstancedMesh(cTrunk, trunkMat, conifer.length);
    const c1 = new THREE.InstancedMesh(cone1, leafMat, conifer.length);
    const c2 = new THREE.InstancedMesh(cone2, leafMat, conifer.length);
    const c3 = new THREE.InstancedMesh(cone3, leafMat, conifer.length);
    conifer.forEach((s, i) => {
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, s.rot, 0);
      dummy.scale.setScalar(s.scale);
      dummy.updateMatrix();
      for (const m of [trunks, c1, c2, c3]) m.setMatrixAt(i, dummy.matrix);
      c1.setColorAt(i, s.color);
      c2.setColorAt(i, s.color.clone().multiplyScalar(1.08));
      c3.setColorAt(i, s.color.clone().multiplyScalar(1.16));
    });
    for (const m of [trunks, c1, c2, c3]) {
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
  }
  return group;
}

export interface HedgeSeg {
  x: number;
  y: number;
  z: number;
  rot: number;
  len: number;
  h: number;
  color: THREE.Color;
}

export function createHedges(segs: HedgeSeg[]) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, segs.length));
  const dummy = new THREE.Object3D();
  segs.forEach((s, i) => {
    dummy.position.set(s.x, s.y + s.h / 2, s.z);
    dummy.rotation.set(0, s.rot, 0);
    dummy.scale.set(s.len, s.h, 0.7);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, s.color);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export interface FlowerSpec {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  s: number;
}

export function createFlowers(specs: FlowerSpec[]) {
  const geo = new THREE.IcosahedronGeometry(0.35, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, specs.length));
  const dummy = new THREE.Object3D();
  specs.forEach((s, i) => {
    dummy.position.set(s.x, s.y + 0.25 * s.s, s.z);
    dummy.scale.set(s.s, s.s * 0.8, s.s);
    dummy.rotation.set(0, s.x * 3, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, s.color);
  });
  mesh.castShadow = true;
  return mesh;
}

export function createClouds(rng: RNG) {
  const puffs: { x: number; y: number; z: number; sx: number; sy: number; sz: number }[] = [];
  for (let i = 0; i < 34; i++) {
    const a = rng() * Math.PI * 2;
    const r = range(rng, 120, 650);
    const cx = Math.cos(a) * r;
    const cz = Math.sin(a) * r;
    const cy = range(rng, 150, 230);
    const n = 4 + Math.floor(rng() * 6);
    const spread = range(rng, 18, 40);
    for (let j = 0; j < n; j++) {
      const s = range(rng, 9, 18);
      puffs.push({
        x: cx + (rng() - 0.5) * spread * 2,
        y: cy + (rng() - 0.5) * 5,
        z: cz + (rng() - 0.5) * spread,
        sx: s * range(rng, 1.1, 1.8),
        sy: s * 0.55,
        sz: s,
      });
    }
  }
  const geo = new THREE.SphereGeometry(1, 10, 7);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, emissive: 0xffffff, emissiveIntensity: 0.15, transparent: true, opacity: 0.92 });
  const mesh = new THREE.InstancedMesh(geo, mat, puffs.length);
  const dummy = new THREE.Object3D();
  puffs.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z);
    dummy.scale.set(p.sx, p.sy, p.sz);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  return mesh;
}
