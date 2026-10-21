import * as THREE from 'three';
import { Collector, box, gableRoof, gableEnds, hipRoof, pyramid, mat4 } from './geometry';
import { RNG, pick, range } from './noise';

export const PALETTE: ThemePalette & { timber: number; doorWood: number; trim: number } = {
  roofMat: 'tiles',
  roofs: [0xb5583c, 0xc26a48, 0xa84e36, 0x9c5a44, 0xb86f50, 0x8d6a5a, 0x7c6f6a, 0xc47a55],
  plasters: [0xf3e7cf, 0xf5ecd9, 0xe8d8b6, 0xf1dfc0, 0xe9cfae, 0xf6efe2, 0xd9c5a0, 0xeadbc8, 0xf0d9c8, 0xdfe4d4],
  stones: [0xc9bfae, 0xbfb4a3, 0xd2c8b6, 0xb8ab97],
  shutters: [0x3d6b4f, 0x4a6a8a, 0x8a4b3b, 0x5c4a3a, 0x6b7d5a],
  styles: { stone: 0.4, plaster: 0.32, timber: 0.28 },
  floorsMax: 3,
  timber: 0x4a3524,
  doorWood: 0x5a3a22,
  trim: 0xf8f3e8,
};

export interface Obb {
  cx: number;
  cz: number;
  hw: number;
  hd: number;
  rot: number;
}

export interface ThemePalette {
  roofs: number[];
  plasters: number[];
  stones: number[];
  shutters: number[];
  styles: { stone: number; plaster: number; timber: number };
  floorsMax: number;
  roofMat: string;
}

export interface HouseOpts {
  w: number;
  d: number;
  floors: number;
  style: 'stone' | 'plaster' | 'timber';
  roofColor: number;
  roofMat: string;
  wallColor: number;
  roofType: 'gable' | 'hip';
  ridgeAlongFront: boolean;
  chimney: boolean;
  dormers: boolean;
  shutters: boolean;
  shutterColor: number;
  ivy: boolean;
}

export function randomHouseOpts(rng: RNG, scale = 1, theme?: ThemePalette): HouseOpts {
  const pal: ThemePalette = theme ?? PALETTE;
  const roll = rng();
  const st = pal.styles;
  const style: HouseOpts['style'] = roll < st.stone ? 'stone' : roll < st.stone + st.plaster ? 'plaster' : 'timber';
  const maxF = Math.max(1, pal.floorsMax);
  const fr = rng();
  let floors = maxF >= 3 ? (fr < 0.6 ? 2 : fr < 0.78 ? 1 : 3) : maxF === 2 ? (fr < 0.68 ? 1 : 2) : 1;
  if (maxF < floors) floors = maxF;
  return {
    w: range(rng, 6, 10) * scale,
    d: range(rng, 5.5, 8) * scale,
    floors,
    style,
    roofMat: pal.roofMat,
    roofColor: pick(rng, pal.roofs),
    wallColor: style === 'stone' ? pick(rng, pal.stones) : pick(rng, pal.plasters),
    roofType: rng() < 0.82 ? 'gable' : 'hip',
    ridgeAlongFront: rng() < 0.65,
    chimney: rng() < 0.85,
    dormers: pal.roofMat === 'tiles' && rng() < 0.45,
    shutters: rng() < 0.5,
    shutterColor: pick(rng, pal.shutters),
    ivy: rng() < 0.3,
  };
}

const FLOOR_H = 3;

export function houseDoorX(w: number) {
  const nWin = Math.max(1, Math.floor((w - 1.2) / 2));
  const spacing = w / (nWin + 1);
  const doorIdx = Math.floor(nWin / 2);
  return nWin % 2 === 1 ? 0 : -w / 2 + spacing * (doorIdx + 1) - spacing / 2;
}

function addWindow(c: Collector, base: THREE.Matrix4, x: number, y: number, z: number, rotY: number, w = 0.9, h = 1.1, shutters?: number) {
  const m = base.clone().multiply(mat4(x, y, z, rotY));
  c.add('flat', box(w + 0.2, h + 0.2, 0.12), m.clone().multiply(mat4(0, 0, 0.02)), PALETTE.trim);
  c.add('glass', box(w, h, 0.12), m.clone().multiply(mat4(0, 0, 0.05)));
  // cross muntin
  c.add('flat', box(0.05, h, 0.14), m.clone().multiply(mat4(0, 0, 0.06)), PALETTE.trim);
  c.add('flat', box(w, 0.05, 0.14), m.clone().multiply(mat4(0, 0, 0.06)), PALETTE.trim);
  // sill
  c.add('flat', box(w + 0.35, 0.08, 0.25), m.clone().multiply(mat4(0, -h / 2 - 0.1, 0.1)), PALETTE.trim);
  if (shutters !== undefined) {
    c.add('wood', box(0.4, h + 0.1, 0.08), m.clone().multiply(mat4(-w / 2 - 0.32, 0, 0.04)), shutters);
    c.add('wood', box(0.4, h + 0.1, 0.08), m.clone().multiply(mat4(w / 2 + 0.32, 0, 0.04)), shutters);
  }
}

function addDoor(c: Collector, base: THREE.Matrix4, x: number, z: number, rotY: number, w = 1.1, h = 2.2) {
  const m = base.clone().multiply(mat4(x, 0, z, rotY));
  c.add('flat', box(w + 0.3, h + 0.15, 0.12), m.clone().multiply(mat4(0, (h + 0.15) / 2, 0.02)), PALETTE.trim);
  c.add('wood', box(w, h, 0.12), m.clone().multiply(mat4(0, h / 2, 0.06)), PALETTE.doorWood);
  c.add('flat', new THREE.SphereGeometry(0.05, 6, 4), m.clone().multiply(mat4(w * 0.3, 1.05, 0.14)), 0xd8b25a);
  // step
  c.add('stone', box(w + 0.6, 0.15, 0.5), m.clone().multiply(mat4(0, 0.075, 0.3)), 0xaaa194);
}

function addTimberFrame(c: Collector, base: THREE.Matrix4, faceW: number, H: number, floors: number, rotY: number, offset: number) {
  // frame on a face; local face coordinate: x across, y up, z toward outside
  const m = base.clone().multiply(mat4(0, 0, 0, rotY)).multiply(mat4(0, 0, offset));
  const t = 0.16;
  const col = PALETTE.timber;
  // horizontals
  for (let f = 0; f <= floors; f++) {
    const y = Math.min(H - 0.1, f * FLOOR_H + (f === 0 ? 0.1 : 0));
    c.add('wood', box(faceW + 0.05, t, 0.1), m.clone().multiply(mat4(0, y, 0.05)), col);
  }
  // verticals
  const n = Math.max(2, Math.round(faceW / 1.6));
  for (let i = 0; i <= n; i++) {
    const x = -faceW / 2 + (faceW / n) * i;
    c.add('wood', box(t, H, 0.1), m.clone().multiply(mat4(x, H / 2, 0.05)), col);
  }
  // diagonal braces on upper floors
  for (let f = 1; f < floors; f++) {
    for (let i = 0; i < n; i += 2) {
      const x0 = -faceW / 2 + (faceW / n) * i;
      const x1 = x0 + faceW / n;
      const cx = (x0 + x1) / 2;
      const cy = f * FLOOR_H + FLOOR_H / 2;
      const len = Math.hypot(x1 - x0, FLOOR_H) * 0.92;
      const ang = Math.atan2(FLOOR_H, x1 - x0) * (i % 4 === 0 ? 1 : -1);
      const mm = m.clone().multiply(mat4(cx, cy, 0.04)).multiply(new THREE.Matrix4().makeRotationZ(ang));
      c.add('wood', box(len, t * 0.8, 0.08), mm, col);
    }
  }
}

export function addHouse(c: Collector, base: THREE.Matrix4, o: HouseOpts, rng: RNG): Obb {
  const H = o.floors * FLOOR_H;
  const wallKey = o.style === 'stone' ? 'stone' : 'plaster';
  const w = o.w;
  const d = o.d;
  // Walls
  c.add(wallKey, box(w, H, d), base.clone().multiply(mat4(0, H / 2, 0)), o.wallColor);
  // Foundation stripe
  c.add('stone', box(w + 0.1, 0.5, d + 0.1), base.clone().multiply(mat4(0, 0.25, 0)), 0x9d9385);

  // Roof
  const ridgeLen = o.ridgeAlongFront ? w : d;
  const span = o.ridgeAlongFront ? d : w;
  const roofH = span * 0.5 * range(rng, 0.85, 1.1);
  const roofRot = o.ridgeAlongFront ? 0 : Math.PI / 2;
  const roofM = base.clone().multiply(mat4(0, H, 0, roofRot));
  if (o.roofType === 'gable') {
    c.add(o.roofMat, gableRoof(ridgeLen, span, roofH), roofM, o.roofColor);
    c.add(wallKey, gableEnds(ridgeLen, span, roofH), roofM, o.wallColor);
    if (o.style === 'timber') {
      // beams on gable ends
      for (const s of [-1, 1]) {
        const gm = roofM.clone().multiply(mat4(s * ridgeLen / 2, 0, 0, s > 0 ? Math.PI / 2 : -Math.PI / 2));
        c.add('wood', box(span * 0.9, 0.14, 0.1), gm.clone().multiply(mat4(0, 0.6, 0.06)), PALETTE.timber);
        c.add('wood', box(0.14, roofH * 0.9, 0.1), gm.clone().multiply(mat4(0, roofH * 0.45, 0.06)), PALETTE.timber);
      }
    }
  } else {
    c.add(o.roofMat, hipRoof(ridgeLen, span, roofH * 0.8), roofM, o.roofColor);
  }
  // Ridge cap
  if (o.roofType === 'gable') {
    c.add('flat', box(ridgeLen + 0.9, 0.18, 0.3), roofM.clone().multiply(mat4(0, roofH + 0.02, 0)), new THREE.Color(o.roofColor).multiplyScalar(0.7));
  }

  // Timber framing
  if (o.style === 'timber') {
    addTimberFrame(c, base, w, H, o.floors, 0, d / 2);
    addTimberFrame(c, base, w, H, o.floors, Math.PI, d / 2);
    addTimberFrame(c, base, d, H, o.floors, Math.PI / 2, w / 2);
    addTimberFrame(c, base, d, H, o.floors, -Math.PI / 2, w / 2);
  }

  // Windows & door on front (+z) and back
  const nWin = Math.max(1, Math.floor((w - 1.2) / 2.0));
  const spacing = w / (nWin + 1);
  const doorX = houseDoorX(w);
  const shut = o.shutters ? o.shutterColor : undefined;
  for (let f = 0; f < o.floors; f++) {
    const y = f * FLOOR_H + (f === 0 ? 1.7 : 1.75);
    for (let i = 0; i < nWin; i++) {
      const x = -w / 2 + spacing * (i + 1);
      if (f === 0 && Math.abs(x - doorX) < spacing * 0.6) continue;
      addWindow(c, base, x, y, d / 2, 0, 0.9, 1.15, shut);
      if (rng() < 0.7) addWindow(c, base, -x, y, -d / 2, Math.PI, 0.9, 1.15, shut);
    }
    // side windows
    const nSide = Math.max(1, Math.floor((d - 1.5) / 2.4));
    const sSp = d / (nSide + 1);
    for (let i = 0; i < nSide; i++) {
      const z = -d / 2 + sSp * (i + 1);
      if (rng() < 0.6) addWindow(c, base, w / 2, y, z, Math.PI / 2, 0.8, 1.1, shut);
      if (rng() < 0.6) addWindow(c, base, -w / 2, y, z, -Math.PI / 2, 0.8, 1.1, shut);
    }
  }
  addDoor(c, base, doorX, d / 2, 0);

  // Dormers on front slope (only if ridge along front and gable)
  if (o.dormers && o.roofType === 'gable' && o.ridgeAlongFront && roofH > 1.6) {
    const nD = w > 8 ? 2 : 1;
    for (let i = 0; i < nD; i++) {
      const x = nD === 1 ? 0 : (i === 0 ? -w / 4 : w / 4);
      const k = roofH / (span / 2);
      const zc = span * 0.22;
      const yBase = H + roofH - zc * k - 0.9;
      const dm = base.clone().multiply(mat4(x, yBase, zc));
      c.add(wallKey, box(1.5, 1.7, 1.6), dm.clone().multiply(mat4(0, 0.85, 0)), o.wallColor);
      c.add(o.roofMat, gableRoof(1.5, 1.6, 0.8, 0.2), dm.clone().multiply(mat4(0, 1.7, 0)), o.roofColor);
      c.add(wallKey, gableEnds(1.5, 1.6, 0.8), dm.clone().multiply(mat4(0, 1.7, 0)), o.wallColor);
      addWindow(c, dm, 0, 0.95, 0.8, 0, 0.7, 0.8);
    }
  }

  // Chimney
  if (o.chimney) {
    const cx = o.ridgeAlongFront ? range(rng, -w / 3, w / 3) : 0;
    const cz = o.ridgeAlongFront ? range(rng, -0.4, 0.4) : range(rng, -d / 3, d / 3);
    const top = H + roofH + 0.9;
    c.add('stone', box(0.9, top - H + 1.5, 0.9), base.clone().multiply(mat4(cx, (top + H - 1.5) / 2, cz)), 0xa88a74);
    c.add('stone', box(1.1, 0.25, 1.1), base.clone().multiply(mat4(cx, top + 0.1, cz)), 0x8d7260);
    c.add('flat', new THREE.CylinderGeometry(0.16, 0.16, 0.4, 8), base.clone().multiply(mat4(cx, top + 0.4, cz)), 0x5a4a40);
  }

  // Ivy blobs
  if (o.ivy) {
    const n = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const x = range(rng, -w / 2 + 0.6, w / 2 - 0.6);
      const y = range(rng, 0.6, H * 0.7);
      const r = range(rng, 0.5, 1.1);
      c.add('leaf', new THREE.SphereGeometry(r, 7, 5), base.clone().multiply(mat4(x, y, d / 2 + 0.05, 0, 1, 1.3, 0.25)), 0x3f6b2e);
    }
  }

  return { cx: 0, cz: 0, hw: w / 2, hd: d / 2, rot: 0 };
}

function addArchedWindow(c: Collector, m: THREE.Matrix4, w: number, h: number) {
  // Gothic-ish arched window facing +z in local
  c.add('stoneDark', box(w + 0.3, h, 0.2), m.clone().multiply(mat4(0, h / 2, 0.02)), 0x8f8577);
  c.add('glassChurch', box(w, h, 0.2), m.clone().multiply(mat4(0, h / 2, 0.06)));
  const cyl = new THREE.CylinderGeometry(w / 2 + 0.15, w / 2 + 0.15, 0.2, 12, 1, false, Math.PI / 2, Math.PI);
  c.add('stoneDark', cyl, m.clone().multiply(mat4(0, h, 0.02)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)), 0x8f8577);
  const cyl2 = new THREE.CylinderGeometry(w / 2, w / 2, 0.2, 12, 1, false, Math.PI / 2, Math.PI);
  c.add('glassChurch', cyl2, m.clone().multiply(mat4(0, h, 0.06)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
}

export function addChurch(c: Collector, base: THREE.Matrix4): Obb[] {
  const naveW = 11;
  const naveD = 24;
  const naveH = 8.5;
  const stone = 0xcfc6b5;
  const roofCol = 0x6f6a68;
  // Nave (ridge along z => rotate roof)
  c.add('stone', box(naveW, naveH, naveD), base.clone().multiply(mat4(0, naveH / 2, -2)), stone);
  const rm = base.clone().multiply(mat4(0, naveH, -2, Math.PI / 2));
  c.add('tiles', gableRoof(naveD, naveW, 4.5), rm, roofCol);
  c.add('stone', gableEnds(naveD, naveW, 4.5), rm, stone);
  // Buttresses
  for (let i = 0; i < 5; i++) {
    const z = -2 - naveD / 2 + 2.5 + i * (naveD - 5) / 4;
    for (const s of [-1, 1]) {
      c.add('stone', box(0.9, 5.5, 1.2), base.clone().multiply(mat4(s * (naveW / 2 + 0.4), 2.75, z)), stone);
    }
  }
  // Side arched windows
  for (let i = 0; i < 4; i++) {
    const z = -2 - naveD / 2 + 4.9 + i * (naveD - 5) / 4;
    for (const s of [-1, 1]) {
      addArchedWindow(c, base.clone().multiply(mat4(s * naveW / 2, 2.2, z, s * Math.PI / 2)), 1.2, 3.2);
    }
  }
  // Apse at back
  c.add('stone', new THREE.CylinderGeometry(naveW / 2 - 1, naveW / 2 - 1, naveH - 1, 12, 1, false, 0, Math.PI), base.clone().multiply(mat4(0, (naveH - 1) / 2, -2 - naveD / 2)).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)), stone);
  c.add('tiles', new THREE.ConeGeometry(naveW / 2 - 0.4, 3, 12, 1, false, 0, Math.PI), base.clone().multiply(mat4(0, naveH - 1, -2 - naveD / 2)).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)), roofCol);

  // Tower at front
  const tw = 6.5;
  const th = 20;
  const tz = naveD / 2 - 2 + 1.5;
  c.add('stone', box(tw, th, tw), base.clone().multiply(mat4(0, th / 2, tz)), stone);
  // Corner pilasters
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    c.add('stone', box(0.7, th, 0.7), base.clone().multiply(mat4(sx * tw / 2, th / 2, tz + sz * tw / 2)), 0xbfb5a3);
  }
  // Belfry openings
  for (let i = 0; i < 4; i++) {
    const rot = i * Math.PI / 2;
    const m = base.clone().multiply(mat4(0, 0, tz, rot)).multiply(mat4(0, 0, tw / 2));
    addArchedWindow(c, m.clone().multiply(mat4(-0.9, th - 5.5, 0)), 0.9, 2.2);
    addArchedWindow(c, m.clone().multiply(mat4(0.9, th - 5.5, 0)), 0.9, 2.2);
    // clock
    c.add('flat', new THREE.CylinderGeometry(1.3, 1.3, 0.15, 24), m.clone().multiply(mat4(0, th - 9, 0.05)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)), 0xf6f1e4);
    c.add('flat', new THREE.TorusGeometry(1.3, 0.1, 6, 24), m.clone().multiply(mat4(0, th - 9, 0.12)), 0x2a2622);
    c.add('flat', box(0.1, 0.9, 0.06), m.clone().multiply(mat4(0, th - 9 + 0.45, 0.16)), 0x2a2622);
    c.add('flat', box(0.6, 0.1, 0.06), m.clone().multiply(mat4(0.3, th - 9, 0.16)), 0x2a2622);
  }
  // Cornice
  c.add('stone', box(tw + 0.8, 0.5, tw + 0.8), base.clone().multiply(mat4(0, th, tz)), 0xbfb5a3);
  // Spire
  c.add('tiles', pyramid(tw + 0.6, 13), base.clone().multiply(mat4(0, th + 0.25, tz)), 0x5f5a5c);
  // Finial cross
  c.add('flat', box(0.12, 1.6, 0.12), base.clone().multiply(mat4(0, th + 13.9, tz)), 0xd8b25a);
  c.add('flat', box(0.9, 0.12, 0.12), base.clone().multiply(mat4(0, th + 14.3, tz)), 0xd8b25a);
  // Main door
  const dm = base.clone().multiply(mat4(0, 0, tz + tw / 2));
  c.add('stoneDark', box(3.2, 4.4, 0.3), dm.clone().multiply(mat4(0, 2.2, 0.05)), 0x8f8577);
  c.add('wood', box(2.4, 3.8, 0.3), dm.clone().multiply(mat4(0, 1.9, 0.12)), 0x4a2f1c);
  c.add('stoneDark', new THREE.CylinderGeometry(1.6, 1.6, 0.3, 14, 1, false, Math.PI / 2, Math.PI), dm.clone().multiply(mat4(0, 4.4, 0.05)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)), 0x8f8577);
  c.add('wood', new THREE.CylinderGeometry(1.2, 1.2, 0.3, 14, 1, false, Math.PI / 2, Math.PI), dm.clone().multiply(mat4(0, 3.8, 0.12)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)), 0x4a2f1c);
  // steps
  c.add('stone', box(5, 0.3, 1.2), dm.clone().multiply(mat4(0, 0.15, 0.6)), 0xaaa194);
  c.add('stone', box(6, 0.15, 2), dm.clone().multiply(mat4(0, 0.075, 1.0)), 0xaaa194);

  return [
    { cx: 0, cz: -2, hw: naveW / 2 + 0.6, hd: naveD / 2 + 1, rot: 0 },
    { cx: 0, cz: tz, hw: tw / 2 + 0.3, hd: tw / 2 + 0.3, rot: 0 },
  ];
}

export function addTownHall(c: Collector, base: THREE.Matrix4): Obb[] {
  const W = 22;
  const D = 12;
  const H = 10.5;
  const wall = 0xe8dcc3;
  const roofCol = 0x5d6670;
  c.add('plaster', box(W, H, D), base.clone().multiply(mat4(0, H / 2, 0)), wall);
  c.add('stone', box(W + 0.2, 1.2, D + 0.2), base.clone().multiply(mat4(0, 0.6, 0)), 0xb7ab97);
  // Quoins
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    c.add('stone', box(0.8, H, 0.8), base.clone().multiply(mat4(sx * W / 2, H / 2, sz * D / 2)), 0xd3c8b2);
  }
  // Cornice
  c.add('flat', box(W + 0.8, 0.4, D + 0.8), base.clone().multiply(mat4(0, H, 0)), 0xf4ecdc);
  c.add('tiles', hipRoof(W, D, 4.2), base.clone().multiply(mat4(0, H + 0.2, 0)), roofCol);
  // Central pavilion
  const pw = 8;
  const pd = 1.6;
  c.add('plaster', box(pw, H + 0.6, pd), base.clone().multiply(mat4(0, (H + 0.6) / 2, D / 2 + pd / 2 - 0.1)), 0xf0e6d0);
  c.add('flat', gableEnds(0.01, pw, 2.4), base.clone().multiply(mat4(0, H + 0.6, D / 2 + pd / 2, Math.PI / 2)), 0xf4ecdc);
  c.add('tiles', gableRoof(pd + 0.6, pw, 2.4, 0.3), base.clone().multiply(mat4(0, H + 0.6, D / 2 + pd / 2 - 0.1, Math.PI / 2)), roofCol);
  // Portico columns & balcony
  for (let i = 0; i < 4; i++) {
    const x = -3 + i * 2;
    c.add('flat', new THREE.CylinderGeometry(0.35, 0.4, 5.8, 12), base.clone().multiply(mat4(x, 3.4, D / 2 + 2.8)), 0xf4ecdc);
    c.add('flat', box(0.9, 0.3, 0.9), base.clone().multiply(mat4(x, 6.4, D / 2 + 2.8)), 0xf4ecdc);
  }
  c.add('flat', box(pw + 1, 0.5, 3.4), base.clone().multiply(mat4(0, 6.75, D / 2 + 1.7)), 0xf4ecdc);
  // Balustrade
  for (let i = 0; i <= 9; i++) {
    c.add('flat', new THREE.CylinderGeometry(0.1, 0.13, 1, 6), base.clone().multiply(mat4(-4.3 + i * 0.96, 7.5, D / 2 + 3.3)), 0xf4ecdc);
  }
  c.add('flat', box(pw + 1, 0.15, 0.3), base.clone().multiply(mat4(0, 8.05, D / 2 + 3.3)), 0xf4ecdc);
  // Steps
  for (let i = 0; i < 4; i++) {
    c.add('stone', box(pw + 2 + i * 0.8, 0.2, 1 + i * 0.6), base.clone().multiply(mat4(0, 0.7 - i * 0.2, D / 2 + 3.8 + i * 0.3)), 0xb7ab97);
  }
  // Door
  const dm = base.clone().multiply(mat4(0, 0.8, D / 2 + pd - 0.1));
  c.add('wood', box(2.4, 3.6, 0.2), dm.clone().multiply(mat4(0, 1.8, 0.05)), 0x4a2f1c);
  c.add('flat', box(2.9, 4, 0.12), dm.clone().multiply(mat4(0, 2.0, 0.0)), 0xf4ecdc);
  // Windows
  for (let f = 0; f < 3; f++) {
    const y = 2.3 + f * 3.2;
    for (let i = 0; i < 7; i++) {
      const x = -9 + i * 3;
      if (Math.abs(x) < 3.2 && f === 0) continue;
      if (Math.abs(x) < 1 && f === 1) continue;
      addWindow(c, base, x, y, D / 2, 0, 1.1, f === 0 ? 2.0 : 1.6);
      addWindow(c, base, -x, y, -D / 2, Math.PI, 1.1, 1.6);
    }
    for (let i = 0; i < 3; i++) {
      const z = -3.5 + i * 3.5;
      addWindow(c, base, W / 2, y, z, Math.PI / 2, 1.1, 1.6);
      addWindow(c, base, -W / 2, y, z, -Math.PI / 2, 1.1, 1.6);
    }
  }
  // Cupola
  const cy = H + 4.2;
  c.add('flat', new THREE.CylinderGeometry(2.2, 2.4, 0.6, 8), base.clone().multiply(mat4(0, cy + 0.3, 0)), 0xe3dac5);
  c.add('flat', new THREE.CylinderGeometry(1.7, 1.7, 2.8, 8), base.clone().multiply(mat4(0, cy + 2, 0)), 0xf4ecdc);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const m = base.clone().multiply(mat4(Math.sin(a) * 1.7, cy + 2, Math.cos(a) * 1.7, a));
    c.add('glass', box(0.7, 1.6, 0.1), m, 0x223344);
  }
  c.add('flat', new THREE.CylinderGeometry(2.1, 2.1, 0.3, 8), base.clone().multiply(mat4(0, cy + 3.5, 0)), 0xe3dac5);
  c.add('flat', new THREE.SphereGeometry(2.0, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), base.clone().multiply(mat4(0, cy + 3.6, 0)), 0x7c868d);
  c.add('flat', new THREE.CylinderGeometry(0.08, 0.08, 2, 6), base.clone().multiply(mat4(0, cy + 6.5, 0)), 0xd8b25a);
  c.add('flat', new THREE.SphereGeometry(0.3, 8, 6), base.clone().multiply(mat4(0, cy + 7.4, 0)), 0xd8b25a);
  // Chimneys
  for (const x of [-7, 7]) {
    c.add('stone', box(1, 3, 1), base.clone().multiply(mat4(x, H + 4, 0)), 0xa88a74);
  }
  return [{ cx: 0, cz: 1.2, hw: W / 2 + 0.3, hd: D / 2 + 2.4, rot: 0 }];
}

export function addMarketStall(c: Collector, base: THREE.Matrix4, awningIdx: number, rng: RNG): Obb {
  const w = 3;
  const d = 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    c.add('wood', box(0.12, 2.4, 0.12), base.clone().multiply(mat4(sx * (w / 2 - 0.1), 1.2, sz * (d / 2 - 0.1))), 0x8b6b45);
  }
  c.add('wood', box(w, 0.1, d), base.clone().multiply(mat4(0, 0.95, 0)), 0xa98659);
  c.add('wood', box(w, 0.8, 0.08), base.clone().multiply(mat4(0, 0.5, d / 2 - 0.1)), 0x8b6b45);
  c.add(`awning${awningIdx}`, gableRoof(w + 0.2, d + 0.4, 0.55, 0.25), base.clone().multiply(mat4(0, 2.3, 0)));
  // goods
  const n = 6 + Math.floor(rng() * 6);
  const goods = [0xd6453d, 0xe8a63a, 0x6ea84b, 0xf2e3b5, 0x8c4a9b, 0xd97b3a, 0xf0d48a];
  for (let i = 0; i < n; i++) {
    const x = range(rng, -w / 2 + 0.3, w / 2 - 0.3);
    const z = range(rng, -d / 2 + 0.3, d / 2 - 0.3);
    const col = pick(rng, goods);
    if (rng() < 0.5) {
      c.add('flat', new THREE.SphereGeometry(range(rng, 0.12, 0.2), 7, 5), base.clone().multiply(mat4(x, 1.12, z)), col);
    } else {
      c.add('wood', box(range(rng, 0.35, 0.55), 0.3, range(rng, 0.3, 0.45)), base.clone().multiply(mat4(x, 1.15, z, rng())), 0xb8935f);
      c.add('flat', new THREE.SphereGeometry(0.14, 6, 4), base.clone().multiply(mat4(x, 1.36, z)), col);
    }
  }
  return { cx: 0, cz: 0, hw: w / 2 + 0.2, hd: d / 2 + 0.2, rot: 0 };
}

export function addLamp(c: Collector, base: THREE.Matrix4) {
  c.add('flat', new THREE.CylinderGeometry(0.2, 0.28, 0.5, 8), base.clone().multiply(mat4(0, 0.25, 0)), 0x2b2b2e);
  c.add('flat', new THREE.CylinderGeometry(0.07, 0.1, 3.6, 8), base.clone().multiply(mat4(0, 2.1, 0)), 0x2b2b2e);
  c.add('flat', box(0.5, 0.06, 0.5), base.clone().multiply(mat4(0, 3.9, 0)), 0x2b2b2e);
  c.add('lampglass', box(0.36, 0.5, 0.36), base.clone().multiply(mat4(0, 4.2, 0)));
  c.add('flat', pyramid(0.6, 0.35), base.clone().multiply(mat4(0, 4.45, 0)), 0x2b2b2e);
  for (const a of [0, Math.PI / 2]) {
    c.add('flat', box(0.5, 0.04, 0.04), base.clone().multiply(mat4(0, 4.2, 0, a)).multiply(mat4(0.25, 0, 0)), 0x2b2b2e);
  }
}

export function addFountain(c: Collector, base: THREE.Matrix4) {
  c.add('stone', new THREE.CylinderGeometry(3.4, 3.6, 0.9, 20), base.clone().multiply(mat4(0, 0.45, 0)), 0xbdb3a2);
  c.add('stone', new THREE.CylinderGeometry(3.6, 3.6, 0.2, 20), base.clone().multiply(mat4(0, 0.95, 0)), 0xcdc3b2);
  c.add('fountainWater', new THREE.CylinderGeometry(3.1, 3.1, 0.1, 20), base.clone().multiply(mat4(0, 0.78, 0)));
  c.add('stone', new THREE.CylinderGeometry(0.5, 0.7, 2.2, 10), base.clone().multiply(mat4(0, 1.9, 0)), 0xbdb3a2);
  c.add('stone', new THREE.CylinderGeometry(1.4, 1.0, 0.4, 14), base.clone().multiply(mat4(0, 3.0, 0)), 0xbdb3a2);
  c.add('fountainWater', new THREE.CylinderGeometry(1.25, 1.25, 0.1, 14), base.clone().multiply(mat4(0, 3.18, 0)));
  c.add('stone', new THREE.CylinderGeometry(0.2, 0.3, 1.0, 8), base.clone().multiply(mat4(0, 3.6, 0)), 0xbdb3a2);
  c.add('flat', new THREE.SphereGeometry(0.35, 10, 8), base.clone().multiply(mat4(0, 4.2, 0)), 0xd8b25a);
}

/**
 * Multi-arch stone bridge. Deck top sits at local y≈0 and runs along local +x.
 * `pierDepth` is how far the piers reach below the deck (down to the river bed).
 */
export function addBridge(c: Collector, base: THREE.Matrix4, length = 18, width = 7, pierDepth = 3.2) {
  const L = length;
  const depth = Math.max(1.6, pierDepth);
  c.add('stone', box(L, 0.5, width), base.clone().multiply(mat4(0, -0.27, 0)), 0xb3a896);
  // parapets + end pillars
  for (const s of [-1, 1]) {
    c.add('stone', box(L, 1.0, 0.45), base.clone().multiply(mat4(0, 0.5, s * (width / 2 - 0.22))), 0xbdb3a2);
    c.add('stone', box(L + 0.2, 0.15, 0.6), base.clone().multiply(mat4(0, 1.05, s * (width / 2 - 0.22))), 0xcdc3b2);
    for (const e of [-1, 1]) {
      c.add('stone', box(0.9, 1.5, 0.9), base.clone().multiply(mat4(e * L / 2, 0.75, s * (width / 2 - 0.22))), 0xb3a896);
    }
  }
  // abutments at both ends, reaching to the ground
  for (const e of [-1, 1]) {
    c.add('stone', box(1.2, depth, width + 0.4), base.clone().multiply(mat4(e * (L / 2 - 0.5), -depth / 2 - 0.4, 0)), 0xa89d8b);
  }
  // piers with diamond cut-waters, arches between them
  const nPiers = Math.max(0, Math.round(L / 11) - 1);
  const spacing = L / (nPiers + 1);
  const r = Math.max(1.2, spacing / 2 - 0.6);
  const archH = Math.min(depth - 0.4, r);
  for (let i = 1; i <= nPiers; i++) {
    const x = -L / 2 + spacing * i;
    c.add('stone', box(1.4, depth, width + 0.4), base.clone().multiply(mat4(x, -depth / 2 - 0.4, 0)), 0xa89d8b);
    for (const s of [-1, 1]) {
      c.add('stone', box(1.0, depth * 0.85, 1.0), base.clone().multiply(mat4(x, -depth * 0.425 - 0.4, s * ((width + 0.4) / 2 + 0.25), Math.PI / 4)), 0xa89d8b);
    }
  }
  for (let i = 0; i <= nPiers; i++) {
    const cx = -L / 2 + spacing * (i + 0.5);
    const arch = new THREE.CylinderGeometry(r, r, width + 0.3, 14, 1, true, -Math.PI / 2, Math.PI);
    const am = base.clone().multiply(mat4(cx, -0.5, 0, 0, 1, archH / r, 1)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    c.add('stoneDS', arch, am, 0x9a9080);
    const wallH = Math.min(depth, archH * 0.55 + 0.5);
    for (const s of [-1, 1]) {
      c.add('stone', box(spacing, wallH, 0.3), base.clone().multiply(mat4(cx, -wallH / 2 - 0.4, s * (width / 2 + 0.05))), 0xa89d8b);
    }
  }
}

export function addWell(c: Collector, base: THREE.Matrix4) {
  c.add('stone', new THREE.CylinderGeometry(1.1, 1.2, 1.0, 12), base.clone().multiply(mat4(0, 0.5, 0)), 0xb3a896);
  c.add('flat', new THREE.CylinderGeometry(0.85, 0.85, 0.1, 12), base.clone().multiply(mat4(0, 0.98, 0)), 0x1d2d3a);
  for (const s of [-1, 1]) c.add('wood', box(0.15, 2.4, 0.15), base.clone().multiply(mat4(s * 1.0, 1.2, 0)), 0x6b4a2e);
  c.add('wood', new THREE.CylinderGeometry(0.08, 0.08, 2.2, 8), base.clone().multiply(mat4(0, 2.0, 0)).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)), 0x6b4a2e);
  c.add('thatch', gableRoof(2.6, 2.2, 0.9, 0.2), base.clone().multiply(mat4(0, 2.3, 0)), 0x8d6a5a);
}

/** Generic cobble/dirt yard patch; optionally draped over a height field. */
export function addYard(c: Collector, base: THREE.Matrix4, w: number, d: number, material: string, heightAt?: (x: number, z: number) => number, lift = 0.1) {
  const geo = new THREE.PlaneGeometry(w, d, heightAt ? Math.max(1, Math.ceil(w / 4)) : 1, heightAt ? Math.max(1, Math.ceil(d / 4)) : 1);
  geo.rotateX(-Math.PI / 2);
  if (heightAt) {
    const p = geo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    const baseY = new THREE.Vector3().setFromMatrixPosition(base).y;
    for (let i = 0; i < p.count; i++) {
      v.set(p.getX(i), 0, p.getZ(i)).applyMatrix4(base);
      p.setY(i, heightAt(v.x, v.z) - baseY + lift);
    }
    geo.computeVertexNormals();
  }
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 5), uv.getY(i) * (d / 5));
  c.add(material, geo, base.clone().multiply(mat4(0, heightAt ? 0 : lift, 0)));
}
