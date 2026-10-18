import { C, RARITY_COLORS, mix, scale, type Rgb } from '../colors';
import { LOOT_GLYPHS, MONSTERS } from '../gamedata';
import { tileDef } from '../tiles';
import type { Item, WireEntity } from '../types';

export interface Glyph { ch: string; fg: Rgb; bold: boolean }

export function entityGlyph(e: WireEntity, isMe = false): Glyph {
  switch (e.k) {
    case 'player': return isMe ? { ch: '@', fg: C.brightWhite, bold: true } : { ch: '@', fg: C.cyan, bold: false };
    case 'monster': {
      const m = MONSTERS[e.t as keyof typeof MONSTERS];
      return m ? { ch: m.glyph, fg: m.fg, bold: !!m.bold } : { ch: '?', fg: C.red, bold: false };
    }
    case 'npc': return { ch: 'N', fg: C.yellow, bold: true };
    case 'loot': {
      const l = LOOT_GLYPHS[e.t] ?? LOOT_GLYPHS.bag!;
      return { ch: l.glyph, fg: l.fg, bold: true };
    }
  }
}

/** Shimmering water colour; `t` in seconds. */
export function waterColor(base: Rgb, x: number, y: number, t: number): Rgb {
  const k = 0.5 + 0.5 * Math.sin(t * 1.8 + x * 0.9 + y * 0.6);
  return mix(scale(base, 0.55), mix(base, 0x7fb0ff, 0.45), k);
}

/** Remembered (not currently visible) tiles are drawn dim. */
export function fogColor(c: Rgb): Rgb { return scale(c, 0.38); }

export function tileGlyph(id: number): { ch: string; fg: Rgb; animated: boolean } {
  const d = tileDef(id);
  return { ch: d.glyph, fg: d.fg, animated: !!d.animated };
}

export const rarityColor = (it: Item | null): Rgb => (it ? RARITY_COLORS[it.rarity] : C.dim);

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : n <= 1 ? s.slice(0, n) : `${s.slice(0, n - 1)}…`;
}

export function statLine(it: Item): string {
  const parts: string[] = [];
  const s = it.stats;
  if (s.atk) parts.push(`ATK+${s.atk}`);
  if (s.mag) parts.push(`MAG+${s.mag}`);
  if (s.def) parts.push(`DEF+${s.def}`);
  if (s.crit) parts.push(`CRT+${s.crit}%`);
  if (s.maxHp) parts.push(`HP+${s.maxHp}`);
  if (s.maxMp) parts.push(`MP+${s.maxMp}`);
  if (it.effect?.hp) parts.push(`heals ${it.effect.hp} HP`);
  if (it.effect?.mp) parts.push(`restores ${it.effect.mp} MP`);
  if (it.effect?.buff) parts.push(`${it.effect.buff.id} ${Math.round(it.effect.buff.ticks / 10)}s`);
  return parts.join('  ');
}
