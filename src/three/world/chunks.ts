import * as THREE from 'three';
import { WORLD_HALF, terrainHeight, riverQuery, riverChains, Road, RoadKind } from './land';
import { TextureSet } from '../textures';

const C_GRASS1 = new THREE.Color(0x5d8f38);
const C_GRASS2 = new THREE.Color(0x7fae44);
const C_MOOR = new THREE.Color(0x7a6b8a);
const C_PINE = new THREE.Color(0x3f6b34);
const C_ARABLE = new THREE.Color(0xa8b254);
const C_ROCK = new THREE.Color(0x8b877e);
const C_SNOW = new THREE.Color(0xf2f4f8);
const C_BANK = new THREE.Color(0x8a7a52);

/** Ground colour at a point: biome tint, rock, snow, river banks. */
export function groundColor(x: number, z: number, h: number, out: THREE.Color) {
  const moist = (Math.sin(x * 0.0011) + Math.cos(z * 0.0009)) * 0.5;
  out.copy(C_GRASS1).lerp(C_GRASS2, 0.5 + moist * 0.5);
  out.lerp(C_MOOR, Math.max(0, Math.min(1, (-x - 1200) / 3200)) * 0.5);
  out.lerp(C_PINE, Math.max(0, Math.min(1, (-z - 1200) / 3200)) * 0.45);
  out.lerp(C_ARABLE, Math.max(0, Math.min(1, (z - 1100) / 3000)) * 0.42);
  out.lerp(C_ROCK, Math.min(1, Math.max(0, (h - 130) / 220)));
  out.lerp(C_SNOW, Math.min(1, Math.max(0, (h - 430) / 180)));
  const q = riverQuery(x, z);
  if (q.d < q.half + 20) out.lerp(C_BANK, Math.min(1, 1 - (q.d - q.half) / 20) * 0.8);
}

/** One near-field tile: heights sampled with a 1-vertex apron so normals are seamless. */
function buildChunkGeometry(cx: number, cz: number, size: number, segs: number, skirt: number) {
  const side = segs + 1;
  const step = size / segs;
  const ox = cx * size - size / 2;
  const oz = cz * size - size / 2;
  const S2 = side + 2;
  const H = new Float32Array(S2 * S2);
  for (let j = 0; j < S2; j++) {
    for (let i = 0; i < S2; i++) H[j * S2 + i] = terrainHeight(ox + (i - 1) * step, oz + (j - 1) * step);
  }
  const ring = 4 * side - 4;
  const vCount = side * side;
  const total = vCount + ring;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const c = new THREE.Color();
  const inv2 = 1 / (2 * step);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const v = j * side + i;
      const x = ox + i * step;
      const z = oz + j * step;
      const h = H[(j + 1) * S2 + (i + 1)];
      pos[v * 3] = x;
      pos[v * 3 + 1] = h;
      pos[v * 3 + 2] = z;
      const nx = -(H[(j + 1) * S2 + (i + 2)] - H[(j + 1) * S2 + i]) * inv2;
      const nz = -(H[(j + 2) * S2 + (i + 1)] - H[j * S2 + (i + 1)]) * inv2;
      const il = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      nor[v * 3] = nx * il;
      nor[v * 3 + 1] = il;
      nor[v * 3 + 2] = nz * il;
      uv[v * 2] = x / 6;
      uv[v * 2 + 1] = z / 6;
      groundColor(x, z, h, c);
      col[v * 3] = c.r;
      col[v * 3 + 1] = c.g;
      col[v * 3 + 2] = c.b;
    }
  }
  // border ring (clockwise seen from above) duplicated downward as a skirt
  const border: number[] = [];
  for (let i = 0; i < side; i++) border.push(i);
  for (let j = 1; j < side; j++) border.push(j * side + side - 1);
  for (let i = side - 2; i >= 0; i--) border.push((side - 1) * side + i);
  for (let j = side - 2; j >= 1; j--) border.push(j * side);
  const base2 = vCount;
  for (let k = 0; k < ring; k++) {
    const vi = border[k];
    const o = base2 + k;
    pos[o * 3] = pos[vi * 3];
    pos[o * 3 + 1] = pos[vi * 3 + 1] - skirt;
    pos[o * 3 + 2] = pos[vi * 3 + 2];
    nor[o * 3] = nor[vi * 3];
    nor[o * 3 + 1] = nor[vi * 3 + 1];
    nor[o * 3 + 2] = nor[vi * 3 + 2];
    col[o * 3] = col[vi * 3];
    col[o * 3 + 1] = col[vi * 3 + 1];
    col[o * 3 + 2] = col[vi * 3 + 2];
    uv[o * 2] = uv[vi * 2];
    uv[o * 2 + 1] = uv[vi * 2 + 1];
  }
  const idx = new Uint32Array(segs * segs * 6 + ring * 6);
  let p = 0;
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * side + i;
      idx[p++] = a; idx[p++] = a + side; idx[p++] = a + 1;
      idx[p++] = a + 1; idx[p++] = a + side; idx[p++] = a + side + 1;
    }
  }
  for (let k = 0; k < ring; k++) {
    const a = border[k];
    const b = border[(k + 1) % ring];
    const na = base2 + k;
    const nb = base2 + ((k + 1) % ring);
    idx[p++] = a; idx[p++] = nb; idx[p++] = na;
    idx[p++] = a; idx[p++] = b; idx[p++] = nb;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Streaming near-field terrain + one permanent coarse world mesh.
 * The coarse mesh sinks 18 m only inside the radius guaranteed to be covered
 * by near chunks, so a missing chunk cannot reveal a square depression.
 */
export class TerrainSystem {
  group = new THREE.Group();
  camUniform = { value: new THREE.Vector3() };
  nearUniform = { value: 1400 };
  readonly chunkSize = 300;
  readonly segs = 40; // 7.5 m grid — must stay finer than the river shelf / road bed
  readonly keepRadius = 1500;
  private nearMat: THREE.MeshStandardMaterial;
  private farMat: THREE.MeshStandardMaterial;
  private chunks = new Map<string, THREE.Mesh>();

  constructor(tex: TextureSet) {
    this.nearMat = new THREE.MeshStandardMaterial({ map: tex.grass, vertexColors: true, roughness: 1 });
    this.farMat = new THREE.MeshStandardMaterial({
      map: tex.grass,
      vertexColors: true,
      roughness: 1,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });
    const camUniform = this.camUniform;
    const nearUniform = this.nearUniform;
    this.farMat.onBeforeCompile = (shader) => {
      shader.uniforms.uCam = camUniform;
      shader.uniforms.uNear = nearUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uCam;\nuniform float uNear;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nfloat dCam = distance(position.xz, uCam.xz);\ntransformed.y -= 18.0 * (1.0 - smoothstep(uNear - 480.0, uNear - 150.0, dCam));',
        );
    };
    this.group.add(this.buildFar());
  }

  private buildFar() {
    const size = WORLD_HALF * 2 + 1600;
    const segs = 400;
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = terrainHeight(x, z);
      pos.setY(i, h);
      uv.setXY(i, x / 24, z / 24);
      groundColor(x, z, h, c);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.farMat);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = 'farTerrain';
    return mesh;
  }

  private makeChunk(cx: number, cz: number) {
    const key = `${cx},${cz}`;
    if (this.chunks.has(key)) return;
    const mesh = new THREE.Mesh(buildChunkGeometry(cx, cz, this.chunkSize, this.segs, 12), this.nearMat);
    mesh.receiveShadow = true;
    mesh.name = key;
    this.chunks.set(key, mesh);
    this.group.add(mesh);
  }

  /** Build every chunk within `radius` right now (used for fast travel / spawn). */
  prewarm(x: number, z: number, radius = 700) {
    const S = this.chunkSize;
    const cx0 = Math.round(x / S);
    const cz0 = Math.round(z / S);
    const coverage = Math.max(radius, this.keepRadius);
    const R = Math.ceil(coverage / S);
    for (let cz = cz0 - R; cz <= cz0 + R; cz++) {
      for (let cx = cx0 - R; cx <= cx0 + R; cx++) {
        if (Math.hypot(cx * S - x, cz * S - z) <= coverage) this.makeChunk(cx, cz);
      }
    }
    this.camUniform.value.set(x, 0, z);
  }

  update(px: number, pz: number) {
    this.camUniform.value.set(px, 0, pz);
    const S = this.chunkSize;
    const cx0 = Math.round(px / S);
    const cz0 = Math.round(pz / S);
    const R = Math.ceil(this.keepRadius / S);
    const wanted = new Set<string>();
    const pending: [number, number, number][] = [];
    for (let cz = cz0 - R; cz <= cz0 + R; cz++) {
      for (let cx = cx0 - R; cx <= cx0 + R; cx++) {
        const d = Math.hypot(cx * S - px, cz * S - pz);
        if (d > this.keepRadius) continue;
        const key = `${cx},${cz}`;
        wanted.add(key);
        if (!this.chunks.has(key)) pending.push([cx, cz, d]);
      }
    }
    if (pending.length) {
      pending.sort((a, b) => a[2] - b[2]);
      const budget = pending.length > 8 ? 5 : 2;
      for (const [cx, cz] of pending.slice(0, budget)) this.makeChunk(cx, cz);
    }
    for (const [key, mesh] of this.chunks) {
      if (!wanted.has(key)) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.chunks.delete(key);
      }
    }
  }

  get loadedChunks() {
    return this.chunks.size;
  }
}

/** Water ribbons following each river's downhill profile, split for culling. */
export function createRivers(tex: TextureSet) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x3f7fa8,
    roughness: 0.12,
    metalness: 0.35,
    normalMap: tex.waterNormal,
    normalScale: new THREE.Vector2(0.45, 0.45),
    transparent: true,
    opacity: 0.9,
  });
  for (const chain of riverChains) {
    const curve = new THREE.CatmullRomCurve3(chain, false, 'centripetal', 0.5);
    const len = curve.getLength();
    const n = Math.max(6, Math.ceil(len / 10));
    const PIECE = 48;
    for (let start = 0; start < n; start += PIECE) {
      const end = Math.min(n, start + PIECE);
      const positions: number[] = [];
      const uvs: number[] = [];
      const idx: number[] = [];
      for (let i = start; i <= end; i++) {
        const t = i / n;
        const p = curve.getPointAt(t);
        const tan = curve.getTangentAt(t);
        // a touch wider than the channel so the surface tucks under the shelf lip,
        // and a few cm above the chain height so it clears the bed vertices
        const half = Math.max(2.4, riverQuery(p.x, p.z).half + 0.6);
        const l = Math.hypot(tan.x, tan.z) || 1;
        const nx = -tan.z / l;
        const nz = tan.x / l;
        const y = p.y + 0.06;
        positions.push(p.x + nx * half, y, p.z + nz * half, p.x - nx * half, y, p.z - nz * half);
        uvs.push((t * len) / 9, 0, (t * len) / 9, (half * 2) / 9);
        if (i < end) {
          const a = (i - start) * 2;
          idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat);
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return group;
}

function ribbonMesh(positions: number[], uv: number[], indices: number[], material: THREE.Material, colors?: number[]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, material);
  mesh.receiveShadow = true;
  return mesh;
}

/** Road cross-section: visible paving, two earth verges, and kind-specific wear. */
export function createRoadMeshes(tex: TextureSet, list: Road[]) {
  const group = new THREE.Group();
  const po = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
  const mats: Record<RoadKind, THREE.Material> = {
    cobble: new THREE.MeshStandardMaterial({ map: tex.cobble, roughness: 0.94, ...po }),
    dirt: new THREE.MeshStandardMaterial({ map: tex.dirt, roughness: 1, ...po }),
    track: new THREE.MeshStandardMaterial({ map: tex.dirt, color: 0xc8b796, roughness: 1, ...po }),
  };
  const vergeMat = new THREE.MeshStandardMaterial({ map: tex.dirt, vertexColors: true, roughness: 1, ...po });
  const curbMat = new THREE.MeshStandardMaterial({ map: tex.stone, color: 0xc9bca4, roughness: 1, ...po });
  const rutMat = new THREE.MeshStandardMaterial({ map: tex.dirt, color: 0x705d4c, roughness: 1, ...po });
  const innerColor = new THREE.Color(0xe9d8b6);
  const outerColor = new THREE.Color(0x9cae83);
  const PIECE = 60;

  list.forEach((road, roadIndex) => {
    const smp = road.samples;
    const half = road.width / 2;
    const shoulder = half + (road.kind === 'cobble' ? 1.15 : 1.7);
    const lift = (road.kind === 'cobble' ? 0.22 : 0.18) + (roadIndex % 5) * 0.008;
    for (let start = 0; start < smp.length - 1; start += PIECE) {
      const end = Math.min(smp.length - 1, start + PIECE);
      const surface: number[] = [];
      const surfaceUV: number[] = [];
      const surfaceIdx: number[] = [];
      const verge: number[] = [];
      const vergeUV: number[] = [];
      const vergeColors: number[] = [];
      const vergeIdx: number[] = [];
      const detail: number[] = [];
      const detailUV: number[] = [];
      const detailIdx: number[] = [];
      const onBridge: boolean[] = [];

      for (let i = start; i <= end; i++) {
        const a = smp[i];
        const next = smp[Math.min(smp.length - 1, i + 1)];
        const prev = smp[Math.max(0, i - 1)];
        const dx = next.x - prev.x;
        const dz = next.z - prev.z;
        const inv = 1 / (Math.hypot(dx, dz) || 1);
        const nx = -dz * inv;
        const nz = dx * inv;
        const bridge = road.bridges.some((sp) => {
          const ox = a.x - sp.x;
          const oz = a.z - sp.z;
          return Math.abs(ox * sp.dx + oz * sp.dz) < sp.halfLen && Math.abs(-ox * sp.dz + oz * sp.dx) < sp.halfW + 2;
        });
        onBridge.push(bridge);

        const leftX = a.x + nx * half;
        const leftZ = a.z + nz * half;
        const rightX = a.x - nx * half;
        const rightZ = a.z - nz * half;
        const leftY = bridge ? a.y + lift : Math.max(a.y + lift, terrainHeight(leftX, leftZ) + 0.18);
        const rightY = bridge ? a.y + lift : Math.max(a.y + lift, terrainHeight(rightX, rightZ) + 0.18);
        surface.push(leftX, leftY, leftZ, rightX, rightY, rightZ);
        surfaceUV.push(a.s / 4.3, 0, a.s / 4.3, road.width / 4.3);

        // Two verges, not a full-width plane under the paving. The outer
        // vertices blend to field green and the inner vertices to packed earth.
        const leftOuterX = a.x + nx * shoulder;
        const leftOuterZ = a.z + nz * shoulder;
        const rightOuterX = a.x - nx * shoulder;
        const rightOuterZ = a.z - nz * shoulder;
        const leftOuterY = terrainHeight(leftOuterX, leftOuterZ) + 0.07;
        const rightOuterY = terrainHeight(rightOuterX, rightOuterZ) + 0.07;
        verge.push(leftOuterX, leftOuterY, leftOuterZ, leftX, leftY - 0.025, leftZ,
          rightX, rightY - 0.025, rightZ, rightOuterX, rightOuterY, rightOuterZ);
        vergeUV.push(a.s / 6, 0, a.s / 6, 0.27, a.s / 6, 0.27, a.s / 6, 0);
        vergeColors.push(outerColor.r, outerColor.g, outerColor.b, innerColor.r, innerColor.g, innerColor.b,
          innerColor.r, innerColor.g, innerColor.b, outerColor.r, outerColor.g, outerColor.b);

        // A pale stone curb in town, worn parallel wheel ruts on country roads.
        const offset = road.kind === 'cobble' ? half - 0.04 : road.width * 0.23;
        const detailHalf = road.kind === 'cobble' ? 0.13 : 0.18;
        for (const side of [1, -1]) {
          const d0 = side > 0 ? offset + detailHalf : -offset + detailHalf;
          const d1 = side > 0 ? offset - detailHalf : -offset - detailHalf;
          const extra = road.kind === 'cobble' ? 0.055 : 0.025;
          const y0 = rightY + ((d0 + half) / (half * 2)) * (leftY - rightY) + extra;
          const y1 = rightY + ((d1 + half) / (half * 2)) * (leftY - rightY) + extra;
          detail.push(a.x + nx * d0, y0, a.z + nz * d0, a.x + nx * d1, y1, a.z + nz * d1);
          detailUV.push(a.s / 3, 0, a.s / 3, 0.3);
        }

        if (i < end) {
          const k = (i - start) * 2;
          // First vertex is on the left (+normal), then on the right. This
          // winding faces UP; the old winding faced down and was culled.
          surfaceIdx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
        }
      }

      for (let i = 0; i < end - start; i++) {
        if (onBridge[i] || onBridge[i + 1]) continue;
        const k = i * 4;
        for (const side of [0, 2]) {
          const a = k + side;
          vergeIdx.push(a, a + 4, a + 1, a + 1, a + 4, a + 5);
          detailIdx.push(a, a + 4, a + 1, a + 1, a + 4, a + 5);
        }
      }

      group.add(ribbonMesh(surface, surfaceUV, surfaceIdx, mats[road.kind]));
      if (vergeIdx.length) {
        group.add(ribbonMesh(verge, vergeUV, vergeIdx, vergeMat, vergeColors));
        group.add(ribbonMesh(detail, detailUV, detailIdx, road.kind === 'cobble' ? curbMat : rutMat));
      }
    }
  });
  return group;
}
