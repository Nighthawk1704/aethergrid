// Turns a map tile into a SUB x SUB block of varied, tonal ASCII glyphs.
import { T } from '../../shared/tiles';
import { hash2, vnoise } from './noise';

/** Glyph cells per tile edge. A tile is SUB x SUB cells so terrain gets SUB^2 times the texture. */
export const SUB = 3;

export interface Cell { ch: string; fg: number }

const GREENS = [0x123a1b, 0x1c5628, 0x287435, 0x389443, 0x4fb458, 0x72cf68, 0x9ae484, 0xc2f5a8];
const GRASS_GLYPHS = ['"', ',', "'", '`', '\\', '/', ';', '"', ',', '.', 'v', 'w', '"', "'", ','];
const CANOPY_TOP = ['/', '\\', '^', '"', '*', '&', '/', '\\', "'", '%'];
const CANOPY_LOW = ['#', '%', '8', '@', '&', '#', '0', 'O', '%', '#'];
const GRAY = [0x30303a, 0x44444f, 0x5a5a68, 0x74748a, 0x9090aa, 0xb4b4cc, 0xd8d8ec];
const DUST = [0x625b48, 0x777058, 0x8e866a, 0xa89e7e];
const WOOD = [0x54391f, 0x6c4a2a, 0x865e36, 0x9c7040];
const SAND = [0x8a7c52, 0xa8996a, 0xc4b484];
const WATER_DEEP = [0x0a2b44, 0x0e3a58, 0x134a6c];
const WATER_SHALLOW = [0x1f6a86, 0x2a84a0, 0x3a9cb8];

const pick = <A,>(arr: readonly A[], h: number): A => arr[Math.min(arr.length - 1, Math.floor(h * arr.length))]!;

/** Does this tile get drawn dynamically so foliage can sway in the wind? */
export function isSwayTile(tile: number, tx: number, ty: number): boolean {
  return (tile === T.GRASS || tile === T.TREE) && hash2(tx, ty, 91) < 0.075;
}

export function isWater(tile: number): boolean { return tile === T.WATER || tile === T.SHALLOW; }

/**
 * The glyph and colour for one cell of a tile. (wcx, wcy) are world cell coordinates, which make the
 * texture continuous across tile borders; (sx, sy) is the cell's position inside its tile.
 */
export function terrainCell(tile: number, wcx: number, wcy: number, sx: number, sy: number): Cell {
  const h = hash2(wcx, wcy);
  const h2 = hash2(wcx, wcy, 7);
  switch (tile) {
    case T.GRASS: {
      const patch = vnoise(wcx * 0.075, wcy * 0.05, 3);
      const fine = vnoise(wcx * 0.4, wcy * 0.3, 5);
      let tone = Math.floor(1.2 + patch * 3.4 + fine * 1.4 + h2 * 0.8);
      tone = Math.max(1, Math.min(6, tone));
      if (h > 0.965) return { ch: '*', fg: h2 > 0.5 ? 0xe8d860 : 0xe07ab0 }; // wildflowers
      if (h > 0.93) return { ch: ',', fg: 0xb8a050 }; // dry weeds
      return { ch: pick(GRASS_GLYPHS, h2), fg: GREENS[tone]! };
    }
    case T.TREE: {
      const top = sy === 0;
      const n = vnoise(wcx * 0.3, wcy * 0.3, 11);
      if (!top && sx === Math.floor(hash2(Math.floor(wcx / SUB), Math.floor(wcy / SUB), 3) * SUB) && h > 0.78) return { ch: 'I', fg: 0x6a4a28 }; // trunk
      const tone = top ? 3 + Math.floor(n * 3 + h2 * 1.5) : 1 + Math.floor(n * 2.4 + h2 * 1.3);
      return { ch: pick(top ? CANOPY_TOP : CANOPY_LOW, h), fg: GREENS[Math.max(1, Math.min(7, tone))]! };
    }
    case T.FLOOR: {
      const t = Math.floor(h2 * 2.4);
      if (h > 0.97) return { ch: '.', fg: GRAY[4]! };
      return { ch: pick(['.', ':', ',', '`', "'", '.', '.', ';'], h), fg: GRAY[t]! };
    }
    case T.ROAD: {
      const t = Math.floor(h2 * DUST.length);
      const ch = sy === 0 ? pick(['=', '-', '=', ':'], h) : pick([':', '=', '.', '-'], h);
      return { ch, fg: DUST[t]! };
    }
    case T.WOOD_FLOOR:
      return { ch: sy === 0 ? '=' : '-', fg: WOOD[Math.floor(h2 * WOOD.length)]! };
    case T.BRIDGE:
      return { ch: sy === 0 ? '=' : '#', fg: WOOD[1 + Math.floor(h2 * 3)]! };
    case T.WALL: case T.RUIN_WALL: {
      const ruin = tile === T.RUIN_WALL;
      const stagger = (Math.floor(wcx / SUB) + Math.floor(wcy / SUB)) & 1;
      if (ruin && h > 0.9) return { ch: pick([':', ';', '.'], h2), fg: 0x4a4538 };
      let ch: string;
      if (sy === 0) ch = (sx + stagger) % 2 === 0 ? '[' : ']';
      else ch = h < 0.18 ? '%' : (sx + stagger) % 2 === 0 ? '=' : '#';
      const base = sy === 0 ? 4 : 2;
      const tone = Math.min(6, base + Math.floor(h2 * 2.2));
      const col = GRAY[tone]!;
      return { ch, fg: ruin ? ((col >> 1) & 0x7f7f7f) + 0x2c2820 : col };
    }
    case T.WATER: return { ch: '~', fg: WATER_DEEP[Math.floor(h2 * 3)]! };
    case T.SHALLOW: return { ch: pick(['-', '~', '.', '-'], h), fg: WATER_SHALLOW[Math.floor(h2 * 3)]! };
    case T.SAND: return { ch: pick([',', '.', ':', "'", '.'], h), fg: SAND[Math.floor(h2 * 3)]! };
    case T.STUMP: return { ch: (sx + sy) % 2 === 0 ? 'o' : ',', fg: 0x6a4a28 };
    case T.RUBBLE: return { ch: pick([':', ';', '.', '`'], h), fg: GRAY[1 + Math.floor(h2 * 3)]! };
    case T.ORE: {
      if (h > 0.4) return { ch: pick(['*', '%', '#', '*'], h2), fg: h2 > 0.5 ? 0xd8c0a0 : 0xb4bcd0 };
      return { ch: ':', fg: GRAY[2]! };
    }
    case T.DOOR_CLOSED: return { ch: sy === 0 ? '[' : '|', fg: sx === 0 ? 0x9b6a35 : 0x7a5026 };
    case T.DOOR_OPEN: return { ch: sy === 0 ? "'" : ' ', fg: 0x7a5026 };
    case T.STAIRS_DOWN: return { ch: sy === 0 ? '>' : '=', fg: 0xffe14a };
    case T.STAIRS_UP: return { ch: sy === 0 ? '<' : '=', fg: 0xffe14a };
    case T.GATE: return { ch: sy === 0 ? (sx === 0 ? '/' : sx === SUB - 1 ? '\\' : '^') : '|', fg: 0xd0d0e0 };
    case T.BANK: return { ch: sy === 0 ? '$' : '&', fg: 0xffc700 };
    case T.BOARD: return { ch: sy === 0 ? '[' : '?', fg: 0xffe14a };
    default: return { ch: ' ', fg: 0 };
  }
}

/** Mirror image of a glyph, for water reflections. */
const FLIP: Record<string, string> = {
  '/': '\\', '\\': '/', '^': 'v', v: '^', '"': ',', ',': '"', "'": '`', '`': "'", '.': "'", b: 'p', p: 'b', d: 'q', q: 'd',
  u: 'n', n: 'u', w: 'm', m: 'w', W: 'M', M: 'W', A: 'V', V: 'A', '6': '9', '9': '6', '<': '<', '>': '>',
};
export const flipGlyph = (ch: string): string => FLIP[ch] ?? ch;
