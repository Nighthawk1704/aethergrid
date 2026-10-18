import type { ZoneId } from './types';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 8765;

/** Server simulation rate: 10 ticks per second. */
export const TICK_RATE = 10;
export const TICK_MS = 1000 / TICK_RATE;

/** Convert seconds to server ticks. */
export const secs = (s: number): number => Math.round(s * TICK_RATE);

// ---- Screen layout (character grid shared by TUI and web clients) -------------------------
export const SCREEN_W = 100;
export const SCREEN_H = 34;

export interface Rect { x: number; y: number; w: number; h: number }

export const LAYOUT = {
  viewport: { x: 0, y: 0, w: 60, h: 22 },
  stats: { x: 60, y: 0, w: 40, h: 12 },
  minimap: { x: 60, y: 12, w: 40, h: 10 },
  chat: { x: 0, y: 22, w: 100, h: 12 },
} as const satisfies Record<string, Rect>;

// ---- Gameplay constants ---------------------------------------------------------------------
export const INVENTORY_SLOTS = 20;
export const BANK_SLOTS = 40;
export const MAX_LEVEL = 30;
export const PARTY_MAX = 4;
export const PARTY_SHARE_RANGE = 15;
export const LOCAL_CHAT_RANGE = 20;
export const CHAT_MAX_LEN = 200;
export const NAME_MIN = 3;
export const NAME_MAX = 16;
export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 64;
export const INTERACT_RANGE = 1.5;

export interface ZoneDef {
  id: ZoneId;
  name: string;
  w: number;
  h: number;
  /** Tile coordinate shown as (0,0) in the UI. */
  origin: { x: number; y: number };
  pvp: boolean;
  /** Sight radius in tiles. */
  fov: number;
  /** Dungeon depth, 0 for surface zones. */
  depth: number;
}

export const ZONES: Record<ZoneId, ZoneDef> = {
  oakhaven: { id: 'oakhaven', name: 'Oakhaven', w: 80, h: 80, origin: { x: 40, y: 40 }, pvp: false, fov: 14, depth: 0 },
  wilds: { id: 'wilds', name: 'The Whispering Wilds', w: 150, h: 150, origin: { x: 75, y: 75 }, pvp: true, fov: 12, depth: 0 },
  catacombs1: { id: 'catacombs1', name: 'Sunken Catacombs I', w: 80, h: 80, origin: { x: 0, y: 0 }, pvp: true, fov: 8, depth: 1 },
  catacombs2: { id: 'catacombs2', name: 'Sunken Catacombs II', w: 80, h: 80, origin: { x: 0, y: 0 }, pvp: true, fov: 8, depth: 2 },
  catacombs3: { id: 'catacombs3', name: 'Sunken Catacombs III', w: 80, h: 80, origin: { x: 0, y: 0 }, pvp: true, fov: 8, depth: 3 },
};

export const ZONE_IDS = Object.keys(ZONES) as ZoneId[];
export const START_ZONE: ZoneId = 'oakhaven';
export const DUNGEON_FLOORS: ZoneId[] = ['catacombs1', 'catacombs2', 'catacombs3'];
