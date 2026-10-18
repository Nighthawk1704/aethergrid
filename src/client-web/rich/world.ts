// The rich world renderer: dense tonal terrain, night lighting, water reflections, entities, effects.
// Everything here is purely visual; it only reads the client's mirror of server state.
import { EF } from '../../shared/types';
import type { WireEntity, ZoneId } from '../../shared/types';
import { T } from '../../shared/tiles';
import { entityGlyph } from '../../shared/ui/theme';
import type { ClientState, ZoneMap } from '../../shared/client/state';
import { FONT_FAMILY, GlyphAtlas, type MakeCanvas } from './atlas';
import { clamp01, hash2, lerp } from './noise';
import { MOON_R, MOON_W, moonCell, type TimeOfDay } from './sky';
import { SUB, flipGlyph, isSwayTile, isWater, terrainCell } from './terrain';

/** Where the moon hangs on screen (fractions of the window): right of centre, clear of the HUD. */
const MOON_POS = { x: 0.7, y: 0.15 };
const CHUNK = 12; // tiles per chunk edge
const MAX_CHUNKS = 48;

interface Chunk { canvas: HTMLCanvasElement; dirty: boolean; used: number }
interface Disp { x: number; y: number }
interface Mote { x: number; y: number; vx: number; vy: number; ph: number }
interface Glint { x: number; y: number; ch: string; color: number; a: number }

export interface Metrics { W: number; H: number; Wd: number; Hd: number; fontPx: number; dpr: number }

const mix3 = (a: number, b: number, t: number): number => {
  const r = lerp((a >> 16) & 255, (b >> 16) & 255, t), g = lerp((a >> 8) & 255, (b >> 8) & 255, t), bl = lerp(a & 255, b & 255, t);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
};
const css = (c: number, a = 1): string => `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
const ckey = (wcx: number, wcy: number): number => (wcy + 4000) * 16384 + (wcx + 4000);

export class WorldRenderer {
  m: Metrics = { W: 0, H: 0, Wd: 8, Hd: 16, fontPx: 13, dpr: 1 };
  private atlas: GlyphAtlas;
  private readonly chunks = new Map<string, Chunk>();
  private tick = 0;
  private mask: HTMLCanvasElement;
  private maskImg: ImageData | null = null;
  private readonly disp = new Map<number, Disp>();
  private cam = { x: 0, y: 0 };
  private camZone: ZoneId | '' = '';
  private motes: Mote[] = [];
  private readonly entCells = new Map<number, { ch: string; color: number }>();
  private glints: Glint[] = [];
  private seed = Math.random() * 1000;

  constructor(private readonly g: CanvasRenderingContext2D, private readonly make: MakeCanvas) {
    this.atlas = new GlyphAtlas(make, 8, 16, 13);
    this.mask = make(4, 4);
  }

  /** Pick a small cell size so the window holds a very dense grid (about 240 columns). */
  resize(W: number, H: number, dpr: number): void {
    const cssW = W / dpr;
    const cwCss = Math.max(5, Math.min(9, cssW / 240));
    const Wd = Math.max(4, Math.round(cwCss * dpr));
    const Hd = Wd * 2;
    this.m = { W, H, Wd, Hd, fontPx: Math.round(Hd / 1.2), dpr };
    this.atlas = new GlyphAtlas(this.make, Wd, Hd, this.m.fontPx);
    this.chunks.clear();
  }

  get cols(): number { return Math.floor(this.m.W / this.m.Wd); }
  get rows(): number { return Math.floor(this.m.H / this.m.Hd); }

  // ---- Chunk cache --------------------------------------------------------------------------
  private drainUpdates(st: ClientState): void {
    for (const [zone, y, x, len] of st.tileUpdates) {
      const cy = Math.floor(y / CHUNK);
      for (let cx = Math.floor(x / CHUNK); cx <= Math.floor((x + len - 1) / CHUNK); cx++) {
        const c = this.chunks.get(`${zone}:${cx},${cy}`);
        if (c) c.dirty = true;
      }
    }
    st.tileUpdates.length = 0;
  }

  private chunk(zone: ZoneMap, cx: number, cy: number): Chunk {
    const key = `${zone.id}:${cx},${cy}`;
    let c = this.chunks.get(key);
    const { Wd, Hd } = this.m;
    if (!c) {
      if (this.chunks.size >= MAX_CHUNKS) {
        let oldest = '', age = Infinity;
        for (const [k, v] of this.chunks) if (v.used < age) { age = v.used; oldest = k; }
        this.chunks.delete(oldest);
      }
      c = { canvas: this.make(CHUNK * SUB * Wd, CHUNK * SUB * Hd), dirty: true, used: 0 };
      this.chunks.set(key, c);
    }
    c.used = this.tick;
    if (c.dirty) {
      c.dirty = false;
      const g = c.canvas.getContext('2d')!;
      g.clearRect(0, 0, c.canvas.width, c.canvas.height);
      for (let ty = cy * CHUNK; ty < Math.min(zone.h, (cy + 1) * CHUNK); ty++) {
        for (let tx = cx * CHUNK; tx < Math.min(zone.w, (cx + 1) * CHUNK); tx++) {
          const k = zone.known[ty * zone.w + tx]!;
          if (!k) continue;
          const tile = k - 1;
          if (isSwayTile(tile, tx, ty)) continue; // drawn live
          for (let sy = 0; sy < SUB; sy++) {
            for (let sx = 0; sx < SUB; sx++) {
              const cell = terrainCell(tile, tx * SUB + sx, ty * SUB + sy, sx, sy);
              this.atlas.draw(g, cell.ch, cell.fg, ((tx - cx * CHUNK) * SUB + sx) * Wd, ((ty - cy * CHUNK) * SUB + sy) * Hd);
            }
          }
        }
      }
    }
    return c;
  }

  // ---- Helpers ------------------------------------------------------------------------------
  private tileAtCell(zone: ZoneMap, wcx: number, wcy: number): number {
    const tx = Math.floor(wcx / SUB), ty = Math.floor(wcy / SUB);
    if (tx < 0 || ty < 0 || tx >= zone.w || ty >= zone.h) return -1;
    return zone.known[ty * zone.w + tx]! - 1;
  }

  private updateDisplay(st: ClientState, dt: number): void {
    const me = st.me!;
    const zone = st.zone!;
    if (this.camZone !== zone.id) { this.cam = { x: me.x, y: me.y }; this.camZone = zone.id; this.disp.clear(); }
    const k = 1 - Math.exp(-dt * 13);
    this.cam.x += (me.x - this.cam.x) * k;
    this.cam.y += (me.y - this.cam.y) * k;
    if (Math.abs(me.x - this.cam.x) > 6 || Math.abs(me.y - this.cam.y) > 6) { this.cam.x = me.x; this.cam.y = me.y; }
    const alive = new Set<number>();
    for (const e of st.entities.values()) {
      alive.add(e.id);
      const d = this.disp.get(e.id);
      if (!d) this.disp.set(e.id, { x: e.x, y: e.y });
      else { d.x += (e.x - d.x) * k; d.y += (e.y - d.y) * k; if (Math.abs(e.x - d.x) > 5 || Math.abs(e.y - d.y) > 5) { d.x = e.x; d.y = e.y; } }
    }
    for (const id of this.disp.keys()) if (!alive.has(id)) this.disp.delete(id);
  }

  // ---- Frame --------------------------------------------------------------------------------
  frame(st: ClientState, nowMs: number, dt: number, tod: TimeOfDay, tSec: number): void {
    const g = this.g;
    const { W, H, Wd, Hd } = this.m;
    this.tick++;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.shadowBlur = 0;
    g.fillStyle = '#02040a';
    g.fillRect(0, 0, W, H);
    const zone = st.zone, me = st.me;
    if (!zone || !me) return;

    this.drainUpdates(st);
    this.updateDisplay(st, dt);
    const indoor = zone.depth > 0;
    const night = indoor ? 1 : tod.night;
    const TW = SUB * Wd, TH = SUB * Hd;
    const originX = Math.round(W / 2 - (this.cam.x * SUB + SUB / 2) * Wd);
    const originY = Math.round(H / 2 - (this.cam.y * SUB + SUB / 2) * Hd);
    const tx0 = Math.max(0, Math.floor(-originX / TW) - 1), tx1 = Math.min(zone.w - 1, Math.ceil((W - originX) / TW) + 1);
    const ty0 = Math.max(0, Math.floor(-originY / TH) - 1), ty1 = Math.min(zone.h - 1, Math.ceil((H - originY) / TH) + 1);

    // 1. Cached terrain chunks.
    for (let cy = Math.floor(ty0 / CHUNK); cy <= Math.floor(ty1 / CHUNK); cy++) {
      for (let cx = Math.floor(tx0 / CHUNK); cx <= Math.floor(tx1 / CHUNK); cx++) {
        const c = this.chunk(zone, cx, cy);
        g.drawImage(c.canvas, originX + cx * CHUNK * TW, originY + cy * CHUNK * TH);
      }
    }

    // Entity cells (for water to reflect them).
    this.entCells.clear();
    for (const e of st.entities.values()) {
      if (e.fl & EF.DEAD || e.k === 'loot') continue;
      const d = this.disp.get(e.id)!;
      const gl = entityGlyph(e);
      for (let sx = 0; sx < SUB; sx++) this.entCells.set(ckey(Math.round(d.x) * SUB + sx, Math.round(d.y) * SUB + SUB - 1), { ch: gl.ch, color: gl.fg });
    }
    for (let sx = 0; sx < SUB; sx++) this.entCells.set(ckey(Math.round(this.cam.x) * SUB + sx, Math.round(this.cam.y) * SUB + SUB - 1), { ch: '@', color: 0xffffff });

    this.drawSway(zone, tx0, ty0, tx1, ty1, originX, originY, tSec);
    this.glints.length = 0;
    this.drawWater(zone, tx0, ty0, tx1, ty1, originX, originY, tSec, night, indoor, nowMs);
    this.applyLight(zone, tx0, ty0, tx1, ty1, originX, originY, night, indoor, nowMs);

    // Additive light: the player's lantern and the moon's halo.
    g.globalCompositeOperation = 'lighter';
    const px = W / 2, py = H / 2;
    const lr = zone.fov * TH * 0.9;
    const lg = g.createRadialGradient(px, py, 0, px, py, lr);
    const flick = 1 + 0.05 * Math.sin(nowMs / 120) + 0.03 * Math.sin(nowMs / 41);
    const lc = indoor ? 0xffa850 : 0x88c0ff;
    lg.addColorStop(0, css(lc, (0.14 * night + 0.02) * flick));
    lg.addColorStop(1, css(lc, 0));
    g.fillStyle = lg;
    g.fillRect(px - lr, py - lr, lr * 2, lr * 2);
    g.globalCompositeOperation = 'source-over';

    if (!indoor && night > 0.12) this.drawMoon(night);
    this.drawGlints(night);
    this.drawMotes(dt, night, indoor, tSec, zone);
    this.drawEntities(st, originX, originY, tSec);
    this.drawFx(st, originX, originY, nowMs);
  }

  // ---- Foliage ------------------------------------------------------------------------------
  private drawSway(zone: ZoneMap, tx0: number, ty0: number, tx1: number, ty1: number, ox: number, oy: number, t: number): void {
    const g = this.g;
    const { Wd, Hd, dpr } = this.m;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const idx = ty * zone.w + tx;
        const k = zone.known[idx]!;
        if (!k || !isSwayTile(k - 1, tx, ty)) continue;
        const vis = zone.vis[idx] === 1;
        const amp = (k - 1 === T.TREE ? 0.9 : 1.5) * dpr;
        const sway = vis ? Math.round(Math.sin(t * 2.4 + tx * 0.9 + ty * 0.45) * amp + Math.sin(t * 5.1 + tx * 3.1) * 0.5 * dpr) : 0;
        const lift = vis && k - 1 === T.GRASS ? Math.round(Math.max(0, Math.sin(t * 3.1 + tx * 1.7)) * 0.8 * dpr) : 0;
        for (let sy = 0; sy < SUB; sy++) {
          for (let sx = 0; sx < SUB; sx++) {
            const c = terrainCell(k - 1, tx * SUB + sx, ty * SUB + sy, sx, sy);
            this.atlas.draw(g, c.ch, c.fg, ox + (tx * SUB + sx) * Wd + sway, oy + (ty * SUB + sy) * Hd - lift);
          }
        }
      }
    }
  }

  // ---- Water --------------------------------------------------------------------------------
  private reflection(zone: ZoneMap, wcx: number, wcy: number, t: number): { ch: string; color: number } | null {
    let y = wcy, d = 0;
    for (;;) {
      y--; d++;
      if (d > 10) return null;
      const tile = this.tileAtCell(zone, wcx, y);
      if (tile < 0) return null;
      if (!isWater(tile)) break;
    }
    const off = Math.round(Math.sin(t * 2.1 + wcy * 0.8 + wcx * 0.07) * (0.6 + d * 0.22));
    const sx = wcx + off, sy = y - (d - 1);
    if (hash2(wcx, wcy, Math.floor(t * 5) + 17) < 0.14 + 0.035 * d) return null; // the current breaks the image
    let ch: string, col: number;
    const ent = this.entCells.get(ckey(sx, sy));
    if (ent) { ch = flipGlyph(ent.ch); col = ent.color; }
    else {
      const tile = this.tileAtCell(zone, sx, sy);
      if (tile < 0 || isWater(tile)) return null;
      const c = terrainCell(tile, sx, sy, ((sx % SUB) + SUB) % SUB, ((sy % SUB) + SUB) % SUB);
      if (c.ch === ' ') return null;
      ch = flipGlyph(c.ch); col = c.fg;
    }
    const fade = Math.pow(clamp01(1 - d / 10.5), 1.25);
    // Brighten the source so the mirror survives the night shading, and let it sink into the water colour.
    const lift = (((Math.min(255, ((col >> 16) & 255) * 1.8)) | 0) << 16) | (((Math.min(255, ((col >> 8) & 255) * 1.8)) | 0) << 8) | (Math.min(255, (col & 255) * 1.8) | 0);
    return { ch, color: mix3(0x1a6488, lift, 0.85 * fade) };
  }

  private drawWater(zone: ZoneMap, tx0: number, ty0: number, tx1: number, ty1: number, ox: number, oy: number, t: number, night: number, indoor: boolean, nowMs: number): void {
    const g = this.g;
    const { Wd, Hd, W, H } = this.m;
    const moonX = Math.round(W * MOON_POS.x);
    const moonBottomPx = H * MOON_POS.y + MOON_R * Hd;
    // The moon's image falls on the water in front of the player: aim it at the visible water, clamped so
    // the whole crescent stays on a body of water where there is room.
    let wMin = Infinity, wMax = -Infinity;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const k2 = zone.known[ty * zone.w + tx]!;
      if (k2 && zone.vis[ty * zone.w + tx] === 1 && isWater(k2 - 1)) { wMin = Math.min(wMin, tx); wMax = Math.max(wMax, tx); }
    }
    const moonWcx0 = Math.round((moonX - ox) / Wd);
    const lo = wMin * SUB + MOON_R * 2, hi = wMax * SUB + SUB - 1 - MOON_R * 2;
    const moonWcx = wMin === Infinity ? moonWcx0 : lo <= hi ? Math.max(lo, Math.min(hi, moonWcx0)) : Math.round((wMin + wMax) * SUB / 2);
    const topWater = new Map<number, number>();
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const idx = ty * zone.w + tx;
        const k = zone.known[idx]!;
        if (!k || zone.vis[idx] !== 1 || !isWater(k - 1)) continue;
        const deep = k - 1 === T.WATER;
        // One background fill per tile (not per cell); the glyphs on top carry the detail.
        const tideWave = Math.sin(t * 1.2 + tx * 0.5 + ty * 0.9);
        g.fillStyle = deep ? css(mix3(0x061a2a, 0x082436, 0.5 + 0.5 * tideWave)) : css(mix3(0x0a2c3e, 0x0d364a, 0.5 + 0.5 * tideWave));
        g.fillRect(ox + tx * SUB * Wd, oy + ty * SUB * Hd, SUB * Wd, SUB * Hd);
        for (let sy = 0; sy < SUB; sy++) {
          for (let sx = 0; sx < SUB; sx++) {
            const wcx = tx * SUB + sx, wcy = ty * SUB + sy;
            const x = ox + wcx * Wd, y = oy + wcy * Hd;
            const wave = Math.sin(t * 1.5 + wcx * 0.33 + wcy * 0.85);
            const r = this.reflection(zone, wcx, wcy, t);
            if (r) this.atlas.draw(g, r.ch, r.color, x, y);
            else {
              const ch = wave > 0.55 ? '~' : wave > 0.05 ? '-' : wave > -0.45 ? '.' : ',';
              this.atlas.draw(g, ch, mix3(deep ? 0x1a5c80 : 0x3a9cb8, 0x6ec8e8, clamp01(wave * 0.5 + 0.3)), x, y);
            }
            // The moon's reflection and its glitter path.
            if (!indoor && night > 0.12 && y > moonBottomPx) {
              const dx = wcx - moonWcx;
              let first = topWater.get(wcx);
              if (first === undefined) { first = wcy; topWater.set(wcx, wcy); }
              const kk = wcy - first;
              if (kk <= MOON_R * 2 + 1 && Math.abs(dx) <= MOON_W / 2 + 3) {
                const shift = Math.round(Math.sin(t * 2.3 + kk * 0.9) * 1.3);
                const mc = hash2(wcx, wcy, Math.floor(t * 6) + 3) < 0.2 + kk * 0.03 ? null : moonCell(dx + shift, MOON_R - kk);
                if (mc) this.glints.push({ x, y, ch: mc.ch, color: mix3(0x9fc8e8, 0xffffff, mc.bright), a: night * (1 - kk / (MOON_R * 2 + 3)) * 0.85 });
              }
              if (Math.abs(dx) <= 9 && kk > 1) {
                const band = 1 - Math.abs(dx) / 10;
                const fall = Math.max(0, 1 - kk / 40);
                if (hash2(wcx, wcy, Math.floor(nowMs / 140)) < band * band * 0.34 * fall) {
                  this.glints.push({ x, y, ch: hash2(wcx, wcy, 9) > 0.5 ? 'o' : '*', color: 0xcfe6ff, a: night * band * fall * 0.7 });
                }
              }
            }
          }
        }
      }
    }
  }

  private drawGlints(night: number): void {
    if (!this.glints.length || night < 0.1) return;
    const g = this.g;
    for (const gl of this.glints) {
      g.globalAlpha = clamp01(gl.a);
      this.atlas.draw(g, gl.ch, gl.color, gl.x, gl.y, true);
    }
    g.globalAlpha = 1;
  }

  private drawMoon(night: number): void {
    const g = this.g;
    const { W, H, Wd, Hd, dpr } = this.m;
    const mx = Math.round(W * MOON_POS.x), my = Math.round(H * MOON_POS.y);
    g.globalCompositeOperation = 'lighter';
    const rg = g.createRadialGradient(mx, my, 0, mx, my, MOON_W * Wd);
    rg.addColorStop(0, css(0x9ab8ff, 0.2 * night));
    rg.addColorStop(1, css(0x9ab8ff, 0));
    g.fillStyle = rg;
    g.fillRect(mx - MOON_W * Wd, my - MOON_W * Wd, MOON_W * Wd * 2, MOON_W * Wd * 2);
    g.globalCompositeOperation = 'source-over';
    g.shadowColor = '#bcd4ff';
    g.shadowBlur = 8 * dpr;
    g.globalAlpha = clamp01(night * 1.2);
    for (let dy = -MOON_R; dy <= MOON_R; dy++) {
      for (let dx = -MOON_R * 2; dx <= MOON_R * 2; dx++) {
        const c = moonCell(dx, dy);
        if (c) this.atlas.draw(g, c.ch, mix3(0xa8bce0, 0xffffff, c.bright), mx + dx * Wd, my + dy * Hd, true);
      }
    }
    g.shadowBlur = 0;
    g.globalAlpha = 1;
  }

  // ---- Light & fog --------------------------------------------------------------------------
  private applyLight(zone: ZoneMap, tx0: number, ty0: number, tx1: number, ty1: number, ox: number, oy: number, night: number, indoor: boolean, nowMs: number): void {
    const g = this.g;
    const { Wd, Hd } = this.m;
    const tw = tx1 - tx0 + 1, th = ty1 - ty0 + 1;
    if (this.mask.width !== tw || this.mask.height !== th) {
      this.mask = this.make(tw, th);
      this.maskImg = null;
    }
    const mg = this.mask.getContext('2d')!;
    const img = (this.maskImg ??= mg.createImageData(tw, th));
    const data = img.data;

    const day = [1, 0.97, 0.9];
    const dark = indoor ? [0.07, 0.08, 0.14] : [0.1, 0.15, 0.3];
    const amb = [lerp(day[0]!, dark[0]!, night), lerp(day[1]!, dark[1]!, night), lerp(day[2]!, dark[2]!, night)];
    const lant = indoor ? [1.0, 0.8, 0.52] : [0.62, 0.86, 1.0];
    const lanternAdd = (0.1 + 0.9 * night) * (1 + 0.05 * Math.sin(nowMs / 120) + 0.03 * Math.sin(nowMs / 41));
    const fov = zone.fov;
    const cx = this.cam.x, cy = this.cam.y;
    let i = 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++, i += 4) {
        const idx = ty * zone.w + tx;
        if (!zone.known[idx]) { data[i] = data[i + 1] = data[i + 2] = 0; data[i + 3] = 255; continue; }
        let r: number, gg: number, b: number;
        if (zone.vis[idx] === 1) {
          const dn = Math.hypot((tx - cx) / 2, ty - cy) / (fov * 0.95);
          let L = clamp01(1 - dn);
          L = L * L * (3 - 2 * L);
          r = amb[0]! + lant[0]! * L * lanternAdd;
          gg = amb[1]! + lant[1]! * L * lanternAdd;
          b = amb[2]! + lant[2]! * L * lanternAdd;
        } else {
          // Remembered ground: faint, slightly desaturated.
          const m = (amb[0]! + amb[1]! + amb[2]!) / 3;
          r = lerp(amb[0]!, m, 0.35) * 0.5; gg = lerp(amb[1]!, m, 0.35) * 0.5; b = lerp(amb[2]!, m, 0.35) * 0.55;
        }
        data[i] = Math.min(255, r * 255);
        data[i + 1] = Math.min(255, gg * 255);
        data[i + 2] = Math.min(255, b * 255);
        data[i + 3] = 255;
      }
    }
    mg.putImageData(img, 0, 0);
    g.globalCompositeOperation = 'multiply';
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'low';
    g.drawImage(this.mask, ox + tx0 * SUB * Wd, oy + ty0 * SUB * Hd, tw * SUB * Wd, th * SUB * Hd);
    g.globalCompositeOperation = 'source-over';
  }

  // ---- Ambient motes (fireflies at night, drifting dust by day) ------------------------------------
  private drawMotes(dt: number, night: number, indoor: boolean, t: number, zone: ZoneMap): void {
    const g = this.g;
    const { W, H, dpr, Hd } = this.m;
    const want = indoor ? 18 : Math.round(14 + 26 * night);
    while (this.motes.length < want) {
      this.motes.push({ x: W / 2 + (Math.random() - 0.5) * W * 0.5, y: H / 2 + (Math.random() - 0.5) * H * 0.6, vx: 0, vy: 0, ph: Math.random() * 6.28 });
    }
    if (this.motes.length > want) this.motes.length = want;
    const rx = zone.fov * Hd * 2 * 0.95, ry = zone.fov * Hd * 0.95;
    g.save();
    for (const m of this.motes) {
      m.ph += dt * (0.8 + (m.x % 1));
      m.vx = Math.sin(m.ph * 1.3) * 9 * dpr; m.vy = Math.cos(m.ph * 0.9) * 6 * dpr - (indoor ? 3 * dpr : 0);
      m.x += m.vx * dt; m.y += m.vy * dt;
      const nx = (m.x - W / 2) / rx, ny = (m.y - H / 2) / ry;
      if (nx * nx + ny * ny > 1) { m.x = W / 2 + (Math.random() - 0.5) * rx * 1.4; m.y = H / 2 + (Math.random() - 0.5) * ry * 1.4; continue; }
      const tw = 0.5 + 0.5 * Math.sin(t * 3 + m.ph * 2);
      const a = (indoor ? 0.35 : night > 0.2 ? 0.9 : 0.35) * tw * (1 - (nx * nx + ny * ny));
      g.globalAlpha = clamp01(a);
      g.fillStyle = indoor ? '#b8c0d8' : night > 0.2 ? '#d8f080' : '#f4efc8';
      g.shadowColor = g.fillStyle as string;
      g.shadowBlur = night > 0.2 ? 6 * dpr : 0;
      g.fillRect(Math.round(m.x), Math.round(m.y), Math.max(1, Math.round(dpr * 1.4)), Math.max(1, Math.round(dpr * 1.4)));
    }
    g.restore();
  }

  // ---- Entities -----------------------------------------------------------------------------
  private drawEntities(st: ClientState, ox: number, oy: number, t: number): void {
    const g = this.g;
    const { Wd, Hd, dpr, fontPx } = this.m;
    const me = st.me!;
    const TW = SUB * Wd, TH = SUB * Hd;
    const list = [...st.entities.values()].filter((e) => !(e.fl & EF.DEAD)).sort((a, b) => (this.disp.get(a.id)!.y - this.disp.get(b.id)!.y));
    const entPx = Math.round(Hd * 1.05);
    const labelPx = Math.max(9 * dpr, Math.round(fontPx * 1.05));
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    // Name labels are queued here and drawn afterwards in priority order, skipping any that would overlap.
    const labels: { cx: number; cy: number; text: string; color: string; prio: number }[] = [];
    const drawOne = (e: WireEntity | null, x: number, y: number, isMe: boolean): void => {
      const cx = ox + (x * SUB + SUB / 2) * Wd, cy = oy + (y * SUB + SUB / 2) * Hd;
      if (cx < -TW || cy < -TH || cx > this.m.W + TW || cy > this.m.H + TH) return;
      const gl = e ? entityGlyph(e, false) : { ch: '@', fg: 0xffffff, bold: true };
      const loot = e?.k === 'loot';
      let halo = isMe ? 0xdde8ff : 0;
      let ha = isMe ? 0.2 : 0;
      if (e) {
        if (e.id === me.target) { halo = 0xff3030; ha = 0.35; }
        else if (e.fl & EF.PARTY) { halo = 0x40e070; ha = 0.28; }
        else if (e.fl & EF.STUNNED) { halo = 0xffe040; ha = 0.3; }
        else if (e.fl & EF.ROOTED) { halo = 0x40a0ff; ha = 0.3; }
        else if (e.k === 'player') { halo = 0x40e0f0; ha = 0.14; }
        else if (e.k === 'monster') { halo = gl.fg; ha = 0.12; }
      }
      if (ha > 0) {
        g.globalCompositeOperation = 'lighter';
        const rg = g.createRadialGradient(cx, cy, 0, cx, cy, TW * 0.95);
        rg.addColorStop(0, css(halo, ha));
        rg.addColorStop(1, css(halo, 0));
        g.fillStyle = rg;
        g.fillRect(cx - TW, cy - TW, TW * 2, TW * 2);
        g.globalCompositeOperation = 'source-over';
      }
      const bob = loot ? Math.sin(t * 4 + x) * dpr : 0;
      const stealth = e ? !!(e.fl & EF.STEALTH) : st.me!.buffs.some((b) => b.id === 'stealth');
      g.globalAlpha = stealth ? 0.4 : 1;
      g.font = `${gl.bold || isMe ? 'bold ' : ''}${loot ? Math.round(entPx * 0.8) : entPx}px ${FONT_FAMILY}`;
      g.shadowColor = css(gl.fg, 0.9);
      g.shadowBlur = (loot ? 7 : 5) * dpr;
      g.fillStyle = css(gl.fg);
      if (loot) g.globalAlpha *= 0.65 + 0.35 * Math.sin(t * 5 + x * 3);
      g.fillText(gl.ch, cx, cy + bob);
      g.shadowBlur = 0;
      g.globalAlpha = 1;
      if (!e || e.k === 'loot') return;

      // Health bar for hurt monsters and the current target.
      if (e.k === 'monster' && e.mhp > 0 && (e.hp < e.mhp || e.id === me.target)) {
        const bw = TW * 0.95, bh = Math.max(2, Math.round(dpr * 2));
        g.fillStyle = 'rgba(0,0,0,0.65)';
        g.fillRect(cx - bw / 2, cy + TH * 0.52, bw, bh + 2);
        g.fillStyle = e.hp / e.mhp < 0.3 ? '#ff4040' : '#d83c3c';
        g.fillRect(cx - bw / 2 + 1, cy + TH * 0.52 + 1, (bw - 2) * clamp01(e.hp / e.mhp), bh);
      }
      // Name label floating over the head, crisp white with a dark outline (drawn later, see below).
      const near = Math.hypot(e.x - me.x, (e.y - me.y) * 2) < 18;
      if (e.k === 'player' || e.k === 'npc' || near || e.id === me.target) {
        labels.push({
          cx, cy: cy - TH * 0.78, text: e.k === 'monster' ? `${e.n} ${e.lv}` : e.n,
          color: e.k === 'monster' ? '#ffc4b4' : e.k === 'npc' ? '#ffe680' : (e.fl & EF.PARTY) ? '#b8ffc8' : '#ffffff',
          prio: e.id === me.target ? 1 : e.k === 'player' ? 2 : e.k === 'npc' ? 3 : 4 + Math.hypot(e.x - me.x, e.y - me.y) * 0.01,
        });
      }
    };

    for (const e of list) {
      const d = this.disp.get(e.id)!;
      drawOne(e, d.x, d.y, false);
    }
    drawOne(null, this.cam.x, this.cam.y, true);
    labels.push({ cx: ox + (this.cam.x * SUB + SUB / 2) * Wd, cy: oy + (this.cam.y * SUB + SUB / 2) * Hd - TH * 0.78, text: me.name, color: '#e8fbff', prio: 0 });

    labels.sort((p, q) => p.prio - q.prio);
    const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
    g.font = `bold ${labelPx}px ${FONT_FAMILY}`;
    g.lineWidth = Math.max(2, dpr * 2.2);
    g.lineJoin = 'round';
    g.shadowBlur = 0;
    for (const l of labels) {
      const w = g.measureText(l.text).width + 4, h = labelPx * 1.1;
      const r = { x0: l.cx - w / 2, y0: l.cy - h / 2, x1: l.cx + w / 2, y1: l.cy + h / 2 };
      if (taken.some((o) => r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0)) continue;
      taken.push(r);
      g.strokeStyle = 'rgba(0,0,6,0.9)';
      g.strokeText(l.text, l.cx, l.cy);
      g.fillStyle = l.color;
      g.fillText(l.text, l.cx, l.cy);
    }
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
  }

  // ---- Floating combat text & bursts ------------------------------------------------------------
  private drawFx(st: ClientState, ox: number, oy: number, nowMs: number): void {
    const g = this.g;
    const { Wd, Hd, dpr, fontPx } = this.m;
    const TW = SUB * Wd, TH = SUB * Hd;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const start = Math.max(0, st.fx.length - 90);
    for (let i = start; i < st.fx.length; i++) {
      const f = st.fx[i]!;
      const age = nowMs - f.born;
      const cx = ox + (f.x * SUB + SUB / 2) * Wd, cy = oy + (f.y * SUB + SUB / 2) * Hd;
      if (f.kind === 'burst') {
        if (age > 420) continue;
        const life = 1 - age / 420;
        g.globalCompositeOperation = 'lighter';
        const rg = g.createRadialGradient(cx, cy, 0, cx, cy, TW * 1.3);
        rg.addColorStop(0, css(0xffa040, 0.55 * life));
        rg.addColorStop(1, css(0xff4010, 0));
        g.fillStyle = rg;
        g.fillRect(cx - TW * 1.4, cy - TW * 1.4, TW * 2.8, TW * 2.8);
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = life;
        g.font = `bold ${Math.round(Hd * 1.1)}px ${FONT_FAMILY}`;
        g.fillStyle = age < 140 ? '#fff4b0' : age < 280 ? '#ffb040' : '#e05020';
        g.shadowColor = '#ff8030';
        g.shadowBlur = 8 * dpr;
        g.fillText(f.text[0] === '*' ? (age % 120 < 60 ? '*' : '+') : f.text[0] ?? '*', cx, cy);
        g.shadowBlur = 0;
        g.globalAlpha = 1;
        continue;
      }
      if (age > 1300) continue;
      const u = age / 1300;
      const rise = (1 - Math.pow(1 - u, 2.2)) * TH * 2.4;
      let text = f.text, color = '#ffffff', size = fontPx * 1.25, bold = false;
      switch (f.kind) {
        case 'hit': text = `-${f.text}`; color = '#ffffff'; break;
        case 'crit': text = `-${f.text}!`; color = '#ffb030'; size = fontPx * 1.7; bold = true; break;
        case 'hurt': text = `-${f.text}`; color = '#ff5050'; bold = true; break;
        case 'heal': color = '#58ff90'; break;
        case 'miss': text = 'MISS'; color = '#a8b0c0'; break;
        case 'xp': color = '#ffd860'; break;
        case 'info': color = '#f070ff'; bold = true; break;
      }
      g.globalAlpha = clamp01(1.6 - u * 1.6);
      g.font = `${bold ? 'bold ' : ''}${Math.round(size)}px ${FONT_FAMILY}`;
      g.lineWidth = Math.max(2, dpr * 2);
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(0,0,8,0.85)';
      const jx = Math.sin(i * 12.9) * TW * 0.25;
      g.strokeText(text, cx + jx, cy - TH * 0.4 - rise);
      g.shadowColor = color;
      g.shadowBlur = 5 * dpr;
      g.fillStyle = color;
      g.fillText(text, cx + jx, cy - TH * 0.4 - rise);
      g.shadowBlur = 0;
      g.globalAlpha = 1;
    }
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
  }
}
