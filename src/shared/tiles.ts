import { C, type Rgb } from './colors';

/** Numeric tile ids; the id is also the wire encoding (see tileCode). */
export const T = {
  VOID: 0,
  FLOOR: 1,
  WALL: 2,
  GRASS: 3,
  WATER: 4,
  DOOR_CLOSED: 5,
  DOOR_OPEN: 6,
  STAIRS_DOWN: 7,
  STAIRS_UP: 8,
  TREE: 9,
  ORE: 10,
  STUMP: 11,
  RUBBLE: 12,
  GATE: 13,
  BANK: 14,
  BOARD: 15,
  ROAD: 16,
  WOOD_FLOOR: 17,
  BRIDGE: 18,
  SHALLOW: 19,
  RUIN_WALL: 20,
  SAND: 21,
} as const;
export type TileId = (typeof T)[keyof typeof T];

export interface TileDef {
  name: string;
  glyph: string;
  fg: Rgb;
  bg?: Rgb;
  /** Can entities step here. */
  walk: boolean;
  /** Blocks line of sight. */
  opaque: boolean;
  /** Water shimmer handled by the renderer. */
  animated?: boolean;
}

const defs: Record<number, TileDef> = {
  [T.VOID]: { name: 'Void', glyph: ' ', fg: C.black, walk: false, opaque: true },
  [T.FLOOR]: { name: 'Floor', glyph: '.', fg: C.floor, walk: true, opaque: false },
  [T.WALL]: { name: 'Stone Wall', glyph: '#', fg: C.darkGray, walk: false, opaque: true },
  [T.GRASS]: { name: 'Tall Grass', glyph: '"', fg: C.grassGreen, walk: true, opaque: false },
  [T.WATER]: { name: 'Deep Water', glyph: '~', fg: C.blue, walk: false, opaque: false, animated: true },
  [T.DOOR_CLOSED]: { name: 'Closed Door', glyph: '+', fg: C.brown, walk: false, opaque: true },
  [T.DOOR_OPEN]: { name: 'Open Door', glyph: "'", fg: C.brown, walk: true, opaque: false },
  [T.STAIRS_DOWN]: { name: 'Stairs Down', glyph: '>', fg: C.yellow, walk: true, opaque: false },
  [T.STAIRS_UP]: { name: 'Stairs Up', glyph: '<', fg: C.yellow, walk: true, opaque: false },
  [T.TREE]: { name: 'Tree', glyph: 'T', fg: C.darkGreen, walk: false, opaque: false },
  [T.ORE]: { name: 'Iron Ore Vein', glyph: '*', fg: 0xb08060, walk: false, opaque: false },
  [T.STUMP]: { name: 'Tree Stump', glyph: ',', fg: C.darkBrown, walk: true, opaque: false },
  [T.RUBBLE]: { name: 'Rubble', glyph: ':', fg: C.dim, walk: true, opaque: false },
  [T.GATE]: { name: 'Gate', glyph: '^', fg: C.silver, walk: true, opaque: false },
  [T.BANK]: { name: 'Bank Chest', glyph: '&', fg: C.gold, walk: false, opaque: false },
  [T.BOARD]: { name: 'Quest Board', glyph: '?', fg: C.yellow, walk: false, opaque: false },
  [T.ROAD]: { name: 'Road', glyph: '.', fg: 0x8a7a5a, walk: true, opaque: false },
  [T.WOOD_FLOOR]: { name: 'Wooden Floor', glyph: '.', fg: 0x7a5a38, walk: true, opaque: false },
  [T.BRIDGE]: { name: 'Bridge', glyph: '=', fg: C.brown, walk: true, opaque: false },
  [T.SHALLOW]: { name: 'Shallow Water', glyph: '-', fg: 0x5a9ae0, walk: true, opaque: false, animated: true },
  [T.RUIN_WALL]: { name: 'Ruined Wall', glyph: '#', fg: 0x6e6450, walk: false, opaque: true },
  [T.SAND]: { name: 'Sand', glyph: '.', fg: 0xa89868, walk: true, opaque: false },
};
export const TILE_TABLE: readonly TileDef[] = Array.from({ length: 22 }, (_, i) => defs[i] ?? defs[T.VOID]!);

export const tileDef = (id: number): TileDef => TILE_TABLE[id] ?? TILE_TABLE[T.VOID]!;
export const isWalkable = (id: number): boolean => tileDef(id).walk;
export const isOpaque = (id: number): boolean => tileDef(id).opaque;

/** Wire encoding: one printable char per tile id. */
export const tileCode = (id: number): string => String.fromCharCode(48 + id);
export const tileFromCode = (ch: number): number => ch - 48;
