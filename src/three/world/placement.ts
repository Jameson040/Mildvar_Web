import type { FarmDef } from './land';

export interface Footprint {
  cx: number;
  cz: number;
  hw: number;
  hd: number;
  rot: number;
}

export type ParcelKind = 'homestead' | 'field' | 'heritage';

export interface Parcel {
  kind: ParcelKind;
  owner: string;
  bounds: Footprint;
}

export const FARM_FIELD_START = 30;
export const FARM_FIELD_GAP = 6;

/** Three.js Y rotation: local +z points along (sin(rot), cos(rot)). */
export function localPoint(origin: { x: number; z: number; rot: number }, lx: number, lz: number) {
  const c = Math.cos(origin.rot);
  const s = Math.sin(origin.rot);
  return { x: origin.x + lx * c + lz * s, z: origin.z - lx * s + lz * c };
}

export function localCoords(bounds: Footprint, x: number, z: number) {
  const c = Math.cos(bounds.rot);
  const s = Math.sin(bounds.rot);
  const dx = x - bounds.cx;
  const dz = z - bounds.cz;
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

export function containsPoint(bounds: Footprint, x: number, z: number, margin = 0) {
  const p = localCoords(bounds, x, z);
  return Math.abs(p.x) <= bounds.hw + margin && Math.abs(p.z) <= bounds.hd + margin;
}

/** Separating-axis test for two rotated building/land parcels. */
export function overlaps(a: Footprint, b: Footprint, margin = 0) {
  const ca = Math.cos(a.rot);
  const sa = Math.sin(a.rot);
  const cb = Math.cos(b.rot);
  const sb = Math.sin(b.rot);
  const au = [ca, -sa];
  const av = [sa, ca];
  const bu = [cb, -sb];
  const bv = [sb, cb];
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  for (const axis of [au, av, bu, bv]) {
    const ra = a.hw * Math.abs(au[0] * axis[0] + au[1] * axis[1]) + a.hd * Math.abs(av[0] * axis[0] + av[1] * axis[1]);
    const rb = b.hw * Math.abs(bu[0] * axis[0] + bu[1] * axis[1]) + b.hd * Math.abs(bv[0] * axis[0] + bv[1] * axis[1]);
    if (Math.abs(dx * axis[0] + dz * axis[1]) > ra + rb + margin) return false;
  }
  return true;
}

/** Samples the entire site, not just the four corners: roads can cross its middle. */
export function sampleFootprint(bounds: Footprint, spacing: number, visit: (x: number, z: number) => boolean) {
  const nx = Math.max(2, Math.ceil((bounds.hw * 2) / spacing));
  const nz = Math.max(2, Math.ceil((bounds.hd * 2) / spacing));
  const c = Math.cos(bounds.rot);
  const s = Math.sin(bounds.rot);
  for (let iz = 0; iz <= nz; iz++) {
    const lz = -bounds.hd + (iz / nz) * bounds.hd * 2;
    for (let ix = 0; ix <= nx; ix++) {
      const lx = -bounds.hw + (ix / nx) * bounds.hw * 2;
      if (!visit(bounds.cx + lx * c + lz * s, bounds.cz - lx * s + lz * c)) return false;
    }
  }
  return true;
}

/** The homestead is beside the fields, not on top of them. */
export function farmHomestead(farm: FarmDef): Footprint {
  return { cx: farm.x, cz: farm.z, hw: farm.mill ? 44 : 25, hd: 25, rot: farm.rot };
}

export function farmFields(farm: FarmDef): Footprint[] {
  let nearEdge = FARM_FIELD_START;
  return farm.plots.map((plot) => {
    const center = localPoint(farm, 0, nearEdge + plot.d / 2);
    nearEdge += plot.d + FARM_FIELD_GAP;
    return { cx: center.x, cz: center.z, hw: plot.w / 2, hd: plot.d / 2, rot: farm.rot };
  });
}

export function farmParcels(farm: FarmDef): Parcel[] {
  return [
    { kind: 'homestead', owner: farm.village, bounds: farmHomestead(farm) },
    ...farmFields(farm).map((bounds) => ({ kind: 'field' as const, owner: farm.village, bounds })),
  ];
}

/** Zoning stays separate from collision: crops aren't walls, but they own land. */
export class ParcelRegistry {
  readonly parcels: Parcel[] = [];

  clear() {
    this.parcels.length = 0;
  }

  reserveFarm(farm: FarmDef) {
    this.parcels.push(...farmParcels(farm));
  }

  reserve(kind: ParcelKind, owner: string, bounds: Footprint) {
    this.parcels.push({ kind, owner, bounds });
  }

  conflicts(bounds: Footprint, margin = 0) {
    const reach = bounds.hw + bounds.hd + margin;
    return this.parcels.some(({ bounds: other }) => {
      const r = reach + other.hw + other.hd;
      return Math.abs(bounds.cx - other.cx) <= r && Math.abs(bounds.cz - other.cz) <= r && overlaps(bounds, other, margin);
    });
  }

  contains(x: number, z: number, margin = 0) {
    return this.at(x, z, margin) !== undefined;
  }

  at(x: number, z: number, margin = 0) {
    return this.parcels.find(({ bounds }) => {
      const r = bounds.hw + bounds.hd + margin;
      return Math.abs(x - bounds.cx) <= r && Math.abs(z - bounds.cz) <= r && containsPoint(bounds, x, z, margin);
    });
  }
}