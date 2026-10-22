# Architectural review → implementation notes

This tracks how the "Argon" architecture review was applied to the Mildvar
Reaches engine, what was deliberately deferred, and how to verify it.

Run `npm run verify` (headless, no browser) or open the dev server.

---

## 1. World scale vs. gameplay pacing — **done**

| Before | After |
| --- | --- |
| `WORLD_HALF = 8000` (16 km square) | `4000` (8 km square) |
| Norvik / Eastreach / Sudholm / Westmoor at ±5000 | ±**2600** |
| Mountain ring at 5.6–7.4 km radius | 3.3–4.4 km radius (encloses the valley) |
| Mildvar → Norvik walk | 19 min → **~9.8 min** (7.3 min on the road at +35%) |
| Mildvar → Norvik sprint | 9 min → **~4.5 min** |

The four outer villages now sit *inside* the ring of wilderness landmarks
(Fort Ironspire −1600/−1700, Lake Eldermere 2300/−2100, Whispering Weald
−2150/−2150, Golden Mead 1850/2200) instead of past them, so a cross-country
walk passes the fort, the wealds and the lake instead of empty noise.

Road bonus: `controls.ts` adds **+35 %** move speed while
`roadQuery(x, z).d < 0.5` (paved/dirt road surface).

Verified: every village still has a road within ~32 m of its square, no two
named locations overlap, no `NaN` terrain samples, and 27.6 km of road is
surveyed for the smaller world (generation 119 ms).

---

## 2. Rendering / engine

### 2a. Un-culled `wildGroup` — **done**

`world.ts` no longer merges all wilderness into one 8 km-wide collector.
Each landmark gets its own `Collector` → `THREE.Group`:

* `lake_eldermere`, `whispering_weald`, `fort_ironspire`, `golden_mead`
* **each** of the five watchtowers (70 m radius)

Each entry is distance-culled (`d < 2700 * viewScale`) and its shadow
casters are gated at 1.1 km. Because the groups are small, Three.js can now
also frustum-cull them with real bounding spheres.

### 2b. NPC identity + shared geometry — **done**

* `makeSoldier()` / `makeVillager()` no longer build a fresh `Collector`
  per instance. Three soldier archetypes and eight villager variants are
  built **once** and `.clone(true)`-d, so every NPC shares the same GPU
  vertex buffers.
* `World.entities: Map<string, WorldEntity>` holds `id`, `name`, `role`,
  `faction` and the `Object3D` for every soldier and villager
  (`soldier_0…`, `villager_<village>_<n>`).
* Fixed an accumulating Y-drift in the soldier idle animation
  (`position.y += …` → absolute `baseY + …`).

### 2c. `EffectComposer` overhead — **done**

`engine.ts` renders straight to the canvas whenever tilt-shift is inactive
(i.e. stroll / fly / ride):

```ts
if (this.tiltH.enabled) this.composer.render();
else this.renderer.render(this.world.scene, this.camera);
```

No more HalfFloat multisampled offscreen target + `OutputPass` in
first-person mode.

### 2d. Terrain streaming stalls — **partially done**

* `prewarm()` used to build every chunk inside `keepRadius` (1 500 m ≈ 95
  chunks) synchronously on spawn and fast travel. It now builds only the
  arrival ring (≤ 900 m) and lets `update()` fill the rest.
* Streaming budget lowered from 5 to 2–3 chunks/frame (measured ~6.6 ms per
  300 m chunk, so 5 was a guaranteed hitch).
* `groundColor()` reuses the river query the height sampler already made
  instead of projecting onto river segments a second time.
* Terrain streaming and sun-shadow updates are skipped entirely while the
  player is inside a pocket interior.

**Deferred:** moving `buildChunkGeometry()` into a Web Worker, and the
baked 2048² heightfield. Both are worthwhile but change the
height-authority contract for roads/rivers/buildings (every placement
helper calls `terrainHeight`); doing that blind, without a browser to
compare silhouettes, was the wrong risk to take in one pass. The measured
numbers above make the trade-off explicit.

---

## 3. Interaction, interiors & quests — **done**

New module `src/three/world/interactables.ts`.

* **Zero-raycast spatial interaction.** Doors/NPCs/shrines/noticeboards are
  registered into a `SpatialGrid<Interactable>(32)` during generation; each
  frame does one cell lookup plus a distance/view-cone test. This is
  required because buildings are merged per material and cannot be
  identified by a raycast.
* **5 pocket interiors** at `(12000, −220, 0)`, spaced 170 m:
  Cathedral of St. Alder, Norvik Great Mead-Hall, Garrison War Room,
  The Golden Flagon Inn, Homestead Hearth.
  They are built with the existing `Collector`/`box`/`mat4` pipeline,
  have DoubleSide materials, their own collision boxes and a warm point
  light, and the whole group is `visible = false` unless entered.
* **Doors** are registered from the *same* matrix the building was placed
  with, so the trigger can never drift from the painted door. 96 doors are
  generated across the five villages plus the fort HQ, the lake lodge, the
  weald cabin and the meadow cottage.
* **Quest engine**: two three-step/two-step questlines with a
  `available → active → completed` state machine, dialogue events and
  reward text (`q_reliquary`, `q_hearth_fires`).
* **Movement**: `world.groundHeight`, `isWalkable` and `resolveCollision`
  delegate to the interior system when indoors; `controls.teleport()`
  skips the terrain prewarm for pocket rooms.

Verification (headless): all 96 doors reachable by a 0.65 m player capsule,
no door returns inside geometry, no duplicate ids, both quest chains
complete, interiors resolve floor/collision correctly.

---

## 4. Bugs from the checklist

| Item | Status |
| --- | --- |
| `App.tsx` 400 ms `setInterval` re-render | **fixed** — rAF + DOM refs, React state only changes when the nearest place changes |
| `Minimap.tsx` `setLocation` every 200 ms | **fixed** — guarded by a ref |
| `WATCHTOWER_SITES` vs `WILDERNESS_SPECS` mismatch | **fixed** — `WATCHTOWER_SITES` is now defined once in `land.ts`; all five are map pins / fast-travel targets |
| Per-NPC geometry | **fixed** — 3 soldier + 8 villager templates, cloned |
| `EffectComposer` when tilt off | **fixed** |

---

## 5. Deliberately not done in this pass

* **Web Worker chunk generation / baked heightfield** (see 2d).
* **GPU shader pack** (wind sway, river foam) — a visual-only change that
  needs a browser to tune; adding it blind risks breaking the look of the
  crops and tree instances.
* **Articulated character rigs** — NPCs still slide/bob rather than swing
  limbs; they now share geometry and carry identity, which is the
  prerequisite for a rig.
* **Mounts** — the road sprint bonus covers the pacing issue; a horse mode
  needs its own animation and camera work.
* **Spatial WebAudio** — no audio pipeline exists yet.

---

## 6. Manual verification path

1. `npm run dev`, open the preview.
2. Press **2** (Stroll) → click to lock the pointer.
3. In Mildvar: the **noticeboard** is a few metres south-east of the
   fountain; the **Cathedral of St. Alder** (tall spire, north-west of the
   square) and the **Town Hall** (with steps) both show `[E] Enter …`.
4. Press **E** at a door → the screen swaps to the furnished pocket
   interior. Talk to Anselm/Greta/Vane/Torstein/Haldor with **E**.
5. Press **J** for the quest journal; **E** on the far door to step back
   outside (you return to the exact doorstep).
6. Open the map (**M**) — 14 locations, including all five watchtowers.
