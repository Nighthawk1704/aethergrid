// AetherGrid wire protocol: JSON text frames, `{ t: <type>, s: <seq>, ... }`.
//
//  * Every client packet carries a client sequence id `s` (monotonic). The server echoes the
//    highest processed one in `state.ack`, so a client can tell which inputs are applied.
//  * Every server packet carries a per-connection sequence id `s` so clients can detect gaps.
//  * Map state is delta-compressed (see StatePacket): tiles are only sent when first seen or
//    when they change, visibility is sent as row spans, entities as spawn/update/despawn.
import {
  CHAT_MAX_LEN, NAME_MAX, NAME_MIN, PASSWORD_MAX, PASSWORD_MIN, INVENTORY_SLOTS, BANK_SLOTS,
} from './constants';
import { CLASS_IDS } from './gamedata';
import {
  EQUIP_SLOTS,
  type ChatChannel, type ClassId, type EntityDelta, type EquipSlot, type FxEvent, type InventoryView,
  type PartyMemberView, type QuestView, type SelfState, type ShopEntry, type TradeView, type WireEntity,
  type ZoneId, type Item,
} from './types';

// ---- Client -> Server -----------------------------------------------------------------------
export type Dir1 = -1 | 0 | 1;
export type HotbarSlot = 1 | 2 | 3 | 4;

export type ClientPacket =
  | { t: 'register'; s: number; name: string; password: string; cls: ClassId }
  | { t: 'login'; s: number; name: string; password: string }
  | { t: 'move'; s: number; dx: Dir1; dy: Dir1 }
  | { t: 'interact'; s: number }
  | { t: 'stairs'; s: number; dir: 'up' | 'down' }
  | { t: 'skill'; s: number; slot: HotbarSlot }
  | { t: 'target'; s: number; mode: 'next' | 'clear' }
  | { t: 'chat'; s: number; text: string }
  | { t: 'inv'; s: number; op: 'use' | 'equip' | 'drop'; slot: number }
  | { t: 'inv'; s: number; op: 'unequip'; equip: EquipSlot }
  | { t: 'shop'; s: number; op: 'buy' | 'sell'; index: number }
  | { t: 'shop'; s: number; op: 'close' }
  | { t: 'bank'; s: number; op: 'deposit' | 'withdraw'; index: number }
  | { t: 'bank'; s: number; op: 'close' }
  | { t: 'trade'; s: number; op: 'offer'; slots: number[]; gold: number }
  | { t: 'trade'; s: number; op: 'confirm' | 'cancel' }
  | { t: 'dialog'; s: number; choice: string }
  | { t: 'quest'; s: number; op: 'accept' | 'turnin'; id: string }
  | { t: 'quest'; s: number; op: 'close' }
  | { t: 'ping'; s: number; ts: number };

export type ClientType = ClientPacket['t'];

// ---- Server -> Client -----------------------------------------------------------------------
/** [y, x, run] - `run` is a string of tile codes (see tileCode) for x, x+1, ... on row y. */
export type TileRun = [number, number, string];

export interface NpcDialogOption { id: string; label: string }

export type ServerPacket =
  | { t: 'hello'; s: number; version: number; tickMs: number; motd: string }
  | { t: 'auth'; s: number; ok: true; id: number; name: string }
  | { t: 'auth'; s: number; ok: false; error: string }
  | { t: 'zone'; s: number; zone: ZoneId; name: string; w: number; h: number; origin: { x: number; y: number }; pvp: boolean; fov: number; depth: number }
  | {
      t: 'state'; s: number; tick: number; ack: number;
      /** Changed fields of the player's own state (x/y/zone included on movement). */
      you?: Partial<SelfState>;
      spawn?: WireEntity[]; update?: EntityDelta[]; despawn?: number[];
      /** Newly known / mutated tiles. */
      tiles?: TileRun[];
      /** Complete current visibility as flat triples [y, x, len, ...]; replaces the previous set. */
      vis?: number[];
      fx?: FxEvent[];
    }
  | ({ t: 'inv'; s: number } & InventoryView)
  | { t: 'chat'; s: number; chan: ChatChannel; from: string; text: string; ts: number }
  | { t: 'shop'; s: number; open: boolean; npc: string; stock: ShopEntry[]; sellRate: number }
  | { t: 'bank'; s: number; open: boolean; items: (Item | null)[] }
  | { t: 'quests'; s: number; open: boolean; npc: string; quests: QuestView[] }
  | { t: 'trade'; s: number; open: boolean; trade?: TradeView }
  | { t: 'dialog'; s: number; npc: string; lines: string[]; options: NpcDialogOption[] }
  | { t: 'party'; s: number; members: PartyMemberView[] }
  | { t: 'pong'; s: number; ts: number; tick: number }
  | { t: 'error'; s: number; message: string }
  | { t: 'kick'; s: number; reason: string };

export type ServerType = ServerPacket['t'];

// ---- Encoding -------------------------------------------------------------------------------
export function encode(p: ClientPacket | ServerPacket): string {
  return JSON.stringify(p);
}

export function decodeServer(raw: string): ServerPacket | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string') return v as ServerPacket;
  } catch { /* fall through */ }
  return null;
}

// ---- Validation of untrusted client input ---------------------------------------------------
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Returns a normalized packet, or null when malformed. Never throws. */
export function parseClient(raw: string): ClientPacket | null {
  if (raw.length > 4096) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v) || typeof v.t !== 'string') return null;
  const s = isInt(v.s, 0, Number.MAX_SAFE_INTEGER) ? v.s : 0;

  switch (v.t) {
    case 'register':
      if (!isStr(v.name, NAME_MIN, NAME_MAX) || !NAME_RE.test(v.name)) return null;
      if (!isStr(v.password, PASSWORD_MIN, PASSWORD_MAX)) return null;
      if (typeof v.cls !== 'string' || !CLASS_IDS.includes(v.cls as ClassId)) return null;
      return { t: 'register', s, name: v.name, password: v.password, cls: v.cls as ClassId };
    case 'login':
      if (!isStr(v.name, NAME_MIN, NAME_MAX) || !isStr(v.password, 1, PASSWORD_MAX)) return null;
      return { t: 'login', s, name: v.name, password: v.password };
    case 'move':
      if (!isInt(v.dx, -1, 1) || !isInt(v.dy, -1, 1)) return null;
      return { t: 'move', s, dx: v.dx as -1 | 0 | 1, dy: v.dy as -1 | 0 | 1 };
    case 'interact':
      return { t: 'interact', s };
    case 'stairs':
      if (v.dir !== 'up' && v.dir !== 'down') return null;
      return { t: 'stairs', s, dir: v.dir };
    case 'skill':
      if (!isInt(v.slot, 1, 4)) return null;
      return { t: 'skill', s, slot: v.slot as HotbarSlot };
    case 'target':
      if (v.mode !== 'next' && v.mode !== 'clear') return null;
      return { t: 'target', s, mode: v.mode };
    case 'chat':
      if (!isStr(v.text, 1, CHAT_MAX_LEN)) return null;
      return { t: 'chat', s, text: v.text };
    case 'inv':
      if (v.op === 'use' || v.op === 'equip' || v.op === 'drop') {
        if (!isInt(v.slot, 0, INVENTORY_SLOTS - 1)) return null;
        return { t: 'inv', s, op: v.op, slot: v.slot };
      }
      if (v.op === 'unequip') {
        if (typeof v.equip !== 'string' || !EQUIP_SLOTS.includes(v.equip as EquipSlot)) return null;
        return { t: 'inv', s, op: 'unequip', equip: v.equip as EquipSlot };
      }
      return null;
    case 'shop':
      if (v.op === 'close') return { t: 'shop', s, op: 'close' };
      if ((v.op === 'buy' || v.op === 'sell') && isInt(v.index, 0, 200)) return { t: 'shop', s, op: v.op, index: v.index };
      return null;
    case 'bank':
      if (v.op === 'close') return { t: 'bank', s, op: 'close' };
      if ((v.op === 'deposit' || v.op === 'withdraw') && isInt(v.index, 0, Math.max(INVENTORY_SLOTS, BANK_SLOTS) - 1)) {
        return { t: 'bank', s, op: v.op, index: v.index };
      }
      return null;
    case 'trade':
      if (v.op === 'confirm' || v.op === 'cancel') return { t: 'trade', s, op: v.op };
      if (v.op === 'offer') {
        if (!Array.isArray(v.slots) || v.slots.length > INVENTORY_SLOTS) return null;
        if (!v.slots.every((n) => isInt(n, 0, INVENTORY_SLOTS - 1))) return null;
        if (!isInt(v.gold, 0, 1_000_000_000)) return null;
        return { t: 'trade', s, op: 'offer', slots: [...new Set(v.slots as number[])], gold: v.gold };
      }
      return null;
    case 'dialog':
      if (!isStr(v.choice, 1, 32)) return null;
      return { t: 'dialog', s, choice: v.choice };
    case 'quest':
      if (v.op === 'close') return { t: 'quest', s, op: 'close' };
      if ((v.op === 'accept' || v.op === 'turnin') && isStr(v.id, 1, 40)) return { t: 'quest', s, op: v.op, id: v.id };
      return null;
    case 'ping':
      return { t: 'ping', s, ts: typeof v.ts === 'number' ? v.ts : 0 };
    default:
      return null;
  }
}
