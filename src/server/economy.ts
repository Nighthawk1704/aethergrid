// Inventory, equipment, vendors, bank, quests and the inn.
import { NPCS, QUESTS, questById } from '../shared/gamedata';
import { T } from '../shared/tiles';
import type { ClientPacket } from '../shared/protocol';
import { EQUIP_SLOTS, type EquipSlot, type Item, type QuestView } from '../shared/types';
import { awardXp, heal } from './combat';
import { Npc, Player } from './entities';
import type { Game } from './game';
import { MAX_STACK, buyPrice, canStack, isStackable, newUid, sellPrice } from './items';

// ---- Bag primitives ---------------------------------------------------------------------------
/** Add to a container (stacking where possible). Returns false (and changes nothing) when full. */
export function addTo(list: (Item | null)[], item: Item): boolean {
  let left = item.qty;
  if (isStackable(item)) {
    const room = list.map((s, i) => ({ s, i })).filter(({ s }) => s && canStack(s, item) && s.qty < MAX_STACK);
    const free = list.filter((s) => s === null).length;
    const capacity = room.reduce((n, { s }) => n + (MAX_STACK - s!.qty), 0) + free * MAX_STACK;
    if (capacity < left) return false;
    for (const { s } of room) {
      const put = Math.min(left, MAX_STACK - s!.qty);
      s!.qty += put;
      left -= put;
      if (!left) return true;
    }
  }
  while (left > 0) {
    const i = list.indexOf(null);
    if (i < 0) return false;
    const put = isStackable(item) ? Math.min(left, MAX_STACK) : 1;
    list[i] = { ...item, uid: left === item.qty && put === item.qty ? item.uid : newUid(), qty: put };
    left -= put;
  }
  return true;
}

export function canFit(list: (Item | null)[], items: Item[]): boolean {
  const copy = list.map((s) => (s ? { ...s } : null));
  return items.every((it) => addTo(copy, it));
}

export function addItem(game: Game, p: Player, item: Item): boolean {
  if (!addTo(p.bag, item)) return false;
  game.markInv(p);
  if (item.slot === 'material') game.questProgress(p, `gather:${item.base}`, item.qty);
  return true;
}

/** Take `qty` from a bag slot. */
export function takeFromBag(game: Game, p: Player, slot: number, qty = 1): Item | null {
  const it = p.bag[slot];
  if (!it) return null;
  const n = Math.min(qty, it.qty);
  const out: Item = { ...it, qty: n, uid: n === it.qty ? it.uid : newUid() };
  if (n >= it.qty) p.bag[slot] = null;
  else it.qty -= n;
  game.markInv(p);
  return out;
}

// ---- Inventory packets ------------------------------------------------------------------------
export function handleInv(game: Game, p: Player, pkt: Extract<ClientPacket, { t: 'inv' }>): void {
  switch (pkt.op) {
    case 'use': return useItem(game, p, pkt.slot);
    case 'equip': return equipItem(game, p, pkt.slot);
    case 'unequip': return unequip(game, p, pkt.equip);
    case 'drop': return dropItem(game, p, pkt.slot);
  }
}

export function useItem(game: Game, p: Player, slot: number): void {
  const it = p.bag[slot];
  if (!it) return;
  if (EQUIP_SLOTS.includes(it.slot as EquipSlot)) return equipItem(game, p, slot);
  if (it.slot !== 'consumable' || !it.effect) { game.sys(p, `You cannot use ${it.name}.`); return; }
  const e = it.effect;
  if (e.hp && p.hp >= p.maxHp && !e.mp && !e.buff) { game.sys(p, 'You are already at full health.'); return; }
  if (e.mp && p.mp >= p.stats.maxMp && !e.hp && !e.buff) { game.sys(p, 'Your mana is already full.'); return; }
  if (e.hp) heal(game, p, e.hp);
  if (e.mp) p.mp = Math.min(p.stats.maxMp, p.mp + e.mp);
  if (e.buff) {
    p.addBuff(e.buff.id, e.buff.ticks, e.buff.power, p.id);
    if (e.buff.id === 'might') p.recalc();
  }
  takeFromBag(game, p, slot, 1);
  game.sys(p, `You use ${it.name}.`);
}

/** Quick-use hotkeys (3/4): drink the weakest potion that does not waste most of its effect. */
export function quickPotion(game: Game, p: Player, base: 'health_potion' | 'mana_potion'): boolean {
  const need = base === 'health_potion' ? p.maxHp - p.hp : p.stats.maxMp - p.mp;
  if (need <= 0) { game.sys(p, base === 'health_potion' ? 'You are already at full health.' : 'Your mana is already full.'); return false; }
  const options = p.bag
    .map((it, slot) => ({ it, slot }))
    .filter((o): o is { it: Item; slot: number } => !!o.it && o.it.base === base)
    .map((o) => ({ ...o, amount: (base === 'health_potion' ? o.it.effect?.hp : o.it.effect?.mp) ?? 0 }))
    .sort((a, b) => a.amount - b.amount);
  if (!options.length) { game.sys(p, `You have no ${base === 'health_potion' ? 'health' : 'mana'} potions.`); return false; }
  const pick = options.find((o) => o.amount >= need) ?? options[options.length - 1]!;
  useItem(game, p, pick.slot);
  return true;
}

export function equipItem(game: Game, p: Player, slot: number): void {
  const it = p.bag[slot];
  if (!it) return;
  if (!EQUIP_SLOTS.includes(it.slot as EquipSlot)) { game.sys(p, `${it.name} cannot be equipped.`); return; }
  const es = it.slot as EquipSlot;
  const old = p.equip[es];
  p.equip[es] = it;
  p.bag[slot] = old;
  p.recalc();
  game.markInv(p);
  game.sys(p, `You equip ${it.name}.`);
}

export function unequip(game: Game, p: Player, es: EquipSlot): void {
  const it = p.equip[es];
  if (!it) return;
  const i = p.bag.indexOf(null);
  if (i < 0) { game.sys(p, 'Your inventory is full.'); return; }
  p.bag[i] = it;
  p.equip[es] = null;
  p.recalc();
  game.markInv(p);
  game.sys(p, `You remove ${it.name}.`);
}

export function dropItem(game: Game, p: Player, slot: number): void {
  const it = p.bag[slot];
  if (!it) return;
  const z = p.zone;
  const spot = z.findNear(p.x, p.y, (x, y) => z.grid.walkable(x, y) && !z.lootOn(x, y), 3);
  if (!spot) { game.sys(p, 'There is no room to drop that here.'); return; }
  p.bag[slot] = null;
  game.markInv(p);
  game.spawnLoot(z, spot.x, spot.y, 0, it, p.id);
  game.sys(p, `You drop ${it.name}.`);
}

// ---- NPC lookup / windows ---------------------------------------------------------------------
function npcNear(p: Player, id: string, range = 3): Npc | null {
  for (const n of p.zone.npcs) if (n.npcId === id && p.dist(n) <= range) return n;
  return null;
}

export function closeWindows(game: Game, p: Player): void {
  if (p.openShop) { p.openShop = null; game.send(p.session, { t: 'shop', open: false, npc: '', stock: [], sellRate: 0 }); }
  if (p.bankOpen) { p.bankOpen = false; game.send(p.session, { t: 'bank', open: false, items: [] }); }
  if (p.questOpen) { p.questOpen = false; game.send(p.session, { t: 'quests', open: false, npc: '', quests: [] }); }
  if (p.dialogNpc) p.dialogNpc = null;
}

/** Called each second to close vendor windows once the player walks away. */
export function checkWindowRange(game: Game, p: Player): void {
  if (p.openShop && !npcNear(p, p.openShop, 4)) closeWindows(game, p);
  if (p.bankOpen && !nearBank(p, 3)) closeWindows(game, p);
  if (p.questOpen && !nearQuestGiver(p, 4)) closeWindows(game, p);
  if (p.dialogNpc && !npcNear(p, p.dialogNpc, 4)) p.dialogNpc = null;
}

export function talkTo(game: Game, p: Player, n: Npc): void {
  closeWindows(game, p);
  const def = NPCS[n.npcId];
  if (!def) return;
  switch (def.role) {
    case 'smith':
    case 'alchemist': return openShop(game, p, n);
    case 'quest': return openQuests(game, p, def.name);
    case 'inn': return openInn(game, p, n);
  }
}

// ---- Shops ------------------------------------------------------------------------------------
function openShop(game: Game, p: Player, n: Npc): void {
  const stock = n.npcId === 'brannoc' ? game.shops.smith : game.shops.alchemist;
  p.openShop = n.npcId;
  game.chat(p, 'system', n.name, NPCS[n.npcId]!.greeting);
  game.send(p.session, { t: 'shop', open: true, npc: n.name, stock, sellRate: 0.4 });
}

export function handleShop(game: Game, p: Player, pkt: Extract<ClientPacket, { t: 'shop' }>): void {
  if (pkt.op === 'close') return closeWindows(game, p);
  if (!p.openShop || !npcNear(p, p.openShop, 4)) return closeWindows(game, p);
  const stock = p.openShop === 'brannoc' ? game.shops.smith : game.shops.alchemist;
  if (pkt.op === 'buy') {
    const entry = stock[pkt.index];
    if (!entry) return;
    const price = buyPrice(entry.item);
    if (p.gold < price) { game.sys(p, 'You cannot afford that.'); return; }
    const item: Item = { ...entry.item, uid: newUid(), qty: 1 };
    if (!addItem(game, p, item)) { game.sys(p, 'Your inventory is full.'); return; }
    p.gold -= price;
    game.sys(p, `Bought ${item.name} for ${price} gold.`);
  } else {
    const it = p.bag[pkt.index];
    if (!it) return;
    const price = sellPrice(it) * it.qty;
    p.bag[pkt.index] = null;
    p.gold += price;
    game.markInv(p);
    game.sys(p, `Sold ${it.name}${it.qty > 1 ? ` x${it.qty}` : ''} for ${price} gold.`);
  }
}

// ---- Bank -------------------------------------------------------------------------------------
function nearBank(p: Player, r: number): boolean {
  const z = p.zone;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (z.grid.get(p.x + dx, p.y + dy) === T.BANK) return true;
  return false;
}

export function openBank(game: Game, p: Player): void {
  closeWindows(game, p);
  p.bankOpen = true;
  game.send(p.session, { t: 'bank', open: true, items: p.bank });
}

export function handleBank(game: Game, p: Player, pkt: Extract<ClientPacket, { t: 'bank' }>): void {
  if (pkt.op === 'close') return closeWindows(game, p);
  if (!p.bankOpen || !nearBank(p, 3)) return closeWindows(game, p);
  if (pkt.op === 'deposit') {
    const it = p.bag[pkt.index];
    if (!it) return;
    if (!addTo(p.bank, it)) { game.sys(p, 'Your bank chest is full.'); return; }
    p.bag[pkt.index] = null;
  } else {
    const it = p.bank[pkt.index];
    if (!it) return;
    if (!addTo(p.bag, it)) { game.sys(p, 'Your inventory is full.'); return; }
    p.bank[pkt.index] = null;
  }
  game.markInv(p);
  game.send(p.session, { t: 'bank', open: true, items: p.bank });
}

// ---- Quests -----------------------------------------------------------------------------------
function nearQuestGiver(p: Player, r: number): boolean {
  return !!npcNear(p, 'hale', r) || (() => {
    const z = p.zone;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (z.grid.get(p.x + dx, p.y + dy) === T.BOARD) return true;
    return false;
  })();
}

function questViews(p: Player): QuestView[] {
  return QUESTS.map((q) => {
    const st = p.quests[q.id];
    const status: QuestView['status'] = st ? (st.status === 'active' ? 'active' : st.status === 'complete' ? 'complete' : 'done') : 'available';
    return {
      id: q.id, name: q.name, desc: q.desc, need: q.need, have: st ? Math.min(q.need, st.progress) : 0,
      rewardXp: q.rewardXp, rewardGold: q.rewardGold, status,
    };
  });
}

export function openQuests(game: Game, p: Player, npcName = 'Quest Board'): void {
  closeWindows(game, p);
  p.questOpen = true;
  p.questNpc = npcName;
  game.send(p.session, { t: 'quests', open: true, npc: npcName, quests: questViews(p) });
}

export function handleQuest(game: Game, p: Player, pkt: Extract<ClientPacket, { t: 'quest' }>): void {
  if (pkt.op === 'close') return closeWindows(game, p);
  if (!p.questOpen || !nearQuestGiver(p, 4)) return closeWindows(game, p);
  const def = questById(pkt.id);
  if (!def) return;
  const st = p.quests[def.id];
  if (pkt.op === 'accept') {
    if (st) { game.sys(p, 'You have already taken that quest.'); return; }
    if (p.level < def.minLevel) { game.sys(p, `You must be level ${def.minLevel} for "${def.name}".`); return; }
    if (Object.values(p.quests).filter((q) => q.status !== 'done').length >= 5) { game.sys(p, 'You can only carry 5 active quests.'); return; }
    p.quests[def.id] = { progress: 0, status: 'active' };
    game.sys(p, `Quest accepted: ${def.name}.`);
  } else {
    if (!st || st.status !== 'complete') { game.sys(p, 'That quest is not complete yet.'); return; }
    st.status = 'done';
    p.gold += def.rewardGold;
    game.markInv(p);
    awardXp(game, p, def.rewardXp);
    game.sys(p, `Quest complete: ${def.name}! +${def.rewardXp} XP, +${def.rewardGold} gold.`);
  }
  game.send(p.session, { t: 'quests', open: true, npc: p.questNpc, quests: questViews(p) });
}

/** Advance matching active quests for a player. */
export function questProgress(game: Game, p: Player, goal: string, n: number): void {
  for (const q of QUESTS) {
    if (q.goal !== goal) continue;
    const st = p.quests[q.id];
    if (!st || st.status !== 'active') continue;
    st.progress = Math.min(q.need, st.progress + n);
    if (st.progress >= q.need) {
      st.status = 'complete';
      game.sys(p, `Quest ready to turn in: ${q.name}! Return to Captain Hale.`);
    } else {
      game.sys(p, `${q.name}: ${st.progress}/${q.need}`);
    }
    if (p.questOpen) game.send(p.session, { t: 'quests', open: true, npc: p.questNpc, quests: questViews(p) });
  }
}

// ---- Inn --------------------------------------------------------------------------------------
const restCost = (p: Player): number => 5 * p.level;

function openInn(game: Game, p: Player, n: Npc): void {
  p.dialogNpc = n.npcId;
  game.send(p.session, {
    t: 'dialog', npc: n.name,
    lines: [NPCS[n.npcId]!.greeting, '', `A room for the night is ${restCost(p)} gold.`, 'You will wake fully healed.'],
    options: [{ id: 'rest', label: `Rest (${restCost(p)}g)` }, { id: 'close', label: 'Leave' }],
  });
}

export function handleDialog(game: Game, p: Player, choice: string): void {
  if (!p.dialogNpc || !npcNear(p, p.dialogNpc, 4)) { p.dialogNpc = null; return; }
  if (choice === 'rest') {
    const cost = restCost(p);
    if (p.gold < cost) { game.sys(p, 'You cannot afford a room.'); }
    else {
      p.gold -= cost;
      p.hp = p.maxHp;
      p.mp = p.stats.maxMp;
      for (const b of ['stun', 'root', 'slow', 'burn'] as const) p.buffs.delete(b);
      game.markInv(p);
      game.sys(p, 'You rest at the inn and wake fully restored.');
      game.savePlayer(p);
    }
  }
  p.dialogNpc = null;
}
