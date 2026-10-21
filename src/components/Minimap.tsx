import React, { useState, useEffect, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { Engine } from '../three/engine';
import { ALL_LOCATIONS, roads, riverChains, bridges, LAKE, FORT } from '../three/world/land';
import { WEALD_POS, MEADOW_POS } from '../three/world/wilderness';

interface MinimapProps {
  engineRef: React.MutableRefObject<Engine | null>;
  onOpenFullMap: () => void;
  waterPhysicsOn: boolean;
  onToggleWaterPhysics: () => void;
}

interface Poly {
  pts: Float32Array; // x,z pairs
  minX: number; maxX: number; minZ: number; maxZ: number;
  color: string;
  width: number;
}

const ZOOM_RANGES = [320, 750, 1600, 3400];
const SIZE = 186;
const DRAW_INTERVAL = 1000 / 30;
const STATE_INTERVAL = 200;

/** Thin a sample list to roughly one point per `step` metres and record its bounds. */
function toPoly(points: { x: number; z: number }[], step: number, color: string, width: number): Poly {
  const out: number[] = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let lastX = NaN, lastZ = NaN;
  points.forEach((p, i) => {
    const last = i === points.length - 1;
    if (!last && !Number.isNaN(lastX) && Math.hypot(p.x - lastX, p.z - lastZ) < step) return;
    out.push(p.x, p.z);
    lastX = p.x; lastZ = p.z;
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  });
  return { pts: Float32Array.from(out), minX, maxX, minZ, maxZ, color, width };
}

export const Minimap: React.FC<MinimapProps> = ({ engineRef, onOpenFullMap, waterPhysicsOn, onToggleWaterPhysics }) => {
  const [zoomLevel, setZoomLevel] = useState(1);
  const radarRange = ZOOM_RANGES[zoomLevel];
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [location, setLocation] = useState('Mildvar');

  // Static geometry is simplified ONCE, not re-walked every frame.
  const polys = useMemo(() => {
    const list: Poly[] = [];
    for (const chain of riverChains) list.push(toPoly(chain, 24, '#437d9e', 6));
    for (const r of roads) {
      const farm = r.village?.startsWith('farm:');
      const color = r.kind === 'cobble' ? '#d8cca8' : farm ? '#9a7d52' : '#ba9863';
      list.push(toPoly(r.samples, r.village ? 8 : 18, color, r.width));
    }
    return list;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    let lastDraw = 0;
    let lastState = 0;
    const dir = new THREE.Vector3();
    const center = SIZE / 2;
    const radius = center - 2;

    const render = (now: number) => {
      raf = requestAnimationFrame(render);
      if (now - lastDraw < DRAW_INTERVAL) return;
      lastDraw = now;
      const engine = engineRef.current;
      if (!engine) return;

      const cam = engine.camera;
      const px = cam.position.x;
      const pz = cam.position.z;
      cam.getWorldDirection(dir);
      const yaw = Math.atan2(dir.x, -dir.z);
      const scale = (radius * 0.9) / radarRange;
      const sx = (wx: number) => center + (wx - px) * scale;
      const sz = (wz: number) => center + (wz - pz) * scale;
      const inView = (minX: number, maxX: number, minZ: number, maxZ: number) =>
        maxX > px - radarRange && minX < px + radarRange && maxZ > pz - radarRange && minZ < pz + radarRange;

      if (now - lastState > STATE_INTERVAL) {
        lastState = now;
        setLocation(engine.world.nearestSettlement(px, pz).v.name);
      }

      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(center, center, radius, 0, Math.PI * 2);
      ctx.clip();

      const grad = ctx.createRadialGradient(center, center, 10, center, center, center);
      grad.addColorStop(0, '#1c2817');
      grad.addColorStop(0.7, '#141e12');
      grad.addColorStop(1, '#0c140a');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, SIZE, SIZE);

      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      for (const f of [0.33, 0.66, 0.99]) {
        ctx.beginPath();
        ctx.arc(center, center, radius * f * 0.9, 0, Math.PI * 2);
        ctx.stroke();
      }

      // regions
      const region = (x: number, z: number, r: number, fill: string, stroke?: string) => {
        if (!inView(x - r, x + r, z - r, z + r)) return;
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(sx(x), sz(z), r * scale, 0, Math.PI * 2);
        ctx.fill();
        if (stroke) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      };
      region(WEALD_POS.x, WEALD_POS.z, WEALD_POS.r, 'rgba(28,64,25,0.45)', 'rgba(46,110,42,0.6)');
      region(MEADOW_POS.x, MEADOW_POS.z, MEADOW_POS.r, 'rgba(120,110,40,0.25)');
      region(LAKE.x, LAKE.z, LAKE.r, '#2b5f7e', '#4a82a6');
      if (inView(FORT.x - 60, FORT.x + 60, FORT.z - 60, FORT.z + 60)) {
        const hw = (FORT.w / 2) * scale;
        const hd = (FORT.d / 2) * scale;
        ctx.fillStyle = 'rgba(120,45,45,0.4)';
        ctx.strokeStyle = '#a83232';
        ctx.lineWidth = 1.5;
        ctx.fillRect(sx(FORT.x) - hw, sz(FORT.z) - hd, hw * 2, hd * 2);
        ctx.strokeRect(sx(FORT.x) - hw, sz(FORT.z) - hd, hw * 2, hd * 2);
      }

      // rivers & roads (only those whose bounds touch the radar)
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const p of polys) {
        if (!inView(p.minX, p.maxX, p.minZ, p.maxZ)) continue;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1.2, p.width * scale);
        ctx.beginPath();
        ctx.moveTo(sx(p.pts[0]), sz(p.pts[1]));
        for (let i = 2; i < p.pts.length; i += 2) ctx.lineTo(sx(p.pts[i]), sz(p.pts[i + 1]));
        ctx.stroke();
      }

      // bridges
      ctx.fillStyle = '#e5ded0';
      ctx.strokeStyle = '#5a554e';
      ctx.lineWidth = 1;
      for (const b of bridges) {
        if (Math.abs(b.x - px) > radarRange || Math.abs(b.z - pz) > radarRange) continue;
        ctx.beginPath();
        ctx.arc(sx(b.x), sz(b.z), Math.max(2, 4 * scale), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      // carriages
      ctx.fillStyle = '#f0c040';
      for (const car of engine.world.carriages) {
        const cp = car.group.position;
        if (Math.abs(cp.x - px) > radarRange || Math.abs(cp.z - pz) > radarRange) continue;
        ctx.beginPath();
        ctx.arc(sx(cp.x), sz(cp.z), 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // places
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 9px serif';
      for (const loc of ALL_LOCATIONS) {
        const x = sx(loc.x);
        const y = sz(loc.z);
        if (Math.hypot(x - center, y - center) > radius - 6) continue;
        ctx.fillStyle = loc.type === 'garrison' ? '#c43535' : loc.type === 'lake' ? '#358fc4' : '#e5ad35';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = '#fff4d6';
        ctx.shadowColor = '#000';
        ctx.shadowBlur = 3;
        ctx.fillText(loc.name, x, y - 8);
        ctx.shadowBlur = 0;
      }

      // player
      ctx.save();
      ctx.translate(center, center);
      ctx.fillStyle = 'rgba(255,230,140,0.22)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 36, -yaw - Math.PI / 2 - 0.42, -yaw - Math.PI / 2 + 0.42);
      ctx.closePath();
      ctx.fill();
      ctx.rotate(-yaw);
      ctx.fillStyle = '#4ade80';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(6, 7);
      ctx.lineTo(0, 4);
      ctx.lineTo(-6, 7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.restore();

      ctx.strokeStyle = '#caa861';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(center, center, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = 'bold 10px serif';
      ctx.fillStyle = '#f87171';
      ctx.textAlign = 'center';
      ctx.fillText('N', center, 12);
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [engineRef, radarRange, polys]);

  return (
    <div className="absolute bottom-5 left-5 z-40 flex flex-col items-start gap-1.5 select-none">
      <div className="flex w-[190px] items-center justify-between rounded-t-xl border border-amber-300/30 bg-black/65 px-2 py-1 text-[11px] text-amber-100 shadow-lg backdrop-blur-md">
        <span className="max-w-[110px] truncate font-serif font-semibold">{location}</span>
        <div className="flex items-center gap-1">
          <button onClick={() => setZoomLevel((z) => Math.max(0, z - 1))} disabled={zoomLevel === 0} title="Zoom in" className="flex h-5 w-5 items-center justify-center rounded bg-white/10 text-xs text-white hover:bg-white/20 disabled:opacity-30">+</button>
          <button onClick={() => setZoomLevel((z) => Math.min(ZOOM_RANGES.length - 1, z + 1))} disabled={zoomLevel === ZOOM_RANGES.length - 1} title="Zoom out" className="flex h-5 w-5 items-center justify-center rounded bg-white/10 text-xs text-white hover:bg-white/20 disabled:opacity-30">−</button>
          <button onClick={onOpenFullMap} title="Open realm map (M)" className="flex h-5 w-5 items-center justify-center rounded bg-amber-400/20 text-xs text-amber-300 hover:bg-amber-400/40">⛶</button>
        </div>
      </div>
      <div className="relative h-[190px] w-[190px] overflow-hidden rounded-full border border-amber-300/40 bg-black/80 p-0.5 shadow-2xl backdrop-blur-md">
        <canvas ref={canvasRef} width={SIZE} height={SIZE} className="block h-full w-full rounded-full" />
      </div>
      <div className="flex w-[190px] items-center justify-between rounded-b-xl border border-amber-300/30 bg-black/65 px-2 py-1 text-[10px] text-white/70 shadow-lg backdrop-blur-md">
        <span className="font-mono text-white/50">{radarRange} m</span>
        <button
          onClick={onToggleWaterPhysics}
          title="Toggle river flotsam & ripple simulation (P)"
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 transition ${waterPhysicsOn ? 'border border-cyan-400/40 bg-cyan-500/25 text-cyan-200' : 'bg-white/5 text-white/40'}`}
        >
          <span>💧</span>
          <span>{waterPhysicsOn ? 'Physics on' : 'Physics off'}</span>
        </button>
      </div>
    </div>
  );
};
