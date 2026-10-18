// End-to-end tests: a real server + real WebSocket clients with manually driven ticks.
// Run with: npm run test:game
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasLos } from '../shared/fov';
import { findPath } from '../shared/path';
import { NetClient, type ClientMsg } from '../shared/client/net';
import { ClientState } from '../shared/client/state';
import { T } from '../shared/tiles';
import type { ClassId, Item, ZoneId } from '../shared/types';
import { questById } from '../shared/gamedata';
import { applyDamage, meleeBlocked } from './combat';
import { Monster, type Player } from './entities';
import type { Game } from './game';
import { startServer } from './main';
import { floodReachable } from './world';

let checks = 0;
let failures = 0;
const failed: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  checks++;
  if (!cond) { failures++; failed.push(name); }
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
}
const section = (s: string): void => console.log(`\n--- ${s}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class TC {
  readonly st = new ClientState();
  readonly net: NetClient;
  readonly packets: string[] = [];
  closedReason = '';
  name = '';
  constructor(private readonly url: string) {
    this.net = new NetClient({
      onPacket: (p) => { this.packets.push(p.t); this.st.apply(p); },
      onClose: (r) => { this.closedReason = r; },
    });
  }
  async open(): Promise<this> {
    this.net.connect(this.url);
    for (let i = 0; i < 100 && !this.st.connected; i++) await sleep(10);
    return this;
  }
  send(m: ClientMsg): void { this.net.send(m); }
  async auth(m: ClientMsg): Promise<boolean> {
    this.st.authError = '';
    this.send(m);
    for (let i = 0; i < 200 && !this.st.authed && !this.st.authError; i++) await sleep(10);
    return this.st.authed;
  }
  get me() { return this.st.me!; }
}

let srv: Awaited<ReturnType<typeof startServer>>;
let game: Game;
const flush = (): Promise<void> => sleep(25);
async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) game.tickOnce();
  await flush();
}
const P = (name: string): Player => game.byName.get(name.toLowerCase())!;

async function newPlayer(name: string, cls: ClassId = 'vanguard', pw = 'secret1'): Promise<TC> {
  const c = await new TC(`ws://localhost:${srv.port}/ws`).open();
  const ok = await c.auth({ t: 'register', name, password: pw, cls });
  if (!ok) throw new Error(`register ${name} failed: ${c.st.authError}`);
  c.name = name;
  await ticks(2);
  return c;
}

async function place(name: string, zone: ZoneId, x: number, y: number): Promise<void> {
  game.transfer(P(name), zone, x, y);
  await ticks(2);
}

async function step(c: TC, dx: -1 | 0 | 1, dy: -1 | 0 | 1, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    c.send({ t: 'move', dx, dy });
    await flush();
    await ticks(4);
  }
}

/** Send a chat line; the wall-clock chat limiter is reset first so tests can run faster than humans type. */
function chat(c: TC, text: string): void {
  P(c.name).session.chatTimes = [];
  c.send({ t: 'chat', text });
}

/** A free tile next to the monster plus the step direction that faces it. */
function adjacentSpot(m: Monster): { x: number; y: number; dx: -1 | 0 | 1; dy: -1 | 0 | 1 } {
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]] as const) {
    if (m.zone.isFree(m.x + dx, m.y + dy) && !meleeBlocked(m.zone, m.x + dx, m.y + dy, m.x, m.y)) {
      return { x: m.x + dx, y: m.y + dy, dx: -dx as -1 | 0 | 1, dy: -dy as -1 | 0 | 1 };
    }
  }
  throw new Error('monster is boxed in');
}

/** Take the packmates out of the picture so single-target scenarios are deterministic. */
function isolate(m: Monster): void {
  for (const o of m.zone.monsters) {
    if (o === m || o.dead || o.dist(m) > 10) continue;
    o.dead = true; o.state = 'RESPAWN'; o.respawnAt = game.tick + 1_000_000;
    m.zone.removeActor(o);
  }
}

/** Hold a monster still (no wandering, no passive aggro) so positions computed now stay valid. */
function pin(m: Monster): void {
  m.state = 'IDLE'; m.idleUntil = game.tick + 1000; m.noAggroUntil = game.tick + 1000; m.path = [];
}

const usedMonsters = new Set<number>();
function pickGoblin(pred: (m: Monster) => boolean = () => true, maxLevel = 5): Monster {
  const z = game.zones.wilds;
  const m = z.monsters.find((o) => o.def.id === 'goblin' && !o.dead && o.level <= maxLevel && !usedMonsters.has(o.id) && freeSpotWithLos(o, 3) && pred(o));
  if (!m) throw new Error('no suitable goblin');
  usedMonsters.add(m.id);
  isolate(m);
  return m;
}

/** Make the player strong enough for the scenario without touching the code under test. */
function buff(name: string, level: number): void {
  const p = P(name);
  p.level = level;
  p.recalc();
  p.hp = p.maxHp;
  p.mp = p.stats.maxMp;
}

/** A free tile at Chebyshev distance `dist` from the monster, in its line of sight (optionally within `maxWalk` steps). */
function freeSpotWithLos(m: Monster, dist: number, maxWalk = Infinity): { x: number; y: number } | null {
  const z = m.zone;
  for (let dy = -dist; dy <= dist; dy++) {
    for (let dx = -dist; dx <= dist; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== dist) continue;
      const x = m.x + dx, y = m.y + dy;
      if (!z.isFree(x, y) || !hasLos(x, y, m.x, m.y, (a, b) => z.grid.opaque(a, b))) continue;
      if (maxWalk !== Infinity) {
        const path = findPath(z.grid.w, z.grid.h, { x: m.x, y: m.y }, { x, y }, (a, b) => z.grid.passable(a, b), { maxNodes: 400 });
        if (!path || path.length > maxWalk) continue;
      }
      return { x, y };
    }
  }
  return null;
}

/** The least crowded live monster of a type that has a clear line of sight spot nearby. */
function loneMonster(id: string, maxLevel = 99): Monster {
  const z = game.zones.wilds;
  const cands = z.monsters
    .filter((o) => o.def.id === id && !o.dead && o.level <= maxLevel && freeSpotWithLos(o, 3))
    .map((o) => ({ o, n: z.monsters.filter((q) => q !== o && !q.dead && q.dist(o) < 9).length }))
    .sort((a, b) => a.n - b.n);
  if (!cands.length) throw new Error(`no ${id} found`);
  return cands[0]!.o;
}

// =============================================================================================
async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aethergrid-game-'));
  const dbPath = join(dir, 'game.db');
  srv = await startServer({ port: 0, dbPath, quiet: true, autoStart: false });
  game = srv.game;
  const wilds = game.zones.wilds;
  const town = game.zones.oakhaven;

  // ---- Auth -----------------------------------------------------------------------------
  section('authentication');
  const hero = await newPlayer('Hero', 'vanguard');
  check('register succeeds and enters Oakhaven', hero.st.authed && hero.st.zone?.id === 'oakhaven');
  check('starter gear equipped, potions in bag', !!hero.st.inv?.equip.weapon && !!hero.st.inv?.equip.armor && (hero.st.inv?.bag[0]?.qty ?? 0) === 3);
  check('welcome messages received', hero.st.chat.some((l) => l.text.includes('Welcome to AetherGrid')));

  const dup = await new TC(`ws://localhost:${srv.port}/ws`).open();
  check('duplicate name rejected', !(await dup.auth({ t: 'register', name: 'hero', password: 'secret1', cls: 'arcanist' })) && /taken/.test(dup.st.authError));
  check('invalid name gets an explicit error', !(await dup.auth({ t: 'register', name: 'x', password: 'secret1', cls: 'arcanist' })) && /Invalid/.test(dup.st.authError), dup.st.authError);
  check('wrong password rejected', !(await dup.auth({ t: 'login', name: 'Hero', password: 'nope' })) && /Invalid/.test(dup.st.authError));
  check('unknown user rejected (same message)', !(await dup.auth({ t: 'login', name: 'Nobody', password: 'nope' })) && /Invalid/.test(dup.st.authError));
  check('login correct password kicks the old session', await dup.auth({ t: 'login', name: 'hero', password: 'secret1' }));
  await flush();
  check('old session told why', hero.st.kicked.includes('another location'), hero.st.kicked);
  check('only one Hero online', [...game.players.values()].filter((p) => p.name === 'Hero').length === 1);
  hero.net.close();
  const h = dup; // the live Hero connection from here on

  // ---- Movement, FOV and delta compression -------------------------------------------------
  section('movement / fog of war / deltas');
  await ticks(2);
  const y0 = h.me.y;
  await step(h, 0, -1, 3);
  check('moves north 3 tiles', h.me.y === y0 - 3, `${y0} -> ${h.me.y}`);
  const zmap = h.st.zone!;
  const visible = zmap.vis.reduce((a, b) => a + b, 0);
  const known = zmap.known.reduce((a, b) => a + (b ? 1 : 0), 0);
  check('FOV marks tiles visible (elliptical, radius 14x28 in town)', visible > 500 && visible < 1700, String(visible));
  check('explored tiles remembered', known >= visible);
  const before = h.packets.length;
  await ticks(5);
  check('idle player receives no redundant state', h.packets.length - before <= 1, `${h.packets.length - before} packets`);
  const farTile = (() => { for (let i = 0; i < zmap.known.length; i++) if (!zmap.known[i]) return i; return -1; })();
  check('unexplored map stays hidden (no map leak)', farTile >= 0 && h.st.tileAt(farTile % zmap.w, Math.floor(farTile / zmap.w)) === -1);
  check('server acks client sequence', h.st.tick > 0);

  await place('Hero', 'oakhaven', 40, 42);
  // Wall blocking: the town wall at y=15; stand just below it and push.
  await place('Hero', 'oakhaven', 30, 16);
  await step(h, 0, -1, 2);
  check('walls block movement', h.me.y === 16, `y=${h.me.y}`);

  // ---- Doors -----------------------------------------------------------------------------
  section('doors');
  await place('Hero', 'oakhaven', 38, 27);
  await step(h, -1, 0, 1);
  check('first bump opens the inn door', town.grid.get(36, 27) === T.DOOR_OPEN || h.me.x === 37, `door=${town.grid.get(36, 27)} x=${h.me.x}`);
  await step(h, -1, 0, 3);
  check('player walks through the open door', h.me.x <= 35, `x=${h.me.x}`);
  await place('Hero', 'oakhaven', 38, 27);
  await ticks(120);
  check('door closes again after a while', town.grid.get(36, 27) === T.DOOR_CLOSED);

  // ---- Inn -------------------------------------------------------------------------------
  section('inn dialog');
  await place('Hero', 'oakhaven', 31, 27);
  P('Hero').hp = 20;
  await step(h, -1, 0, 1);
  check('bumping Marta opens the inn dialog', !!h.st.dialog && h.st.dialog.options.some((o) => o.id === 'rest'));
  const goldBefore = P('Hero').gold;
  h.send({ t: 'dialog', choice: 'rest' });
  await flush(); await ticks(2);
  check('resting heals fully and costs gold', P('Hero').hp === P('Hero').maxHp && P('Hero').gold === goldBefore - 5, `gold ${goldBefore} -> ${P('Hero').gold}`);

  // ---- Shop ------------------------------------------------------------------------------
  section('shop');
  await place('Hero', 'oakhaven', 31, 52);
  await step(h, -1, 0, 1);
  check('bumping the alchemist opens her shop', !!h.st.shop && h.st.shop.stock.length >= 8, JSON.stringify(h.st.shop?.npc));
  const gold1 = P('Hero').gold;
  const priceOf = h.st.shop!.stock[0]!.price;
  h.send({ t: 'shop', op: 'buy', index: 0 });
  await flush(); await ticks(2);
  check('buying deducts gold and adds the item', P('Hero').gold === gold1 - priceOf && (h.st.inv?.bag[0]?.qty ?? 0) === 4, `gold ${gold1}->${P('Hero').gold}`);
  h.send({ t: 'shop', op: 'buy', index: 3 });
  await flush(); await ticks(2);
  check('cannot buy what you cannot afford', P('Hero').gold >= 0 && !h.st.inv?.bag.some((i) => i?.name.startsWith('Superior')));
  const gold2 = P('Hero').gold;
  h.send({ t: 'shop', op: 'sell', index: 1 });
  await flush(); await ticks(2);
  check('selling pays gold and removes the stack', P('Hero').gold > gold2 && !h.st.inv?.bag[1]);
  await step(h, 1, 0, 4);
  await ticks(12); // window range is checked once a second
  check('walking away closes the shop window', h.st.shop === null);

  // ---- Harvesting -------------------------------------------------------------------------
  section('harvesting');
  let treeSpot: { x: number; y: number } | null = null;
  for (let y = 3; y < 12 && !treeSpot; y++) for (let x = 3; x < 70 && !treeSpot; x++) {
    if (town.grid.get(x, y) === T.TREE && town.grid.walkable(x - 1, y) && !town.actorAt(x - 1, y)) treeSpot = { x, y };
  }
  check('forest has a reachable tree', !!treeSpot);
  await place('Hero', 'oakhaven', treeSpot!.x - 1, treeSpot!.y);
  await step(h, 1, 0, 1);
  check('bumping a tree yields oak logs', !!h.st.inv?.bag.some((i) => i?.base === 'wood'));
  check('tree becomes a stump', town.grid.get(treeSpot!.x, treeSpot!.y) === T.STUMP);
  await flush();
  check('client sees the tile change (delta)', h.st.tileAt(treeSpot!.x, treeSpot!.y) === T.STUMP);
  await ticks(1200);
  check('tree regrows after its timer', town.grid.get(treeSpot!.x, treeSpot!.y) === T.TREE);

  // ---- Zones ----------------------------------------------------------------------------
  section('zone transitions');
  await place('Hero', 'oakhaven', 40, 3);
  await step(h, 0, -1, 3);
  check('north gate leads to the Whispering Wilds', h.st.zone?.id === 'wilds' && P('Hero').zone === wilds, h.st.zone?.id);
  const sd = game.world.zones.wilds.stairsDown!;
  await place('Hero', 'wilds', sd.x, sd.y);
  h.send({ t: 'stairs', dir: 'down' });
  await flush(); await ticks(2);
  check('stairs down enter the Catacombs', h.st.zone?.id === 'catacombs1');
  const up1 = game.world.zones.catacombs1.stairsUp!;
  check('arrive on the up-stairs', h.me.x === up1.x && h.me.y === up1.y);
  h.send({ t: 'stairs', dir: 'down' });
  await flush(); await ticks(2);
  check('no stairs down where there are none', h.st.zone?.id === 'catacombs1');
  h.send({ t: 'stairs', dir: 'up' });
  await flush(); await ticks(2);
  check('stairs up return to the Wilds', h.st.zone?.id === 'wilds');
  check('wilds map memory kept across the round trip', h.st.maps.get('wilds')!.known.some((v) => v > 0));

  // ---- Combat & AI -------------------------------------------------------------------------
  section('monster AI: aggro, chase, attack, flee, respawn');
  buff('Hero', 6);
  const gob = pickGoblin((m) => !!freeSpotWithLos(m, 5, 9), 4);
  const spot = freeSpotWithLos(gob, 5, 9)!;
  await place('Hero', 'wilds', spot.x, spot.y);
  const hp0 = P('Hero').hp;
  let minD = 99;
  for (let i = 0; i < 80 && gob.state !== 'AGGRO'; i++) await ticks(1);
  check('goblin notices the player and goes AGGRO', gob.state === 'AGGRO', gob.state);
  for (let i = 0; i < 60; i++) { await ticks(1); minD = Math.min(minD, gob.dist(P('Hero'))); }
  check('goblin paths (A*) to melee range', minD <= 1, `min distance ${minD}`);
  check('goblin damages the player', P('Hero').hp < hp0, `${hp0} -> ${P('Hero').hp}`);
  check('combat log reports hits', h.st.chat.some((l) => l.chan === 'combat' && /hits you/.test(l.text)));

  const xp0 = P('Hero').xp;
  const lv0 = P('Hero').level;
  gob.hp = Math.ceil(gob.maxHp * 0.1);
  await ticks(2);
  check('hurt goblin FLEEs at <15% HP', gob.state === 'FLEE', gob.state);
  const distToHero = (): number => Math.hypot(gob.x - P('Hero').x, gob.y - P('Hero').y);
  const fleeFrom = distToHero();
  // A goblin pinned against water or trees genuinely cannot run; only demand movement when it has room.
  const hasRoom = [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => (dx || dy)
    && wilds.isFree(gob.x + dx, gob.y + dy) && Math.hypot(gob.x + dx - P('Hero').x, gob.y + dy - P('Hero').y) > fleeFrom + 0.01
    && (!dx || !dy || (wilds.grid.walkable(gob.x + dx, gob.y) && wilds.grid.walkable(gob.x, gob.y + dy)))));
  await ticks(10);
  check('fleeing goblin runs away (when it has room)', !hasRoom || distToHero() > fleeFrom, `from ${fleeFrom.toFixed(1)} to ${distToHero().toFixed(1)}`);
  // Cowards outrun you; pin it with a stun, then finish it with bump attacks.
  gob.addBuff('stun', 200);
  const adj = adjacentSpot(gob);
  await place('Hero', 'wilds', adj.x, adj.y);
  for (let i = 0; i < 30 && !gob.dead; i++) {
    h.send({ t: 'move', dx: adj.dx, dy: adj.dy });
    await flush(); await ticks(3);
  }
  check('player bump-attacks the goblin to death', gob.dead);
  check('XP awarded', P('Hero').xp > xp0 || P('Hero').level > lv0);
  check('monster enters RESPAWN state', gob.state === 'RESPAWN');
  const lootBefore = [...wilds.loot.values()];
  check('loot dropped on the ground', lootBefore.length > 0);
  if (lootBefore.length) {
    const l = lootBefore[0]!;
    await place('Hero', 'wilds', l.x, l.y);
    const goldBefore2 = P('Hero').gold;
    if (wilds.loot.has(l.id)) { h.send({ t: 'interact' }); await flush(); await ticks(2); }
    check('E picks up loot', !wilds.loot.has(l.id) && P('Hero').gold > goldBefore2, `gold ${goldBefore2}->${P('Hero').gold}`);
  }
  for (let waited = 0; waited < gob.def.respawn + 150; waited += 20) {
    P('Hero').hp = P('Hero').maxHp; // stay alive: sleeping zones do not run respawn timers
    await ticks(20);
  }
  check('goblin respawns after its timer', !gob.dead && ['IDLE', 'PATROL', 'AGGRO'].includes(gob.state), `${gob.state} dead=${gob.dead}`);

  // A target across a river: the monster sees it but cannot path, so it must give up.
  {
    const z = wilds;
    let found: { m: Monster; px: number; py: number } | null = null;
    for (const m of z.monsters) {
      if (m.dead || m.def.id !== 'goblin' || usedMonsters.has(m.id)) continue;
      for (let dx = -6; dx <= 6 && !found; dx++) for (let dy = -6; dy <= 6 && !found; dy++) {
        const x = m.x + dx, y = m.y + dy;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 3 || !z.isFree(x, y)) continue;
        if (!hasLos(m.x, m.y, x, y, (a, b) => z.grid.opaque(a, b))) continue;
        // Exact terrain reachability (flood fill), not a capped search.
        if (!floodReachable(z.grid, { x: m.x, y: m.y })[z.grid.idx(x, y)]) found = { m, px: x, py: y };
      }
      if (found) break;
    }
    if (found) {
      usedMonsters.add(found.m.id);
      isolate(found.m);
      await place('Hero', 'wilds', found.px, found.py);
      for (let i = 0; i < 40 && found.m.state !== 'AGGRO'; i++) await ticks(1);
      check('monster aggroes on a target it can see across the river', found.m.state === 'AGGRO', found.m.state);
      let gaveUp = false;
      for (let i = 0; i < 150 && !gaveUp; i++) { P('Hero').hp = P('Hero').maxHp; await ticks(1); gaveUp = found.m.state !== 'AGGRO'; }
      check('monster gives up on an unreachable target instead of hovering forever', gaveUp, found.m.state);
      if (!gaveUp) {
        const m = found.m, hp = P('Hero');
        console.log('   DBG unreachable', JSON.stringify({ id: m.id, pos: [m.x, m.y], home: m.home, wanted: [found.px, found.py], hero: [hp.x, hp.y], heroZone: hp.zone.def.id, state: m.state, unreach: m.unreachableSince, replanAt: m.replanAt, path: m.path.length, noAggro: m.noAggroUntil, tick: game.tick, targetId: m.targetId, heroId: hp.id, dist: m.dist(hp), moveCd: m.moveCd, buffs: [...m.buffs.keys()] }));
      }
    } else {
      console.log('   (no river-separated goblin found for this seed; unreachable-target case skipped)');
    }
  }

  // ---- Skills -----------------------------------------------------------------------------
  section('class skills');
  const mage = await newPlayer('Merlin', 'arcanist');
  buff('Merlin', 6);
  const g2 = pickGoblin();
  const s2 = freeSpotWithLos(g2, 4)!;
  await place('Merlin', 'wilds', s2.x, s2.y);
  P('Merlin').target = g2.id;
  const mp0 = P('Merlin').mp;
  const g2hp = g2.hp;
  mage.send({ t: 'skill', slot: 1 });
  await flush(); await ticks(2);
  check('Fireball hits the locked target at range', g2.hp < g2hp || g2.dead, `${g2hp} -> ${g2.hp}`);
  check('Fireball spends mana and starts its cooldown', P('Merlin').mp < mp0 && P('Merlin').cd[0] > 0);
  await flush();
  check('client receives the cooldown', mage.me.cd[0] > 0);
  const mp1 = P('Merlin').mp;
  mage.send({ t: 'skill', slot: 1 });
  await flush(); await ticks(1);
  check('skill on cooldown is refused (no mana spent)', P('Merlin').mp >= mp1);
  await ticks(40);
  check('cooldown expires', P('Merlin').cd[0] === 0);
  const gAdj = pickGoblin();
  g2.hp = 0; // keep the previous target out of the way
  pin(gAdj);
  const adjM = adjacentSpot(gAdj);
  await place('Merlin', 'wilds', adjM.x, adjM.y);
  gAdj.maxHp = gAdj.hp = 5000;
  mage.send({ t: 'skill', slot: 2 });
  await flush(); await ticks(2);
  check('Frost Nova roots nearby enemies', gAdj.rooted, `buffs=${[...gAdj.buffs.keys()]}`);
  const rootedAt = { x: gAdj.x, y: gAdj.y };
  await ticks(15);
  check('rooted monster cannot move', gAdj.x === rootedAt.x && gAdj.y === rootedAt.y);

  const knight = await newPlayer('Knight', 'vanguard');
  buff('Knight', 6);
  const g3 = pickGoblin();
  g3.maxHp = g3.hp = 5000;
  pin(g3);
  const adjK = adjacentSpot(g3);
  await place('Knight', 'wilds', adjK.x, adjK.y);
  P('Knight').faceX = adjK.dx; P('Knight').faceY = adjK.dy;
  knight.send({ t: 'skill', slot: 1 });
  await flush(); await ticks(2);
  check('Shield Bash stuns the target', g3.stunned, `buffs=${[...g3.buffs.keys()]}`);
  await flush();
  check('stun is flagged on the wire', [...knight.st.entities.values()].some((e) => e.id === g3.id && (e.fl & 1) !== 0));
  const g3pos = { x: g3.x, y: g3.y };
  await ticks(10);
  check('stunned monster does not move', g3.x === g3pos.x && g3.y === g3pos.y);
  await place('Knight', 'oakhaven', 40, 42);
  const kMp = P('Knight').mp;
  knight.send({ t: 'skill', slot: 2 });
  await flush(); await ticks(1);
  check('Whirlwind with no enemies is refused (no mana spent, no cooldown)', P('Knight').mp >= kMp && P('Knight').cd[1] === 0);
  const g3b = pickGoblin();
  g3b.maxHp = g3b.hp = 5000;
  pin(g3b);
  const adjW = adjacentSpot(g3b);
  await place('Knight', 'wilds', adjW.x, adjW.y);
  g3b.addBuff('root', 100); // keep it from wandering off between setup and cast
  const g3bHp = g3b.hp;
  knight.send({ t: 'skill', slot: 2 });
  await flush(); await ticks(2);
  check('Whirlwind hits adjacent enemies', g3b.hp < g3bHp, `${g3bHp} -> ${g3b.hp}`);

  const rogue = await newPlayer('Shade', 'shadowblade');
  buff('Shade', 6);
  rogue.send({ t: 'skill', slot: 2 });
  await flush(); await ticks(2);
  check('Smoke Bomb grants stealth', P('Shade').stealthed);
  await flush();
  check('stealth shows as a buff on the client', rogue.me.buffs.some((b) => b.id === 'stealth'));
  P('Shade').buffs.clear();

  // Backstab: damage from behind must clearly exceed damage from the front (crit disabled for determinism).
  const g4 = pickGoblin((m) => m.zone.isFree(m.x - 1, m.y));
  g4.maxHp = g4.hp = 100000;
  // Pin it in place (no wandering, no passive aggro) before the rogue arrives.
  g4.state = 'IDLE'; g4.idleUntil = game.tick + 1000; g4.noAggroUntil = game.tick + 1000; g4.path = [];
  await place('Shade', 'wilds', g4.x - 1, g4.y);
  P('Shade').stats.crit = 0;
  P('Shade').faceX = 1; P('Shade').faceY = 0;
  g4.faceX = 1; g4.faceY = 0; // looking away from the rogue
  check('rogue is standing directly behind the goblin', P('Shade').x === g4.x - 1 && P('Shade').y === g4.y, `shade=(${P('Shade').x},${P('Shade').y}) goblin=(${g4.x},${g4.y})`);
  const stab = async (): Promise<number> => {
    const p = P('Shade');
    p.cd[0] = 0; p.atkCd = 0; p.mp = p.stats.maxMp;
    const before = g4.hp;
    rogue.send({ t: 'skill', slot: 1 });
    await flush(); await ticks(1);
    return before - g4.hp;
  };
  const fromBehind = await stab();
  if (fromBehind === 0) {
    const sp = P('Shade');
    console.log('   DBG backstab', JSON.stringify({ shade: [sp.x, sp.y], face: [sp.faceX, sp.faceY], g4: [g4.x, g4.y, g4.state, g4.dead], mp: sp.mp, cd: sp.cd, atkCd: sp.atkCd, buffs: [...sp.buffs.keys()], hp: sp.hp, zone: sp.zone.def.id, msgs: rogue.st.chat.slice(-4).map((c) => c.text) }));
  }
  g4.state = 'AGGRO'; g4.targetId = P('Shade').id;
  const front: number[] = [];
  for (let i = 0; i < 4; i++) {
    g4.faceX = 1; g4.faceY = 0;
    // Face the attacker, like a real monster that is fighting someone.
    g4.faceX = Math.sign(P('Shade').x - g4.x); g4.faceY = Math.sign(P('Shade').y - g4.y);
    front.push(await stab());
  }
  const frontAvg = front.reduce((x, y) => x + y, 0) / front.length;
  check('Backstab from behind deals ~2x the damage of a frontal stab', fromBehind > frontAvg * 1.6 && frontAvg > 0, `behind=${fromBehind} front=${frontAvg.toFixed(1)}`);

  // ---- Chat, party, trade ------------------------------------------------------------------
  section('chat / party / trade');
  const a = await newPlayer('Alice', 'vanguard');
  const b = await newPlayer('Bob', 'arcanist');
  const far = await newPlayer('Faraway', 'shadowblade');
  await place('Alice', 'oakhaven', 40, 44);
  await place('Bob', 'oakhaven', 42, 44);
  await place('Faraway', 'oakhaven', 40, 70);
  chat(a, 'hello neighbours');
  await flush(); await ticks(1);
  check('/say reaches nearby players', b.st.chat.some((l) => l.chan === 'local' && l.text === 'hello neighbours'));
  check('/say does not reach distant players', !far.st.chat.some((l) => l.text === 'hello neighbours'));
  chat(a, '/shout big news');
  await flush(); await ticks(1);
  check('/shout reaches everyone', far.st.chat.some((l) => l.chan === 'global' && l.text === 'big news'));
  chat(a, '/w bob psst');
  await flush(); await ticks(1);
  check('/w whispers privately', b.st.chat.some((l) => l.chan === 'whisper' && l.from === 'Alice' && l.text === 'psst') && !far.st.chat.some((l) => l.text === 'psst'));
  chat(b, '/r got it');
  await flush(); await ticks(1);
  check('/r replies to the last whisperer', a.st.chat.some((l) => l.chan === 'whisper' && l.text === 'got it'));
  chat(a, '/who');
  await flush(); await ticks(1);
  check('/who lists online players', a.st.chat.some((l) => /Online players \(\d+\)/.test(l.text)) && a.st.chat.some((l) => l.text.includes('Bob')));
  chat(a, '/nonsense');
  await flush(); await ticks(1);
  check('unknown commands are reported', a.st.chat.some((l) => /Unknown command/.test(l.text)));
  chat(a, '/help');
  await flush(); await ticks(1);
  check('/help prints help', a.st.chat.filter((l) => l.chan === 'system').some((l) => l.text.includes('/party')));
  for (let i = 0; i < 8; i++) a.send({ t: 'chat', text: `spam ${i}` });
  await flush(); await ticks(1);
  check('chat flood is rate limited', a.st.chat.some((l) => /too fast/.test(l.text)));

  chat(a, '/party invite bob');
  await flush(); await ticks(1);
  check('party invite delivered', b.st.chat.some((l) => l.chan === 'party' && /invites you/.test(l.text)));
  chat(b, '/party accept');
  await flush(); await ticks(12);
  check('party formed with both members', P('Alice').partyId !== 0 && P('Alice').partyId === P('Bob').partyId && a.st.party.length === 2 && b.st.party.length === 2);
  check('party members flagged on the wire', [...b.st.entities.values()].some((e) => e.n === 'Alice' && (e.fl & 32) !== 0));
  chat(a, '/p form up');
  await flush(); await ticks(1);
  check('/p party chat', b.st.chat.some((l) => l.chan === 'party' && l.text === 'form up'));

  // Shared XP: Bob never touches the monster.
  buff('Alice', 8); buff('Bob', 8);
  const g5 = loneMonster('goblin', 5);
  await place('Alice', 'wilds', g5.x - 1, g5.y);
  await place('Bob', 'wilds', g5.x - 2, g5.y - 1);
  const bobXp = P('Bob').xp + P('Bob').level * 1000;
  const aliceXp = P('Alice').xp + P('Alice').level * 1000;
  P('Alice').faceX = 1; P('Alice').faceY = 0;
  g5.hp = 1;
  applyDamage(game, P('Alice'), g5, 5, false);
  await ticks(2);
  check('goblin killed by Alice', g5.dead);
  check('kill XP is shared with the in-range party member', P('Bob').xp + P('Bob').level * 1000 > bobXp && P('Alice').xp + P('Alice').level * 1000 > aliceXp);

  // PvP.
  const g6hp = P('Bob').hp;
  await place('Alice', 'wilds', 75, 140); await place('Bob', 'wilds', 76, 140);
  chat(a, '/party leave');
  await flush(); await ticks(1);
  check('/party leave dissolves a 2-person party', P('Alice').partyId === 0 && P('Bob').partyId === 0);
  await step(a, 1, 0, 2);
  check('no PvP damage unless both flag themselves', P('Bob').hp === g6hp);
  chat(a, '/pvp on'); chat(b, '/pvp on');
  await flush(); await ticks(1);
  await step(a, 1, 0, 3);
  check('flagged players can fight in the Wilds', P('Bob').hp < g6hp, `${g6hp} -> ${P('Bob').hp}`);
  await place('Alice', 'oakhaven', 40, 44); await place('Bob', 'oakhaven', 41, 44);
  const safe = P('Bob').hp;
  await step(a, 1, 0, 3);
  check('Oakhaven is a PvP-free safe zone', P('Bob').hp === safe);
  chat(a, '/pvp off');
  await flush(); await ticks(1);

  // Trade.
  await place('Alice', 'oakhaven', 40, 44); await place('Bob', 'oakhaven', 42, 44);
  const sword: Item = { uid: 'trade-1', base: 'sword', name: 'Fiery Steel Blade of the Bear', slot: 'weapon', rarity: 'rare', qty: 1, stats: { atk: 9 }, value: 100, ilvl: 5 };
  P('Alice').bag[5] = sword;
  game.markInv(P('Alice'));
  await ticks(2);
  chat(a, '/trade bob');
  await flush(); await ticks(1);
  chat(b, '/trade accept');
  await flush(); await ticks(2);
  check('trade window opens for both', !!a.st.trade && !!b.st.trade);
  a.send({ t: 'trade', op: 'offer', slots: [5], gold: 3 });
  await flush(); await ticks(1);
  check('offers are mirrored to the partner', b.st.trade?.them.items[0]?.uid === 'trade-1' && b.st.trade?.them.gold === 3);
  a.send({ t: 'trade', op: 'confirm' });
  await flush(); await ticks(1);
  check('one-sided confirmation does not complete the trade', P('Alice').bag[5]?.uid === 'trade-1');
  const aGold = P('Alice').gold, bGold = P('Bob').gold;
  b.send({ t: 'trade', op: 'confirm' });
  await flush(); await ticks(2);
  check('both confirming swaps items and gold', P('Bob').bag.some((i) => i?.uid === 'trade-1') && !P('Alice').bag[5] && P('Alice').gold === aGold - 3 && P('Bob').gold === bGold + 3);
  check('trade windows close', a.st.trade === null && b.st.trade === null);
  chat(a, '/trade bob');
  await flush(); chat(b, '/trade accept');
  await flush(); await ticks(1);
  a.send({ t: 'trade', op: 'cancel' });
  await flush(); await ticks(1);
  check('cancel closes the trade without changes', a.st.trade === null && b.st.trade === null && P('Alice').tradeId === 0);

  // ---- Bank ------------------------------------------------------------------------------
  section('bank');
  await place('Knight', 'oakhaven', 49, 52);
  const potion = P('Knight').bag[0]!;
  await step(knight, 1, 0, 1);
  check('bumping the chest opens the bank', !!knight.st.bank);
  knight.send({ t: 'bank', op: 'deposit', index: 0 });
  await flush(); await ticks(2);
  check('deposit moves the stack into the vault', !P('Knight').bag[0] && P('Knight').bank.some((i) => i?.uid === potion.uid));
  knight.send({ t: 'bank', op: 'withdraw', index: 0 });
  await flush(); await ticks(2);
  check('withdraw returns it', P('Knight').bag.some((i) => i?.uid === potion.uid) && !P('Knight').bank[0]);

  // ---- Quests ----------------------------------------------------------------------------
  section('quests');
  await place('Knight', 'oakhaven', 36, 38);
  await step(knight, 0, -1, 1);
  check('bumping the quest board lists quests', !!knight.st.quests && knight.st.quests.quests.length >= 5);
  knight.send({ t: 'quest', op: 'accept', id: 'goblin_menace' });
  await flush(); await ticks(1);
  check('quest accepted', P('Knight').quests['goblin_menace']?.status === 'active');
  knight.send({ t: 'quest', op: 'accept', id: 'dragonbane' });
  await flush(); await ticks(1);
  check('level-gated quest refused', !P('Knight').quests['dragonbane']);
  game.questProgress(P('Knight'), 'kill:goblin', 6);
  await ticks(1);
  check('progress completes the quest', P('Knight').quests['goblin_menace']?.status === 'complete');
  const kGold = P('Knight').gold, kXp = P('Knight').xp + P('Knight').level * 10000;
  knight.send({ t: 'quest', op: 'turnin', id: 'goblin_menace' });
  await flush(); await ticks(2);
  const def = questById('goblin_menace')!;
  check('turn-in pays gold and XP', P('Knight').gold === kGold + def.rewardGold && P('Knight').xp + P('Knight').level * 10000 > kXp);
  check('quest marked done', P('Knight').quests['goblin_menace']?.status === 'done');

  // ---- Inventory ops ----------------------------------------------------------------------
  section('inventory');
  const bagSword: Item = { ...sword, uid: 'inv-1', name: 'Test Blade', stats: { atk: 20 } };
  P('Knight').bag[7] = bagSword;
  game.markInv(P('Knight'));
  const atk0 = P('Knight').stats.atk;
  const oldWeapon = P('Knight').equip.weapon!;
  knight.send({ t: 'inv', op: 'equip', slot: 7 });
  await flush(); await ticks(2);
  check('equipping raises attack and swaps the old weapon into the bag', P('Knight').stats.atk > atk0 && P('Knight').bag[7]?.uid === oldWeapon.uid);
  knight.send({ t: 'inv', op: 'unequip', equip: 'weapon' });
  await flush(); await ticks(2);
  check('unequip returns it to the bag', P('Knight').equip.weapon === null && P('Knight').bag.some((i) => i?.uid === 'inv-1'));
  P('Knight').hp = Math.floor(P('Knight').maxHp / 2);
  const hpUse = P('Knight').hp;
  knight.send({ t: 'skill', slot: 3 });
  await flush(); await ticks(2);
  check('hotkey 3 quaffs a health potion', P('Knight').hp > hpUse);
  const dropIdx = P('Knight').bag.findIndex((i) => i?.uid === 'inv-1');
  knight.send({ t: 'inv', op: 'drop', slot: dropIdx });
  await flush(); await ticks(2);
  check('dropping puts the item on the ground', !P('Knight').bag.some((i) => i?.uid === 'inv-1') && [...town.loot.values()].some((l) => l.item?.uid === 'inv-1'));

  // ---- Death -----------------------------------------------------------------------------
  section('death');
  const orc = wilds.monsters.find((m) => m.def.id === 'orc' && !m.dead && (() => { try { adjacentSpot(m); return true; } catch { return false; } })())!;
  const adjO = adjacentSpot(orc);
  await place('Shade', 'wilds', adjO.x, adjO.y);
  P('Shade').hp = 1;
  P('Shade').buffs.clear();
  for (let i = 0; i < 120 && P('Shade').zone === wilds; i++) await ticks(1);
  check('killed player respawns in Oakhaven', P('Shade').zone === town && P('Shade').hp > 1, `${P('Shade').zone.def.id} hp=${P('Shade').hp}`);
  await flush();
  check('client is told about the death', rogue.st.chat.some((l) => /slain/.test(l.text)) && rogue.st.zone?.id === 'oakhaven');

  // ---- Abuse ---------------------------------------------------------------------------------
  section('protocol abuse');
  const evil = await new TC(`ws://localhost:${srv.port}/ws`).open();
  evil.net.send({ t: 'move', dx: 1, dy: 0 });
  await flush();
  check('unauthenticated gameplay packets are refused', evil.st.chat.some((l) => /log in/.test(l.text)));
  (evil.net as unknown as { ws: WebSocket }).ws.send('{"t":"move","dx":99,"dy":"x"}');
  (evil.net as unknown as { ws: WebSocket }).ws.send('not json at all');
  (evil.net as unknown as { ws: WebSocket }).ws.send('x'.repeat(5000));
  await flush();
  check('server survives garbage input', game.tick > 0 && srv.port > 0);
  evil.net.close();

  // ---- Persistence across restart ------------------------------------------------------------
  section('persistence across server restart');
  const wildsHash = (): string => Buffer.from(game.world.zones.wilds.grid.tiles.slice(0, 4000)).toString('base64');
  const hashBefore = wildsHash();
  P('Knight').gold = 777;
  await place('Knight', 'wilds', 75, 140);
  const snap = { level: P('Knight').level, xp: P('Knight').xp, gold: P('Knight').gold, x: P('Knight').x, y: P('Knight').y, bag: JSON.stringify(P('Knight').bag), equip: JSON.stringify(P('Knight').equip), quests: JSON.stringify(P('Knight').quests) };
  const markerLoot = game.spawnLoot(wilds, 75, 138, 42, null, 0);
  const markerPos = { x: markerLoot.x, y: markerLoot.y };
  knight.net.close();
  await flush();
  for (const c of [a, b, far, mage, rogue, h]) c.net.close();
  await flush();
  await srv.close();

  srv = await startServer({ port: 0, dbPath, quiet: true, autoStart: false });
  game = srv.game;
  check('same world after restart (stored seed)', wildsHash() === hashBefore);
  check('ground drop survived the restart', !!game.zones.wilds.lootOn(markerPos.x, markerPos.y)?.gold);
  const k2 = await new TC(`ws://localhost:${srv.port}/ws`).open();
  check('login works after restart', await k2.auth({ t: 'login', name: 'knight', password: 'secret1' }));
  await ticks(2);
  const kp = P('Knight');
  check('level / xp / gold persisted', kp.level === snap.level && kp.xp === snap.xp && kp.gold === snap.gold, `${kp.level}/${kp.xp}/${kp.gold} vs ${snap.level}/${snap.xp}/${snap.gold}`);
  check('inventory and equipment persisted', JSON.stringify(kp.bag) === snap.bag && JSON.stringify(kp.equip) === snap.equip);
  check('quest progress persisted', JSON.stringify(kp.quests) === snap.quests);
  check('position persisted (zone + tile)', kp.zone.def.id === 'wilds' && Math.abs(kp.x - snap.x) <= 3 && Math.abs(kp.y - snap.y) <= 3, `${kp.zone.def.id} ${kp.x},${kp.y}`);
  check('client received full state after re-login', !!k2.st.inv && !!k2.st.zone && k2.me.gold === snap.gold);
  const bad = await new TC(`ws://localhost:${srv.port}/ws`).open();
  const good = await new TC(`ws://localhost:${srv.port}/ws`).open();
  check('passwords survive restart (wrong rejected, right accepted)', !(await bad.auth({ t: 'login', name: 'Knight', password: 'wrong!' })) && (await good.auth({ t: 'login', name: 'Alice', password: 'secret1' })));
  k2.net.close(); bad.net.close(); good.net.close();
  await flush();

  // ---- Load ------------------------------------------------------------------------------
  section('load: 40 simultaneous players');
  const crowd: TC[] = [];
  const classes: ClassId[] = ['vanguard', 'arcanist', 'shadowblade'];
  for (let i = 0; i < 40; i++) crowd.push(await newPlayer(`Crowd${String(i).padStart(2, '0')}`, classes[i % 3]!));
  for (const c of crowd) {
    const m = wilds.monsters[(crowd.indexOf(c) * 7) % wilds.monsters.length]!;
    game.transfer(P(c.name), 'wilds', m.x, m.y);
    buff(c.name, 10);
  }
  check('40 players online', game.players.size >= 40, String(game.players.size));
  const tickTimes: number[] = [];
  const bytes0 = game.stats.bytesOut, packets0 = game.stats.packetsOut;
  const t0 = performance.now();
  for (let t = 0; t < 300; t++) {
    for (const c of crowd) if (Math.random() < 0.5) c.send({ t: 'move', dx: (Math.floor(Math.random() * 3) - 1) as -1 | 0 | 1, dy: (Math.floor(Math.random() * 3) - 1) as -1 | 0 | 1 });
    if (t % 25 === 0) for (const c of crowd) c.send({ t: 'skill', slot: 1 });
    const a0 = performance.now();
    game.tickOnce();
    tickTimes.push(performance.now() - a0);
    if (t % 5 === 0) await sleep(4);
  }
  await flush();
  const avg = tickTimes.reduce((x, y) => x + y, 0) / tickTimes.length;
  const max = Math.max(...tickTimes);
  const bytes = game.stats.bytesOut - bytes0, packets = game.stats.packetsOut - packets0;
  console.log(`   300 ticks, 40 players in the Wilds: tick avg ${avg.toFixed(2)} ms, max ${max.toFixed(2)} ms; ${packets} packets, ${(bytes / 1024).toFixed(0)} KiB sent (${(bytes / 300 / 40).toFixed(0)} B/player/tick); ${(performance.now() - t0).toFixed(0)} ms wall`);
  check('40 players: average tick far below the 100 ms budget', avg < 20, `${avg.toFixed(2)} ms`);
  check('40 players: worst tick below the budget', max < 100, `${max.toFixed(2)} ms`);
  check('40 players: all still connected', crowd.every((c) => c.net.connected));
  check('40 players: every client mirrors its server position', crowd.every((c) => c.me.x === P(c.name).x && c.me.y === P(c.name).y));
  for (const c of crowd) c.net.close();
  await flush();

  await srv.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) console.log(`FAILED: ${failed.join(' | ')}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
