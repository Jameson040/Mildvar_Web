import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { World } from './world/world';
import { roadQuery, WORLD_HALF } from './world/land';

export type Mode = 'overview' | 'stroll' | 'fly' | 'ride';

const EYE = 1.7;

export class ExplorerControls {
  mode: Mode = 'overview';
  yaw = 0;
  pitch = 0;
  rideYaw = 0;
  keys = new Set<string>();
  orbit: OrbitControls;
  flySpeed = 60;
  locked = false;
  rideIndex = 0;
  onLockChange?: (locked: boolean) => void;
  private vel = new THREE.Vector3();
  private smoothY = EYE;
  private touchLook: { id: number; x: number; y: number } | null = null;
  private touchMove = new THREE.Vector2();
  private touchMoveStart: { id: number; x: number; y: number } | null = null;

  constructor(public camera: THREE.PerspectiveCamera, public dom: HTMLElement, public world: World) {
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.06;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.minDistance = 10;
    this.orbit.maxDistance = 4000;
    this.orbit.autoRotate = true;
    this.orbit.autoRotateSpeed = 0.3;
    const g = world.groundHeight(0, 0);
    this.orbit.target.set(0, g + 6, 0);
    camera.position.set(190, g + 140, 230);

    dom.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onLock);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    dom.addEventListener('wheel', this.onWheel, { passive: true });
    dom.addEventListener('touchstart', this.onTouchStart, { passive: false });
    dom.addEventListener('touchmove', this.onTouchMove, { passive: false });
    dom.addEventListener('touchend', this.onTouchEnd);
  }

  setMode(mode: Mode) {
    if (mode === this.mode) return;
    const prev = this.mode;
    this.mode = mode;
    if (mode === 'overview') {
      this.unlock();
      this.orbit.enabled = true;
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.orbit.target.copy(this.camera.position).addScaledVector(dir, 60);
      this.orbit.target.y = Math.max(this.orbit.target.y, this.world.groundHeight(this.orbit.target.x, this.orbit.target.z));
      this.camera.position.y = Math.max(this.camera.position.y, this.world.groundHeight(this.camera.position.x, this.camera.position.z) + 45);
      this.orbit.autoRotate = true;
      this.orbit.update();
      return;
    }
    this.orbit.enabled = false;
    this.orbit.autoRotate = false;
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;

    if (mode === 'stroll') {
      if (prev === 'overview') this.placeAtStart();
      const p = this.camera.position;
      if (!this.world.isWalkable(p.x, p.z)) this.placeAtStart();
      this.world.terrain.prewarm(p.x, p.z, 1100);
      this.world.resolveCollision(p, 0.65);
      this.smoothY = this.world.groundHeight(p.x, p.z) + EYE;
      p.y = this.smoothY;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -0.7, 0.7);
    } else if (mode === 'fly') {
      const p = this.camera.position;
      if (prev === 'overview') p.y = Math.max(p.y, this.world.groundHeight(p.x, p.z) + 8);
      this.vel.set(0, 0, 0);
    } else if (mode === 'ride') {
      this.rideYaw = 0;
      this.pitch = -0.12;
    }
    this.applyRotation();
  }

  private placeAtStart() {
    const t = this.world.travelTarget('mildvar')!;
    this.teleport(t.x, t.z, t.y, t.yaw);
  }

  /** Move the player instantly (fast travel / boarding) and pre-build terrain there. */
  teleport(x: number, z: number, y?: number, yaw?: number) {
    // Pocket interiors are pre-built and 220 m below the map: warming the
    // terrain there would build chunks nobody can see and stall the door.
    if (!this.world.interactions?.currentInterior) this.world.terrain.prewarm(x, z, 1100);
    this.camera.position.set(x, y ?? this.world.groundHeight(x, z) + EYE, z);
    this.vel.set(0, 0, 0);
    this.smoothY = this.camera.position.y;
    if (yaw !== undefined) {
      this.yaw = yaw;
      this.pitch = -0.03;
      this.applyRotation();
    }
  }

  boardCarriage(index: number) {
    const cars = this.world.carriages;
    if (!cars.length) return;
    this.rideIndex = ((index % cars.length) + cars.length) % cars.length;
    const car = cars[this.rideIndex];
    this.setMode('ride');
    const p = car.group.position;
    this.teleport(p.x, p.z, p.y + 3.4);
  }

  lock() {
    if (this.mode === 'overview') return;
    this.dom.requestPointerLock?.();
  }
  unlock() {
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }
  private onLock = () => {
    this.locked = document.pointerLockElement === this.dom;
    this.onLockChange?.(this.locked);
  };

  private onMouseMove = (e: MouseEvent) => {
    if (this.mode === 'overview' || !this.locked) return;
    if (this.mode === 'ride') {
      this.rideYaw -= e.movementX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.1, 0.9);
      return;
    }
    this.yaw -= e.movementX * 0.0022;
    this.pitch -= e.movementY * 0.0022;
    const lim = this.mode === 'stroll' ? 1.3 : 1.5;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -lim, lim);
    this.applyRotation();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    this.keys.add(e.code);
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onWheel = (e: WheelEvent) => {
    if (this.mode === 'fly') this.flySpeed = THREE.MathUtils.clamp(this.flySpeed * (e.deltaY > 0 ? 0.85 : 1.18), 5, 600);
  };

  private onTouchStart = (e: TouchEvent) => {
    if (this.mode === 'overview') return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX > window.innerWidth / 2) this.touchLook = { id: t.identifier, x: t.clientX, y: t.clientY };
      else this.touchMoveStart = { id: t.identifier, x: t.clientX, y: t.clientY };
    }
  };
  private onTouchMove = (e: TouchEvent) => {
    if (this.mode === 'overview') return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (this.touchLook && t.identifier === this.touchLook.id) {
        if (this.mode === 'ride') this.rideYaw -= (t.clientX - this.touchLook.x) * 0.005;
        else this.yaw -= (t.clientX - this.touchLook.x) * 0.005;
        this.pitch = THREE.MathUtils.clamp(this.pitch - (t.clientY - this.touchLook.y) * 0.005, -1.3, 1.3);
        this.touchLook.x = t.clientX;
        this.touchLook.y = t.clientY;
        if (this.mode !== 'ride') this.applyRotation();
      } else if (this.touchMoveStart && t.identifier === this.touchMoveStart.id) {
        this.touchMove.set((t.clientX - this.touchMoveStart.x) / 60, (t.clientY - this.touchMoveStart.y) / 60).clampLength(0, 1);
      }
    }
  };
  private onTouchEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (this.touchLook && t.identifier === this.touchLook.id) this.touchLook = null;
      if (this.touchMoveStart && t.identifier === this.touchMoveStart.id) {
        this.touchMoveStart = null;
        this.touchMove.set(0, 0);
      }
    }
  };

  private applyRotation() {
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }

  private inputVector() {
    const k = this.keys;
    let f = 0;
    let r = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) r += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) r -= 1;
    f -= this.touchMove.y;
    r += this.touchMove.x;
    return { f, r };
  }

  update(dt: number) {
    dt = Math.min(dt, 0.05);
    if (this.mode === 'overview') {
      this.orbit.update();
      const p = this.camera.position;
      const g = this.world.groundHeight(p.x, p.z) + 3;
      if (p.y < g) p.y = g;
      return;
    }
    const { f, r } = this.inputVector();
    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    if (this.mode === 'stroll') {
      const p0 = this.camera.position;
      // Paved roads are faster going: +35% while on the road surface.
      const onRoad = roadQuery(p0.x, p0.z).d < 0.5;
      const speed = (sprint ? 9.5 : 4.4) * (onRoad ? 1.35 : 1);
      const wish = new THREE.Vector3().addScaledVector(forward, f).addScaledVector(right, r);
      if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
      this.vel.lerp(wish, 1 - Math.exp(-dt * 12));
      const p = this.camera.position;
      const next = p.clone().addScaledVector(this.vel, dt);
      if (this.world.isWalkable(next.x, next.z)) {
        this.world.resolveCollision(next, 0.65);
        p.x = next.x;
        p.z = next.z;
      } else {
        const nx = p.clone();
        nx.x = next.x;
        const nz = p.clone();
        nz.z = next.z;
        if (this.world.isWalkable(nx.x, nx.z)) p.x = nx.x;
        else if (this.world.isWalkable(nz.x, nz.z)) p.z = nz.z;
        this.vel.multiplyScalar(0.5);
      }
      const targetY = this.world.groundHeight(p.x, p.z) + EYE;
      this.smoothY += (targetY - this.smoothY) * (1 - Math.exp(-dt * 9));
      const moving = this.vel.length() / speed;
      const bob = Math.sin(performance.now() * 0.011 * (sprint ? 1.35 : 1)) * 0.04 * moving;
      p.y = this.smoothY + bob;
    } else if (this.mode === 'fly') {
      const speed = this.flySpeed * (sprint ? 3 : 1);
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      const wish = new THREE.Vector3().addScaledVector(dir, f).addScaledVector(right, r);
      let up = 0;
      if (this.keys.has('Space') || this.keys.has('KeyE')) up += 1;
      if (this.keys.has('KeyQ') || this.keys.has('KeyC') || this.keys.has('ControlLeft')) up -= 1;
      wish.y += up;
      if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
      this.vel.lerp(wish, 1 - Math.exp(-dt * 5));
      const p = this.camera.position;
      p.addScaledVector(this.vel, dt);
      const g = this.world.groundHeight(p.x, p.z) + 1.4;
      if (p.y < g) {
        p.y = g;
        this.vel.y = Math.max(0, this.vel.y);
      }
      p.y = Math.min(p.y, 1400);
      const R = Math.hypot(p.x, p.z);
      const lim = WORLD_HALF - 300;
      if (R > lim) {
        p.x *= lim / R;
        p.z *= lim / R;
      }
    } else {
      // ride: chase the carriage; the model faces +x so heading θ → (cos θ, −sin θ)
      const cars = this.world.carriages;
      if (!cars.length) return;
      const car = cars[this.rideIndex % cars.length];
      const heading = car.group.rotation.y;
      const fwd = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
      const want = car.group.position.clone().addScaledVector(fwd, -6.5);
      want.y = car.group.position.y + 3.4;
      this.camera.position.lerp(want, 1 - Math.exp(-dt * 4));
      const baseYaw = Math.atan2(-fwd.x, -fwd.z);
      let dy = baseYaw + this.rideYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * Math.min(1, dt * 4);
      this.applyRotation();
    }
  }

  dispose() {
    this.orbit.dispose();
    this.dom.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onLock);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.removeEventListener('touchstart', this.onTouchStart);
    this.dom.removeEventListener('touchmove', this.onTouchMove);
    this.dom.removeEventListener('touchend', this.onTouchEnd);
  }
}
