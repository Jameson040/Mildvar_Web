import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { Engine, Quality, FrameStats } from './three/engine';
import type { Mode } from './three/controls';
import { cn } from './utils/cn';
import { ALL_LOCATIONS, SETTLEMENT_SPECS, roads, riverChains, farms, bridges } from './three/world/land';
import type { Interactable, DialogueEvent, Quest } from './three/world/interactables';
import { Minimap } from './components/Minimap';

const PX_PER_DEG = 2.4;
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function Compass({ engineRef }: { engineRef: React.MutableRefObject<Engine | null> }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const acc = useRef(0);
  const prev = useRef<number | null>(null);
  const dir = useRef(new THREE.Vector3());

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const e = engineRef.current;
      if (!e || !stripRef.current || e.controls.mode === 'overview') return;
      e.camera.getWorldDirection(dir.current);
      const f = dir.current;
      let bearing = (Math.atan2(f.x, -f.z) * 180) / Math.PI;
      bearing = ((bearing % 360) + 360) % 360;
      if (prev.current === null) prev.current = bearing;
      let d = bearing - prev.current;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      acc.current += d;
      prev.current = bearing;
      stripRef.current.style.transform = `translateX(${130 - (acc.current + 360) * PX_PER_DEG}px)`;
      if (labelRef.current) labelRef.current.textContent = CARDINALS[Math.round(((bearing % 360) + 360) % 360 / 45) % 8];
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [engineRef]);

  const ticks: number[] = [];
  for (let deg = -360; deg <= 720; deg += 10) ticks.push(deg);

  return (
    <div className="pointer-events-none absolute left-1/2 top-[68px] z-20 -translate-x-1/2">
      <div className="relative h-9 w-[260px] overflow-hidden rounded-lg border border-white/15 bg-black/45 shadow-lg backdrop-blur-md">
        <div ref={stripRef} className="absolute top-0 h-full will-change-transform" style={{ width: 1080 * PX_PER_DEG }}>
          {ticks.map((deg) => {
            const norm = ((deg % 360) + 360) % 360;
            const isCardinal = norm % 90 === 0;
            const major = norm % 30 === 0;
            const letter = isCardinal ? CARDINALS[norm / 45] : null;
            return (
              <div key={deg} className="absolute top-0 flex h-full flex-col items-center justify-end" style={{ left: deg * PX_PER_DEG + 360 * PX_PER_DEG }}>
                {letter ? (
                  <span className={cn('pb-0.5 font-serif text-[13px] leading-none', letter === 'N' ? 'text-rose-300' : 'text-amber-100')}>{letter}</span>
                ) : major ? (
                  <span className="pb-0.5 font-mono text-[8px] leading-none text-white/45">{norm}</span>
                ) : null}
                <span className={cn('mb-0 w-px', isCardinal ? 'h-2.5 bg-amber-200/80' : major ? 'h-2 bg-white/40' : 'h-1 bg-white/20')} />
              </div>
            );
          })}
        </div>
        {/* fixed needle */}
        <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-amber-300 shadow-[0_0_6px_rgba(251,191,36,0.9)]" />
        <div className="absolute left-1/2 top-0 -translate-x-1/2 border-x-4 border-t-[5px] border-x-transparent border-t-amber-300" />
      </div>
      <div className="mt-1 text-center text-[10px] uppercase tracking-[0.25em] text-white/60">
        facing <span ref={labelRef} className="font-semibold text-amber-200">N</span>
      </div>
    </div>
  );
}

const MODES: { id: Mode; label: string; icon: string; hint: string; key: string }[] = [
  { id: 'overview', label: 'Overview', icon: '🗺️', hint: 'Drag to orbit · Scroll to zoom · auto-rotates', key: '1' },
  { id: 'stroll', label: 'Stroll', icon: '🚶', hint: 'WASD to walk · Shift to run · mouse to look', key: '2' },
  { id: 'fly', label: 'Free Fly', icon: '🕊️', hint: 'WASD + Space/Q · Shift boost · wheel = speed', key: '3' },
  { id: 'ride', label: 'Carriage', icon: '🐎', hint: 'Ride the road between settlements · mouse to look', key: '4' },
];

const QUALITIES: { id: Quality; label: string }[] = [
  { id: 'performance', label: 'Fast' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'ultra', label: 'Ultra' },
];

const WORLD_KM = 8;

function hourLabel(h: number) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  const h12 = ((hh + 11) % 12) + 1;
  return `${h12}:${mm.toString().padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`;
}

const place = (x: number, z: number) => ({
  left: `${50 + (x / (WORLD_KM * 1000)) * 100}%`,
  top: `${50 + (z / (WORLD_KM * 1000)) * 100}%`,
});

const mapPoint = (x: number, z: number) => `${(50 + x / (WORLD_KM * 10)).toFixed(2)},${(50 + z / (WORLD_KM * 10)).toFixed(2)}`;

const INTERIOR_LABEL: Record<string, string> = {
  cathedral: 'Cathedral of St. Alder',
  longhouse: 'Great Mead-Hall',
  keep: 'Garrison War Room',
  tavern: 'The Golden Flagon',
  cottage: 'Homestead Hearth',
};

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : `${n}`);

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>('overview');
  const [locked, setLocked] = useState(false);
  const [hour, setHour] = useState(18.2);
  const [tilt, setTilt] = useState(true);
  const [quality, setQuality] = useState<Quality>('balanced');
  const [frame, setFrame] = useState<FrameStats>({ fps: 0, calls: 0, triangles: 0, chunks: 0 });
  const [stats, setStats] = useState({ houses: 0, trees: 0, villagers: 0, farms: 0, bridges: 0, roadsKm: 0 });
  const [showHelp, setShowHelp] = useState(true);
  const [mapOpen, setMapOpen] = useState(false);
  const [discovered, setDiscovered] = useState<string[]>(['mildvar']);
  const [toast, setToast] = useState<string | null>(null);
  const [pos, setPos] = useState({ x: 0, z: 0 });
  const [near, setNear] = useState(SETTLEMENT_SPECS[0].name);
  const [waterPhysicsOn, setWaterPhysicsOn] = useState(true);
  const [interactPrompt, setInteractPrompt] = useState<Interactable | null>(null);
  const [dialogue, setDialogue] = useState<DialogueEvent | null>(null);
  const [quests, setQuests] = useState<Quest[]>([]);
  const [questOpen, setQuestOpen] = useState(false);
  const nearLabelRef = useRef<HTMLSpanElement>(null);
  const coordRef = useRef<HTMLDivElement>(null);
  const nearNameRef = useRef('');
  const mapOpenRef = useRef(false);
  mapOpenRef.current = mapOpen;

  const toggleWaterPhysics = useCallback(() => setWaterPhysicsOn((prev) => !prev), []);
  useEffect(() => {
    engineRef.current?.setWaterPhysics(waterPhysicsOn);
  }, [waterPhysicsOn, ready]);

  const mapLines = useMemo(() => {
    if (!ready || !mapOpen) return null;
    return {
      water: riverChains.map((chain) => chain.filter((_, i) => i % 8 === 0 || i === chain.length - 1).map((p) => mapPoint(p.x, p.z)).join(' ')),
      routes: roads.map((r) => ({
        points: r.samples.filter((_, i) => i % (r.village ? 3 : 12) === 0 || i === r.samples.length - 1).map((p) => mapPoint(p.x, p.z)).join(' '),
        kind: r.kind,
        farm: r.village?.startsWith('farm:'),
      })),
      fields: farms.map((f) => ({ x: 50 + f.x / (WORLD_KM * 10), z: 50 + f.z / (WORLD_KM * 10) })),
      crossings: bridges.map((b) => ({ x: 50 + b.x / (WORLD_KM * 10), z: 50 + b.z / (WORLD_KM * 10) })),
    };
  }, [ready, mapOpen]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let engine: Engine | null = null;
    const id = window.setTimeout(() => {
      engine = new Engine(canvas);
      engineRef.current = engine;
      engine.controls.onLockChange = setLocked;
      engine.onStats = setFrame;
      engine.world.interactions.onTargetChange = setInteractPrompt;
      engine.world.interactions.onQuestChange = setQuests;
      engine.world.interactions.onDialogue = (d) => {
        setDialogue(d);
        if (d) engine?.controls.unlock();
      };
      setQuests([...engine.world.interactions.quests]);
      engine.setHour(18.2);
      engine.world.onDiscovery((name) => {
        const v = ALL_LOCATIONS.find((s) => s.name === name);
        if (!v) return;
        setDiscovered((d) => (d.includes(v.id) ? d : [...d, v.id]));
        setToast(`${v.emoji}  Discovered ${name} — ${v.title}`);
        window.setTimeout(() => setToast(null), 5200);
      });
      engine.start();
      setStats(engine.world.stats);
      setReady(true);
    }, 60);
    return () => {
      window.clearTimeout(id);
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  /**
   * Location readouts are written straight into the DOM from the render loop
   * (like <Compass/>), so React re-renders only when the nearest settlement
   * actually changes instead of 2.5 times per second.
   */
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 200) return;
      last = now;
      const e = engineRef.current;
      if (!e) return;
      const p = e.camera.position;
      const interior = e.world.interactions?.currentInterior;
      const name = interior ? INTERIOR_LABEL[interior] : e.world.nearestSettlement(p.x, p.z).v.name;
      if (name !== nearNameRef.current) {
        nearNameRef.current = name;
        if (nearLabelRef.current) nearLabelRef.current.textContent = name;
        setNear(name);
      }
      if (coordRef.current) {
        coordRef.current.textContent = interior
          ? 'Underground · pocket interior'
          : `${p.x >= 0 ? 'E' : 'W'} ${Math.abs(p.x / 1000).toFixed(2)} km · ${p.z >= 0 ? 'S' : 'N'} ${Math.abs(p.z / 1000).toFixed(2)} km`;
      }
      if (mapOpenRef.current) setPos({ x: p.x, z: p.z });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const changeMode = useCallback((m: Mode) => {
    setMode(m);
    const e = engineRef.current;
    if (!e) return;
    // Leaving a pocket interior for a camera mode that cannot be indoors:
    // step back out to the doorstep first.
    const inside = e.world.interactions.currentInterior;
    if (inside && m !== 'stroll') {
      const r = e.world.interactions.returnState;
      e.world.interactions.leaveInterior();
      e.setMode('stroll');
      if (r) e.controls.teleport(r.x, r.z, r.y, r.yaw);
    }
    if (m === 'ride') {
      e.controls.boardCarriage(Math.floor(Math.random() * Math.max(1, e.world.carriages.length)));
      e.setTilt(e.tilt);
    } else {
      e.setMode(m);
    }
    if (m !== 'overview') setTimeout(() => e.controls.lock(), 60);
  }, []);

  const travel = useCallback((id: string) => {
    const e = engineRef.current;
    if (!e) return;
    if (e.world.interactions.currentInterior) e.world.interactions.leaveInterior();
    const t = e.world.travelTarget(id);
    if (!t) return;
    e.setMode('stroll');
    e.controls.teleport(t.x, t.z, t.y, t.yaw);
    setMapOpen(false);
    setMode('stroll');
    setTimeout(() => e.controls.lock(), 80);
  }, []);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.code === 'Digit1') changeMode('overview');
      if (ev.code === 'Digit2') changeMode('stroll');
      if (ev.code === 'Digit3') changeMode('fly');
      if (ev.code === 'Digit4') changeMode('ride');
      if (ev.code === 'KeyM') setMapOpen((o) => !o);
      if (ev.code === 'KeyT') setTilt((t) => !t);
      if (ev.code === 'KeyP') toggleWaterPhysics();
      if (ev.code === 'KeyH') setShowHelp((s) => !s);
      if (ev.code === 'KeyJ') {
        const next = !questOpen;
        setQuestOpen(next);
        if (next) engineRef.current?.controls.unlock();
        else if (mode !== 'overview') engineRef.current?.controls.lock();
      }
      if (ev.code === 'KeyE') {
        if (dialogue) {
          setDialogue(null);
          engineRef.current?.controls.lock();
          return;
        }
        if (mode === 'stroll' && !questOpen) {
          const e = engineRef.current;
          e?.world.interactions.interact((x, z, y, yaw) => e.controls.teleport(x, z, y, yaw));
        }
      }
      if (ev.code === 'Escape') {
        setDialogue(null);
        setQuestOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [changeMode, dialogue, mode, questOpen]);

  useEffect(() => {
    engineRef.current?.setTilt(tilt);
  }, [tilt, mode]);

  const onHour = (h: number) => {
    setHour(h);
    engineRef.current?.setHour(h);
  };

  const onQuality = (q: Quality) => {
    setQuality(q);
    engineRef.current?.applyQuality(q);
  };

  const needsLock = ready && mode !== 'overview' && !locked && !mapOpen && !dialogue && !questOpen;
  const current = MODES.find((m) => m.id === mode)!;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0b1020] font-sans text-white select-none">
      <canvas ref={canvasRef} className="block h-full w-full" onClick={() => mode !== 'overview' && engineRef.current?.controls.lock()} />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_58%,rgba(8,8,18,0.5)_100%)]" />

      {!ready && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-gradient-to-b from-[#182142] to-[#080c18]">
          <div className="mb-6 animate-pulse text-6xl">🏰</div>
          <h1 className="font-serif text-3xl tracking-wide text-amber-100">Founding the realm…</h1>
          <p className="mt-3 text-sm text-amber-100/60">surveying five settlements · paving 30 km of road · raising windmills</p>
          <div className="mt-6 h-1 w-64 overflow-hidden rounded-full bg-white/10">
            <div className="h-full w-1/2 animate-[loading_1.2s_ease-in-out_infinite] rounded-full bg-amber-300" />
          </div>
        </div>
      )}

      {/* Title */}
      <div className="pointer-events-none absolute left-5 top-5 z-20">
        <h1 className="font-serif text-2xl font-semibold tracking-wide text-amber-50 drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)] md:text-3xl">The Mildvar Reaches</h1>
        <p className="mt-0.5 text-[10px] uppercase tracking-[0.3em] text-amber-100/70 drop-shadow md:text-xs">Five Settlements · Medieval Fantasy Open World</p>
      </div>

      {/* Modes */}
      <div className="absolute left-1/2 top-5 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/15 bg-black/45 p-1 shadow-xl backdrop-blur-md">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => changeMode(m.id)}
            className={cn(
              'flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition-all',
              mode === m.id ? 'bg-amber-400 text-amber-950 shadow-[0_0_18px_rgba(251,191,36,0.5)]' : 'text-white/80 hover:bg-white/10',
            )}
          >
            <span>{m.icon}</span>
            <span className="hidden sm:inline">{m.label}</span>
            <kbd className="hidden rounded bg-black/20 px-1 text-[10px] opacity-60 md:inline">{m.key}</kbd>
          </button>
        ))}
        <button onClick={() => setMapOpen(true)} className="ml-1 flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-sm text-white/80 transition hover:bg-white/10">
          <span>🧭</span>
          <span className="hidden md:inline">Map</span>
          <kbd className="hidden rounded bg-black/20 px-1 text-[10px] opacity-60 md:inline">M</kbd>
        </button>
      </div>

      {/* Heading ruler */}
      {ready && mode !== 'overview' && <Compass engineRef={engineRef} />}

      {/* Time of day + quality */}
      <div className="absolute right-5 top-5 z-40 w-60 rounded-2xl border border-white/15 bg-black/45 p-4 shadow-xl backdrop-blur-md">
        <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-widest text-white/60">
          <span>Time of day</span>
          <span className="font-mono text-amber-200">{hourLabel(hour)}</span>
        </div>
        <input type="range" min={4.8} max={22.4} step={0.05} value={hour} onChange={(e) => onHour(parseFloat(e.target.value))} className="w-full accent-amber-400" />
        <div className="mt-1 flex justify-between text-[10px] text-white/40">
          <span>🌅</span><span>☀️</span><span>🌇</span><span>🌙</span>
        </div>
        <div className="mt-3 flex gap-1.5">
          {([['Dawn', 6], ['Noon', 12.6], ['Golden', 18.2], ['Night', 22.2]] as [string, number][]).map(([l, h]) => (
            <button key={l} onClick={() => onHour(h)} className={cn('flex-1 rounded-md border border-white/10 py-1 text-[11px] transition', Math.abs(hour - h) < 0.3 ? 'bg-amber-400/90 text-amber-950' : 'bg-white/5 hover:bg-white/15')}>
              {l}
            </button>
          ))}
        </div>
        <div className="mt-3 text-[10px] uppercase tracking-widest text-white/60">Graphics & Physics</div>
        <div className="mt-1 flex gap-1.5">
          {QUALITIES.map((q) => (
            <button key={q.id} onClick={() => onQuality(q.id)} className={cn('flex-1 rounded-md border border-white/10 py-1 text-[11px] transition', quality === q.id ? 'bg-emerald-400/90 text-emerald-950' : 'bg-white/5 hover:bg-white/15')}>
              {q.label}
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex items-center justify-between text-xs">
          <span className="text-white/70">💧 Water Physics <kbd className="ml-1 rounded bg-white/10 px-1 text-[10px]">P</kbd></span>
          <button
            onClick={toggleWaterPhysics}
            className={cn('relative h-5 w-9 rounded-full transition', waterPhysicsOn ? 'bg-cyan-500' : 'bg-white/20')}
          >
            <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', waterPhysicsOn ? 'left-[18px]' : 'left-0.5')} />
          </button>
        </div>
        <label className={cn('mt-2 flex cursor-pointer items-center justify-between text-xs', mode !== 'overview' && 'opacity-40')}>
          <span className="text-white/70">Miniature tilt‑shift <kbd className="ml-1 rounded bg-white/10 px-1 text-[10px]">T</kbd></span>
          <span onClick={() => setTilt((t) => !t)} className={cn('relative h-5 w-9 rounded-full transition', tilt ? 'bg-amber-400' : 'bg-white/20')}>
            <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', tilt ? 'left-[18px]' : 'left-0.5')} />
          </span>
        </label>
      </div>

      {/* Minimap in Left Corner */}
      {ready && (
        <Minimap
          engineRef={engineRef}
          onOpenFullMap={() => setMapOpen(true)}
          waterPhysicsOn={waterPhysicsOn}
          onToggleWaterPhysics={toggleWaterPhysics}
        />
      )}

      {/* Help card (above Minimap) + Performance readout */}
      <div className="absolute bottom-[240px] left-5 z-30 max-w-xs">
        {showHelp && (
          <div className="mb-2 rounded-2xl border border-white/15 bg-black/55 p-3.5 text-xs shadow-xl backdrop-blur-md">
            <div className="mb-1.5 flex items-center justify-between text-sm font-semibold text-amber-100">
              <span className="flex items-center gap-1.5">
                <span>{current.icon}</span> {current.label}
              </span>
              <button
                onClick={() => setShowHelp(false)}
                className="text-white/40 hover:text-white/80 text-xs px-1"
                title="Hide guide (Press H)"
              >
                ✕
              </button>
            </div>
            <p className="text-white/70 leading-relaxed">{current.hint}</p>
            <ul className="mt-2 space-y-1 text-[11px] text-white/60">
              {mode === 'overview' && <li>• Press <kbd className="rounded bg-white/10 px-1">M</kbd> for the full realm map or click pins to fast travel</li>}
              {mode === 'stroll' && <li>• Stroll through Mildvar, Fort Ironspire garrison, or Lake Eldermere</li>}
              {mode === 'stroll' && <li>• Look for <kbd className="rounded bg-white/10 px-1">E</kbd> prompts at doors, shrines &amp; noticeboards · <kbd className="rounded bg-white/10 px-1">J</kbd> opens your journal</li>}
              {mode === 'fly' && <li>• Fly over the Whispering Weald forest & Golden Mead grassland</li>}
              {mode === 'ride' && <li>• Ride with the carriage driver · <kbd className="rounded bg-white/10 px-1">2</kbd> to dismount</li>}
              <li>• <kbd className="rounded bg-white/10 px-1">P</kbd> toggles Water Physics · <kbd className="rounded bg-white/10 px-1">H</kbd> toggles this panel</li>
            </ul>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-white/55 bg-black/40 px-2.5 py-1 rounded-lg backdrop-blur-sm border border-white/10">
          <span className="font-mono text-emerald-200/90">{frame.fps} fps</span>
          <span>·</span><span className="font-mono">{frame.calls} calls</span>
          <span>·</span><span className="font-mono">{fmt(frame.triangles)} tris</span>
          <span>·</span><span>{stats.houses} bldgs</span>
          <span>·</span><span>{stats.farms} farms</span>
        </div>
      </div>

      {/* Location readout */}
      <div className="pointer-events-none absolute bottom-5 right-5 z-30 rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-right text-[11px] backdrop-blur-md">
        <div className="font-serif text-sm text-amber-100">Near <span ref={nearLabelRef}>{near}</span></div>
        <div ref={coordRef} className="font-mono text-white/45">
          {pos.x >= 0 ? 'E' : 'W'} {Math.abs(pos.x / 1000).toFixed(2)} km · {pos.z >= 0 ? 'S' : 'N'} {Math.abs(pos.z / 1000).toFixed(2)} km
        </div>
        <div className="mt-1 text-white/40">Discovered {discovered.length}/{ALL_LOCATIONS.length} realm regions</div>
      </div>

      {/* [E] world interaction prompt */}
      {interactPrompt && mode === 'stroll' && !dialogue && !questOpen && (
        <div className="pointer-events-none absolute left-1/2 top-[54%] z-30 -translate-x-1/2 rounded-xl border border-amber-300/40 bg-black/75 px-4 py-2 text-center shadow-xl backdrop-blur-md">
          <div className="font-serif text-[11px] text-amber-200/80">{interactPrompt.title}</div>
          <div className="mt-0.5 flex items-center justify-center gap-1.5 text-sm font-semibold text-white">
            <kbd className="rounded bg-amber-400 px-1.5 py-0.5 font-mono text-xs text-amber-950">E</kbd>
            <span>{interactPrompt.prompt}</span>
          </div>
        </div>
      )}

      {/* Quest tracker */}
      {ready && quests.length > 0 && (
        <div className="pointer-events-none absolute left-5 top-[86px] z-20 w-[300px] rounded-xl border border-white/10 bg-black/45 p-3 backdrop-blur-md">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-amber-200/80">
            <span>Quest log</span>
            <span className="font-mono text-white/40">J</span>
          </div>
          {quests.map((q) => (
            <div key={q.id} className="mt-2 border-t border-white/10 pt-1.5">
              <div className="font-serif text-xs font-semibold text-amber-100">
                {q.status === 'completed' ? '✓ ' : '◆ '}
                {q.title}
                <span className="ml-1 font-mono text-[9px] text-white/35">{Math.min(q.stepIndex + 1, q.steps.length)}/{q.steps.length}</span>
              </div>
              <div className="mt-0.5 text-[11px] leading-snug text-white/65">
                {q.status === 'completed' ? q.rewardText : q.steps[q.stepIndex]?.description}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* NPC dialogue */}
      {dialogue && (
        <div className="absolute inset-x-0 bottom-10 z-50 mx-auto w-[min(92vw,620px)] rounded-2xl border border-amber-300/40 bg-[#12100c]/95 p-6 shadow-2xl backdrop-blur-md">
          {dialogue.questUpdate && (
            <div className="mb-2 inline-block rounded-full bg-amber-400/20 px-3 py-0.5 text-[11px] font-semibold text-amber-300">
              {dialogue.questUpdate}
            </div>
          )}
          <h3 className="font-serif text-xl text-amber-100">{dialogue.speaker}</h3>
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.2em] text-amber-200/50">{dialogue.title}</div>
          <div className="mt-3 space-y-2 text-sm leading-relaxed text-white/85">
            {dialogue.lines.map((line, idx) => <p key={idx}>{line}</p>)}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={() => { setDialogue(null); engineRef.current?.controls.lock(); }}
              className="rounded-lg bg-amber-400 px-4 py-1.5 text-xs font-semibold text-amber-950 hover:bg-amber-300"
            >
              Continue [E]
            </button>
          </div>
        </div>
      )}

      {/* Journal */}
      {questOpen && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => setQuestOpen(false)}>
          <div className="w-[min(94vw,720px)] rounded-2xl border border-amber-200/25 bg-[#12100c]/97 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-end justify-between border-b border-white/10 pb-2">
              <div>
                <h2 className="font-serif text-2xl text-amber-100">Quest Journal</h2>
                <p className="text-[11px] text-amber-100/50">Doors with a prompt lead to interiors; every hall keeps a named NPC.</p>
              </div>
              <button onClick={() => setQuestOpen(false)} className="rounded-lg border border-white/15 px-3 py-1 text-sm text-white/70 hover:bg-white/10">Close [J]</button>
            </div>
            {quests.map((q) => (
              <div key={q.id} className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-serif text-base text-amber-100">{q.title}</h3>
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px] uppercase tracking-widest', q.status === 'completed' ? 'bg-emerald-400/20 text-emerald-300' : q.status === 'active' ? 'bg-amber-400/20 text-amber-300' : 'bg-white/10 text-white/60')}>
                    {q.status}
                  </span>
                </div>
                <div className="text-[11px] text-white/45">Given by {q.giver} · {q.village}</div>
                <ol className="mt-2 space-y-1.5">
                  {q.steps.map((step, i) => (
                    <li key={step.id} className={cn('flex gap-2 text-xs', step.completed ? 'text-white/35 line-through' : i === q.stepIndex && q.status === 'active' ? 'text-amber-100' : 'text-white/60')}>
                      <span>{step.completed ? '✓' : i === q.stepIndex && q.status === 'active' ? '◆' : '○'}</span>
                      <span>{step.description}</span>
                    </li>
                  ))}
                </ol>
                <div className="mt-2 text-[11px] text-amber-200/60">Reward: {q.rewardText}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && (
        <div className="pointer-events-none absolute left-1/2 top-24 z-40 -translate-x-1/2 rounded-2xl border border-amber-300/40 bg-black/70 px-6 py-3 text-center shadow-2xl backdrop-blur-md">
          <div className="text-[10px] uppercase tracking-[0.3em] text-amber-200/70">Location discovered</div>
          <div className="mt-1 font-serif text-lg text-amber-100">{toast}</div>
        </div>
      )}

      {/* Realm map */}
      {mapOpen && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto" onClick={() => setMapOpen(false)}>
          <div className="w-[min(94vw,900px)] max-h-[92vh] overflow-y-auto rounded-3xl border border-amber-200/20 bg-[#12100c]/95 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-end justify-between">
              <div>
                <h2 className="font-serif text-2xl text-amber-100">The Mildvar Reaches</h2>
                <p className="text-xs text-amber-100/50">Five settlements, military garrisons, lakes & wilderness · click a pin to travel</p>
              </div>
              <button onClick={() => setMapOpen(false)} className="rounded-lg border border-white/15 px-3 py-1 text-sm text-white/70 hover:bg-white/10">Close</button>
            </div>
            <div className="relative aspect-square w-full max-h-[460px] overflow-hidden rounded-2xl border border-amber-200/15 bg-[#1b2412]">
              <div className="absolute inset-0 opacity-90 [background:radial-gradient(circle_at_50%_50%,#3d5324_0%,#2c3d1c_45%,#22301a_70%,#1a2414_100%)]" />
              <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                {mapLines?.water.map((points, i) => (
                  <polyline key={`river-${i}`} points={points} fill="none" stroke="#609abb" strokeWidth={i === 0 ? 0.44 : 0.32} opacity="0.75" strokeLinejoin="round" />
                ))}
                {mapLines?.routes.map((route, i) => (
                  <polyline
                    key={`road-${i}`}
                    points={route.points}
                    fill="none"
                    stroke={route.farm ? '#b49767' : route.kind === 'cobble' ? '#dfd1aa' : '#c7a975'}
                    strokeWidth={route.farm ? 0.11 : route.kind === 'cobble' ? 0.2 : 0.27}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    opacity={route.farm ? 0.7 : 0.95}
                  />
                ))}
                {mapLines?.fields.map((f, i) => <circle key={`farm-${i}`} cx={f.x} cy={f.z} r="0.27" fill="#e6c77e" opacity="0.9" />)}
                {mapLines?.crossings.map((b, i) => <circle key={`bridge-${i}`} cx={b.x} cy={b.z} r="0.25" fill="#e2d9c5" stroke="#677478" strokeWidth="0.12" />)}
              </svg>
              {ALL_LOCATIONS.map((s) => {
                const seen = discovered.includes(s.id);
                return (
                  <button key={s.id} onClick={() => travel(s.id)} style={place(s.x, s.z)} className="group absolute -translate-x-1/2 -translate-y-1/2 focus:outline-none">
                    <span className="flex flex-col items-center">
                      <span className={cn('flex h-8 w-8 items-center justify-center rounded-full border-2 text-base shadow-lg transition group-hover:scale-110', seen ? (s.type === 'garrison' ? 'border-red-400 bg-red-600/90' : s.type === 'lake' ? 'border-cyan-300 bg-cyan-600/90' : 'border-amber-300 bg-amber-400/90') : 'border-white/30 bg-black/60 grayscale')}>
                        {seen ? s.emoji : '❓'}
                      </span>
                      <span className={cn('mt-0.5 whitespace-nowrap rounded px-1.5 py-0.5 font-serif text-[10px] backdrop-blur-sm', seen ? 'bg-black/60 text-amber-100' : 'bg-black/50 text-white/50')}>
                        {seen ? s.name : 'Unknown'}
                      </span>
                    </span>
                  </button>
                );
              })}
              <div
                className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]"
                style={place(pos.x, pos.z)}
              />
              <div className="pointer-events-none absolute bottom-2 left-3 text-[10px] uppercase tracking-widest text-amber-100/50">Actual roads · rivers · farmsteads · {WORLD_KM} km across</div>
              <div className="pointer-events-none absolute bottom-2 right-3 text-[10px] text-amber-100/40">N ↑</div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {ALL_LOCATIONS.map((s) => (
                <button key={s.id} onClick={() => travel(s.id)} className={cn('rounded-xl border p-2.5 text-left transition', discovered.includes(s.id) ? 'border-amber-200/25 bg-amber-400/5 hover:bg-amber-400/15' : 'border-white/10 bg-white/5 opacity-60 hover:bg-white/10')}>
                  <div className="flex items-center gap-2">
                    <span className="text-base">{discovered.includes(s.id) ? s.emoji : '❓'}</span>
                    <span className="font-serif text-sm text-amber-100 font-semibold">{discovered.includes(s.id) ? s.name : 'Unknown'}</span>
                  </div>
                  <p className="mt-0.5 text-[10px] leading-tight text-white/55">{discovered.includes(s.id) ? s.blurb : 'Travel here to discover this region.'}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {needsLock && (
        <div className="absolute inset-0 z-30 flex cursor-pointer items-center justify-center bg-black/40 backdrop-blur-[2px]" onClick={() => engineRef.current?.controls.lock()}>
          <div className="rounded-3xl border border-amber-200/30 bg-black/70 px-10 py-8 text-center shadow-2xl">
            <div className="text-5xl">{current.icon}</div>
            <div className="mt-3 font-serif text-2xl text-amber-100">
              Click to {mode === 'stroll' ? 'take a stroll' : mode === 'fly' ? 'take flight' : 'ride along'}
            </div>
            <div className="mt-2 text-sm text-white/60">{current.hint}</div>
            <div className="mt-4 text-xs text-white/40">Esc to release · M for the map · 1 for Overview</div>
          </div>
        </div>
      )}

      {mode !== 'overview' && mode !== 'ride' && locked && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/70 shadow-[0_0_6px_rgba(0,0,0,0.8)]" />
      )}
    </div>
  );
}
