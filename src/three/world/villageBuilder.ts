import * as THREE from 'three';
import { Collector, box, mat4 } from '../geometry';
import { RNG, range, pick } from '../noise';
import { addHouse, randomHouseOpts, houseDoorX, addChurch, addTownHall, addMarketStall, addLamp, addFountain, addWell, addYard, Obb } from '../buildings';
import {
  addBarn, addLonghouse, addKeep, addFlag, addStoneCircle, addRuins, addWatchtower, addWindmill,
  addDock, addBoat, addHaystack, addFence, addCrateCluster, addSignpost, addTrough, addWoodpile,
  addGraveyard, addTent, addShrine,
} from './structures';
import { VillageDef, FarmDef, Theme, terrainHeight, riverQuery, roadQuery, roadFootprintClear, roadPointAt, roads, nearestRiverPoint, platforms, plazaRadius, addVillageRoad } from './land';
import { HedgeSeg, FlowerSpec, treeColor } from '../nature';
import { landUse } from './land';
import { FARM_FIELD_START, FARM_FIELD_GAP, farmFields, localPoint, overlaps, sampleFootprint } from './placement';

export interface TreeSpecOut {
  x: number;
  z: number;
  scale: number;
  kind: 'round' | 'conifer';
  color: THREE.Color;
}

export interface DynamicSpec {
  kind: 'mill' | 'boat';
  x: number;
  y: number;
  z: number;
  rot: number;
  scale: number;
  village: string;
}

export interface CropBatch {
  kind: number;
  positions: Float32Array;
  village: string;
}
export const cropBatch: CropBatch[] = [];

export interface BuildCtx {
  c: Collector;
  rng: RNG;
  obbs: Obb[];
  trees: TreeSpecOut[];
  hedges: HedgeSeg[];
  flowers: FlowerSpec[];
  lamps: { pos: THREE.Vector3; light: boolean }[];
  dynamics: DynamicSpec[];
  plaza(x: number, z: number, rx: number, rz: number): void;
  theme: Theme;
}

/** Everything about a village that must be known before terrain is sampled. */
export interface HarborPlan {
  theta: number;
  bx: number; bz: number; deckBase: number;
  qx: number; qz: number;
  px: number; pz: number; py: number;
  tx: number; tz: number; nx: number; nz: number; half: number;
}
export interface VillagePlan {
  lanes: THREE.CatmullRomCurve3[];
  laneAngles: number[];
  harbor: HarborPlan | null;
}

/* ================================================================== *
 *  LAYER 2 — survey: decide every street before the ground is shaped  *
 * ================================================================== */
export function planVillage(v: VillageDef, rng: RNG): VillagePlan {
  const rx = plazaRadius(v);
  const rz = rx * 0.86;
  const R1 = Math.max(rx, rz) + 3;

  // own lanes avoid the directions the long roads arrive from
  const laneAngles: number[] = [];
  const candidates = [45, 135, 225, 315, 22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5].map((d) => (d * Math.PI) / 180);
  for (const cand of candidates) {
    if (laneAngles.length >= 4) break;
    const a = cand + (rng() - 0.5) * 0.14;
    if ([...v.approaches, ...laneAngles].some((b) => angDist(a, b) < 0.5)) continue;
    laneAngles.push(a);
  }

  const lanes: THREE.CatmullRomCurve3[] = [];
  for (let i = 0; i < laneAngles.length; i++) {
    const a = laneAngles[i];
    const pts: THREE.Vector2[] = [];
    const R2 = v.r * 1.2;
    for (let k = 0; k <= 6; k++) {
      const tt = k / 6;
      const R = R1 + (R2 - R1) * tt;
      const aa = a + (Math.sin(tt * Math.PI * 1.2 + i) * 9 * tt) / R;
      pts.push(new THREE.Vector2(v.x + Math.cos(aa) * R, v.z + Math.sin(aa) * R * 0.95));
    }
    addVillageRoad(pts, i === 0 || rng() < 0.45 ? 'cobble' : 'dirt', i === 0 ? 6 : 5, v.id);
    lanes.push(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x, 0, p.y)), false, 'centripetal', 0.5));
  }
  // the long-road approaches are already cobbled stubs; line them with houses too
  for (const a of v.approaches) {
    const pts = [R1, (R1 + v.r * 1.25) / 2, v.r * 1.25].map((R) => new THREE.Vector3(v.x + Math.cos(a) * R, 0, v.z + Math.sin(a) * R));
    lanes.push(new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5));
  }
  if (v.r > 60) {
    const ring: THREE.Vector2[] = [];
    for (let i = 0; i <= 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const R = v.r * (0.88 + Math.sin(a * 3 + v.x * 0.01) * 0.05);
      ring.push(new THREE.Vector2(v.x + Math.cos(a) * R, v.z + Math.sin(a) * R * 0.95));
    }
    addVillageRoad(ring, 'dirt', 4.2, v.id);
  }

  // harbour: the quay road must exist before terrain is sampled
  let harbor: HarborPlan | null = null;
  if (v.landmark === 'harbor') {
    const rp = nearestRiverPoint(v.x, v.z, 520);
    if (rp) {
      const side = Math.sign((v.x - rp.x) * rp.nx + (v.z - rp.z) * rp.nz) || 1;
      const nx = rp.nx * side;
      const nz = rp.nz * side;
      const theta = Math.atan2(rp.tx, rp.tz);
      const bx = rp.x + nx * (rp.half + 0.6);
      const bz = rp.z + nz * (rp.half + 0.6);
      const qx = rp.x + nx * (rp.half + 10);
      const qz = rp.z + nz * (rp.half + 10);
      const ang = Math.atan2(qz - v.z, qx - v.x);
      const p0 = new THREE.Vector2(v.x + Math.cos(ang) * (rx + 3), v.z + Math.sin(ang) * (rx + 3));
      const p2 = new THREE.Vector2(qx, qz);
      const roadPts = [p0, new THREE.Vector2((p0.x + p2.x) / 2, (p0.y + p2.y) / 2), p2];
      addVillageRoad(roadPts, 'cobble', 4.5, v.id);
      harbor = { theta, bx, bz, deckBase: rp.y - 0.2, qx, qz, px: rp.x, pz: rp.z, py: rp.y, tx: rp.tx, tz: rp.tz, nx, nz, half: rp.half };
    }
  }
  return { lanes, laneAngles, harbor };
}

function faceTo(x: number, z: number, tx: number, tz: number) {
  return Math.atan2(tx - x, tz - z);
}

function obbCorners(o: Obb): [number, number][] {
  const pts: [number, number][] = [];
  const c = Math.cos(o.rot);
  const s = Math.sin(o.rot);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    pts.push([o.cx + c * o.hw * sx + s * o.hd * sz, o.cz - s * o.hw * sx + c * o.hd * sz]);
  }
  return pts;
}

function groundAt(o: Obb) {
  let y = Infinity;
  for (const p of obbCorners(o)) y = Math.min(y, terrainHeight(p[0], p[1]));
  return y;
}

function collides(o: Obb, list: Obb[]) {
  const reach = o.hw + o.hd + 14;
  for (const b of list) {
    if (Math.abs(b.cx - o.cx) > reach + b.hw + b.hd || Math.abs(b.cz - o.cz) > reach + b.hw + b.hd) continue;
    if (overlaps(o, b, 1.2)) return true;
  }
  return false;
}
function roadClear(o: Obb, margin: number) {
  return roadFootprintClear(o, margin);
}
function waterClear(o: Obb) {
  return sampleFootprint(o, 4, (x, z) => {
    const q = riverQuery(x, z);
    return q.d > q.half + 5;
  });
}

function frontage(o: Obb, w: number, d: number) {
  const door = localPoint({ x: o.cx, z: o.cz, rot: o.rot }, houseDoorX(w), d / 2 + 0.15);
  return roadQuery(door.x, door.z).d;
}

function houseFits(o: Obb, ctx: BuildCtx, frontGap: number, village: VillageDef) {
  if (landUse.conflicts(o, 2) || collides(o, ctx.obbs) || !roadClear(o, 0.85) || !waterClear(o)) return false;
  const front = localPoint({ x: o.cx, z: o.cz, rot: o.rot }, 0, o.hd + frontGap / 2);
  const frontagePlot: Obb = { cx: front.x, cz: front.z, hw: o.hw + 0.25, hd: frontGap / 2, rot: o.rot };
  if (landUse.conflicts(frontagePlot, 0.7) || !waterClear(frontagePlot)) return false;
  const civicRX = plazaRadius(village) + 3.5;
  const civicRZ = plazaRadius(village) * 0.86 + 3.5;
  if (!sampleFootprint(o, 2.5, (x, z) => {
    const dx = (x - village.x) / civicRX;
    const dz = (z - village.z) / civicRZ;
    return dx * dx + dz * dz > 1.02;
  })) return false;
  let low = Infinity;
  let high = -Infinity;
  sampleFootprint(o, 4, (x, z) => {
    const y = terrainHeight(x, z);
    low = Math.min(low, y);
    high = Math.max(high, y);
    return true;
  });
  return high - low < 2.6;
}

/** Packed forecourt, planted side beds and a continuous stone path to the road. */
function addHouseFrontage(ctx: BuildCtx, o: Obb, opts: ReturnType<typeof randomHouseOpts>, gap: number) {
  const base = mat4(o.cx, groundAt(o), o.cz, o.rot);
  const courtDepth = Math.max(0.8, Math.min(gap, 7.5));
  addYard(ctx.c, base, opts.w + 0.6, opts.d + 0.65, 'packed', terrainHeight, 0.11);
  addYard(ctx.c, base.clone().multiply(mat4(0, 0, opts.d / 2 + courtDepth / 2)), opts.w + 0.65, courtDepth, 'packed', terrainHeight, 0.11);

  const doorX = houseDoorX(opts.w);
  const bedZ = opts.d / 2 + courtDepth * 0.47;
  const bedDepth = Math.max(0.65, courtDepth - 0.5);
  const left = doorX - 1.1 + opts.w / 2;
  const right = opts.w / 2 - doorX - 1.1;
  if (left > 1) addYard(ctx.c, base.clone().multiply(mat4(-opts.w / 2 + left / 2, 0, bedZ)), left - 0.15, bedDepth, 'soil', terrainHeight, 0.14);
  if (right > 1) addYard(ctx.c, base.clone().multiply(mat4(opts.w / 2 - right / 2, 0, bedZ)), right - 0.15, bedDepth, 'soil', terrainHeight, 0.14);
  addYard(ctx.c, base.clone().multiply(mat4(doorX, 0, opts.d / 2 + courtDepth / 2)), 1.65, courtDepth + 0.2, 'cobble', terrainHeight, 0.18);
  // doorstep at the threshold
  ctx.c.add('stone', box(1.9, 0.16, 0.65), base.clone().multiply(mat4(doorX, 0.08, opts.d / 2 + 0.22)), 0xbdb3a2);
}
function angDist(a: number, b: number) {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

/* ================================================================== *
 *  Village                                                            *
 * ================================================================== */
export function buildVillage(v: VillageDef, plan: VillagePlan, ctx: BuildCtx) {
  const { c, rng } = ctx;
  const t = ctx.theme;
  const base = v.groundY;
  const rx = plazaRadius(v);
  const rz = rx * 0.86;

  ctx.plaza(v.x, v.z, rx + 3.5, rz + 3.5);

  /* streets were surveyed in Layer 2 (planVillage) — here we only build along them */
  const lanes: THREE.Curve<THREE.Vector3>[] = plan.lanes;

  /* ---------- square fittings ---------- */
  if (v.landmark === 'cathedral') addFountain(c, mat4(v.x, base + 0.05, v.z));
  else addWell(c, mat4(v.x + 3, base + 0.05, v.z - 2, rng() * 1.5));
  ctx.obbs.push({ cx: v.x, cz: v.z, hw: 4, hd: 4, rot: 0 });

  const stallCount = v.landmark === 'harbor' ? 5 : v.r > 90 ? 8 : v.r > 75 ? 5 : 3;
  for (let i = 0; i < stallCount; i++) {
    const a = (i / stallCount) * Math.PI * 2 + 0.35;
    const x = v.x + Math.cos(a) * (rx * 0.55);
    const z = v.z + Math.sin(a) * (rz * 0.55);
    const rot = faceTo(x, z, v.x + Math.cos(a) * 100, v.z + Math.sin(a) * 100);
    const ob = addMarketStall(c, mat4(x, base + 0.05, z, rot), i % 4, rng);
    ctx.obbs.push({ ...ob, cx: x, cz: z, rot });
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.5;
    const x = v.x + Math.cos(a) * (rx * 0.95);
    const z = v.z + Math.sin(a) * (rz * 0.95);
    ctx.lamps.push({ pos: new THREE.Vector3(x, base + 4.3, z), light: true });
    ctx.obbs.push({ cx: x, cz: z, hw: 0.3, hd: 0.3, rot: 0 });
    addLamp(c, mat4(x, base + 0.05, z));
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.2;
    const x = v.x + Math.cos(a) * (rx * 0.74);
    const z = v.z + Math.sin(a) * (rz * 0.74);
    const rot = faceTo(x, z, v.x, v.z);
    const m = mat4(x, base + 0.05, z, rot);
    c.add('wood', box(1.8, 0.08, 0.45), m.clone().multiply(mat4(0, 0.5, 0)), 0x7a5a3a);
    c.add('wood', box(1.8, 0.4, 0.06), m.clone().multiply(mat4(0, 0.75, -0.22)), 0x7a5a3a);
    c.add('flat', box(0.1, 0.5, 0.45), m.clone().multiply(mat4(-0.8, 0.25, 0)), 0x2b2b2e);
    c.add('flat', box(0.1, 0.5, 0.45), m.clone().multiply(mat4(0.8, 0.25, 0)), 0x2b2b2e);
  }
  for (let i = 0; i < 4; i++) {
    const a = rng() * Math.PI * 2;
    addCrateCluster(c, mat4(v.x + Math.cos(a) * (rx * 0.82), base + 0.05, v.z + Math.sin(a) * (rz * 0.82), rng() * 3), rng);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x = v.x + Math.cos(a) * (rx * 1.3);
    const z = v.z + Math.sin(a) * (rz * 1.3);
    if (roadQuery(x, z).d < 2) continue;
    const kind = t.treeMix > 0.5 ? 'conifer' : 'round';
    ctx.trees.push({ x, z, scale: 0.95, kind, color: treeColor(rng, kind) });
  }

  /* ---------- landmark ---------- */
  const lmAngle = -0.9;
  const lmx = v.x + Math.cos(lmAngle) * v.r * 0.52;
  const lmz = v.z + Math.sin(lmAngle) * v.r * 0.5;
  const lmRot = faceTo(lmx, lmz, v.x, v.z);
  const lmY = terrainHeight(lmx, lmz);
  const pushObb = (x: number, z: number, hw: number, hd: number, rot: number) => ctx.obbs.push({ cx: x, cz: z, hw, hd, rot });

  if (v.landmark === 'cathedral') {
    for (const o of addChurch(c, mat4(lmx, lmY, lmz, lmRot))) {
      const co = Math.cos(lmRot);
      const si = Math.sin(lmRot);
      pushObb(lmx + o.cx * co + o.cz * si, lmz - o.cx * si + o.cz * co, o.hw, o.hd, lmRot);
    }
    const ha = lmAngle + Math.PI * 0.8;
    const hx = v.x + Math.cos(ha) * v.r * 0.62;
    const hz = v.z + Math.sin(ha) * v.r * 0.62;
    const hrot = faceTo(hx, hz, v.x, v.z);
    for (const o of addTownHall(c, mat4(hx, terrainHeight(hx, hz), hz, hrot))) {
      const co = Math.cos(hrot);
      const si = Math.sin(hrot);
      pushObb(hx + o.cx * co + o.cz * si, hz - o.cx * si + o.cz * co, o.hw, o.hd, hrot);
    }
    addGraveyard(c, mat4(lmx + 16, lmY, lmz + 12, lmRot), rng, 14);
    addShrine(c, mat4(v.x - rx * 1.5, base + 0.05, v.z + rz * 1.3, 0.6));
  } else if (v.landmark === 'longhouse') {
    const o = addLonghouse(c, mat4(lmx, lmY, lmz, lmRot), t.roofMat);
    pushObb(lmx, lmz, o.hw, o.hd, lmRot);
    addFlag(c, mat4(lmx + 12, terrainHeight(lmx + 12, lmz), lmz, 0), t.accent);
    const fx = v.x + 13;
    const fz = v.z - 11;
    const fy = terrainHeight(fx, fz);
    c.add('rock', new THREE.TorusGeometry(1.6, 0.35, 6, 14), mat4(fx, fy + 0.2, fz).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)), 0x6f6a64);
    for (let i = 0; i < 4; i++) c.add('wood', box(1.6, 0.22, 0.22), mat4(fx, fy + 0.35, fz, i * 0.8), 0x4a3320);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const bx = fx + Math.cos(a) * 3.4;
      const bz = fz + Math.sin(a) * 3.4;
      c.add('wood', box(0.5, 0.5, 1.6), mat4(bx, terrainHeight(bx, bz) + 0.25, bz, a + 1.57), 0x6b4f30);
    }
    const scx = v.x - v.r * 1.05;
    const scz = v.z + v.r * 0.85;
    addStoneCircle(c, mat4(scx, terrainHeight(scx, scz), scz), rng, 11, 12);
  } else if (v.landmark === 'keep') {
    const o = addKeep(c, mat4(lmx, lmY, lmz, lmRot));
    pushObb(lmx, lmz, o.hw, o.hd, lmRot);
    addFlag(c, mat4(lmx, lmY + o.topY, lmz), 0x8a2f2f);
    for (let i = 0; i < 44; i++) {
      const a = (i / 44) * Math.PI * 2;
      if (angDist(a, lmRot) < 0.3) continue;
      const px = lmx + Math.sin(a) * 18;
      const pz = lmz + Math.cos(a) * 18;
      c.add('wood', box(0.42, 4.2 + Math.sin(a * 3) * 0.2, 0.28), mat4(px, terrainHeight(px, pz) + 2.1, pz, a), i % 7 === 0 ? 0x5a4229 : 0x6b5230);
    }
    for (let i = 0; i < 4; i++) {
      const a = rng() * Math.PI * 2;
      const px = lmx - Math.sin(lmRot) * 26 + Math.cos(a) * 8;
      const pz = lmz - Math.cos(lmRot) * 26 + Math.sin(a) * 8;
      addTent(c, mat4(px, terrainHeight(px, pz), pz, rng() * 3), rng);
    }
  } else if (v.landmark === 'mill') {
    const o = addWindmill(c, mat4(lmx, lmY, lmz, lmRot), rng);
    pushObb(lmx, lmz, o.hw, o.hd, lmRot);
    ctx.dynamics.push({ kind: 'mill', x: lmx, y: lmY + o.sailY, z: lmz, rot: lmRot, scale: 1, village: v.id });
    const w2x = lmx + 38;
    const w2z = lmz - 14;
    const o2 = addWindmill(c, mat4(w2x, terrainHeight(w2x, w2z), w2z, lmRot + 0.7), rng);
    pushObb(w2x, w2z, o2.hw, o2.hd, lmRot + 0.7);
    ctx.dynamics.push({ kind: 'mill', x: w2x, y: terrainHeight(w2x, w2z) + o2.sailY, z: w2z, rot: lmRot + 0.7, scale: 0.85, village: v.id });
  } else if (v.landmark === 'harbor' && plan.harbor) {
    buildHarbor(v, ctx, plan.harbor);
  }

  /* ---------- wells, troughs, signposts ---------- */
  for (let i = 0; i < (v.r > 85 ? 3 : 2); i++) {
    const a = rng() * Math.PI * 2;
    const R = v.r * range(rng, 0.5, 0.85);
    const x = v.x + Math.cos(a) * R;
    const z = v.z + Math.sin(a) * R;
    if (roadQuery(x, z).d < 3.5 || roadQuery(x + 3.2, z).d < 2) continue;
    addWell(c, mat4(x, terrainHeight(x, z), z, rng() * 3));
    ctx.obbs.push({ cx: x, cz: z, hw: 1.3, hd: 1.3, rot: 0 });
    addTrough(c, mat4(x + 3.2, terrainHeight(x + 3.2, z), z, rng() * 3));
  }
  for (const a of [...plan.laneAngles, ...v.approaches]) {
    const R = v.r * 1.22;
    const x = v.x + Math.cos(a) * R - Math.sin(a) * 4.4;
    const z = v.z + Math.sin(a) * R + Math.cos(a) * 4.4;
    const y = terrainHeight(x, z);
    addSignpost(c, mat4(x, y, z, a), [{ rot: 0.4, len: 2.2 }, { rot: -0.6, len: 1.8 }]);
    const lx = x + Math.cos(a) * 3;
    const lz = z + Math.sin(a) * 3;
    addLamp(c, mat4(lx, terrainHeight(lx, lz), lz));
    ctx.lamps.push({ pos: new THREE.Vector3(lx, terrainHeight(lx, lz) + 4.3, lz), light: true });
  }

  /* ---------- houses: ring around the square ---------- */
  const ringR = Math.max(rx, rz) + 9;
  let a = rng() * 0.5;
  let guard = 0;
  while (a < Math.PI * 2 && guard++ < 200) {
    const opts = randomHouseOpts(rng, t.scale * 0.95, t);
    opts.ridgeAlongFront = rng() < 0.8;
    const R = ringR + opts.d / 2;
    const x = v.x + Math.cos(a) * R;
    const z = v.z + Math.sin(a) * R * 0.95;
    const rot = faceTo(x, z, v.x, v.z);
    const o: Obb = { cx: x, cz: z, hw: opts.w / 2, hd: opts.d / 2, rot };
    const door = localPoint({ x, z, rot }, houseDoorX(opts.w), opts.d / 2);
    const ellipse = Math.hypot((door.x - v.x) / (rx + 3.5), (door.z - v.z) / (rz + 3.5));
    const gap = Math.max(0.9, Math.min(6, (ellipse - 1) * Math.min(rx, rz) + 0.8));
    if (ellipse < 1.32 && houseFits(o, ctx, gap, v)) {
      const gy = groundAt(o);
      addHouse(c, mat4(x, gy - 0.05, z, rot), opts, rng);
      ctx.obbs.push(o);
      addHouseFrontage(ctx, o, opts, gap);
      garden(ctx, mat4(x, gy, z, rot), rot, opts, gap);
    }
    a += (opts.w + range(rng, 0.8, 2.6)) / R;
  }

  /* ---------- houses along every lane & approach ---------- */
  for (const lane of lanes) {
    const len = lane.getLength();
    for (const side of [-1, 1]) {
      let pos = 6;
      let g2 = 0;
      while (pos < len - 6 && g2++ < 120) {
        const tt = pos / len;
        const p = lane.getPointAt(tt);
        const tan = lane.getTangentAt(tt);
        const opts = randomHouseOpts(rng, t.scale * (tt > 0.6 ? 0.88 : 1), t);
        const off = 4.8 + opts.d / 2;
        const x = p.x - tan.z * side * off;
        const z = p.z + tan.x * side * off;
        const rot = faceTo(x, z, p.x, p.z);
        const o: Obb = { cx: x, cz: z, hw: opts.w / 2, hd: opts.d / 2, rot };
        const dRoad = frontage(o, opts.w, opts.d);
        const gap = Math.max(0.8, dRoad + 0.7);
        if (Math.hypot(x - v.x, z - v.z) < v.r * 1.4 && dRoad > 0.6 && dRoad < 6.3 && houseFits(o, ctx, gap, v)) {
          const gy = groundAt(o);
          addHouse(c, mat4(x, gy - 0.05, z, rot), opts, rng);
          ctx.obbs.push(o);
          addHouseFrontage(ctx, o, opts, gap);
          garden(ctx, mat4(x, gy, z, rot), rot, opts, gap);
          if (rng() < 0.14) {
            const lx = x - tan.z * side * (off + 3);
            const lz = z + tan.x * side * (off + 3);
            const ly = terrainHeight(lx, lz);
            addLamp(c, mat4(lx, ly, lz));
            ctx.lamps.push({ pos: new THREE.Vector3(lx, ly + 4.3, lz), light: Math.hypot(lx - v.x, lz - v.z) < 70 });
          }
        }
        pos += opts.w + range(rng, 1.2, 6);
      }
    }
  }

  /* ---------- outlying cottages: every door must face an actual lane ---------- */
  const approachRoads = roads.filter((r) => !r.village && r.kind !== 'cobble');
  for (let i = 0; i < 140 && approachRoads.length; i++) {
    const road = pick(rng, approachRoads);
    const p = roadPointAt(road, range(rng, 10, road.length - 10));
    const distance = Math.hypot(p.x - v.x, p.z - v.z);
    if (distance < v.r + 35 || distance > v.r + 220) continue;
    const opts = randomHouseOpts(rng, t.scale * 0.9, t);
    const side = rng() < 0.5 ? -1 : 1;
    const off = road.width / 2 + range(rng, 2.6, 5) + opts.d / 2;
    const x = p.x - p.tz * side * off;
    const z = p.z + p.tx * side * off;
    const rot = faceTo(x, z, p.x, p.z);
    const o: Obb = { cx: x, cz: z, hw: opts.w / 2, hd: opts.d / 2, rot };
    const dRoad = frontage(o, opts.w, opts.d);
    const gap = Math.max(0.9, dRoad + 0.7);
    if (dRoad < 0.7 || dRoad > 6.5 || !houseFits(o, ctx, gap, v)) continue;
    const gy = groundAt(o);
    addHouse(c, mat4(x, gy - 0.05, z, rot), opts, rng);
    ctx.obbs.push(o);
    addHouseFrontage(ctx, o, opts, gap);
    garden(ctx, mat4(x, gy, z, rot), rot, opts, gap);
    if (rng() < 0.45) {
      const back = localPoint({ x, z, rot }, (rng() < 0.5 ? -1 : 1) * (opts.w / 2 + 8), -5);
      const bx = back.x;
      const bz = back.z;
      const bo: Obb = { cx: bx, cz: bz, hw: 6.6, hd: 5.2, rot };
      if (!landUse.conflicts(bo, 3) && !collides(bo, ctx.obbs) && roadClear(bo, 2) && waterClear(bo)) {
        addBarn(c, mat4(bx, groundAt(bo), bz, rot + rng()), t.roofMat, rng);
        addYard(c, mat4(bx, terrainHeight(bx, bz), bz, rot), 13, 10, 'packed', terrainHeight);
        ctx.obbs.push(bo);
      }
    }
  }

  /* ---------- countryside features ---------- */
  for (let i = 0; i < 2; i++) {
    const ang = rng() * Math.PI * 2;
    const R = v.r + range(rng, 230, 460);
    const x = v.x + Math.cos(ang) * R;
    const z = v.z + Math.sin(ang) * R;
    const site: Obb = { cx: x, cz: z, hw: 8, hd: 8, rot: 0 };
    if (landUse.conflicts(site, 4) || collides(site, ctx.obbs) || !roadClear(site, 4) || !waterClear(site)) continue;
    if (rng() < 0.5) addRuins(c, mat4(x, terrainHeight(x, z), z, rng() * 3), rng);
    else {
      addWatchtower(c, mat4(x, terrainHeight(x, z), z));
      ctx.obbs.push({ cx: x, cz: z, hw: 3.4, hd: 3.4, rot: 0 });
    }
    // A ruin can be entered, but its footprint must stay free of farms and trees.
    landUse.reserve('heritage', v.id, site);
  }
}

/* ================================================================== *
 *  Harbour on the real riverbank                                      *
 * ================================================================== */
function buildHarbor(v: VillageDef, ctx: BuildCtx, hp: HarborPlan) {
  const { c, rng } = ctx;
  const { theta, bx, bz, deckBase, qx, qz, px, pz, py, tx, tz, nx, nz, half } = hp;
  const dockLen = 30;
  addDock(c, mat4(bx, deckBase, bz, theta).multiply(mat4(0, 0, -dockLen / 2)), dockLen, 4.5);
  platforms.push({ x: bx, z: bz, dx: tx, dz: tz, halfLen: dockLen / 2, halfW: 2.3, deckY: deckBase + 1.1, pierBottom: py - 3 });
  addCrateCluster(c, mat4(bx + tx * 7, deckBase + 1.22, bz + tz * 7, theta), rng);
  addCrateCluster(c, mat4(bx - tx * 9, deckBase + 1.22, bz - tz * 9, theta + 1), rng);

  // quay on the land side (the cobble lane into the square was surveyed in L2)
  addYard(c, mat4(qx, terrainHeight(qx, qz), qz, theta), 14, 36, 'dirt', terrainHeight);

  // moored boats on the water side, a drifting barge mid-stream
  for (const k of [-9, 8]) {
    const mx = px + nx * (half - 4.2) + tx * k;
    const mz = pz + nz * (half - 4.2) + tz * k;
    addBoat(c, mat4(mx, py, mz, theta + (rng() - 0.5) * 0.2), k < 0 ? 0x6b4f30 : 0x7a5a3a);
  }
  ctx.dynamics.push({ kind: 'boat', x: px + tx * 48, y: py, z: pz + tz * 48, rot: theta + 0.25, scale: 0.95, village: v.id });

  // fish stalls facing the water, drying nets, lamps
  for (let i = 0; i < 3; i++) {
    const k = -13 + i * 13;
    const sx = px + nx * (half + 15) + tx * k;
    const sz = pz + nz * (half + 15) + tz * k;
    const rot = faceTo(sx, sz, sx - nx, sz - nz);
    const ob = addMarketStall(c, mat4(sx, terrainHeight(sx, sz), sz, rot), i % 4, rng);
    ctx.obbs.push({ ...ob, cx: sx, cz: sz, rot });
  }
  for (let i = 0; i < 3; i++) {
    const k = -16 + i * 16;
    const fx = px + nx * (half + 21) + tx * k;
    const fz = pz + nz * (half + 21) + tz * k;
    const fy = terrainHeight(fx, fz);
    const m = mat4(fx, fy, fz, theta);
    for (const s of [-1, 1]) c.add('wood', box(0.16, 4, 0.16), m.clone().multiply(mat4(0, 2, s * 2.4)), 0x5a4229);
    c.add('wood', box(0.14, 0.14, 5), m.clone().multiply(mat4(0, 3.9, 0)), 0x5a4229);
    for (let q = 0; q < 4; q++) c.add('canvas', box(0.03, 2.4, 0.9), m.clone().multiply(mat4(0, 2.6, (q - 1.5) * 1.2)), 0xdcd6c2);
  }
  for (const k of [-14, 14]) {
    const lx = px + nx * (half + 7) + tx * k;
    const lz = pz + nz * (half + 7) + tz * k;
    addLamp(c, mat4(lx, terrainHeight(lx, lz), lz));
    ctx.lamps.push({ pos: new THREE.Vector3(lx, terrainHeight(lx, lz) + 4.3, lz), light: true });
  }
}

/* ================================================================== *
 *  Gardens                                                            *
 * ================================================================== */
function garden(ctx: BuildCtx, m: THREE.Matrix4, rot: number, opts: ReturnType<typeof randomHouseOpts>, gap: number) {
  const { rng } = ctx;
  const t = ctx.theme;
  if (gap < 2.2) return;
  const roll = rng();
  const dist = opts.d / 2 + Math.min(gap - 0.8, 2.6);
  const halfW = opts.w / 2 + 0.6;
  const toWorld = (lx: number, lz: number) => new THREE.Vector3(lx, 0, lz).applyMatrix4(m);
  if (roll < 0.5) {
    for (const s of [-1, 1]) {
      const len = halfW - 0.9;
      const p = toWorld(s * (0.9 + len / 2), dist);
      ctx.hedges.push({ x: p.x, y: terrainHeight(p.x, p.z), z: p.z, rot, len, h: range(rng, 0.8, 1.2), color: new THREE.Color(pick(rng, t.hedge)) });
    }
  } else if (roll < 0.75) {
    for (const s of [-1, 1]) {
      const len = halfW - 0.9;
      ctx.c.add('stone', box(len, 0.7, 0.35), m.clone().multiply(mat4(s * (0.9 + len / 2), 0.35, dist)), 0xb3a896);
    }
  }
  const cols = [0xe0457b, 0xf2c94c, 0xd94a3d, 0x9b59b6, 0xffffff, 0xf28c28];
  const n = 4 + Math.floor(rng() * 8);
  for (let i = 0; i < n; i++) {
    const lx = range(rng, -halfW + 0.3, halfW - 0.3);
    if (Math.abs(lx) < 1.1) continue;
    const p = toWorld(lx, range(rng, opts.d / 2 + 0.4, dist - 0.4));
    ctx.flowers.push({ x: p.x, y: terrainHeight(p.x, p.z) + 0.13, z: p.z, color: new THREE.Color(pick(rng, cols)), s: range(rng, 0.5, 1.0) });
  }
  if (rng() < 0.4) {
    const p = toWorld((rng() < 0.5 ? -1 : 1) * (halfW + 2.6), range(rng, -opts.d / 2, opts.d / 2));
    if (roadQuery(p.x, p.z).d > 1.5) {
      const kind = t.treeMix > 0.5 ? 'conifer' : 'round';
      ctx.trees.push({ x: p.x, z: p.z, scale: range(rng, 0.55, 0.9), kind, color: treeColor(rng, kind) });
    }
  }
}

/* ================================================================== *
 *  Farms                                                              *
 * ================================================================== */
export function buildFarm(f: FarmDef, v: VillageDef, ctx: BuildCtx) {
  const { c, rng } = ctx;
  const local = (lx: number, lz: number) => localPoint(f, lx, lz);

  const opts = randomHouseOpts(rng, 0.95, v.theme);
  const h = local(-12, 7);
  const hrot = f.rot + Math.PI;
  const ho: Obb = { cx: h.x, cz: h.z, hw: opts.w / 2, hd: opts.d / 2, rot: hrot };
  addHouse(c, mat4(h.x, groundAt(ho) - 0.05, h.z, hrot), opts, rng);
  ctx.obbs.push(ho);

  const b = local(12, 7);
  const bo = addBarn(c, mat4(b.x, terrainHeight(b.x, b.z) - 0.1, b.z, hrot + 0.08), v.theme.roofMat, rng);
  ctx.obbs.push({ cx: b.x, cz: b.z, hw: bo.hw, hd: bo.hd, rot: hrot });

  const yard = local(0, -8);
  addYard(c, mat4(yard.x, terrainHeight(yard.x, yard.z), yard.z, f.rot), 23, 18, 'packed', terrainHeight, 0.16);
  const fieldWalk = local(0, 15);
  addYard(c, mat4(fieldWalk.x, terrainHeight(fieldWalk.x, fieldWalk.z), fieldWalk.z, f.rot), 2.5, 30, 'packed', terrainHeight, 0.17);
  // Footpaths join both entrances to the farm's driveway and yard.
  for (const lx of [-12, 12]) {
    const p = local(lx, 1);
    addYard(c, mat4(p.x, terrainHeight(p.x, p.z), p.z, f.rot), 1.8, 6, 'cobble', terrainHeight, 0.2);
  }
  const cr = local(-6, -7);
  addCrateCluster(c, mat4(cr.x, terrainHeight(cr.x, cr.z), cr.z, f.rot), rng);
  const wp = local(-8, 0);
  addWoodpile(c, mat4(wp.x, terrainHeight(wp.x, wp.z), wp.z, f.rot + 0.4), rng);
  const tr = local(8, -6);
  addTrough(c, mat4(tr.x, terrainHeight(tr.x, tr.z), tr.z, f.rot + 1.2));
  const well = local(-8, -12);
  addWell(c, mat4(well.x, terrainHeight(well.x, well.z), well.z, f.rot));
  ctx.obbs.push({ cx: well.x, cz: well.z, hw: 1.3, hd: 1.3, rot: f.rot });
  for (let i = 0; i < 3; i++) {
    const p = local(range(rng, -3, 22), range(rng, 17, 23));
    addHaystack(c, mat4(p.x, terrainHeight(p.x, p.z), p.z, rng() * 3), rng);
  }
  if (f.mill) {
    const p = local(-29, 9);
    const o = addWindmill(c, mat4(p.x, terrainHeight(p.x, p.z), p.z, f.rot), rng);
    ctx.obbs.push({ cx: p.x, cz: p.z, hw: o.hw, hd: o.hd, rot: f.rot });
    ctx.dynamics.push({ kind: 'mill', x: p.x, y: terrainHeight(p.x, p.z) + o.sailY, z: p.z, rot: f.rot, scale: 1, village: v.id });
  }

  const fields = farmFields(f);
  for (let fieldIndex = 0; fieldIndex < f.plots.length; fieldIndex++) {
    const plot = f.plots[fieldIndex];
    const field = fields[fieldIndex];
    const center = { x: field.cx, z: field.cz, rot: f.rot };
    const fieldY = terrainHeight(field.cx, field.cz);
    const pm = mat4(field.cx, fieldY, field.cz, f.rot);
    const geo = new THREE.PlaneGeometry(plot.w, plot.d, 8, 6);
    geo.rotateX(-Math.PI / 2);
    // drape the field quad over the terrain
    const pp = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pp.count; i++) {
      const w = localPoint(center, pp.getX(i), pp.getZ(i));
      pp.setY(i, terrainHeight(w.x, w.z) - fieldY);
    }
    geo.computeVertexNormals();
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (plot.w / 8), uv.getY(i) * (plot.d / 3.2));
    c.add(`crop${plot.kind}`, geo, pm.clone().multiply(mat4(0, 0.16, 0)));
    addYard(c, pm, 2.4, plot.d + 0.6, 'packed', terrainHeight, 0.235);

    const tufts = Math.min(220, Math.floor((plot.w * plot.d) / 9));
    const plants: number[] = [];
    for (let i = 0; i < tufts; i++) {
      const lx = range(rng, -plot.w / 2 + 0.7, plot.w / 2 - 0.7);
      const lz = range(rng, -plot.d / 2 + 0.7, plot.d / 2 - 0.7);
      if (Math.abs(lx) < 1.6) continue; // clear the walking aisle through the gate
      const w = localPoint(center, lx, lz);
      plants.push(w.x, terrainHeight(w.x, w.z) + 0.18, w.z);
    }
    cropBatch.push({ kind: plot.kind, positions: new Float32Array(plants), village: v.id });
    // Both cross-fences leave a 3.2 m gate aligned with the field aisle.
    const gateWidth = 3.2;
    const wing = (plot.w - gateWidth) / 2;
    for (const lz of [-plot.d / 2, plot.d / 2]) {
      for (const side of [-1, 1]) {
        const fp = localPoint(center, side * (gateWidth / 2 + wing / 2), lz);
        addFence(c, mat4(fp.x, terrainHeight(fp.x, fp.z), fp.z, f.rot), wing, 0, 0x6b5230, terrainHeight);
      }
    }
    for (const [lx, lz, r, len] of [[-plot.w / 2, 0, Math.PI / 2, plot.d], [plot.w / 2, 0, Math.PI / 2, plot.d]] as [number, number, number, number][]) {
      const fp = localPoint(center, lx, lz);
      addFence(c, mat4(fp.x, terrainHeight(fp.x, fp.z), fp.z, f.rot + r), len, 0, 0x6b5230, terrainHeight);
    }
    if (fieldIndex < f.plots.length - 1) {
      const farEdge = FARM_FIELD_START + f.plots.slice(0, fieldIndex + 1).reduce((sum, current) => sum + current.d, 0) + fieldIndex * FARM_FIELD_GAP;
      const pass = local(0, farEdge + FARM_FIELD_GAP / 2);
      addYard(c, mat4(pass.x, terrainHeight(pass.x, pass.z), pass.z, f.rot), 2.4, FARM_FIELD_GAP + 0.8, 'packed', terrainHeight, 0.235);
    }
  }
}
