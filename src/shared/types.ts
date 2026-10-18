// Core domain types shared by server and clients.

export type ClassId = 'vanguard' | 'arcanist' | 'shadowblade';
export type ZoneId = 'oakhaven' | 'wilds' | 'catacombs1' | 'catacombs2' | 'catacombs3';
export type EntityKind = 'player' | 'monster' | 'npc' | 'loot';
export type MonsterId = 'goblin' | 'skeleton' | 'orc' | 'dragon';
export type NpcRole = 'inn' | 'smith' | 'alchemist' | 'quest';
export type SkillId = 'shield_bash' | 'whirlwind' | 'fireball' | 'frost_nova' | 'backstab' | 'smoke_bomb';
export type AIState = 'IDLE' | 'PATROL' | 'AGGRO' | 'FLEE' | 'RESPAWN';

export interface Vec2 { x: number; y: number }

// ---- Items ----------------------------------------------------------------------------------
export type EquipSlot = 'weapon' | 'armor' | 'ring' | 'amulet';
export const EQUIP_SLOTS: readonly EquipSlot[] = ['weapon', 'armor', 'ring', 'amulet'];
export type ItemSlot = EquipSlot | 'consumable' | 'material';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

/** Combat-relevant stats. Used for class bases, item bonuses and derived totals. */
export interface Stats {
  maxHp: number;
  maxMp: number;
  /** Physical power. */
  atk: number;
  /** Spell power. */
  mag: number;
  def: number;
  /** Crit chance in percent. */
  crit: number;
}
export type StatKey = keyof Stats;
export const STAT_KEYS: readonly StatKey[] = ['maxHp', 'maxMp', 'atk', 'mag', 'def', 'crit'];

export type BuffId = 'stun' | 'root' | 'slow' | 'stealth' | 'might' | 'regen' | 'burn' | 'enrage';

export interface ConsumableEffect {
  hp?: number;
  mp?: number;
  /** Optional temporary buff. */
  buff?: { id: BuffId; ticks: number; power: number };
}

export interface Item {
  /** Unique instance id. */
  uid: string;
  /** Base template key, e.g. "sword", "health_potion". */
  base: string;
  /** Fully generated display name, e.g. "Fiery Steel Blade of the Bear". */
  name: string;
  slot: ItemSlot;
  rarity: Rarity;
  qty: number;
  stats: Partial<Stats>;
  effect?: ConsumableEffect;
  /** Base vendor value in gold. */
  value: number;
  ilvl: number;
}

// ---- Entities -------------------------------------------------------------------------------
/** Bit flags carried on every wire entity. */
export const EF = {
  STUNNED: 1,
  ROOTED: 2,
  STEALTH: 4,
  FLEEING: 8,
  ENRAGED: 16,
  PARTY: 32,
  HOSTILE: 64,
  DEAD: 128,
  PVP: 256,
} as const;

export interface BuffView {
  id: BuffId;
  /** Remaining ticks. */
  ticks: number;
}

/** What a client may know about any visible entity. */
export interface WireEntity {
  id: number;
  k: EntityKind;
  x: number;
  y: number;
  /** Display name. */
  n: string;
  /** Template: class id (player), monster id, npc role/id, or loot kind. */
  t: string;
  hp: number;
  mhp: number;
  lv: number;
  /** EF bit flags. */
  fl: number;
}
export type EntityDelta = Partial<Omit<WireEntity, 'id'>> & { id: number };

// ---- Player-private state -------------------------------------------------------------------
export interface SelfState {
  id: number;
  name: string;
  cls: ClassId;
  lv: number;
  xp: number;
  xpNext: number;
  hp: number;
  mp: number;
  gold: number;
  x: number;
  y: number;
  zone: ZoneId;
  /** Derived totals (class + level + gear + buffs). */
  stats: Stats;
  buffs: BuffView[];
  /** Remaining cooldown ticks for hotbar slots 1-4 (index 0 = slot 1). */
  cd: [number, number, number, number];
  /** Entity id of locked target, or 0. */
  target: number;
  pvp: boolean;
  partyId: number;
}

export interface InventoryView {
  bag: (Item | null)[];
  equip: Record<EquipSlot, Item | null>;
  gold: number;
}

// ---- Quests / social views ------------------------------------------------------------------
export interface QuestView {
  id: string;
  name: string;
  desc: string;
  need: number;
  have: number;
  rewardXp: number;
  rewardGold: number;
  status: 'available' | 'active' | 'complete' | 'done';
}

export interface PartyMemberView {
  id: number;
  name: string;
  cls: ClassId;
  lv: number;
  hp: number;
  mhp: number;
  leader: boolean;
  zone: ZoneId;
}

export interface TradeSideView {
  name: string;
  gold: number;
  items: Item[];
  confirmed: boolean;
}
export interface TradeView {
  me: TradeSideView;
  them: TradeSideView;
}

export interface ShopEntry { item: Item; price: number }

export type ChatChannel = 'global' | 'local' | 'combat' | 'system' | 'whisper' | 'party';

export interface FxEvent {
  x: number;
  y: number;
  text: string;
  kind: 'hit' | 'crit' | 'heal' | 'miss' | 'xp' | 'burst' | 'info' | 'hurt';
}
