// Chat, slash commands, parties and player-to-player trading.
import { INVENTORY_SLOTS, LOCAL_CHAT_RANGE, PARTY_MAX, secs } from '../shared/constants';
import { CLASSES } from '../shared/gamedata';
import type { ClientPacket } from '../shared/protocol';
import type { Item, PartyMemberView, TradeSideView, TradeView } from '../shared/types';
import { Player } from './entities';
import type { Game } from './game';
import { addTo, canFit } from './economy';

export interface Party { id: number; leaderId: number; members: number[]; sig: string }
export interface Invite { fromId: number; partyId: number; expires: number }
export interface Trade {
  id: number;
  a: Player; b: Player;
  slotsA: number[]; slotsB: number[];
  goldA: number; goldB: number;
  okA: boolean; okB: boolean;
}

let partyIds = 1;
let tradeIds = 1;

// ---- Chat -------------------------------------------------------------------------------------
const HELP = [
  'Movement: WASD / arrows (QEZC diagonals). Space/E: interact, talk, loot. < > : stairs.',
  'Skills: 1,2 class skills  3 health potion  4 mana potion  Tab: cycle target.',
  'I: inventory   C: character sheet   Enter: chat   Esc: leave chat / close windows.',
  'Chat: /say <msg>  /shout <msg>  /w <user> <msg>  /r <msg>  /me <action>  /who',
  'Party: /party invite <user>  /party accept|decline|leave|kick <user>  /p <msg>',
  'Other: /trade <user>  /trade accept|cancel   /pvp on|off   /unstuck   /help',
];

export function handleChat(game: Game, p: Player, raw: string): void {
  const text = raw.trim();
  if (!text) return;
  const now = Date.now();
  const s = p.session;
  s.chatTimes = s.chatTimes.filter((t) => now - t < 8000);
  if (s.chatTimes.length >= 6) { game.sys(p, 'You are chatting too fast.'); return; }
  s.chatTimes.push(now);

  if (text[0] !== '/') return say(game, p, text);
  const m = /^\/(\S+)\s*(.*)$/s.exec(text);
  if (!m) return;
  const cmd = m[1]!.toLowerCase();
  const arg = m[2]!.trim();
  switch (cmd) {
    case 'say': case 's': return arg ? say(game, p, arg) : game.sys(p, 'Usage: /say <message>');
    case 'shout': case 'g': case 'global': case 'y': return arg ? shout(game, p, arg) : game.sys(p, 'Usage: /shout <message>');
    case 'w': case 'whisper': case 'tell': case 't': {
      const [to, ...rest] = arg.split(/\s+/);
      if (!to || !rest.length) return game.sys(p, 'Usage: /w <user> <message>');
      return whisper(game, p, to, rest.join(' '));
    }
    case 'r': case 'reply':
      if (!p.lastWhisperFrom) return game.sys(p, 'Nobody to reply to.');
      return arg ? whisper(game, p, p.lastWhisperFrom, arg) : game.sys(p, 'Usage: /r <message>');
    case 'me': case 'emote': return arg ? emote(game, p, arg) : game.sys(p, 'Usage: /me <action>');
    case 'who': return who(game, p);
    case 'help': case '?': for (const l of HELP) game.sys(p, l); return;
    case 'party': return partyCommand(game, p, arg);
    case 'p': return arg ? partyChat(game, p, arg) : game.sys(p, 'Usage: /p <message>');
    case 'trade': return tradeCommand(game, p, arg);
    case 'pvp': return pvpCommand(game, p, arg);
    case 'unstuck': case 'home': return unstuck(game, p);
    default: game.sys(p, `Unknown command /${cmd}. Type /help.`);
  }
}

function say(game: Game, p: Player, text: string): void {
  for (const o of p.zone.players.values()) {
    if (o.dist(p) <= LOCAL_CHAT_RANGE) game.chat(o, 'local', p.name, text);
  }
  game.db.logChat('local', p.name, text, p.zone.def.id);
}

function emote(game: Game, p: Player, text: string): void {
  for (const o of p.zone.players.values()) if (o.dist(p) <= LOCAL_CHAT_RANGE) game.chat(o, 'local', '*', `${p.name} ${text}`);
}

function shout(game: Game, p: Player, text: string): void {
  for (const o of game.players.values()) game.chat(o, 'global', p.name, text);
  game.db.logChat('global', p.name, text, p.zone.def.id);
}

function whisper(game: Game, p: Player, to: string, text: string): void {
  const o = game.byName.get(to.toLowerCase());
  if (!o) return game.sys(p, `${to} is not online.`);
  if (o === p) return game.sys(p, 'You whisper to yourself. Nobody answers.');
  game.chat(o, 'whisper', p.name, text);
  game.chat(p, 'whisper', `to ${o.name}`, text);
  o.lastWhisperFrom = p.name;
  p.lastWhisperFrom = o.name;
  game.db.logChat('whisper', p.name, text, undefined, o.name);
}

function who(game: Game, p: Player): void {
  const list = [...game.players.values()].sort((a, b) => a.name.localeCompare(b.name));
  game.sys(p, `Online players (${list.length}):`);
  let line = '';
  for (const o of list) {
    const part = `${o.name} [L${o.level} ${CLASSES[o.cls].name}, ${o.zone.def.name}]`;
    if (line && line.length + part.length > 90) { game.sys(p, line); line = ''; }
    line += (line ? '; ' : '') + part;
  }
  if (line) game.sys(p, line);
}

function pvpCommand(game: Game, p: Player, arg: string): void {
  const want = arg.toLowerCase();
  if (want !== 'on' && want !== 'off') return game.sys(p, `PvP is ${p.pvp ? 'ON' : 'off'}. Usage: /pvp on|off (only active in the Wilds and Catacombs).`);
  if (want === 'off' && game.tick < p.combatUntil) return game.sys(p, 'You cannot disable PvP while in combat.');
  p.pvp = want === 'on';
  game.sys(p, p.pvp ? 'PvP enabled. Other flagged players can fight you outside Oakhaven.' : 'PvP disabled.');
}

function unstuck(game: Game, p: Player): void {
  if (game.tick < p.combatUntil) return game.sys(p, 'You cannot do that in combat.');
  if (game.tick < p.unstuckAt) return game.sys(p, `Unstuck is on cooldown (${Math.ceil((p.unstuckAt - game.tick) / 10)}s).`);
  p.unstuckAt = game.tick + secs(300);
  const home = game.world.zones.oakhaven.respawn;
  game.transfer(p, 'oakhaven', home.x, home.y);
  game.sys(p, 'You return to the Oakhaven plaza.');
}

// ---- Party ------------------------------------------------------------------------------------
function partyOf(game: Game, p: Player): Party | null {
  return p.partyId ? game.parties.get(p.partyId) ?? null : null;
}

export function partyMembers(game: Game, id: number): Player[] {
  const party = game.parties.get(id);
  if (!party) return [];
  return party.members.map((m) => game.players.get(m)).filter((x): x is Player => !!x);
}

function partyCommand(game: Game, p: Player, arg: string): void {
  const [sub, ...rest] = arg.split(/\s+/);
  const name = rest.join(' ');
  switch ((sub ?? '').toLowerCase()) {
    case '': {
      const party = partyOf(game, p);
      if (!party) return game.sys(p, 'You are not in a party. /party invite <user>');
      game.sys(p, 'Party: ' + partyMembers(game, party.id).map((m) => `${m.name}${m.id === party.leaderId ? '*' : ''} L${m.level}`).join(', '));
      return;
    }
    case 'invite': case 'inv': {
      const o = game.byName.get(name.toLowerCase());
      if (!o) return game.sys(p, `${name || 'That player'} is not online.`);
      if (o === p) return game.sys(p, 'You cannot invite yourself.');
      if (o.partyId) return game.sys(p, `${o.name} is already in a party.`);
      const party = partyOf(game, p);
      if (party && party.leaderId !== p.id) return game.sys(p, 'Only the party leader can invite.');
      if (party && party.members.length >= PARTY_MAX) return game.sys(p, 'Your party is full.');
      game.invites.set(o.id, { fromId: p.id, partyId: party?.id ?? 0, expires: game.tick + secs(60) });
      game.chat(o, 'party', 'Party', `${p.name} invites you to a party. Type /party accept or /party decline.`);
      game.chat(p, 'party', 'Party', `Invitation sent to ${o.name}.`);
      return;
    }
    case 'accept': {
      const inv = game.invites.get(p.id);
      if (!inv || inv.expires < game.tick) return game.sys(p, 'You have no pending party invitation.');
      game.invites.delete(p.id);
      const from = game.players.get(inv.fromId);
      if (!from) return game.sys(p, 'The inviter is no longer online.');
      let party = inv.partyId ? game.parties.get(inv.partyId) : partyOf(game, from);
      if (!party) {
        party = { id: partyIds++, leaderId: from.id, members: [from.id], sig: '' };
        game.parties.set(party.id, party);
        from.partyId = party.id;
      }
      if (party.members.length >= PARTY_MAX) return game.sys(p, 'That party is full.');
      party.members.push(p.id);
      p.partyId = party.id;
      partyBroadcast(game, party, `${p.name} joined the party.`);
      pushParty(game, party, true);
      return;
    }
    case 'decline':
      if (game.invites.delete(p.id)) game.sys(p, 'Invitation declined.');
      return;
    case 'leave': return leaveParty(game, p);
    case 'kick': {
      const party = partyOf(game, p);
      if (!party || party.leaderId !== p.id) return game.sys(p, 'Only the party leader can kick.');
      const o = game.byName.get(name.toLowerCase());
      if (!o || o.partyId !== party.id || o === p) return game.sys(p, 'That player is not in your party.');
      game.chat(o, 'party', 'Party', 'You were removed from the party.');
      leaveParty(game, o);
      return;
    }
    default: game.sys(p, 'Usage: /party [invite <user> | accept | decline | leave | kick <user>]');
  }
}

export function leaveParty(game: Game, p: Player): void {
  const party = partyOf(game, p);
  if (!party) return;
  party.members = party.members.filter((m) => m !== p.id);
  p.partyId = 0;
  game.send(p.session, { t: 'party', members: [] });
  game.chat(p, 'party', 'Party', 'You left the party.');
  if (party.members.length <= 1) {
    for (const id of party.members) {
      const o = game.players.get(id);
      if (o) { o.partyId = 0; game.send(o.session, { t: 'party', members: [] }); game.chat(o, 'party', 'Party', 'The party was disbanded.'); }
    }
    game.parties.delete(party.id);
    return;
  }
  if (party.leaderId === p.id) party.leaderId = party.members[0]!;
  partyBroadcast(game, party, `${p.name} left the party.`);
  pushParty(game, party, true);
}

function partyBroadcast(game: Game, party: Party, text: string): void {
  for (const m of partyMembers(game, party.id)) game.chat(m, 'party', 'Party', text);
}

function partyChat(game: Game, p: Player, text: string): void {
  const party = partyOf(game, p);
  if (!party) return game.sys(p, 'You are not in a party.');
  for (const m of partyMembers(game, party.id)) game.chat(m, 'party', p.name, text);
}

export function pushParty(game: Game, party: Party, force = false): void {
  const members = partyMembers(game, party.id);
  const views: PartyMemberView[] = members.map((m) => ({
    id: m.id, name: m.name, cls: m.cls, lv: m.level, hp: Math.round(m.hp), mhp: m.maxHp, leader: m.id === party.leaderId, zone: m.zone.def.id,
  }));
  const sig = JSON.stringify(views);
  if (!force && sig === party.sig) return;
  party.sig = sig;
  for (const m of members) game.send(m.session, { t: 'party', members: views });
}

// ---- Trade ------------------------------------------------------------------------------------
function tradeCommand(game: Game, p: Player, arg: string): void {
  const a = arg.toLowerCase();
  if (a === 'cancel') return cancelTrade(game, p, 'Trade cancelled.');
  if (a === 'accept') {
    const req = game.tradeRequests.get(p.id);
    if (!req || req.expires < game.tick) return game.sys(p, 'You have no pending trade request.');
    game.tradeRequests.delete(p.id);
    const from = game.players.get(req.fromId);
    if (!from) return game.sys(p, 'That player is no longer online.');
    return startTrade(game, from, p);
  }
  const o = game.byName.get(a);
  if (!a || !o) return game.sys(p, a ? `${arg} is not online.` : 'Usage: /trade <player> | accept | cancel');
  if (o === p) return game.sys(p, 'You cannot trade with yourself.');
  if (o.zone !== p.zone || o.dist(p) > 12) return game.sys(p, `${o.name} is too far away.`);
  if (p.tradeId || o.tradeId) return game.sys(p, 'One of you is already trading.');
  game.tradeRequests.set(o.id, { fromId: p.id, expires: game.tick + secs(30) });
  game.chat(o, 'system', 'Trade', `${p.name} wants to trade. Type /trade accept.`);
  game.chat(p, 'system', 'Trade', `Trade request sent to ${o.name}.`);
}

function startTrade(game: Game, a: Player, b: Player): void {
  if (a.tradeId || b.tradeId) return game.sys(b, 'One of you is already trading.');
  if (a.zone !== b.zone || a.dist(b) > 12) return game.sys(b, 'You are too far apart.');
  game.closeWindows(a);
  game.closeWindows(b);
  const t: Trade = { id: tradeIds++, a, b, slotsA: [], slotsB: [], goldA: 0, goldB: 0, okA: false, okB: false };
  game.trades.set(t.id, t);
  a.tradeId = b.tradeId = t.id;
  pushTrade(game, t);
}

function sideView(p: Player, slots: number[], gold: number, ok: boolean): TradeSideView {
  return { name: p.name, gold, confirmed: ok, items: slots.map((s) => p.bag[s]).filter((x): x is Item => !!x) };
}

function pushTrade(game: Game, t: Trade): void {
  const va: TradeView = { me: sideView(t.a, t.slotsA, t.goldA, t.okA), them: sideView(t.b, t.slotsB, t.goldB, t.okB) };
  const vb: TradeView = { me: sideView(t.b, t.slotsB, t.goldB, t.okB), them: sideView(t.a, t.slotsA, t.goldA, t.okA) };
  game.send(t.a.session, { t: 'trade', open: true, trade: va });
  game.send(t.b.session, { t: 'trade', open: true, trade: vb });
}

export function cancelTrade(game: Game, p: Player, why: string): void {
  const t = game.trades.get(p.tradeId);
  if (!t) return;
  game.trades.delete(t.id);
  for (const o of [t.a, t.b]) {
    o.tradeId = 0;
    game.send(o.session, { t: 'trade', open: false });
    game.sys(o, why);
  }
}

export function handleTrade(game: Game, p: Player, pkt: Extract<ClientPacket, { t: 'trade' }>): void {
  const t = game.trades.get(p.tradeId);
  if (!t) return;
  const isA = t.a === p;
  if (pkt.op === 'cancel') return cancelTrade(game, p, `${p.name} cancelled the trade.`);
  if (pkt.op === 'offer') {
    const slots = pkt.slots.filter((s) => s >= 0 && s < INVENTORY_SLOTS && p.bag[s]);
    const gold = Math.min(pkt.gold, p.gold);
    if (isA) { t.slotsA = slots; t.goldA = gold; } else { t.slotsB = slots; t.goldB = gold; }
    t.okA = t.okB = false;
    return pushTrade(game, t);
  }
  if (isA) t.okA = true; else t.okB = true;
  if (!(t.okA && t.okB)) return pushTrade(game, t);

  // Both confirmed: re-validate and swap atomically.
  const outA = t.slotsA.map((s) => t.a.bag[s]).filter((x): x is Item => !!x);
  const outB = t.slotsB.map((s) => t.b.bag[s]).filter((x): x is Item => !!x);
  const fail = (why: string): void => { t.okA = t.okB = false; game.sys(t.a, why); game.sys(t.b, why); pushTrade(game, t); };
  if (t.a.zone !== t.b.zone || t.a.dist(t.b) > 15) return cancelTrade(game, p, 'Trade cancelled: too far apart.');
  if (t.goldA > t.a.gold || t.goldB > t.b.gold) return fail('Trade failed: not enough gold.');
  if (outA.length !== t.slotsA.length || outB.length !== t.slotsB.length) return fail('Trade failed: items changed.');
  const bagA = t.a.bag.map((s, i) => (t.slotsA.includes(i) ? null : s));
  const bagB = t.b.bag.map((s, i) => (t.slotsB.includes(i) ? null : s));
  if (!canFit(bagA, outB) || !canFit(bagB, outA)) return fail('Trade failed: not enough inventory space.');

  for (const s of t.slotsA) t.a.bag[s] = null;
  for (const s of t.slotsB) t.b.bag[s] = null;
  for (const it of outB) addTo(t.a.bag, it);
  for (const it of outA) addTo(t.b.bag, it);
  t.a.gold += t.goldB - t.goldA;
  t.b.gold += t.goldA - t.goldB;
  game.markInv(t.a);
  game.markInv(t.b);
  game.trades.delete(t.id);
  for (const o of [t.a, t.b]) {
    o.tradeId = 0;
    game.send(o.session, { t: 'trade', open: false });
    game.sys(o, 'Trade complete.');
    game.savePlayer(o);
  }
}

/** Once a second: expire stale requests, cancel trades whose partners drifted apart. */
export function socialTick(game: Game): void {
  for (const [id, inv] of game.invites) if (inv.expires < game.tick) game.invites.delete(id);
  for (const [id, r] of game.tradeRequests) if (r.expires < game.tick) game.tradeRequests.delete(id);
  for (const t of [...game.trades.values()]) {
    if (t.a.zone !== t.b.zone || t.a.dist(t.b) > 15) cancelTrade(game, t.a, 'Trade cancelled: too far apart.');
  }
  for (const party of game.parties.values()) pushParty(game, party);
}
