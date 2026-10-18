// Static game data shared by server and clients (display + balance tables).
import { C, type Rgb } from './colors';
import { MAX_LEVEL, secs } from './constants';
import type { ClassId, MonsterId, NpcRole, SkillId, Stats, ZoneId } from './types';

// ---- Classes --------------------------------------------------------------------------------
export interface ClassDef {
  id: ClassId;
  name: string;
  blurb: string;
  base: Stats;
  /** Stat gain per level above 1. */
  growth: Stats;
  /** Ticks between steps (lower = faster). */
  moveTicks: number;
  /** Ticks between basic attacks. */
  attackTicks: number;
  skills: [SkillId, SkillId];
}

export const CLASSES: Record<ClassId, ClassDef> = {
  vanguard: {
    id: 'vanguard',
    name: 'Vanguard',
    blurb: 'Armored frontline warrior. High HP and defense.',
    base: { maxHp: 140, maxMp: 30, atk: 12, mag: 4, def: 8, crit: 5 },
    growth: { maxHp: 16, maxMp: 3, atk: 2.2, mag: 0.4, def: 1.6, crit: 0.1 },
    moveTicks: 3,
    attackTicks: 4,
    skills: ['shield_bash', 'whirlwind'],
  },
  arcanist: {
    id: 'arcanist',
    name: 'Arcanist',
    blurb: 'Glass-cannon mage. Deep mana pool and burst damage.',
    base: { maxHp: 80, maxMp: 110, atk: 6, mag: 14, def: 3, crit: 6 },
    growth: { maxHp: 8, maxMp: 11, atk: 1, mag: 2.6, def: 0.6, crit: 0.1 },
    moveTicks: 3,
    attackTicks: 5,
    skills: ['fireball', 'frost_nova'],
  },
  shadowblade: {
    id: 'shadowblade',
    name: 'Shadowblade',
    blurb: 'Fast assassin. High crit chance and mobility.',
    base: { maxHp: 100, maxMp: 60, atk: 11, mag: 5, def: 4, crit: 18 },
    growth: { maxHp: 10, maxMp: 5, atk: 2, mag: 0.5, def: 0.9, crit: 0.3 },
    moveTicks: 2,
    attackTicks: 3,
    skills: ['backstab', 'smoke_bomb'],
  },
};
export const CLASS_IDS = Object.keys(CLASSES) as ClassId[];

// ---- Skills ---------------------------------------------------------------------------------
export interface SkillDef {
  id: SkillId;
  name: string;
  cls: ClassId;
  desc: string;
  mp: number;
  cd: number;
  /** Max reach in tiles (0 = self-centred). */
  range: number;
  /** Damage multiplier of the governing stat. */
  power: number;
  /** Governing stat. */
  scale: 'atk' | 'mag';
  /** AoE radius around the impact point (0 = single target). */
  radius: number;
}

export const SKILLS: Record<SkillId, SkillDef> = {
  shield_bash: {
    id: 'shield_bash', name: 'Shield Bash', cls: 'vanguard', desc: 'Slam an adjacent foe, stunning it for 2s.',
    mp: 8, cd: secs(4), range: 1, power: 1.2, scale: 'atk', radius: 0,
  },
  whirlwind: {
    id: 'whirlwind', name: 'Whirlwind', cls: 'vanguard', desc: 'Spin and hit every adjacent enemy.',
    mp: 15, cd: secs(8), range: 0, power: 1.0, scale: 'atk', radius: 1,
  },
  fireball: {
    id: 'fireball', name: 'Fireball', cls: 'arcanist', desc: 'Hurl a fireball that explodes (radius 1), range 8.',
    mp: 12, cd: secs(3), range: 8, power: 1.6, scale: 'mag', radius: 1,
  },
  frost_nova: {
    id: 'frost_nova', name: 'Frost Nova', cls: 'arcanist', desc: 'Blast of frost: roots foes within 3 tiles for 3s, then slows.',
    mp: 14, cd: secs(9), range: 0, power: 0.6, scale: 'mag', radius: 3,
  },
  backstab: {
    id: 'backstab', name: 'Backstab', cls: 'shadowblade', desc: 'Strike an adjacent foe; double damage from behind.',
    mp: 6, cd: secs(3), range: 1, power: 1.3, scale: 'atk', radius: 0,
  },
  smoke_bomb: {
    id: 'smoke_bomb', name: 'Smoke Bomb', cls: 'shadowblade', desc: 'Vanish for 5s: foes lose you, +40% evasion.',
    mp: 10, cd: secs(15), range: 0, power: 0, scale: 'atk', radius: 0,
  },
};

/** Hotbar slots 3 and 4 are quick-use potions. */
export const QUICK_POTION_SLOTS = { 3: 'health_potion', 4: 'mana_potion' } as const;

// ---- Progression ----------------------------------------------------------------------------
/** XP required to advance from `lv` to `lv + 1`. */
export function xpForLevel(lv: number): number {
  return Math.floor(40 * Math.pow(lv, 1.75));
}

export function statsForLevel(cls: ClassId, lv: number): Stats {
  const def = CLASSES[cls];
  const n = Math.max(0, Math.min(MAX_LEVEL, lv) - 1);
  const out = { ...def.base };
  for (const k of Object.keys(out) as (keyof Stats)[]) out[k] = Math.round((def.base[k] + def.growth[k] * n) * 10) / 10;
  out.maxHp = Math.round(out.maxHp);
  out.maxMp = Math.round(out.maxMp);
  return out;
}

// ---- Monsters -------------------------------------------------------------------------------
export interface MonsterDef {
  id: MonsterId;
  name: string;
  glyph: string;
  fg: Rgb;
  bold?: boolean;
  hp: number;
  atk: number;
  def: number;
  xp: number;
  gold: [number, number];
  moveTicks: number;
  attackTicks: number;
  sight: number;
  /** Flees below 15% HP. */
  coward: boolean;
  /** Berserker rage below 50% HP. */
  berserk: boolean;
  /** Per-level scaling of hp/atk. */
  perLevel: number;
  respawn: number;
  boss?: boolean;
}

export const MONSTERS: Record<MonsterId, MonsterDef> = {
  goblin: {
    id: 'goblin', name: 'Goblin', glyph: 'g', fg: C.green, hp: 28, atk: 6, def: 1, xp: 12, gold: [2, 8],
    moveTicks: 3, attackTicks: 6, sight: 8, coward: true, berserk: false, perLevel: 0.18, respawn: secs(30),
  },
  skeleton: {
    id: 'skeleton', name: 'Skeleton', glyph: 's', fg: 0xeeeeee, hp: 45, atk: 9, def: 4, xp: 22, gold: [4, 14],
    moveTicks: 4, attackTicks: 7, sight: 7, coward: false, berserk: false, perLevel: 0.2, respawn: secs(40),
  },
  orc: {
    id: 'orc', name: 'Orc Berserker', glyph: 'o', fg: C.red, hp: 90, atk: 15, def: 6, xp: 55, gold: [10, 30],
    moveTicks: 3, attackTicks: 6, sight: 8, coward: false, berserk: true, perLevel: 0.22, respawn: secs(60),
  },
  dragon: {
    id: 'dragon', name: 'Ancient Dragon', glyph: 'D', fg: C.brightRed, bold: true, hp: 2200, atk: 45, def: 18, xp: 1500,
    gold: [400, 900], moveTicks: 4, attackTicks: 8, sight: 12, coward: false, berserk: false, perLevel: 0.1,
    respawn: secs(600), boss: true,
  },
};
export const MONSTER_IDS = Object.keys(MONSTERS) as MonsterId[];

/** Which monsters roam each zone, with spawn level range and weight. */
export const ZONE_SPAWNS: Record<ZoneId, { monster: MonsterId; weight: number; lv: [number, number] }[]> = {
  oakhaven: [],
  wilds: [
    { monster: 'goblin', weight: 6, lv: [1, 5] },
    { monster: 'orc', weight: 2, lv: [5, 9] },
    { monster: 'skeleton', weight: 2, lv: [3, 7] },
  ],
  catacombs1: [
    { monster: 'skeleton', weight: 5, lv: [4, 8] },
    { monster: 'goblin', weight: 3, lv: [4, 7] },
  ],
  catacombs2: [
    { monster: 'skeleton', weight: 4, lv: [8, 12] },
    { monster: 'orc', weight: 4, lv: [9, 13] },
  ],
  catacombs3: [
    { monster: 'orc', weight: 5, lv: [12, 16] },
    { monster: 'skeleton', weight: 3, lv: [12, 16] },
  ],
};

// ---- NPCs -----------------------------------------------------------------------------------
export interface NpcDef {
  id: string;
  role: NpcRole;
  name: string;
  greeting: string;
}
export const NPCS: Record<string, NpcDef> = {
  marta: { id: 'marta', role: 'inn', name: 'Marta the Innkeeper', greeting: 'Welcome, traveller! A warm bed heals all wounds.' },
  brannoc: { id: 'brannoc', role: 'smith', name: 'Brannoc the Smith', greeting: 'Steel never lies. Take a look at my wares.' },
  elowen: { id: 'elowen', role: 'alchemist', name: 'Elowen the Alchemist', greeting: 'Potions, tinctures and a few things I cannot explain.' },
  hale: { id: 'hale', role: 'quest', name: 'Captain Hale', greeting: 'Oakhaven needs capable hands. Choose a task.' },
};

// ---- Quests ---------------------------------------------------------------------------------
export interface QuestDef {
  id: string;
  name: string;
  desc: string;
  /** "kill:<monster>" or "gather:<material base>". */
  goal: string;
  need: number;
  rewardXp: number;
  rewardGold: number;
  minLevel: number;
}
export const QUESTS: QuestDef[] = [
  { id: 'goblin_menace', name: 'Goblin Menace', desc: 'Goblins raid caravans in the Wilds. Slay 6.', goal: 'kill:goblin', need: 6, rewardXp: 90, rewardGold: 60, minLevel: 1 },
  { id: 'timber', name: 'Timber!', desc: 'The town needs lumber. Chop 8 trees.', goal: 'gather:wood', need: 8, rewardXp: 70, rewardGold: 45, minLevel: 1 },
  { id: 'iron_will', name: 'Iron Will', desc: 'Brannoc needs ore. Mine 5 iron veins.', goal: 'gather:iron_ore', need: 5, rewardXp: 140, rewardGold: 90, minLevel: 2 },
  { id: 'bone_collector', name: 'Bone Collector', desc: 'The Catacombs stir. Destroy 8 skeletons.', goal: 'kill:skeleton', need: 8, rewardXp: 260, rewardGold: 150, minLevel: 4 },
  { id: 'orc_slayer', name: 'Orc Slayer', desc: 'Berserkers threaten the road. Slay 4 orcs.', goal: 'kill:orc', need: 4, rewardXp: 420, rewardGold: 240, minLevel: 6 },
  { id: 'dragonbane', name: 'Dragonbane', desc: 'Slay the Ancient Dragon on the lowest Catacomb floor.', goal: 'kill:dragon', need: 1, rewardXp: 3000, rewardGold: 1500, minLevel: 12 },
];
export const questById = (id: string): QuestDef | undefined => QUESTS.find((q) => q.id === id);

// ---- Loot display ---------------------------------------------------------------------------
export interface LootGlyph { glyph: string; fg: Rgb }
export const LOOT_GLYPHS: Record<string, LootGlyph> = {
  gold: { glyph: '$', fg: C.gold },
  bag: { glyph: '$', fg: C.gold },
  consumable: { glyph: '!', fg: C.magenta },
  weapon: { glyph: '/', fg: C.silver },
  armor: { glyph: '[', fg: C.steel },
  ring: { glyph: '=', fg: C.gold },
  amulet: { glyph: '%', fg: C.pink },
  material: { glyph: ';', fg: C.brown },
};

export const ITEM_GLYPHS: Record<string, string> = {
  weapon: '/', armor: '[', ring: '=', amulet: '%', consumable: '!', material: ';',
};
