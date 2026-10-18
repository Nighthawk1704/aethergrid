// Procedural item generation: [Quality] [Element] [Material] [Type] [of the Beast]
import { randomBytes } from 'node:crypto';
import { Rng } from '../shared/rng';
import type { ConsumableEffect, EquipSlot, Item, Rarity, ShopEntry, Stats } from '../shared/types';

export const newUid = (): string => randomBytes(8).toString('hex');

type Bonus = Partial<Stats>;
type MaterialKind = 'metal' | 'cloth' | 'leather' | 'wood' | 'jewel';

interface BaseType { key: string; slot: EquipSlot; names: string[]; kind: MaterialKind; stats: Bonus }

const BASES: BaseType[] = [
  { key: 'dagger', slot: 'weapon', names: ['Dagger', 'Stiletto', 'Kris'], kind: 'metal', stats: { atk: 4, crit: 3 } },
  { key: 'sword', slot: 'weapon', names: ['Sword', 'Blade', 'Brand'], kind: 'metal', stats: { atk: 6 } },
  { key: 'axe', slot: 'weapon', names: ['Axe', 'Hatchet', 'Cleaver'], kind: 'metal', stats: { atk: 8, crit: 1 } },
  { key: 'mace', slot: 'weapon', names: ['Mace', 'Hammer', 'Flail'], kind: 'metal', stats: { atk: 5, def: 1, maxHp: 6 } },
  { key: 'staff', slot: 'weapon', names: ['Staff', 'Rod', 'Scepter'], kind: 'wood', stats: { mag: 7, maxMp: 12 } },
  { key: 'robe', slot: 'armor', names: ['Robe', 'Vestments'], kind: 'cloth', stats: { def: 2, mag: 2, maxMp: 10 } },
  { key: 'leather', slot: 'armor', names: ['Leather Armor', 'Jerkin', 'Brigandine'], kind: 'leather', stats: { def: 4, crit: 1 } },
  { key: 'chain', slot: 'armor', names: ['Chain Mail', 'Hauberk'], kind: 'metal', stats: { def: 7, maxHp: 8 } },
  { key: 'plate', slot: 'armor', names: ['Plate Armor', 'Cuirass'], kind: 'metal', stats: { def: 11, maxHp: 14 } },
  { key: 'ring', slot: 'ring', names: ['Ring', 'Band', 'Signet'], kind: 'jewel', stats: {} },
  { key: 'amulet', slot: 'amulet', names: ['Amulet', 'Pendant', 'Charm', 'Talisman'], kind: 'jewel', stats: {} },
];

const MATERIALS: Record<MaterialKind, string[]> = {
  metal: ['Rusty Iron', 'Iron', 'Steel', 'Mithril', 'Adamant'],
  cloth: ['Frayed', 'Linen', 'Silk', 'Spidersilk', 'Starweave'],
  leather: ['Worn', 'Hide', 'Cured', 'Drake', 'Wyrmhide'],
  wood: ['Gnarled', 'Oak', 'Yew', 'Moonwood', 'Elderwood'],
  jewel: ['Copper', 'Silver', 'Gold', 'Sapphire', 'Diamond'],
};
const TIER_MULT = [0.7, 1, 1.4, 1.9, 2.6];

const QUALITY: { name: string; stats: Bonus }[] = [
  { name: 'Sharp', stats: { atk: 2 } },
  { name: 'Sturdy', stats: { def: 2 } },
  { name: 'Keen', stats: { crit: 2 } },
  { name: 'Vital', stats: { maxHp: 12 } },
  { name: 'Arcane', stats: { mag: 2 } },
  { name: 'Mystic', stats: { maxMp: 12 } },
];
const ELEMENT: { name: string; stats: Bonus }[] = [
  { name: 'Fiery', stats: { atk: 2, mag: 2 } },
  { name: 'Frozen', stats: { def: 1, mag: 3 } },
  { name: 'Shocking', stats: { crit: 3, atk: 1 } },
  { name: 'Venomous', stats: { atk: 3 } },
  { name: 'Holy', stats: { maxHp: 10, def: 1 } },
  { name: 'Shadow', stats: { crit: 2, atk: 2 } },
];
const SUFFIX: { name: string; stats: Bonus }[] = [
  { name: 'of the Bear', stats: { maxHp: 18 } },
  { name: 'of the Fox', stats: { crit: 3 } },
  { name: 'of the Owl', stats: { maxMp: 15, mag: 2 } },
  { name: 'of the Wolf', stats: { atk: 3 } },
  { name: 'of the Turtle', stats: { def: 3 } },
  { name: 'of the Eagle', stats: { crit: 2, mag: 2 } },
  { name: 'of the Whale', stats: { maxHp: 10, maxMp: 10 } },
  { name: 'of the Tiger', stats: { atk: 2, crit: 2 } },
];
const JEWEL_POOL: Bonus[] = [{ atk: 2 }, { mag: 2 }, { def: 2 }, { crit: 2 }, { maxHp: 14 }, { maxMp: 14 }];

const WEIGHT: Record<keyof Stats, number> = { atk: 4, mag: 4, def: 4, crit: 5, maxHp: 0.8, maxMp: 0.8 };
const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

function addScaled(into: Bonus, add: Bonus, k: number): void {
  for (const key of Object.keys(add) as (keyof Stats)[]) {
    into[key] = (into[key] ?? 0) + Math.max(1, Math.round(add[key]! * k));
  }
}

export function rollRarity(rng: Rng, bonus = 0, min: Rarity = 'common'): Rarity {
  const r = rng.next() - bonus * 0.01;
  const rolled: Rarity = r < 0.01 ? 'legendary' : r < 0.05 ? 'epic' : r < 0.15 ? 'rare' : r < 0.4 ? 'uncommon' : 'common';
  return RARITY_ORDER.indexOf(rolled) >= RARITY_ORDER.indexOf(min) ? rolled : min;
}

export function statValue(stats: Bonus): number {
  let v = 0;
  for (const k of Object.keys(stats) as (keyof Stats)[]) v += (stats[k] ?? 0) * WEIGHT[k];
  return v;
}

export interface EquipOptions { slot?: EquipSlot; rarity?: Rarity; minRarity?: Rarity; base?: string }

export function generateEquipment(rng: Rng, ilvl: number, opts: EquipOptions = {}): Item {
  const pool = opts.base ? BASES.filter((b) => b.key === opts.base) : opts.slot ? BASES.filter((b) => b.slot === opts.slot) : BASES;
  const base = rng.pick(pool);
  const rarity = opts.rarity ?? rollRarity(rng, 0, opts.minRarity);
  let tier = Math.min(4, Math.floor((Math.max(1, ilvl) - 1) / 4));
  if (rng.chance(0.2)) tier = Math.max(0, tier - 1);
  else if (rng.chance(0.12)) tier = Math.min(4, tier + 1);
  const k = TIER_MULT[tier]! * (1 + ilvl * 0.08);
  const affK = 1 + ilvl * 0.1;

  const stats: Bonus = {};
  if (base.slot === 'ring' || base.slot === 'amulet') {
    addScaled(stats, rng.pick(JEWEL_POOL), k);
  } else {
    addScaled(stats, base.stats, k);
  }

  const material = MATERIALS[base.kind][tier]!;
  const typeName = rng.pick(base.names);
  const idx = RARITY_ORDER.indexOf(rarity);
  let quality: string | null = null, element: string | null = null, suffix: string | null = null;
  if (idx === 1) {
    if (rng.chance(0.5)) quality = pickAffix(rng, QUALITY, stats, affK);
    else suffix = pickAffix(rng, SUFFIX, stats, affK);
  } else if (idx === 2) {
    if (rng.chance(0.5)) quality = pickAffix(rng, QUALITY, stats, affK);
    else element = pickAffix(rng, ELEMENT, stats, affK);
    suffix = pickAffix(rng, SUFFIX, stats, affK);
  } else if (idx >= 3) {
    quality = pickAffix(rng, QUALITY, stats, affK);
    element = pickAffix(rng, ELEMENT, stats, affK);
    suffix = pickAffix(rng, SUFFIX, stats, affK);
    if (idx === 4) addScaled(stats, rng.pick(JEWEL_POOL), affK * 1.5);
  }

  const name = [quality, element, material, typeName, suffix].filter(Boolean).join(' ');
  return {
    uid: newUid(), base: base.key, name, slot: base.slot, rarity, qty: 1, stats, ilvl,
    value: Math.max(2, Math.round(statValue(stats) * 2.2)),
  };
}

function pickAffix(rng: Rng, list: { name: string; stats: Bonus }[], into: Bonus, k: number): string {
  const a = rng.pick(list);
  addScaled(into, a.stats, k);
  return a.name;
}

// ---- Consumables & materials ----------------------------------------------------------------
const POTION_TIERS: Record<'health_potion' | 'mana_potion', { name: string; amount: number; ilvl: number }[]> = {
  health_potion: [
    { name: 'Minor Health Potion', amount: 40, ilvl: 1 },
    { name: 'Health Potion', amount: 100, ilvl: 5 },
    { name: 'Greater Health Potion', amount: 220, ilvl: 10 },
    { name: 'Superior Health Potion', amount: 450, ilvl: 16 },
  ],
  mana_potion: [
    { name: 'Minor Mana Potion', amount: 30, ilvl: 1 },
    { name: 'Mana Potion', amount: 80, ilvl: 5 },
    { name: 'Greater Mana Potion', amount: 170, ilvl: 10 },
    { name: 'Superior Mana Potion', amount: 340, ilvl: 16 },
  ],
};

export function makePotion(kind: 'health_potion' | 'mana_potion', tier: number, qty = 1): Item {
  const t = POTION_TIERS[kind][Math.max(0, Math.min(3, tier))]!;
  const effect: ConsumableEffect = kind === 'health_potion' ? { hp: t.amount } : { mp: t.amount };
  return {
    uid: newUid(), base: kind, name: t.name, slot: 'consumable', rarity: tier >= 2 ? 'uncommon' : 'common', qty,
    stats: {}, effect, value: Math.round(t.amount * (kind === 'health_potion' ? 0.18 : 0.2)), ilvl: t.ilvl,
  };
}

export function makeElixir(kind: 'elixir_might' | 'elixir_regen', qty = 1): Item {
  if (kind === 'elixir_might') {
    return {
      uid: newUid(), base: kind, name: 'Elixir of Might', slot: 'consumable', rarity: 'uncommon', qty, stats: {},
      effect: { buff: { id: 'might', ticks: 600, power: 0.25 } }, value: 55, ilvl: 4,
    };
  }
  return {
    uid: newUid(), base: kind, name: 'Elixir of Renewal', slot: 'consumable', rarity: 'uncommon', qty, stats: {},
    effect: { buff: { id: 'regen', ticks: 200, power: 0.02 } }, value: 45, ilvl: 4,
  };
}

export function makeMaterial(base: 'wood' | 'iron_ore', qty = 1): Item {
  return base === 'wood'
    ? { uid: newUid(), base, name: 'Oak Log', slot: 'material', rarity: 'common', qty, stats: {}, value: 2, ilvl: 1 }
    : { uid: newUid(), base, name: 'Iron Ore', slot: 'material', rarity: 'common', qty, stats: {}, value: 6, ilvl: 1 };
}

export const MAX_STACK = 50;
export const isStackable = (it: Item): boolean => it.slot === 'consumable' || it.slot === 'material';
export const canStack = (a: Item, b: Item): boolean => isStackable(a) && a.base === b.base && a.name === b.name;

/** Gold price when selling to a vendor. */
export const sellPrice = (it: Item): number => Math.max(1, Math.floor(it.value * 0.4));
/** Gold price when buying from a vendor. */
export const buyPrice = (it: Item): number => Math.max(1, Math.round(it.value * 1.3));

/** Random loot for a monster of the given level. Boss drops are always at least epic gear. */
export function rollMonsterDrop(rng: Rng, mlvl: number, boss: boolean): Item | null {
  if (boss) return generateEquipment(rng, mlvl, { minRarity: 'epic' });
  const r = rng.next();
  const tier = mlvl >= 14 ? 3 : mlvl >= 9 ? 2 : mlvl >= 4 ? 1 : 0;
  if (r < 0.18) return makePotion('health_potion', tier);
  if (r < 0.26) return makePotion('mana_potion', tier);
  if (r < 0.40) return generateEquipment(rng, Math.max(1, mlvl));
  if (r < 0.42) return makeElixir(rng.chance(0.5) ? 'elixir_might' : 'elixir_regen');
  return null;
}

// ---- Vendor stock -----------------------------------------------------------------------------
export function blacksmithStock(seed: number): ShopEntry[] {
  const rng = new Rng(seed ^ 0xb1ac5);
  const out: ShopEntry[] = [];
  for (const [slot, ilvl, rarity] of [
    ['weapon', 1, 'common'], ['weapon', 2, 'common'], ['weapon', 5, 'uncommon'], ['weapon', 9, 'uncommon'],
    ['armor', 1, 'common'], ['armor', 3, 'common'], ['armor', 6, 'uncommon'], ['armor', 10, 'uncommon'],
    ['ring', 4, 'uncommon'], ['amulet', 4, 'uncommon'],
  ] as const) {
    const item = generateEquipment(rng, ilvl, { slot, rarity });
    out.push({ item, price: buyPrice(item) });
  }
  return out;
}

export function alchemistStock(): ShopEntry[] {
  const items = [
    makePotion('health_potion', 0), makePotion('health_potion', 1), makePotion('health_potion', 2), makePotion('health_potion', 3),
    makePotion('mana_potion', 0), makePotion('mana_potion', 1), makePotion('mana_potion', 2), makePotion('mana_potion', 3),
    makeElixir('elixir_might'), makeElixir('elixir_regen'),
  ];
  return items.map((item) => ({ item, price: buyPrice(item) }));
}
