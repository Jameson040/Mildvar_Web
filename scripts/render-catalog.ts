import * as THREE from 'three';
import zlib from 'node:zlib';
import fs from 'node:fs';
import { Collector, mat4 } from '../src/three/geometry';
import { addHouse, randomHouseOpts, PALETTE, type HouseType } from '../src/three/buildings';
import { addWatchtower } from '../src/three/world/structures';
import { villages, buildRoadNetwork, buildFarms, terrainHeight } from '../src/three/world/land';
import { buildVillage, planVillage, type BuildCtx } from '../src/three/world/villageBuilder';
import { createRoadMeshes } from '../src/three/world/chunks';
import { roads } from '../src/three/world/land';
import { InteractionSystem } from '../src/three/world/interactables';
import type { Obb } from '../src/three/buildings';

/*
 * Offline catalogue renderer: no GPU and no browser needed, so the geometry can
 * be eyeballed in CI. `FRONT=1 npx tsx scripts/render-catalog.ts` draws the
 * street elevations instead of the three-quarter views.
 */

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const BASE: Record<string, number> = {
  stone: 0xbdb5a6, stoneDark: 0x9d9484, stoneDS: 0xbdb5a6, plaster: 0xf1e6cf, tiles: 0xc4694a,
  slate: 0x596270, thatch: 0xb89250, wood: 0x6d5138, canvas: 0xe8e2d0, glass: 0x4a5f78,
  glassChurch: 0x3a4f8e, lampglass: 0xffd48a, leaf: 0x4f7f36, rock: 0x8f8b84, flat: 0xe9e2d3,
};

interface Tri { x: number[]; y: number[]; z: number[]; r: number; g: number; b: number }

function collect(c: Collector): Tri[] {
  const tris: Tri[] = [];
  const v = new THREE.Vector3();
  for (const [key, list] of c.parts) {
    const base = new THREE.Color(BASE[key] ?? 0xcccccc);
    for (const g of list) {
      const p = g.attributes.position as THREE.BufferAttribute;
      const col = g.attributes.color as THREE.BufferAttribute | undefined;
      const avg = new THREE.Color(0, 0, 0);
      if (col) for (let i = 0; i < col.count; i++) avg.r += col.getX(i), avg.g += col.getY(i), avg.b += col.getZ(i);
      if (col) avg.multiplyScalar(1 / col.count);
      const cc = base.clone().multiply(col ? avg : new THREE.Color(1, 1, 1));
      for (let i = 0; i < p.count; i += 3) {
        const t: Tri = { x: [], y: [], z: [], r: cc.r, g: cc.g, b: cc.b };
        for (let k = 0; k < 3; k++) {
          v.set(p.getX(i + k), p.getY(i + k), p.getZ(i + k));
          t.x.push(v.x); t.y.push(v.y); t.z.push(v.z);
        }
        tris.push(t);
      }
    }
  }
  return tris;
}

function render(tris: Tri[], W: number, H: number, azim = 0.55, elev = 0.34, pad = 0.06) {
  const ca = Math.cos(azim), sa = Math.sin(azim), cp = Math.cos(elev), sp = Math.sin(elev);
  const px: number[] = [], py: number[] = [], pz: number[] = [];
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minD = 1e9, maxD = -1e9;
  const proj = tris.map((t) => {
    const out: number[] = [];
    for (let k = 0; k < 3; k++) {
      const x = t.x[k], y = t.y[k], z = t.z[k];
      const xA = x * ca - z * sa;
      const zA = x * sa + z * ca;
      const yA = y * cp - zA * sp;
      const d = zA * cp + y * sp;
      out.push(xA, yA, d);
      minX = Math.min(minX, xA); maxX = Math.max(maxX, xA);
      minY = Math.min(minY, yA); maxY = Math.max(maxY, yA);
      minD = Math.min(minD, d); maxD = Math.max(maxD, d);
    }
    return out;
  });
  const spanX = maxX - minX, spanY = maxY - minY;
  const sc = Math.min((W * (1 - pad * 2)) / spanX, (H * (1 - pad * 2)) / spanY);
  const ox = W / 2 - ((minX + maxX) / 2) * sc;
  const oy = H / 2 + ((minY + maxY) / 2) * sc;
  px.length = 0; py.length = 0; pz.length = 0;
  void pz;
  const buf = new Float32Array(W * H * 3);
  const zb = new Float32Array(W * H).fill(-Infinity);
  for (let i = 0; i < W * H; i++) { // sky gradient
    const t = Math.floor(i / W) / H;
    buf[i * 3] = 0.72 - t * 0.12; buf[i * 3 + 1] = 0.79 - t * 0.1; buf[i * 3 + 2] = 0.84 - t * 0.06;
  }
  const L = new THREE.Vector3(0.45, 0.82, 0.36).normalize();
  tris.forEach((t, ti) => {
    const o = proj[ti];
    const X = [ox + o[0] * sc, ox + o[3] * sc, ox + o[6] * sc];
    const Y = [oy - o[1] * sc, oy - o[4] * sc, oy - o[7] * sc];
    const D = [o[2], o[5], o[8]];
    const ax = t.x[1] - t.x[0], ay = t.y[1] - t.y[0], az = t.z[1] - t.z[0];
    const bx = t.x[2] - t.x[0], by = t.y[2] - t.y[0], bz = t.z[2] - t.z[0];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    let lam = (nx * L.x + ny * L.y + nz * L.z) / nl;
    if (lam < 0) lam = -lam * 0.55; // two-sided: back faces lit dimmer
    const shade = 0.38 + 0.72 * Math.max(0, lam);
    const r = Math.min(1, t.r * shade), g = Math.min(1, t.g * shade), b = Math.min(1, t.b * shade);
    const minx = Math.max(0, Math.floor(Math.min(X[0], X[1], X[2])));
    const maxx = Math.min(W - 1, Math.ceil(Math.max(X[0], X[1], X[2])));
    const miny = Math.max(0, Math.floor(Math.min(Y[0], Y[1], Y[2])));
    const maxy = Math.min(H - 1, Math.ceil(Math.max(Y[0], Y[1], Y[2])));
    const d0 = X[1] - X[0], d1 = X[2] - X[0], e0 = Y[1] - Y[0], e1 = Y[2] - Y[0];
    const den = d0 * e1 - d1 * e0;
    if (Math.abs(den) < 1e-9) return;
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const wx = x + 0.5 - X[0], wy = y + 0.5 - Y[0];
        const u = (wx * e1 - wy * d1) / den;
        const vv = (wy * d0 - wx * e0) / den;
        if (u < 0 || vv < 0 || u + vv > 1) continue;
        const depth = D[0] + (D[1] - D[0]) * u + (D[2] - D[0]) * vv;
        const idx = y * W + x;
        if (depth > zb[idx]) {
          zb[idx] = depth;
          buf[idx * 3] = r; buf[idx * 3 + 1] = g; buf[idx * 3 + 2] = b;
        }
      }
    }
  });
  return { buf, W, H };
}

/* ---------------- PNG writer ---------------- */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b: Buffer) { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePNG(path: string, buf: Float32Array, W: number, H: number) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      for (let k = 0; k < 3; k++) raw[y * (W * 3 + 1) + 1 + x * 3 + k] = Math.max(0, Math.min(255, Math.round(buf[i + k] * 255)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(path, png);
}

const VILLAGE = process.env.VILLAGE === '1';

/* ---------------- a real village, built exactly as the game builds it ---------------- */
function villageTris(): Tri[] {
  buildRoadNetwork();
  buildFarms();
  const mats: Record<string, THREE.Material> = {};
  for (const k of ['stone', 'stoneDark', 'stoneDS', 'plaster', 'tiles', 'slate', 'thatch', 'wood', 'canvas', 'glass', 'glassChurch', 'lampglass', 'leaf', 'rock', 'water', 'fountainWater', 'cobble', 'dirt', 'packed', 'soil', 'flat', 'crop0', 'crop1', 'crop2', 'crop3', 'tuft0', 'tuft1', 'tuft2', 'tuft3', 'awning0', 'awning1', 'awning2', 'awning3']) {
    mats[k] = new THREE.MeshStandardMaterial();
  }
  const inter = new InteractionSystem(mats);
  const obbs: Obb[] = [];
  const ctx: BuildCtx = {
    c: new Collector(), rng: mulberry(4242), obbs, trees: [], hedges: [], flowers: [],
    lamps: [], dynamics: [], theme: villages[0].theme, interactions: inter, plaza: () => {},
  };
  const v = villages[0];
  buildVillage(v, planVillage(v, mulberry(1013)), ctx);
  return collect(ctx.c);
}

/* ---------------- compose the sheet ---------------- */
if (VILLAGE) {
  const cx = 0, cz = 0, RAD = 240;
  const near = (x: number, z: number) => Math.hypot(x - cx, z - cz) < RAD;
  const tris = villageTris().filter((t) => near(t.x[0], t.z[0]));
  // roads are built by their own system; pull the ones crossing the village in
  {
    const group = createRoadMeshes({ cobble: null, dirt: null, stone: null } as never, roads);
    const v = new THREE.Vector3();
    for (const obj of group.children) {
      const m = obj as THREE.Mesh;
      const g = m.geometry as THREE.BufferGeometry;
      const mat = m.material as THREE.MeshStandardMaterial;
      const pos = g.attributes.position as THREE.BufferAttribute;
      const col = g.attributes.color as THREE.BufferAttribute | undefined;
      const idx = g.index!;
      for (let t = 0; t < idx.count; t += 3) {
        const ids = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
        const tri: Tri = { x: [], y: [], z: [], r: 0, g: 0, b: 0 };
        let inside = false;
        const cc = new THREE.Color(0, 0, 0);
        for (const id of ids) {
          v.set(pos.getX(id), pos.getY(id), pos.getZ(id));
          if (near(v.x, v.z)) inside = true;
          tri.x.push(v.x); tri.y.push(v.y); tri.z.push(v.z);
          if (col) { cc.r += col.getX(id) / 3; cc.g += col.getY(id) / 3; cc.b += col.getZ(id) / 3; }
        }
        if (!inside) continue;
        const tint = col ? cc : new THREE.Color(1, 1, 1);
        const tx = mat.map ? 0.6 : mat.color.getHexString() === 'ffffff' ? 0.55 : 1;
        tri.r = mat.color.r * tint.r * tx; tri.g = mat.color.g * tint.g * tx; tri.b = mat.color.b * tint.b * tx;
        tris.push(tri);
      }
    }
  }
  const b = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const t of tris) for (let k = 0; k < 3; k++) b.expandByPoint(v.set(t.x[k], t.y[k], t.z[k]));
  console.log(`village: ${tris.length} tris · bounds x[${b.min.x.toFixed(0)}, ${b.max.x.toFixed(0)}] z[${b.min.z.toFixed(0)}, ${b.max.z.toFixed(0)}] y[${b.min.y.toFixed(0)}, ${b.max.y.toFixed(0)}]`);
  const VW = 1500, VH = 700;
  const img = render(tris, VW, VH, 0.62, 0.42, 0.02);
  writePNG('docs/village-view.png', img.buf, VW, VH);
  console.log('wrote docs/village-view.png');
  process.exit(0);
}

const types: HouseType[] = ['cottage', 'townhouse', 'longhouse', 'hall', 'workshop', 'manor'];
const AZ = process.env.FRONT === '1' ? 0.0 : 0.55;
const EL = process.env.FRONT === '1' ? 0.12 : 0.3;
const TW = 340, TH = 400, COLS = 4, ROWS = 2;
const W = TW * COLS, H = TH * ROWS;
const sheet = new Float32Array(W * H * 3).fill(0.12);
const tiles: Tri[][] = [];
for (const type of types) {
  const rng = mulberry(4242);
  const o = randomHouseOpts(rng, 1, PALETTE, type);
  const c = new Collector();
  addHouse(c, mat4(0, 0, 0), o, rng);
  tiles.push(collect(c));
}
const FRONT = process.env.FRONT === '1';
const tw = new Collector();
addWatchtower(tw, mat4(0, 0, 0));
tiles.push(collect(tw));
// a jettied townhouse from the other side, and a manor from the front
{
  const rng = mulberry(99);
  const o = randomHouseOpts(rng, 1.05, PALETTE, 'townhouse');
  const c = new Collector();
  addHouse(c, mat4(0, 0, 0), o, rng);
  tiles.push(collect(c));
}
tiles.forEach((tris, i) => {
  const r = render(tris, TW, TH, AZ, EL);
  const cx = (i % COLS) * TW, cy = Math.floor(i / COLS) * TH;
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
    const s = (y * TW + x) * 3, d = ((cy + y) * W + cx + x) * 3;
    sheet[d] = r.buf[s]; sheet[d + 1] = r.buf[s + 1]; sheet[d + 2] = r.buf[s + 2];
  }
  // frame
  for (let x = 0; x < TW; x++) { const a = (cy * W + cx + x) * 3, b = ((cy + TH - 1) * W + cx + x) * 3; sheet[a] = sheet[a + 1] = sheet[a + 2] = 0.3; sheet[b] = sheet[b + 1] = sheet[b + 2] = 0.3; }
  for (let y = 0; y < TH; y++) { const a = ((cy + y) * W + cx) * 3, b = ((cy + y) * W + cx + TW - 1) * 3; sheet[a] = sheet[a + 1] = sheet[a + 2] = 0.3; sheet[b] = sheet[b + 1] = sheet[b + 2] = 0.3; }
});
writePNG(FRONT ? 'docs/house-fronts.png' : 'docs/house-catalog.png', sheet, W, H);
console.log('wrote docs/house-catalog.png', W, H, 'tris per tile', tiles.map((t) => t.length).join(', '));
