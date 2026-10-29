import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { HorizontalTiltShiftShader } from 'three/examples/jsm/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/examples/jsm/shaders/VerticalTiltShiftShader.js';
import { World } from './world/world';
import { ExplorerControls, Mode } from './controls';

export type Quality = 'performance' | 'balanced' | 'ultra';

interface Preset {
  dpr: number;
  shadow: number;
  samples: number;
  view: number;
}

const PRESETS: Record<Quality, Preset> = {
  performance: { dpr: 1, shadow: 1024, samples: 0, view: 0.72 },
  balanced: { dpr: 1.25, shadow: 2048, samples: 2, view: 1 },
  ultra: { dpr: 1.75, shadow: 3072, samples: 4, view: 1.2 },
};

export interface LayerCost {
  name: string;
  calls: number;
  tris: number;
}

export interface FrameStats {
  fps: number;
  calls: number;
  triangles: number;
  chunks: number;
  /** per-layer draw-call / triangle budget, only filled while the F3 overlay is on */
  layers?: LayerCost[];
  ms?: number;
}

export class Engine {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  world: World;
  controls: ExplorerControls;
  composer!: EffectComposer;
  tiltH!: ShaderPass;
  tiltV!: ShaderPass;
  clock = new THREE.Clock();
  raf = 0;
  tilt = true;
  quality: Quality = 'balanced';
  onStats?: (s: FrameStats) => void;
  /** F3 performance overlay: per-layer draw calls and triangles. */
  showDebug = false;
  private frames = 0;
  private fpsTime = 0;

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // the composer issues several render calls per frame; accumulate stats manually
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.35, 24000);
    this.world = new World();
    this.controls = new ExplorerControls(this.camera, canvas, this.world);
    this.world.terrain.prewarm(this.controls.orbit.target.x, this.controls.orbit.target.z, 1100);

    this.applyQuality('balanced');
    window.addEventListener('resize', this.resize);
  }

  private buildComposer(samples: number) {
    if (this.composer) this.composer.dispose();
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const target = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { samples, type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.world.scene, this.camera));
    this.tiltH = new ShaderPass(HorizontalTiltShiftShader);
    this.tiltV = new ShaderPass(VerticalTiltShiftShader);
    this.tiltH.uniforms.r.value = 0.42;
    this.tiltV.uniforms.r.value = 0.42;
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    this.composer.addPass(new OutputPass());
    this.updateTilt();
  }

  applyQuality(q: Quality) {
    this.quality = q;
    const p = PRESETS[q];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, p.dpr));
    const shadow = this.world.sun.shadow;
    if (shadow.mapSize.x !== p.shadow) {
      shadow.mapSize.set(p.shadow, p.shadow);
      if (shadow.map) {
        shadow.map.dispose();
        shadow.map = null;
      }
    }
    this.world.viewScale = p.view;
    this.buildComposer(p.samples);
    this.resize();
  }

  resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.tiltH.uniforms.h.value = 1.5 / (w * pr);
    this.tiltV.uniforms.v.value = 1.5 / (h * pr);
  };

  setMode(mode: Mode) {
    this.controls.setMode(mode);
    this.updateTilt();
  }

  setTilt(on: boolean) {
    this.tilt = on;
    this.updateTilt();
  }

  private updateTilt() {
    const on = this.tilt && this.controls.mode === 'overview';
    this.tiltH.enabled = on;
    this.tiltV.enabled = on;
  }

  setHour(h: number) {
    this.world.setTimeOfDay(h);
  }

  setWaterPhysics(on: boolean) {
    this.world.waterPhysics.enabled = on;
  }

  start() {
    this.clock.start();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.05);
      this.controls.update(dt);
      this.world.update(dt, this.camera);

      const mode = this.controls.mode;
      const center = mode === 'overview' ? this.controls.orbit.target : this.camera.position;
      // Pocket interiors are isolated from the streamed terrain: don't build
      // chunks 12 km off-map while the player is indoors.
      const indoors = !!this.world.interactions?.currentInterior;
      if (!indoors) this.world.terrain.update(center.x, center.z);
      const radius = mode === 'overview'
        ? THREE.MathUtils.clamp(this.camera.position.distanceTo(this.controls.orbit.target) * 0.85, 70, 260)
        : mode === 'fly'
          ? THREE.MathUtils.clamp(70 + (this.camera.position.y - this.world.groundHeight(this.camera.position.x, this.camera.position.z)) * 1.2, 90, 260)
          : 90;
      if (!indoors) {
        this.world.updateSunShadow(new THREE.Vector3(center.x, this.world.groundHeight(center.x, center.z), center.z), Math.round(radius / 10) * 10);
      }

      this.renderer.info.reset();
      if (this.tiltH.enabled) {
        this.composer.render();
      } else {
        // No post-processing is active (stroll / fly / ride), so skip the
        // HalfFloat multisampled offscreen target and OutputPass entirely.
        this.renderer.render(this.world.scene, this.camera);
      }
      this.frames++;
      this.fpsTime += dt;
      if (this.fpsTime > 0.5) {
        const info = this.renderer.info.render;
        this.onStats?.({
          fps: Math.round(this.frames / this.fpsTime),
          calls: info.calls,
          triangles: info.triangles,
          chunks: this.world.terrain.loadedChunks,
          layers: this.showDebug ? this.world.debugLayers(this.camera) : undefined,
          ms: Math.round((this.fpsTime / Math.max(1, this.frames)) * 10000) / 10,
        });
        this.frames = 0;
        this.fpsTime = 0;
      }
    };
    loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.controls.dispose();
    this.world.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
