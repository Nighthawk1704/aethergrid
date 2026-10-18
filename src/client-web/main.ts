// Browser shell for AetherGrid: a full-window canvas driven by the rich Stage, plus the keyboard bridge.
import { GameApp } from '../shared/ui/app';
import { activeModal } from '../shared/ui/modals';
import { Stage } from './rich/stage';
import type { TimeMode } from './rich/sky';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const glow = document.getElementById('glow') as HTMLCanvasElement;
const g = canvas.getContext('2d', { alpha: false })!;
const gg = glow.getContext('2d')!;

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const make = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w); c.height = Math.max(1, h);
  return c;
};

// ---- App ----------------------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const wsUrl = params.get('server') ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const app = new GameApp({
  url: wsUrl,
  initialName: store.get('aethergrid.name') ?? '',
  onLogin: (name) => store.set('aethergrid.name', name),
  credentials: params.get('user') && params.get('pass')
    ? { name: params.get('user')!, password: params.get('pass')!, register: params.has('register'), cls: (params.get('class') as 'vanguard') ?? 'vanguard' }
    : undefined,
});

const stage = new Stage(g, make);
let timeMode: TimeMode = (['auto', 'day', 'night'] as const).find((m) => m === params.get('time')) ?? 'auto';
let crt = store.get('aethergrid.crt') !== '0';
document.body.classList.toggle('no-crt', !crt);

// ---- Sizing -------------------------------------------------------------------------------------
function resize(): void {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const W = Math.floor(window.innerWidth * dpr), H = Math.floor(window.innerHeight * dpr);
  canvas.width = W; canvas.height = H;
  canvas.style.width = `${W / dpr}px`; canvas.style.height = `${H / dpr}px`;
  glow.width = Math.max(1, W >> 1); glow.height = Math.max(1, H >> 1);
  glow.style.width = `${W / dpr}px`; glow.style.height = `${H / dpr}px`;
  stage.resize(W, H, dpr);
}

// ---- Keyboard -----------------------------------------------------------------------------------
const MOVE_KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, -1], w: [0, -1], W: [0, -1], ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
  ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0], ArrowRight: [1, 0], d: [1, 0], D: [1, 0],
};
const held = new Map<string, [number, number]>();

function typing(): boolean {
  return app.chatFocus || !app.inGame || activeModal(app.st, app.ui) !== 'none' || app.disconnected;
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'F2') { crt = !crt; document.body.classList.toggle('no-crt', !crt); store.set('aethergrid.crt', crt ? '1' : '0'); e.preventDefault(); return; }
  if (e.key === 'F3') { timeMode = timeMode === 'auto' ? 'night' : timeMode === 'night' ? 'day' : 'auto'; e.preventDefault(); return; }
  if (e.metaKey || (e.ctrlKey && e.key !== 'c')) return; // leave browser shortcuts alone
  if (e.altKey && e.key.length > 1) return;
  e.preventDefault();
  const move = MOVE_KEYS[e.key];
  if (move && !typing()) {
    // Held movement keys are driven by the timer below (smooth, and WASD combos give diagonals).
    if (!e.repeat) { held.set(e.key.toLowerCase(), move); app.handleKey({ key: e.key, shift: e.shiftKey }); }
    return;
  }
  if (e.ctrlKey) return; // no Ctrl+C quit in a browser tab
  app.handleKey({ key: e.key, ctrl: false, alt: e.altKey, shift: e.shiftKey });
});
window.addEventListener('keyup', (e) => { held.delete(e.key.toLowerCase()); });
window.addEventListener('blur', () => held.clear());

setInterval(() => {
  if (!held.size || typing()) return;
  let dx = 0, dy = 0;
  for (const [x, y] of held.values()) { dx += x; dy += y; }
  dx = Math.max(-1, Math.min(1, dx)); dy = Math.max(-1, Math.min(1, dy));
  if (dx || dy) app.moveDir(dx as -1 | 0 | 1, dy as -1 | 0 | 1);
}, 110);

// ---- Main loop ----------------------------------------------------------------------------------
window.addEventListener('resize', resize);
resize();
app.connect();

const t0 = Date.now();
let lastUpdate = performance.now();
let lastTs = performance.now();
let fps = 60, frameMs = 1, avgCost = 1, skip = false;

function frame(ts: number): void {
  requestAnimationFrame(frame);
  // If frames are expensive, render every other refresh instead of stuttering.
  skip = avgCost > 11 ? !skip : false;
  if (skip) return;
  const dt = Math.min(0.1, (ts - lastTs) / 1000);
  fps += (1 / Math.max(0.001, (ts - lastTs) / 1000) - fps) * 0.08;
  lastTs = ts;
  while (ts - lastUpdate >= 100) { app.update(); lastUpdate += 100; if (ts - lastUpdate > 1000) lastUpdate = ts; }

  const c0 = performance.now();
  stage.render(app, Date.now(), dt, (Date.now() - t0) / 1000, { timeMode, crt, fps, frameMs, t0 });
  if (crt) { gg.clearRect(0, 0, glow.width, glow.height); gg.drawImage(canvas, 0, 0, glow.width, glow.height); }
  const cost = performance.now() - c0;
  frameMs += (cost - frameMs) * 0.1;
  avgCost += (cost - avgCost) * 0.05;
}
requestAnimationFrame(frame);

// Handy for debugging in the console.
(window as unknown as { aether: GameApp }).aether = app;
