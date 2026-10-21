import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Box geometry with UVs scaled so textures tile in world units. */
export function box(w: number, h: number, d: number, texScale = 0.5) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const n = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(n.getX(i));
    const ny = Math.abs(n.getY(i));
    let su: number, sv: number;
    if (nx > 0.5) {
      su = d;
      sv = h;
    } else if (ny > 0.5) {
      su = w;
      sv = d;
    } else {
      su = w;
      sv = h;
    }
    uv.setXY(i, uv.getX(i) * su * texScale, uv.getY(i) * sv * texScale);
  }
  return g;
}

type V3 = [number, number, number];

class PolyBuilder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];

  /** Quad a,b,c,d in CCW order from outside. uv scale in world units. */
  quad(a: V3, b: V3, c: V3, d: V3, outward: V3, uvScale = 0.5) {
    const va = new THREE.Vector3(...a);
    const vb = new THREE.Vector3(...b);
    const vc = new THREE.Vector3(...c);
    const vd = new THREE.Vector3(...d);
    const n = new THREE.Vector3().subVectors(vb, va).cross(new THREE.Vector3().subVectors(vc, va)).normalize();
    const out = new THREE.Vector3(...outward);
    let order = [va, vb, vc, vd];
    if (n.dot(out) < 0) {
      n.negate();
      order = [va, vd, vc, vb];
    }
    const [p0, p1, p2, p3] = order;
    // uv axes
    const uAxis = new THREE.Vector3().subVectors(p1, p0);
    const uLen = uAxis.length();
    uAxis.normalize();
    const vAxis = new THREE.Vector3().subVectors(p3, p0);
    const vLen = vAxis.length();
    const uvOf = (p: THREE.Vector3): [number, number] => {
      const rel = new THREE.Vector3().subVectors(p, p0);
      return [rel.dot(uAxis) * uvScale, (rel.dot(vAxis.clone().normalize())) * uvScale];
    };
    void uLen;
    void vLen;
    const tri = (x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3) => {
      for (const p of [x, y, z]) {
        this.positions.push(p.x, p.y, p.z);
        this.normals.push(n.x, n.y, n.z);
        const [u, v] = uvOf(p);
        this.uvs.push(u, v);
      }
    };
    tri(p0, p1, p2);
    tri(p0, p2, p3);
  }

  tri(a: V3, b: V3, c: V3, outward: V3, uvScale = 0.5) {
    const va = new THREE.Vector3(...a);
    const vb = new THREE.Vector3(...b);
    const vc = new THREE.Vector3(...c);
    const n = new THREE.Vector3().subVectors(vb, va).cross(new THREE.Vector3().subVectors(vc, va)).normalize();
    const out = new THREE.Vector3(...outward);
    let order = [va, vb, vc];
    if (n.dot(out) < 0) {
      n.negate();
      order = [va, vc, vb];
    }
    const uAxis = new THREE.Vector3().subVectors(order[1], order[0]).normalize();
    const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();
    for (const p of order) {
      this.positions.push(p.x, p.y, p.z);
      this.normals.push(n.x, n.y, n.z);
      const rel = new THREE.Vector3().subVectors(p, order[0]);
      this.uvs.push(rel.dot(uAxis) * uvScale, rel.dot(vAxis) * uvScale);
    }
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    return g;
  }
}

/**
 * Gable roof: ridge runs along X axis with length `len`, spans `span` along Z.
 * Base (eave line, before overhang) at y=0, ridge at y=h.
 */
export function gableRoof(len: number, span: number, h: number, overhang = 0.45) {
  const b = new PolyBuilder();
  const k = h / (span / 2);
  const L = len / 2 + overhang;
  const S = span / 2 + overhang;
  const ey = -overhang * k;
  // front slope (+z)
  b.quad([-L, ey, S], [L, ey, S], [L, h, 0], [-L, h, 0], [0, 1, 1], 0.5);
  // back slope (-z)
  b.quad([L, ey, -S], [-L, ey, -S], [-L, h, 0], [L, h, 0], [0, 1, -1], 0.5);
  // underside of eaves (thin) to avoid see-through from below
  b.quad([-L, ey - 0.12, S], [-L, h - 0.12, 0], [L, h - 0.12, 0], [L, ey - 0.12, S], [0, -1, 0], 0.5);
  b.quad([L, ey - 0.12, -S], [L, h - 0.12, 0], [-L, h - 0.12, 0], [-L, ey - 0.12, -S], [0, -1, 0], 0.5);
  return b.build();
}

/** Gable end triangles (wall material). */
export function gableEnds(len: number, span: number, h: number) {
  const b = new PolyBuilder();
  const L = len / 2;
  const S = span / 2;
  b.tri([L, 0, -S], [L, 0, S], [L, h, 0], [1, 0, 0]);
  b.tri([-L, 0, S], [-L, 0, -S], [-L, h, 0], [-1, 0, 0]);
  return b.build();
}

/** Hipped roof: footprint len (x) by span (z), height h. */
export function hipRoof(len: number, span: number, h: number, overhang = 0.5) {
  const b = new PolyBuilder();
  const L = len / 2 + overhang;
  const S = span / 2 + overhang;
  const k = h / (span / 2);
  const ey = -overhang * k;
  const r = Math.max(0, len / 2 - span / 2); // half ridge length
  b.quad([-L, ey, S], [L, ey, S], [r, h, 0], [-r, h, 0], [0, 1, 1]);
  b.quad([L, ey, -S], [-L, ey, -S], [-r, h, 0], [r, h, 0], [0, 1, -1]);
  b.tri([L, ey, S], [L, ey, -S], [r, h, 0], [1, 1, 0]);
  b.tri([-L, ey, -S], [-L, ey, S], [-r, h, 0], [-1, 1, 0]);
  b.quad([-L, ey - 0.1, S], [-L, ey - 0.1, -S], [L, ey - 0.1, -S], [L, ey - 0.1, S], [0, -1, 0]);
  return b.build();
}

/** Simple pyramid (spire) with 4 sides. */
export function pyramid(base: number, h: number) {
  const b = new PolyBuilder();
  const s = base / 2;
  b.tri([-s, 0, s], [s, 0, s], [0, h, 0], [0, 0.3, 1]);
  b.tri([s, 0, s], [s, 0, -s], [0, h, 0], [1, 0.3, 0]);
  b.tri([s, 0, -s], [-s, 0, -s], [0, h, 0], [0, 0.3, -1]);
  b.tri([-s, 0, -s], [-s, 0, s], [0, h, 0], [-1, 0.3, 0]);
  return b.build();
}

/** Collects geometry by material key, merging into few meshes. */
export class Collector {
  parts = new Map<string, THREE.BufferGeometry[]>();
  private tmpColor = new THREE.Color();

  add(key: string, geom: THREE.BufferGeometry, matrix?: THREE.Matrix4, color?: THREE.ColorRepresentation) {
    let g = geom.index ? geom.toNonIndexed() : geom.clone();
    if (matrix) g.applyMatrix4(matrix);
    // strip extra attrs
    for (const name of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    const c = this.tmpColor.set(color ?? 0xffffff);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
    if (!this.parts.has(key)) this.parts.set(key, []);
    this.parts.get(key)!.push(g);
  }

  build(materials: Record<string, THREE.Material>, shadows = true): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [key, list] of this.parts) {
      const mat = materials[key];
      if (!mat) {
        console.warn('No material for key', key);
        continue;
      }
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      meshes.push(mesh);
    }
    return meshes;
  }
}

export function mat4(x: number, y: number, z: number, rotY = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
    new THREE.Vector3(sx, sy, sz),
  );
}
