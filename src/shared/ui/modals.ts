// Modal windows: inventory, character sheet, help, shop, bank, quests, dialog, trade.
import { C, RARITY_COLORS, type Rgb } from '../colors';
import { INVENTORY_SLOTS } from '../constants';
import { CLASSES, ITEM_GLYPHS, SKILLS, xpForLevel } from '../gamedata';
import type { ClientMsg } from '../client/net';
import type { ClientState } from '../client/state';
import { EQUIP_SLOTS, type EquipSlot, type Item } from '../types';
import type { KeyEvent } from './keys';
import { ATTR, KEEP, Screen } from './screen';
import { statLine, truncate } from './theme';

export type LocalModal = 'none' | 'inventory' | 'character' | 'help';

export interface UiState {
  modal: LocalModal;
  invPane: 'bag' | 'equip';
  invCursor: number;
  equipCursor: number;
  shopMode: 'buy' | 'sell';
  shopCursor: number;
  bankPane: 'bag' | 'bank';
  bankCursor: number;
  questCursor: number;
  dialogCursor: number;
  tradeCursor: number;
  tradeOffer: Set<number>;
  tradeGold: number;
}

export const newUiState = (): UiState => ({
  modal: 'none', invPane: 'bag', invCursor: 0, equipCursor: 0, shopMode: 'buy', shopCursor: 0, bankPane: 'bag', bankCursor: 0,
  questCursor: 0, dialogCursor: 0, tradeCursor: 0, tradeOffer: new Set(), tradeGold: 0,
});

export interface ModalHost {
  st: ClientState;
  ui: UiState;
  send(msg: ClientMsg): void;
}

export type ModalName = LocalModal | 'shop' | 'bank' | 'quests' | 'dialog' | 'trade';

/** Server-driven windows take precedence over locally opened ones. */
export function activeModal(st: ClientState, ui: UiState): ModalName {
  if (st.trade) return 'trade';
  if (st.shop) return 'shop';
  if (st.bank) return 'bank';
  if (st.quests) return 'quests';
  if (st.dialog) return 'dialog';
  return ui.modal;
}

// ---- Frame & list helpers -----------------------------------------------------------------------
const MX = 14, MY = 3, MW = 72, MH = 28;
const BG = 0x0a0a16;

function frame(s: Screen, title: string, footer: string): void {
  s.fill(MX, MY, MW, MH, BG);
  s.box(MX, MY, MW, MH, C.borderBright, title, C.yellow, BG);
  s.text(MX + 2, MY + MH - 1, ` ${footer} `, C.dim, BG);
}

interface Row { text: string; fg: Rgb; right?: string; rightFg?: Rgb; glyph?: string }

function list(s: Screen, x: number, y: number, w: number, h: number, rows: Row[], cursor: number, active: boolean): void {
  const top = Math.max(0, Math.min(cursor - Math.floor(h / 2), rows.length - h));
  for (let i = 0; i < h; i++) {
    const r = rows[top + i];
    if (!r) break;
    const sel = top + i === cursor;
    const bg = sel ? (active ? 0x28305a : 0x1a1a2a) : BG;
    s.fill(x, y + i, w, 1, bg);
    if (sel && active) s.set(x, y + i, '>', C.yellow, bg, ATTR.BOLD);
    if (r.glyph) s.set(x + 2, y + i, r.glyph, r.fg, bg, ATTR.BOLD);
    const right = r.right ?? '';
    s.text(x + 4, y + i, truncate(r.text, w - 5 - right.length), r.fg, bg);
    if (right) s.textRight(x + w - 1, y + i, right, r.rightFg ?? C.text, bg);
  }
  if (rows.length > h) {
    s.set(x + w - 1, y, top > 0 ? '▲' : ' ', C.dim, BG);
    s.set(x + w - 1, y + h - 1, top + h < rows.length ? '▼' : ' ', C.dim, BG);
  }
}

const itemRow = (it: Item | null, i: number): Row => it
  ? { text: it.name, fg: RARITY_COLORS[it.rarity], glyph: ITEM_GLYPHS[it.slot] ?? '?', right: it.qty > 1 ? `x${it.qty}` : '' }
  : { text: `(empty ${String(i + 1).padStart(2)})`, fg: C.dimmer };

function itemDetail(s: Screen, x: number, y: number, w: number, it: Item | null | undefined, extra = ''): void {
  s.fill(x, y, w, 5, BG);
  if (!it) { s.text(x, y, 'Nothing selected.', C.dimmer, BG); return; }
  s.text(x, y, truncate(it.name, w), RARITY_COLORS[it.rarity], BG, ATTR.BOLD);
  s.text(x, y + 1, `${it.rarity} ${it.slot}  (item level ${it.ilvl})`, C.dim, BG);
  s.text(x, y + 2, truncate(statLine(it) || 'No bonuses.', w), C.text, BG);
  s.text(x, y + 3, `Value: ${it.value}g${extra ? `   ${extra}` : ''}`, C.gold, BG);
}

const nav = (k: KeyEvent): -1 | 0 | 1 => (k.key === 'ArrowUp' || k.key === 'w' || k.key === 'W' || k.key === 'k' ? -1 : k.key === 'ArrowDown' || k.key === 's' || k.key === 'S' || k.key === 'j' ? 1 : 0);
const clamp = (v: number, n: number): number => Math.max(0, Math.min(Math.max(0, n - 1), v));

// ---- Inventory ----------------------------------------------------------------------------------
function drawInventory(s: Screen, st: ClientState, ui: UiState): void {
  frame(s, 'Inventory', '↑↓ move  Tab pane  Enter use/equip  D drop  U unequip  Esc close');
  const inv = st.inv;
  if (!inv) { s.text(MX + 3, MY + 3, 'Loading...', C.dim, BG); return; }
  const used = inv.bag.filter(Boolean).length;
  s.text(MX + 2, MY + 2, `Backpack  ${used}/${INVENTORY_SLOTS}`, ui.invPane === 'bag' ? C.yellow : C.dim, BG, ATTR.BOLD);
  list(s, MX + 2, MY + 3, 34, 20, inv.bag.map(itemRow), ui.invCursor, ui.invPane === 'bag');

  s.text(MX + 38, MY + 2, 'Equipment', ui.invPane === 'equip' ? C.yellow : C.dim, BG, ATTR.BOLD);
  const names: Record<EquipSlot, string> = { weapon: 'Weapon', armor: 'Armor', ring: 'Ring', amulet: 'Amulet' };
  const rows: Row[] = EQUIP_SLOTS.map((es) => {
    const it = inv.equip[es];
    return it ? { text: `${names[es].padEnd(7)} ${it.name}`, fg: RARITY_COLORS[it.rarity] } : { text: `${names[es].padEnd(7)} —`, fg: C.dimmer };
  });
  list(s, MX + 38, MY + 3, 32, 4, rows, ui.equipCursor, ui.invPane === 'equip');

  const sel = ui.invPane === 'bag' ? inv.bag[ui.invCursor] : inv.equip[EQUIP_SLOTS[ui.equipCursor]!];
  s.text(MX + 38, MY + 9, 'Details', C.dim, BG);
  itemDetail(s, MX + 38, MY + 10, 32, sel);
  s.text(MX + 38, MY + 17, `Gold: ${inv.gold}`, C.gold, BG, ATTR.BOLD);
  const me = st.me;
  if (me) {
    s.text(MX + 38, MY + 19, `ATK ${Math.round(me.stats.atk)}  MAG ${Math.round(me.stats.mag)}  DEF ${Math.round(me.stats.def)}`, C.text, BG);
    s.text(MX + 38, MY + 20, `HP ${me.hp}/${me.stats.maxHp}  MP ${me.mp}/${me.stats.maxMp}  CRT ${Math.round(me.stats.crit)}%`, C.text, BG);
  }
}

function keyInventory(h: ModalHost, k: KeyEvent): void {
  const { ui, st } = h;
  if (k.key === 'Escape' || k.key === 'i' || k.key === 'I') { ui.modal = 'none'; return; }
  if (k.key === 'Tab' || k.key === 'ArrowLeft' || k.key === 'ArrowRight') { ui.invPane = ui.invPane === 'bag' ? 'equip' : 'bag'; return; }
  const d = nav(k);
  if (ui.invPane === 'bag') {
    if (d) ui.invCursor = clamp(ui.invCursor + d, INVENTORY_SLOTS);
    else if (k.key === 'Enter' || k.key === 'e') { if (st.inv?.bag[ui.invCursor]) h.send({ t: 'inv', op: 'use', slot: ui.invCursor }); }
    else if (k.key === 'd' || k.key === 'D') { if (st.inv?.bag[ui.invCursor]) h.send({ t: 'inv', op: 'drop', slot: ui.invCursor }); }
  } else {
    if (d) ui.equipCursor = clamp(ui.equipCursor + d, EQUIP_SLOTS.length);
    else if (k.key === 'Enter' || k.key === 'u' || k.key === 'U') h.send({ t: 'inv', op: 'unequip', equip: EQUIP_SLOTS[ui.equipCursor]! });
  }
  if ((k.key === 'u' || k.key === 'U') && ui.invPane === 'bag') ui.invPane = 'equip';
}

// ---- Character sheet ----------------------------------------------------------------------------
function drawCharacter(s: Screen, st: ClientState): void {
  frame(s, 'Character Sheet', 'Esc / C close');
  const me = st.me;
  if (!me) return;
  const cls = CLASSES[me.cls];
  const x = MX + 3;
  s.text(x, MY + 2, me.name, C.brightWhite, BG, ATTR.BOLD);
  s.text(x + me.name.length + 2, MY + 2, `Level ${me.lv} ${cls.name}`, C.yellow, BG);
  s.text(x, MY + 3, cls.blurb, C.dim, BG);
  s.text(x, MY + 5, 'Experience', C.dim, BG);
  s.bar(x + 12, MY + 5, 30, me.xpNext ? me.xp / me.xpNext : 1, C.xpGold, 0x3a3010, BG);
  s.text(x + 44, MY + 5, `${me.xp}/${me.xpNext || xpForLevel(me.lv)}`, C.text, BG);

  const b = cls.base;
  const rows: [string, number, number][] = [
    ['Max HP', me.stats.maxHp, b.maxHp], ['Max MP', me.stats.maxMp, b.maxMp], ['Attack', me.stats.atk, b.atk],
    ['Magic', me.stats.mag, b.mag], ['Defense', me.stats.def, b.def], ['Crit %', me.stats.crit, b.crit],
  ];
  s.text(x, MY + 7, 'Attributes', C.yellow, BG, ATTR.BOLD);
  rows.forEach(([name, v, base], i) => {
    s.text(x + 2, MY + 8 + i, name.padEnd(9), C.text, BG);
    s.text(x + 11, MY + 8 + i, String(Math.round(v * 10) / 10).padStart(6), C.brightWhite, BG);
    const bonus = Math.round((v - base) * 10) / 10;
    s.text(x + 18, MY + 8 + i, `(base ${base}${bonus > 0 ? `, +${bonus}` : ''})`, C.dimmer, BG);
  });

  s.text(x + 36, MY + 7, 'Skills', C.yellow, BG, ATTR.BOLD);
  cls.skills.forEach((id, i) => {
    const sk = SKILLS[id];
    s.text(x + 36, MY + 8 + i * 3, `${i + 1}  ${sk.name}`, C.cyan, BG, ATTR.BOLD);
    s.text(x + 36, MY + 9 + i * 3, truncate(sk.desc, 30), C.dim, BG);
    s.text(x + 36, MY + 10 + i * 3, `${sk.mp} MP   ${(sk.cd / 10).toFixed(0)}s cooldown`, C.dimmer, BG);
  });
  s.text(x + 36, MY + 14, '3  Health Potion   4  Mana Potion', C.dim, BG);

  s.text(x, MY + 15, 'Equipment', C.yellow, BG, ATTR.BOLD);
  EQUIP_SLOTS.forEach((es, i) => {
    const it = st.inv?.equip[es];
    s.text(x + 2, MY + 16 + i, es.padEnd(7), C.dim, BG);
    s.text(x + 10, MY + 16 + i, truncate(it ? `${it.name}  ${statLine(it)}` : '—', 56), it ? RARITY_COLORS[it.rarity] : C.dimmer, BG);
  });
  s.text(x, MY + 21, 'Gold', C.dim, BG);
  s.text(x + 5, MY + 21, String(me.gold), C.gold, BG, ATTR.BOLD);
  s.text(x + 20, MY + 21, `Party: ${st.party.length ? st.party.map((m) => m.name).join(', ') : 'none'}`, C.text, BG);
  s.text(x + 2, MY + 23, `PvP: ${me.pvp ? 'ON' : 'off'} (/pvp on|off)`, me.pvp ? C.brightRed : C.dim, BG);
}

// ---- Help ---------------------------------------------------------------------------------------
const HELP_LINES: [string, string][] = [
  ['Move', 'W A S D or the arrow keys'],
  ['Diagonal', 'Q (NW)   Z (SW)   Shift+E (NE)   Shift+C (SE)'],
  ['Attack', 'Walk into an enemy (bump-to-attack)'],
  ['Skills', '1, 2 class skills    3 health potion    4 mana potion'],
  ['Target', 'Tab cycles targets, Esc clears. Spells aim at your target,'],
  ['', 'otherwise in the direction you are facing'],
  ['Interact', 'Space or E: talk, loot, open doors, harvest.'],
  ['', 'Walking into NPCs, trees, ore veins and chests works too'],
  ['Stairs', '>  (or .)  go down        <  (or ,)  go up'],
  ['Windows', 'I inventory    C character sheet    ? help    Esc close'],
  ['Chat', 'Enter to type, Enter to send, Esc to cancel'],
  ['', '[ and ] switch chat tabs, PgUp / PgDn scroll'],
  ['Commands', '/say  /shout  /w <user>  /r  /me  /who  /help  /pvp on|off'],
  ['', '/party invite|accept|decline|leave|kick <user>    /p <message>'],
  ['', '/trade <user>    /trade accept|cancel    /unstuck'],
  ['World', 'Oakhaven (safe) has the inn, smith, alchemist, bank and quest'],
  ['', 'board. Its north gate leads to the Whispering Wilds; stairs there'],
  ['', 'descend into the Sunken Catacombs. A dragon waits on floor 3.'],
];

function drawHelp(s: Screen): void {
  frame(s, 'Help', 'Esc close');
  HELP_LINES.forEach(([k, v], i) => {
    s.text(MX + 3, MY + 2 + i, k.padEnd(9), C.yellow, BG, ATTR.BOLD);
    s.text(MX + 13, MY + 2 + i, truncate(v, MW - 16), C.text, BG);
  });
}

// ---- Shop ---------------------------------------------------------------------------------------
function sellList(st: ClientState): { slot: number; it: Item }[] {
  return (st.inv?.bag ?? []).map((it, slot) => ({ it, slot })).filter((r): r is { slot: number; it: Item } => !!r.it);
}

function drawShop(s: Screen, st: ClientState, ui: UiState): void {
  const shop = st.shop!;
  frame(s, shop.npc, '↑↓ move  Tab buy/sell  Enter confirm  Esc leave');
  const buy = ui.shopMode === 'buy';
  s.text(MX + 3, MY + 2, '[ Buy ]', buy ? C.yellow : C.dim, BG, buy ? ATTR.BOLD : 0);
  s.text(MX + 12, MY + 2, '[ Sell ]', !buy ? C.yellow : C.dim, BG, !buy ? ATTR.BOLD : 0);
  s.textRight(MX + MW - 3, MY + 2, `Gold: ${st.inv?.gold ?? st.me?.gold ?? 0}`, C.gold, BG, ATTR.BOLD);
  if (buy) {
    const rows: Row[] = shop.stock.map((e) => ({ text: e.item.name, fg: RARITY_COLORS[e.item.rarity], glyph: ITEM_GLYPHS[e.item.slot], right: `${e.price}g`, rightFg: (st.me?.gold ?? 0) >= e.price ? C.gold : C.red }));
    list(s, MX + 2, MY + 4, MW - 4, 14, rows, ui.shopCursor, true);
    itemDetail(s, MX + 3, MY + 20, MW - 6, shop.stock[ui.shopCursor]?.item);
  } else {
    const sl = sellList(st);
    const rows: Row[] = sl.map(({ it }) => ({ text: it.name, fg: RARITY_COLORS[it.rarity], glyph: ITEM_GLYPHS[it.slot], right: `${Math.max(1, Math.floor(it.value * shop.sellRate)) * it.qty}g${it.qty > 1 ? ` (x${it.qty})` : ''}`, rightFg: C.gold }));
    if (!rows.length) s.text(MX + 4, MY + 5, 'Your backpack is empty.', C.dimmer, BG);
    list(s, MX + 2, MY + 4, MW - 4, 14, rows, ui.shopCursor, true);
    itemDetail(s, MX + 3, MY + 20, MW - 6, sl[ui.shopCursor]?.it);
  }
}

function keyShop(h: ModalHost, k: KeyEvent): void {
  const { ui, st } = h;
  if (k.key === 'Escape') { h.send({ t: 'shop', op: 'close' }); return; }
  if (k.key === 'Tab' || k.key === 'ArrowLeft' || k.key === 'ArrowRight') { ui.shopMode = ui.shopMode === 'buy' ? 'sell' : 'buy'; ui.shopCursor = 0; return; }
  const n = ui.shopMode === 'buy' ? st.shop!.stock.length : sellList(st).length;
  const d = nav(k);
  if (d) ui.shopCursor = clamp(ui.shopCursor + d, n);
  else if (k.key === 'Enter' || k.key === ' ') {
    if (ui.shopMode === 'buy') h.send({ t: 'shop', op: 'buy', index: ui.shopCursor });
    else { const row = sellList(st)[ui.shopCursor]; if (row) h.send({ t: 'shop', op: 'sell', index: row.slot }); }
  }
  ui.shopCursor = clamp(ui.shopCursor, ui.shopMode === 'buy' ? st.shop!.stock.length : sellList(st).length);
}

// ---- Bank ---------------------------------------------------------------------------------------
function drawBank(s: Screen, st: ClientState, ui: UiState): void {
  frame(s, 'Bank Chest', '↑↓ move  Tab pane  Enter move item  Esc close');
  const bag = st.inv?.bag ?? [];
  const bank = st.bank ?? [];
  s.text(MX + 2, MY + 2, `Backpack  ${bag.filter(Boolean).length}/${INVENTORY_SLOTS}`, ui.bankPane === 'bag' ? C.yellow : C.dim, BG, ATTR.BOLD);
  s.text(MX + 37, MY + 2, `Vault  ${bank.filter(Boolean).length}/${bank.length}`, ui.bankPane === 'bank' ? C.yellow : C.dim, BG, ATTR.BOLD);
  list(s, MX + 2, MY + 3, 33, 18, bag.map(itemRow), ui.bankPane === 'bag' ? ui.bankCursor : -1, ui.bankPane === 'bag');
  list(s, MX + 37, MY + 3, 33, 18, bank.map(itemRow), ui.bankPane === 'bank' ? ui.bankCursor : -1, ui.bankPane === 'bank');
  itemDetail(s, MX + 3, MY + 22, MW - 6, (ui.bankPane === 'bag' ? bag : bank)[ui.bankCursor]);
}

function keyBank(h: ModalHost, k: KeyEvent): void {
  const { ui, st } = h;
  if (k.key === 'Escape') { h.send({ t: 'bank', op: 'close' }); return; }
  if (k.key === 'Tab' || k.key === 'ArrowLeft' || k.key === 'ArrowRight') { ui.bankPane = ui.bankPane === 'bag' ? 'bank' : 'bag'; ui.bankCursor = 0; return; }
  const n = ui.bankPane === 'bag' ? (st.inv?.bag.length ?? 0) : (st.bank?.length ?? 0);
  const d = nav(k);
  if (d) ui.bankCursor = clamp(ui.bankCursor + d, n);
  else if (k.key === 'Enter' || k.key === ' ') h.send({ t: 'bank', op: ui.bankPane === 'bag' ? 'deposit' : 'withdraw', index: ui.bankCursor });
}

// ---- Quests -------------------------------------------------------------------------------------
const QUEST_COLORS = { available: C.text, active: C.cyan, complete: C.green, done: C.dimmer } as const;

function drawQuests(s: Screen, st: ClientState, ui: UiState): void {
  const q = st.quests!;
  frame(s, q.npc, '↑↓ move  Enter accept / turn in  Esc close');
  const rows: Row[] = q.quests.map((x) => ({
    text: x.name, fg: QUEST_COLORS[x.status],
    right: x.status === 'available' ? 'new' : x.status === 'active' ? `${x.have}/${x.need}` : x.status === 'complete' ? 'READY' : 'done',
    rightFg: QUEST_COLORS[x.status],
  }));
  list(s, MX + 2, MY + 3, MW - 4, 8, rows, ui.questCursor, true);
  const sel = q.quests[ui.questCursor];
  if (sel) {
    s.text(MX + 3, MY + 13, sel.name, C.yellow, BG, ATTR.BOLD);
    s.text(MX + 3, MY + 14, sel.desc, C.text, BG);
    s.text(MX + 3, MY + 16, `Progress: ${sel.have}/${sel.need}`, C.cyan, BG);
    s.text(MX + 3, MY + 17, `Reward: ${sel.rewardXp} XP, ${sel.rewardGold} gold`, C.gold, BG);
    const hint = sel.status === 'available' ? 'Press Enter to accept.' : sel.status === 'complete' ? 'Press Enter to turn in!' : sel.status === 'active' ? 'In progress.' : 'Completed.';
    s.text(MX + 3, MY + 19, hint, sel.status === 'complete' ? C.green : C.dim, BG);
  }
}

function keyQuests(h: ModalHost, k: KeyEvent): void {
  const { ui, st } = h;
  if (k.key === 'Escape') { h.send({ t: 'quest', op: 'close' }); return; }
  const q = st.quests!.quests;
  const d = nav(k);
  if (d) ui.questCursor = clamp(ui.questCursor + d, q.length);
  else if (k.key === 'Enter' || k.key === ' ') {
    const sel = q[ui.questCursor];
    if (sel?.status === 'available') h.send({ t: 'quest', op: 'accept', id: sel.id });
    else if (sel?.status === 'complete') h.send({ t: 'quest', op: 'turnin', id: sel.id });
  }
}

// ---- Dialog -------------------------------------------------------------------------------------
function drawDialog(s: Screen, st: ClientState, ui: UiState): void {
  const d = st.dialog!;
  const w = 56, x = 22, y = 9, h = 10 + d.options.length;
  s.fill(x, y, w, h, BG);
  s.box(x, y, w, h, C.borderBright, d.npc, C.yellow, BG);
  d.lines.forEach((l, i) => s.text(x + 3, y + 2 + i, truncate(l, w - 6), C.text, BG));
  d.options.forEach((o, i) => {
    const sel = i === ui.dialogCursor;
    s.fill(x + 2, y + 7 + i, w - 4, 1, sel ? 0x28305a : BG);
    s.text(x + 4, y + 7 + i, `${sel ? '>' : ' '} ${o.label}`, sel ? C.yellow : C.text, KEEP, sel ? ATTR.BOLD : 0);
  });
}

function keyDialog(h: ModalHost, k: KeyEvent): void {
  const { ui, st } = h;
  const opts = st.dialog!.options;
  if (k.key === 'Escape') { h.send({ t: 'dialog', choice: 'close' }); h.st.dialog = null; ui.dialogCursor = 0; return; }
  const d = nav(k);
  if (d) ui.dialogCursor = clamp(ui.dialogCursor + d, opts.length);
  else if (k.key === 'Enter' || k.key === ' ') {
    const o = opts[ui.dialogCursor];
    if (o) { h.send({ t: 'dialog', choice: o.id }); h.st.dialog = null; ui.dialogCursor = 0; }
  }
}

// ---- Trade --------------------------------------------------------------------------------------
function drawTrade(s: Screen, st: ClientState, ui: UiState): void {
  const tr = st.trade!;
  frame(s, `Trade with ${tr.them.name}`, '↑↓ pick  Space offer  [ ] gold ±10  { } ±100  Enter confirm  Esc cancel');
  const side = (x: number, label: string, v: typeof tr.me): void => {
    s.text(x, MY + 2, `${label}${v.confirmed ? '  ✓ confirmed' : ''}`, v.confirmed ? C.green : C.yellow, BG, ATTR.BOLD);
    s.text(x, MY + 3, `Gold: ${v.gold}`, C.gold, BG);
    v.items.forEach((it, i) => { if (i < 6) s.text(x, MY + 5 + i, truncate(`${it.name}${it.qty > 1 ? ` x${it.qty}` : ''}`, 30), RARITY_COLORS[it.rarity], BG); });
    if (!v.items.length) s.text(x, MY + 5, '(no items)', C.dimmer, BG);
  };
  side(MX + 3, 'You offer', tr.me);
  side(MX + 38, `${tr.them.name} offers`, tr.them);
  for (let y = MY + 2; y < MY + 12; y++) s.set(MX + 36, y, '│', C.border, BG);
  s.text(MX + 3, MY + 13, 'Your backpack (Space to offer / withdraw):', C.dim, BG);
  const bag = st.inv?.bag ?? [];
  const rows: Row[] = bag.map((it, i) => {
    const r = itemRow(it, i);
    if (it && ui.tradeOffer.has(i)) { r.right = '[offered]'; r.rightFg = C.green; }
    return r;
  });
  list(s, MX + 2, MY + 14, MW - 4, 11, rows, ui.tradeCursor, true);
}

function sendOffer(h: ModalHost): void {
  h.send({ t: 'trade', op: 'offer', slots: [...h.ui.tradeOffer], gold: h.ui.tradeGold });
}

function keyTrade(h: ModalHost, k: KeyEvent): void {
  const { ui, st } = h;
  if (k.key === 'Escape') { h.send({ t: 'trade', op: 'cancel' }); return; }
  const d = nav(k);
  if (d) ui.tradeCursor = clamp(ui.tradeCursor + d, INVENTORY_SLOTS);
  else if (k.key === ' ') {
    if (!st.inv?.bag[ui.tradeCursor]) return;
    if (ui.tradeOffer.has(ui.tradeCursor)) ui.tradeOffer.delete(ui.tradeCursor); else ui.tradeOffer.add(ui.tradeCursor);
    sendOffer(h);
  } else if (k.key === '[' || k.key === ']' || k.key === '{' || k.key === '}') {
    const step = k.key === '[' ? -10 : k.key === ']' ? 10 : k.key === '{' ? -100 : 100;
    ui.tradeGold = Math.max(0, Math.min(st.inv?.gold ?? 0, ui.tradeGold + step));
    sendOffer(h);
  } else if (k.key === 'Enter') h.send({ t: 'trade', op: 'confirm' });
}

// ---- Dispatch -----------------------------------------------------------------------------------
export function drawModal(s: Screen, st: ClientState, ui: UiState): void {
  switch (activeModal(st, ui)) {
    case 'inventory': return drawInventory(s, st, ui);
    case 'character': return drawCharacter(s, st);
    case 'help': return drawHelp(s);
    case 'shop': return drawShop(s, st, ui);
    case 'bank': return drawBank(s, st, ui);
    case 'quests': return drawQuests(s, st, ui);
    case 'dialog': return drawDialog(s, st, ui);
    case 'trade': return drawTrade(s, st, ui);
    case 'none': return;
  }
}

/** Returns true when a modal consumed the key. */
export function modalKey(h: ModalHost, k: KeyEvent): boolean {
  const m = activeModal(h.st, h.ui);
  switch (m) {
    case 'none': return false;
    case 'inventory': keyInventory(h, k); break;
    case 'character': if (k.key === 'Escape' || k.key === 'c' || k.key === 'C') h.ui.modal = 'none'; break;
    case 'help': if (k.key === 'Escape' || k.key === '?' || k.key === 'h') h.ui.modal = 'none'; break;
    case 'shop': keyShop(h, k); break;
    case 'bank': keyBank(h, k); break;
    case 'quests': keyQuests(h, k); break;
    case 'dialog': keyDialog(h, k); break;
    case 'trade': keyTrade(h, k); break;
  }
  if (m !== 'trade' && !h.st.trade) { h.ui.tradeOffer.clear(); h.ui.tradeGold = 0; }
  return true;
}
