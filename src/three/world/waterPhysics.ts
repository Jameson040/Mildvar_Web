import * as THREE from 'three';
import { RNG, range, pick } from '../noise';

/** Everything the simulation needs to know about the rivers, injected by the world. */
export interface WaterAPI {
  /** rivers only: distance to the centre-line, surface height and half-width */
  query(x: number, z: number): { d: number; y: number; half: number };
  point(chain: number, t: number): { x: number; y: number; z: number; nx: number; nz: number } | null;
  length(chain: number): number;
  nearest(x: number, z: number, maxDist: number): { chain: number; t: number; d: number } | null;
}

interface Flotsam {
  chain: number;
  t: number;
  off: number;        // lateral offset from the centre-line, in metres
  speed: number;      // m/s downstream
  life: number;
  maxLife: number;
  scale: number;
  phase: number;
  kind: 0 | 1 | 2;    // leaf | foam | lily
  color: THREE.Color;
}

interface Ripple {
  x: number;
  y: number;
  z: number;
  r: number;
  maxR: number;
  speed: number;
}

const LEAVES = 36;
const FOAM = 36;
const LILIES = 18;
const RIPPLES = 24;
const ACTIVE_RADIUS = 420;

/**
 * Cheap "water physics": buoyant flotsam carried along the actual river
 * curves, plus expanding ripple rings from ducks and the player. Everything is
 * instanced (4 draw calls total) and only simulated within ~400 m of the camera.
 */
export class WaterPhysicsSystem {
  group = new THREE.Group();
  enabled = true;
  private flotsam: Flotsam[] = [];
  private ripples: Ripple[] = [];
  private leafMesh: THREE.InstancedMesh;
  private foamMesh: THREE.InstancedMesh;
  private lilyMesh: THREE.InstancedMesh;
  private rippleMesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private rng: RNG;
  private time = 0;
  private spawnClock = 0;
  private nearClock = 1;
  private near: { chain: number; t: number; d: number } | null = null;

  constructor(rng: RNG) {
    this.rng = rng;
    this.group.name = 'waterPhysics';

    const leafGeo = new THREE.PlaneGeometry(0.42, 0.55);
    leafGeo.rotateX(-Math.PI / 2);
    this.leafMesh = this.makeInstanced(leafGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide }), LEAVES);

    const foamGeo = new THREE.PlaneGeometry(0.7, 1.6);
    foamGeo.rotateX(-Math.PI / 2);
    this.foamMesh = this.makeInstanced(foamGeo, new THREE.MeshStandardMaterial({ color: 0xf4f9ff, roughness: 0.3, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }), FOAM);

    const lilyGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.05, 8);
    this.lilyMesh = this.makeInstanced(lilyGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), LILIES);

    const rippleGeo = new THREE.RingGeometry(0.86, 1.0, 28);
    rippleGeo.rotateX(-Math.PI / 2);
    this.rippleMesh = this.makeInstanced(rippleGeo, new THREE.MeshStandardMaterial({ color: 0xcfe9ff, roughness: 0.1, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }), RIPPLES);
  }

  private makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number) {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    // nothing may render at the origin before the first update
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, this.zero);
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    return mesh;
  }

  /** Expanding ring on the surface (footsteps, ducks, oars). */
  emitRipple(x: number, y: number, z: number, maxR = 3.5, speed = 2.2) {
    if (!this.enabled || this.ripples.length >= RIPPLES) return;
    this.ripples.push({ x, y: y + 0.03, z, r: 0.25, maxR, speed });
  }

  private spawn(api: WaterAPI) {
    if (!this.near || this.flotsam.length >= LEAVES + FOAM + LILIES) return;
    const len = api.length(this.near.chain);
    const t = this.near.t + range(this.rng, -340, 340) / len;
    if (t <= 0.01 || t >= 0.98) return;
    const p = api.point(this.near.chain, t);
    if (!p) return;
    const half = api.query(p.x, p.z).half;
    const roll = this.rng();
    const kind: Flotsam['kind'] = roll < 0.45 ? 0 : roll < 0.8 ? 1 : 2;
    if (kind === 2 && this.flotsam.filter((f) => f.kind === 2).length >= LILIES) return;
    const color =
      kind === 0 ? new THREE.Color(pick(this.rng, [0xd97424, 0xcaa332, 0xb85028, 0x8a4522, 0x5a8a28]))
        : kind === 1 ? new THREE.Color(0xf6fbff)
          : new THREE.Color(pick(this.rng, [0x356e30, 0x3f7a38, 0x2f6a2c]));
    this.flotsam.push({
      chain: this.near.chain,
      t,
      off: range(this.rng, -0.7, 0.7) * half,
      // lilies are rooted; leaves ride the current, foam runs with the fastest water
      speed: kind === 2 ? 0 : (kind === 1 ? 1.9 : 1.3) * range(this.rng, 0.8, 1.2),
      life: 0,
      maxLife: range(this.rng, 20, 45),
      scale: range(this.rng, 0.7, 1.3),
      phase: this.rng() * Math.PI * 2,
      kind,
      color,
    });
  }

  update(dt: number, cam: THREE.Vector3, api: WaterAPI) {
    this.group.visible = this.enabled;
    if (!this.enabled) return;
    this.time += dt;

    // the nearest river to the player is found twice a second, not every frame
    this.nearClock += dt;
    if (this.nearClock > 0.5) {
      this.nearClock = 0;
      this.near = api.nearest(cam.x, cam.z, ACTIVE_RADIUS);
    }
    this.spawnClock += dt;
    if (this.spawnClock > 0.22) {
      this.spawnClock = 0;
      this.spawn(api);
    }

    // ---- flotsam ----
    const counts = [0, 0, 0];
    const meshes = [this.leafMesh, this.foamMesh, this.lilyMesh];
    const caps = [LEAVES, FOAM, LILIES];
    const alive: Flotsam[] = [];
    for (const f of this.flotsam) {
      f.life += dt;
      const len = api.length(f.chain);
      // slower near the banks, like a real channel
      const half = Math.max(1, Math.abs(f.off) + 0.5);
      const bankFactor = 1 - 0.45 * Math.min(1, Math.abs(f.off) / half);
      f.t += (f.speed * bankFactor * dt) / len;
      if (f.life > f.maxLife || f.t >= 0.985) continue;
      const p = api.point(f.chain, f.t);
      if (!p) continue;
      const x = p.x + p.nx * f.off;
      const z = p.z + p.nz * f.off;
      if (Math.abs(x - cam.x) > ACTIVE_RADIUS + 60 || Math.abs(z - cam.z) > ACTIVE_RADIUS + 60) continue;
      const k = f.kind;
      if (counts[k] >= caps[k]) continue;
      const bob = Math.sin(this.time * 3.1 + f.phase + x * 0.4) * 0.04;
      this.dummy.position.set(x, p.y + 0.07 + bob, z);
      this.dummy.rotation.set(
        Math.sin(this.time * 2.6 + f.phase) * 0.07,
        f.phase + Math.sin(this.time * 1.4 + f.phase) * 0.35,
        Math.cos(this.time * 2.2 + f.phase) * 0.07,
      );
      this.dummy.scale.setScalar(f.scale);
      this.dummy.updateMatrix();
      meshes[k].setMatrixAt(counts[k], this.dummy.matrix);
      meshes[k].setColorAt(counts[k], f.color);
      counts[k]++;
      alive.push(f);
    }
    this.flotsam = alive;
    meshes.forEach((m, k) => {
      for (let i = counts[k]; i < caps[k]; i++) m.setMatrixAt(i, this.zero);
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    });

    // ---- ripples ----
    const liveRipples: Ripple[] = [];
    let n = 0;
    for (const r of this.ripples) {
      r.r += r.speed * dt;
      if (r.r >= r.maxR) continue;
      this.dummy.position.set(r.x, r.y, r.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(r.r, 1, r.r);
      this.dummy.updateMatrix();
      this.rippleMesh.setMatrixAt(n++, this.dummy.matrix);
      liveRipples.push(r);
    }
    this.ripples = liveRipples;
    for (let i = n; i < RIPPLES; i++) this.rippleMesh.setMatrixAt(i, this.zero);
    this.rippleMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const m of [this.leafMesh, this.foamMesh, this.lilyMesh, this.rippleMesh]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
