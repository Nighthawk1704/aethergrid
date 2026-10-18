// Translucent HUD drawn on a character grid and blitted over the world. Chat and the minimap reuse the
// shared panels; the status panel, skill bar, target frame and metrics are bespoke.
import { C, mix } from '../../shared/colors';
import { CLASSES, SKILLS } from '../../shared/gamedata';
import { EF, type InventoryView } from '../../shared/types';
import type { GameApp } from '../../shared/ui/app';
import { drawChat, drawMinimap } from '../../shared/ui/panels';
import { ATTR, Screen } from '../../shared/ui/screen';
import { truncate } from '../../shared/ui/theme';
import { GlyphAtlas, paintScreen, type MakeCanvas } from './atlas';
import { formatHour, type TimeOfDay } from './sky';

const PANEL = 0x060a14;
const BORDER = 0x4a5a7a;

/** Cosmetic carry weight derived from what is in the bag and worn (the game has no weight stat). */
export function loadKg(inv: InventoryView | null): number {
  if (!inv) return 0;
  const w = (it: { slot: string; qty: number; ilvl: number } | null): number => {
    if (!it) return 0;
    switch (it.slot) {
      case 'weapon': return 3 + it.ilvl * 0.4;
      case 'armor': return 6 + it.ilvl * 0.7;
      case 'ring': case 'amulet': return 0.1;
      case 'consumable': return 0.4 * it.qty;
      default: return 1.2 * it.qty;
    }
  };
  let total = 0;
  for (const it of inv.bag) total += w(it);
  for (const it of Object.values(inv.equip)) total += w(it);
  return total;
}

/** A dense, textured bar such as [█████▓░░░░]. */
function texBar(s: Screen, x: number, y: number, w: number, frac: number, dark: number, bright: number): void {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  const exact = f * w;
  const full = Math.floor(exact);
  const rest = exact - full;
  s.set(x, y, '[', BORDER);
  for (let i = 0; i < w; i++) {
    const col = mix(dark, bright, w > 1 ? i / (w - 1) : 1);
    if (i < full) s.set(x + 1 + i, y, '█', col);
    else if (i === full && rest > 0.66) s.set(x + 1 + i, y, '▓', col);
    else if (i === full && rest > 0.33) s.set(x + 1 + i, y, '▒', col);
    else s.set(x + 1 + i, y, '░', mix(dark, C.black, 0.45));
  }
  s.set(x + w + 1, y, ']', BORDER);
}

function panel(s: Screen, x: number, y: number, w: number, h: number, title = ''): void {
  s.fill(x, y, w, h, PANEL);
  s.box(x, y, w, h, BORDER, title, 0xb8c8e8, PANEL);
}

export class Hud {
  private screen = new Screen(10, 10);
  private tmp = new Screen(100, 34);
  private atlas: GlyphAtlas;
  private W = 0;
  private H = 0;
  private fade = 0;

  constructor(private readonly make: MakeCanvas) {
    this.atlas = new GlyphAtlas(make, 8, 16, 13);
  }

  resize(W: number, H: number, dpr: number, worldFontPx: number): void {
    this.W = W; this.H = H;
    const px = Math.max(11 * dpr, Math.round(worldFontPx * 1.1));
    const cw = Math.round(px * 0.6), ch = Math.round(px * 1.25);
    this.atlas = new GlyphAtlas(this.make, cw, ch, px);
    this.screen = new Screen(Math.max(40, Math.floor(W / cw)), Math.max(14, Math.floor(H / ch)));
  }

  draw(g: CanvasRenderingContext2D, app: GameApp, fps: number, frameMs: number, tod: TimeOfDay, mode: string, dt: number): void {
    const st = app.st;
    const s = this.screen;
    s.clear(C.black);
    this.fade += (1 - this.fade) * (1 - Math.exp(-dt * 3));
    const me = st.me, zone = st.zone;
    if (!me || !zone) return;
    const cols = s.w, rows = s.h;

    // ---- Status panel (top-left) -------------------------------------------------------------
    panel(s, 1, 0, 38, 9, me.name);
    const cls = CLASSES[me.cls];
    s.text(3, 1, `Lv ${me.lv} ${cls.name}`, C.yellow, -1, ATTR.BOLD);
    s.textRight(37, 1, `${me.gold}g`, C.gold, -1, ATTR.BOLD);
    s.text(3, 2, 'HP', C.hpRed, -1, ATTR.BOLD);
    texBar(s, 6, 2, 18, me.hp / me.stats.maxHp, 0x6a1414, me.hp < me.stats.maxHp * 0.3 ? 0xff4040 : 0xe05050);
    s.text(27, 2, `${me.hp}/${me.stats.maxHp}`, C.text);
    s.text(3, 3, 'MP', C.mpBlue, -1, ATTR.BOLD);
    texBar(s, 6, 3, 18, me.mp / Math.max(1, me.stats.maxMp), 0x14306a, 0x58a0ff);
    s.text(27, 3, `${me.mp}/${me.stats.maxMp}`, C.text);
    s.text(3, 4, 'XP', C.xpGold, -1, ATTR.BOLD);
    texBar(s, 6, 4, 18, me.xpNext ? me.xp / me.xpNext : 0, 0x5a4410, 0xf0c840);
    s.text(27, 4, `${me.xpNext ? Math.floor((me.xp / me.xpNext) * 100) : 0}%`, C.text);
    const kg = loadKg(st.inv);
    s.text(3, 5, 'Load', C.dim);
    s.text(8, 5, `${kg.toFixed(1)}kg`, kg > 40 ? C.orange : C.text);
    s.text(18, 5, `ATK ${Math.round(me.stats.atk)} DEF ${Math.round(me.stats.def)}`, C.dim);
    const grp = st.party.length ? `Group ${st.party.length}: ${st.party.map((m) => m.name + (m.leader ? '*' : '')).join(', ')}` : 'Group: Solo';
    s.text(3, 6, truncate(grp, 34), st.party.length ? C.green : C.dim);
    const buffs = me.buffs.map((b) => `${b.id} ${Math.ceil(b.ticks / 10)}s`).join('  ');
    s.text(3, 7, truncate(buffs || 'No effects', 34), buffs ? C.cyan : C.dimmer);

    // ---- Performance & world (top-right) -----------------------------------------------------------
    const pw = 40, px = cols - pw - 1;
    panel(s, px, 0, pw, 5);
    s.text(px + 2, 1, `FPS ${Math.round(fps)}`, fps >= 55 ? C.green : fps >= 30 ? C.yellow : C.red, -1, ATTR.BOLD);
    s.textRight(px + pw - 3, 1, `Frame ${frameMs.toFixed(1)}ms`, C.text);
    const nightTag = zone.depth > 0 ? 'DEEP' : tod.night > 0.6 ? 'NIGHT' : tod.night > 0.15 ? 'DUSK' : 'DAY';
    s.text(px + 2, 2, truncate(zone.name, pw - 4), C.borderBright);
    s.text(px + 2, 3, zone.depth > 0 ? 'Catacombs' : formatHour(tod.hour), C.dim);
    s.textRight(px + pw - 3, 3, nightTag, tod.night > 0.5 || zone.depth ? 0x8aa4ff : C.yellow, -1, ATTR.BOLD);
    s.textRight(px + pw - 3, 4, `ping ${Math.round(app.net.latency)}ms${mode === 'auto' ? '' : '  [' + mode + ']'}`, C.dimmer);

    // ---- Minimap + nearby (reusing the shared panel) -------------------------------------------------
    const ctx = app.renderCtx();
    const t = this.tmp;
    t.clear(C.black);
    drawMinimap(t, ctx);
    this.copy(t, 60, 12, 40, 10, s, cols - 41, 6);

    // ---- Chat (reusing the shared panel) ---------------------------------------------------------------
    t.clear(C.black);
    drawChat(t, ctx);
    const cw = Math.min(100, cols - 2);
    this.copy(t, 0, 22, cw, 12, s, 1, rows - 12);

    // ---- Target frame -------------------------------------------------------------------------------------
    const tgt = me.target ? st.entities.get(me.target) : undefined;
    if (tgt && !(tgt.fl & EF.DEAD)) {
      const tw = 30, tx = Math.floor((cols - tw) / 2);
      panel(s, tx, 0, tw, 4);
      s.center(tx, tw, 1, truncate(`${tgt.n}  Lv ${tgt.lv}`, tw - 4), tgt.k === 'monster' ? 0xffa090 : C.white, -1, ATTR.BOLD);
      texBar(s, tx + 3, 2, tw - 8, tgt.mhp ? tgt.hp / tgt.mhp : 0, 0x6a1414, 0xe04040);
    }

    // ---- Skill bar (bottom-right) --------------------------------------------------------------------------
    const bw = 17, bx = cols - bw * 4 - 2, by = rows - 5;
    const bag = st.inv?.bag ?? [];
    const count = (base: string): number => bag.reduce((n, i) => n + (i?.base === base ? i.qty : 0), 0);
    for (let i = 0; i < 4; i++) {
      const x = bx + i * bw;
      let name: string, sub: string, max = 1;
      if (i < 2) {
        const sk = SKILLS[cls.skills[i]!];
        name = sk.name; sub = `${sk.mp} MP`; max = sk.cd;
      } else {
        name = i === 2 ? 'Health Potion' : 'Mana Potion';
        const n = count(i === 2 ? 'health_potion' : 'mana_potion');
        sub = `x${n}`; max = 20;
      }
      const cd = me.cd[i] ?? 0;
      const ready = cd <= 0;
      panel(s, x, by, bw - 1, 4);
      s.text(x + 2, by + 1, `${i + 1}`, ready ? C.yellow : C.dim, -1, ATTR.BOLD);
      s.text(x + 4, by + 1, truncate(name, bw - 6), ready ? C.white : C.dim);
      s.text(x + 2, by + 2, sub, C.dim);
      if (!ready) {
        s.textRight(x + bw - 3, by + 2, `${(cd / 10).toFixed(1)}s`, C.orange, -1, ATTR.BOLD);
        const frac = Math.min(1, cd / max);
        const w2 = bw - 3;
        for (let k = 0; k < w2 * frac; k++) s.set(x + 1 + k, by + 3, '▒', 0x805020);
      }
    }

    g.save();
    g.globalAlpha = this.fade;
    paintScreen(g, this.atlas, s, 0, 0, { bgAlpha: 0.6, clearBlack: true, alpha: 1 });
    g.restore();
  }

  private copy(src: Screen, sx: number, sy: number, w: number, h: number, dst: Screen, dx: number, dy: number): void {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (sy + y) * src.w + sx + x;
        if (!dst.inside(dx + x, dy + y)) continue;
        const di = (dy + y) * dst.w + dx + x;
        dst.ch[di] = src.ch[si]!;
        dst.fg[di] = src.fg[si]!;
        dst.bg[di] = src.bg[si] === 0 ? 0x04070d : src.bg[si]!;
        dst.at[di] = src.at[si]!;
      }
    }
  }
}
