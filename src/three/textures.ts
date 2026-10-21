import * as THREE from 'three';
import { mulberry32, fbm } from './noise';

function makeCanvas(size: number) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

function finish(c: HTMLCanvasElement, srgb = true, anis = 8) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anis;
  t.needsUpdate = true;
  return t;
}

function addNoise(ctx: CanvasRenderingContext2D, size: number, amount: number, rng: () => number) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

export function cobblestoneTexture(size = 512) {
  const rng = mulberry32(11);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#6e6659';
  ctx.fillRect(0, 0, size, size);
  const cell = size / 14;
  const stones: { x: number; y: number; rx: number; ry: number; col: string; rot: number }[] = [];
  for (let gy = 0; gy < 14; gy++) {
    for (let gx = 0; gx < 14; gx++) {
      const x = (gx + 0.5 + (gy % 2) * 0.5) * cell + (rng() - 0.5) * cell * 0.3;
      const y = (gy + 0.5) * cell + (rng() - 0.5) * cell * 0.25;
      const l = 120 + rng() * 70;
      const warm = rng();
      const col = `rgb(${Math.round(l + warm * 18)},${Math.round(l + warm * 8)},${Math.round(l - warm * 10)})`;
      stones.push({ x, y, rx: cell * (0.42 + rng() * 0.1), ry: cell * (0.36 + rng() * 0.1), col, rot: (rng() - 0.5) * 0.6 });
    }
  }
  for (const s of stones) {
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        ctx.save();
        ctx.translate(s.x + ox * size, s.y + oy * size);
        ctx.rotate(s.rot);
        // shadow
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.ellipse(2, 3, s.rx, s.ry, 0, 0, Math.PI * 2);
        ctx.fill();
        const grad = ctx.createRadialGradient(-s.rx * 0.3, -s.ry * 0.4, 1, 0, 0, s.rx);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(1, s.col);
        ctx.fillStyle = grad;
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.ellipse(0, 0, s.rx, s.ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }
  }
  addNoise(ctx, size, 28, rng);
  const t = finish(c);
  return t;
}

export function roofTileTexture(size = 512) {
  const rng = mulberry32(23);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#9a8a7c';
  ctx.fillRect(0, 0, size, size);
  const rows = 12;
  const cols = 10;
  const th = size / rows;
  const tw = size / cols;
  for (let r = rows; r >= -1; r--) {
    const off = (r % 2) * tw * 0.5;
    for (let cI = -1; cI <= cols; cI++) {
      const x = cI * tw + off;
      const y = r * th;
      const l = 165 + rng() * 60;
      ctx.fillStyle = `rgb(${Math.round(l + 20)},${Math.round(l)},${Math.round(l - 15)})`;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + tw, y);
      ctx.lineTo(x + tw, y + th * 0.75);
      ctx.quadraticCurveTo(x + tw * 0.5, y + th * 1.25, x, y + th * 0.75);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(40,20,10,0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // shade at bottom edge
      const g = ctx.createLinearGradient(0, y + th * 0.3, 0, y + th * 1.2);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.4)');
      ctx.fillStyle = g;
      ctx.fill();
    }
  }
  addNoise(ctx, size, 20, rng);
  return finish(c);
}

export function stoneWallTexture(size = 512) {
  const rng = mulberry32(37);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#7a7268';
  ctx.fillRect(0, 0, size, size);
  const rows = 10;
  const rh = size / rows;
  for (let r = 0; r < rows; r++) {
    let x = -rng() * 40;
    const y = r * rh;
    while (x < size) {
      const w = rh * (1.1 + rng() * 1.6);
      const l = 150 + rng() * 70;
      const warm = rng() * 14;
      ctx.fillStyle = `rgb(${Math.round(l + warm)},${Math.round(l + warm * 0.5)},${Math.round(l - warm * 0.5)})`;
      const inset = 2.5;
      for (const ox of [0, size]) {
        ctx.beginPath();
        ctx.roundRect(x + inset - ox, y + inset, w - inset * 2, rh - inset * 2, 4);
        ctx.fill();
        const g = ctx.createLinearGradient(x - ox, y, x - ox, y + rh);
        g.addColorStop(0, 'rgba(255,255,255,0.18)');
        g.addColorStop(1, 'rgba(0,0,0,0.28)');
        ctx.fillStyle = g;
        ctx.fill();
        ctx.fillStyle = `rgb(${Math.round(l + warm)},${Math.round(l + warm * 0.5)},${Math.round(l - warm * 0.5)})`;
      }
      x += w;
    }
  }
  addNoise(ctx, size, 26, rng);
  return finish(c);
}

export function plasterTexture(size = 256) {
  const rng = mulberry32(41);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.05, y * 0.05, 3);
      const v = 225 + n * 30 + (rng() - 0.5) * 12;
      const i = (y * size + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(c);
}

export function woodTexture(size = 256) {
  const rng = mulberry32(53);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#b48a5c';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    const x = rng() * size;
    ctx.strokeStyle = `rgba(${60 + rng() * 40},${30 + rng() * 25},${10 + rng() * 15},${0.25 + rng() * 0.35})`;
    ctx.lineWidth = 1 + rng() * 3;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + (rng() - 0.5) * 20, size * 0.3, x + (rng() - 0.5) * 20, size * 0.7, x, size);
    ctx.stroke();
  }
  addNoise(ctx, size, 18, rng);
  return finish(c);
}

export function grassTexture(size = 512) {
  const rng = mulberry32(67);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.03, y * 0.03, 4);
      const n2 = fbm(x * 0.15 + 50, y * 0.15 + 50, 2);
      let v = 190 + n * 50 + n2 * 30 + (rng() - 0.5) * 30;
      const i = (y * size + x) * 4;
      img.data[i] = v * 0.86;
      img.data[i + 1] = v;
      img.data[i + 2] = v * 0.72;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(c);
}

export function waterNormalTexture(size = 256) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const h = (x: number, y: number) => fbm(((x % size) + size) % size * 0.04, ((y % size) + size) % size * 0.04, 3) + fbm(x * 0.12, y * 0.12, 2) * 0.4;
  const s = 6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * s;
      const dy = (h(x, y + 1) - h(x, y - 1)) * s;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = (-dx / len * 0.5 + 0.5) * 255;
      img.data[i + 1] = (-dy / len * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, false, 4);
}

export function awningTexture(color: string, size = 128) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#f7f1e3';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = color;
  const stripes = 6;
  const sw = size / stripes;
  for (let i = 0; i < stripes; i += 2) ctx.fillRect(i * sw, 0, sw, size);
  const t = finish(c);
  return t;
}

/** Combed straw thatch with sagging courses. */
export function thatchTexture(size = 512) {
  const rng = mulberry32(97);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#b9944f';
  ctx.fillRect(0, 0, size, size);
  const rows = 22;
  const rh = size / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * rh;
    for (let i = 0; i < 220; i++) {
      const x = rng() * size;
      const len = rh * (0.8 + rng() * 0.9);
      const l = 150 + rng() * 80;
      ctx.strokeStyle = `rgba(${Math.round(l + 25)},${Math.round(l)},${Math.round(l * 0.55)},${0.35 + rng() * 0.4})`;
      ctx.lineWidth = 1 + rng() * 1.6;
      ctx.beginPath();
      ctx.moveTo(x, y + rh);
      ctx.quadraticCurveTo(x + (rng() - 0.5) * 6, y + rh - len * 0.6, x + (rng() - 0.5) * 10, y + rh - len);
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(60,40,15,${0.1 + rng() * 0.12})`;
    ctx.fillRect(0, y, size, 2);
  }
  addNoise(ctx, size, 22, rng);
  return finish(c);
}

/** Dark graduated slate tiles. */
export function slateTexture(size = 512) {
  const rng = mulberry32(113);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#3d4550';
  ctx.fillRect(0, 0, size, size);
  const rows = 14;
  const cols = 7;
  const th = size / rows;
  const tw = size / cols;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * tw * 0.5;
    for (let ci = -1; ci <= cols; ci++) {
      const x = ci * tw + off;
      const y = r * th;
      const l = 58 + rng() * 40 + (1 - r / rows) * 14;
      const blue = rng() * 14;
      ctx.fillStyle = `rgb(${Math.round(l - blue * 0.3)},${Math.round(l)},${Math.round(l + blue)})`;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + tw - 1.5, y);
      ctx.lineTo(x + tw - 2.5, y + th - 2);
      ctx.lineTo(x + 1, y + th - 2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(8,10,14,0.6)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const g = ctx.createLinearGradient(0, y, 0, y + th);
      g.addColorStop(0, 'rgba(255,255,255,0.13)');
      g.addColorStop(1, 'rgba(0,0,0,0.35)');
      ctx.fillStyle = g;
      ctx.fill();
    }
  }
  addNoise(ctx, size, 16, rng);
  return finish(c);
}

/** Packed earth / dirt road with wheel ruts and scattered pebbles. */
export function dirtRoadTexture(size = 512) {
  const rng = mulberry32(131);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#8a7350';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 260; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const w = 20 + rng() * 70;
    ctx.fillStyle = `rgba(${120 + rng() * 50},${100 + rng() * 40},${70 + rng() * 30},0.16)`;
    ctx.beginPath();
    ctx.ellipse(x, y, w, 6 + rng() * 18, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // ruts
  for (const ry of [size * 0.3, size * 0.7]) {
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = `rgba(70,55,38,${0.06 + rng() * 0.1})`;
      ctx.beginPath();
      ctx.ellipse(rng() * size, ry + (rng() - 0.5) * 22, 8 + rng() * 30, 3 + rng() * 5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // pebbles
  for (let i = 0; i < 700; i++) {
    const l = 120 + rng() * 90;
    ctx.fillStyle = `rgba(${l},${l * 0.92},${l * 0.8},${0.5 + rng() * 0.4})`;
    ctx.beginPath();
    ctx.ellipse(rng() * size, rng() * size, 1 + rng() * 2.6, 1 + rng() * 2, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  addNoise(ctx, size, 26, rng);
  return finish(c);
}

/** Furrowed field planted with a crop. */
export function cropTexture(base: [number, number, number], size = 256) {
  const rng = mulberry32(Math.round(base[0] * 7 + base[1] * 13 + base[2] * 3));
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = `rgb(${base[0] * 0.5},${base[1] * 0.5},${base[2] * 0.45})`;
  ctx.fillRect(0, 0, size, size);
  const furrows = 16;
  const fh = size / furrows;
  for (let f = 0; f < furrows; f++) {
    const y = f * fh;
    ctx.fillStyle = `rgb(${Math.round(base[0] * 0.45)},${Math.round(base[1] * 0.4)},${Math.round(base[2] * 0.32)})`;
    ctx.fillRect(0, y + fh * 0.78, size, fh * 0.22);
    for (let i = 0; i < 90; i++) {
      const x = rng() * size;
      const l = 0.75 + rng() * 0.6;
      ctx.fillStyle = `rgb(${Math.min(255, base[0] * l)},${Math.min(255, base[1] * l)},${Math.min(255, base[2] * l * 0.8)})`;
      ctx.beginPath();
      ctx.ellipse(x, y + fh * (0.2 + rng() * 0.45), 2 + rng() * 4, 1.6 + rng() * 2.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  addNoise(ctx, size, 18, rng);
  return finish(c);
}

/** Mottled granite / boulder. */
export function rockTexture(size = 256) {
  const rng = mulberry32(151);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#8d8b86';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 200; i++) {
    const l = 100 + rng() * 90;
    ctx.fillStyle = `rgba(${l},${l * 0.99},${l * 0.96},0.2)`;
    ctx.beginPath();
    ctx.ellipse(rng() * size, rng() * size, 8 + rng() * 40, 6 + rng() * 30, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 40; i++) {
    ctx.strokeStyle = `rgba(60,58,55,${0.15 + rng() * 0.2})`;
    ctx.lineWidth = 1 + rng() * 2;
    ctx.beginPath();
    const x = rng() * size;
    const y = rng() * size;
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng() - 0.5) * 90, y + (rng() - 0.5) * 90);
    ctx.stroke();
  }
  addNoise(ctx, size, 20, rng);
  return finish(c);
}

export interface TextureSet {
  cobble: THREE.Texture;
  tiles: THREE.Texture;
  slate: THREE.Texture;
  thatch: THREE.Texture;
  stone: THREE.Texture;
  plaster: THREE.Texture;
  wood: THREE.Texture;
  grass: THREE.Texture;
  dirt: THREE.Texture;
  rock: THREE.Texture;
  crops: THREE.Texture[];
  waterNormal: THREE.Texture;
  awnings: THREE.Texture[];
}

export function createTextures(): TextureSet {
  return {
    cobble: cobblestoneTexture(),
    tiles: roofTileTexture(),
    slate: slateTexture(),
    thatch: thatchTexture(),
    stone: stoneWallTexture(),
    plaster: plasterTexture(),
    wood: woodTexture(),
    grass: grassTexture(),
    dirt: dirtRoadTexture(),
    rock: rockTexture(),
    crops: [
      cropTexture([214, 178, 84]),  // wheat
      cropTexture([196, 186, 110]), // barley
      cropTexture([96, 140, 66]),   // greens
      cropTexture([140, 112, 74]),  // fallow
    ],
    waterNormal: waterNormalTexture(),
    awnings: ['#c8403a', '#2f7d5b', '#d9a632', '#3b6fb6'].map((c) => awningTexture(c)),
  };
}
