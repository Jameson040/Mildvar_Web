import * as THREE from 'three';
import { createTextures, TextureSet } from '../textures';
import { Collector, mat4, box } from '../geometry';
import { RNG, mulberry32, range, pick, clamp, lerp, smoothstep, fbm } from '../noise';
import { addBridge, Obb, PALETTE } from '../buildings';
import { createHedges, createFlowers, createClouds, HedgeSeg, FlowerSpec } from '../nature';
import { TerrainSystem, createRivers, createRoadMeshes } from './chunks';
import {
  villages, VillageDef, buildRoadNetwork, buildFarms, farms, roads, bridges, platforms, Road, BridgeSpan, terrainHeight, waterDist,
  riverHalfWidth, roadQuery, RIVER_BANK, roadPointAt, SpatialGrid, waterSurfaceY, WORLD_HALF, getRiverPoint, Theme, plazaRadius, landUse, resetWorldLayout,
  ALL_LOCATIONS, SettlementSpec, riverQuery, riverLength, nearestRiverPoint, waterQuery, LAKE, FORT, WATCHTOWER_SITES,
} from './land';
import { buildVillage, buildFarm, BuildCtx, cropBatch, TreeSpecOut, planVillage } from './villageBuilder';
import { addBoat, buildMillSails, cropTuftGeometry, addMilestone } from './structures';
import { buildNature, createBirds, ScatterItem, NatureTile, FarForest } from './scatter';
import { containsPoint } from './placement';
import { WaterPhysicsSystem, WaterAPI } from './waterPhysics';
import {
  buildLakeEldermere, buildWhisperingWeald, buildFortIronspire, buildGoldenMeadow,
  buildWatchtower, WEALD_POS, MEADOW_POS, WildernessCtx
} from './wilderness';
import { InteractionSystem } from './interactables';

export interface WorldEntity {
  id: string;
  name: string;
  role: string;
  faction: string;
  obj: THREE.Object3D;
}

interface Walker {
  id: string;
  obj: THREE.Object3D;
  curve: THREE.Curve<THREE.Vector3>;
  len: number;
  t: number;
  speed: number;
  dir: number;
  offset: number;
  phase: number;
  closed: boolean;
  home: VillageDef;
}

export interface Carriage {
  group: THREE.Group;
  road: Road;
  s: number;
  dir: number;
  speed: number;
  wheels: THREE.Object3D[];
}

export interface WildernessLandmark {
  id: string;
  group: THREE.Group;
  meshes: THREE.Mesh[];
  cx: number;
  cz: number;
  radius: number;
  shadow: boolean;
}

interface Settlement {
  v: VillageDef;
  group: THREE.Group;
  meshes: THREE.Mesh[];
  radius: number;
  shadow: boolean;
}

const LIGHT_POOL = 8;

export class World {
  scene = new THREE.Scene();
  textures: TextureSet;
  materials: Record<string, THREE.Material> = {};
  roadsGroup = new THREE.Group();
  propsGroup = new THREE.Group();
  terrain!: TerrainSystem;
  water!: THREE.Group;
  birds!: ReturnType<typeof createBirds>;
  sun!: THREE.DirectionalLight;
  hemi!: THREE.HemisphereLight;
  ambient!: THREE.AmbientLight;
  sky!: THREE.Mesh;
  skyMat!: THREE.ShaderMaterial;
  clouds!: THREE.InstancedMesh;
  lightPool: THREE.PointLight[] = [];
  lampPositions: THREE.Vector3[] = [];
  lampIntensity = 0;
  obbs: Obb[] = [];
  obbGrid = new SpatialGrid<Obb>(72);
  settlements: Settlement[] = [];
  wilderness: WildernessLandmark[] = [];
  entities = new Map<string, WorldEntity>();
  interactions!: InteractionSystem;
  natureTiles: NatureTile[] = [];
  natureFar: FarForest | null = null;
  private nearKeys = new Set<string>();
  walkers: Walker[] = [];
  carriages: Carriage[] = [];
  mills: { obj: THREE.Group; speed: number }[] = [];
  boats: { obj: THREE.Object3D; baseY: number; phase: number }[] = [];
  ducks: { obj: THREE.Object3D; chain: number; t: number; speed: number; off: number }[] = [];
  soldiers: { obj: THREE.Object3D; baseRot: number; baseY: number; phase: number; id: string; name: string; role: string; faction: string }[] = [];
  waterPhysics!: WaterPhysicsSystem;
  private waterApi: WaterAPI = {
    query: riverQuery,
    point: getRiverPoint,
    length: riverLength,
    nearest: (x, z, maxDist) => {
      const p = nearestRiverPoint(x, z, maxDist);
      return p ? { chain: p.chain, t: p.t, d: p.d } : null;
    },
  };
  discovered = new Set<string>();
  hour = 18.2;
  sunDir = new THREE.Vector3(0, 1, 0);
  lightDir = new THREE.Vector3(0, 1, 0);
  rng: RNG;
  time = 0;
  viewScale = 1;
  stats = { houses: 0, trees: 0, villagers: 0, farms: 0, bridges: 0, roadsKm: 0 };
  private discoveryCb?: (name: string) => void;
  private ctx!: BuildCtx;
  private cloudTarget = new THREE.Vector3();

  constructor() {
    resetWorldLayout();
    cropBatch.length = 0;
    this.rng = mulberry32(4242);
    this.textures = createTextures();
    this.createMaterials();
    // Doors, NPCs and pocket interiors are registered while the world is
    // generated, so the interaction layer must exist before Layer 2.
    this.interactions = new InteractionSystem(this.materials);
    this.scene.add(this.interactions.group);
    this.interactions.mount(this.scene);
    this.buildSky();
    this.buildLights();
    this.scene.add(this.roadsGroup);
    this.scene.add(this.propsGroup);

    /* ================================================================
     *  LAYER 1 — FOUNDATION (pure data, no meshes)
     *  Landscape noise, river chains with downhill profiles, the five
     *  settlement sites and their plateau heights. Already evaluated by
     *  the module imports above; nothing here may depend on meshes.
     * ================================================================ */

    /* ================================================================
     *  LAYER 2 — ROUTES (survey everything before shaping the ground)
     *  Long roads via A*, then every village street, ring lane and
     *  harbour quay is registered, so the terrain of Layer 3 can conform
     *  to all of them and the road meshes of Layer 5 have no gaps.
     * ================================================================ */
    buildRoadNetwork();
    const ctx = this.makeCtx();
    const plans = villages.map((v, i) => {
      ctx.theme = v.theme;
      return planVillage(v, mulberry32(1013 + i * 7717));
    });
    buildFarms(); // farm placement also respects the final road grid

    /* ================================================================
     *  LAYER 3 — TERRAIN
     *  One coarse world mesh plus streamed detail chunks; both sample
     *  terrainHeight(), which now sees every route from Layer 2.
     * ================================================================ */
    this.terrain = new TerrainSystem(this.textures);
    this.scene.add(this.terrain.group);

    /* ================================================================
     *  LAYER 4 — WATER (sits in the channels carved by Layer 3)
     * ================================================================ */
    this.water = createRivers(this.textures);
    this.scene.add(this.water);
    this.scene.add(this.createLake());

    /* ================================================================
     *  LAYER 5 — CIRCULATION (meshes for everything surveyed in L2)
     *  Road ribbons and bridges over crossings; roadside planting waits
     *  until buildings and field ownership are final.
     * ================================================================ */
    this.roadsGroup.add(createRoadMeshes(this.textures, roads));
    this.buildBridges();
    this.stats.roadsKm = Math.round(roads.reduce((a: number, r: Road) => a + r.length, 0) / 100) / 10;
    this.stats.bridges = bridges.length;
    this.stats.farms = farms.length;

    /* ================================================================
     *  LAYER 6 — SETTLEMENTS & WILDERNESS LANDMARKS on the finished ground
     * ================================================================ */
    villages.forEach((v, i) => {
      const c = new Collector();
      ctx.c = c;
      ctx.theme = v.theme;
      buildVillage(v, plans[i], ctx);
      for (const f of farms) if (f.village === v.id) buildFarm(f, v, ctx);
      const meshes = c.build(this.materials);
      const group = new THREE.Group();
      group.name = v.id;
      for (const m of meshes) group.add(m);
      this.propsGroup.add(group);
      this.settlements.push({ v, group, meshes, radius: v.r + 560, shadow: true });
    });

    // Wilderness landmarks are built into ONE COLLECTOR PER LANDMARK, not one
    // global collector. A single 10 km-wide merged mesh can never be frustum
    // culled (its bounding sphere covers the realm) and it cast shadows
    // everywhere; per-landmark groups get real culling and shadow gating.
    const wildPatrols: { x: number; y: number; z: number; rot: number; type: 'guard' | 'archer' | 'officer' }[] = [];
    const wildCtx: WildernessCtx = {
      c: new Collector(),
      rng: this.rng,
      obbs: this.obbs,
      trees: this.ctx.trees as TreeSpecOut[],
      lamps: this.ctx.lamps,
      soldierPatrols: wildPatrols,
      interactions: this.interactions,
    };

    const landmarks: { id: string; cx: number; cz: number; radius: number; build: (ctx: WildernessCtx) => void }[] = [
      { id: 'lake_eldermere', cx: LAKE.x, cz: LAKE.z, radius: 420, build: buildLakeEldermere },
      { id: 'whispering_weald', cx: WEALD_POS.x, cz: WEALD_POS.z, radius: 540, build: buildWhisperingWeald },
      { id: 'fort_ironspire', cx: FORT.x, cz: FORT.z, radius: 260, build: buildFortIronspire },
      { id: 'golden_mead', cx: MEADOW_POS.x, cz: MEADOW_POS.z, radius: 460, build: buildGoldenMeadow },
    ];
    for (const lm of landmarks) {
      const c = new Collector();
      lm.build({ ...wildCtx, c });
      this.addWildernessGroup(lm.id, c, lm.cx, lm.cz, lm.radius);
    }
    // Each watchtower is its own draw-call cluster so one far tower cannot
    // keep four near ones in the render list.
    for (const site of WATCHTOWER_SITES) {
      const c = new Collector();
      buildWatchtower({ ...wildCtx, c }, site);
      this.addWildernessGroup(site.id, c, site.x, site.z, 70);
    }

    /* ================================================================
     *  LAYER 7 — ANIMATION RIGS, WATER PHYSICS & LIGHTS
     * ================================================================ */
    this.buildCrops();
    this.buildDynamics();
    this.collectLamps();

    // 💧 Optimized GPU Water Physics & Buoyant Flotsam Simulation
    this.waterPhysics = new WaterPhysicsSystem(this.rng);
    this.scene.add(this.waterPhysics.group);

    // Collision and land-use queries must exist before planting road avenues.
    for (const o of this.obbs) this.obbGrid.insert(o.cx, o.cz, Math.max(o.hw, o.hd) + 2.5, o);
    this.stats.houses = this.obbs.filter((o) => o.hw > 2 && o.hd > 2).length;

    /* ================================================================
     *  LAYER 8 — NATURE grows on top of terrain, roads and fields:
     *  milestone verges, village gardens, woodland belts, the wild
     *  forests, riverside growth, rocks and scrub.
     * ================================================================ */
    this.buildRoadside();
    this.buildNature();

    /* ================================================================
     *  LAYER 9 — LIFE: soldiers, villagers, carriages, ducks, birds, clouds.
     * ================================================================ */
    this.buildSoldiers(wildPatrols);
    this.buildVillagers();
    this.buildCarriages();
    this.buildDucks();
    this.birds = createBirds(this.rng, 9, villages.map((v) => ({ x: v.x, z: v.z })));
    this.scene.add(this.birds.mesh);
    this.clouds = createClouds(this.rng);
    this.clouds.position.y = 140;
    this.scene.add(this.clouds);

    this.setTimeOfDay(this.hour);
  }

  /* ------------------------------------------------------------ */
  private createMaterials() {
    const t = this.textures;
    const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
    const ground = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 };
    const stone = std({ map: t.stone, vertexColors: true, roughness: 0.95 });
    this.materials = {
      flat: std({ vertexColors: true, roughness: 0.75 }),
      stone,
      stoneDark: stone,
      stoneDS: std({ map: t.stone, vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }),
      plaster: std({ map: t.plaster, vertexColors: true, roughness: 0.9 }),
      tiles: std({ map: t.tiles, vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }),
      slate: std({ map: t.slate, vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }),
      thatch: std({ map: t.thatch, vertexColors: true, roughness: 1, side: THREE.DoubleSide }),
      wood: std({ map: t.wood, vertexColors: true, roughness: 0.82 }),
      canvas: std({ color: 0xe8e2d0, vertexColors: true, roughness: 1, side: THREE.DoubleSide }),
      glass: std({ color: 0x3d4e63, roughness: 0.12, metalness: 0.55, emissive: 0xffb95e, emissiveIntensity: 0 }),
      glassChurch: std({ color: 0x3a4f8e, roughness: 0.2, metalness: 0.4, emissive: 0xd9b36a, emissiveIntensity: 0 }),
      lampglass: std({ color: 0xfff3d0, roughness: 0.3, emissive: 0xffc46a, emissiveIntensity: 0.2 }),
      leaf: std({ vertexColors: true, roughness: 1 }),
      rock: std({ map: t.rock, vertexColors: true, roughness: 1 }),
      water: std({ color: 0x5aa0cf, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.85 }),
      fountainWater: std({ color: 0x5aa0cf, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.85 }),
      cobble: std({ map: t.cobble, roughness: 0.95, ...ground }),
      dirt: std({ map: t.dirt, roughness: 1, ...ground }),
      packed: std({ map: t.dirt, color: 0xd5c4a3, roughness: 1, ...ground }),
      soil: std({ map: t.dirt, color: 0x7a6248, roughness: 1, ...ground }),
      crop0: std({ map: t.crops[0], roughness: 1, ...ground }),
      crop1: std({ map: t.crops[1], roughness: 1, ...ground }),
      crop2: std({ map: t.crops[2], roughness: 1, ...ground }),
      crop3: std({ map: t.crops[3], roughness: 1, ...ground }),
      tuft0: std({ color: 0xd2b25a, roughness: 1 }),
      tuft1: std({ color: 0xc9bb6e, roughness: 1 }),
      tuft2: std({ color: 0x5f9a3c, roughness: 1 }),
      tuft3: std({ color: 0x9a8a5a, roughness: 1 }),
    };
    t.awnings.forEach((a, i) => {
      this.materials[`awning${i}`] = std({ map: a, roughness: 0.9, side: THREE.DoubleSide });
    });
  }

  private buildSky() {
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x3b7bd6) },
        horizonColor: { value: new THREE.Color(0xdcecff) },
        sunColor: { value: new THREE.Color(0xfff2d0) },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        moonDir: { value: new THREE.Vector3(0, 1, 0) },
        nightness: { value: 0 },
      },
      vertexShader: `varying vec3 vWorldPos;
        void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vWorldPos = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `
        uniform vec3 topColor; uniform vec3 horizonColor; uniform vec3 sunColor; uniform vec3 sunDir; uniform vec3 moonDir; uniform float nightness;
        varying vec3 vWorldPos;
        float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
        void main(){
          vec3 d = normalize(vWorldPos - cameraPosition);
          float h = clamp(d.y, 0.0, 1.0);
          vec3 col = mix(horizonColor, topColor, pow(h, 0.5));
          float s = max(dot(d, sunDir), 0.0);
          col += sunColor * (pow(s, 900.0) * 3.0 + pow(s, 24.0) * 0.45 + pow(s, 3.0) * 0.12);
          vec3 cell = floor(d * 260.0);
          float st = step(0.9975, hash(cell)) * smoothstep(0.0, 0.25, d.y);
          col += vec3(st) * nightness * 0.9;
          float m = max(dot(d, moonDir), 0.0);
          col += vec3(0.85,0.9,1.0) * (smoothstep(0.99930,0.99965,m) * 2.5 + pow(m, 80.0) * 0.25) * nightness;
          col = mix(col, horizonColor * 0.92, smoothstep(0.0, -0.12, d.y));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 40, 20), this.skyMat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.scene.fog = new THREE.FogExp2(0xdcecff, 0.00016);
  }

  private buildLights() {
    this.hemi = new THREE.HemisphereLight(0xbfd9ff, 0x8a7a55, 0.7);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.12);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 1000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.06;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    // a fixed pool of point lights is re-targeted to the nearest lanterns every frame,
    // so shaders compile once for 8 lights instead of one per lamp in the realm
    for (let i = 0; i < LIGHT_POOL; i++) {
      const pl = new THREE.PointLight(0xffc46a, 0, 26, 1.8);
      this.scene.add(pl);
      this.lightPool.push(pl);
    }
  }

  private makeCtx(): BuildCtx {
    const ctx: BuildCtx = {
      c: new Collector(),
      rng: this.rng,
      obbs: this.obbs,
      trees: [],
      hedges: [],
      flowers: [],
      lamps: [],
      dynamics: [],
      interactions: this.interactions,
      theme: { ...PALETTE, scale: 1, treeMix: 0.12, foliage: [0x5c9a36, 0x6aa63c], hedge: [0x4a8a35], accent: 0xd9a632 } as unknown as Theme,
      plaza: (x: number, z: number, rx: number, rz: number) => {
        const geo = new THREE.CircleGeometry(1, 40);
        geo.rotateX(-Math.PI / 2);
        geo.scale(rx, 1, rz);
        const uv = geo.attributes.uv as THREE.BufferAttribute;
        const pos = geo.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / 4.5, pos.getZ(i) / 4.5);
        const mesh = new THREE.Mesh(geo, this.materials.cobble);
        mesh.position.set(x, terrainHeight(x, z) + 0.21, z);
        mesh.receiveShadow = true;
        this.roadsGroup.add(mesh);

        const edge = new THREE.RingGeometry(0.992, 1.025, 64);
        edge.rotateX(-Math.PI / 2);
        edge.scale(rx, 1, rz);
        const kerb = new THREE.Mesh(edge, this.materials.packed);
        kerb.position.set(x, terrainHeight(x, z) + 0.255, z);
        kerb.receiveShadow = true;
        this.roadsGroup.add(kerb);
      },
    };
    this.ctx = ctx;
    return ctx;
  }

  /** Lake Eldermere's surface shares the river water material (same normal-map scroll). */
  private createLake() {
    const geo = new THREE.CircleGeometry(LAKE.r + 1.5, 64);
    geo.rotateX(-Math.PI / 2);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / 9, pos.getZ(i) / 9);
    const riverMat = (this.water.children[0] as THREE.Mesh | undefined)?.material as THREE.Material | undefined;
    const mesh = new THREE.Mesh(geo, riverMat ?? this.materials.water);
    mesh.position.set(LAKE.x, LAKE.y + 0.06, LAKE.z);
    mesh.receiveShadow = true;
    mesh.name = 'lake';
    return mesh;
  }

  private addWildernessGroup(id: string, c: Collector, cx: number, cz: number, radius: number) {
    const meshes = c.build(this.materials);
    const group = new THREE.Group();
    group.name = id;
    for (const m of meshes) group.add(m);
    this.propsGroup.add(group);
    this.wilderness.push({ id, group, meshes, cx, cz, radius, shadow: true });
  }

  private buildBridges() {
    const c = new Collector();
    for (const sp of bridges) {
      const rot = Math.atan2(-sp.dz, sp.dx);
      addBridge(c, mat4(sp.x, sp.deckY, sp.z, rot), sp.halfLen * 2, sp.halfW * 2, sp.deckY - sp.pierBottom);
    }
    for (const m of c.build(this.materials)) this.roadsGroup.add(m);
  }

  private natureClear(x: number, z: number, margin: number) {
    if (landUse.contains(x, z, margin)) return false;
    for (const o of this.obbGrid.query(x, z)) {
      if (containsPoint(o, x, z, margin)) return false;
    }
    return true;
  }

  /** Wayside landmarks and planted avenues follow the finished roads and parcels. */
  private buildRoadside() {
    const c = new Collector();
    const rng = mulberry32(555);
    for (const road of roads) {
      if (road.kind === 'cobble' || road.village) continue; // long roads only
      // milestones roughly every league
      for (let s = 500; s < road.length - 200; s += 500 + rng() * 120) {
        const p = roadPointAt(road, s);
        const side = (Math.floor(s / 500) % 2 === 0 ? 1 : -1) * (road.width / 2 + 1.4);
        const x = p.x - p.tz * side;
        const z = p.z + p.tx * side;
        if (waterDist(x, z) < RIVER_BANK + 2 || !this.natureClear(x, z, 1.5)) continue;
        addMilestone(c, mat4(x, terrainHeight(x, z), z, Math.atan2(p.tx, p.tz)), s / 1000);
      }
      // avenues: staggered trees lining the road
      for (let s = 60; s < road.length - 40; s += 26 + rng() * 30) {
        const p = roadPointAt(road, s);
        const side = (Math.floor(s / 26) % 2 === 0 ? 1 : -1) * (road.width / 2 + range(rng, 3.5, 6.5));
        const x = p.x - p.tz * side;
        const z = p.z + p.tx * side;
        if (waterDist(x, z) < RIVER_BANK + 3 || roadQuery(x, z).d < 3 || !this.natureClear(x, z, 4.5)) continue;
        let near = false;
        for (const v of villages) if (Math.hypot(x - v.x, z - v.z) < v.r + 24) near = true;
        if (near) continue;
        const h = terrainHeight(x, z);
        if (h > 320) continue;
        const conifer = h > 170 || rng() < 0.3;
        this.ctx.trees.push({
          x, z, scale: 0.85 + rng() * 0.4,
          kind: conifer ? 'conifer' : 'round',
          color: new THREE.Color(conifer ? pick(rng, [0x2f5f2a, 0x356b30, 0x3d7336]) : pick(rng, [0x4f8a2e, 0x5c9a36, 0x6aa63c, 0xd98b2b])),
        });
      }
    }
    for (const m of c.build(this.materials)) {
      m.castShadow = true;
      this.roadsGroup.add(m);
    }
  }

  private settlementGroup(id: string) {
    return this.settlements.find((s) => s.v.id === id)?.group ?? this.propsGroup;
  }

  private buildCrops() {
    const byKey = new Map<string, Float32Array[]>();
    for (const b of cropBatch) {
      const key = `${b.village}|${b.kind}`;
      let arr = byKey.get(key);
      if (!arr) byKey.set(key, (arr = []));
      arr.push(b.positions);
    }
    const dummy = new THREE.Object3D();
    for (const [key, arrs] of byKey) {
      const [vid, kindS] = key.split('|');
      const kind = Number(kindS);
      const total = arrs.reduce((a, p) => a + p.length / 3, 0);
      if (!total) continue;
      const mesh = new THREE.InstancedMesh(cropTuftGeometry(kind), this.materials[`tuft${kind}`], total);
      let i = 0;
      for (const p of arrs) {
        for (let k = 0; k < p.length; k += 3) {
          dummy.position.set(p[k], p[k + 1], p[k + 2]);
          dummy.rotation.set(0, (i % 7) * 0.45, 0);
          dummy.scale.set(1, 0.85 + ((i * 37) % 40) / 100, 1);
          dummy.updateMatrix();
          mesh.setMatrixAt(i++, dummy.matrix);
        }
      }
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true;
      this.settlementGroup(vid).add(mesh);
    }
  }

  private buildDynamics() {
    for (const d of this.ctx.dynamics) {
      if (d.kind === 'mill') {
        const g = buildMillSails(this.materials);
        // sails hang in front of the tower's door face (local +z)
        g.position.set(d.x + Math.sin(d.rot) * 4.1 * d.scale, d.y, d.z + Math.cos(d.rot) * 4.1 * d.scale);
        g.rotation.y = d.rot;
        g.scale.setScalar(d.scale);
        this.settlementGroup(d.village).add(g);
        this.mills.push({ obj: g, speed: 0.2 + this.rng() * 0.14 });
      } else {
        const c = new Collector();
        addBoat(c, mat4(0, 0, 0, 0), 0x6b4f30);
        const g = new THREE.Group();
        for (const m of c.build(this.materials)) {
          m.castShadow = true;
          g.add(m);
        }
        g.position.set(d.x, d.y, d.z);
        g.rotation.y = d.rot;
        g.scale.setScalar(d.scale);
        this.settlementGroup(d.village).add(g);
        this.boats.push({ obj: g, baseY: d.y, phase: this.rng() * 6 });
      }
    }
  }

  private collectLamps() {
    this.lampPositions = this.ctx.lamps.filter((l) => l.light).map((l) => l.pos);
  }

  private buildNature() {
    const rng = this.rng;
    const items: ScatterItem[] = [];
    for (const t of this.ctx.trees as TreeSpecOut[]) {
      if (!this.natureClear(t.x, t.z, 0.5) || roadQuery(t.x, t.z).d < 1.5) continue;
      items.push({ x: t.x, z: t.z, y: terrainHeight(t.x, t.z) - 0.15, scale: t.scale, kind: t.kind, color: t.color, rot: rng() * 6.28 });
    }
    // belts of woodland around each settlement
    for (const v of villages) {
      const n = v.id === 'mildvar' ? 1400 : 1000;
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2;
        const R = v.r + Math.sqrt(rng()) * 900;
        const x = v.x + Math.cos(a) * R;
        const z = v.z + Math.sin(a) * R;
        if (Math.abs(x) > WORLD_HALF - 300 || Math.abs(z) > WORLD_HALF - 300) continue;
        if (waterDist(x, z) < RIVER_BANK + 2) continue;
        if (roadQuery(x, z).d < 5 || !this.natureClear(x, z, 4)) continue;
        const density = fbm(x * 0.0016 + 3, z * 0.0016 + 8, 3);
        if (rng() > (density > 0.52 ? 0.72 : 0.17)) continue;
        const kind: ScatterItem['kind'] = rng() < v.theme.treeMix ? 'conifer' : 'round';
        items.push({ x, z, y: terrainHeight(x, z) - 0.15, scale: range(rng, 0.75, 1.5), kind, color: new THREE.Color(pick(rng, v.theme.foliage)), rot: rng() * 6.28 });
      }
    }
    // Woodland grows in stands rather than a uniform random dusting. Farm
    // fields, road shoulders and building plots are cleared before planting.
    for (const v of villages) {
      for (let stand = 0; stand < 13; stand++) {
        const angle = rng() * Math.PI * 2;
        const radius = v.r + 190 + rng() * 600;
        const cx = v.x + Math.cos(angle) * radius;
        const cz = v.z + Math.sin(angle) * radius;
        if (roadQuery(cx, cz).d < 18 || !this.natureClear(cx, cz, 9)) continue;
        const spread = 30 + rng() * 50;
        const count = 36 + Math.floor(rng() * 48);
        for (let j = 0; j < count; j++) {
          const a = rng() * Math.PI * 2;
          const d = Math.sqrt(rng()) * spread;
          const x = cx + Math.cos(a) * d;
          const z = cz + Math.sin(a) * d;
          if (roadQuery(x, z).d < 6 || !this.natureClear(x, z, 4)) continue;
          const q = waterDist(x, z);
          if (q < riverHalfWidth(x, z) + 5) continue;
          const h = terrainHeight(x, z);
          if (h > 360) continue;
          const kind: ScatterItem['kind'] = rng() < v.theme.treeMix ? 'conifer' : 'round';
          items.push({ x, z, y: h - 0.15, scale: range(rng, 0.85, 1.55), kind, color: new THREE.Color(pick(rng, v.theme.foliage)), rot: rng() * Math.PI * 2 });
        }
      }
    }
    // the wilds
    for (let i = 0; i < 20000; i++) {
      const x = (rng() * 2 - 1) * (WORLD_HALF - 400);
      const z = (rng() * 2 - 1) * (WORLD_HALF - 400);
      const forest = fbm(x * 0.00045 + 13, z * 0.00045 + 29, 3);
      const h = terrainHeight(x, z);
      if (h > 380) continue;
      const p = forest > 0.55 ? 0.55 : forest > 0.48 ? 0.14 : 0.03;
      if (rng() > p) continue;
      if (waterDist(x, z) < RIVER_BANK + 2) continue;
      if (roadQuery(x, z).d < 5 || !this.natureClear(x, z, 4)) continue;
      let near = false;
      for (const v of villages) if (Math.hypot(x - v.x, z - v.z) < v.r + 50) near = true;
      if (near) continue;
      const mountain = h > 200;
      const kind: ScatterItem['kind'] = rng() < (mountain ? 0.8 : 0.4) ? 'conifer' : 'round';
      items.push({
        x, z, y: h - 0.15, scale: range(rng, 0.9, 2.0), kind,
        color: new THREE.Color(mountain ? pick(rng, [0x356b30, 0x2f5f2a, 0x3d7336]) : pick(rng, [0x4f8a2e, 0x5c9a36, 0x3f7a2a, 0x6aa63c, 0xd98b2b, 0xc96a24])),
        rot: rng() * 6.28,
      });
    }
    // boulders, scrub
    for (let i = 0; i < 2600; i++) {
      const x = (rng() * 2 - 1) * (WORLD_HALF - 400);
      const z = (rng() * 2 - 1) * (WORLD_HALF - 400);
      if (waterDist(x, z) < RIVER_BANK + 1) continue;
      if (roadQuery(x, z).d < 4 || !this.natureClear(x, z, 2.5)) continue;
      const h = terrainHeight(x, z);
      const rocky = h > 150;
      if (rng() < (rocky ? 0.55 : 0.18)) {
        const s = range(rng, 0.5, rocky ? 3.4 : 1.5);
        items.push({ x, z, y: h - s * 0.25, scale: s, kind: 'rock', color: new THREE.Color(pick(rng, [0x8b877e, 0x7d7a74, 0x9a968c])), rot: rng() * 6.28 });
      } else {
        items.push({ x, z, y: h - 0.1, scale: range(rng, 0.6, 1.4), kind: 'bush', color: new THREE.Color(pick(rng, [0x4a7a34, 0x5b8a3c, 0x6f9a44])), rot: rng() * 6.28 });
      }
    }
    // waterside trees
    for (let i = 0; i < 1400; i++) {
      const chain = Math.floor(rng() * 5);
      const p = getRiverPoint(chain, rng());
      if (!p) continue;
      const side = rng() < 0.5 ? -1 : 1;
      const off = riverHalfWidth(p.x, p.z) + range(rng, 4, 18);
      const x = p.x + p.nx * side * off;
      const z = p.z + p.nz * side * off;
      if (waterDist(x, z) < riverHalfWidth(x, z) + 3) continue;
      if (roadQuery(x, z).d < 4 || !this.natureClear(x, z, 3)) continue;
      const kind: ScatterItem['kind'] = rng() < 0.12 ? 'conifer' : 'round';
      items.push({ x, z, y: terrainHeight(x, z) - 0.15, scale: range(rng, 0.6, 1.2), kind, color: new THREE.Color(pick(rng, [0x6fae3f, 0x5c9a36, 0x86c257, 0x4f8a2e])), rot: rng() * 6.28 });
    }
    this.stats.trees = items.filter((i) => i.kind === 'round' || i.kind === 'conifer').length;
    const set = buildNature(items, this.rng);
    this.natureTiles = set.tiles;
    this.natureFar = set.far;
    this.scene.add(set.group);
    const hedges = createHedges(this.ctx.hedges as HedgeSeg[]);
    const flowers = createFlowers(this.ctx.flowers as FlowerSpec[]);
    hedges.computeBoundingSphere();
    flowers.computeBoundingSphere();
    this.scene.add(hedges);
    this.scene.add(flowers);
  }

  /* --------------------------- life --------------------------- */
  private soldierTemplates = new Map<string, THREE.Group>();
  private villagerTemplates: THREE.Group[] = [];

  /**
   * Geometry-sharing NPC factory: each archetype is built exactly once and
   * every instance is a clone that shares the same GPU vertex buffers.
   */
  private makeSoldier(type: 'guard' | 'archer' | 'officer') {
    const cached = this.soldierTemplates.get(type);
    if (cached) return cached.clone(true);
    const c = new Collector();
    const steel = 0x8a9096;
    const darkIron = 0x42464a;
    const tunic = type === 'officer' ? 0x9e2424 : 0x2f4258;
    const skin = 0xe0b48c;

    // Steel greaves / boots
    c.add('flat', box(0.18, 0.85, 0.18), mat4(0, 0.42, -0.1), darkIron);
    c.add('flat', box(0.18, 0.85, 0.18), mat4(0, 0.42, 0.1), darkIron);

    // Armored Cuirass / Chainmail Torso
    c.add('flat', new THREE.CylinderGeometry(0.24, 0.26, 0.75, 10), mat4(0, 1.22, 0), steel);
    c.add('flat', box(0.44, 0.7, 0.32), mat4(0, 1.22, 0), tunic);

    // Arms with steel vambraces
    c.add('flat', box(0.12, 0.65, 0.12), mat4(0, 1.2, -0.3), steel);
    c.add('flat', box(0.12, 0.65, 0.12), mat4(0, 1.2, 0.3), steel);

    // Head
    c.add('flat', new THREE.SphereGeometry(0.16, 10, 8), mat4(0, 1.74, 0), skin);

    // Conical Iron Helmet
    c.add('flat', new THREE.CylinderGeometry(0.2, 0.22, 0.28, 10), mat4(0, 1.84, 0), steel);
    c.add('flat', new THREE.ConeGeometry(0.23, 0.2, 10), mat4(0, 1.98, 0), steel);

    if (type === 'officer') {
      // Crimson helmet plume & gold standard
      c.add('flat', box(0.08, 0.35, 0.38), mat4(0, 2.08, 0), 0xd12828);
      c.add('flat', box(0.48, 0.08, 0.35), mat4(0, 1.5, 0), 0xd4af37);
    }

    // Equipment: Shield + Spear or Longbow
    if (type === 'guard' || type === 'officer') {
      // Heater Shield
      c.add('flat', box(0.08, 0.85, 0.55), mat4(0.05, 1.2, 0.36, 0.1), tunic);
      c.add('flat', box(0.09, 0.4, 0.12), mat4(0.06, 1.2, 0.36), 0xd4af37);
      // Steel Spear
      c.add('wood', new THREE.CylinderGeometry(0.035, 0.035, 2.6, 6), mat4(0.1, 1.3, -0.32), 0x5a3f28);
      c.add('flat', new THREE.ConeGeometry(0.08, 0.35, 6), mat4(0.1, 2.65, -0.32), steel);
    } else if (type === 'archer') {
      // Longbow on back + quiver
      c.add('wood', new THREE.TorusGeometry(0.7, 0.03, 6, 12, Math.PI), mat4(-0.2, 1.2, 0, Math.PI / 2).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 4)), 0x4a3320);
      // quiver tilted on the back (the old call passed a 0 scale → degenerate geometry)
      c.add('flat', new THREE.CylinderGeometry(0.08, 0.06, 0.7, 8), mat4(-0.15, 1.35, 0.12).multiply(new THREE.Matrix4().makeRotationX(-0.3)), 0x6b4a2e);
    }

    const g = new THREE.Group();
    for (const m of c.build({ flat: this.materials.flat, wood: this.materials.wood })) {
      m.castShadow = true;
      g.add(m);
    }
    this.soldierTemplates.set(type, g);
    return g.clone(true);
  }

  private buildSoldiers(patrols: { x: number; y: number; z: number; rot: number; type: 'guard' | 'archer' | 'officer' }[]) {
    const names = ['Aldric', 'Bryn', 'Cedric', 'Dorin', 'Ewan', 'Falk', 'Garin', 'Halvor', 'Ivar', 'Jorund', 'Kettil', 'Leif'];
    const roles = { guard: 'Garrison Guard', archer: 'Watch Archer', officer: 'Garrison Officer' } as const;
    patrols.forEach((p, idx) => {
      const soldier = this.makeSoldier(p.type);
      soldier.position.set(p.x, p.y, p.z);
      soldier.rotation.y = p.rot;
      this.scene.add(soldier);
      const id = `soldier_${idx}`;
      const faction = p.x < -1000 && p.z < -1000 ? 'Fort Ironspire' : 'Reaches Watch';
      this.soldiers.push({
        obj: soldier, baseRot: p.rot, baseY: p.y, phase: idx * 0.7,
        id, name: `${roles[p.type]} ${names[idx % names.length]}`, role: p.type, faction,
      });
      this.entities.set(id, { id, name: names[idx % names.length], role: roles[p.type], faction, obj: soldier });
    });
  }

  private makeVillager(variant: number) {
    if (!this.villagerTemplates.length) {
      for (let v = 0; v < 8; v++) this.villagerTemplates.push(this.buildVillagerTemplate(mulberry32(9001 + v * 131)));
    }
    return this.villagerTemplates[variant % this.villagerTemplates.length].clone(true);
  }

  private buildVillagerTemplate(rng: RNG) {
    const c = new Collector();
    const skin = pick(rng, [0xf1c9a5, 0xe0b48c, 0xc68e63, 0x8d5a3b]);
    const cloth = pick(rng, [0x8a3b3b, 0x3b5c8a, 0x5a7a3a, 0x8a6a3a, 0x6a4a7a, 0x3a3a3a, 0xb8865a, 0x2f6b6b]);
    const legs = pick(rng, [0x3a3a3a, 0x4a3a2a, 0x5a5a6a, 0x6a4a3a]);
    if (rng() < 0.5) c.add('flat', new THREE.ConeGeometry(0.38, 1.1, 10), mat4(0, 0.55, 0), cloth);
    else {
      c.add('flat', box(0.16, 0.85, 0.16), mat4(0, 0.42, -0.1), legs);
      c.add('flat', box(0.16, 0.85, 0.16), mat4(0, 0.42, 0.1), legs);
    }
    c.add('flat', new THREE.CylinderGeometry(0.2, 0.24, 0.7, 10), mat4(0, 1.2, 0), cloth);
    c.add('flat', new THREE.SphereGeometry(0.16, 10, 8), mat4(0, 1.72, 0), skin);
    c.add('flat', box(0.1, 0.6, 0.1), mat4(0, 1.2, -0.28), cloth);
    c.add('flat', box(0.1, 0.6, 0.1), mat4(0, 1.2, 0.28), cloth);
    const hat = rng();
    if (hat < 0.35) {
      c.add('flat', new THREE.CylinderGeometry(0.28, 0.28, 0.04, 10), mat4(0, 1.84, 0), 0x4a3a2a);
      c.add('flat', new THREE.CylinderGeometry(0.15, 0.17, 0.18, 10), mat4(0, 1.94, 0), 0x4a3a2a);
    } else if (hat < 0.6) {
      c.add('flat', new THREE.SphereGeometry(0.17, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat4(0, 1.74, 0), pick(rng, [0xf5f0e6, 0xd94a3d, 0x3b5c8a]));
    } else {
      c.add('flat', new THREE.SphereGeometry(0.165, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat4(0, 1.73, 0), pick(rng, [0x3a2a1a, 0x7a5a3a, 0xd9b36a, 0x1a1a1a]));
    }
    const g = new THREE.Group();
    for (const m of c.build({ flat: this.materials.flat })) {
      m.castShadow = true;
      g.add(m);
    }
    return g;
  }

  private buildVillagers() {
    const rng = this.rng;
    for (const v of villages) {
      // every road segment inside the settlement becomes a walking route
      const routes: THREE.Curve<THREE.Vector3>[] = [];
      for (const r of roads) {
        const pts = r.samples.filter((s, i) => i % 3 === 0 && Math.hypot(s.x - v.x, s.z - v.z) < v.r * 1.7);
        if (pts.length >= 4) routes.push(new THREE.CatmullRomCurve3(pts.map((s) => new THREE.Vector3(s.x, 0, s.z)), false, 'centripetal', 0.5));
      }
      const loops: THREE.Curve<THREE.Vector3>[] = [];
      for (const R of [plazaRadius(v) * 0.5, plazaRadius(v) * 0.78]) {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          pts.push(new THREE.Vector3(v.x + Math.cos(a) * R, 0, v.z + Math.sin(a) * R * 0.88));
        }
        loops.push(new THREE.CatmullRomCurve3(pts, true, 'centripetal'));
      }
      const count = v.id === 'mildvar' ? 24 : 14;
      for (let i = 0; i < count; i++) {
        const variant = Math.floor(rng() * 8);
        const obj = this.makeVillager(variant);
        obj.visible = false;
        this.scene.add(obj);
        let curve: THREE.Curve<THREE.Vector3>;
        let closed = false;
        if (i < 7 || !routes.length) {
          curve = loops[i % loops.length];
          closed = true;
        } else {
          curve = routes[Math.floor(rng() * routes.length)];
        }
        const id = `villager_${v.id}_${i}`;
        this.walkers.push({
          id, obj, curve, len: curve.getLength(), t: rng(), speed: range(rng, 0.85, 1.5), dir: rng() < 0.5 ? -1 : 1,
          offset: range(rng, -1.4, 1.4), phase: rng() * 10, closed, home: v,
        });
        this.entities.set(id, { id, name: `Citizen of ${v.name}`, role: 'villager', faction: v.name, obj });
      }
    }
    this.stats.villagers = this.walkers.length;
  }

  private makeCarriageTemplate() {
    const c = new Collector();
    const brown = 0x6b4a2e;
    // horse, facing +x
    c.add('flat', box(1.5, 0.7, 0.6), mat4(1.6, 1.15, 0), brown);
    c.add('flat', box(0.5, 0.8, 0.4), mat4(2.4, 1.6, 0).multiply(new THREE.Matrix4().makeRotationZ(-0.6)), brown);
    c.add('flat', box(0.6, 0.35, 0.35), mat4(2.85, 1.95, 0), brown);
    c.add('flat', box(0.12, 0.2, 0.08), mat4(2.65, 2.2, 0.12), 0x3a2a1a);
    c.add('flat', box(0.12, 0.2, 0.08), mat4(2.65, 2.2, -0.12), 0x3a2a1a);
    for (const lx of [1.05, 2.15]) for (const lz of [-0.2, 0.2]) c.add('flat', box(0.16, 0.85, 0.16), mat4(lx, 0.42, lz), 0x4a3320);
    // cart
    c.add('wood', box(2.6, 0.12, 1.6), mat4(-1.0, 0.95, 0), 0x9a7a4a);
    c.add('wood', box(2.6, 0.55, 0.08), mat4(-1.0, 1.25, 0.78), 0x9a7a4a);
    c.add('wood', box(2.6, 0.55, 0.08), mat4(-1.0, 1.25, -0.78), 0x9a7a4a);
    c.add('wood', box(0.08, 0.55, 1.6), mat4(-2.3, 1.25, 0), 0x9a7a4a);
    c.add('wood', box(1.6, 0.08, 0.08), mat4(0.9, 0.95, 0.4), 0x7a5a3a);
    c.add('wood', box(1.6, 0.08, 0.08), mat4(0.9, 0.95, -0.4), 0x7a5a3a);
    for (let k = 0; k < 7; k++) c.add('flat', new THREE.SphereGeometry(0.4, 8, 6), mat4(-1.9 + (k % 4) * 0.62, 1.32, k < 4 ? -0.32 : 0.32), k % 3 === 0 ? 0xcba64f : 0xd9b35a);
    // driver
    c.add('flat', box(0.42, 0.55, 0.45), mat4(0.1, 1.35, 0), 0x3b5c8a);
    c.add('flat', new THREE.SphereGeometry(0.16, 10, 8), mat4(0.1, 1.78, 0), 0xe0b48c);
    c.add('flat', new THREE.CylinderGeometry(0.26, 0.26, 0.04, 10), mat4(0.1, 1.9, 0), 0x6a4a2a);
    const g = new THREE.Group();
    for (const m of c.build({ flat: this.materials.flat, wood: this.materials.wood })) {
      m.castShadow = true;
      g.add(m);
    }
    for (const z of [-0.9, 0.9]) {
      const wc = new Collector();
      const rim = new THREE.CylinderGeometry(0.68, 0.68, 0.12, 12);
      rim.rotateX(Math.PI / 2);
      wc.add('flat', rim, undefined, 0x5a3a22);
      for (let k = 0; k < 4; k++) wc.add('flat', box(1.26, 0.07, 0.05), new THREE.Matrix4().makeRotationZ((k / 4) * Math.PI), 0x8a6a42);
      const wm = wc.build({ flat: this.materials.flat })[0];
      wm.name = 'wheel';
      wm.position.set(-1.0, 0.68, z);
      wm.castShadow = true;
      g.add(wm);
    }
    return g;
  }

  private buildCarriages() {
    const rng = this.rng;
    const template = this.makeCarriageTemplate();
    // Short farm access tracks are for delivery, not through traffic.
    const routes = roads.filter((r) => r.kind !== 'cobble' && !r.village?.startsWith('farm:') && r.length > 160);
    for (const road of routes) {
      const n = !road.village && road.kind === 'dirt' ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const g = template.clone();
        const wheels = g.children.filter((ch) => ch.name === 'wheel');
        this.scene.add(g);
        this.carriages.push({ group: g, road, s: range(rng, 0.1, 0.9) * road.length, dir: rng() < 0.5 ? -1 : 1, speed: 3.0 + rng() * 1.2, wheels });
      }
    }
  }

  private buildDucks() {
    const rng = this.rng;
    const c = new Collector();
    c.add('flat', new THREE.SphereGeometry(0.3, 8, 6), mat4(0, 0.1, 0, 0, 1.3, 0.8, 1), 0xf5f0e6);
    c.add('flat', new THREE.SphereGeometry(0.15, 8, 6), mat4(0.3, 0.42, 0), 0xf5f0e6);
    c.add('flat', box(0.18, 0.06, 0.1), mat4(0.48, 0.4, 0), 0xf2a33a);
    const template = c.build({ flat: this.materials.flat })[0];
    for (let i = 0; i < 24; i++) {
      const g = new THREE.Mesh(template.geometry, template.material);
      this.scene.add(g);
      this.ducks.push({ obj: g, chain: Math.floor(rng() * 5), t: range(rng, 0.05, 0.95), speed: range(rng, 0.0025, 0.006) * (rng() < 0.5 ? -1 : 1), off: range(rng, -3, 3) });
    }
  }

  /* --------------------------- queries --------------------------- */
  private spanAt(x: number, z: number, list: BridgeSpan[]) {
    for (const sp of list) {
      const dx = x - sp.x;
      const dz = z - sp.z;
      if (Math.abs(dx * sp.dx + dz * sp.dz) < sp.halfLen + 1 && Math.abs(-dx * sp.dz + dz * sp.dx) < sp.halfW) return sp;
    }
    return null;
  }

  onSpan(x: number, z: number) {
    return this.spanAt(x, z, bridges) ?? this.spanAt(x, z, platforms);
  }

  groundHeight(x: number, z: number) {
    // Pocket interiors have their own flat floor, far from the terrain.
    const iy = this.interactions?.interiorGroundHeight(x, z);
    if (iy !== null && iy !== undefined) return iy;
    const bridge = this.spanAt(x, z, bridges);
    if (bridge) return bridge.deckY + 0.22;
    const platform = this.spanAt(x, z, platforms);
    if (platform) return platform.deckY + 0.12;
    const ns = this.nearestSettlement(x, z);
    const v = villages.find((item) => item.id === ns.v.id);
    if (v) {
      const pr = plazaRadius(v) + 3.5;
      if (Math.hypot((x - v.x) / pr, (z - v.z) / (pr * 0.86 + 0.5)) < 1) {
        return terrainHeight(v.x, v.z) + 0.22;
      }
    }
    const rq = roadQuery(x, z);
    if (rq.road && rq.d < 0.5) return Math.max(rq.y + 0.22, terrainHeight(x, z) + 0.18);
    const parcel = landUse.at(x, z);
    if (parcel?.kind === 'field') return terrainHeight(x, z) + 0.2;
    if (parcel?.kind === 'homestead') return terrainHeight(x, z) + 0.17;
    return terrainHeight(x, z) + 0.08;
  }

  isWalkable(x: number, z: number) {
    if (this.interactions?.interiorGroundHeight(x, z) !== null) return true;
    if (Math.abs(x) > WORLD_HALF - 200 || Math.abs(z) > WORLD_HALF - 200) return false;
    if (this.onSpan(x, z)) return true;
    return waterDist(x, z) > riverHalfWidth(x, z) + 0.8;
  }

  resolveCollision(pos: THREE.Vector3, radius: number) {
    if (this.interactions?.resolveInteriorCollision(pos, radius)) return;
    for (const o of this.obbGrid.query(pos.x, pos.z)) {
      const dx = pos.x - o.cx;
      const dz = pos.z - o.cz;
      const maxR = o.hw + o.hd + radius + 1;
      if (Math.abs(dx) > maxR || Math.abs(dz) > maxR) continue;
      const c = Math.cos(o.rot);
      const s = Math.sin(o.rot);
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      const px = o.hw + radius - Math.abs(lx);
      const pz = o.hd + radius - Math.abs(lz);
      if (px > 0 && pz > 0) {
        let nlx = lx;
        let nlz = lz;
        if (px < pz) nlx = Math.sign(lx || 1) * (o.hw + radius);
        else nlz = Math.sign(lz || 1) * (o.hd + radius);
        pos.x = o.cx + nlx * c + nlz * s;
        pos.z = o.cz - nlx * s + nlz * c;
      }
    }
  }

  nearestSettlement(x: number, z: number): { v: SettlementSpec; d: number } {
    let bv: SettlementSpec = ALL_LOCATIONS[0];
    let bd = Infinity;
    for (const loc of ALL_LOCATIONS) {
      const d = Math.hypot(x - loc.x, z - loc.z);
      if (d < bd) {
        bd = d;
        bv = loc;
      }
    }
    return { v: bv, d: bd };
  }

  /** Spawn point for any settlement, military fort, or wilderness landmark. */
  travelTarget(id: string) {
    const loc = ALL_LOCATIONS.find((x) => x.id === id);
    if (!loc) return null;
    if (loc.type === 'garrison') {
      const x = FORT.x + 50;
      const z = FORT.z;
      return { x, z, y: this.groundHeight(x, z) + 1.7, yaw: -Math.PI / 2, v: loc };
    } else if (loc.type === 'lake') {
      const x = LAKE.x + 40;
      const z = LAKE.z + LAKE.r + 6;
      return { x, z, y: this.groundHeight(x, z) + 1.7, yaw: Math.PI * 0.9, v: loc };
    } else if (loc.type === 'forest') {
      const x = loc.x + 15;
      const z = loc.z + 20;
      return { x, z, y: this.groundHeight(x, z) + 1.7, yaw: 0.5, v: loc };
    } else if (loc.type === 'plains') {
      const x = loc.x + 10;
      const z = loc.z + 20;
      return { x, z, y: this.groundHeight(x, z) + 1.7, yaw: 0.8, v: loc };
    } else if (loc.type === 'watchtower') {
      const wy = this.groundHeight(loc.x + 8, loc.z + 8);
      return { x: loc.x + 8, z: loc.z + 8, y: wy + 1.7, yaw: 0, v: loc };
    }
    const z = loc.z + plazaRadius(loc as VillageDef) - 3;
    return { x: loc.x, z, y: this.groundHeight(loc.x, z) + 1.7, yaw: 0, v: loc };
  }

  onDiscovery(cb: (name: string) => void) {
    this.discoveryCb = cb;
  }

  /* --------------------------- time of day --------------------------- */
  setTimeOfDay(hour: number) {
    this.hour = hour;
    const f = clamp((hour - 4.5) / 17, 0, 1);
    const az = f * Math.PI;
    const elev = Math.sin(f * Math.PI) * THREE.MathUtils.degToRad(58);
    this.sunDir.set(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.cos(elev) * 0.42).normalize();
    const e = THREE.MathUtils.radToDeg(Math.asin(this.sunDir.y));
    const night = 1 - smoothstep(-8, 0.5, e);
    const day = smoothstep(5, 30, e);
    const sunset = clamp(1 - night - day, 0, 1);
    const moonDir = new THREE.Vector3(-Math.cos(az) * 0.7, 0.62, -0.5).normalize();
    this.lightDir.copy(this.sunDir).lerp(moonDir, smoothstep(0, -6, e)).normalize();
    this.skyMat.uniforms.moonDir.value.copy(moonDir);

    const mix3 = (n: number, s: number, d: number) => new THREE.Color(n).multiplyScalar(night).add(new THREE.Color(s).multiplyScalar(sunset)).add(new THREE.Color(d).multiplyScalar(day));
    this.skyMat.uniforms.topColor.value.copy(mix3(0x070b1f, 0x4b5fb0, 0x3f82dd));
    this.skyMat.uniforms.horizonColor.value.copy(mix3(0x141a33, 0xffb16e, 0xd6ebff));
    this.skyMat.uniforms.sunColor.value.copy(mix3(0x223355, 0xffa050, 0xfff1d8));
    this.skyMat.uniforms.sunDir.value.copy(this.sunDir);
    this.skyMat.uniforms.nightness.value = night;

    const fog = this.skyMat.uniforms.horizonColor.value.clone().lerp(new THREE.Color(0xffffff), day * 0.15);
    (this.scene.fog as THREE.FogExp2).color.copy(fog);
    (this.scene.fog as THREE.FogExp2).density = lerp(0.00022, 0.00015, day);

    this.sun.color.copy(mix3(0x7f8fd0, 0xffa052, 0xfff3de));
    this.sun.intensity = smoothstep(-6, 8, e) * 3.1 + night * 0.4;
    this.hemi.color.copy(mix3(0x1a2448, 0x6b6ab0, 0xb9d6ff));
    this.hemi.groundColor.copy(mix3(0x0a0a12, 0x6b4a30, 0x8f7c55));
    this.hemi.intensity = 0.22 + day * 0.5 + sunset * 0.4;
    this.ambient.intensity = 0.06 + night * 0.1;

    const glow = night * 1.7 + sunset * 0.5;
    (this.materials.glass as THREE.MeshStandardMaterial).emissiveIntensity = glow;
    (this.materials.glassChurch as THREE.MeshStandardMaterial).emissiveIntensity = glow * 0.8;
    (this.materials.lampglass as THREE.MeshStandardMaterial).emissiveIntensity = 0.2 + glow * 2.4;
    this.lampIntensity = (night + sunset * 0.5) * 50;
    (this.clouds.material as THREE.MeshStandardMaterial).color.copy(mix3(0x1a2033, 0xffc9a0, 0xffffff));
  }

  /**
   * Per-layer submission cost for the F3 overlay. Counts only what the camera
   * would actually submit: visible meshes whose bounding sphere is in frustum.
   */
  debugLayers(camera: THREE.Camera): { name: string; calls: number; tris: number }[] {
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const sphere = new THREE.Sphere();
    const count = (name: string, roots: THREE.Object3D[]) => {
      let calls = 0;
      let tris = 0;
      for (const root of roots) {
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh || !m.visible) return;
          let vis = true;
          for (let p: THREE.Object3D | null = m; p && vis; p = p.parent) if (!p.visible) vis = false;
          if (!vis) return;
          const g = m.geometry as THREE.BufferGeometry;
          if (m.frustumCulled) {
            if (!g.boundingSphere) g.computeBoundingSphere();
            sphere.copy(g.boundingSphere!).applyMatrix4(m.matrixWorld);
            if (!frustum.intersectsSphere(sphere)) return;
          }
          const tri = g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
          const n = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
          calls += 1;
          tris += tri * n;
        });
      }
      return { name, calls, tris };
    };
    const natureRoots: THREE.Object3D[] = this.natureTiles.filter((t) => t.lod === 0).map((t) => t.near);
    if (this.natureFar) natureRoots.push(...this.natureFar.meshes);
    return [
      count('settlements', this.settlements.map((s) => s.group)),
      count('wilderness', this.wilderness.map((w) => w.group)),
      count('roads', [this.roadsGroup]),
      count('nature', natureRoots),
      count('props', [this.propsGroup]),
    ].filter((l) => l.calls > 0);
  }

  /** Shadow cascades are capped: past ~160 m the extra casters cost more than
   *  the shadow is worth, and distant people/props use blob shadows. */
  updateSunShadow(center: THREE.Vector3, radius: number) {
    radius = Math.min(radius, 160);
    this.sun.position.copy(center).addScaledVector(this.lightDir, 320);
    this.sun.target.position.copy(center);
    const cam = this.sun.shadow.camera;
    if (cam.left !== -radius) {
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.updateProjectionMatrix();
    }
  }

  private updateLights(cam: THREE.Vector3) {
    if (this.lampIntensity < 0.01) {
      for (const pl of this.lightPool) pl.intensity = 0;
      return;
    }
    const near = this.lampPositions
      .map((p) => ({ p, d: (p.x - cam.x) * (p.x - cam.x) + (p.z - cam.z) * (p.z - cam.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, LIGHT_POOL);
    this.lightPool.forEach((pl, i) => {
      const n = near[i];
      if (n && n.d < 260 * 260) {
        pl.position.copy(n.p);
        pl.intensity = this.lampIntensity;
      } else pl.intensity = 0;
    });
  }

  /* --------------------------- per-frame --------------------------- */
  update(dt: number, camera: THREE.Camera) {
    this.time += dt;
    const cam = camera.position;
    this.sky.position.copy(cam);
    const wm = (this.water.children[0] as THREE.Mesh)?.material as THREE.MeshStandardMaterial;
    if (wm?.normalMap) {
      wm.normalMap.offset.x += dt * 0.01;
      wm.normalMap.offset.y += dt * 0.005;
    }
    // clouds are a camera-relative sky layer
    this.cloudTarget.set(cam.x, 140, cam.z);
    this.clouds.position.lerp(this.cloudTarget, 1 - Math.exp(-dt * 0.8));
    this.clouds.rotation.y += dt * 0.0022;

    // 💧 water physics (flotsam along the real river curves, ripple rings)
    this.waterPhysics.update(dt, cam, this.waterApi);

    // the player wading at the water's edge pushes out ripples
    if (this.waterPhysics.enabled) {
      const wq = waterQuery(cam.x, cam.z);
      if (wq.d < wq.half + 1.6 && Math.abs(cam.y - wq.y) < 3 && this.rng() < 0.2) {
        this.waterPhysics.emitRipple(cam.x, wq.y, cam.z, 3.6, 2.2);
      }
    }

    // Soldier animations (Watchmen, guards, archers)
    for (const s of this.soldiers) {
      s.obj.rotation.y = s.baseRot + Math.sin(this.time * 0.8 + s.phase) * 0.12;
      // absolute, not +=: the old version accumulated a slow vertical drift
      s.obj.position.y = s.baseY + Math.sin(this.time * 2.8 + s.phase) * 0.012;
    }

    const tan = new THREE.Vector3();
    const rawPos = new THREE.Vector3();
    for (const w of this.walkers) {
      const far = Math.abs(w.home.x - cam.x) > 700 || Math.abs(w.home.z - cam.z) > 700;
      w.obj.visible = !far;
      if (far) continue;
      w.t += (w.dir * w.speed * dt) / w.len;
      if (w.closed) w.t = ((w.t % 1) + 1) % 1;
      else if (w.t > 1 || w.t < 0) {
        w.t = clamp(w.t, 0, 1);
        w.dir *= -1;
      }
      const tt = clamp(w.t, 0, 1);
      const p = w.curve.getPointAt(tt);
      w.curve.getTangentAt(tt, tan);
      const x = p.x - tan.z * w.offset;
      const z = p.z + tan.x * w.offset;

      // 🛡️ Strict NPC collision rule: NPCs never step into buildings or off-road roofs
      rawPos.set(x, this.groundHeight(x, z), z);
      this.resolveCollision(rawPos, 0.45);
      rawPos.y = this.groundHeight(rawPos.x, rawPos.z);
      w.obj.position.copy(rawPos);
      w.obj.rotation.y = Math.atan2(-tan.z * w.dir, tan.x * w.dir);
      w.obj.rotation.z = Math.sin(this.time * 9 + w.phase) * 0.03;
    }

    for (const car of this.carriages) {
      car.s += car.dir * car.speed * dt;
      if (car.s > car.road.length - 14) car.dir = -1;
      if (car.s < 14) car.dir = 1;
      const p = roadPointAt(car.road, car.s);
      const p2 = roadPointAt(car.road, clamp(car.s + car.dir * 3, 0, car.road.length));
      car.group.position.set(p.x, p.y + 0.12, p.z);
      // model faces +x: yaw θ maps +x to (cos θ, −sin θ)
      const target = Math.atan2(-(p2.z - p.z), p2.x - p.x);
      let d = target - car.group.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      car.group.rotation.y += d * Math.min(1, dt * 3);
      for (const w of car.wheels) w.rotation.z -= dt * car.speed * 1.5;
      car.group.visible = Math.abs(p.x - cam.x) < 1500 && Math.abs(p.z - cam.z) < 1500;
    }

    for (const m of this.mills) m.obj.rotation.z += dt * m.speed;
    for (const b of this.boats) {
      b.obj.position.y = b.baseY + Math.sin(this.time * 0.9 + b.phase) * 0.12;
      b.obj.rotation.z = Math.sin(this.time * 0.7 + b.phase) * 0.04;
      b.obj.rotation.x = Math.cos(this.time * 0.6 + b.phase) * 0.03;
    }
    for (const d of this.ducks) {
      d.t += d.speed * dt * 20;
      if (d.t > 0.97 || d.t < 0.03) d.speed *= -1;
      const p = getRiverPoint(d.chain, clamp(d.t, 0.01, 0.99));
      if (!p) continue;
      const x = p.x + p.nx * d.off;
      const z = p.z + p.nz * d.off;
      const far = Math.abs(x - cam.x) > 500 || Math.abs(z - cam.z) > 500;
      d.obj.visible = !far;
      if (far) continue;
      d.obj.position.set(x, waterSurfaceY(x, z) + 0.05, z);
      d.obj.rotation.y = Math.atan2(-p.nz * Math.sign(d.speed), p.nx * Math.sign(d.speed));
      if (this.waterPhysics.enabled && this.rng() < 0.12) {
        this.waterPhysics.emitRipple(x, waterSurfaceY(x, z), z, 2.0, 1.4);
      }
    }

    this.birds.update(this.time, cam, (x, z) => Math.max(terrainHeight(x, z), 0));

    // Interaction registry: O(1) spatial hash + view cone, no raycasts.
    this.interactions.update(camera);

    // ---- distance culling & shadow-caster gating (GPU budget) ----
    const vs = this.viewScale;
    for (const w of this.wilderness) {
      const d = Math.hypot(cam.x - w.cx, cam.z - w.cz) - w.radius;
      w.group.visible = d < 2700 * vs;
      const sh = d < 1100;
      if (sh !== w.shadow) {
        w.shadow = sh;
        for (const m of w.meshes) m.castShadow = sh;
      }
    }
    for (const s of this.settlements) {
      const d = Math.hypot(cam.x - s.v.x, cam.z - s.v.z) - s.radius;
      // landmarks of the realm stay visible across the whole map; only shadows gate
      s.group.visible = d < 9000 * vs;
      const sh = d < 1300;
      if (sh !== s.shadow) {
        s.shadow = sh;
        for (const m of s.meshes) m.castShadow = sh;
      }
    }
    // LOD with hysteresis: a camera hovering on a threshold used to flip the
    // whole tile every frame. The margin only has to absorb sub-tile movement.
    const nearR = 2400 * vs;
    const farR = 9500 * vs;
    const HYST = 1.08;
    let nearSetChanged = false;
    const nearKeys = this.nearKeys;
    const TILE = 1200;
    for (const t of this.natureTiles) {
      const d = Math.hypot(cam.x - t.cx, cam.z - t.cz);
      const inA = t.lod === 0 ? nearR * HYST : nearR / HYST;
      const inB = t.lod <= 1 ? farR * HYST : farR / HYST;
      const lod: 0 | 1 | 2 = d < inA ? 0 : d < inB ? 1 : 2;
      if (lod !== t.lod) t.lod = lod;
      const nearVisible = lod === 0;
      if (t.near.visible !== nearVisible) t.near.visible = nearVisible;
      const key = `${Math.round(t.cx / TILE)},${Math.round(t.cz / TILE)}`;
      if (nearVisible) {
        if (!nearKeys.has(key)) { nearKeys.add(key); nearSetChanged = true; }
      } else if (nearKeys.has(key)) {
        nearKeys.delete(key);
        nearSetChanged = true;
      }
      const sh = d < 1500;
      if (sh !== t.shadow) {
        t.shadow = sh;
        for (const m of t.casters) m.castShadow = sh;
      }
    }
    // The far batch is the complement of the near bubble, so it is rebuilt only
    // when a tile crosses in or out — a few times a minute, not every frame.
    if (nearSetChanged) {
      this.natureFar?.update((x, z) => nearKeys.has(`${Math.round(x / TILE)},${Math.round(z / TILE)}`));
    }
    this.updateLights(cam);

    const near = this.nearestSettlement(cam.x, cam.z);
    if (near.d < 300 && !this.discovered.has(near.v.id)) {
      this.discovered.add(near.v.id);
      this.discoveryCb?.(near.v.name);
    }
  }

  dispose() {
    this.waterPhysics.dispose();
    this.scene.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const m of Object.values(this.materials)) m.dispose();
    for (const t of Object.values(this.textures)) {
      if (Array.isArray(t)) t.forEach((x) => x.dispose());
      else (t as THREE.Texture).dispose();
    }
  }
}
