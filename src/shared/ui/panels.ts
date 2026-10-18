// The four always-visible panes: viewport, stats, minimap + nearby list, chat.
import { C, RARITY_COLORS, mix, scale, type Rgb } from '../colors';
import { LAYOUT } from '../constants';
import { CLASSES } from '../gamedata';
import type { ChatChannel, WireEntity } from '../types';
import { EF } from '../types';
import { T, tileDef } from '../tiles';
import type { ClientState } from '../client/state';
import { ATTR, KEEP, Screen } from './screen';
import { entityGlyph, fogColor, tileGlyph, truncate, waterColor } from './theme';

export interface RenderCtx {
  st: ClientState;
  /** Milliseconds, monotonically increasing; drives animation. */
  now: number;
  chatTab: number;
  chatFocus: boolean;
  chatInput: string;
  unread: boolean[];
  latency: number;
  /** Lines scrolled back from the newest (0 = follow). */
  chatScroll: number;
}

// ---- Viewport -----------------------------------------------------------------------------------
const VIEW_CX = 30; // screen column of the player (interior is columns 1..58)
const VIEW_CY = 11; // screen row of the player (interior is rows 1..20)

const FX_COLORS: Record<string, Rgb> = {
  hit: 0xffffff, crit: C.orange, hurt: 0xff5050, heal: 0x50ff80, miss: C.dim, xp: C.gold, info: C.magenta, burst: C.yellow,
};

export function drawViewport(s: Screen, ctx: RenderCtx): void {
  const R = LAYOUT.viewport;
  const { st } = ctx;
  const zone = st.zone, me = st.me;
  s.box(R.x, R.y, R.w, R.h, C.border, zone ? `${zone.name}  ${zone.pvp ? '[PvP]' : '[Safe]'}` : 'AetherGrid');
  if (!zone || !me) { s.center(1, 58, 11, 'Entering the world...', C.dim); return; }

  const t = ctx.now / 1000;
  const fov = zone.fov;
  for (let sy = 1; sy <= 20; sy++) {
    for (let sx = 1; sx <= 58; sx++) {
      const wx = me.x + sx - VIEW_CX, wy = me.y + sy - VIEW_CY;
      if (wx < 0 || wy < 0 || wx >= zone.w || wy >= zone.h) continue;
      const idx = wy * zone.w + wx;
      const k = zone.known[idx]!;
      if (!k) continue;
      const g = tileGlyph(k - 1);
      let fg = g.fg;
      const visible = zone.vis[idx] === 1;
      if (g.animated) fg = waterColor(fg, wx, wy, t);
      if (visible) {
        const d = Math.hypot((wx - me.x) / 2, wy - me.y) / fov;
        fg = scale(fg, Math.max(0.55, 1.08 - 0.5 * d * d));
      } else fg = fogColor(fg);
      s.set(sx, sy, g.ch, fg, C.black, 0);
    }
  }

  // Entities, drawn by increasing importance.
  const order = (e: WireEntity): number => (e.k === 'loot' ? 0 : e.k === 'npc' ? 1 : e.k === 'monster' ? 2 : 3);
  const ents = [...st.entities.values()].sort((a, b) => order(a) - order(b));
  const blink = Math.floor(ctx.now / 400) % 2 === 0;
  for (const e of ents) {
    if (e.fl & EF.DEAD) continue;
    const sx = e.x - me.x + VIEW_CX, sy = e.y - me.y + VIEW_CY;
    if (sx < 1 || sx > 58 || sy < 1 || sy > 20) continue;
    const g = entityGlyph(e);
    let fg = g.fg, bg: number = C.black, attr = g.bold ? ATTR.BOLD : 0;
    if (e.id === me.target) bg = 0x5a1414;
    else if (e.fl & EF.PARTY) bg = 0x0f3a1a;
    if (e.fl & EF.STUNNED) bg = 0x4a4400;
    if (e.fl & EF.ROOTED) bg = 0x103a5a;
    if (e.fl & EF.FLEEING) fg = scale(fg, blink ? 1 : 0.5);
    if (e.fl & EF.ENRAGED) attr |= ATTR.BOLD;
    if (e.fl & EF.STEALTH) fg = scale(fg, 0.5);
    if (e.k === 'player' && e.fl & EF.PVP) attr |= ATTR.UNDERLINE;
    s.set(sx, sy, g.ch, fg, bg, attr);
  }
  // The local player, always centred.
  const stealth = me.buffs.some((b) => b.id === 'stealth');
  s.set(VIEW_CX, VIEW_CY, '@', stealth ? C.dim : C.brightWhite, 0x1a1a24, ATTR.BOLD);

  drawFx(s, ctx, me.x, me.y);
}

function drawFx(s: Screen, ctx: RenderCtx, mx: number, my: number): void {
  const fx = ctx.st.fx;
  const start = Math.max(0, fx.length - 80);
  // Bursts first so numbers stay legible on top.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = start; i < fx.length; i++) {
      const f = fx[i]!;
      const age = ctx.now - f.born;
      const sx = f.x - mx + VIEW_CX, sy = f.y - my + VIEW_CY;
      if ((f.kind === 'burst') !== (pass === 0)) continue;
      if (f.kind === 'burst') {
        if (age > 320 || sx < 1 || sx > 58 || sy < 1 || sy > 20) continue;
        const col = [C.yellow, C.orange, C.red, 0x883322][Math.min(3, Math.floor(age / 90))]!;
        s.set(sx, sy, f.text[0] ?? '*', col, mix(C.black, col, 0.18), ATTR.BOLD);
      } else {
        if (age > 1000) continue;
        const rise = Math.min(3, Math.floor(age / 240));
        const text = f.kind === 'crit' ? `${f.text}!` : f.text;
        const y = sy - rise;
        const x0 = sx - (text.length >> 1);
        const col = scale(FX_COLORS[f.kind] ?? C.white, age > 750 ? 0.6 : 1);
        for (let k = 0; k < text.length; k++) {
          const x = x0 + k;
          if (x >= 1 && x <= 58 && y >= 1 && y <= 20) s.set(x, y, text[k]!, col, KEEP, f.kind === 'crit' || f.kind === 'info' ? ATTR.BOLD : 0);
        }
      }
    }
  }
}

// ---- Stats --------------------------------------------------------------------------------------
export function drawStats(s: Screen, ctx: RenderCtx): void {
  const R = LAYOUT.stats;
  const me = ctx.st.me, inv = ctx.st.inv, zone = ctx.st.zone;
  s.box(R.x, R.y, R.w, R.h, C.border, 'Character');
  if (!me) return;
  const x = R.x + 2, w = R.w - 4;
  const cls = CLASSES[me.cls];
  s.text(x, 1, truncate(me.name, 16), C.brightWhite, KEEP, ATTR.BOLD);
  s.textRight(x + w - 1, 1, `Lv ${me.lv} ${cls.name}`, C.yellow);

  const bar = (row: number, label: string, cur: number, max: number, fg: Rgb): void => {
    s.text(x, row, label, fg, KEEP, ATTR.BOLD);
    s.bar(x + 3, row, 17, max > 0 ? cur / max : 0, fg, scale(fg, 0.3));
    s.text(x + 21, row, `${cur}/${max}`, C.text);
  };
  bar(2, 'HP', me.hp, me.stats.maxHp, me.hp < me.stats.maxHp * 0.25 ? C.brightRed : C.hpRed);
  bar(3, 'MP', me.mp, me.stats.maxMp, C.mpBlue);
  bar(4, 'XP', me.xp, me.xpNext, C.xpGold);

  const ox = zone?.origin.x ?? 0, oy = zone?.origin.y ?? 0;
  s.text(x, 5, `Gold `, C.dim);
  s.text(x + 5, 5, String(me.gold), C.gold, KEEP, ATTR.BOLD);
  s.textRight(x + w - 1, 5, `(${me.x - ox}, ${me.y - oy})`, C.text);

  const st = me.stats;
  s.text(x, 6, `ATK ${Math.round(st.atk)}  MAG ${Math.round(st.mag)}  DEF ${Math.round(st.def)}  CRT ${Math.round(st.crit)}%`, C.text);

  const slotRow = (row: number, tag: string, name: string | undefined, col: Rgb | undefined): void => {
    s.text(x, row, tag, C.dim);
    s.text(x + 3, row, truncate(name ?? '—', w - 3), col ?? C.dimmer);
  };
  const eq = inv?.equip;
  slotRow(7, 'W:', eq?.weapon?.name, eq?.weapon ? RARITY_COLORS[eq.weapon.rarity] : undefined);
  slotRow(8, 'A:', eq?.armor?.name, eq?.armor ? RARITY_COLORS[eq.armor.rarity] : undefined);
  s.text(x, 9, 'R:', C.dim);
  s.text(x + 3, 9, truncate(eq?.ring?.name ?? '—', 14), eq?.ring ? RARITY_COLORS[eq.ring.rarity] : C.dimmer);
  s.text(x + 18, 9, '%:', C.dim);
  s.text(x + 21, 9, truncate(eq?.amulet?.name ?? '—', w - 21), eq?.amulet ? RARITY_COLORS[eq.amulet.rarity] : C.dimmer);

  // Active buffs on the last interior row.
  const buffs = me.buffs.map((b) => `${b.id[0]!.toUpperCase()}${b.id.slice(1)} ${Math.ceil(b.ticks / 10)}s`).join(' ');
  s.text(x, 10, truncate(buffs || 'No active buffs', w), buffs ? C.cyan : C.dimmer);
  if (me.pvp) s.textRight(x + w - 1, 0, ' PvP ', C.brightRed, KEEP, ATTR.BOLD);
}

// ---- Minimap + nearby ---------------------------------------------------------------------------
const MM_W = 19;
const MM_H = 8;

const MM_PRIORITY: { match: (t: number) => boolean; ch: string }[] = [
  { match: (t) => t === T.STAIRS_DOWN || t === T.STAIRS_UP, ch: '>' },
  { match: (t) => t === T.GATE, ch: '^' },
  { match: (t) => t === T.BANK || t === T.BOARD, ch: '$' },
  { match: (t) => t === T.DOOR_CLOSED || t === T.DOOR_OPEN, ch: '+' },
  { match: (t) => t === T.WALL || t === T.RUIN_WALL, ch: '#' },
  { match: (t) => t === T.WATER, ch: '~' },
  { match: (t) => t === T.TREE, ch: 'T' },
  { match: (t) => t === T.ORE, ch: '*' },
  { match: (t) => t === T.BRIDGE || t === T.ROAD, ch: ':' },
  { match: (t) => t === T.GRASS, ch: '"' },
  { match: (t) => t === T.SHALLOW, ch: '-' },
];

export function drawMinimap(s: Screen, ctx: RenderCtx): void {
  const R = LAYOUT.minimap;
  const { st } = ctx;
  s.box(R.x, R.y, R.w, R.h, C.border, 'Map');
  const z = st.zone, me = st.me;
  if (!z || !me) return;
  const mx0 = R.x + 1, my0 = R.y + 1;
  const bw = z.w / MM_W, bh = z.h / MM_H;

  for (let cy = 0; cy < MM_H; cy++) {
    for (let cx = 0; cx < MM_W; cx++) {
      const x0 = Math.floor(cx * bw), x1 = Math.max(x0 + 1, Math.floor((cx + 1) * bw));
      const y0 = Math.floor(cy * bh), y1 = Math.max(y0 + 1, Math.floor((cy + 1) * bh));
      let best = -1, bestTile = 0, seen = false;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const k = z.known[y * z.w + x]!;
          if (!k) continue;
          seen = true;
          const tile = k - 1;
          const p = MM_PRIORITY.findIndex((m) => m.match(tile));
          const rank = p < 0 ? MM_PRIORITY.length : p;
          if (best < 0 || rank < best) { best = rank; bestTile = tile; }
        }
      }
      if (!seen) continue;
      const ch = best >= 0 && best < MM_PRIORITY.length ? MM_PRIORITY[best]!.ch : '.';
      s.set(mx0 + cx, my0 + cy, ch, scale(tileDef(bestTile).fg, 0.85), C.black);
    }
  }
  const cell = (wx: number, wy: number): [number, number] => [mx0 + Math.min(MM_W - 1, Math.floor(wx / bw)), my0 + Math.min(MM_H - 1, Math.floor(wy / bh))];
  for (const e of st.entities.values()) {
    if (e.k === 'loot' || e.fl & EF.DEAD) continue;
    const [px, py] = cell(e.x, e.y);
    const col = e.k === 'monster' ? C.red : e.k === 'npc' ? C.yellow : e.fl & EF.PARTY ? C.green : C.cyan;
    s.set(px, py, e.k === 'monster' ? 'x' : e.k === 'npc' ? 'N' : '@', col, C.black, ATTR.BOLD);
  }
  const [px, py] = cell(me.x, me.y);
  s.set(px, py, '@', Math.floor(ctx.now / 450) % 2 ? C.brightWhite : C.yellow, C.black, ATTR.BOLD);

  // Divider and nearby list.
  const lx = R.x + 1 + MM_W + 1;
  for (let y = R.y + 1; y < R.y + R.h - 1; y++) s.set(lx - 1, y, '│', C.border);
  s.text(lx, R.y, ' Nearby ', C.borderBright);
  const near = [...st.entities.values()]
    .filter((e) => e.k !== 'loot' && !(e.fl & EF.DEAD))
    .map((e) => ({ e, d: Math.max(Math.abs(e.x - me.x), Math.abs(e.y - me.y)) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, MM_H);
  near.forEach(({ e }, i) => {
    const y = R.y + 1 + i;
    const g = entityGlyph(e);
    const isTarget = e.id === me.target;
    if (isTarget) s.set(lx, y, '>', C.brightRed, KEEP, ATTR.BOLD);
    s.set(lx + 1, y, g.ch, g.fg, KEEP, g.bold ? ATTR.BOLD : 0);
    const nameCol = e.fl & EF.PARTY ? C.green : e.k === 'monster' ? 0xe0a0a0 : C.text;
    const lvl = e.lv > 0 ? ` ${e.lv}` : '';
    s.text(lx + 3, y, truncate(e.n + lvl, 8).padEnd(8), nameCol);
    if (e.k !== 'npc' && e.mhp > 0) s.bar(lx + 12, y, 4, e.hp / e.mhp, e.k === 'monster' ? C.hpRed : C.green, 0x333333);
  });
  if (!near.length) s.text(lx + 1, R.y + 3, 'Nobody near', C.dimmer);
}

// ---- Chat ---------------------------------------------------------------------------------------
export const CHAT_TABS = ['Global', 'Local', 'Combat', 'System'] as const;

/** [Global] is the combined view of everything except the (spammy) combat log. */
export const TAB_CHANNELS: ChatChannel[][] = [
  ['global', 'whisper', 'party', 'local', 'system'],
  ['local'],
  ['combat'],
  ['system'],
];

const CHAT_COLORS: Record<ChatChannel, Rgb> = {
  global: 0xe8e8e8, local: 0xb0c8b0, combat: 0xffa860, system: C.yellow, whisper: C.magenta, party: 0x70d0ff,
};

/** Tabs that show a given channel (used for unread markers). */
export function chatTabsOf(chan: ChatChannel): number[] {
  return TAB_CHANNELS.map((c, i) => (c.includes(chan) ? i : -1)).filter((i) => i >= 0);
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut < width * 0.5) cut = width;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

const hhmm = (ts: number): string => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function drawChat(s: Screen, ctx: RenderCtx): void {
  const R = LAYOUT.chat;
  const { st } = ctx;
  s.box(R.x, R.y, R.w, R.h - 1, C.border);
  // Tabs sit on the top border.
  let tx = R.x + 2;
  CHAT_TABS.forEach((name, i) => {
    const active = i === ctx.chatTab;
    const label = `[${name}${ctx.unread[i] && !active ? '*' : ''}]`;
    s.text(tx, R.y, label, active ? C.yellow : ctx.unread[i] ? C.orange : C.dim, C.black, active ? ATTR.BOLD : 0);
    tx += label.length + 1;
  });
  s.textRight(R.x + R.w - 3, R.y, `${ctx.chatScroll ? ' scrolled (PgDn) ' : ''} ${Math.round(ctx.latency)}ms `, ctx.chatScroll ? C.orange : C.dimmer);

  const lines: { time: string; text: string; col: Rgb }[] = [];
  const chans = TAB_CHANNELS[ctx.chatTab]!;
  const TIME_W = 6;
  const width = R.w - 4 - TIME_W;
  for (const m of st.chat) {
    if (!chans.includes(m.chan)) continue;
    let who = '';
    if (m.chan === 'whisper') who = m.from.startsWith('to ') ? `${m.from}: ` : `${m.from} whispers: `;
    else if (m.chan === 'global' || m.chan === 'local') who = m.from === '*' ? '' : `${m.from}: `;
    else if (m.chan === 'party') who = m.from === 'Party' ? '' : m.from === 'Loot' ? '' : `(P) ${m.from}: `;
    wrap(`${who}${m.text}`, width).forEach((w, i) => lines.push({ time: i === 0 ? hhmm(m.ts) : '', text: w, col: CHAT_COLORS[m.chan] }));
  }
  const rows = R.h - 3; // 9 visible lines
  const scroll = Math.min(ctx.chatScroll, Math.max(0, lines.length - rows));
  const end = lines.length - scroll;
  lines.slice(Math.max(0, end - rows), end).forEach((l, i) => {
    const y = R.y + 1 + i;
    s.text(R.x + 2, y, l.time, C.dimmer);
    s.text(R.x + 2 + TIME_W, y, l.text, l.col);
  });

  // Input bar on the final row.
  const iy = R.y + R.h - 1;
  if (ctx.chatFocus) {
    s.fill(0, iy, R.w, 1, 0x161628);
    s.text(1, iy, '>', C.yellow, 0x161628, ATTR.BOLD);
    const room = R.w - 5;
    const shown = ctx.chatInput.length > room ? ctx.chatInput.slice(ctx.chatInput.length - room) : ctx.chatInput;
    s.text(3, iy, shown, C.brightWhite, 0x161628);
    if (Math.floor(ctx.now / 500) % 2 === 0) s.set(3 + shown.length, iy, '█', C.brightWhite, 0x161628);
  } else {
    s.text(1, iy, 'Enter: chat   I: inventory   C: character   Tab: target   1-4: skills   ?: help', C.dimmer);
  }
}

