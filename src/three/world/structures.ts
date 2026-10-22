import * as THREE from 'three';
import { Collector, box, gableRoof, gableEnds, pyramid, mat4 } from '../geometry';
import { RNG, range, pick } from '../noise';

/* ------------------------------ Barn ------------------------------ */
export function addBarn(c: Collector, base: THREE.Matrix4, roofMat = 'thatch', rng?: RNG) {
  const W = 12;
  const D = 9;
  const H = 6;
  const wall = 0x8a6440;
  c.add('stone', box(W + 0.4, 0.9, D + 0.4), base.clone().multiply(mat4(0, 0.45, 0)), 0x9d9385);
  c.add('wood', box(W, H, D), base.clone().multiply(mat4(0, H / 2 + 0.9, 0)), wall);
  // timber frame cladding
  for (let i = 0; i <= 6; i++) {
    const x = -W / 2 + (W / 6) * i;
    c.add('wood', box(0.28, H, 0.16), base.clone().multiply(mat4(x, H / 2 + 0.9, D / 2 + 0.02)), 0x5a3f28);
    c.add('wood', box(0.28, H, 0.16), base.clone().multiply(mat4(x, H / 2 + 0.9, -D / 2 - 0.02)), 0x5a3f28);
  }
  for (const s of [-1, 1]) {
    c.add('wood', box(0.16, H, D), base.clone().multiply(mat4(s * W / 2, H / 2 + 0.9, 0)), 0x5a3f28);
  }
  const rm = base.clone().multiply(mat4(0, H + 0.9, 0, Math.PI / 2));
  c.add(roofMat, gableRoof(D, W, 4.2, 0.6), rm, 0xb08b46);
  c.add('wood', gableEnds(D, W, 4.2), rm, wall);
  // big double doors + hay door above
  c.add('wood', box(4.4, 4.2, 0.16), base.clone().multiply(mat4(0, 2.1 + 0.9, D / 2 + 0.06)), 0x6b4a2e);
  c.add('wood', box(0.16, 4.2, 0.1), base.clone().multiply(mat4(0, 3 + 0.9, D / 2 + 0.16)), 0x3d2a18);
  c.add('wood', box(2.4, 2.2, 0.14), base.clone().multiply(mat4(0, H + 1.6, D / 2 + 0.06)), 0x6b4a2e);
  // haystacks spilling out
  if (rng) {
    for (let i = 0; i < 3; i++) {
      const x = range(rng, -W / 2, W / 2);
      c.add('thatch', new THREE.SphereGeometry(1.1, 9, 6), base.clone().multiply(mat4(x, 1.0, D / 2 + 1.6 + rng() * 1.2, 0, 1, 0.85, 1)), 0xd9b35a);
    }
  }
  return { hw: W / 2 + 0.5, hd: D / 2 + 0.5 };
}

/* --------------------------- Longhouse ---------------------------- */
export function addLonghouse(c: Collector, base: THREE.Matrix4, roofMat = 'slate') {
  const W = 16;
  const D = 10;
  const H = 5;
  const wall = 0x8b7c66;
  c.add('stone', box(W + 0.6, 1.0, D + 0.6), base.clone().multiply(mat4(0, 0.5, 0)), 0x8f8b83);
  c.add('wood', box(W, H, D), base.clone().multiply(mat4(0, H / 2 + 1, 0)), wall);
  // crossed timbers on the gables + carved posts at the door
  const rm = base.clone().multiply(mat4(0, H + 1, 0, Math.PI / 2));
  c.add(roofMat, gableRoof(D, W, 6.4, 0.7), rm, 0x46505e);
  c.add('wood', gableEnds(D, W, 6.4), rm, wall);
  for (const s of [-1, 1]) {
    const gm = base.clone().multiply(mat4(s * W / 2, H + 1, 0));
    c.add('wood', box(0.2, 6.4, 0.14), gm.clone().multiply(new THREE.Matrix4().makeRotationZ(0.6)), 0x3d2a18);
    c.add('wood', box(0.2, 6.4, 0.14), gm.clone().multiply(new THREE.Matrix4().makeRotationZ(-0.6)), 0x3d2a18);
  }
  // door posts with beast heads
  for (const s of [-1, 1]) {
    c.add('wood', box(0.5, 4.2, 0.5), base.clone().multiply(mat4(s * 1.5, 2.1 + 1, D / 2 + 0.2)), 0x4a3320);
    c.add('wood', box(0.6, 0.5, 0.6), base.clone().multiply(mat4(s * 1.5, 4.4 + 1, D / 2 + 0.2)), 0x4a3320);
  }
  c.add('wood', box(2.6, 3.4, 0.16), base.clone().multiply(mat4(0, 1.7 + 1, D / 2 + 0.08)), 0x5a3a22);
  // roof ridge carvings
  c.add('wood', box(D + 1.4, 0.24, 0.24), base.clone().multiply(mat4(0, H + 7.4, 0)), 0x3d2a18);
  // fire smoke trench marks
  for (let i = 0; i < 3; i++) {
    c.add('flat', new THREE.CylinderGeometry(0.5, 0.6, 0.5, 8), base.clone().multiply(mat4(-4 + i * 4, H + 3.4, 0)), 0x2b2b2e);
  }
  return { hw: W / 2 + 0.8, hd: D / 2 + 0.8 };
}

/* ----------------------------- Keep ------------------------------- */
export function addKeep(c: Collector, base: THREE.Matrix4) {
  const R = 6.2;
  const H = 22;
  const stone = 0x8f8d8a;
  c.add('stone', new THREE.CylinderGeometry(R + 0.6, R + 1.4, 3, 16), base.clone().multiply(mat4(0, 1.5, 0)), 0x7f7d7a);
  c.add('stone', new THREE.CylinderGeometry(R, R * 0.94, H, 16), base.clone().multiply(mat4(0, H / 2 + 3, 0)), stone);
  // string courses
  for (const y of [8, 15]) {
    c.add('stone', new THREE.CylinderGeometry(R + 0.35, R + 0.35, 0.5, 16), base.clone().multiply(mat4(0, y + 3, 0)), 0xa09e99);
  }
  // crenellated parapet
  const py = H + 3;
  c.add('stone', new THREE.CylinderGeometry(R + 0.5, R + 0.5, 1.1, 16), base.clone().multiply(mat4(0, py, 0)), 0xa09e99);
  const merlons = 12;
  for (let i = 0; i < merlons; i++) {
    const a = (i / merlons) * Math.PI * 2;
    c.add('stone', box(1.5, 1.4, 0.5), base.clone().multiply(mat4(Math.sin(a) * (R + 0.35), py + 1.2, Math.cos(a) * (R + 0.35), a)), 0xa5a39e);
  }
  // windows + door
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const m = base.clone().multiply(mat4(Math.sin(a) * R, 9, Math.cos(a) * R, a));
    c.add('flat', box(0.9, 1.5, 0.3), m.clone().multiply(mat4(0, 0, 0.05)), 0x2a2622);
    c.add('flat', box(1.3, 0.2, 0.4), m.clone().multiply(mat4(0, -0.9, 0.05)), 0xa5a39e);
  }
  const dm = base.clone().multiply(mat4(0, 0, R + 0.2));
  c.add('wood', box(2.6, 3.6, 0.3), dm.clone().multiply(mat4(0, 1.8 + 3, 0.1)), 0x4a2f1c);
  c.add('stone', box(3.4, 0.5, 1.6), dm.clone().multiply(mat4(0, 0.25, 0.6)), 0x9a978f);
  // stair turret
  c.add('stone', new THREE.CylinderGeometry(1.6, 1.8, py + 1.4, 10), base.clone().multiply(mat4(R + 1.2, (py + 1.4) / 2, 0)), 0x84827f);
  c.add('flat', new THREE.ConeGeometry(2, 2.4, 10), base.clone().multiply(mat4(R + 1.2, py + 2.4, 0)), 0x50565c);
  return { hw: R + 2.6, hd: R + 2.6, topY: py + 1.9 };
}

/** Banner pole with a hanging cloth flag. */
export function addFlag(c: Collector, base: THREE.Matrix4, color: number) {
  c.add('flat', new THREE.CylinderGeometry(0.09, 0.11, 6, 6), base.clone().multiply(mat4(0, 3, 0)), 0x4a3a2a);
  c.add('flat', box(2.4, 1.5, 0.05), base.clone().multiply(mat4(1.25, 5.2, 0)), color);
  c.add('flat', box(2.4, 0.2, 0.06), base.clone().multiply(mat4(1.25, 4.5, 0)), color);
}

/* ------------------------- Standing stones ------------------------ */
export function addStoneCircle(c: Collector, base: THREE.Matrix4, rng: RNG, count = 9, radius = 9) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const h = range(rng, 2.4, 4.6);
    const x = Math.sin(a) * radius;
    const z = Math.cos(a) * radius;
    const m = base.clone().multiply(mat4(x, 0, z, a + (rng() - 0.5) * 0.4));
    const g = new THREE.BoxGeometry(1.5, h, 0.8, 1, 3, 1);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < p.count; k++) {
      p.setX(k, p.getX(k) + (Math.sin(k * 2.7 + i) * 0.12));
      p.setZ(k, p.getZ(k) + (Math.cos(k * 1.9 + i) * 0.1));
    }
    g.computeVertexNormals();
    c.add('rock', g, m.clone().multiply(mat4(0, h / 2 - 0.3, 0)), 0x7d7f82);
  }
  // centre slab
  c.add('rock', new THREE.CylinderGeometry(1.8, 2.2, 0.5, 10), base.clone().multiply(mat4(0, 0.25, 0)), 0x8a8c8f);
}

/* ----------------------------- Ruins ------------------------------ */
export function addRuins(c: Collector, base: THREE.Matrix4, rng: RNG) {
  const W = 14;
  for (const s of [-1, 1]) {
    const h = range(rng, 1.5, 4.5);
    c.add('stone', box(0.8, h, W * range(rng, 0.4, 0.9)), base.clone().multiply(mat4(s * W / 2, h / 2, 0, (rng() - 0.5) * 0.1)), 0x9a9385);
  }
  // broken arch
  const ah = range(rng, 3.5, 5);
  c.add('stone', box(1, ah, 1), base.clone().multiply(mat4(-3, ah / 2, W / 2 - 1)), 0x9a9385);
  c.add('stone', box(1, ah * 0.6, 1), base.clone().multiply(mat4(1.2, (ah * 0.6) / 2, W / 2 - 1)), 0x9a9385);
  // rubble
  for (let i = 0; i < 16; i++) {
    const s = range(rng, 0.4, 1.4);
    c.add('rock', new THREE.DodecahedronGeometry(s, 0), base.clone().multiply(mat4(range(rng, -W / 2, W / 2), s * 0.4, range(rng, -W / 2, W / 2), rng() * 3)), 0x8f8b84);
  }
}

/* --------------------------- Watchtower --------------------------- */
/**
 * A real border tower instead of a bare cylinder: battered plinth, two-stage
 * shaft with a string course, arrow slits, a corbelled parapet with merlons,
 * a timber hoarding, a stair turret and a shingle cone. 24 m to the finial —
 * tall enough to read as a landmark from the road.
 */
export function addWatchtower(c: Collector, base: THREE.Matrix4) {
  const stone = 0x8f8d8a;
  const light = 0xa6a29b;
  const shaft2 = 0x94918c;
  const slateCol = 0x4f555c;
  const py = 16.2; // wall head / parapet springing

  // ---- 1. footing and battered plinth
  c.add('stone', new THREE.CylinderGeometry(3.35, 3.8, 0.75, 16), base.clone().multiply(mat4(0, 0.37, 0)), 0x807d79);
  c.add('stone', new THREE.CylinderGeometry(3.06, 3.36, 2.45, 16), base.clone().multiply(mat4(0, 1.97, 0)), 0x8a8783);
  c.add('stone', new THREE.CylinderGeometry(3.14, 3.14, 0.26, 16), base.clone().multiply(mat4(0, 3.32, 0)), light);

  // ---- 2. shaft, two stages with a string course between them
  c.add('stone', new THREE.CylinderGeometry(2.74, 3.06, 7.35, 16), base.clone().multiply(mat4(0, 7.13, 0)), stone);
  c.add('stone', new THREE.CylinderGeometry(2.92, 2.92, 0.42, 16), base.clone().multiply(mat4(0, 10.85, 0)), light);
  c.add('stone', new THREE.CylinderGeometry(2.52, 2.74, 5.25, 16), base.clone().multiply(mat4(0, 13.7, 0)), shaft2);

  // ---- 3. arrow slits, sunk into the curved face
  const slits: [number, number][] = [
    [0.45, 6.4], [1.9, 6.4], [3.35, 6.4], [4.9, 6.4],
    [0.9, 12.7], [2.7, 12.7], [4.6, 12.7], [5.6, 12.7],
  ];
  for (const [a, y] of slits) {
    const r = y > 11 ? 2.62 : 2.9;
    const m = base.clone().multiply(mat4(Math.sin(a) * r, y, Math.cos(a) * r, a));
    c.add('stone', box(0.52, 1.78, 0.2), m.clone().multiply(mat4(0, 0, -0.04)), light);
    c.add('flat', box(0.24, 1.5, 0.16), m.clone().multiply(mat4(0, 0, 0.06)), 0x231f1c);
  }

  // ---- 4. upper windows with stone lintels
  for (let i = 0; i < 3; i++) {
    const a = 0.85 + i * 1.5;
    const m = base.clone().multiply(mat4(Math.sin(a) * 2.55, 14.7, Math.cos(a) * 2.55, a));
    c.add('flat', box(0.64, 1.02, 0.2), m.clone().multiply(mat4(0, 0, 0.03)), 0x2a2622);
    c.add('stone', box(0.98, 0.16, 0.36), m.clone().multiply(mat4(0, -0.62, 0.07)), light);
  }

  // ---- 5. timber hoarding on the corbel, then the parapet
  c.add('stone', new THREE.CylinderGeometry(3.24, 2.5, 1.2, 16), base.clone().multiply(mat4(0, py + 0.2, 0)), 0x9a9791);
  c.add('wood', new THREE.CylinderGeometry(3.16, 3.0, 1.0, 16, 1, true), base.clone().multiply(mat4(0, py - 0.55, 0)), 0x4a3524);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    c.add('wood', box(0.09, 1.0, 0.09), base.clone().multiply(mat4(Math.sin(a) * 3.14, py - 0.55, Math.cos(a) * 3.14, a)), 0x392a1d);
  }
  c.add('stone', new THREE.CylinderGeometry(3.28, 3.28, 1.55, 16), base.clone().multiply(mat4(0, py + 1.55, 0)), light);
  c.add('stone', new THREE.CylinderGeometry(3.42, 3.42, 0.22, 16), base.clone().multiply(mat4(0, py + 2.42, 0)), 0xb2afa8);
  const merlons = 12;
  for (let i = 0; i < merlons; i++) {
    const a = (i / merlons) * Math.PI * 2 + 0.13;
    c.add('stone', box(1.08, 0.86, 0.5), base.clone().multiply(mat4(Math.sin(a) * 3.2, py + 2.96, Math.cos(a) * 3.2, a)), 0xb8b5ae);
  }

  // ---- 6. shingle cone inside the parapet
  c.add('slate', new THREE.ConeGeometry(3.0, 3.5, 16), base.clone().multiply(mat4(0, py + 4.4, 0)), slateCol);
  c.add('slate', new THREE.CylinderGeometry(0.1, 0.16, 0.9, 6), base.clone().multiply(mat4(0, py + 6.5, 0)), 0x3c4249);
  c.add('flat', new THREE.SphereGeometry(0.3, 8, 6), base.clone().multiply(mat4(0, py + 6.1, 0)), 0xb08a3c);

  // ---- 7. stair turret (east side) rising to the parapet
  const tx = 2.6;
  const tz = -0.45;
  c.add('stone', new THREE.CylinderGeometry(1.06, 1.22, py + 0.85, 12), base.clone().multiply(mat4(tx, (py + 0.85) / 2, tz)), 0x8d8a85);
  c.add('stone', new THREE.CylinderGeometry(1.34, 1.34, 0.26, 12), base.clone().multiply(mat4(tx, py + 0.9, tz)), light);
  c.add('slate', new THREE.ConeGeometry(1.32, 2.2, 12), base.clone().multiply(mat4(tx, py + 2.18, tz)), 0x4b5158);
  for (const y of [5.5, 11.2]) {
    c.add('flat', box(0.9, 1.1, 0.16), base.clone().multiply(mat4(tx + 1.02, y, tz, Math.PI / 2)), 0x241f1c);
  }

  // ---- 8. projecting forebuilding with the door on its face
  const fm = base.clone().multiply(mat4(0, 0, 3.62));
  c.add('stone', box(2.5, 3.35, 1.35), fm.clone().multiply(mat4(0, 1.67, 0)), 0x96938d);
  c.add('stone', box(2.72, 0.3, 1.55), fm.clone().multiply(mat4(0, 3.42, 0)), 0xa6a29b);
  for (const s of [-1, 1]) c.add('stone', box(0.6, 0.52, 1.35), fm.clone().multiply(mat4(s * 0.86, 3.82, 0)), 0xa6a29b);
  c.add('wood', box(1.45, 2.6, 0.22), fm.clone().multiply(mat4(0, 1.33, 0.74)), 0x4a2f1c);
  for (const y of [0.6, 1.95]) c.add('flat', box(1.5, 0.13, 0.26), fm.clone().multiply(mat4(0, y, 0.75)), 0x3a3a3e);
  c.add('stone', new THREE.TorusGeometry(0.95, 0.16, 6, 14, Math.PI), fm.clone().multiply(mat4(0, 2.6, 0.72)), 0xb0aca5);
  // two worn steps down to the road
  c.add('stone', box(2.6, 0.24, 0.72), base.clone().multiply(mat4(0, 0.56, 4.32)), 0x9d9a94);
  c.add('stone', box(2.25, 0.32, 0.8), base.clone().multiply(mat4(0, 0.16, 4.62)), 0xa5a29b);
  // lantern bracket beside the door
  c.add('flat', box(0.1, 0.1, 0.7), fm.clone().multiply(mat4(1.55, 3.0, 0.55)), 0x2b2b2e);
  c.add('lampglass', new THREE.SphereGeometry(0.19, 8, 6), fm.clone().multiply(mat4(1.55, 2.82, 0.88)), 0xffcf87);

  // ---- 9. banner on the parapet
  c.add('flat', new THREE.CylinderGeometry(0.07, 0.09, 5.4, 6), base.clone().multiply(mat4(-2.78, py + 5.25, 0.95)), 0x4a3a2a);
  c.add('flat', box(1.85, 1.1, 0.05), base.clone().multiply(mat4(-1.88, py + 6.95, 0.95)), 0x8a2f2f);
  c.add('flat', box(1.85, 0.16, 0.06), base.clone().multiply(mat4(-1.88, py + 6.35, 0.95)), 0x8a2f2f);

  // ---- 10. weather staining, cheap and effective at distance
  for (const [a, y, h] of [[1.2, 5.0, 3.2], [4.3, 8.4, 4.0], [3.0, 2.2, 1.6]] as [number, number, number][]) {
    c.add('stone', box(0.9, h, 0.09), base.clone().multiply(mat4(Math.sin(a) * 2.95, y, Math.cos(a) * 2.95, a)), 0x7d7a76);
  }

  return { hw: 4.8, hd: 4.8 };
}

/* --------------------------- Windmill ----------------------------- */
export function addWindmill(c: Collector, base: THREE.Matrix4, rng: RNG) {
  const H = 11;
  c.add('stone', new THREE.CylinderGeometry(3.4, 4.4, H, 12), base.clone().multiply(mat4(0, H / 2, 0)), 0xc2ae88);
  c.add('thatch', new THREE.ConeGeometry(4.2, 4, 12), base.clone().multiply(mat4(0, H + 2, 0)), 0xb08b46);
  c.add('wood', box(2, 3, 0.3), base.clone().multiply(mat4(0, 1.8, 3.5)), 0x5a3a22);
  // door step and windows
  c.add('stone', box(3, 0.4, 1.4), base.clone().multiply(mat4(0, 0.2, 4.2)), 0xa89a78);
  for (const [dx, dy] of [[-2.2, 6], [2.2, 6], [0, 8.4]] as [number, number][]) {
    c.add('flat', box(0.8, 1, 0.3), base.clone().multiply(mat4(dx, dy, 3.1, 0, 1, 1, 1)), 0x3d4e63);
  }
  void rng;
  return { hw: 4.6, hd: 4.6, sailY: H + 1.6, sailZ: 3.6 };
}

/** Windmill sails — merged into two meshes (wood, canvas) and animated as one group. */
export function buildMillSails(materials: Record<string, THREE.Material>) {
  const c = new Collector();
  c.add('wood', new THREE.CylinderGeometry(0.3, 0.3, 1.2, 8), new THREE.Matrix4().makeRotationX(Math.PI / 2), 0x6b4a2e);
  for (let i = 0; i < 4; i++) {
    const rot = new THREE.Matrix4().makeRotationZ((i / 4) * Math.PI * 2);
    c.add('wood', box(0.32, 11, 0.32), rot.clone().multiply(mat4(0, 5.5, 0)), 0x6b4a2e);
    c.add('canvas', box(2.1, 9.4, 0.1), rot.clone().multiply(mat4(1.3, 5.4, 0.25)), 0xe8e2d0);
    for (let k = 0; k < 5; k++) c.add('wood', box(2.1, 0.1, 0.1), rot.clone().multiply(mat4(1.3, 1.6 + k * 2, 0.2)), 0x6b4a2e);
  }
  const g = new THREE.Group();
  for (const m of c.build(materials)) {
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

/* -------------------------- Water mill ---------------------------- */
export function addWaterMill(c: Collector, base: THREE.Matrix4, roofMat = 'thatch') {
  const W = 11;
  const D = 8;
  const H = 5;
  c.add('stone', box(W, H, D), base.clone().multiply(mat4(0, H / 2, 0)), 0xb8a488);
  const rm = base.clone().multiply(mat4(0, H, 0, Math.PI / 2));
  c.add(roofMat, gableRoof(D, W, 3.6, 0.6), rm, 0xa37f3e);
  c.add('stone', gableEnds(D, W, 3.6), rm, 0xb8a488);
  c.add('wood', box(2.2, 3, 0.2), base.clone().multiply(mat4(0, 1.5, D / 2 + 0.05)), 0x5a3a22);
  // wheel pit
  c.add('stone', box(4, 2, 5), base.clone().multiply(mat4(W / 2 + 2, -0.6, 0)), 0x8f8577);
  return { hw: W / 2 + 0.4, hd: D / 2 + 0.4, wheelX: W / 2 + 2.2 };
}

export function buildWaterWheel(materials: Record<string, THREE.Material>) {
  const g = new THREE.Group();
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.7, 16, 1, true), materials.wood);
  wheel.rotation.z = Math.PI / 2;
  g.add(wheel);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const paddle = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.12), materials.wood);
    paddle.position.set(0, Math.sin(a) * 2.55, Math.cos(a) * 2.55);
    paddle.rotation.x = -a;
    g.add(paddle);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.12, 5.1, 0.12), materials.wood);
    spoke.rotation.x = a;
    g.add(spoke);
    if (i % 2 === 0) {
      const ax = new THREE.Mesh(new THREE.BoxGeometry(0.6, 5.1, 0.12), materials.wood);
      ax.rotation.x = a + 0.4;
      g.add(ax);
    }
  }
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 3, 8), materials.wood);
  axle.rotation.z = Math.PI / 2;
  g.add(axle);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });
  return g;
}

/* ------------------------------ Dock ------------------------------ */
export function addDock(c: Collector, base: THREE.Matrix4, len = 16, wide = 4) {
  const deckMat = 'wood';
  c.add(deckMat, box(wide, 0.25, len), base.clone().multiply(mat4(0, 1.1, len / 2)), 0x7d5f3d);
  for (let i = 0; i <= Math.floor(len / 4); i++) {
    for (const s of [-1, 1]) {
      c.add('wood', box(0.35, 4, 0.35), base.clone().multiply(mat4(s * (wide / 2 - 0.3), -0.9, i * 4 + 1)), 0x5a4229);
    }
    if (i < len / 4) {
      c.add('wood', box(wide, 0.18, 0.18), base.clone().multiply(mat4(0, 1.28, i * 4 + 3)), 0x6b4f30);
    }
  }
  return { hw: wide / 2, hd: len / 2 };
}

export function addBoat(c: Collector, base: THREE.Matrix4, color = 0x6b4f30) {
  const hull = new THREE.LatheGeometry(
    Array.from({ length: 9 }, (_, i) => {
      const t = i / 8;
      return new THREE.Vector2(Math.sin(t * Math.PI) * 1.5 + 0.05, (t - 0.5) * 7.4);
    }),
    10,
    0,
    Math.PI * 2,
  );
  hull.rotateX(Math.PI / 2);
  c.add('wood', hull, base.clone().multiply(mat4(0, 0.35, 0, 0, 1, 1, 1)), color);
  c.add('wood', box(1.5, 0.12, 0.16), base.clone().multiply(mat4(0, 0.95, 0)), 0x4a3320);
  c.add('wood', box(0.14, 3.4, 0.14), base.clone().multiply(mat4(0, 2.0, -0.6)), 0x4a3320);
  c.add('canvas', box(0.06, 2.6, 2.0), base.clone().multiply(mat4(0, 2.9, 0.6)), 0xe8e2d0);
  c.add('wood', box(1.4, 0.1, 0.14), base.clone().multiply(mat4(0, 4.2, 0.6)), 0x4a3320);
  return { hw: 1.8, hd: 3.8 };
}

/* --------------------------- Small props -------------------------- */
export function addHaystack(c: Collector, base: THREE.Matrix4, rng: RNG) {
  const r = range(rng, 1.3, 2.1);
  c.add('thatch', new THREE.ConeGeometry(r, r * 1.5, 10), base.clone().multiply(mat4(0, r * 0.75, 0)), pick(rng, [0xd9b35a, 0xcba64f, 0xe0bd68]));
  c.add('thatch', new THREE.CylinderGeometry(r * 0.95, r * 1.05, r * 0.5, 10), base.clone().multiply(mat4(0, r * 0.25, 0)), 0xb9944f);
  return { hw: r, hd: r };
}

/** Post-and-rail fence; posts and rail segments follow the ground when `heightAt` is given. */
export function addFence(c: Collector, base: THREE.Matrix4, len: number, rotY: number, color = 0x6b5230, heightAt?: (x: number, z: number) => number) {
  const m = base.clone().multiply(mat4(0, 0, 0, rotY));
  const baseY = new THREE.Vector3().setFromMatrixPosition(base).y;
  const n = Math.max(1, Math.round(len / 2.4));
  const seg = len / n;
  const v = new THREE.Vector3();
  const ys: number[] = [];
  for (let i = 0; i <= n; i++) {
    const lx = -len / 2 + seg * i;
    let dy = 0;
    if (heightAt) {
      v.set(lx, 0, 0).applyMatrix4(m);
      dy = heightAt(v.x, v.z) - baseY;
    }
    ys.push(dy);
    c.add('wood', box(0.16, 1.3, 0.16), m.clone().multiply(mat4(lx, 0.65 + dy, 0)), color);
  }
  for (let i = 0; i < n; i++) {
    const x0 = -len / 2 + seg * i;
    const y0 = ys[i];
    const y1 = ys[i + 1];
    const ang = Math.atan2(y1 - y0, seg);
    const L = Math.hypot(seg, y1 - y0) + 0.05;
    for (const y of [0.5, 1.05]) {
      const rm = m.clone().multiply(mat4(x0 + seg / 2, y + (y0 + y1) / 2, 0)).multiply(new THREE.Matrix4().makeRotationZ(ang));
      c.add('wood', box(L, 0.1, 0.09), rm, color);
    }
  }
}

export function addCrateCluster(c: Collector, base: THREE.Matrix4, rng: RNG) {
  const n = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const s = range(rng, 0.5, 0.85);
    const x = range(rng, -1.4, 1.4);
    const z = range(rng, -1.4, 1.4);
    const m = base.clone().multiply(mat4(x, s / 2 + (i > 2 ? 0.85 : 0), z, rng() * 1.5));
    c.add('wood', box(s, s, s), m, pick(rng, [0x8a6a42, 0x7a5c38, 0x96754a]));
    c.add('wood', box(s + 0.03, 0.08, 0.08), m, 0x5a4229);
  }
  if (rng() < 0.7) {
    c.add('wood', new THREE.CylinderGeometry(0.42, 0.36, 0.85, 10), base.clone().multiply(mat4(1.9, 0.42, 0.6)), 0x6b4a2e);
    c.add('flat', new THREE.TorusGeometry(0.4, 0.04, 4, 10), base.clone().multiply(mat4(1.9, 0.42, 0.6)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)), 0x3a2a18);
  }
}

export function addSignpost(c: Collector, base: THREE.Matrix4, arms: { rot: number; len: number }[]) {
  c.add('wood', box(0.16, 3.2, 0.16), base.clone().multiply(mat4(0, 1.6, 0)), 0x5a4229);
  for (const a of arms) {
    const m = base.clone().multiply(mat4(0, 2.5, 0, a.rot)).multiply(mat4(a.len / 2, 0, 0));
    c.add('wood', box(a.len, 0.42, 0.08), m, 0x7a5c38);
    c.add('flat', box(a.len - 0.2, 0.06, 0.02), m.clone().multiply(mat4(0, 0.1, 0.06)), 0xe8dcc0);
  }
  return { hw: 0.5, hd: 0.5 };
}

export function addTrough(c: Collector, base: THREE.Matrix4) {
  c.add('wood', box(2.2, 0.55, 0.8), base.clone().multiply(mat4(0, 0.28, 0)), 0x6b4a2e);
  c.add('water', box(1.9, 0.06, 0.6), base.clone().multiply(mat4(0, 0.5, 0)), 0x4a6b7a);
  for (const s of [-1, 1]) c.add('wood', box(0.14, 0.6, 0.9), base.clone().multiply(mat4(s * 1.0, 0.3, 0)), 0x5a3f28);
}

export function addWoodpile(c: Collector, base: THREE.Matrix4, rng: RNG) {
  for (let row = 0; row < 3; row++) {
    const cnt = 5 - row;
    for (let i = 0; i < cnt; i++) {
      const r = 0.22;
      c.add('wood', new THREE.CylinderGeometry(r, r, 1.6, 7), base.clone().multiply(mat4(-0.9 + i * 0.46 + row * 0.2, 0.24 + row * 0.44, 0, 0, 1, 1, 1)).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)), pick(rng, [0x6b4a2e, 0x7a5636, 0x5c3f26]));
    }
  }
  c.add('wood', box(1.8, 0.12, 1.4), base.clone().multiply(mat4(0, 0.06, 0)), 0x5a4229);
}

export function addGraveyard(c: Collector, base: THREE.Matrix4, rng: RNG, count = 12) {
  for (let i = 0; i < count; i++) {
    const x = range(rng, -7, 7);
    const z = range(rng, -6, 6);
    const rot = (rng() - 0.5) * 0.5;
    if (rng() < 0.5) {
      c.add('stone', box(0.7, 1.1, 0.16), base.clone().multiply(mat4(x, 0.55, z, rot)), 0xa5a09a);
      c.add('stone', new THREE.CylinderGeometry(0.35, 0.35, 0.16, 10, 1, false, 0, Math.PI), base.clone().multiply(mat4(x, 1.1, z, rot)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)), 0xa5a09a);
    } else {
      c.add('stone', box(0.9, 0.35, 1.7), base.clone().multiply(mat4(x, 0.2, z, rot)), 0x9a958f);
      c.add('flat', new THREE.ConeGeometry(0.3, 0.7, 4), base.clone().multiply(mat4(x, 0.75, z, rot)), 0xa5a09a);
    }
  }
}

export function addTent(c: Collector, base: THREE.Matrix4, rng: RNG) {
  const col = pick(rng, [0x9c6b4a, 0x7d6b4a, 0xb0a080, 0x8a5a5a]);
  c.add('canvas', new THREE.ConeGeometry(2.2, 2.8, 8), base.clone().multiply(mat4(0, 1.4, 0)), col);
  c.add('canvas', new THREE.CylinderGeometry(0.6, 0.9, 2.4, 8, 1, true, 0, Math.PI), base.clone().multiply(mat4(0, 1.2, 0)), 0x4a3a2a);
  c.add('wood', box(0.1, 3.2, 0.1), base.clone().multiply(mat4(0, 1.6, 0)), 0x5a4229);
  return { hw: 2.3, hd: 2.3 };
}

export function addShrine(c: Collector, base: THREE.Matrix4) {
  c.add('stone', new THREE.CylinderGeometry(1.6, 1.9, 0.5, 8), base.clone().multiply(mat4(0, 0.25, 0)), 0xb3a896);
  for (const s of [-1, 1]) c.add('stone', box(0.5, 2.6, 0.5), base.clone().multiply(mat4(s * 1.1, 1.8, 0)), 0xc0b5a2);
  c.add('stone', box(3, 0.5, 1.4), base.clone().multiply(mat4(0, 3.3, 0)), 0xc0b5a2);
  c.add('stone', pyramid(1.6, 1, ), base.clone().multiply(mat4(0, 3.55, 0)), 0xb3a896);
  c.add('flat', new THREE.SphereGeometry(0.35, 10, 8), base.clone().multiply(mat4(0, 4.6, 0)), 0xd8b25a);
  c.add('flat', box(0.06, 0.9, 0.06), base.clone().multiply(mat4(0, 1.4, 0)), 0xd8b25a);
  return { hw: 1.8, hd: 1.8 };
}

/** Wayside milestone: a weathered pillar marking the long roads between settlements. */
export function addMilestone(c: Collector, base: THREE.Matrix4, distKm: number) {
  c.add('stone', box(0.4, 1.5, 0.28), base.clone().multiply(mat4(0, 0.75, 0)), 0x9a958c);
  c.add('stone', new THREE.SphereGeometry(0.24, 8, 6), base.clone().multiply(mat4(0, 1.55, 0, 0, 1, 0.7, 1)), 0xa5a09a);
  // carved distance bands
  const bands = Math.max(1, Math.min(5, Math.round(distKm)));
  for (let i = 0; i < bands; i++) {
    c.add('flat', box(0.44, 0.05, 0.32), base.clone().multiply(mat4(0, 0.45 + i * 0.16, 0)), 0x6f6a63);
  }
  c.add('flat', box(0.46, 0.08, 0.34), base.clone().multiply(mat4(0, 1.2, 0)), 0x7a756e);
}

/** Crop rows: an instanced field of little plants. */
export function cropTuftGeometry(kind: number) {
  if (kind === 2) {
    // leafy greens
    const g = new THREE.SphereGeometry(0.34, 6, 4);
    g.scale(1, 0.75, 1);
    return g;
  }
  if (kind === 3) {
    // stubble / fallow
    const g = new THREE.ConeGeometry(0.1, 0.5, 4);
    g.translate(0, 0.25, 0);
    return g;
  }
  const g = new THREE.ConeGeometry(0.16, 1.25, 4);
  g.translate(0, 0.62, 0);
  return g;
}
