import * as THREE from 'three';
import { Collector, box, mat4, pyramid, gableRoof } from '../geometry';
import { RNG, range, pick } from '../noise';
import { addHouse, randomHouseOpts, Obb } from '../buildings';
import {
  addBarn, addWatchtower, addDock, addBoat, addFence, addCrateCluster,
  addSignpost, addTrough, addWoodpile, addTent, addShrine, addStoneCircle, addHaystack, addFlag
} from './structures';
import { terrainHeight, LAKE, FORT, platforms, WATCHTOWER_SITES, type WatchtowerSpec } from './land';
import type { InteractionSystem } from './interactables';

export interface WildernessCtx {
  c: Collector;
  rng: RNG;
  obbs: Obb[];
  trees: { x: number; z: number; scale: number; kind: 'round' | 'conifer'; color: THREE.Color }[];
  lamps: { pos: THREE.Vector3; light: boolean }[];
  soldierPatrols: { x: number; y: number; z: number; rot: number; type: 'guard' | 'archer' | 'officer' }[];
  interactions: InteractionSystem;
}

/* ================================================================== *
 *  1. LAKE ELDERMERE (Silvermere) & Waterfront Fishing Hamlet         *
 * ================================================================== */
/** Positions come from land.ts so terrain, water and props can never disagree. */
export const LAKE_POS = { x: LAKE.x, z: LAKE.z, r: LAKE.r, waterY: LAKE.y };
export const GARRISON_POS = { x: FORT.x, z: FORT.z, w: FORT.w, d: FORT.d };

export function buildLakeEldermere(ctx: WildernessCtx) {
  const { c, rng } = ctx;
  const lx = LAKE.x;
  const lz = LAKE.z;
  const wy = LAKE.y;
  // (the lake's water surface is a real water mesh built by the world, see createLake)

  // 1. Central Islet with Sacred Moon Shrine & Weeping Willows
  const isletX = LAKE.islet.x;
  const isletZ = LAKE.islet.z;
  const isletY = wy + 0.6;
  c.add('stone', new THREE.CylinderGeometry(15, 19, 1.0, 16), mat4(isletX, isletY - 0.5, isletZ), 0x7c7870);
  addShrine(c, mat4(isletX, isletY + 0.1, isletZ, 0.4));
  ctx.obbs.push({ cx: isletX, cz: isletZ, hw: 6, hd: 6, rot: 0 });

  // Shrine Islet Willows
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.2;
    const tx = isletX + Math.cos(a) * 11;
    const tz = isletZ + Math.sin(a) * 11;
    ctx.trees.push({
      x: tx,
      z: tz,
      scale: 1.15,
      kind: 'round',
      color: new THREE.Color(0x5a9a42),
    });
  }

  // 3. Waterfront Fishing Piers, Boats & Fisherman's Lodge (Southern Shore)
  const shoreX = lx + 40;
  const shoreZ = lz + LAKE.r + 6; // on the dry shelf just past the shoreline
  const shoreY = terrainHeight(shoreX, shoreZ);

  // Main fishing jetty: starts on the shelf and runs straight out over the water (-z)
  const dockLen = 40;
  addDock(c, mat4(shoreX, wy + 0.85, shoreZ, Math.PI), dockLen, 4.2);
  platforms.push({ x: shoreX, z: shoreZ - dockLen / 2, dx: 0, dz: -1, halfLen: dockLen / 2, halfW: 2.1, deckY: wy + 1.95, pierBottom: wy - 3 });
  addBoat(c, mat4(shoreX - 7, wy + 0.1, shoreZ - 24, 0.8), 0x5a3f28);
  addBoat(c, mat4(shoreX + 7, wy + 0.1, shoreZ - 31, -0.4), 0x6b4a2e);

  // Fisherman's Lodge
  const lodgeOpts = randomHouseOpts(rng, 1.0, {
    roofMat: 'thatch',
    roofs: [0xb08b46, 0xa37f3e],
    plasters: [0xe8dec8],
    stones: [0x9a9385],
    shutters: [0x3d6b4f],
    styles: { stone: 0.5, plaster: 0.2, timber: 0.3 },
    floorsMax: 1,
  });
  const lodgeRot = Math.PI * 0.9;
  addHouse(c, mat4(shoreX + 22, shoreY - 0.05, shoreZ + 14, lodgeRot), lodgeOpts, rng);
  ctx.obbs.push({ cx: shoreX + 22, cz: shoreZ + 14, hw: lodgeOpts.w / 2, hd: lodgeOpts.d / 2, rot: lodgeRot });
  ctx.interactions.registerDoor({
    id: 'door_lake_lodge', title: "Eldermere Fisherman's Lodge",
    x: shoreX + 22, y: shoreY - 0.05, z: shoreZ + 14, rot: lodgeRot,
    doorZ: lodgeOpts.d / 2 + 0.45, interior: 'cottage',
  });

  // Fishing accessories: crates, drying nets, woodpile, lanterns
  addCrateCluster(c, mat4(shoreX + 6, shoreY + 0.1, shoreZ + 6, rng()), rng);
  addWoodpile(c, mat4(shoreX + 16, shoreY + 0.1, shoreZ + 18, 0.4), rng);
  addSignpost(c, mat4(shoreX + 2, shoreY + 0.1, shoreZ + 12, -0.5), [{ rot: 0.2, len: 2.2 }, { rot: -0.7, len: 1.8 }]);

  // Shore Lanterns
  ctx.lamps.push({ pos: new THREE.Vector3(shoreX + 1, shoreY + 4.2, shoreZ + 8), light: true });
}

/* ================================================================== *
 *  2. DENSE FOREST (The Whispering Weald / Ironwood Forest)          *
 * ================================================================== */
export const WEALD_POS = { x: -2150, z: -2150, r: 480 };

export function buildWhisperingWeald(ctx: WildernessCtx) {
  const { c, rng } = ctx;
  const wx = WEALD_POS.x;
  const wz = WEALD_POS.z;
  const wy = terrainHeight(wx, wz);

  // 1. Woodcutter's / Trapper's Lodge in a shaded forest clearing
  const cabinOpts = randomHouseOpts(rng, 1.05, {
    roofMat: 'thatch',
    roofs: [0x8f7038, 0xa37f3e],
    plasters: [0xded4bf],
    stones: [0x7f7c75],
    shutters: [0x4a3a2a],
    styles: { stone: 0.3, plaster: 0.1, timber: 0.6 },
    floorsMax: 1,
  });
  const cabinRot = 0.55;
  addHouse(c, mat4(wx, wy - 0.05, wz, cabinRot), cabinOpts, rng);
  ctx.obbs.push({ cx: wx, cz: wz, hw: cabinOpts.w / 2, hd: cabinOpts.d / 2, rot: cabinRot });
  ctx.interactions.registerDoor({
    id: 'door_weald_cabin', title: "Woodcutter's Cabin",
    x: wx, y: wy - 0.05, z: wz, rot: cabinRot,
    doorZ: cabinOpts.d / 2 + 0.45, interior: 'cottage',
  });

  // Woodcutter's barn, lumber piles, chopping block
  const barnO = addBarn(c, mat4(wx + 16, terrainHeight(wx + 16, wz - 8), wz - 8, cabinRot + 0.3), 'thatch', rng);
  ctx.obbs.push({ cx: wx + 16, cz: wz - 8, hw: barnO.hw, hd: barnO.hd, rot: cabinRot + 0.3 });
  addWoodpile(c, mat4(wx - 8, wy + 0.05, wz + 6, 0.1), rng);
  addWoodpile(c, mat4(wx - 12, wy + 0.05, wz + 8, -0.4), rng);
  addCrateCluster(c, mat4(wx + 4, wy + 0.05, wz + 7, 0.8), rng);
  addTrough(c, mat4(wx + 10, wy + 0.05, wz + 2, 1.2));

  // 2. Ancient Druid Stone Circle & Megaliths in deep woods
  const circleX = wx - 140;
  const circleZ = wz - 110;
  addStoneCircle(c, mat4(circleX, terrainHeight(circleX, circleZ), circleZ, 0.2), rng, 12, 16);
  ctx.obbs.push({ cx: circleX, cz: circleZ, hw: 14, hd: 14, rot: 0 });

  // 3. Dense titan trees clustered heavily around the region
  const titanGreens = [0x244a22, 0x1f421d, 0x2d5a28, 0x1c3d1b, 0x38612f];
  for (let i = 0; i < 340; i++) {
    const a = rng() * Math.PI * 2;
    const dist = range(rng, 35, WEALD_POS.r);
    const tx = wx + Math.cos(a) * dist;
    const tz = wz + Math.sin(a) * dist;
    // Don't place on cabin clearing
    if (Math.hypot(tx - wx, tz - wz) < 32 || Math.hypot(tx - circleX, tz - circleZ) < 24) continue;
    ctx.trees.push({
      x: tx,
      z: tz,
      scale: range(rng, 1.4, 2.3),
      kind: rng() < 0.65 ? 'conifer' : 'round',
      color: new THREE.Color(pick(rng, titanGreens)),
    });
  }

  // Mossy forest boulders & fallen logs
  for (let i = 0; i < 28; i++) {
    const bx = wx + (rng() - 0.5) * WEALD_POS.r * 1.5;
    const bz = wz + (rng() - 0.5) * WEALD_POS.r * 1.5;
    const by = terrainHeight(bx, bz);
    c.add('rock', new THREE.DodecahedronGeometry(range(rng, 1.2, 2.8), 0), mat4(bx, by + 0.4, bz, rng() * 3), 0x5a6355);
  }
}

/* ================================================================== *
 *  3. DEFENSE GARRISON & MILITARY BASE FOR 100 SOLDIERS (Fort Ironspire)
 * ================================================================== */
export function buildFortIronspire(ctx: WildernessCtx) {
  const { c, rng } = ctx;
  const gx = FORT.x;
  const gz = FORT.z;
  const gy = FORT.y;
  const W = FORT.w;
  const D = FORT.d;
  const stoneCol = 0x828487;
  const timberCol = 0x4a3625;
  const bannerRed = 0x9e2424;

  const pushObb = (cx: number, cz: number, hw: number, hd: number, rot = 0) => {
    ctx.obbs.push({ cx, cz, hw, hd, rot });
  };

  // 1. Packed Dirt Drill Ground & Fort Courtyard
  const courtGeo = new THREE.PlaneGeometry(W + 6, D + 6, 4, 4);
  courtGeo.rotateX(-Math.PI / 2);
  courtGeo.computeVertexNormals();
  c.add('dirt', courtGeo, mat4(gx, gy + 0.08, gz));

  // 2. Heavy Stone Curtain Walls (Perimeter)
  const wallH = 6.2;
  const wallThick = 1.4;
  const hw = W / 2;
  const hd = D / 2;

  // North, South, West curtain walls
  // North Wall
  c.add('stone', box(W - 12, wallH, wallThick), mat4(gx, gy + wallH / 2, gz - hd), stoneCol);
  // South Wall
  c.add('stone', box(W - 12, wallH, wallThick), mat4(gx, gy + wallH / 2, gz + hd), stoneCol);
  // West Wall
  c.add('stone', box(wallThick, wallH, D - 12), mat4(gx - hw, gy + wallH / 2, gz), stoneCol);
  // East Wall (Flanking the Gatehouse)
  const gateGap = 16;
  const eastWingLen = (D - gateGap) / 2;
  c.add('stone', box(wallThick, wallH, eastWingLen), mat4(gx + hw, gy + wallH / 2, gz - hd + eastWingLen / 2), stoneCol);
  c.add('stone', box(wallThick, wallH, eastWingLen), mat4(gx + hw, gy + wallH / 2, gz + hd - eastWingLen / 2), stoneCol);

  // Wooden Ramparts / Catwalks on internal wall perimeter
  const rampW = 1.8;
  const rampY = wallH - 1.4;
  c.add('wood', box(W - 16, 0.25, rampW), mat4(gx, gy + rampY, gz - hd + rampW / 2 + wallThick / 2), timberCol);
  c.add('wood', box(W - 16, 0.25, rampW), mat4(gx, gy + rampY, gz + hd - rampW / 2 - wallThick / 2), timberCol);
  c.add('wood', box(rampW, 0.25, D - 16), mat4(gx - hw + rampW / 2 + wallThick / 2, gy + rampY, gz), timberCol);

  // 3. Four Corner Defensive Bastion Towers (Square with Battlements)
  const towerS = 8.5;
  const towerH = 10.5;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const tx = gx + sx * hw;
      const tz = gz + sz * hd;
      // Stone Tower Body
      c.add('stone', box(towerS, towerH, towerS), mat4(tx, gy + towerH / 2, tz), 0x76787b);
      // Crenellated Parapet
      c.add('stone', box(towerS + 0.8, 1.2, towerS + 0.8), mat4(tx, gy + towerH + 0.5, tz), 0x8c8f94);
      // Signal Fire Brazier on tower top
      c.add('flat', new THREE.CylinderGeometry(0.8, 0.5, 0.9, 8), mat4(tx, gy + towerH + 1.6, tz), 0x2a2522);
      c.add('flat', new THREE.SphereGeometry(0.5, 6, 4), mat4(tx, gy + towerH + 2.1, tz), 0xf27d16);
      // Tower Flag Standard
      addFlag(c, mat4(tx + 2.5 * sx, gy + towerH + 1.0, tz + 2.5 * sz, sx > 0 ? 0 : Math.PI), bannerRed);
      pushObb(tx, tz, towerS / 2 + 0.5, towerS / 2 + 0.5);

      // Stationed tower archer
      ctx.soldierPatrols.push({
        x: tx,
        y: gy + towerH + 1.1,
        z: tz,
        rot: Math.atan2(sx, sz),
        type: 'archer',
      });
    }
  }

  // 4. Fortified Gatehouse with Portcullis & Drawbridge
  const gateX = gx + hw;
  const gateZ = gz;
  // Twin Gate Towers
  for (const sz of [-1, 1]) {
    const gtz = gateZ + sz * (gateGap / 2 + 2.5);
    c.add('stone', box(7, towerH - 1, 6), mat4(gateX, gy + (towerH - 1) / 2, gtz), 0x7a7c80);
    c.add('stone', pyramid(7.2, 3.5), mat4(gateX, gy + towerH - 1, gtz), 0x3d4550);
    pushObb(gateX, gtz, 4, 3.5);
  }
  // Overhead Arch connecting Gate Towers
  c.add('stone', box(6.5, 3.2, gateGap + 4), mat4(gateX, gy + wallH + 1.6, gateZ), 0x828487);
  // Heavy timber double doors — swung open inward so the gate is passable
  for (const s of [-1, 1]) {
    const leaf = mat4(gateX - 2.6, gy + 2.6, gateZ + s * 5.2, s * 1.15);
    c.add('wood', box(0.3, 5.2, 6.4), leaf, 0x3d2816);
    c.add('flat', box(0.34, 0.12, 6.0), leaf.clone().multiply(mat4(0, 1.6, 0)), 0x1f1f22);
    c.add('flat', box(0.34, 0.12, 6.0), leaf.clone().multiply(mat4(0, -1.6, 0)), 0x1f1f22);
    ctx.obbs.push({ cx: gateX - 2.6, cz: gateZ + s * 5.2, hw: 0.3, hd: 3.2, rot: s * 1.15 });
  }
  // Iron Portcullis — raised into the arch (bottom edge 3.6 m above the ground)
  for (let k = 0; k < 6; k++) {
    c.add('flat', box(0.12, 5.2, 0.12), mat4(gateX + 0.4, gy + 6.2, gateZ - 3 + k * 1.2), 0x1f1f22);
  }
  // Iron-spiked barricades flank the approach road, never cross it
  for (let i = 0; i < 4; i++) {
    const obX = gateX + 8 + i * 3;
    const obZ = gateZ + (i % 2 === 0 ? -1 : 1) * 10.5;
    c.add('wood', box(3.2, 0.25, 0.25), mat4(obX, gy + 0.8, obZ, 0.8), 0x5a3f28);
    c.add('wood', box(3.2, 0.25, 0.25), mat4(obX, gy + 0.8, obZ, -0.8), 0x5a3f28);
    ctx.obbs.push({ cx: obX, cz: obZ, hw: 1.6, hd: 1.6, rot: 0 });
  }

  // 5. Three Large Soldier Barracks (Multi-story, housing 100 troops)
  const barrackW = 28;
  const barrackD = 12;
  const barrackH = 7.5;
  // Barracks 1 (North Side)
  const b1X = gx - 12;
  const b1Z = gz - hd + 18;
  c.add('stone', box(barrackW, barrackH, barrackD), mat4(b1X, gy + barrackH / 2, b1Z), 0x8f8c87);
  c.add('slate', gableRoof(barrackD + 1.2, barrackW + 1.2, 5.0, 0.6), mat4(b1X, gy + barrackH, b1Z, Math.PI / 2), 0x3d4550);
  pushObb(b1X, b1Z, barrackW / 2 + 1, barrackD / 2 + 1);

  // Barracks 2 (South Side)
  const b2X = gx - 12;
  const b2Z = gz + hd - 18;
  c.add('stone', box(barrackW, barrackH, barrackD), mat4(b2X, gy + barrackH / 2, b2Z), 0x8f8c87);
  c.add('slate', gableRoof(barrackD + 1.2, barrackW + 1.2, 5.0, 0.6), mat4(b2X, gy + barrackH, b2Z, Math.PI / 2), 0x3d4550);
  pushObb(b2X, b2Z, barrackW / 2 + 1, barrackD / 2 + 1);

  // Barracks 3 (West Side, near Wall)
  const b3X = gx - hw + 16;
  const b3Z = gz;
  c.add('stone', box(barrackD, barrackH, barrackW - 6), mat4(b3X, gy + barrackH / 2, b3Z), 0x8f8c87);
  c.add('slate', gableRoof(barrackW - 5, barrackD + 1.2, 5.0, 0.6), mat4(b3X, gy + barrackH, b3Z), 0x3d4550);
  pushObb(b3X, b3Z, barrackD / 2 + 1, (barrackW - 6) / 2 + 1);

  // 6. Commander's Headquarters / War Room Manor
  const hqX = gx + 10;
  const hqZ = gz - 18;
  const hqW = 16;
  const hqD = 14;
  const hqH = 9.0;
  c.add('stone', box(hqW, hqH, hqD), mat4(hqX, gy + hqH / 2, hqZ), 0x9a9791);
  c.add('tiles', gableRoof(hqW + 1, hqD + 1, 4.6, 0.5), mat4(hqX, gy + hqH, hqZ), 0x7c2e2e);
  addFlag(c, mat4(hqX, gy + hqH + 4.8, hqZ), bannerRed);
  pushObb(hqX, hqZ, hqW / 2 + 1, hqD / 2 + 1);
  ctx.interactions.registerDoor({
    id: 'door_fort_hq', title: 'Fort Ironspire War Room',
    x: hqX, y: gy, z: hqZ, rot: 0, doorZ: hqD / 2 + 0.5, interior: 'keep',
  });

  // 7. Armory & Blacksmith with Forge
  const armX = gx + 12;
  const armZ = gz + 16;
  c.add('stone', box(14, 5.2, 10), mat4(armX, gy + 2.6, armZ), 0x78736d);
  c.add('slate', gableRoof(15, 11, 3.4, 0.5), mat4(armX, gy + 5.2, armZ), 0x3a404a);
  // Chimney & Forge
  c.add('stone', box(1.8, 7.5, 1.8), mat4(armX - 6, gy + 3.75, armZ - 4), 0x5a5550);
  // Anvil & weapon rack
  c.add('flat', box(0.6, 0.8, 1.2), mat4(armX + 2, gy + 0.4, armZ - 7), 0x222225);
  for (let i = 0; i < 5; i++) {
    c.add('flat', box(0.08, 2.4, 0.08), mat4(armX + 4 + i * 0.4, gy + 1.2, armZ - 6.5, 0.2), 0xc5c7cb);
  }
  pushObb(armX, armZ, 8, 6);

  // 8. Archery Practice Range with Target Butts
  const archX = gx - 6;
  const archZ = gz - 2;
  for (let i = 0; i < 4; i++) {
    const tz = archZ - 6 + i * 4;
    const tx = archX - 10;
    // Target post + straw disc
    c.add('wood', box(0.2, 2.4, 0.2), mat4(tx, gy + 1.2, tz), 0x5a3f28);
    c.add('thatch', new THREE.CylinderGeometry(0.9, 0.9, 0.35, 12), mat4(tx, gy + 1.6, tz).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)), 0xd4b86a);
    // Bullseye red ring
    c.add('flat', new THREE.CylinderGeometry(0.35, 0.35, 0.38, 12), mat4(tx, gy + 1.6, tz).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)), 0xb82e2e);
    // Arrows sticking into target
    c.add('flat', box(1.2, 0.05, 0.05), mat4(tx + 0.6, gy + 1.6 + (i % 2) * 0.2, tz + (i % 3) * 0.1, 0.1), 0x222222);
  }

  // 9. Combat Training Yard with Dummies & Sparring Ring
  const dummyX = gx - 4;
  const dummyZ = gz + 8;
  for (let i = 0; i < 4; i++) {
    const dx = dummyX + (i % 2) * 5;
    const dz = dummyZ + Math.floor(i / 2) * 5;
    // Wooden dummy post & crossbar
    c.add('wood', box(0.25, 2.2, 0.25), mat4(dx, gy + 1.1, dz), 0x5a3f28);
    c.add('wood', box(1.6, 0.2, 0.2), mat4(dx, gy + 1.6, dz), 0x5a3f28);
    c.add('thatch', new THREE.SphereGeometry(0.45, 8, 6), mat4(dx, gy + 1.4, dz), 0xcfb265);
    c.add('flat', new THREE.SphereGeometry(0.28, 8, 6), mat4(dx, gy + 2.2, dz), 0x7a5a3a);
  }

  // 10. Military Supply Wagons & Horse Stables
  const stabX = gx + 18;
  const stabZ = gz - 2;
  // Horse stable shed
  c.add('wood', box(14, 4.2, 6), mat4(stabX, gy + 2.1, stabZ), 0x5a3f28);
  c.add('thatch', gableRoof(7, 15, 2.4, 0.4), mat4(stabX, gy + 4.2, stabZ), 0xb89248);
  for (let i = 0; i < 3; i++) {
    addHaystack(c, mat4(stabX - 6 + i * 6, gy, stabZ + 6), rng);
  }
  pushObb(stabX, stabZ, 8, 4);

  // 11. Central Muster Campfire & Benches
  const fireX = gx - 2;
  const fireZ = gz - 14;
  c.add('rock', new THREE.TorusGeometry(1.6, 0.35, 6, 12), mat4(fireX, gy + 0.15, fireZ).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)), 0x3d3835);
  c.add('flat', new THREE.SphereGeometry(0.7, 8, 6), mat4(fireX, gy + 0.45, fireZ), 0xf26418);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    c.add('wood', box(3.2, 0.4, 0.6), mat4(fireX + Math.cos(a) * 3.4, gy + 0.25, fireZ + Math.sin(a) * 3.4, a + Math.PI / 2), 0x4a321d);
  }

  // 12. Soldier Patrol Placeholders (Armored Guards)
  const patrolPoints = [
    // Gate guards
    { x: gateX + 2, y: gy + 0.9, z: gateZ - 3, rot: Math.PI / 2, type: 'guard' as const },
    { x: gateX + 2, y: gy + 0.9, z: gateZ + 3, rot: Math.PI / 2, type: 'guard' as const },
    // Parade ground & drills
    { x: gx - 2, y: gy + 0.9, z: gz - 8, rot: 0, type: 'officer' as const },
    { x: archX + 4, y: gy + 0.9, z: archZ - 4, rot: Math.PI, type: 'archer' as const },
    { x: archX + 4, y: gy + 0.9, z: archZ + 2, rot: Math.PI, type: 'archer' as const },
    { x: dummyX + 3, y: gy + 0.9, z: dummyZ, rot: -0.6, type: 'guard' as const },
    { x: b1X + 4, y: gy + 0.9, z: b1Z + 8, rot: 1.2, type: 'guard' as const },
    { x: b2X + 4, y: gy + 0.9, z: b2Z - 8, rot: -1.2, type: 'guard' as const },
    { x: hqX - 4, y: gy + 0.9, z: hqZ + 6, rot: 2.4, type: 'officer' as const },
    // Wall sentries
    { x: gx, y: gy + rampY + 0.9, z: gz - hd + 2, rot: 0, type: 'guard' as const },
    { x: gx, y: gy + rampY + 0.9, z: gz + hd - 2, rot: Math.PI, type: 'guard' as const },
    { x: gx - hw + 2, y: gy + rampY + 0.9, z: gz, rot: -Math.PI / 2, type: 'guard' as const },
  ];
  ctx.soldierPatrols.push(...patrolPoints);

  // Collision: the WALLS block, the courtyard does not (a single fort-sized box
  // would have shoved the player out before they ever reached the gate).
  pushObb(gx, gz - hd, (W - 12) / 2, wallThick / 2 + 0.3);
  pushObb(gx, gz + hd, (W - 12) / 2, wallThick / 2 + 0.3);
  pushObb(gx - hw, gz, wallThick / 2 + 0.3, (D - 12) / 2);
  pushObb(gx + hw, gz - hd + eastWingLen / 2, wallThick / 2 + 0.3, eastWingLen / 2);
  pushObb(gx + hw, gz + hd - eastWingLen / 2, wallThick / 2 + 0.3, eastWingLen / 2);
}

/* ================================================================== *
 *  4. THE SUNKEN MEADOW (Great Grassland & Prairie Plains)           *
 * ================================================================== */
export const MEADOW_POS = { x: 1850, z: 2200, r: 420 };

export function buildGoldenMeadow(ctx: WildernessCtx) {
  const { c, rng } = ctx;
  const mx = MEADOW_POS.x;
  const mz = MEADOW_POS.z;
  const my = terrainHeight(mx, mz);

  // 1. Shepherd's Stone Cottage
  const shepOpts = randomHouseOpts(rng, 0.95, {
    roofMat: 'thatch',
    roofs: [0xc09a52, 0xb08b46],
    plasters: [0xf0e2c0],
    stones: [0xd0bd97],
    shutters: [0x5c7a3a],
    styles: { stone: 0.7, plaster: 0.2, timber: 0.1 },
    floorsMax: 1,
  });
  addHouse(c, mat4(mx, my - 0.05, mz, 0.8), shepOpts, rng);
  ctx.obbs.push({ cx: mx, cz: mz, hw: shepOpts.w / 2, hd: shepOpts.d / 2, rot: 0.8 });
  ctx.interactions.registerDoor({
    id: 'door_mead_cottage', title: "Shepherd's Cottage",
    x: mx, y: my - 0.05, z: mz, rot: 0.8,
    doorZ: shepOpts.d / 2 + 0.45, interior: 'cottage',
  });

  // 2. Livestock Fold / Sheep Pen (Post & Rail Fences)
  const penX = mx + 20;
  const penZ = mz + 6;
  const penY = terrainHeight(penX, penZ);
  const penW = 28;
  const penD = 22;
  for (const [lx, lz, rot, len] of [
    [0, -penD / 2, 0, penW],
    [0, penD / 2, 0, penW],
    [-penW / 2, 0, Math.PI / 2, penD],
    [penW / 2, 0, Math.PI / 2, penD],
  ] as [number, number, number, number][]) {
    addFence(c, mat4(penX + lx, penY, penZ + lz, rot), len, 0, 0x6b4a2e);
  }
  addTrough(c, mat4(penX, penY + 0.1, penZ));
  addHaystack(c, mat4(penX + 8, penY, penZ - 5), rng);

  // 3. Solitary Ancient Great Oak Tree atop Hill
  const hillX = mx - 60;
  const hillZ = mz - 70;
  ctx.trees.push({
    x: hillX,
    z: hillZ,
    scale: 2.2,
    kind: 'round',
    color: new THREE.Color(0x6aa63c),
  });

  // Stone boundary cairns
  for (let i = 0; i < 6; i++) {
    const cx = mx + (rng() - 0.5) * 320;
    const cz = mz + (rng() - 0.5) * 320;
    const cy = terrainHeight(cx, cz);
    for (let k = 0; k < 4; k++) {
      c.add('rock', new THREE.DodecahedronGeometry(0.8 - k * 0.15, 0), mat4(cx, cy + k * 0.55, cz, k * 0.7), 0x9a958a);
    }
  }
}

/* ================================================================== *
 *  5. BORDER WATCHTOWERS ALONG HIGHWAYS & PASSES                     *
 * ================================================================== */
export { WATCHTOWER_SITES };

export function buildWatchtower(ctx: WildernessCtx, site: WatchtowerSpec) {
  const { c, rng } = ctx;
  const wx = site.x;
  const wz = site.z;
  const wy = terrainHeight(wx, wz);

  // Watchtower Structure
  addWatchtower(c, mat4(wx, wy, wz, site.rot));
  ctx.obbs.push({ cx: wx, cz: wz, hw: 3.6, hd: 3.6, rot: site.rot });

  // Guard Station Tent & Campfire
  const tentX = wx - Math.sin(site.rot) * 11;
  const tentZ = wz - Math.cos(site.rot) * 11;
  addTent(c, mat4(tentX, terrainHeight(tentX, tentZ), tentZ, site.rot + 0.4), rng);
  ctx.obbs.push({ cx: tentX, cz: tentZ, hw: 2.4, hd: 2.4, rot: site.rot + 0.4 });

  // Palisade barricade along highway edge
  const fenceX = wx + Math.sin(site.rot + Math.PI / 2) * 8;
  const fenceZ = wz + Math.cos(site.rot + Math.PI / 2) * 8;
  addFence(c, mat4(fenceX, terrainHeight(fenceX, fenceZ), fenceZ, site.rot), 12, 0, 0x5a3f28);

  // Highway Signal Lantern
  ctx.lamps.push({ pos: new THREE.Vector3(wx + 4, wy + 4.5, wz + 4), light: true });

  // Sentry Guard NPC
  ctx.soldierPatrols.push({
    x: wx + Math.sin(site.rot) * 4,
    y: wy + 0.9,
    z: wz + Math.cos(site.rot) * 4,
    rot: site.rot,
    type: 'guard',
  });

  // Signal brazier is a real interaction: it reports the road ahead.
  ctx.interactions.register({
    id: `brazier_${site.id}`,
    kind: 'shrine',
    title: `${site.name} Brazier`,
    prompt: 'Read the signal flame',
    pos: new THREE.Vector3(wx + Math.sin(site.rot) * 5.4, wy + 1.4, wz + Math.cos(site.rot) * 5.4),
    radius: 3.0,
    lines: [
      `${site.name} keeps a brazier burning day and night.`,
      'The watch rotates every four hours; cinders mark the road onward.',
      'A carved tally on the parapet records how many patrols have passed this season.',
    ],
  });
}

export function buildBorderWatchtowers(ctx: WildernessCtx) {
  for (const site of WATCHTOWER_SITES) buildWatchtower(ctx, site);
}
