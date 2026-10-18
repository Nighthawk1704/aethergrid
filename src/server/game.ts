// The authoritative game: 10 Hz tick loop, sessions, authentication, packet routing, world state.
import type { RawData, WebSocket } from 'ws';
import { PROTOCOL_VERSION, TICK_MS, ZONES, secs } from '../shared/constants';
import { NPCS, CLASSES } from '../shared/gamedata';
import { T } from '../shared/tiles';
import { encode, parseClient, type ClientPacket, type ServerPacket } from '../shared/protocol';
import { Rng } from '../shared/rng';
import type { ChatChannel, Item, ShopEntry, ZoneId } from '../shared/types';
import { updateMonster } from './ai';
import { dummyVerify, hashPassword, verifyPassword } from './auth';
import { cycleTarget, updatePlayer } from './player';
import type { CharacterRecord, GameDb } from './db';
import {
  addItem, closeWindows, handleBank, handleDialog, handleInv, handleQuest, handleShop, questProgress, quickPotion,
} from './economy';
import { Actor, Loot, Monster, Npc, Player, type Session } from './entities';
import { alchemistStock, blacksmithStock, generateEquipment, makePotion } from './items';
import {
  cancelTrade, handleChat, handleTrade, leaveParty, partyMembers, socialTick, type Invite, type Party, type Trade,
} from './social';
import { syncPlayer } from './sync';
import { generateWorld, type World } from './world';
import { ZoneRuntime } from './zone';

type DistOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
/** A server packet before the connection stamps its sequence id. */
export type Out = DistOmit<ServerPacket, 's'>;

export interface GameStats { tickMsAvg: number; tickMsMax: number; ticks: number; bytesOut: number; packetsOut: number }

const MOTD = 'Welcome to AetherGrid. Type /help for commands.';
const LOOT_TTL_MS = 300_000;
const AUTOSAVE_TICKS = secs(30);

export class Game {
  readonly world: World;
  readonly zones: Record<ZoneId, ZoneRuntime>;
  readonly players = new Map<number, Player>();
  readonly byName = new Map<string, Player>();
  readonly actors = new Map<number, Actor>();
  readonly sessions = new Set<Session>();
  readonly parties = new Map<number, Party>();
  readonly invites = new Map<number, Invite>();
  readonly trades = new Map<number, Trade>();
  readonly tradeRequests = new Map<number, { fromId: number; expires: number }>();
  readonly shops: { smith: ShopEntry[]; alchemist: ShopEntry[] };
  readonly rng = new Rng((Date.now() ^ (process.pid << 8)) >>> 0);

  tick = 0;
  /** Remaining A* searches monsters may start this tick. */
  pathBudget = 0;
  readonly stats: GameStats = { tickMsAvg: 0, tickMsMax: 0, ticks: 0, bytesOut: 0, packetsOut: 0 };

  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAt = 0;
  private sessionIds = 1;

  constructor(readonly db: GameDb, seed: number) {
    this.world = generateWorld(seed);
    const zones = {} as Record<ZoneId, ZoneRuntime>;
    for (const id of Object.keys(ZONES) as ZoneId[]) zones[id] = new ZoneRuntime(id, this.world.zones[id]);
    this.zones = zones;
    this.shops = { smith: blacksmithStock(seed), alchemist: alchemistStock() };
    this.populate();
    this.loadDrops();
  }

  // ---- World population --------------------------------------------------------------------
  private populate(): void {
    let mobs = 0;
    for (const z of Object.values(this.zones)) {
      for (const n of z.data.npcs) {
        const def = NPCS[n.npc]!;
        const npc = new Npc(n.npc, def.role, def.name, n.x, n.y);
        z.npcs.push(npc);
        z.addActor(npc, n.x, n.y);
        this.actors.set(npc.id, npc);
      }
      for (const spawn of z.data.mobs) {
        const m = new Monster(spawn);
        const spot = z.findNear(spawn.x, spawn.y, (x, y) => z.isFree(x, y), 3);
        if (!spot) continue;
        m.home = { x: spot.x, y: spot.y };
        z.monsters.push(m);
        z.addActor(m, spot.x, spot.y);
        this.actors.set(m.id, m);
        mobs++;
      }
    }
    console.log(`[world] populated ${mobs} monsters, ${[...Object.values(this.zones)].reduce((n, z) => n + z.npcs.length, 0)} NPCs`);
  }

  private loadDrops(): void {
    let n = 0;
    for (const d of this.db.loadDrops()) {
      const z = this.zones[d.zone];
      if (!z || !z.grid.walkable(d.x, d.y) || z.lootOn(d.x, d.y)) { this.db.removeDrop(d.id); continue; }
      const l = new Loot(d.zone, d.x, d.y, d.gold, d.item, this.tick + Math.ceil((d.expiresAt - Date.now()) / TICK_MS));
      l.dbId = d.id;
      z.addLoot(l);
      n++;
    }
    if (n) console.log(`[world] restored ${n} ground drops from the database`);
  }

  // ---- Lifecycle ---------------------------------------------------------------------------
  start(): void {
    this.nextAt = performance.now() + TICK_MS;
    const loop = (): void => {
      const t0 = performance.now();
      try {
        this.tickOnce();
      } catch (err) {
        console.error('[tick] error:', err);
      }
      const dt = performance.now() - t0;
      const s = this.stats;
      s.ticks++;
      s.tickMsAvg += (dt - s.tickMsAvg) * 0.02;
      s.tickMsMax = Math.max(s.tickMsMax * 0.999, dt);
      this.nextAt += TICK_MS;
      const now = performance.now();
      if (this.nextAt < now - TICK_MS * 5) this.nextAt = now; // fell far behind: drop ticks rather than spiral
      this.timer = setTimeout(loop, Math.max(0, this.nextAt - now));
    };
    this.timer = setTimeout(loop, TICK_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.saveAll();
    for (const s of this.sessions) {
      this.send(s, { t: 'kick', reason: 'Server shutting down.' });
      s.ws.close(1001, 'shutdown');
    }
  }

  saveAll(): void {
    for (const p of this.players.values()) this.savePlayer(p);
  }

  savePlayer(p: Player): void {
    try {
      this.db.saveCharacter(p.toRecord());
    } catch (err) {
      console.error(`[db] failed to save ${p.name}:`, err);
    }
  }

  // ---- The tick ----------------------------------------------------------------------------
  tickOnce(): void {
    this.tick++;
    this.pathBudget = 80;

    for (const p of this.players.values()) updatePlayer(this, p);

    for (const z of Object.values(this.zones)) {
      if (!z.active) continue;
      for (const m of z.monsters) updateMonster(this, m);
      this.zoneMaintenance(z);
    }

    if (this.tick % 10 === 0) socialTick(this);
    if (this.tick % 20 === 0) this.expireLoot();

    for (const p of this.players.values()) {
      if (p.invDirty) { p.invDirty = false; this.send(p.session, { t: 'inv', bag: p.bag, equip: p.equip, gold: p.gold }); }
      syncPlayer(this, p);
      if (this.tick >= p.nextAutosave) { p.nextAutosave = this.tick + AUTOSAVE_TICKS + this.rng.int(0, 50); this.savePlayer(p); }
    }
    for (const z of Object.values(this.zones)) {
      if (z.tileChanges.length) z.tileChanges = [];
      if (z.fx.length) z.fx = [];
    }
  }

  private zoneMaintenance(z: ZoneRuntime): void {
    for (const [idx, at] of z.doorTimers) {
      if (this.tick < at) continue;
      const x = idx % z.grid.w, y = Math.floor(idx / z.grid.w);
      if (z.actorAt(x, y) || z.lootOn(x, y)) { z.doorTimers.set(idx, this.tick + secs(2)); continue; }
      z.doorTimers.delete(idx);
      z.setTile(x, y, T.DOOR_CLOSED);
    }
    if (z.regrow.length && this.tick % 10 === 0) {
      for (let i = z.regrow.length - 1; i >= 0; i--) {
        const r = z.regrow[i]!;
        if (this.tick < r.at) continue;
        const x = r.idx % z.grid.w, y = Math.floor(r.idx / z.grid.w);
        if (z.actorAt(x, y) || z.lootOn(x, y)) { r.at = this.tick + secs(10); continue; }
        z.setTile(x, y, r.tile);
        z.regrow.splice(i, 1);
      }
    }
  }

  private expireLoot(): void {
    for (const z of Object.values(this.zones)) {
      for (const l of [...z.loot.values()]) {
        if (l.expireTick > this.tick) continue;
        z.removeLoot(l);
        if (l.dbId) this.db.removeDrop(l.dbId);
      }
    }
  }

  // ---- Messaging ---------------------------------------------------------------------------
  send(s: Session, pkt: Out | ServerPacket): void {
    if (s.closed || s.ws.readyState !== 1) return;
    if (s.ws.bufferedAmount > 4_000_000) { s.ws.terminate(); return; }
    s.outSeq++;
    const msg = encode({ ...pkt, s: s.outSeq } as ServerPacket);
    this.stats.bytesOut += msg.length;
    this.stats.packetsOut++;
    s.ws.send(msg);
  }

  chat(p: Player, chan: ChatChannel, from: string, text: string): void {
    this.send(p.session, { t: 'chat', chan, from, text, ts: Date.now() });
  }
  sys(p: Player, text: string): void { this.chat(p, 'system', 'System', text); }
  combatLog(p: Player, text: string): void { this.chat(p, 'combat', 'Combat', text); }

  broadcastSystem(text: string, except?: Player): void {
    for (const p of this.players.values()) if (p !== except) this.sys(p, text);
  }
  broadcastZone(z: ZoneRuntime, text: string): void {
    for (const p of z.players.values()) this.sys(p, text);
  }

  markInv(p: Player): void { p.invDirty = true; }

  // ---- Helpers used by subsystems -----------------------------------------------------------
  actorById(id: number): Actor | undefined { return this.actors.get(id); }
  partyMembers(id: number): Player[] { return partyMembers(this, id); }
  closeWindows(p: Player): void { closeWindows(this, p); }
  quickPotion(p: Player, base: 'health_potion' | 'mana_potion'): boolean { return quickPotion(this, p, base); }
  questProgress(p: Player, goal: string, n: number): void { questProgress(this, p, goal, n); }

  openDoor(z: ZoneRuntime, x: number, y: number): void {
    z.setTile(x, y, T.DOOR_OPEN);
    z.doorTimers.set(z.grid.idx(x, y), this.tick + secs(8));
  }

  /** Put a monster into AGGRO against a player and alert nearby packmates. */
  aggroMonster(m: Monster, src: Actor): void {
    if (!(src instanceof Player) || m.dead) return;
    const wasCalm = m.state === 'IDLE' || m.state === 'PATROL';
    m.state = 'AGGRO';
    m.targetId = src.id;
    m.path = [];
    m.lostSightSince = 0;
    if (!wasCalm) return;
    m.zone.emitFx(m.x, m.y, '!', 'info');
    for (const o of m.zone.actorsNear(m.x, m.y, 6)) {
      if (o instanceof Monster && o !== m && o.def.id === m.def.id && (o.state === 'IDLE' || o.state === 'PATROL')) {
        o.state = 'AGGRO';
        o.targetId = src.id;
        o.path = [];
      }
    }
  }

  spawnLoot(z: ZoneRuntime, x: number, y: number, gold: number, item: Item | null, ownerId: number): Loot {
    const l = new Loot(z.def.id, x, y, gold, item, this.tick + secs(LOOT_TTL_MS / 1000));
    l.ownerId = ownerId;
    l.ownerUntil = ownerId ? this.tick + secs(20) : 0;
    l.dbId = this.db.addDrop(z.def.id, x, y, gold, item, LOOT_TTL_MS);
    z.addLoot(l);
    return l;
  }

  pickup(p: Player, l: Loot): void {
    if (l.ownerId && l.ownerId !== p.id && this.tick < l.ownerUntil) {
      const owner = this.players.get(l.ownerId);
      const sameParty = owner && owner.partyId !== 0 && owner.partyId === p.partyId;
      if (!sameParty) {
        this.sys(p, `That belongs to ${owner?.name ?? 'someone else'} for ${Math.ceil((l.ownerUntil - this.tick) / 10)} more seconds.`);
        return;
      }
    }
    if (l.item && !addItem(this, p, l.item)) { this.sys(p, 'Your inventory is full.'); return; }
    if (l.gold) { p.gold += l.gold; this.markInv(p); }
    const parts = [l.item ? l.item.name : '', l.gold ? `${l.gold} gold` : ''].filter(Boolean);
    this.sys(p, `You pick up ${parts.join(' and ')}.`);
    p.zone.removeLoot(l);
    if (l.dbId) this.db.removeDrop(l.dbId);
  }

  // ---- Zones -------------------------------------------------------------------------------
  private zonePacket(z: ZoneRuntime): Out {
    const d = z.def;
    return { t: 'zone', zone: d.id, name: d.name, w: d.w, h: d.h, origin: d.origin, pvp: d.pvp, fov: d.fov, depth: d.depth };
  }

  /** Move a player to another (or the same) zone near the given tile. */
  transfer(p: Player, zoneId: ZoneId, x: number, y: number): void {
    this.closeWindows(p);
    const from = p.zone;
    const to = this.zones[zoneId];
    const spot = to.findNear(x, y, (xx, yy) => to.isFree(xx, yy), 8) ?? { x, y };
    from.removeActor(p);
    to.addActor(p, spot.x, spot.y);
    p.fovDirty = true;
    p.sent.clear();
    p.visList = [];
    p.visSet = new Set();
    p.target = 0;
    p.pendingMove = null;
    p.forceSelf = true;
    if (from !== to) {
      this.send(p.session, this.zonePacket(to));
      this.sys(p, `You enter ${to.def.name}.`);
      this.savePlayer(p);
    } else {
      this.send(p.session, this.zonePacket(to));
    }
  }

  // ---- Connections -------------------------------------------------------------------------
  attach(ws: WebSocket): void {
    const s: Session = {
      id: this.sessionIds++, ws, player: null, accountId: 0, authed: false, authBusy: false, authFails: 0, outSeq: 0,
      lastClientSeq: 0, tokens: 80, lastRefill: performance.now(), alive: true, chatTimes: [], closed: false, badPackets: 0,
    };
    this.sessions.add(s);
    this.send(s, { t: 'hello', version: PROTOCOL_VERSION, tickMs: TICK_MS, motd: MOTD });
    ws.on('message', (data: RawData) => this.onMessage(s, data));
    ws.on('pong', () => { s.alive = true; });
    ws.on('close', () => this.onClose(s));
    ws.on('error', () => { /* close follows */ });
  }

  /** Terminate connections that stopped answering pings. Called periodically by the server. */
  heartbeat(): void {
    for (const s of this.sessions) {
      if (!s.alive) { s.ws.terminate(); continue; }
      s.alive = false;
      try { s.ws.ping(); } catch { /* ignore */ }
    }
  }

  private onClose(s: Session): void {
    s.closed = true;
    this.sessions.delete(s);
    if (s.player) this.removePlayer(s.player);
  }

  private removePlayer(p: Player): void {
    if (p.tradeId) cancelTrade(this, p, `${p.name} disconnected.`);
    leaveParty(this, p);
    this.tradeRequests.delete(p.id);
    this.invites.delete(p.id);
    this.savePlayer(p);
    p.zone.removeActor(p);
    this.players.delete(p.id);
    this.actors.delete(p.id);
    if (this.byName.get(p.name.toLowerCase()) === p) this.byName.delete(p.name.toLowerCase());
    p.session.player = null;
    this.broadcastSystem(`${p.name} has left the world.`);
  }

  private onMessage(s: Session, data: RawData): void {
    const now = performance.now();
    s.tokens = Math.min(120, s.tokens + ((now - s.lastRefill) / 1000) * 60);
    s.lastRefill = now;
    if (s.tokens < 1) return; // flood: drop silently
    s.tokens -= 1;

    const raw = typeof data === 'string' ? data : Array.isArray(data) ? Buffer.concat(data).toString() : Buffer.from(data as ArrayBuffer).toString();
    const pkt = parseClient(raw);
    if (!pkt) {
      // Tell a client why its login/registration was rejected instead of leaving it hanging.
      if (!s.authed && /"t"\s*:\s*"(login|register)"/.test(raw.slice(0, 64))) {
        this.send(s, { t: 'auth', ok: false, error: 'Invalid input. Names: 3-16 letters, digits or _ (start with a letter); passwords: 4-64 characters.' });
      }
      if (++s.badPackets > 30) s.ws.close(1008, 'protocol violation');
      return;
    }
    if (pkt.t === 'ping') { this.send(s, { t: 'pong', ts: pkt.ts, tick: this.tick }); return; }
    const p = s.player;
    if (!s.authed || !p) {
      if (pkt.t === 'login' || pkt.t === 'register') void this.authenticate(s, pkt);
      else this.send(s, { t: 'error', message: 'Please log in first.' });
      return;
    }
    if (pkt.s > s.lastClientSeq) s.lastClientSeq = pkt.s;
    this.dispatch(p, pkt);
  }

  private dispatch(p: Player, pkt: ClientPacket): void {
    switch (pkt.t) {
      case 'move': p.pendingMove = { dx: pkt.dx, dy: pkt.dy, until: this.tick + 3 }; break;
      case 'interact': p.wantInteract = true; break;
      case 'stairs': p.wantStairs = pkt.dir; break;
      case 'skill':
        if (p.pendingSkills.length < 2) p.pendingSkills.push({ slot: pkt.slot, until: this.tick + 4 });
        break;
      case 'target': cycleTarget(this, p, pkt.mode === 'clear'); break;
      case 'chat': handleChat(this, p, pkt.text); break;
      case 'inv': handleInv(this, p, pkt); break;
      case 'shop': handleShop(this, p, pkt); break;
      case 'bank': handleBank(this, p, pkt); break;
      case 'trade': handleTrade(this, p, pkt); break;
      case 'quest': handleQuest(this, p, pkt); break;
      case 'dialog': handleDialog(this, p, pkt.choice); break;
      case 'login': case 'register': case 'ping': break;
    }
  }

  // ---- Authentication ----------------------------------------------------------------------
  private async authenticate(s: Session, pkt: Extract<ClientPacket, { t: 'login' | 'register' }>): Promise<void> {
    if (s.authBusy || s.authed) return;
    s.authBusy = true;
    const fail = (error: string): void => {
      this.send(s, { t: 'auth', ok: false, error });
      if (++s.authFails >= 8) s.ws.close(1008, 'too many attempts');
    };
    try {
      let rec: CharacterRecord | null;
      if (pkt.t === 'register') {
        if (this.db.findUser(pkt.name)) return fail('That name is already taken.');
        const { salt, hash } = await hashPassword(pkt.password);
        rec = this.db.createAccount(pkt.name, salt, hash, pkt.cls);
        if (!rec) return fail('That name is already taken.');
        this.giveStarterKit(rec);
        this.db.saveCharacter(rec);
      } else {
        const user = this.db.findUser(pkt.name);
        if (!user) { await dummyVerify(pkt.password); return fail('Invalid username or password.'); }
        if (!(await verifyPassword(pkt.password, user.salt, user.hash))) return fail('Invalid username or password.');
        rec = this.db.loadCharacter(user.id);
        if (!rec) return fail('Account has no character.');
        this.db.markLogin(user.id);
      }
      if (s.closed) return;
      this.enterWorld(s, rec);
    } catch (err) {
      console.error('[auth] error:', err);
      fail('Server error during login.');
    } finally {
      s.authBusy = false;
    }
  }

  private giveStarterKit(rec: CharacterRecord): void {
    const rng = this.rng;
    const weapon = { vanguard: 'sword', arcanist: 'staff', shadowblade: 'dagger' }[rec.cls];
    const armor = rec.cls === 'arcanist' ? 'robe' : 'leather';
    rec.equip.weapon = generateEquipment(rng, 1, { base: weapon, rarity: 'common' });
    rec.equip.armor = generateEquipment(rng, 1, { base: armor, rarity: 'common' });
    rec.bag[0] = makePotion('health_potion', 0, 3);
    rec.bag[1] = makePotion('mana_potion', 0, 2);
  }

  private enterWorld(s: Session, rec: CharacterRecord): void {
    const existing = this.byName.get(rec.name.toLowerCase());
    if (existing) {
      this.send(existing.session, { t: 'kick', reason: 'You logged in from another location.' });
      existing.session.ws.close(1000, 'replaced');
      this.removePlayer(existing);
      existing.session.closed = true;
    }
    const zone = this.zones[rec.zone] ?? this.zones.oakhaven;
    const startOk = zone.grid.walkable(rec.x, rec.y);
    const home = startOk ? { x: rec.x, y: rec.y } : zone.data.arrival;
    const p = new Player(s, rec);
    const spot = zone.findNear(home.x, home.y, (x, y) => zone.isFree(x, y), 10) ?? zone.data.arrival;
    s.player = p;
    s.authed = true;
    s.accountId = rec.userId;
    this.players.set(p.id, p);
    this.actors.set(p.id, p);
    this.byName.set(p.name.toLowerCase(), p);
    zone.addActor(p, spot.x, spot.y);
    p.nextAutosave = this.tick + AUTOSAVE_TICKS;

    this.send(s, { t: 'auth', ok: true, id: p.id, name: p.name });
    this.send(s, this.zonePacket(zone));
    this.markInv(p);
    for (const c of this.db.recentGlobalChat(12)) this.send(s, { t: 'chat', chan: 'global', from: c.sender, text: c.text, ts: c.ts });
    this.sys(p, `${MOTD} You are a level ${p.level} ${CLASSES[p.cls].name}.`);
    this.sys(p, 'Tip: bump into trees to chop, enemies to attack, NPCs to talk. Keys: I inventory, C sheet, Enter chat.');
    this.broadcastSystem(`${p.name} has entered the world.`, p);
  }
}
