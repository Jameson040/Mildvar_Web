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

export type HouseType = 'cottage' | 'townhouse' | 'longhouse' | 'hall' | 'workshop' | 'manor';

/** Human labels used by the door/interaction layer. */
export const HOUSE_TITLE: Record<HouseType, string> = {
  cottage: 'Cottage',
  townhouse: 'Townhouse',
  longhouse: 'Longhouse',
  hall: 'Guild Hall',
  workshop: 'Workshop',
  manor: 'Manor House',
};

/**
 * One house. `w`/`d` describe the ground-floor block; the yard, the door and
 * the collision box are all derived from it. Only `wing` projects at ground
 * level and it is accounted for separately (see `wingBox`).
 */
export interface HouseOpts {
  type: HouseType;
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
  /** upper-floor overhang, per storey (m) */
  jetty: number;
  /** projecting cross-gable wing on the street front (m) */
  /** which side of the facade the cross wing sits on (-1 or +1) */
  wing: number;
  wingX: number;
  /** projecting columned entrance porch */
  porch: boolean;
  /** arched shop front, wide glazing and a hanging sign */
  shopfront: boolean;
  /** rear corner stair turret */
  turret: boolean;
  /** lean-to outshot on the rear elevation */
  outshot: boolean;
}

interface TypeShape {
  w: [number, number];
  d: [number, number];
  floorH: number;
  pitch: number;
  maxFloors: number;
  floorTable: number[];
}

const SHAPES: Record<HouseType, TypeShape> = {
  cottage: { w: [5.6, 8.2], d: [5.0, 7.0], floorH: 3.0, pitch: 0.95, maxFloors: 2, floorTable: [1, 1, 2] },
  townhouse: { w: [4.8, 6.4], d: [6.2, 8.2], floorH: 2.95, pitch: 1.25, maxFloors: 3, floorTable: [2, 2, 3] },
  longhouse: { w: [9.6, 13.0], d: [6.2, 7.8], floorH: 2.85, pitch: 0.62, maxFloors: 1, floorTable: [1] },
  hall: { w: [10.0, 13.0], d: [8.0, 9.8], floorH: 3.4, pitch: 0.8, maxFloors: 2, floorTable: [2] },
  workshop: { w: [6.4, 8.6], d: [5.8, 7.2], floorH: 3.1, pitch: 0.95, maxFloors: 2, floorTable: [1, 2, 2] },
  manor: { w: [12.0, 15.5], d: [8.6, 10.6], floorH: 3.4, pitch: 0.8, maxFloors: 3, floorTable: [2, 2, 3] },
};

function chooseType(rng: RNG, maxF: number): HouseType {
  const r = rng();
  if (maxF >= 3) {
    if (r < 0.24) return 'cottage';
    if (r < 0.44) return 'townhouse';
    if (r < 0.58) return 'longhouse';
    if (r < 0.70) return 'workshop';
    if (r < 0.87) return 'hall';
    return 'manor';
  }
  if (r < 0.32) return 'cottage';
  if (r < 0.48) return 'townhouse';
  if (r < 0.66) return 'longhouse';
  if (r < 0.84) return 'workshop';
  if (r < 0.93) return 'hall';
  return 'manor';
}

export function randomHouseOpts(rng: RNG, scale = 1, theme?: ThemePalette, forced?: HouseType): HouseOpts {
  const pal: ThemePalette = theme ?? PALETTE;
  const st = pal.styles;
  const maxF = Math.max(1, pal.floorsMax);
  const type = forced ?? chooseType(rng, maxF);
  const sh = SHAPES[type];

  const roll = rng();
  let style: HouseOpts['style'] = roll < st.stone ? 'stone' : roll < st.stone + st.plaster ? 'plaster' : 'timber';
  // A timber townhouse is the archetype; a stone manor is not timber.
  if (type === 'townhouse' && style === 'stone' && rng() < 0.55) style = 'timber';
  if (type === 'manor' || type === 'hall') style = rng() < 0.72 ? 'stone' : 'plaster';
  if (type === 'workshop') style = rng() < 0.5 ? 'timber' : 'plaster';
  if (type === 'longhouse') style = rng() < 0.6 ? 'timber' : 'plaster';

  const floors = Math.max(1, Math.min(pick(rng, sh.floorTable), sh.maxFloors, maxF));
  const w = range(rng, sh.w[0], sh.w[1]) * scale;
  const d = range(rng, sh.d[0], sh.d[1]) * scale;

  const jetty = type === 'townhouse' && floors >= 2 ? range(rng, 0.24, 0.34) : 0;
  const wing = type === 'manor' ? range(rng, 1.8, 2.4) : 0;
  const wingX = wing > 0 ? (rng() < 0.5 ? -1 : 1) : 0;
  const porch = type === 'manor' && rng() < 0.85;
  const outshot = type === 'longhouse' && rng() < 0.7;

  return {
    type,
    w,
    d,
    floors,
    style,
    roofMat: pal.roofMat,
    roofColor: pick(rng, pal.roofs),
    wallColor: style === 'stone' ? pick(rng, pal.stones) : pick(rng, pal.plasters),
    roofType: type === 'hall' || type === 'manor' ? 'hip' : type === 'townhouse' ? 'gable' : rng() < 0.82 ? 'gable' : 'hip',
    // townhouses and manor wings show a gable to the street; everything else
    // runs its ridge parallel to the frontage.
    ridgeAlongFront: type === 'townhouse' ? false : rng() < 0.7,
    chimney: type === 'hall' || type === 'manor' || type === 'townhouse' ? true : rng() < 0.85,
    dormers: type === 'hall' ? true : type === 'manor' ? rng() < 0.8 : pal.roofMat === 'tiles' && rng() < 0.4,
    shutters: type === 'manor' ? rng() < 0.3 : rng() < 0.5,
    shutterColor: pick(rng, pal.shutters),
    ivy: rng() < (type === 'cottage' ? 0.42 : 0.22),
    jetty,
    wing,
    wingX,
    porch,
    shopfront: type === 'workshop',
    turret: (type === 'hall' && rng() < 0.55) || (type === 'manor' && rng() < 0.8),
    outshot,
  };
}

export function houseDoorX(w: number) {
  const nWin = Math.max(1, Math.floor((w - 1.2) / 2));
  const spacing = w / (nWin + 1);
  const doorIdx = Math.floor(nWin / 2);
  return nWin % 2 === 1 ? 0 : -w / 2 + spacing * (doorIdx + 1) - spacing / 2;
}

/**
 * The manor's cross wing is the only part of a house that projects at ground
 * level. Its box is derived here so the builder and the collision layer can
 * never disagree about where it is.
 */
export function wingBox(o: HouseOpts) {
  if (o.wing <= 0) return null;
  const w = Math.min(o.w * 0.36, 4.2);
  const x = (o.wingX < 0 ? -1 : 1) * (o.w / 2 - w / 2 - 0.5);
  return { x, w, d: o.wing };
}

/**
 * A house that projects into the street looks broken. When the gap to the
 * carriageway is tight, strip the projecting features rather than let the
 * cross wing straddle the paving.
 */
export function clampHouseFrontage(o: HouseOpts, gap: number) {
  if (o.wing > 0 && gap < o.wing + 1.0) {
    o.wing = 0;
    o.wingX = 0;
  }
  if (o.porch && gap < 2.8) o.porch = false;
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

/** One timber-framed storey on one elevation (sill, head, studs, braces). */
function addTimberBay(c: Collector, base: THREE.Matrix4, faceW: number, FH: number, y0: number, rotY: number, offset: number) {
  const m = base.clone().multiply(mat4(0, 0, 0, rotY)).multiply(mat4(0, 0, offset));
  const t = 0.15;
  const col = PALETTE.timber;
  c.add('wood', box(faceW + 0.06, t, 0.1), m.clone().multiply(mat4(0, y0 + 0.08, 0.05)), col);
  c.add('wood', box(faceW + 0.06, t, 0.1), m.clone().multiply(mat4(0, y0 + FH - 0.08, 0.05)), col);
  const n = Math.max(2, Math.round(faceW / 1.7));
  for (let i = 0; i <= n; i++) {
    const x = -faceW / 2 + (faceW / n) * i;
    c.add('wood', box(t, FH, 0.1), m.clone().multiply(mat4(x, y0 + FH / 2, 0.05)), col);
  }
  for (let i = 0; i < n; i += 2) {
    const x0 = -faceW / 2 + (faceW / n) * i;
    const x1 = x0 + faceW / n;
    const len = Math.hypot(x1 - x0, FH) * 0.9;
    const ang = Math.atan2(FH, x1 - x0) * (i % 4 === 0 ? 1 : -1);
    const mm = m.clone().multiply(mat4((x0 + x1) / 2, y0 + FH / 2, 0.04)).multiply(new THREE.Matrix4().makeRotationZ(ang));
    c.add('wood', box(len, t * 0.78, 0.08), mm, col);
  }
}

/**
 * A village house with a real architectural type: cottage, townhouse (jettied,
 * gable to the street), longhouse (low and long with a rear outshot), guild
 * hall (hipped, dormered, stair turret), workshop (arched shop front and sign)
 * or manor (cross wing, columned porch, turret).
 */
export function addHouse(c: Collector, base: THREE.Matrix4, o: HouseOpts, rng: RNG): Obb {
  const FH = SHAPES[o.type].floorH;
  const H = o.floors * FH;
  const wallKey = o.style === 'stone' ? 'stone' : 'plaster';
  const w = o.w;
  const d = o.d;
  const shut = o.shutters ? o.shutterColor : undefined;
  const doorX = houseDoorX(w);
  const jettyTotal = o.jetty * Math.max(0, o.floors - 1);
  const topW = w + jettyTotal * 2;
  const topD = d + jettyTotal * 2;
  const wing = wingBox(o);
  const wingW = wing ? wing.w : 0;

  // ---- plinth
  c.add('stone', box(w + 0.3, 0.5, d + 0.3), base.clone().multiply(mat4(0, 0.25, 0)), 0x9d9385);
  if (o.type === 'hall' || o.type === 'manor') {
    c.add('stone', box(w + 0.46, 0.22, d + 0.46), base.clone().multiply(mat4(0, 0.6, 0)), 0xa89c88);
  }

  // ---- storeys (jettied upper floors step outwards)
  for (let f = 0; f < o.floors; f++) {
    const over = o.jetty * f;
    const fw = w + over * 2;
    const fd = d + over * 2;
    const y0 = f * FH;
    c.add(wallKey, box(fw, FH, fd), base.clone().multiply(mat4(0, y0 + FH / 2, 0)), o.wallColor);
    if (over > 0) {
      c.add('wood', box(fw + 0.1, 0.22, fd + 0.1), base.clone().multiply(mat4(0, y0 + 0.06, 0)), 0x4a3524);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          c.add('wood', box(0.2, over + 0.5, 0.2), base.clone().multiply(mat4(sx * (fw / 2 - 0.3), y0 - 0.2, sz * (fd / 2 - 0.3))), 0x40301f);
        }
      }
    }
    if (o.style === 'timber') {
      const faces: [number, number, number][] = [
        [fw, 0, fd / 2],
        [fw, Math.PI, fd / 2],
        [fd, Math.PI / 2, fw / 2],
        [fd, -Math.PI / 2, fw / 2],
      ];
      for (const [faceW, rotY, offset] of faces) addTimberBay(c, base, faceW, FH, y0, rotY, offset);
    }
  }

  // ---- windows
  const tall = o.type === 'hall' || o.type === 'manor';
  const winW = tall ? 1.0 : o.type === 'townhouse' ? 0.78 : 0.9;
  const winH = tall ? 1.42 : o.type === 'townhouse' ? 1.28 : 1.15;
  const shopSide = o.shopfront ? (doorX <= 0 ? 1 : -1) : 0;
  for (let f = 0; f < o.floors; f++) {
    const over = o.jetty * f;
    const fw = w + over * 2;
    const fd = d + over * 2;
    const nWin = Math.max(1, Math.floor((fw - 1.2) / (o.type === 'townhouse' ? 1.7 : 2.0)));
    const spacing = fw / (nWin + 1);
    const y = f * FH + (f === 0 ? 1.75 : 1.85);
    let frontWindows = 0;
    for (let i = 0; i < nWin; i++) {
      const x = -fw / 2 + spacing * (i + 1);
      const nearDoor = Math.abs(x - doorX) < spacing * 0.62;
      const shopWin = o.shopfront && shopSide !== 0 && Math.sign(x) === shopSide && Math.abs(x) < fw * 0.34;
      const underWing = wing !== null && Math.abs(x - wing.x) < wingW / 2 + 0.6;
      if (!(f === 0 && (nearDoor || shopWin)) && !underWing) {
        addWindow(c, base, x, y, fd / 2, 0, winW, winH, shut);
        frontWindows++;
      }
      if (!(f === 0 && nearDoor) && !underWing && rng() < 0.7) addWindow(c, base, -x, y, -fd / 2, Math.PI, winW, winH, shut);
    }
    // A narrow frontage (townhouses) can lose every window to the doorway;
    // make sure each storey still gets glazing either side of the door.
    if (frontWindows === 0 && !(f === 0 && o.shopfront)) {
      const off = Math.min(fw / 2 - 0.9, Math.max(1.35, spacing * 0.95));
      for (const sideX of [-1, 1]) {
        const wx = Math.max(-fw / 2 + 0.78, Math.min(fw / 2 - 0.78, doorX + sideX * off));
        if (wing !== null && Math.abs(wx - wing.x) < wingW / 2 + 0.6) continue;
        addWindow(c, base, wx, y, fd / 2, 0, winW * 0.92, winH, shut);
      }
    }
    const nSide = Math.max(1, Math.floor((fd - 1.5) / 2.4));
    const sSp = fd / (nSide + 1);
    for (let i = 0; i < nSide; i++) {
      const z = -fd / 2 + sSp * (i + 1);
      if (rng() < 0.6) addWindow(c, base, fw / 2, y, z, Math.PI / 2, winW * 0.9, winH * 0.95, shut);
      if (rng() < 0.6) addWindow(c, base, -fw / 2, y, z, -Math.PI / 2, winW * 0.9, winH * 0.95, shut);
    }
  }

  // ---- entrance (type-specific)
  if (o.type === 'longhouse') {
    for (const s of [-1, 1]) {
      c.add('wood', box(0.44, 3.2, 0.44), base.clone().multiply(mat4(doorX + s * 1.55, 1.6, d / 2 + 0.14)), 0x4a3320);
      c.add('wood', box(0.58, 0.34, 0.58), base.clone().multiply(mat4(doorX + s * 1.55, 3.3, d / 2 + 0.14)), 0x4a3320);
    }
    addDoor(c, base, doorX, d / 2, 0, 1.7, 2.55);
  } else if (o.shopfront) {
    addDoor(c, base, doorX, d / 2, 0, 1.25, 2.45);
    // stone arch over the door
    c.add('stone', new THREE.TorusGeometry(0.78, 0.15, 6, 14, Math.PI), base.clone().multiply(mat4(doorX, 2.45, d / 2 + 0.14)), 0xc6bda9);
    // wide shop glazing
    const sw = Math.min(2.9, w * 0.4);
    const sx = shopSide * Math.min(w * 0.28, 2.4);
    const sm = base.clone().multiply(mat4(sx, 1.55, d / 2 + 0.05));
    c.add('flat', box(sw + 0.28, 1.5, 0.14), sm.clone().multiply(mat4(0, 0, 0.02)), 0x574434);
    c.add('glass', box(sw, 1.22, 0.1), sm.clone().multiply(mat4(0, 0, 0.08)));
    for (const dx of [-sw / 6, sw / 6]) c.add('wood', box(0.09, 1.22, 0.14), sm.clone().multiply(mat4(dx, 0, 0.09)), PALETTE.timber);
    c.add('wood', box(sw + 0.4, 0.12, 0.5), sm.clone().multiply(mat4(0, -0.68, 0.14)), PALETTE.timber);
    // hanging sign
    const signX = doorX - shopSide * 2.15;
    c.add('wood', box(0.12, 0.12, 1.15), base.clone().multiply(mat4(signX, 3.35, d / 2 + 0.55)), 0x40301f);
    c.add('wood', box(0.85, 0.72, 0.09), base.clone().multiply(mat4(signX, 2.85, d / 2 + 1.1)), 0x8a6a3c);
    c.add('flat', box(0.42, 0.38, 0.05), base.clone().multiply(mat4(signX, 2.85, d / 2 + 1.16)), o.shutterColor);
  } else if (o.porch) {
    addDoor(c, base, doorX, d / 2, 0, 1.45, 2.65);
    // step slab, two columns, lintel and a lean-to hood
    c.add('stone', box(4.1, 0.24, 2.5), base.clone().multiply(mat4(doorX, 0.12, d / 2 + 1.2)), 0xb0a692);
    for (const s of [-1, 1]) {
      c.add('stone', box(0.44, 3.0, 0.44), base.clone().multiply(mat4(doorX + s * 1.55, 1.5, d / 2 + 2.05)), 0xc6bda9);
      c.add('stone', box(0.62, 0.22, 0.62), base.clone().multiply(mat4(doorX + s * 1.55, 3.06, d / 2 + 2.05)), 0xd0c7b3);
    }
    c.add('stone', box(3.7, 0.3, 0.55), base.clone().multiply(mat4(doorX, 3.25, d / 2 + 2.05)), 0xc6bda9);
    c.add(o.roofMat, box(4.3, 0.18, 2.9), base.clone().multiply(mat4(doorX, 3.5, d / 2 + 0.95)).multiply(new THREE.Matrix4().makeRotationX(-0.2)), o.roofColor);
  } else {
    const dh = o.type === 'hall' ? 2.7 : 2.25;
    addDoor(c, base, doorX, d / 2, 0, o.type === 'hall' ? 1.35 : 1.15, dh);
    if (o.type === 'hall') {
      // arched surround and flanking buttresses
      c.add('stone', new THREE.TorusGeometry(0.85, 0.16, 6, 14, Math.PI), base.clone().multiply(mat4(doorX, dh, d / 2 + 0.14)), 0xc6bda9);
      for (const s of [-1, 1]) {
        c.add('stone', box(0.55, 2.6, 0.5), base.clone().multiply(mat4(s * (w / 2 - 0.35), 1.3, d / 2 + 0.1)), 0xb3a896);
      }
    }
  }

  // ---- projecting cross-gable wing (manor)
  if (wing) {
    const wm = base.clone().multiply(mat4(wing.x, 0, d / 2 + wing.d / 2));
    c.add(wallKey, box(wingW, H, o.wing + 0.06), wm.clone().multiply(mat4(0, H / 2, 0)), o.wallColor);
    c.add('stone', box(wingW + 0.2, 0.45, o.wing + 0.24), wm.clone().multiply(mat4(0, 0.22, 0)), 0x9d9385);
    const gm = wm.clone().multiply(mat4(0, H, 0, Math.PI / 2));
    const gh = wingW * 0.72;
    c.add(o.roofMat, gableRoof(o.wing + 0.55, wingW, gh), gm, o.roofColor);
    c.add(wallKey, gableEnds(o.wing + 0.55, wingW, gh), gm, o.wallColor);
    c.add('flat', box(0.28, 0.16, o.wing + 1.0), gm.clone().multiply(mat4(0, gh + 0.05, 0)), new THREE.Color(o.roofColor).multiplyScalar(0.7));
    for (let f = 0; f < o.floors; f++) {
      const y = f * FH + FH * 0.58;
      addWindow(c, wm, 0, y, o.wing / 2 + 0.07, 0, 0.95, 1.35, shut);
      if (rng() < 0.6) addWindow(c, wm, wingW / 2, y, wing.d * 0.55, Math.PI / 2, 0.8, 1.2, shut);
    }
  }

  // ---- rear stair turret
  if (o.turret) {
    const tx = w * 0.33;
    const tz = -d / 2 + 0.45;
    const th = H + 1.6;
    c.add('stone', new THREE.CylinderGeometry(0.98, 1.1, th, 10), base.clone().multiply(mat4(tx, th / 2, tz)), 0xaba596);
    c.add('stone', new THREE.CylinderGeometry(1.3, 1.3, 0.32, 10), base.clone().multiply(mat4(tx, th, tz)), 0xbcb5a6);
    c.add(o.roofMat, new THREE.ConeGeometry(1.22, 2.0, 10), base.clone().multiply(mat4(tx, th + 1.16, tz)), new THREE.Color(o.roofColor).multiplyScalar(0.85));
    for (let i = 0; i < 3; i++) {
      const a = -0.7 + i * 0.9;
      c.add('flat', box(0.3, 0.7, 0.14), base.clone().multiply(mat4(tx + Math.sin(a) * 1.0, H * 0.45 + i * 1.4, tz + Math.cos(a) * 1.0, a)), 0x2a2622);
    }
  }

  // ---- rear lean-to outshot (longhouse)
  if (o.outshot) {
    const ow = w * 0.56;
    const ox = -w * 0.16;
    const oz = -d / 2 - 0.95;
    const oh = 2.5;
    c.add(wallKey, box(ow, oh, 1.9), base.clone().multiply(mat4(ox, oh / 2, oz)), o.wallColor);
    c.add('stone', box(ow + 0.2, 0.4, 2.1), base.clone().multiply(mat4(ox, 0.2, oz)), 0x9d9385);
    if (o.style === 'timber') {
      for (let i = 0; i <= 4; i++) {
        const bx = ox - ow / 2 + (ow / 4) * i;
        c.add('wood', box(0.13, oh, 0.1), base.clone().multiply(mat4(bx, oh / 2, oz - 0.96)), PALETTE.timber);
      }
    }
    c.add(o.roofMat, box(ow + 0.8, 0.16, 2.5), base.clone().multiply(mat4(ox, oh + 0.22, oz - 0.25)).multiply(new THREE.Matrix4().makeRotationX(-0.24)), o.roofColor);
    addWindow(c, base, ox, 1.5, oz - 0.98, Math.PI, 0.7, 0.8);
  }

  // ---- roof
  const ridgeLen = o.ridgeAlongFront ? topW : topD;
  const span = o.ridgeAlongFront ? topD : topW;
  const roofH = (span / 2) * SHAPES[o.type].pitch * range(rng, 0.94, 1.06);
  const roofRot = o.ridgeAlongFront ? 0 : Math.PI / 2;
  const roofM = base.clone().multiply(mat4(0, H, 0, roofRot));
  const overhang = o.type === 'longhouse' ? 0.62 : o.type === 'manor' ? 0.55 : 0.45;
  if (o.roofType === 'gable') {
    c.add(o.roofMat, gableRoof(ridgeLen, span, roofH, overhang), roofM, o.roofColor);
    c.add(wallKey, gableEnds(ridgeLen, span, roofH), roofM, o.wallColor);
    if (o.style === 'timber') {
      for (const s of [-1, 1]) {
        const gm = roofM.clone().multiply(mat4((s * ridgeLen) / 2, 0, 0, s > 0 ? Math.PI / 2 : -Math.PI / 2));
        c.add('wood', box(span * 0.9, 0.14, 0.1), gm.clone().multiply(mat4(0, 0.6, 0.06)), PALETTE.timber);
        c.add('wood', box(0.14, roofH * 0.9, 0.1), gm.clone().multiply(mat4(0, roofH * 0.45, 0.06)), PALETTE.timber);
      }
    }
    c.add('flat', box(ridgeLen + 0.9, 0.18, 0.3), roofM.clone().multiply(mat4(0, roofH + 0.02, 0)), new THREE.Color(o.roofColor).multiplyScalar(0.7));
  } else {
    c.add(o.roofMat, hipRoof(ridgeLen, span, roofH, overhang), roofM, o.roofColor);
  }
  // longhouse smoke louvre on the ridge
  if (o.type === 'longhouse') {
    c.add('wood', box(0.7, 0.75, 0.7), roofM.clone().multiply(mat4(ridgeLen * 0.12, roofH + 0.3, 0)), 0x3a2a1c);
    c.add('flat', box(0.95, 0.12, 0.95), roofM.clone().multiply(mat4(ridgeLen * 0.12, roofH + 0.72, 0)), 0x2b2b2e);
  }

  // ---- dormers on the front slope
  if (o.dormers && o.ridgeAlongFront && roofH > 1.5) {
    const nD = topW > 8 ? 2 : 1;
    for (let i = 0; i < nD; i++) {
      const x = nD === 1 ? 0 : i === 0 ? -topW / 4 : topW / 4;
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

  // ---- chimney
  if (o.chimney) {
    const grand = o.type === 'hall' || o.type === 'manor';
    const cx = o.ridgeAlongFront ? (grand ? topW * 0.28 : range(rng, -topW / 3, topW / 3)) : 0;
    const cz = o.ridgeAlongFront ? range(rng, -0.4, 0.4) : range(rng, -topD / 3, topD / 3);
    const top = H + roofH + (grand ? 1.6 : 0.9);
    const cw = grand ? 1.25 : 0.9;
    const baseY = H - 1.5;
    c.add('stone', box(cw, top - baseY, cw), base.clone().multiply(mat4(cx, (top + baseY) / 2, cz)), 0xa88a74);
    c.add('stone', box(cw + 0.22, 0.25, cw + 0.22), base.clone().multiply(mat4(cx, top + 0.1, cz)), 0x8d7260);
    if (grand) {
      for (const s of [-1, 1]) c.add('stone', new THREE.CylinderGeometry(0.17, 0.17, 0.55, 8), base.clone().multiply(mat4(cx + s * 0.3, top + 0.5, cz)), 0x6f5344);
    } else {
      c.add('flat', new THREE.CylinderGeometry(0.16, 0.16, 0.4, 8), base.clone().multiply(mat4(cx, top + 0.4, cz)), 0x5a4a40);
    }
  }

  // ---- ivy (ground floor only, so it never floats past a jetty)
  if (o.ivy) {
    const n = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const x = range(rng, -w / 2 + 0.6, w / 2 - 0.6);
      const y = range(rng, 1.0, Math.max(1.2, Math.min(FH * 0.85, H * 0.7)));
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
