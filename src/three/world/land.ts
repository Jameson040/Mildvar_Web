import * as THREE from 'three';
import { fbm, lerp, smoothstep, clamp } from '../noise';
import { ParcelRegistry, farmParcels, localCoords, localPoint, sampleFootprint, type Footprint } from './placement';

export const WORLD_HALF = 8000;
export const RIVER_BANK = 11;

/* ------------------------------------------------------------------ *
 *  Base landscape (no rivers, no villages, no roads)                  *
 * ------------------------------------------------------------------ */
export function landscape(x: number, z: number): number {
  const r = Math.hypot(x, z);
  let h = (fbm(x * 0.00034 + 11, z * 0.00034 + 5, 4) - 0.4) * 145;
  h += (fbm(x * 0.0015 + 3, z * 0.0015 + 9, 3) - 0.5) * 40;
  h += (fbm(x * 0.0075 + 7, z * 0.0075 + 1, 2) - 0.5) * 7;
  const mtn = smoothstep(5600, 7400, r);
  if (mtn > 0) {
    const ridge = 1 - Math.abs(fbm(x * 0.00042 + 21, z * 0.00042 + 13, 3) * 2 - 1);
    h += Math.pow(ridge, 1.5) * 780 * mtn + mtn * 140;
  }
  return h;
}

/* ------------------------------------------------------------------ *
 *  World-scale landmarks. Their heights are READ from the landscape   *
 *  (never hard-coded), otherwise a fort can end up on a 40 m tower or *
 *  a lake at the bottom of a pit.                                     *
 * ------------------------------------------------------------------ */
function ringMean(x: number, z: number, r: number, n = 16) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    s += landscape(x + Math.cos(a) * r, z + Math.sin(a) * r);
  }
  return s / n;
}

export const LAKE = (() => {
  const x = 2300;
  const z = -2100;
  const r = 260;
  return { x, z, r, y: ringMean(x, z, r) - 1.0, islet: { x: 2280, z: -2085 } };
})();

export const FORT = (() => {
  const x = -1600;
  const z = -1700;
  return { x, z, w: 96, d: 84, y: (ringMean(x, z, 48, 12) + landscape(x, z)) / 2 };
})();

/* ------------------------------------------------------------------ *
 *  Rivers                                                             *
 * ------------------------------------------------------------------ */
interface RiverDef {
  name: string;
  width: number;
  pts: [number, number][];
}

export const RIVER_DEFS: RiverDef[] = [
  {
    name: 'The Wyle',
    width: 11,
    pts: [[-1700, -3600], [-900, -2500], [-400, -1600], [-100, -800], [70, -330], [175, -80], [250, 110], [600, 110], [1400, 60], [2400, 60], [3400, 90], [4300, 110], [4900, 115], [5300, 150], [5700, 320], [6300, 700]],
  },
  {
    name: 'Moorbeck',
    width: 9,
    pts: [[-6300, -1500], [-5200, -1050], [-4300, -620], [-3600, -200], [-3100, 260], [-2800, 900], [-2620, 1700], [-2350, 2700], [-1850, 3700], [-1250, 4500], [-600, 5050], [180, 5420]],
  },
  { name: 'Moortarn', width: 6, pts: [[-6700, -1300], [-5700, -760], [-5250, -330], [-5190, 80], [-5260, 500], [-5650, 1700]] },
  { name: 'Norbeck', width: 8, pts: [[520, -6600], [540, -5600], [430, -5150], [300, -4600], [225, -3800], [165, -2800], [150, -1700], [165, -750], [110, -345]] },
  { name: 'Sudbourne', width: 8, pts: [[350, 6700], [420, 5900], [300, 5420], [120, 5190], [-300, 5170], [-1250, 5000], [-2200, 4800]] },
];

const EMPTY: never[] = [];
export class SpatialGrid<T> {
  cell: number;
  map = new Map<number, T[]>();
  constructor(cell: number) {
    this.cell = cell;
  }
  private key(cx: number, cz: number) {
    return (cx + 8192) * 16384 + (cz + 8192);
  }
  insert(x: number, z: number, pad: number, item: T) {
    const c = this.cell;
    for (let cx = Math.floor((x - pad) / c); cx <= Math.floor((x + pad) / c); cx++) {
      for (let cz = Math.floor((z - pad) / c); cz <= Math.floor((z + pad) / c); cz++) {
        const k = this.key(cx, cz);
        let arr = this.map.get(k);
        if (!arr) this.map.set(k, (arr = []));
        arr.push(item);
      }
    }
  }
  query(x: number, z: number): T[] {
    return this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell))) ?? EMPTY;
  }

  queryArea(x: number, z: number, rx: number, rz: number): Set<T> {
    const result = new Set<T>();
    const c = this.cell;
    for (let ix = Math.floor((x - rx) / c); ix <= Math.floor((x + rx) / c); ix++) {
      for (let iz = Math.floor((z - rz) / c); iz <= Math.floor((z + rz) / c); iz++) {
        for (const item of this.map.get(this.key(ix, iz)) ?? EMPTY) result.add(item);
      }
    }
    return result;
  }
}

export interface RiverSeg {
  ax: number; az: number; ay: number;
  bx: number; bz: number; by: number;
  half: number;
}

export interface RiverHit {
  d: number;
  y: number;
  half: number;
}

class RiverNetwork {
  grid = new SpatialGrid<RiverSeg>(64);
  chains: THREE.Vector3[][] = [];
  curves: THREE.CatmullRomCurve3[] = [];
  constructor() {
    for (const def of RIVER_DEFS) {
      const curve = new THREE.CatmullRomCurve3(def.pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal', 0.5);
      const n = Math.ceil(curve.getLength() / 14);
      const raw: { x: number; z: number; y: number }[] = [];
      for (let i = 0; i <= n; i++) {
        const p = curve.getPointAt(i / n);
        raw.push({ x: p.x, z: p.z, y: landscape(p.x, p.z) });
      }
      for (let pass = 0; pass < 4; pass++) {
        const src = raw.map((r) => r.y);
        for (let i = 1; i < raw.length - 1; i++) raw[i].y = (src[i - 1] + src[i] * 2 + src[i + 1]) / 4;
      }
      raw[0].y += 5;
      for (let i = 1; i < raw.length; i++) raw[i].y = Math.min(raw[i].y, raw[i - 1].y - 0.02);
      const chain = raw.map((r) => new THREE.Vector3(r.x, r.y - 0.45, r.z));
      this.chains.push(chain);
      this.curves.push(new THREE.CatmullRomCurve3(chain, false, 'centripetal', 0.5));
      for (let i = 0; i < chain.length - 1; i++) {
        const a = chain[i];
        const b = chain[i + 1];
        const s: RiverSeg = { ax: a.x, az: a.z, ay: a.y, bx: b.x, bz: b.z, by: b.y, half: def.width / 2 };
        this.grid.insert((a.x + b.x) / 2, (a.z + b.z) / 2, Math.hypot(b.x - a.x, b.z - a.z) / 2 + s.half + 60, s);
      }
    }
  }
  query(x: number, z: number): RiverHit {
    let best = 1e9;
    let by = 0;
    let bh = 5;
    const list = this.grid.query(x, z);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = s.ax + dx * t - x;
      const pz = s.az + dz * t - z;
      const d = Math.sqrt(px * px + pz * pz);
      if (d < best) {
        best = d;
        by = s.ay + (s.by - s.ay) * t;
        bh = s.half;
      }
    }
    return { d: best, y: by, half: bh };
  }
}

export const rivers = new RiverNetwork();
export const riverChains = rivers.chains;

/** Rivers only (used by the terrain carve and ground colouring). */
export function riverQuery(x: number, z: number): RiverHit {
  return rivers.query(x, z);
}

/**
 * Any water body. Same contract for rivers and the lake:
 *   d    = distance to the water centre-line (lake: distance to its shore, 0 inside)
 *   half = half-width of the channel (lake: 0, so `d < half + m` means "within m of water")
 *   y    = water surface height
 */
export function waterQuery(x: number, z: number): RiverHit {
  const rq = rivers.query(x, z);
  const dl = Math.hypot(x - LAKE.x, z - LAKE.z);
  if (dl < LAKE.r + 80) {
    const lake: RiverHit = { d: Math.max(0, dl - LAKE.r), y: LAKE.y, half: 0 };
    return lake.d < rq.d - rq.half ? lake : rq;
  }
  return rq;
}
export function waterSurfaceY(x: number, z: number) {
  return waterQuery(x, z).y;
}
export function waterDist(x: number, z: number) {
  return waterQuery(x, z).d;
}
export function riverHalfWidth(x: number, z: number) {
  return waterQuery(x, z).half;
}

/** Point + normal on a river centre-line (ducks, boats, bank planting). */
export function getRiverPoint(chain: number, t: number) {
  const curve = rivers.curves[chain];
  if (!curve) return null;
  const tt = clamp(t, 0, 1);
  const p = curve.getPointAt(tt);
  const tan = curve.getTangentAt(tt);
  const l = Math.hypot(tan.x, tan.z) || 1;
  return { x: p.x, y: p.y, z: p.z, nx: -tan.z / l, nz: tan.x / l };
}

export function riverLength(chain: number) {
  return rivers.curves[chain]?.getLength() ?? 1;
}

export interface RiverPoint {
  x: number; z: number; y: number;
  tx: number; tz: number; nx: number; nz: number;
  half: number; d: number; chain: number; t: number;
}

export function nearestRiverPoint(x: number, z: number, maxDist = 600): RiverPoint | null {
  let best: RiverPoint | null = null;
  let bd = maxDist;
  for (let ci = 0; ci < rivers.chains.length; ci++) {
    const ch = rivers.chains[ci];
    for (let i = 0; i < ch.length; i++) {
      const p = ch[i];
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) {
        bd = d;
        const a = ch[Math.max(0, i - 1)];
        const b = ch[Math.min(ch.length - 1, i + 1)];
        const tx = b.x - a.x;
        const tz = b.z - a.z;
        const l = Math.hypot(tx, tz) || 1;
        // chains are arc-length sampled, so the index is a valid curve parameter
        best = { x: p.x, z: p.z, y: p.y, tx: tx / l, tz: tz / l, nx: -tz / l, nz: tx / l, half: RIVER_DEFS[ci].width / 2, d, chain: ci, t: i / (ch.length - 1) };
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 *  Settlements                                                        *
 * ------------------------------------------------------------------ */
export type RoofKind = 'tiles' | 'slate' | 'thatch';
export type LandmarkKind = 'cathedral' | 'longhouse' | 'keep' | 'mill' | 'harbor';

export interface Theme {
  roofMat: RoofKind;
  roofs: number[];
  plasters: number[];
  stones: number[];
  shutters: number[];
  styles: { stone: number; plaster: number; timber: number };
  floorsMax: number;
  scale: number;
  treeMix: number;
  foliage: number[];
  hedge: number[];
  accent: number;
}

export interface VillageDef {
  id: string;
  name: string;
  title: string;
  blurb: string;
  x: number;
  z: number;
  r: number;
  groundY: number;
  theme: Theme;
  landmark: LandmarkKind;
  farms: number;
  emoji: string;
  /** directions (radians) in which main roads leave the square */
  approaches: number[];
}

export const THEMES: Record<string, Theme> = {
  mildvar: {
    roofMat: 'tiles',
    roofs: [0xb5583c, 0xc26a48, 0xa84e36, 0xb86f50, 0xc47a55, 0x9c5a44],
    plasters: [0xf3e7cf, 0xf5ecd9, 0xe8d8b6, 0xf1dfc0, 0xeadbc8, 0xf6efe2],
    stones: [0xd8c9ac, 0xcbbba0, 0xe0d2b8],
    shutters: [0x3d6b4f, 0x4a6a8a, 0x8a4b3b, 0x5c4a3a],
    styles: { stone: 0.34, plaster: 0.44, timber: 0.22 },
    floorsMax: 3,
    scale: 1,
    treeMix: 0.12,
    foliage: [0x5c9a36, 0x6aa63c, 0xd98b2b, 0x4f8a2e],
    hedge: [0x4a8a35, 0x3f7a2e, 0x55943d],
    accent: 0xd9a632,
  },
  norvik: {
    roofMat: 'slate',
    roofs: [0x46505e, 0x3c4653, 0x525b66, 0x36404c],
    plasters: [0xd9d3c4, 0xcfc6b4, 0xe3dccd],
    stones: [0x9a978f, 0x8b8880, 0xa6a29a],
    shutters: [0x2f4858, 0x4a3b2f, 0x5d3a3a],
    styles: { stone: 0.42, plaster: 0.16, timber: 0.42 },
    floorsMax: 2,
    scale: 1.08,
    treeMix: 0.85,
    foliage: [0x2f5f2a, 0x356b30, 0x2a5527, 0x3d7336],
    hedge: [0x35643a, 0x2e5a34],
    accent: 0x6f9ec4,
  },
  eastreach: {
    roofMat: 'thatch',
    roofs: [0xb08b46, 0xa37f3e, 0xc09a52, 0x8f7038],
    plasters: [0xf7f2e4, 0xefe8d5, 0xe6dcc6, 0xfbf6ea],
    stones: [0xc4b49c, 0xb6a68e, 0xd2c3ab],
    shutters: [0x2f7d8a, 0x3b6b4f, 0x8a6a3b, 0x4a5a7a],
    styles: { stone: 0.24, plaster: 0.52, timber: 0.24 },
    floorsMax: 2,
    scale: 0.94,
    treeMix: 0.08,
    foliage: [0x6fae3f, 0x7dbb4a, 0x5c9a36, 0x86c257],
    hedge: [0x55943d, 0x4a8a35, 0x63a347],
    accent: 0x3f9ec4,
  },
  sudholm: {
    roofMat: 'thatch',
    roofs: [0xc09a52, 0xb08b46, 0xcaa75e, 0x9d7c3c],
    plasters: [0xead9b0, 0xf0e2c0, 0xdfc99a, 0xf5ead0],
    stones: [0xd0bd97, 0xc2ae88, 0xdccba8],
    shutters: [0x8a6a3b, 0x5c7a3a, 0x9c4a3a, 0x6b5230],
    styles: { stone: 0.3, plaster: 0.5, timber: 0.2 },
    floorsMax: 2,
    scale: 0.96,
    treeMix: 0.05,
    foliage: [0x86b84a, 0x9cc757, 0x74ad3f, 0xd9a63a],
    hedge: [0x63a347, 0x578f3c],
    accent: 0xe0b23a,
  },
  westmoor: {
    roofMat: 'slate',
    roofs: [0x50565c, 0x5d636a, 0x454b52, 0x6a7076],
    plasters: [0xcfcabb, 0xc2bcac, 0xdad5c7],
    stones: [0x8f8d8a, 0x7f7d7a, 0x9d9b97],
    shutters: [0x3a4a3f, 0x4a4a5a, 0x5a3a3a],
    styles: { stone: 0.66, plaster: 0.2, timber: 0.14 },
    floorsMax: 2,
    scale: 0.92,
    treeMix: 0.45,
    foliage: [0x4a6b3a, 0x557a42, 0x6b7d3a, 0x7a6b3a],
    hedge: [0x4f6b3a, 0x5d6b4a],
    accent: 0x9c6bb0,
  },
};

export interface SettlementSpec {
  id: string;
  name: string;
  title: string;
  blurb: string;
  x: number;
  z: number;
  r: number;
  landmark: LandmarkKind;
  farms: number;
  emoji: string;
  type?: 'village' | 'garrison' | 'lake' | 'forest' | 'plains' | 'watchtower';
}

export const SETTLEMENT_SPECS: SettlementSpec[] = [
  { id: 'mildvar', name: 'Mildvar', title: 'Market Town of the Wyle', blurb: 'Tiered roofs crowd a busy market square beneath the bells of St. Alder.', x: 0, z: 0, r: 118, landmark: 'cathedral', farms: 6, emoji: '🏰', type: 'village' },
  { id: 'norvik', name: 'Norvik', title: 'Pinehold of the North', blurb: 'Smoke-heavy longhouse halls beneath the fir slopes of the Norbeck.', x: 0, z: -5000, r: 80, landmark: 'longhouse', farms: 4, emoji: '🌲', type: 'village' },
  { id: 'eastreach', name: 'Eastreach', title: 'River Port on the Wyle', blurb: 'Thatched cottages lean over the water where barges unload at the staithe.', x: 5000, z: 0, r: 74, landmark: 'harbor', farms: 4, emoji: '⚓', type: 'village' },
  { id: 'sudholm', name: 'Sudholm', title: 'Granary of the South', blurb: 'Golden barley, creaking windmills and wide hedge-lined fields.', x: 0, z: 5000, r: 88, landmark: 'mill', farms: 8, emoji: '🌾', type: 'village' },
  { id: 'westmoor', name: 'Westmoor', title: 'Garrison of the Moor', blurb: 'Grey granite keeps watch over heather, standing stones and fog.', x: -5000, z: 0, r: 70, landmark: 'keep', farms: 3, emoji: '⛰️', type: 'village' },
];

export const WILDERNESS_SPECS: SettlementSpec[] = [
  { id: 'fort_ironspire', name: 'Fort Ironspire', title: 'Northern Defense Garrison', blurb: 'Fortified stone & timber garrison housing 100 soldiers, watchtowers, and training yards.', x: -1600, z: -1700, r: 60, landmark: 'keep', farms: 0, emoji: '⚔️', type: 'garrison' },
  { id: 'lake_eldermere', name: 'Lake Eldermere', title: 'Silvermere Fishing Waters', blurb: 'A scenic deep freshwater lake with fishing piers, boats, and a sacred moon islet.', x: 2300, z: -2100, r: 180, landmark: 'harbor', farms: 0, emoji: '⛵', type: 'lake' },
  { id: 'whispering_weald', name: 'Whispering Weald', title: 'Ancient Titan Forest', blurb: 'Towering ancient oaks, mossy megaliths, and a woodcutter cabin hidden in the deep canopy.', x: -2400, z: -2500, r: 350, landmark: 'longhouse', farms: 0, emoji: '🌳', type: 'forest' },
  { id: 'golden_mead', name: 'The Golden Mead', title: 'Sunvale Steppe & Pastures', blurb: 'Vast rolling wildflower grasslands with livestock folds and shepherd hills.', x: 2100, z: 2400, r: 280, landmark: 'mill', farms: 0, emoji: '🐑', type: 'plains' },
  { id: 'norbeck_watch', name: 'Norbeck Watch', title: 'Highway Sentinel', blurb: 'North road stone watchtower with signal brazier overlooking the pass to Norvik.', x: 70, z: -2700, r: 30, landmark: 'keep', farms: 0, emoji: '🛡️', type: 'watchtower' },
  { id: 'wyle_gate', name: 'Wyle Gate Outpost', title: 'Eastern Border Watch', blurb: 'East road highway watchtower guarding the merchant river route to Eastreach.', x: 2700, z: 50, r: 30, landmark: 'keep', farms: 0, emoji: '🛡️', type: 'watchtower' },
];

export const ALL_LOCATIONS: SettlementSpec[] = [...SETTLEMENT_SPECS, ...WILDERNESS_SPECS];

export const villages: VillageDef[] = SETTLEMENT_SPECS.map((s) => ({
  ...s,
  theme: THEMES[s.id],
  groundY: landscape(s.x, s.z),
  approaches: [],
}));

// keep every settlement plateau safely above nearby river water
for (const v of villages) {
  let maxW = -Infinity;
  for (const ch of rivers.chains) {
    for (const p of ch) if (Math.hypot(p.x - v.x, p.z - v.z) < v.r + 250) maxW = Math.max(maxW, p.y);
  }
  if (maxW > -Infinity) {
    // Settlements beside water sit 2.8–9 m above it. Without the upper bound a
    // village on a hill forced the river into a sheer-walled canyon.
    v.groundY = clamp(v.groundY, maxW + 2.8, maxW + (v.landmark === 'harbor' ? 6.5 : 9));
  }
}

export function plazaRadius(v: VillageDef) {
  return Math.max(16, Math.min(30, v.r * 0.34));
}

/* ------------------------------------------------------------------ *
 *  Roads (declared before terrainHeight so the terrain can conform)   *
 * ------------------------------------------------------------------ */
export type RoadKind = 'cobble' | 'dirt' | 'track';

export interface RoadSample {
  x: number;
  z: number;
  y: number;
  s: number;
}

export interface BridgeSpan {
  x: number;
  z: number;
  dx: number;
  dz: number;
  halfLen: number;
  halfW: number;
  deckY: number;
  pierBottom: number;
}

export interface Road {
  kind: RoadKind;
  width: number;
  samples: RoadSample[];
  bridges: BridgeSpan[];
  from: string;
  to: string;
  length: number;
  village?: string;
}

export const roads: Road[] = [];
export const bridges: BridgeSpan[] = [];
/** Walkable decks that are not bridges (docks, piers). */
export const platforms: BridgeSpan[] = [];

const roadGrid = new SpatialGrid<{ road: Road; idx: number }>(90);

export function roadQuery(x: number, z: number): { d: number; y: number; road: Road | null } {
  let best = 1e9;
  let by = 0;
  let bro: Road | null = null;
  const list = roadGrid.query(x, z);
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const s = e.road.samples;
    const a = s[e.idx];
    const b = s[e.idx + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + dx * t - x;
    const pz = a.z + dz * t - z;
    const d = Math.sqrt(px * px + pz * pz) - e.road.width / 2;
    if (d < best) {
      best = d;
      by = a.y + (b.y - a.y) * t;
      bro = e.road;
    }
  }
  return { d: best, y: by, road: bro };
}

/** Exact road/plot intersection: a narrow lane can pass between sample points. */
export function roadFootprintClear(bounds: Footprint, clearance: number) {
  const c = Math.cos(bounds.rot);
  const s = Math.sin(bounds.rot);
  const reachX = Math.abs(c) * bounds.hw + Math.abs(s) * bounds.hd + clearance + 5;
  const reachZ = Math.abs(s) * bounds.hw + Math.abs(c) * bounds.hd + clearance + 5;
  for (const entry of roadGrid.queryArea(bounds.cx, bounds.cz, reachX, reachZ)) {
    const a = entry.road.samples[entry.idx];
    const b = entry.road.samples[entry.idx + 1];
    const p = localCoords(bounds, a.x, a.z);
    const q = localCoords(bounds, b.x, b.z);
    const pad = entry.road.width / 2 + clearance;
    const limitX = bounds.hw + pad;
    const limitZ = bounds.hd + pad;
    let lo = 0;
    let hi = 1;
    for (const [start, delta, extent] of [[p.x, q.x - p.x, limitX], [p.z, q.z - p.z, limitZ]]) {
      if (Math.abs(delta) < 1e-7) {
        if (Math.abs(start) > extent) {
          lo = 2;
          break;
        }
      } else {
        const t0 = (-extent - start) / delta;
        const t1 = (extent - start) / delta;
        lo = Math.max(lo, Math.min(t0, t1));
        hi = Math.min(hi, Math.max(t0, t1));
      }
    }
    if (lo <= hi) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 *  Terrain height, in dependency order:                               *
 *    L1 landscape  →  settlement plateaus  →  river channel           *
 *    …then, once every route has been surveyed (L2), the ground       *
 *    is pulled up to meet the roads (see terrainHeight).              *
 * ------------------------------------------------------------------ */
/**
 * The streamed terrain mesh has a ~7.5 m vertex grid. Any feature narrower than
 * one cell (a 6 m road, an 11 m river) gets cut by the triangles interpolated
 * between grid vertices, so every carve below is deliberately wider than a cell:
 * the land is held FLAT for ≥ one cell on each side before it blends back.
 */
export const RIVER_SHELF = 12;   // flat floodplain beside the channel (m)
export const RIVER_VALLEY = 48;  // valley slope width beyond the shelf (m)

export function baseHeight(x: number, z: number): number {
  let h = landscape(x, z);

  // 1. Village plateaus
  for (let i = 0; i < villages.length; i++) {
    const v = villages[i];
    const d = Math.hypot(x - v.x, z - v.z);
    const edge = v.r * 1.05;
    if (d < edge + 140) h = lerp(v.groundY, h, smoothstep(edge, edge + 140, d));
  }

  // 2. Fort Ironspire parade plateau — level read from the local landscape
  const dFort = Math.hypot(x - FORT.x, z - FORT.z);
  if (dFort < 130) h = lerp(FORT.y, h, smoothstep(62, 130, dFort));

  // 3. Lake Eldermere basin — water level read from the rim of the landscape
  const dLake = Math.hypot(x - LAKE.x, z - LAKE.z);
  if (dLake < LAKE.r + 90) {
    const u = Math.min(1, dLake / LAKE.r);
    let bed = LAKE.y - 3.6 * (1 - u * u);
    const dIslet = Math.hypot(x - LAKE.islet.x, z - LAKE.islet.z);
    if (dIslet < 26) bed = lerp(LAKE.y + 0.6, bed, smoothstep(15, 26, dIslet));
    if (dLake < LAKE.r) {
      h = bed;
    } else {
      const shelf = LAKE.y + 0.5 * smoothstep(LAKE.r, LAKE.r + 3, dLake) + (dLake - LAKE.r) * 0.02;
      h = lerp(shelf, Math.max(h, shelf), smoothstep(LAKE.r + 14, LAKE.r + 90, dLake));
    }
  }

  // 4. River: channel → flat shelf → valley slope. The shelf is wider than a
  //    terrain cell so the water surface is never buried under a bank triangle.
  const q = rivers.query(x, z);
  const half = q.half;
  const valleyEdge = half + RIVER_SHELF + RIVER_VALLEY;
  if (q.d < valleyEdge) {
    if (q.d < half) {
      const u = q.d / half;
      h = Math.min(h, q.y - 1.9 * (1 - u * u));
    } else {
      const shelf = q.y + 0.5 * smoothstep(half, half + 3, q.d) + (q.d - half) * 0.02;
      const bank = Math.max(h, shelf);
      h = lerp(shelf, bank, smoothstep(half + RIVER_SHELF, valleyEdge, q.d));
    }
  }
  return h;
}

export function terrainHeight(x: number, z: number): number {
  let h = baseHeight(x, z);
  if (roadGrid.map.size > 0) {
    const rq = roadQuery(x, z);
    if (rq.road && rq.d < 24) {
      // hold the ground level for a full terrain cell (9 m) either side of the
      // paving, then grade out over 15 m — a road bed, not a knife cut
      const q = rivers.query(x, z);
      const wRoad = 1 - smoothstep(9, 24, rq.d);
      const wRiver = 1 - smoothstep(q.half + 8, q.half + 20, q.d);
      h = lerp(h, rq.y - 0.12, wRoad * (1 - wRiver));
    }
  }
  return h;
}

/* ------------------------------------------------------------------ *
 *  Road sampling                                                      *
 * ------------------------------------------------------------------ */
function sampleRoad(pts: THREE.Vector2[], kind: RoadKind, width: number, from: string, to: string, village?: string): Road {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x, 0, p.y)), false, 'centripetal', 0.5);
  const len = curve.getLength();
  const n = Math.max(6, Math.ceil(len / 6));
  const xs = new Float64Array(n + 1);
  const zs = new Float64Array(n + 1);
  const base = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const p = curve.getPointAt(i / n);
    xs[i] = p.x;
    zs[i] = p.z;
    base[i] = baseHeight(p.x, p.z); // roads follow the land, never themselves
  }
  const W = kind === 'cobble' ? 2 : 8;
  const y = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    let s = 0;
    for (let k = -W; k <= W; k++) s += base[clamp(i + k, 0, n)];
    y[i] = s / (2 * W + 1);
  }
  // river crossings → bridge decks
  const hits: RiverHit[] = [];
  for (let i = 0; i <= n; i++) hits.push(rivers.query(xs[i], zs[i]));
  const inZone = (i: number) => hits[i].d < hits[i].half + 16;
  const spans: BridgeSpan[] = [];
  let i = 0;
  while (i <= n) {
    if (!inZone(i)) {
      i++;
      continue;
    }
    let j = i;
    let maxW = -1e9;
    let minW = 1e9;
    let crosses = false;
    while (j <= n && inZone(j)) {
      maxW = Math.max(maxW, hits[j].y);
      minW = Math.min(minW, hits[j].y);
      if (hits[j].d < hits[j].half + 1.5) crosses = true;
      j++;
    }
    if (crosses) {
      const iA = Math.max(0, i - 1);
      const iB = Math.min(n, j);
      const deckY = Math.max(maxW + 1.45, (y[iA] + y[iB]) / 2);
      const dx = xs[iB] - xs[iA];
      const dz = zs[iB] - zs[iA];
      const dl = Math.hypot(dx, dz) || 1;
      const span: BridgeSpan = {
        x: (xs[iA] + xs[iB]) / 2,
        z: (zs[iA] + zs[iB]) / 2,
        dx: dx / dl,
        dz: dz / dl,
        halfLen: dl / 2 + 1.5,
        halfW: width / 2 + 1.0,
        deckY,
        pierBottom: minW - 2.6,
      };
      spans.push(span);
      bridges.push(span);
      for (let k = iA; k <= iB; k++) y[k] = deckY;
      for (let k = 1; k <= 7; k++) {
        const t = k / 8;
        if (iA - k >= 0) y[iA - k] = lerp(deckY, y[iA - k], t);
        if (iB + k <= n) y[iB + k] = lerp(deckY, y[iB + k], t);
      }
    }
    i = j;
  }
  const samples: RoadSample[] = [];
  let acc = 0;
  for (let k = 0; k <= n; k++) {
    samples.push({ x: xs[k], z: zs[k], y: y[k], s: acc });
    if (k < n) acc += Math.hypot(xs[k + 1] - xs[k], zs[k + 1] - zs[k]);
  }
  const road: Road = { kind, width, samples, bridges: spans, from, to, length: acc, village };
  for (let k = 0; k < samples.length - 1; k++) {
    const a = samples[k];
    const b = samples[k + 1];
    roadGrid.insert((a.x + b.x) / 2, (a.z + b.z) / 2, Math.hypot(b.x - a.x, b.z - a.z) / 2 + 26, { road, idx: k });
  }
  roads.push(road);
  return road;
}

/** Register a short settlement lane in the shared road system. */
export function addVillageRoad(pts: THREE.Vector2[], kind: RoadKind, width: number, village: string): Road {
  return sampleRoad(pts, kind, width, village, village, village);
}

/* ------------------------------------------------------------------ *
 *  A* path-finding over a coarse grid                                 *
 * ------------------------------------------------------------------ */
const GRID = 110;
const GN = Math.ceil((WORLD_HALF * 2) / GRID) + 1;
let pathPenalty: Float32Array | null = null;

function cellCenter(i: number) {
  const cx = i % GN;
  const cz = Math.floor(i / GN);
  return { x: (cx - (GN - 1) / 2) * GRID, z: (cz - (GN - 1) / 2) * GRID };
}
function cellIndex(x: number, z: number) {
  const cx = clamp(Math.round(x / GRID + (GN - 1) / 2), 0, GN - 1);
  const cz = clamp(Math.round(z / GRID + (GN - 1) / 2), 0, GN - 1);
  return cz * GN + cx;
}

function computePenalty() {
  const pen = new Float32Array(GN * GN);
  for (let i = 0; i < GN * GN; i++) {
    const { x, z } = cellCenter(i);
    const d = waterDist(x, z);
    let p = 0;
    if (d < RIVER_BANK * 2.4) p += 6 + 120 * (1 - smoothstep(RIVER_BANK * 0.9, RIVER_BANK * 2.4, d));
    const h0 = landscape(x, z);
    const slope = Math.hypot(landscape(x + GRID, z) - h0, landscape(x, z + GRID) - h0) / GRID;
    p += Math.pow(slope * 8, 2) * 7 + Math.max(0, slope - 0.2) * 1200;
    for (const v of villages) {
      const dd = Math.hypot(x - v.x, z - v.z);
      if (dd < v.r * 1.4) p += 30 * (1 - dd / (v.r * 1.4));
    }
    pen[i] = p;
  }
  pathPenalty = pen;
}

function findPath(a: THREE.Vector2, b: THREE.Vector2): THREE.Vector2[] {
  const pen = pathPenalty!;
  const start = cellIndex(a.x, a.y);
  const goal = cellIndex(b.x, b.y);
  const N = GN * GN;
  const g = new Float32Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const f = new Float32Array(N);
  const goalC = cellCenter(goal);
  const heap: number[] = [start];
  g[start] = 0;
  f[start] = Math.hypot(cellCenter(start).x - goalC.x, cellCenter(start).z - goalC.z);
  const push = (i: number) => {
    heap.push(i);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (f[heap[p]] <= f[heap[c]]) break;
      const t = heap[p];
      heap[p] = heap[c];
      heap[c] = t;
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let m = p;
        if (l < heap.length && f[heap[l]] < f[heap[m]]) m = l;
        if (r < heap.length && f[heap[r]] < f[heap[m]]) m = r;
        if (m === p) break;
        const t = heap[p];
        heap[p] = heap[m];
        heap[m] = t;
        p = m;
      }
    }
    return top;
  };
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let iter = 0;
  while (heap.length && iter++ < 200000) {
    const cur = pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const c = cellCenter(cur);
    for (const [dx, dz] of dirs) {
      const nx = c.x + dx * GRID;
      const nz = c.z + dz * GRID;
      if (Math.abs(nx) > WORLD_HALF - GRID || Math.abs(nz) > WORLD_HALF - GRID) continue;
      const ni = cellIndex(nx, nz);
      if (closed[ni]) continue;
      const ng = g[cur] + Math.hypot(dx, dz) * GRID * (1 + (pen[cur] + pen[ni]) * 0.011);
      if (ng < g[ni]) {
        g[ni] = ng;
        from[ni] = cur;
        f[ni] = ng + Math.hypot(nx - goalC.x, nz - goalC.z) * 1.02;
        push(ni);
      }
    }
  }
  const out: THREE.Vector2[] = [];
  let cur = goal;
  let guard = 0;
  while (cur !== -1 && guard++ < 20000) {
    const c = cellCenter(cur);
    out.push(new THREE.Vector2(c.x, c.z));
    if (cur === start) break;
    cur = from[cur];
  }
  out.reverse();
  return out;
}

function chaikin(pts: THREE.Vector2[], iterations = 2) {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const next: THREE.Vector2[] = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i];
      const b = cur[i + 1];
      next.push(new THREE.Vector2(lerp(a.x, b.x, 0.25), lerp(a.y, b.y, 0.25)));
      next.push(new THREE.Vector2(lerp(a.x, b.x, 0.75), lerp(a.y, b.y, 0.75)));
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

export function buildRoadNetwork() {
  if (roads.length) return;
  computePenalty();
  const centre = villages[0];
  const dirAngle = (a: VillageDef, b: VillageDef) => Math.atan2(b.z - a.z, b.x - a.x);
  const ptAt = (v: VillageDef, ang: number, R: number) => new THREE.Vector2(v.x + Math.cos(ang) * R, v.z + Math.sin(ang) * R);
  const stub = (v: VillageDef, ang: number, width: number) => {
    const r0 = plazaRadius(v) + 2;
    const r1 = v.r + 34;
    sampleRoad([ptAt(v, ang, r0), ptAt(v, ang, (r0 + r1) / 2), ptAt(v, ang, r1)], 'cobble', width, v.name, v.name, v.id);
    return ptAt(v, ang, r1);
  };
  const connect = (A: VillageDef, B: VillageDef, kind: RoadKind, width: number, stubW: number) => {
    const aA = dirAngle(A, B);
    const aB = dirAngle(B, A);
    A.approaches.push(aA);
    B.approaches.push(aB);
    const ea = stub(A, aA, stubW);
    const eb = stub(B, aB, stubW);
    const path = chaikin(findPath(ea, eb), 2);
    sampleRoad([ea, ...path, eb], kind, width, A.name, B.name);
  };
  for (let i = 1; i < villages.length; i++) connect(centre, villages[i], 'dirt', 6.4, 6);
  const ring = [1, 2, 3, 4, 1];
  for (let k = 0; k < ring.length - 1; k++) connect(villages[ring[k]], villages[ring[k + 1]], 'track', 5, 5);

  // Military garrison highway connection (to Fort Ironspire)
  const fortGate = new THREE.Vector2(-1550, -1700);
  const fortJunction = new THREE.Vector2(-1150, -1250);
  const fortPath = chaikin(findPath(fortJunction, fortGate), 2);
  sampleRoad([fortJunction, ...fortPath, fortGate], 'dirt', 5.5, 'Mildvar Highway', 'Fort Ironspire');

  // Lake Eldermere dock approach road
  const lakeJunction = new THREE.Vector2(1950, -1700);
  const lakeDock = new THREE.Vector2(2340, -1840);
  const lakePath = chaikin(findPath(lakeJunction, lakeDock), 2);
  sampleRoad([lakeJunction, ...lakePath, lakeDock], 'dirt', 5.0, 'Wyle Highway', 'Lake Eldermere');
}

export function roadPointAt(road: Road, s: number) {
  const smp = road.samples;
  const target = clamp(s, 0, road.length);
  let lo = 0;
  let hi = smp.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (smp[mid].s < target) lo = mid;
    else hi = mid;
  }
  const a = smp[lo];
  const b = smp[Math.min(smp.length - 1, lo + 1)];
  const segLen = Math.max(1e-4, b.s - a.s);
  const t = clamp((target - a.s) / segLen, 0, 1);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: a.x + dx * t, z: a.z + dz * t, y: a.y + (b.y - a.y) * t, tx: dx / l, tz: dz / l };
}

/* ------------------------------------------------------------------ *
 *  Farms                                                              *
 * ------------------------------------------------------------------ */
export interface FarmDef {
  x: number;
  z: number;
  rot: number;
  village: string;
  accessX: number;
  accessZ: number;
  plots: { w: number; d: number; kind: number }[];
  mill: boolean;
}

export const farms: FarmDef[] = [];
export const landUse = new ParcelRegistry();

/** Rebuild-safe: roads, zoning and paths must share one generation, even after HMR. */
export function resetWorldLayout() {
  roads.length = 0;
  bridges.length = 0;
  platforms.length = 0;
  farms.length = 0;
  roadGrid.map.clear();
  pathPenalty = null;
  landUse.clear();
  for (const v of villages) v.approaches.length = 0;
}

function farmSiteClear(farm: FarmDef) {
  for (const parcel of farmParcels(farm)) {
    if (landUse.conflicts(parcel.bounds, 5) || !roadFootprintClear(parcel.bounds, 4)) return false;
    const heights: number[] = [];
    const valid = sampleFootprint(parcel.bounds, 11, (x, z) => {
      if (Math.abs(x) > WORLD_HALF - 450 || Math.abs(z) > WORLD_HALF - 450) return false;
      const q = rivers.query(x, z);
      if (q.d < q.half + 11) return false;
      if (villages.some((v) => Math.hypot(x - v.x, z - v.z) < v.r + 20)) return false;
      const y = terrainHeight(x, z);
      if (y > 220) return false;
      heights.push(y);
      return true;
    });
    if (!valid || Math.max(...heights) - Math.min(...heights) > (parcel.kind === 'field' ? 5 : 3.8)) return false;
  }
  const yardGate = localPoint(farm, 0, -17);
  for (let t = 0; t <= 1; t += 0.2) {
    const x = lerp(farm.accessX, yardGate.x, t);
    const z = lerp(farm.accessZ, yardGate.z, t);
    const q = rivers.query(x, z);
    if (q.d < q.half + 5 || landUse.contains(x, z, 2)) return false;
  }
  return true;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildFarms() {
  if (farms.length) return;
  let seed = 7;
  for (const v of villages) {
    const rng = mulberry32(9000 + seed++ * 7919);
    const sites: { x: number; z: number; tx: number; tz: number }[] = [];
    for (const road of roads) {
      if (road.village || road.kind === 'cobble') continue;
      for (let i = 4; i < road.samples.length - 4; i += 6) {
        const p = road.samples[i];
        const d = Math.hypot(p.x - v.x, p.z - v.z);
        if (d < v.r + 140 || d > v.r + 650) continue;
        const prev = road.samples[i - 2];
        const next = road.samples[i + 2];
        const dx = next.x - prev.x;
        const dz = next.z - prev.z;
        const l = Math.hypot(dx, dz) || 1;
        sites.push({ x: p.x, z: p.z, tx: dx / l, tz: dz / l });
      }
    }
    let placed = 0;
    let guard = 0;
    while (placed < v.farms && guard++ < 2200 && sites.length) {
      const site = sites[Math.floor(rng() * sites.length)];
      const side = rng() < 0.5 ? -1 : 1;
      const nx = -site.tz * side;
      const nz = site.tx * side;
      const offset = 43 + rng() * 13;
      const x = site.x + nx * offset;
      const z = site.z + nz * offset;
      const rot = Math.atan2(nx, nz);
      const nPlots = 2 + Math.floor(rng() * 2);
      const crop = Math.floor(rng() * 3);
      const plots: { w: number; d: number; kind: number }[] = [];
      for (let i = 0; i < nPlots; i++) plots.push({ w: 26 + rng() * 18, d: 20 + rng() * 13, kind: rng() < 0.7 ? crop : 3 });
      const farm: FarmDef = {
        x, z, rot, village: v.id,
        accessX: site.x, accessZ: site.z, plots,
        mill: (v.landmark === 'mill' && placed < 2) || rng() < 0.14,
      };
      if (!farmSiteClear(farm)) continue;
      landUse.reserveFarm(farm);
      farms.push(farm);
      const gate = localPoint(farm, 0, -17);
      // Farm tracks are surveyed before the terrain and never carry through traffic.
      addVillageRoad([
        new THREE.Vector2(site.x, site.z),
        new THREE.Vector2(lerp(site.x, gate.x, 0.56), lerp(site.z, gate.z, 0.56)),
        new THREE.Vector2(gate.x, gate.z),
      ], 'track', 3.2, `farm:${v.id}`);
      placed++;
    }
  }
}
