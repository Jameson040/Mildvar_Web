/*
 * Offline road cross-section render. Builds the real road network, runs the
 * real `createRoadMeshes`, and paints two windows of it with a software
 * rasteriser so the paving / shoulder / kerb / ruts can be checked without a
 * browser.  `npx tsx scripts/render-roads.ts`
 */
import * as THREE from 'three';
import zlib from 'node:zlib';
import fs from 'node:fs';
import { buildRoadNetwork, roads, terrainHeight } from '../src/three/world/land';
import { createRoadMeshes } from '../src/three/world/chunks';

interface Tri { x: number[]; y: number[]; z: number[]; r: number; g: number; b: number }

/** A patch of real terrain under the window, so the road can be judged in place. */
function groundTris(cx: number, cz: number, rad: number): Tri[] {
  const step = 3;
  const tris: Tri[] = [];
  for (let z = cz - rad; z < cz + rad; z += step) {
    for (let x = cx - rad; x < cx + rad; x += step) {
      const y00 = terrainHeight(x, z), y10 = terrainHeight(x + step, z);
      const y01 = terrainHeight(x, z + step), y11 = terrainHeight(x + step, z + step);
      const shade = 0.55 + 0.1 * Math.sin(x * 0.21 + z * 0.17);
      const push = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx2: number, cy2: number, cz2: number) =>
        tris.push({ x: [ax, bx, cx2], y: [ay, by, cy2], z: [az, bz, cz2], r: 0.30 * shade, g: 0.46 * shade, b: 0.20 * shade });
      push(x, y00, z, x, y01, z + step, x + step, y10, z);
      push(x + step, y10, z, x, y01, z + step, x + step, y11, z + step);
    }
  }
  return tris;
}

function collectMeshes(group: THREE.Group, cx: number, cz: number, rad: number): Tri[] {
  const tris: Tri[] = [];
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
        if (Math.hypot(v.x - cx, v.z - cz) < rad) inside = true;
        tri.x.push(v.x); tri.y.push(v.y); tri.z.push(v.z);
        if (col) cc.r += col.getX(id) / 3, cc.g += col.getY(id) / 3, cc.b += col.getZ(id) / 3;
      }
      if (!inside) continue;
      const tint = col ? cc : new THREE.Color(1, 1, 1);
      // stand-in for the real textures, which are not available headlessly
      const tx = mat.map ? 0.62 : (mat.color.getHexString() === 'ffffff' ? 0.55 : 1);
      tri.r = mat.color.r * tint.r * tx; tri.g = mat.color.g * tint.g * tx; tri.b = mat.color.b * tint.b * tx;
      tris.push(tri);
    }
  }
  return tris;
}

function render(tris: Tri[], W: number, H: number, azim: number, elev: number) {
  const ca = Math.cos(azim), sa = Math.sin(azim), cp = Math.cos(elev), sp = Math.sin(elev);
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
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
    }
    return out;
  });
  const sc = Math.min(W / (maxX - minX), H / (maxY - minY)) * 0.94;
  const ox = W / 2 - ((minX + maxX) / 2) * sc;
  const oy = H / 2 + ((minY + maxY) / 2) * sc;
  const buf = new Float32Array(W * H * 3);
  const zb = new Float32Array(W * H).fill(-Infinity);
  for (let i = 0; i < W * H; i++) { const t = Math.floor(i / W) / H; buf[i * 3] = 0.6 - t * 0.1; buf[i * 3 + 1] = 0.7 - t * 0.08; buf[i * 3 + 2] = 0.74 - t * 0.04; }
  const L = new THREE.Vector3(0.4, 0.86, 0.3).normalize();
  tris.forEach((t, ti) => {
    const o = proj[ti];
    const X = [ox + o[0] * sc, ox + o[3] * sc, ox + o[6] * sc];
    const Y = [oy - o[1] * sc, oy - o[4] * sc, oy - o[7] * sc];
    const D = [o[2], o[5], o[8]];
    const ax = t.x[1] - t.x[0], ay = t.y[1] - t.y[0], az = t.z[1] - t.z[0];
    const bx = t.x[2] - t.x[0], by = t.y[2] - t.y[0], bz = t.z[2] - t.z[0];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const lam = Math.abs(nx * L.x + ny * L.y + nz * L.z) / nl;
    const shade = 0.45 + 0.7 * lam;
    const r = Math.min(1, t.r * shade), g = Math.min(1, t.g * shade), b = Math.min(1, t.b * shade);
    const minx = Math.max(0, Math.floor(Math.min(...X)));
    const maxx = Math.min(W - 1, Math.ceil(Math.max(...X)));
    const miny = Math.max(0, Math.floor(Math.min(...Y)));
    const maxy = Math.min(H - 1, Math.ceil(Math.max(...Y)));
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
        const id = y * W + x;
        if (depth > zb[id]) { zb[id] = depth; buf[id * 3] = r; buf[id * 3 + 1] = g; buf[id * 3 + 2] = b; }
      }
    }
  });
  return buf;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Buffer) { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function writePNG(path: string, buf: Float32Array, W: number, H: number) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 3; k++)
    raw[y * (W * 3 + 1) + 1 + x * 3 + k] = Math.max(0, Math.min(255, Math.round(buf[(y * W + x) * 3 + k] * 255)));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

buildRoadNetwork();
const group = createRoadMeshes({ cobble: null, dirt: null, stone: null } as never, roads);
const town = roads.find((r) => r.kind === 'cobble')!;
const country = roads.find((r) => r.kind === 'dirt')!;
const pick = (r: typeof town, t: number) => r.samples[Math.floor(r.samples.length * t)];
const a = pick(town, 0.5), b = pick(country, 0.45);
const TW = 900, TH = 430;
const W = TW, H = TH * 2;
const sheet = new Float32Array(W * H * 3);
const views = [
  { c: a, rad: 20, az: 1.0, el: 0.17, label: 'cobble lane' },
  { c: b, rad: 26, az: 1.45, el: 0.16, label: 'country road' },
];
views.forEach((v, i) => {
  const tris = [...groundTris(v.c.x, v.c.z, v.rad), ...collectMeshes(group, v.c.x, v.c.z, v.rad)];
  const img = render(tris, TW, TH, v.az, v.el);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) for (let k = 0; k < 3; k++)
    sheet[((i * TH + y) * W + x) * 3 + k] = img[(y * TW + x) * 3 + k];
  console.log(`view ${i}: ${tris.length} tris around ${v.c.x.toFixed(0)},${v.c.z.toFixed(0)} (${v.label})`);
});
writePNG('docs/road-cross-sections.png', sheet, W, H);
console.log('wrote docs/road-cross-sections.png');
