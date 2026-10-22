import * as THREE from 'three';
import { WORLD_HALF, terrainHeight, riverQuery, riverChains, Road, RoadKind, type RiverHit } from './land';
import { TextureSet } from '../textures';

const C_GRASS1 = new THREE.Color(0x5d8f38);
const C_GRASS2 = new THREE.Color(0x7fae44);
const C_MOOR = new THREE.Color(0x7a6b8a);
const C_PINE = new THREE.Color(0x3f6b34);
const C_ARABLE = new THREE.Color(0xa8b254);
const C_ROCK = new THREE.Color(0x8b877e);
const C_SNOW = new THREE.Color(0xf2f4f8);
const C_BANK = new THREE.Color(0x8a7a52);

/**
 * Ground colour at a point: biome tint, rock, snow, river banks.
 * `hit` lets a chunk pass in the river query it already performed for the
 * height, instead of projecting onto river segments a second time.
 */
export function groundColor(x: number, z: number, h: number, out: THREE.Color, hit?: RiverHit) {
  const moist = (Math.sin(x * 0.0011) + Math.cos(z * 0.0009)) * 0.5;
  out.copy(C_GRASS1).lerp(C_GRASS2, 0.5 + moist * 0.5);
  out.lerp(C_MOOR, Math.max(0, Math.min(1, (-x - 1200) / 3200)) * 0.5);
  out.lerp(C_PINE, Math.max(0, Math.min(1, (-z - 1200) / 3200)) * 0.45);
  out.lerp(C_ARABLE, Math.max(0, Math.min(1, (z - 1100) / 3000)) * 0.42);
  out.lerp(C_ROCK, Math.min(1, Math.max(0, (h - 130) / 220)));
  out.lerp(C_SNOW, Math.min(1, Math.max(0, (h - 430) / 180)));
  const q = hit ?? riverQuery(x, z);
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
      groundColor(x, z, h, c, riverQuery(x, z));
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
      groundColor(x, z, h, c, riverQuery(x, z));
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

  /**
   * Build the arrival ring immediately (fast travel / spawn / doors).
   *
   * Building the whole keepRadius synchronously is a 200–500 ms freeze. The
   * far-terrain shader sinks itself only beyond ~900 m, so we only need the
   * coarse mesh underfoot for the first frames; the rest streams in through
   * update() a couple of chunks at a time.
   */
  prewarm(x: number, z: number, radius = 700) {
    const S = this.chunkSize;
    const cx0 = Math.round(x / S);
    const cz0 = Math.round(z / S);
    const coverage = Math.min(Math.max(radius, 600), 900);
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
      // Keep the per-frame budget small: each chunk evaluates ~3.7k terrain
      // samples, so 5 in one frame is a visible hitch.
      const budget = pending.length > 40 ? 2 : pending.length > 8 ? 3 : 5;
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

/* ---- small geometry accumulators used by the road builder ---- */
interface Buf {
  pos: number[];
  uv: number[];
  col: number[];
  idx: number[];
}
const newBuf = (): Buf => ({ pos: [], uv: [], col: [], idx: [] });
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const _v = new THREE.Vector3();
const boxM = (x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));

/** Append a coloured box (used for milestones) into an accumulator. */
function pushBox(b: Buf, m: THREE.Matrix4, color: THREE.Color) {
  const p = UNIT_BOX.attributes.position;
  const base = b.pos.length / 3;
  for (let i = 0; i < p.count; i++) {
    _v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(m);
    b.pos.push(_v.x, _v.y, _v.z);
    b.uv.push(_v.x * 0.35, _v.y * 0.35);
    b.col.push(color.r, color.g, color.b);
  }
  const index = UNIT_BOX.index!;
  for (let i = 0; i < index.count; i++) b.idx.push(base + index.getX(i));
}

/**
 * Road cross-section, improved:
 *   paving with a crowned centre and mottled wear · a pale gravel shoulder ·
 *   a grassy outer verge · kerb setts in towns and a grass median on tracks ·
 *   wheel ruts on country roads · roadside milestones on the highways.
 */
export function createRoadMeshes(tex: TextureSet, list: Road[]) {
  const group = new THREE.Group();
  const po = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
  // overlays that sit on top of the paving win the depth test outright, so the
  // crown and the ruts can never flicker against the road surface
  const poTop = { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -6 };
  const vc = { vertexColors: true, ...po };
  const mats: Record<RoadKind, THREE.Material> = {
    cobble: new THREE.MeshStandardMaterial({ map: tex.cobble, roughness: 0.94, ...vc }),
    dirt: new THREE.MeshStandardMaterial({ map: tex.dirt, roughness: 1, ...vc }),
    track: new THREE.MeshStandardMaterial({ map: tex.dirt, color: 0xc8b796, roughness: 1, ...vc }),
  };
  const vergeMat = new THREE.MeshStandardMaterial({ map: tex.dirt, vertexColors: true, roughness: 1, ...po });
  const curbMat = new THREE.MeshStandardMaterial({ map: tex.stone, vertexColors: true, roughness: 0.95, ...poTop });
  const rutMat = new THREE.MeshStandardMaterial({ map: tex.dirt, color: 0x6f5c4a, roughness: 1, ...poTop });
  const postMat = new THREE.MeshStandardMaterial({ map: tex.stone, vertexColors: true, roughness: 0.95, ...po });
  const grass = new THREE.Color(0x7c9459);
  const gravelCol = new THREE.Color(0xd3c8ae);
  const edgeCol = new THREE.Color(0xe4d8bb);
  const postStone = new THREE.Color(0xb8b2a4);
  const postPaint = new THREE.Color(0xe9e4d6);
  const tint = new THREE.Color();
  const PIECE = 60;

  list.forEach((road, roadIndex) => {
    const smp = road.samples;
    const half = road.width / 2;
    const cobble = road.kind === 'cobble';
    const shoulder = half + (cobble ? 1.15 : 1.7);
    const lift = (cobble ? 0.22 : 0.18) + (roadIndex % 5) * 0.008;
    const rutOffset = road.width * 0.23;
    // milestones: highways only, roughly every 160 m, first one offset so the
    // posts of neighbouring roads never line up
    let nextPost = road.kind === 'track' ? 1e9 : 110 + (roadIndex % 4) * 35;

    for (let start = 0; start < smp.length - 1; start += PIECE) {
      const end = Math.min(smp.length - 1, start + PIECE);
      const surface: number[] = [];
      const surfaceUV: number[] = [];
      const surfaceIdx: number[] = [];
      const surfaceCol: number[] = [];
      const verge: number[] = [];
      const vergeUV: number[] = [];
      const vergeColors: number[] = [];
      const vergeIdx: number[] = [];
      const detail: number[] = [];
      const detailUV: number[] = [];
      const detailIdx: number[] = [];
      const kerb: number[] = [];
      const kerbUV: number[] = [];
      const kerbColors: number[] = [];
      const kerbIdx: number[] = [];
      const median: number[] = [];
      const medianUV: number[] = [];
      const medianColors: number[] = [];
      const medianIdx: number[] = [];
      const posts = newBuf();
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
        // crowned centre so water runs to the gutters and the surface catches light
        const crownY = (leftY + rightY) / 2 + (bridge ? 0.02 : 0.045);
        // height of the paved section at signed offset d from the centre line,
        // including the crown — kerbs, ruts and medians all sit on this
        const surfY = (d: number) =>
          rightY + ((d + half) / (half * 2)) * (leftY - rightY) + (bridge ? 0.02 : 0.045) * (1 - Math.min(1, Math.abs(d) / half));
        const midX = (leftX + rightX) / 2;
        const midZ = (leftZ + rightZ) / 2;
        surface.push(leftX, leftY, leftZ, midX, crownY, midZ, rightX, rightY, rightZ);
        surfaceUV.push(a.s / 4.3, 0, a.s / 4.3, half / 4.3, a.s / 4.3, (half * 2) / 4.3);
        // wear: patches of pale dust and darker damp, drifting along the road
        const mottle = 0.82 + 0.2 * (0.5 + 0.5 * Math.sin(a.s * 0.09 + roadIndex * 2.3));
        const damp = 0.5 + 0.5 * Math.sin(a.s * 0.037 + roadIndex * 1.1);
        tint.setRGB(mottle * (1 - damp * 0.1), mottle * (1 - damp * 0.07), mottle * (1 - damp * 0.02));
        surfaceCol.push(tint.r * 0.88, tint.g * 0.87, tint.b * 0.86,
          tint.r, tint.g, tint.b,
          tint.r * 0.88, tint.g * 0.87, tint.b * 0.86);

        // ---- shoulder: pale gravel next to the paving, grass further out
        const midL = half + (shoulder - half) * 0.34;
        const gravelY = bridge ? a.y + lift - 0.02 : terrainHeight(a.x + nx * midL, a.z + nz * midL) + 0.12;
        const outerY = bridge ? a.y + lift - 0.05 : terrainHeight(a.x + nx * shoulder, a.z + nz * shoulder) + 0.07;
        const gravelRx = a.x - nx * midL;
        const gravelRz = a.z - nz * midL;
        const gravelRY = bridge ? a.y + lift - 0.02 : terrainHeight(gravelRx, gravelRz) + 0.12;
        const outerRx = a.x - nx * shoulder;
        const outerRz = a.z - nz * shoulder;
        const outerRY = bridge ? a.y + lift - 0.05 : terrainHeight(outerRx, outerRz) + 0.07;
        verge.push(
          a.x + nx * shoulder, outerY, a.z + nz * shoulder,
          a.x + nx * midL, gravelY, a.z + nz * midL,
          leftX, leftY - 0.025, leftZ,
          rightX, rightY - 0.025, rightZ,
          gravelRx, gravelRY, gravelRz,
          outerRx, outerRY, outerRz,
        );
        vergeUV.push(a.s / 6, 0, a.s / 6, 0.14, a.s / 6, 0.22, a.s / 6, 0.22, a.s / 6, 0.14, a.s / 6, 0);
        vergeColors.push(
          grass.r, grass.g, grass.b,
          gravelCol.r, gravelCol.g, gravelCol.b,
          edgeCol.r, edgeCol.g, edgeCol.b,
          edgeCol.r, edgeCol.g, edgeCol.b,
          gravelCol.r, gravelCol.g, gravelCol.b,
          grass.r, grass.g, grass.b,
        );

        // ---- town kerb: a raised band of setts, alternating tone
        if (cobble) {
          const sett = (i - start) % 2 === 0 ? 1 : 0.84;
          const kOut = half - 0.03;
          const kIn = half - 0.36;
          const kyL = surfY(kOut) + 0.055;
          const kyLi = surfY(kIn) + 0.075;
          const kyR = surfY(-kOut) + 0.055;
          const kyRi = surfY(-kIn) + 0.075;
          kerb.push(
            a.x + nx * kOut, kyL, a.z + nz * kOut,
            a.x + nx * kIn, kyLi, a.z + nz * kIn,
            a.x - nx * kIn, kyRi, a.z - nz * kIn,
            a.x - nx * kOut, kyR, a.z - nz * kOut,
          );
          kerbUV.push(a.s / 2.2, 0, a.s / 2.2, 0.16, a.s / 2.2, 0.16, a.s / 2.2, 0);
          for (let q = 0; q < 4; q++) kerbColors.push(sett, sett * 0.97, sett * 0.9);
        }

        // ---- grass median growing between the wheel ruts of a country track
        if (road.kind === 'track') {
          const mw = road.width * 0.14;
          const myL = surfY(mw) + 0.02;
          const myR = surfY(-mw) + 0.02;
          median.push(
            midX + nx * mw, myL, midZ + nz * mw,
            midX - nx * mw, myR, midZ - nz * mw,
          );
          medianUV.push(a.s / 3, 0, a.s / 3, 0.30);
          const g = 0.9 + 0.1 * Math.sin(a.s * 0.5);
          medianColors.push(0.44 * g, 0.55 * g, 0.3 * g, 0.44 * g, 0.55 * g, 0.3 * g);
        }

        // ---- worn parallel ruts (country roads only: towns have a kerb there)
        if (!cobble) {
          for (const side of [1, -1]) {
            const d0 = side > 0 ? rutOffset + 0.18 : -rutOffset + 0.18;
            const d1 = side > 0 ? rutOffset - 0.18 : -rutOffset - 0.18;
            const y0 = surfY(d0) + 0.03;
            const y1 = surfY(d1) + 0.03;
            detail.push(a.x + nx * d0, y0, a.z + nz * d0, a.x + nx * d1, y1, a.z + nz * d1);
            detailUV.push(a.s / 3, 0, a.s / 3, 0.3);
          }
        }

        // ---- milestone on the left shoulder
        if (a.s >= nextPost && !bridge) {
          nextPost = a.s + 160;
          const px = a.x + nx * (shoulder + 0.78);
          const pz = a.z + nz * (shoulder + 0.78);
          const py = terrainHeight(px, pz);
          const pm = new THREE.Matrix4().compose(
            new THREE.Vector3(px, py, pz),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(nx, nz)),
            new THREE.Vector3(1, 1, 1),
          );
          pushBox(posts, pm.clone().multiply(boxM(0, 0.42, 0, 0.3, 0.84, 0.26)), postStone);
          pushBox(posts, pm.clone().multiply(boxM(0, 0.88, 0, 0.34, 0.16, 0.3)), postPaint);
        }

        if (i < end) {
          // three vertices per row: left, crowned centre, right
          const k = (i - start) * 3;
          surfaceIdx.push(k, k + 3, k + 1, k + 1, k + 3, k + 4, k + 1, k + 4, k + 2, k + 2, k + 4, k + 5);

        }
      }

      for (let i = 0; i < end - start; i++) {
        if (onBridge[i] || onBridge[i + 1]) continue;
        const vk = i * 6;
        for (const side of [0, 3]) {
          for (const s of [0, 1]) {
            const a = vk + side + s;
            vergeIdx.push(a, a + 6, a + 1, a + 1, a + 6, a + 7);
          }
        }
        if (!cobble) {
          const dk = i * 4;
          for (const side of [0, 2]) {
            const a = dk + side;
            detailIdx.push(a, a + 4, a + 1, a + 1, a + 4, a + 5);
          }
        }
        if (cobble) {
          const kk = i * 4;
          kerbIdx.push(kk, kk + 4, kk + 1, kk + 1, kk + 4, kk + 5, kk + 2, kk + 6, kk + 3, kk + 3, kk + 6, kk + 7);
        }
        if (road.kind === 'track') {
          const mk = i * 2;
          medianIdx.push(mk, mk + 2, mk + 1, mk + 1, mk + 2, mk + 3);
        }
      }

      group.add(ribbonMesh(surface, surfaceUV, surfaceIdx, mats[road.kind], surfaceCol));
      if (vergeIdx.length) group.add(ribbonMesh(verge, vergeUV, vergeIdx, vergeMat, vergeColors));
      if (detailIdx.length) group.add(ribbonMesh(detail, detailUV, detailIdx, rutMat));
      if (kerbIdx.length) group.add(ribbonMesh(kerb, kerbUV, kerbIdx, curbMat, kerbColors));
      if (medianIdx.length) group.add(ribbonMesh(median, medianUV, medianIdx, vergeMat, medianColors));
      if (posts.idx.length) group.add(ribbonMesh(posts.pos, posts.uv, posts.idx, postMat, posts.col));
    }
  });
  return group;
}
