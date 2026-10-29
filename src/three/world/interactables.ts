import * as THREE from 'three';
import { Collector, box, mat4 } from '../geometry';
import { SpatialGrid } from './land';

/* ==================================================================
 *  A data-driven interaction layer that sits beside the procedural
 *  world instead of inside it.
 *
 *  Why no raycasting: village buildings are merged into one
 *  BufferGeometry per material, so a Raycaster hit cannot tell you
 *  *which* house, shrine or door the player is looking at. Instead
 *  every door / NPC / noticeboard is registered with a position and a
 *  radius during generation, and an O(1) spatial-hash + view-cone test
 *  runs each frame.
 *
 *  Pocket interiors live in an isolated pocket at (POCKET_X, POCKET_Y)
 *  so they can never intersect terrain, streamed chunks, shadows or
 *  the far mesh. They are only rendered while the player is inside.
 * ================================================================== */

export type InteriorKind = 'cathedral' | 'longhouse' | 'keep' | 'tavern' | 'cottage';
export type InteractKind = 'enter_interior' | 'exit_interior' | 'npc' | 'shrine' | 'noticeboard';
export type QuestStatus = 'available' | 'active' | 'completed';

export interface Interactable {
  id: string;
  kind: InteractKind;
  /** Short name shown above the key prompt, e.g. "Cathedral of St. Alder". */
  title: string;
  /** Verb line, e.g. "Enter the cathedral". */
  prompt: string;
  pos: THREE.Vector3;
  radius: number;
  /** Optional bespoke text; otherwise the kind's default is used. */
  lines?: string[];
  interior?: InteriorKind;
  npcId?: string;
  returnDoor?: { x: number; y: number; z: number; yaw: number; label: string };
}

export interface QuestStep {
  id: string;
  description: string;
  /** Matches a registered npcId, shrine id or noticeboard id. */
  targetId: string;
  dialogue: string[];
  completed: boolean;
}

export interface Quest {
  id: string;
  title: string;
  giver: string;
  village: string;
  status: QuestStatus;
  stepIndex: number;
  steps: QuestStep[];
  rewardText: string;
}

export interface DialogueEvent {
  speaker: string;
  title: string;
  lines: string[];
  questUpdate?: string;
}

export interface DoorSpec {
  id: string;
  title: string;
  /** World transform of the building the door belongs to (same as its mat4). */
  x: number;
  y: number;
  z: number;
  rot: number;
  /** Door position in the building's local space (+z is the front face). */
  doorX?: number;
  doorZ: number;
  interior: InteriorKind;
  prompt?: string;
}

interface InteriorCell {
  kind: InteriorKind;
  origin: THREE.Vector3;
  spawn: THREE.Vector3;
  floorY: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  obbs: { cx: number; cz: number; hw: number; hd: number }[];
}

const POCKET_X = 12000;
const POCKET_Y = -220;
const POCKET_GAP = 170;
const EYE = 1.7;

/** Door frames, walls and hearths must be visible from inside a room. */
function interiorMaterials(src: Record<string, THREE.Material>): Record<string, THREE.Material> {
  const out: Record<string, THREE.Material> = {};
  for (const key of ['stone', 'plaster', 'wood', 'flat', 'cobble', 'thatch', 'rock', 'slate', 'tiles']) {
    const base = src[key] as THREE.MeshStandardMaterial | undefined;
    if (!base) continue;
    const m = base.clone();
    m.side = THREE.DoubleSide;
    // The sun is still in the scene while indoors; dimming the albedo keeps
    // the room from looking like an open-air courtyard, while the warm
    // interior point light does the actual lighting.
    m.color.multiplyScalar(0.6);
    out[key] = m;
  }
  return out;
}

export class InteractionSystem {
  group = new THREE.Group();
  grid = new SpatialGrid<Interactable>(32);
  all: Interactable[] = [];
  cells = new Map<InteriorKind, InteriorCell>();
  light: THREE.PointLight;

  activeTarget: Interactable | null = null;
  currentInterior: InteriorKind | null = null;
  returnState: { x: number; y: number; z: number; yaw: number; label: string } | null = null;

  quests: Quest[] = [];
  onTargetChange?: (target: Interactable | null) => void;
  onDialogue?: (d: DialogueEvent | null) => void;
  onQuestChange?: (quests: Quest[]) => void;
  onInteriorChange?: (kind: InteriorKind | null) => void;

  private camDir = new THREE.Vector3();
  private toTarget = new THREE.Vector3();

  constructor(materials: Record<string, THREE.Material>) {
    this.group.name = 'pocketInteriors';
    this.group.visible = false;
    // The light lives OUTSIDE the pocket group on purpose: adding/removing a
    // light from the scene changes the shader light count, which recompiles
    // every material in the realm. It is mounted once with intensity 0.
    this.light = new THREE.PointLight(0xffb86c, 0, 34, 1.4);
    this.light.visible = true;
    this.buildInteriors(interiorMaterials(materials));
    this.initQuests();
  }

  /** Mount the interior light into the scene graph (kept out of the pocket group). */
  mount(scene: THREE.Scene) {
    scene.add(this.light);
    this.light.position.set(POCKET_X, POCKET_Y + 3.4, 0);
  }

  /* ---------------------------- registration ---------------------------- */

  register(item: Interactable) {
    this.all.push(item);
    this.grid.insert(item.pos.x, item.pos.z, item.radius + 2, item);
  }

  /**
   * Register a door from the same matrix the building was placed with, so the
   * trigger can never drift away from the painted door.
   */
  registerDoor(spec: DoorSpec) {
    const doorX = spec.doorX ?? 0;
    const c = Math.cos(spec.rot);
    const s = Math.sin(spec.rot);
    const toWorld = (lx: number, lz: number) => ({ x: spec.x + lx * c + lz * s, z: spec.z - lx * s + lz * c });
    const door = toWorld(doorX, spec.doorZ);
    const out = toWorld(doorX, spec.doorZ + 2.6);
    this.register({
      id: spec.id,
      kind: 'enter_interior',
      title: spec.title,
      prompt: spec.prompt ?? `Enter ${spec.title}`,
      pos: new THREE.Vector3(door.x, spec.y + 1.4, door.z),
      radius: 2.9,
      interior: spec.interior,
      returnDoor: { x: out.x, y: spec.y + EYE, z: out.z, yaw: spec.rot + Math.PI, label: spec.title },
    });
  }

  /* ------------------------------ queries ------------------------------- */

  isInsidePocket(x: number, z: number) {
    return x > POCKET_X - 600 && Math.abs(z) < 200;
  }

  interiorGroundHeight(x: number, z: number): number | null {
    if (!this.currentInterior) return null;
    const cell = this.cells.get(this.currentInterior);
    if (!cell) return null;
    const b = cell.bounds;
    if (x < b.minX - 2 || x > b.maxX + 2 || z < b.minZ - 2 || z > b.maxZ + 2) return null;
    return cell.floorY;
  }

  /** Returns true when the position was inside an interior and has been resolved. */
  resolveInteriorCollision(pos: THREE.Vector3, radius: number): boolean {
    if (!this.currentInterior) return false;
    const cell = this.cells.get(this.currentInterior);
    if (!cell) return false;
    const b = cell.bounds;
    pos.x = Math.min(b.maxX, Math.max(b.minX, pos.x));
    pos.z = Math.min(b.maxZ, Math.max(b.minZ, pos.z));
    for (const o of cell.obbs) {
      const dx = pos.x - o.cx;
      const dz = pos.z - o.cz;
      const px = o.hw + radius - Math.abs(dx);
      const pz = o.hd + radius - Math.abs(dz);
      if (px > 0 && pz > 0) {
        if (px < pz) pos.x = o.cx + Math.sign(dx || 1) * (o.hw + radius);
        else pos.z = o.cz + Math.sign(dz || 1) * (o.hd + radius);
      }
    }
    return true;
  }

  /* ------------------------------ per frame ----------------------------- */

  /** O(1) spatial hash + view-cone test; no scene raycast at all. */
  update(cam: THREE.Camera) {
    const p = cam.position;
    cam.getWorldDirection(this.camDir);

    let best: Interactable | null = null;
    let bestScore = Infinity;
    const nearby = this.grid.query(p.x, p.z);
    for (let i = 0; i < nearby.length; i++) {
      const it = nearby[i];
      if (Math.abs(it.pos.y - p.y) > 3.4) continue;
      const dx = it.pos.x - p.x;
      const dz = it.pos.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > it.radius) continue;
      this.toTarget.set(dx, it.pos.y - p.y, dz).normalize();
      const dot = this.camDir.dot(this.toTarget);
      if (dot < 0.35 && dist > 1.1) continue;
      const score = dist * (2 - dot);
      if (score < bestScore) {
        bestScore = score;
        best = it;
      }
    }

    if (best?.id !== this.activeTarget?.id) {
      this.activeTarget = best;
      this.onTargetChange?.(best);
    }
  }

  /* ------------------------------ actions ------------------------------- */

  interact(teleport: (x: number, z: number, y: number, yaw: number) => void) {
    const t = this.activeTarget;
    if (!t) return;

    if (t.kind === 'enter_interior' && t.interior && t.returnDoor) {
      const cell = this.cells.get(t.interior);
      if (!cell) return;
      this.returnState = t.returnDoor;
      this.currentInterior = t.interior;
      this.placeLight(cell);
      this.group.visible = true;
      teleport(cell.spawn.x, cell.spawn.z, cell.spawn.y, 0);
      this.onInteriorChange?.(t.interior);
      this.clearTarget();
      return;
    }

    if (t.kind === 'exit_interior' && this.returnState) {
      const r = this.returnState;
      // Teleport while still flagged as "inside" so the terrain prewarm is
      // skipped: those chunks are already resident from the way in.
      teleport(r.x, r.z, r.y, r.yaw);
      this.leaveInterior();
      return;
    }

    if (t.kind === 'npc' && t.npcId) {
      this.handleNpc(t);
      return;
    }

    if (t.kind === 'shrine' || t.kind === 'noticeboard') {
      this.onDialogue?.({
        speaker: t.title,
        title: t.kind === 'shrine' ? 'Ancient Wayshrine' : 'Town Noticeboard',
        lines: t.lines ?? (
          t.kind === 'shrine'
            ? [
                'The weathered stone hums faintly under your palm.',
                'Offerings of barley and small coin lie at its base, left by travellers crossing the Wyle.',
                '“Walk softly. The Reaches remember every footfall.”',
              ]
            : [
                'BY ORDER OF THE MAGISTRATE OF MILDVAR',
                '• Pilgrims sought for the reliquary of St. Alder — speak with Arch-Prelate Anselm in the cathedral.',
                '• The garrison at Fort Ironspire pays coin for reliable couriers — Commander Vane holds the ledger.',
                '• Norvik’s mead-hall seeks word of the southern grain tithe — Jarl Torstein waits by the fire-trench.',
                'Press J at any time to open your journal.',
              ]
        ),
      });
      return;
    }
  }

  leaveInterior() {
    this.currentInterior = null;
    this.returnState = null;
    this.group.visible = false;
    this.light.intensity = 0;
    this.clearTarget();
    this.onInteriorChange?.(null);
  }

  private clearTarget() {
    if (this.activeTarget) {
      this.activeTarget = null;
      this.onTargetChange?.(null);
    }
  }

  private placeLight(cell: InteriorCell) {
    this.light.position.set(cell.origin.x, cell.origin.y + 3.4, cell.origin.z);
    this.light.intensity = 55;
  }

  private handleNpc(t: Interactable) {
    for (const q of this.quests) {
      if (q.status === 'completed') continue;
      const step = q.steps[q.stepIndex];
      if (!step || step.targetId !== t.npcId) continue;
      step.completed = true;
      const starting = q.status === 'available';
      q.status = 'active';
      q.stepIndex++;
      let questUpdate = starting ? `Quest started · ${q.title}` : `Objective complete · ${q.title}`;
      if (q.stepIndex >= q.steps.length) {
        q.status = 'completed';
        questUpdate = `Quest completed · ${q.title} (${q.rewardText})`;
      }
      this.onDialogue?.({ speaker: t.title, title: q.title, lines: step.dialogue, questUpdate });
      this.onQuestChange?.([...this.quests]);
      return;
    }

    // An NPC whose step is not current still has something to say.
    const waiting = this.quests.find((q) => q.status !== 'completed' && q.steps[q.stepIndex]?.targetId === t.npcId);
    this.onDialogue?.({
      speaker: t.title,
      title: waiting ? waiting.title : 'A Word on the Road',
      lines: [
        'May the roads treat you kindly, traveller.',
        this.currentInterior
          ? 'The hearth is warm and the door is open. Ask what you will.'
          : 'Press J to review your journal, or read the noticeboard in the square.',
      ],
    });
  }

  /* ----------------------------- interiors ------------------------------ */

  private buildInteriors(mats: Record<string, THREE.Material>) {
    const specs: {
      kind: InteriorKind;
      w: number; d: number; h: number;
      title: string;
      npcName: string; npcRole: string;
      wall: string; wallCol: number; floorKey: 'cobble' | 'wood';
      npcX: number; npcZ: number;
    }[] = [
      { kind: 'cathedral', w: 16, d: 30, h: 11, title: 'Cathedral of St. Alder', npcName: 'Arch-Prelate Anselm', npcRole: 'Keeper of the Reliquary', wall: 'stone', wallCol: 0xcfc6b5, floorKey: 'cobble', npcX: 0, npcZ: -8.8 },
      { kind: 'longhouse', w: 16, d: 24, h: 7, title: 'Norvik Great Mead-Hall', npcName: 'Jarl Torstein', npcRole: 'High Chieftain of Norvik', wall: 'wood', wallCol: 0x6b4f35, floorKey: 'wood', npcX: 0, npcZ: -7.6 },
      { kind: 'keep', w: 18, d: 20, h: 8.4, title: 'Garrison War Room', npcName: 'Commander Vane', npcRole: 'Lord Marshal of the Reaches', wall: 'stone', wallCol: 0x8f8d8a, floorKey: 'cobble', npcX: 0, npcZ: -5.4 },
      { kind: 'tavern', w: 15, d: 18, h: 5.6, title: 'The Golden Flagon Inn', npcName: 'Innkeeper Greta', npcRole: 'Master of Rumours', wall: 'plaster', wallCol: 0xe8d8b6, floorKey: 'wood', npcX: 1.6, npcZ: -1.0 },
      { kind: 'cottage', w: 11, d: 12, h: 4.4, title: 'Homestead Hearth', npcName: 'Elder Reeve Haldor', npcRole: 'Village Steward', wall: 'plaster', wallCol: 0xe0d2b8, floorKey: 'wood', npcX: -1.6, npcZ: -2.4 },
    ];

    specs.forEach((sp, idx) => {
      const ox = POCKET_X + idx * POCKET_GAP;
      const oz = 0;
      const oy = POCKET_Y;
      const hw = sp.w / 2;
      const hd = sp.d / 2;
      const base = mat4(ox, oy, oz);
      const c = new Collector();
      const obbs: InteriorCell['obbs'] = [];
      const solid = (cx: number, cz: number, w: number, d: number) => obbs.push({ cx, cz, hw: w / 2, hd: d / 2 });

      // shell
      c.add(sp.floorKey, box(sp.w, 0.4, sp.d), base.clone().multiply(mat4(0, -0.2, 0)), sp.floorKey === 'cobble' ? 0x9a8873 : 0x7a5a3a);
      c.add('wood', box(sp.w + 0.7, 0.4, sp.d + 0.7), base.clone().multiply(mat4(0, sp.h + 0.2, 0)), 0x4a3524);
      c.add(sp.wall, box(sp.w, sp.h, 0.6), base.clone().multiply(mat4(0, sp.h / 2, -hd)), sp.wallCol);
      c.add(sp.wall, box(sp.w, sp.h, 0.6), base.clone().multiply(mat4(0, sp.h / 2, hd)), sp.wallCol);
      c.add(sp.wall, box(0.6, sp.h, sp.d), base.clone().multiply(mat4(-hw, sp.h / 2, 0)), sp.wallCol);
      c.add(sp.wall, box(0.6, sp.h, sp.d), base.clone().multiply(mat4(hw, sp.h / 2, 0)), sp.wallCol);
      for (let z = -hd + 3; z <= hd - 3; z += 4) {
        c.add('wood', box(sp.w - 0.5, 0.34, 0.34), base.clone().multiply(mat4(0, sp.h - 0.35, z)), 0x3d2a18);
      }

      // threshold & door at +z
      c.add('stone', box(2.6, 0.14, 1.2), base.clone().multiply(mat4(0, 0.07, hd + 0.35)), 0xbdb3a2);
      c.add('stone', box(3.0, 3.5, 0.22), base.clone().multiply(mat4(0, 1.75, hd - 0.3)), 0xa89e8c);
      c.add('wood', box(2.2, 3.1, 0.28), base.clone().multiply(mat4(0, 1.55, hd - 0.42)), 0x4a2f1c);
      c.add('flat', box(0.18, 0.18, 0.3), base.clone().multiply(mat4(0.75, 1.4, hd - 0.55)), 0xd8b25a);

      const cellObbs: InteriorCell['obbs'] = obbs;

      if (sp.kind === 'cathedral') {
        for (let z = -hd + 8; z <= hd - 6; z += 5) {
          for (const s of [-1, 1]) {
            c.add('stone', new THREE.CylinderGeometry(0.5, 0.56, sp.h, 10), base.clone().multiply(mat4(s * 5.2, sp.h / 2, z)), 0xb8b0a0);
            solid(ox + s * 5.2, oz + z, 1.2, 1.2);
            c.add('wood', box(3.4, 0.95, 0.7), base.clone().multiply(mat4(s * 2.6, 0.47, z)), 0x5a3a22);
            solid(ox + s * 2.6, oz + z, 3.4, 0.8);
          }
        }
        c.add('stone', box(7, 0.5, 4), base.clone().multiply(mat4(0, 0.25, -hd + 4)), 0xbdb3a2);
        c.add('stone', box(3.6, 1.3, 1.5), base.clone().multiply(mat4(0, 1.05, -hd + 3.6)), 0xe8dcc3);
        c.add('flat', box(0.22, 1.6, 0.22), base.clone().multiply(mat4(0, 2.4, -hd + 3.4)), 0xd8b25a);
        c.add('flat', box(1.0, 0.22, 0.22), base.clone().multiply(mat4(0, 2.8, -hd + 3.4)), 0xd8b25a);
        solid(ox, oz - hd + 3.8, 5, 1.4);
        // stained-glass glow strips on both walls
        for (let z = -hd + 6; z <= hd - 8; z += 6) {
          for (const s of [-1, 1]) {
            c.add('flat', box(0.1, 2.6, 0.9), base.clone().multiply(mat4(s * (hw - 0.36), 5.2, z)), 0x4c6bb0);
          }
        }
      } else if (sp.kind === 'longhouse') {
        c.add('stone', box(2.6, 0.4, 10), base.clone().multiply(mat4(0, 0.2, 0)), 0x6f6a64);
        solid(ox, oz, 2.6, 10);
        for (const z of [-2.4, 2.4]) {
          c.add('flat', new THREE.ConeGeometry(0.8, 1.2, 7), base.clone().multiply(mat4(0, 0.8, z)), 0xff7a1a);
        }
        for (const s of [-1, 1]) {
          c.add('wood', box(1.8, 0.9, 9), base.clone().multiply(mat4(s * 4.4, 0.45, 0)), 0x6b4a2e);
          solid(ox + s * 4.4, oz, 1.8, 9);
        }
        c.add('wood', box(5, 0.55, 3), base.clone().multiply(mat4(0, 0.28, -hd + 3)), 0x4a3320);
        c.add('wood', box(1.9, 2.6, 1.3), base.clone().multiply(mat4(0, 1.6, -hd + 2.4)), 0x3d2816);
        solid(ox, oz - hd + 2.7, 2.6, 1.4);
      } else if (sp.kind === 'keep') {
        c.add('wood', box(5.2, 1.0, 3.4), base.clone().multiply(mat4(0, 0.5, -2)), 0x4a2f1c);
        c.add('flat', box(4.6, 0.07, 2.8), base.clone().multiply(mat4(0, 1.02, -2)), 0x5c7a45);
        c.add('flat', box(0.3, 0.4, 0.3), base.clone().multiply(mat4(-1.0, 1.2, -2.4)), 0xc43535);
        c.add('flat', box(0.3, 0.4, 0.3), base.clone().multiply(mat4(1.1, 1.2, -1.5)), 0x358fc4);
        c.add('flat', box(0.36, 0.5, 0.36), base.clone().multiply(mat4(0, 1.28, -2)), 0xe5ad35);
        solid(ox, oz - 2, 5.2, 3.4);
        for (const s of [-1, 1]) {
          c.add('wood', box(0.8, 2.4, 4.4), base.clone().multiply(mat4(s * (hw - 0.9), 1.2, -1)), 0x5a3f28);
          for (let i = 0; i < 3; i++) {
            c.add('flat', box(0.06, 2.0, 0.06), base.clone().multiply(mat4(s * (hw - 1.2), 1.3, -2.4 + i * 1.4)), 0xc5c7cb);
          }
          solid(ox + s * (hw - 0.9), oz - 1, 1.2, 4.4);
        }
        c.add('flat', box(4.5, 0.05, 2.6), base.clone().multiply(mat4(0, 0.03, 4.2)), 0x6b2a2a);
      } else if (sp.kind === 'tavern') {
        c.add('stone', box(1.7, sp.h, 4.6), base.clone().multiply(mat4(-hw + 1.6, sp.h / 2, -hd + 2.4)), 0x8a8278);
        c.add('flat', new THREE.SphereGeometry(0.6, 8, 6), base.clone().multiply(mat4(-hw + 1.9, 0.7, -hd + 2.4)), 0xff6b1a);
        solid(ox - hw + 1.6, oz - hd + 2.4, 1.7, 4.6);
        c.add('wood', box(4.6, 1.15, 1.2), base.clone().multiply(mat4(-hw + 4.6, 0.57, -4)), 0x6b4a2e);
        c.add('wood', box(0.1, 0.1, 1.2), base.clone().multiply(mat4(-hw + 4.6, 1.15, -4)), 0x8a6a42);
        solid(ox - hw + 4.6, oz - 4, 4.6, 1.2);
        for (const [tx, tz] of [[2.6, 1.4], [2.0, -4.2], [-1.2, 3.0]] as [number, number][]) {
          c.add('wood', box(2.4, 0.8, 2.0), base.clone().multiply(mat4(tx, 0.4, tz)), 0x7a5636);
          solid(ox + tx, oz + tz, 2.4, 2.0);
        }
        for (let i = 0; i < 3; i++) {
          c.add('flat', box(0.5, 0.5, 0.5), base.clone().multiply(mat4(-hw + 3.2 + i * 0.9, 3.0, -hd + 1.2)), 0xc9a227);
        }
      } else {
        c.add('stone', box(1.6, sp.h, 3.0), base.clone().multiply(mat4(-hw + 1.4, sp.h / 2, -hd + 2.2)), 0x8a8278);
        c.add('flat', new THREE.SphereGeometry(0.5, 8, 6), base.clone().multiply(mat4(-hw + 1.7, 0.6, -hd + 2.2)), 0xff6b1a);
        solid(ox - hw + 1.4, oz - hd + 2.2, 1.6, 3.0);
        c.add('wood', box(2.4, 0.8, 2.0), base.clone().multiply(mat4(1.4, 0.4, -1.6)), 0x7a5636);
        solid(ox + 1.4, oz - 1.6, 2.4, 2.0);
        c.add('wood', box(1.4, 0.5, 2.6), base.clone().multiply(mat4(-hw + 2.4, 0.25, 1.6)), 0x5a3a22);
        c.add('thatch', box(1.4, 0.35, 2.4), base.clone().multiply(mat4(-hw + 2.4, 0.68, 1.6)), 0xd9c08a);
        solid(ox - hw + 2.4, oz + 1.6, 1.4, 2.6);
      }

      // quest giver at the far end of the room
      const npcX = ox + sp.npcX;
      const npcZ = oz + sp.npcZ;
      this.addFigure(c, mat4(npcX, oy, npcZ), sp.kind);
      cellObbs.push({ cx: npcX, cz: npcZ, hw: 0.75, hd: 0.75 });

      for (const m of c.build(mats, false)) {
        m.castShadow = false;
        m.receiveShadow = false;
        this.group.add(m);
      }

      this.cells.set(sp.kind, {
        kind: sp.kind,
        origin: new THREE.Vector3(ox, oy, oz),
        spawn: new THREE.Vector3(ox, oy + EYE, oz + hd - 5),
        floorY: oy,
        bounds: { minX: ox - hw + 0.9, maxX: ox + hw - 0.9, minZ: oz - hd + 0.9, maxZ: oz + hd - 0.9 },
        obbs: cellObbs,
      });

      this.register({
        id: `exit_${sp.kind}`,
        kind: 'exit_interior',
        title: sp.title,
        prompt: 'Step back outside',
        pos: new THREE.Vector3(ox, oy + 1.4, oz + hd - 1.4),
        radius: 2.4,
      });

      this.register({
        id: `npc_${sp.kind}`,
        kind: 'npc',
        title: `${sp.npcName} — ${sp.npcRole}`,
        prompt: `Speak with ${sp.npcName}`,
        pos: new THREE.Vector3(npcX, oy + 1.4, npcZ),
        radius: 3.2,
        npcId: NPC_IDS[sp.kind],
      });
    });
  }

  private addFigure(c: Collector, base: THREE.Matrix4, kind: InteriorKind) {
    const robe =
      kind === 'cathedral' ? 0xd9a632 : kind === 'keep' ? 0x9e2424 : kind === 'longhouse' ? 0x3b5c8a : kind === 'tavern' ? 0x5a7a3a : 0x8a5a3a;
    c.add('flat', new THREE.CylinderGeometry(0.26, 0.38, 1.4, 10), base.clone().multiply(mat4(0, 0.7, 0)), robe);
    c.add('flat', new THREE.SphereGeometry(0.18, 10, 8), base.clone().multiply(mat4(0, 1.6, 0)), 0xe0b48c);
    c.add('flat', box(0.12, 0.62, 0.12), base.clone().multiply(mat4(-0.3, 1.1, 0)), robe);
    c.add('flat', box(0.12, 0.62, 0.12), base.clone().multiply(mat4(0.3, 1.1, 0)), robe);
    // floating quest diamond
    c.add('flat', new THREE.OctahedronGeometry(0.17, 0), base.clone().multiply(mat4(0, 2.2, 0)), 0xffcf40);
  }

  /* ------------------------------- quests ------------------------------- */

  private initQuests() {
    this.quests = [
      {
        id: 'q_reliquary',
        title: 'The Reliquary of St. Alder',
        giver: 'Arch-Prelate Anselm',
        village: 'Mildvar',
        status: 'available',
        stepIndex: 0,
        rewardText: '+150 gold · Blessing of the Wyle',
        steps: [
          {
            id: 's1',
            description: 'Enter the Cathedral of St. Alder in Mildvar and speak with Arch-Prelate Anselm.',
            targetId: NPC_IDS.cathedral,
            dialogue: [
              'Welcome to the cathedral, traveller. Mind the steps — the stone is older than the kingdom.',
              'Our northern courier vanished near the Whispering Weald carrying a seal meant for Fort Ironspire.',
              'Ask Innkeeper Greta at the Golden Flagon. She hears every wagon driver on the road.',
            ],
            completed: false,
          },
          {
            id: 's2',
            description: 'Question Innkeeper Greta inside a town tavern.',
            targetId: NPC_IDS.tavern,
            dialogue: [
              'Anselm sent you? Aye — a driver came in shivering at dawn.',
              'He swore the courier rode straight for Fort Ironspire to warn Commander Vane of strange lights in the Weald.',
              'Take the north road. The garrison gate is open until dusk.',
            ],
            completed: false,
          },
          {
            id: 's3',
            description: 'Report to Commander Vane in the Garrison War Room at Fort Ironspire.',
            targetId: NPC_IDS.keep,
            dialogue: [
              'By the iron crown — so the Prelate’s seal made it through after all.',
              'You have saved my scouts a week of blind patrolling. Take this from the garrison treasury.',
              'If those lights are what I fear, we will speak again before winter.',
            ],
            completed: false,
          },
        ],
      },
      {
        id: 'q_hearth_fires',
        title: 'Hearth-Fires of the North',
        giver: 'Jarl Torstein',
        village: 'Norvik',
        status: 'available',
        stepIndex: 0,
        rewardText: '+200 gold · Pinehold runestone',
        steps: [
          {
            id: 'n1',
            description: 'Enter the Great Mead-Hall in Norvik and speak with Jarl Torstein.',
            targetId: NPC_IDS.longhouse,
            dialogue: [
              'Warm your hands by the fire-trench, stranger! Few walk the long road north from Mildvar.',
              'The grain wagons from Sudholm are late, and the frost already bites the Norbeck.',
              'Find Elder Reeve Haldor in a homestead cottage and see the harvest tithe is moving.',
            ],
            completed: false,
          },
          {
            id: 'n2',
            description: 'Find Elder Reeve Haldor in any village cottage and take the tally-stick.',
            targetId: NPC_IDS.cottage,
            dialogue: [
              'Tell Jarl Torstein the barley carts are loaded and rolling along the Wyle highway!',
              'Here is the signed tally-stick for the northern granaries. Mind the puddles on the way home.',
            ],
            completed: false,
          },
        ],
      },
    ];
  }

  /** Journal view model for the UI. */
  questSummary() {
    return this.quests.map((q) => ({
      id: q.id,
      title: q.title,
      status: q.status,
      objective: q.status === 'completed' ? q.rewardText : q.steps[q.stepIndex]?.description ?? '',
      step: Math.min(q.stepIndex + 1, q.steps.length),
      steps: q.steps.length,
    }));
  }
}

export const NPC_IDS: Record<InteriorKind, string> = {
  cathedral: 'npc_anselm',
  longhouse: 'npc_torstein',
  keep: 'npc_vane',
  tavern: 'npc_greta',
  cottage: 'npc_haldor',
};
