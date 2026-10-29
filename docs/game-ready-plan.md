# Game-Ready Plan — Trees, People, Rivers, and the road to a shipping build

Status: **plan only, nothing implemented yet.** Written against the code as it
stands at `b016641` (six house types, rebuilt watchtowers, crowned roads,
minimap heading fix).

---

## 0. What "game ready" means here

Not "looks good in a screenshot" — the target is:

| Pillar | Target | Why this number |
| --- | --- | --- |
| Frame rate | 60 fps at 1080p on a 2020 mid-range laptop GPU (GTX 1650 / M1), 30 fps floor on integrated | The player base for a browser game is laptops |
| Draw calls | **< 300 per frame** on desktop, < 120 at the *low* preset | Every draw call is CPU submission cost in WebGL2; ~100–150 is the comfortable band, several hundred is the practical desktop ceiling |
| Triangles submitted | < 2.0 M visible | Above this, vertex cost starts to matter on integrated GPUs |
| First interactive frame | < 3 s on a 10 Mbit connection | Currently the whole app is one inlined 1.03 MB HTML file (289 kB gzip) and the world is generated synchronously |
| Frame time variance | p99 < 1.5× median | Stutter reads as "broken" far more than a low average FPS does |
| Memory ceiling | < 450 MB after 30 min of roaming | Streaming terrain already exists; the assets are the risk |

### Measured baseline (not guessed) — `npx tsx scripts/audit-budget.ts`

The audit builds the real world headlessly and counts what the renderer would
submit from three viewpoints, using the game's actual LOD rule (near LOD inside
2.4 km, far LOD to 9.5 km) and the real forest-density field:

| Layer | Draw calls | Triangles | Verdict |
| --- | --- | --- | --- |
| Settlements (14) | **93** | 366 k | fine; an atlas takes it to ~40 |
| Wilderness landmarks | 14 | 23 k | fine |
| **Roads** | **517** | 89 k | **broken — see below** |
| Nature (9–12 near + 97 far tiles) | 259–278 | 156 k | ~196 of those calls are *far* tiles |
| **Total, worst view** | **888** | **0.64 M** | 3× over the draw-call budget, well under the triangle budget |

Two findings change the order of the plan:

1. **Road draw calls are a regression I introduced in the last round.** The new
   crowned-road builder creates a *separate mesh per 60-sample piece per layer*
   (surface, verge, ruts, kerb, median, milestones) instead of accumulating the
   whole road and emitting one mesh per material. 26 roads × ~30 pieces × ~5
   layers = 517 calls for 89 k triangles — 60 % of the entire frame's submission
   cost for 6 % of its geometry. This is the single highest-value fix in the plan
   and it is ~30 lines: accumulate into arrays across pieces, build once.
2. **Far nature tiles each cost their own draw call.** 97 far tiles × 2 = 194
   calls to draw what is effectively two instanced meshes of 8-triangle trees.
   Beyond the near bubble the whole world's trees can live in **two global
   instanced meshes** (one round, one conifer) rebuilt only when the camera
   crosses a tile boundary: ~194 calls → 2.

Everything else is roughly as expected. The triangle budget is *not* the problem
today (0.64 M of a 2 M budget); draw calls are, and they are concentrated in two
places. That is very good news — it means Steps 1–2 of this plan are mostly
re-arranging existing submission rather than cutting content.

**Other measured facts:**

* One 1.03 MB inlined bundle, 289 kB gzip. No external assets at all — every
  texture, mesh and NPC is procedural. That is a big advantage: zero download
  risk, no licence problems, and it is why the world can be 8 km wide.
* Terrain streams in 300 m chunks; nature is split into 1200 m tiles with two
  LODs switched at 2.4 km / 9.5 km with a **hard pop** and no hysteresis.
* Trees: flat-shaded spheres/cones, ~130 tris near, ~8 far, **no wind, no leaf
  cards, no contact shading**.
* People: 3 soldier + 8 villager archetypes, cloned per NPC, rigid — no rig, no
  walk cycle, no idle. ~500 villagers total; a busy square is ~40 draw calls of
  people alone.
* Rivers: one ~5 m ribbon per chain, `MeshStandardMaterial` with a scrolling
  normal map; no foam, no depth tint, no flow direction, no Fresnel.
* No audio, no loading screen, no persistence, no mobile preset, no input
  remapping.

So the gap to "game ready" is not one feature — it is four asset-quality jumps,
one rendering-architecture change, and a shipping layer.

---

## Step 1 — DONE (measured)

Landed before starting Step 2, because the audit showed the frame was 3x over the
draw-call budget with no visual benefit:

| Fix | Before | After |
| --- | --- | --- |
| Roads: one mesh per piece per layer → one per material for the whole network | 517 calls | **8** |
| Far trees: two meshes per tile → three world-wide instanced batches | 194 calls | **3** |
| LOD hysteresis (±8 %) so tiles do not thrash on a threshold | — | — |
| Shadow cascade capped at 160 m | up to 260 m | 160 m |
| `F3` overlay: per-layer draw calls / triangles / ms | none | in HUD |

**Measured worst view: 888 → 188 draw calls, 0.64 M triangles.** Inside budget
with room for everything in Steps 2–4. The road render is pixel-identical to the
previous round (`docs/road-cross-sections.png`).

---

## 1. How realistic trees are actually done (and what to copy)

The industry answer is boring and consistent:

1. **One authored tree, not three spheres.** A hero tree is 8–20 k tris with
   leaf *cards* (alpha-tested quads with a 4–8 leaf cluster texture) or
   photogrammetry. Leaves are almost never individual meshes.
2. **A LOD chain you author once**: full mesh → 1/4 mesh → billboard *impostor*.
   The impostor is a single camera-facing card that blends the three nearest
   baked views from an octahedral (or hemi-octahedral, for things never seen
   from below) atlas. Real numbers from a comparable project: 10 000 trees as
   meshes = 24.2 M indices and **21 ms** GPU; as impostors = 48 K indices and
   **1.0 ms**. Fortnite shipped its trees this way before Nanite.
3. **Instancing everywhere**, grouped into spatial tiles so frustum culling can
   still reject a forest behind you. (We already do tiles + instancing — keep
   that architecture, it is the right one.)
4. **Wind in the vertex shader, not on the CPU**: bend weighted by height above
   the pivot, phase taken from world position so a gust *travels* across the
   valley instead of every tree shivering in unison, plus a small high-frequency
   flutter on the leaf cards only.
5. **Dithered LOD crossfade.** The pop is worse than the polycount. A
   screen-door dither over ~0.3 s costs nothing and hides both LOD switches.
6. **Contact darkening** (vertex-baked AO at the base, cheap screen-space
   darkening later) — this is what stops a tree looking "pasted on" the terrain.

### What I would do in this codebase

**T-A. Tree species kit (replaces the sphere/cone primitives).**
Five species built procedurally in code, each with three authored LODs:

| Species | Hero tris | Far impostor | Notes |
| --- | --- | --- | --- |
| Oak (broadleaf) | ~2 800 | 8 tris | 5–7 branches, 90–140 leaf cards |
| Ash (tall broadleaf) | ~2 400 | 8 | narrower crown, brighter green |
| Pine (conifer) | ~1 600 | 6 | 3 trunk segments, 12–18 branch whorls |
| Birch | ~1 400 | 8 | white bark texture, sparse cards |
| Willow (riverline) | ~2 000 | 8 | drooping cards, always placed in the wet band |

Geometry recipe per species: recursive branch skeleton (L-system, 2 levels,
seeded per species) → tapered cylinder segments merged into one geometry →
leaf cards distributed on branch tips with a per-card random rotation → one
merged `BufferGeometry` with an `aWind` attribute (0 at the base, 1 at the tip).
Cards use a **2048² leaf-cluster atlas** shared by all five species (one texture
bind), alpha *tested*, not blended, and **double-sided with flipped normals** so
the crown lights correctly from both sides.

Cost check: 7 500 trees × 90 cards × 2 tris = 1.35 M tris if every near tree
were drawn. That is why LOD0 must be a **150 m bubble**, not the current 2.4 km
tile. Retune: LOD0 < 150 m (hero), LOD1 150–600 m (cards dropped, crown becomes
a cross-billboard set), LOD2 > 600 m (8-tri impostor card, still wind-swayed).

**T-B. Impostor baker (`scripts/bake-impostors.ts`).** Runs headless against the
same procedural geometry, renders 8 × 8 hemi-octahedral views into one atlas per
species (albedo + normal + depth), writes it as a PNG + JSON under
`public/impostors/`. ~15 min to write, and it turns "forest at 600 m" from
~800 k tris into ~60 k. Because our trees are procedural there is no DCC in the
loop — this is a pure Node script, like the verify and render scripts already in
`scripts/`.

**T-C. Wind.** One `WindState` object (direction, strength, gust phase), shared
uniforms injected through `onBeforeCompile` into the existing foliage material,
`customProgramCacheKey` set so it compiles once. Two bands: canopy sway
(0.05–0.12 m, 0.3 Hz) and leaf flutter (only on card geometry, 3–5 Hz, amplitude
scaled by `aWind²`). Because it is a vertex-shader change on an already-instanced
batch, **the runtime cost is ~0**.

**T-D. Grounding.** Bake a per-instance dark vertex colour into the bottom 10 %
of the trunk geometry, plus a small "root flare" — 40 tris, kills the "floating
tree" look that flat lighting gives us today.

**T-E. Grass and understory (the real "beautiful" lever).** A 60 m ring of
crossed alpha-tested grass cards, instanced, density-faded with distance and
wind-swayed with the same uniforms. Budget 40 k blades in the ring; ~1 draw call
per tile. Plus the existing flowers folded into the same batch (they are
currently 1 247 separate quads). This is the single biggest visual
return-per-triangle item in the whole plan.

**T-F. LOD crossfade + hysteresis.** Dither the outgoing batch over 0.25 s;
switch at the hysteresis margin of ±8 % of the threshold so a camera hovering on
a boundary does not thrash. We already track `t.lod`, so this is a small,
contained change in `scatter.ts`.

---

## 2. How realistic people are actually done

Three tiers, and the trick is knowing which one each character belongs in.

| Tier | Tech | Who | Cost |
| --- | --- | --- | --- |
| **Hero** | glTF skinned mesh, 1–2 k tris, 30–40 bones, shared `AnimationMixer`, ≤ 4 bone influences | named quest NPCs (5–10 on screen), the player | 1 draw call each, CPU skinning |
| **Crowd** | Same rig, but *animation LOD*: full rig < 25 m, simplified rig 25–80 m, impostor/billboard > 80 m | villagers walking lanes, market, docks | 1 draw call each, throttled mixer |
| **Ambient** | VAT (vertex animation texture) + GPU instancing — the animation is baked into a texture read in the vertex shader, so N characters = **1 draw call, 0 per-frame CPU** | distant crowd, crowds at the low preset | ~0 |

The standard pipeline for an asset like this is: author/rig in Blender → export
glTF → compress with `gltf-transform` (meshopt or Draco) + KTX2/Basis textures
→ load with `GLTFLoader` + `KTX2Loader` + `MeshoptDecoder` → one `AnimationMixer`
per animated root, advanced once per frame with `delta`.

The known traps, which the plan must respect:
* **Skinned mesh frustum culling** breaks because three.js caches the bind-pose
  bounding box; set `frustumCulled = false` or a padded manual bounding box.
* **Bones are the cost**, not triangles: `updateMatrixWorld()` on every bone of
  every character dominates. Hence animation throttling (update distant mixers
  at 10–15 Hz, not 60) and the tier split above.
* **One material per character** — a character with 6 submeshes is 6 draw calls.
  Atlas the skin + tunic + leather into one 1024² texture and merge to 1 mesh.

### What I would do in this codebase

**P-A. Rigged hero set, built procedurally first, authored later.** Keep the
zero-asset advantage: generate a 22-bone humanoid rig in code (root, hips,
spine, chest, neck, head, 2 × shoulder/elbow/wrist, 2 × hip/knee/ankle, plus
skirt and cloak bones), skin the existing blocky villager silhouette to it with
simple distance weights, and drive six hand-authored clips: idle, walk, work,
talk, sit, carry. Cost: one afternoon, no DCC, and it instantly replaces the
"sliding statues" with people who *walk*. Ships with the same merged-geometry +
vertex-colour pipeline the buildings already use, so it needs no new textures.

**P-B. Then (optional, later) an authored glTF**. If the look needs to go
photoreal-ish, swap the mesh for a Mixamo-rigged, gltf-transform-compressed
character (~1.5 MB → ~400 kB with meshopt + KTX2). The animation layer is the
same, so this is an asset swap, not a rewrite. Keep the procedural rig as the
low-quality fallback and as the source of shared clips.

**P-C. Animation LOD and mixer budget.** A global scheduler: hero NPCs inside
25 m update at 60 Hz; 25–80 m at 15 Hz; beyond that the mixer is stopped and the
character is drawn as a static pose or an impostor. Cap `AnimationMixer.update`
calls per frame (e.g. 40) and round-robin the rest. This is the difference
between 30 and 400 villagers on screen.

**P-D. Crowd instancing.** Once people are VAT-baked they can share `InstancedMesh`
with per-instance animation phase, which is the only way to afford a market day.
Bake the *walk* and *idle* clips per archetype (8 archetypes × 2 clips × 40
frames ≈ 640 kb of texture) in a Node script, same pattern as P-B/T-B.

**P-E. Presence, which is cheaper than any of the above.** Footstep dust on
paths, a shadow that actually tracks the sun angle, head-turn toward the player
within 6 m, a second idle pose (hands on hips / leaning on a stall), and
`AnimationMixer`-driven blinks. These sell "people live here" more than a
higher-poly face.

---

## 3. How realistic rivers are actually done

A believable river is **three layers**, and only the middle one is the water
surface:

1. **The channel** — a carved, widening, meandering bed with a wet band above
   the waterline (darker soil, pebbles, reeds). Ours does this on the CPU
   (`terrainHeight` holds a shelf), which is right, but the transition is a
   vertex-colour lerp only.
2. **The surface** — a shader, not a normal map. The standard recipe:
   * **flow direction** encoded in a flowmap (or, because our rivers are curves,
     derived from the curve tangent passed in as a vertex attribute — cheaper and
     exact),
   * **two scrolling normal maps** at different scales/speeds, summed, with the
     scroll axis rotated to the flow direction,
   * **depth-based colour**: shallow → pale turquoise, deep → slate blue, driven
     by *scene depth* (screen-space depth read vs the water surface) or by a
     cheap analytic distance-to-bank we already know from `riverQuery`,
   * **shoreline foam**: where the water meets geometry, noise-masked so it is
     broken rather than a clean band, plus a **wet edge** that darkens the bank,
   * **Fresnel**: looking along the river shows the sky, looking down shows the
     bed.
3. **The life** — drifting debris, ripple rings (we have these), and reeds/rocks
   at the waterline with the same foam collar so objects *sit in* the water.

Cost note: the expensive part is transparency + depth reads. The cheap version
that still looks right is **opaque-ish water with a depth-tinted colour and no
refraction**, which is what most stylised games ship.

### What I would do in this codebase

**R-A. Give the river ribbon a proper vertex attribute set** — `aFlow` (tangent,
already computed when the ribbon is built) and `aBank` (signed distance to the
nearest bank, from `riverQuery`, normalised 0…1). No textures needed for either.

**R-B. One `WaterMaterial` (`ShaderMaterial` built by patching `MeshStandardMaterial`
so it keeps the scene's lighting and fog):**
* base colour = mix(shallow, deep, `aBank`), plus a slow caustic-ish gradient;
* two normal maps scrolling along `aFlow` at 0.06 and 0.021 (the current single
  scroll is why it reads as "plastic with a moving pattern");
* foam = `smoothstep(0.08, 0.0, aBank)` × 2-octave noise moving at flow speed,
  broken up so it hugs the bank in tongues rather than a stripe;
* Fresnel rim brightening toward the horizon (this alone fixes the flat look at
  distance);
* a small **vertex ripple** from the same `WindState` time so the surface is not
  perfectly planar (0.03 m is enough).

**R-C. Wet band on the terrain.** Extend `groundColor()` with a wet-soil tint and
a pebble colour for `q.d < half + 3` — 6 lines, no cost, and it removes the
"water pasted on grass" seam.

**R-D. Reeds and bank rocks** as an instanced strip along both banks with the
same foam collar trick (a small dark ring decal at the waterline). This is what
makes the river read at close range.

**R-E. River physics polish (already partly there):** keep the ripples, add a
slow downstream flotsam drift that respects `aFlow`, and a "wade" slowdown when
`waterQuery().d < half`.

---

## 4. The heavier architectural decisions (needed for the targets, not for looks)

These are the things that will otherwise bite at frame 60 of a real session.

**A1. Draw-call audit before any new content.** `renderer.info.render.calls` is
already accumulated in `engine.ts` but never reported per layer. Add a debug
overlay (off by default, `F3`) showing calls / tris / geometries per group:
settlements, roads, nature tiles, people, props, water, sky. **We cannot budget
what we do not measure** — this is step 0 of the whole plan.

**A2. Material atlas.** Right now `Collector` builds one mesh per material key
per landmark. A village is ~9 material keys × 5 villages = a few dozen calls,
which is fine; but the road, nature and prop groups each add their own. Fold the
building material set (stone/plaster/tiles/slate/thatch/wood/flat) into **one
atlas texture with 6 UV bands**, so every building in the world is **1 draw call
per village** instead of ~9. Expected saving: 30–50 calls.

**A3. Shadow budget.** Shadow maps are the silent killer: every caster that is
drawn into the shadow pass doubles its cost. Cap the cascade to 120 m, only
include near-tree tiles and buildings (people get a cheap blob shadow beyond
20 m), and keep `shadow.mapSize` at 2048 on the *balanced* preset (currently
likely 2048/4096).

**A4. Streaming the content, not just the terrain.** Chunk generation runs on the
main thread (`buildChunkGeometry`). Moving it to a **Web Worker** with a
transferable `ArrayBuffer` removes the hitch that arrives whenever you cross a
chunk boundary at speed. This was deferred last phase as "risky blind" — it
becomes safe once A1 gives us the frame-time histogram to prove the hitch exists.

**A5. Loading and smoke screen.** Even with no downloads, world generation is
~1–2 s of blocking work on first paint. A proper loading sequence (progress bar
fed by the same counters `prewarm` already tracks) makes it feel shipped.

**A6. Persistence.** Quest state and player position are in memory only — a
reload resets everything. `localStorage` or IndexedDB with a versioned schema,
autosaved on interior exit / fast travel. This is a *game-ready* requirement, not
a polish item.

**A7. Audio.** Footsteps by surface (cobble/grass/water), wind bed, river bed by
proximity, birdsong at dawn/dusk, UI clicks. WebAudio with 3–4 looping beds and
positional one-shots; ~30 kB of procedural/CC0 samples. This changes perceived
quality more than another 500 k triangles.

**A8. Settings that actually do something.** Draw distance, foliage density,
shadow quality, wind on/off, water quality (full/fast), tilt-shift. All of them
should drive existing knobs (`viewScale`, `PRESETS`, the new LOD thresholds), and
persist.

**A9. Accessibility and input.** Remappable keys, a gamepad path, large-pointer
UI, and a "no tilt-shift / no motion" toggle. Cheap to add now, expensive later.

**A10. Mobile / low-end preset.** Half-resolution render target, LOD thresholds
at 40 %, no wind, no tilt-shift, impostors everywhere beyond 150 m, people as
billboards beyond 30 m. Target: playable on a 2021 mid-range phone.

---

## 5. Sequencing — five steps, each one shippable

Every step ends with `npm run verify` + `tsc` + `build` green and a new offline
render in `docs/`, exactly like the houses/tower/roads round. No step lands
half-done.

### Step 1 — Pay down submission cost — **SHIPPED**
Measured: **888 → 188 calls**, road render unchanged, `verify` PASS.
Still open in this step (do with Step 2, they touch the same code): the material
atlas for settlements (93 calls) and grass batching (Step 2's T-E).

### Step 2 — Trees that look like trees
* T-A species kit (5 species, 3 LODs, leaf-card atlas).
* T-B impostor baker script.
* T-C wind + T-D grounding + T-E grass/understory.
* **Exit test:** forest at 150 m reads as a forest in the offline render; calls
  per nature tile ≤ 6 near / ≤ 2 far; tris visible at the hilltop view down
  ≥ 50 % from today with no visible loss.

### Step 3 — People who move
* P-A procedural rig + six clips, applied to villagers and soldiers.
* P-C animation LOD scheduler and mixer cap.
* P-E presence details (head-turn, footstep dust, blob shadows).
* **Exit test:** a 40-villager square at 60 fps; face-count unchanged; walk
  cycle visible in the offline render.

### Step 4 — Rivers that read as water
* R-A flow/bank attributes, R-B water material, R-C wet band, R-D reeds/rocks.
* **Exit test:** three renders (bank close-up, bridge crossing, valley from
  above); frame cost of the water shader < 0.8 ms on the balanced preset.

### Step 5 — Ship it
* A4 worker chunking, A5 loading screen, A6 persistence, A7 audio, A8 settings,
  A9 input/accessibility, A10 mobile preset.
* **Exit test:** cold load < 3 s to interactive, 60 fps desktop / 30 fps mobile
  on the low preset, quest progress survives a reload, settings persist.

### Step 6 (optional, asset-grade)
Swap in authored glTF characters and scanned bark/leaf textures, compressed with
`gltf-transform` + KTX2. This is the only step that needs external asset
downloads, and it is deliberately last because everything above is achievable
with zero-external-asset procedural content — which is this project's actual
superpower.

---

## 6. Budget summary (balanced preset, desktop)

| Layer | Measured today (worst view) | After Step 1 | After Steps 2–4 | Triangles visible |
| --- | --- | --- | --- | --- |
| Settlements (14) | 93 calls / 366 k | 93 | ~40 (atlas) | 366 k → 300 k |
| Roads & yards | **517 calls** / 89 k | **~6** | ~6 | 89 k |
| Nature | 278 calls / 157 k | **~85** | ~85 + grass | 157 k → 220 k (much better looking) |
| Wilderness | 14 / 23 k | 14 | 14 | 23 k |
| People | ~40 (in settlements) | 40 | 40 hero + 1 crowd | 40 k |
| Water | 6 | 6 | 6 | 8 k |
| **Total visible** | **888 calls / 0.64 M** | **~280 / 0.64 M** | **~300 / 0.75 M** | |

Note what this table says: after Step 1 we are *inside* the budget at roughly the
current visual quality, which leaves the entire triangle budget (2 M, we use
0.75 M) free for Step 2–4 to spend on leaf cards, grass and better people. That
is exactly the trade the plan is designed to make.

The honest headline: **the plan is not about adding detail, it is about spending
the same budget on the right detail** — and the audit shows there is far more
budget to spend than it looked, once the submission cost is fixed. Leaf cards + impostors + wind + grass will
look dramatically better than today's spheres *and* cost fewer triangles; rigged
people cost the same draw calls as the rigid clones but move; and a half-dozen
shader lines make the rivers read as water instead of a moving pattern.

---

## 7. Risks and how the plan absorbs them

| Risk | Mitigation |
| --- | --- |
| Leaf-card overdraw kills fill rate on integrated GPUs | Cards are alpha-*tested*, LOD0 bubble is 150 m, grass ring 60 m; measure with A1 before widening |
| Impostor atlas bloats VRAM | 8 × 8 × 5 species at 512² per frame = 40 MB; halve to 4 × 4 for the low preset |
| Procedural rig looks like a puppet | Keep it stylised (the whole world is), ship clips before faces; authored glTF is the Step 6 escape hatch |
| Water transparency + depth reads are expensive | Fast path: opaque-ish water, bank attribute instead of scene depth, no refraction |
| Worker chunking introduces race conditions | Chunking is already a pure function of (cx, cz) — the worker returns geometry buffers only, no scene mutation |
| Scope creep across five steps | Each step has a hard numeric exit test and its own commit; a step that misses its number is not started twice |

---

## 8. What I need from you

The plan above is ordered by "visual return per unit of risk", but the order can
change. Three decision points:

1. **Do we keep the zero-asset procedural identity?** Everything in Steps 1–5 is
   doable with no downloads. Step 6 introduces authored assets and external
   licences (CC0/Mixamo). My recommendation: stay procedural through Step 5.
2. **Where does the time go first?** My recommendation is Step 1 → Step 2
   (trees are on screen 90 % of the time), then Step 4 (rivers are cheap and
   high-impact), then Step 3 (people are the biggest single chunk of work).
3. **Is mobile a real target or a nice-to-have?** If real, A10 moves into Step 1
   and the triangle budget halves from the start.

---

## 9. Appendix — recorded audit output

`npm run audit` (balanced preset assumptions, seed data):

```
Mildvar square      · 806 near trees / 6387 far
  settlements   93 calls   366k
  wilderness    14 calls    23k
  roads        517 calls    89k
  nature       259 calls   156k   (9 near + 98 far tiles)
  TOTAL        883 calls   0.63M

village lane        · 822 near trees / 6372 far
  total        888 calls   0.64M   (10 near + 97 far tiles)

hilltop (600 m out) · 816 near trees / 6364 far
  total        902 calls   0.64M   (12 near + 97 far tiles)
```

Re-run it after every step; the numbers in §6 are the gate.


---

## 10. Step 1 result (recorded)

```
npm run audit          # after Step 1
Mildvar square      roads 8 · nature 73 · settlements 93 · wilderness 14  → 188 calls / 0.64 M
village lane        roads 8 · nature 73 · settlements 93 · wilderness 14  → 188 calls / 0.64 M
hilltop (600 m out) roads 8 · nature 87 · settlements 93 · wilderness 14  → 202 calls / 0.64 M
worst view 202 calls → WITHIN BUDGET (< 300)
```

At runtime the real number will be lower still (the audit counts every
settlement, while the camera frustum rejects the ones behind you) and higher in
town (interiors, props and people). The `F3` overlay reports the true figure per
layer.
