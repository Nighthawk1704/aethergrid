// Offline self-test for world generation, spatial algorithms and persistence.
// Run with: npm test
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZONES, ZONE_IDS } from '../shared/constants';
import { computeFov, indicesToSpans } from '../shared/fov';
import { findPath } from '../shared/path';
import { T } from '../shared/tiles';
import type { Item, Vec2, ZoneId } from '../shared/types';
import { dummyVerify, hashPassword, verifyPassword } from './auth';
import { GameDb } from './db';
import { floodReachable, generateWorld, type World } from './world';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = ''): void {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
}

const SEED = 1337;
const hashTiles = (w: World): string => ZONE_IDS.map((z) => {
  let h = 2166136261;
  for (const b of w.zones[z].grid.tiles) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h.toString(16);
}).join('-');

// ---- World generation ---------------------------------------------------------------------
const t0 = performance.now();
const world = generateWorld(SEED);
console.log(`world generated in ${Math.round(performance.now() - t0)} ms`);
check('deterministic for equal seeds', hashTiles(world) === hashTiles(generateWorld(SEED)));
check('different seeds differ', hashTiles(world) !== hashTiles(generateWorld(SEED + 1)));

for (const id of ZONE_IDS) {
  const z = world.zones[id];
  check(`${id}: dimensions ${ZONES[id].w}x${ZONES[id].h}`, z.grid.w === ZONES[id].w && z.grid.h === ZONES[id].h);
  check(`${id}: arrival is walkable`, z.grid.walkable(z.arrival.x, z.arrival.y), JSON.stringify(z.arrival));
  const badMob = z.mobs.find((m) => !z.grid.walkable(m.x, m.y));
  check(`${id}: all ${z.mobs.length} mob spawns on walkable tiles`, !badMob, JSON.stringify(badMob));
}

const reachFrom = (z: ZoneId, from: Vec2): Uint8Array => floodReachable(world.zones[z].grid, from);
const canReach = (z: ZoneId, r: Uint8Array, p: Vec2): boolean => r[world.zones[z].grid.idx(p.x, p.y)] === 1;

// Oakhaven
{
  const z = world.zones.oakhaven;
  const r = reachFrom('oakhaven', z.arrival);
  check('oakhaven: 4 NPCs placed', z.npcs.length === 4);
  const unreachable = z.npcs.filter((n) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && canReach('oakhaven', r, { x: n.x + dx, y: n.y + dy })) return false;
    return true;
  });
  check('oakhaven: every NPC reachable', unreachable.length === 0, JSON.stringify(unreachable));
  check('oakhaven: NPC tiles are walkable floor', z.npcs.every((n) => z.grid.walkable(n.x, n.y)));
  check('oakhaven: north gate reachable from plaza', canReach('oakhaven', r, { x: 40, y: 0 }));
  const count = (t: number): number => z.grid.tiles.reduce((a, b) => a + (b === t ? 1 : 0), 0);
  check('oakhaven: has bank chest and quest board', count(T.BANK) === 1 && count(T.BOARD) === 1);
  check('oakhaven: forest has choppable trees', count(T.TREE) > 200);
  check('oakhaven: no monsters in town', z.mobs.length === 0);
}

// Wilds
{
  const z = world.zones.wilds;
  const r = reachFrom('wilds', z.arrival);
  check('wilds: dungeon entrance reachable from gate', canReach('wilds', r, z.stairsDown!));
  check('wilds: gate tiles reachable', canReach('wilds', r, { x: 75, y: 149 }));
  const count = (t: number): number => z.grid.tiles.reduce((a, b) => a + (b === t ? 1 : 0), 0);
  check('wilds: has trees, ore veins, lakes/rivers', count(T.TREE) > 500 && count(T.ORE) >= 15 && count(T.WATER) > 300);
  check('wilds: roads bridge deep water', count(T.BRIDGE) > 0, `bridges=${count(T.BRIDGE)}`);
  check('wilds: road network exists', count(T.ROAD) > 150, `road=${count(T.ROAD)}`);
  check('wilds: >= 60 roaming mobs', z.mobs.length >= 60, String(z.mobs.length));
  const unreach = z.mobs.filter((m) => !canReach('wilds', r, m));
  check('wilds: every mob spawn reachable', unreach.length === 0, `${unreach.length} unreachable`);
  const lvls = z.mobs.map((m) => m.level);
  check('wilds: mob levels scale with distance', Math.max(...lvls) >= 6 && Math.min(...lvls) <= 2, `${Math.min(...lvls)}..${Math.max(...lvls)}`);
}

// Dungeons
for (const [id, floor] of [['catacombs1', 1], ['catacombs2', 2], ['catacombs3', 3]] as const) {
  const z = world.zones[id];
  const r = reachFrom(id, z.stairsUp!);
  check(`${id}: has stairs up`, z.grid.get(z.stairsUp!.x, z.stairsUp!.y) === T.STAIRS_UP);
  if (floor < 3) {
    check(`${id}: stairs down reachable from stairs up`, canReach(id, r, z.stairsDown!));
  } else {
    const dragons = z.mobs.filter((m) => m.monster === 'dragon');
    check('catacombs3: exactly one Ancient Dragon', dragons.length === 1);
    check('catacombs3: boss reachable from stairs up', canReach(id, r, dragons[0]!));
    check('catacombs3: no stairs down', !z.stairsDown);
  }
  const unreach = z.mobs.filter((m) => !canReach(id, r, m));
  check(`${id}: every mob reachable`, unreach.length === 0, `${unreach.length} unreachable`);
  check(`${id}: has doors and walls`, z.grid.tiles.includes(T.DOOR_CLOSED) && z.grid.tiles.includes(T.WALL));
}

// Zone links are bidirectional and land on walkable tiles.
{
  let bad = 0, total = 0;
  const problems: string[] = [];
  for (const id of ZONE_IDS) {
    const z = world.zones[id];
    for (const [idx, link] of z.links) {
      total++;
      const dest = world.zones[link.zone];
      const here = { x: idx % z.grid.w, y: Math.floor(idx / z.grid.w) };
      const tile = z.grid.get(here.x, here.y);
      if (!dest.grid.walkable(link.x, link.y)) { bad++; problems.push(`${id}@${here.x},${here.y} lands on blocked tile`); continue; }
      if (tile === T.STAIRS_DOWN || tile === T.STAIRS_UP) {
        // Stairs must round-trip exactly.
        const back = dest.links.get(dest.grid.idx(link.x, link.y));
        if (!back || back.zone !== id || back.x !== here.x || back.y !== here.y) { bad++; problems.push(`${id}@${here.x},${here.y} stairs do not round-trip`); }
      } else {
        // Gate: the landing spot must be within 4 tiles of a gate tile that leads back to this zone.
        const near = [...dest.links.entries()].some(([i, l]) => l.zone === id
          && Math.hypot((i % dest.grid.w) - link.x, Math.floor(i / dest.grid.w) - link.y) <= 4);
        if (!near) { bad++; problems.push(`${id}@${here.x},${here.y} gate has no return gate`); }
        if (z.grid.get(here.x, here.y) !== T.GATE) { bad++; problems.push(`${id}@${here.x},${here.y} link is not on a GATE tile`); }
      }
    }
  }
  check(`zone links consistent (${total} links)`, bad === 0, problems.join('; '));
  check('link count: 6 gate tiles + 3 stair pairs', total === 12, String(total));
}

// ---- FOV ----------------------------------------------------------------------------------
{
  const w = 21, h = 21;
  const walls = new Set<number>();
  for (let y = 0; y < h; y++) walls.add(y * w + 12); // vertical wall at x=12 spanning the map
  const opaque = (x: number, y: number): boolean => x < 0 || y < 0 || x >= w || y >= h || walls.has(y * w + x);
  const vis = new Set(computeFov(5, 10, 9, w, h, opaque));
  check('fov: origin visible', vis.has(10 * w + 5));
  check('fov: wall face visible', vis.has(10 * w + 12));
  check('fov: tile behind wall hidden', !vis.has(10 * w + 14));
  check('fov: open tile in radius visible', vis.has(10 * w + 9));
  check('fov: beyond radius hidden', !vis.has(10 * w + 0 + 5 + 10));
  const wide = new Set(computeFov(0, 10, 5, 41, 21, () => false, 2));
  check('fov: aspect 2 sees twice as far sideways as vertically', wide.has(10 * 41 + 10) && !wide.has(10 * 41 + 12) && wide.has(15 * 41 + 0) && !wide.has(16 * 41 + 0));
  const list = computeFov(5, 10, 9, w, h, opaque);
  check('fov: sorted row-major', list.every((v, i) => i === 0 || v > list[i - 1]!));
  const spans = indicesToSpans(list, w);
  const decoded: number[] = [];
  for (let i = 0; i < spans.length; i += 3) for (let k = 0; k < spans[i + 2]!; k++) decoded.push(spans[i]! * w + spans[i + 1]! + k);
  check('fov: span encoding round-trips', JSON.stringify(decoded) === JSON.stringify(list));
}

// ---- A* -----------------------------------------------------------------------------------
{
  const w = 12, h = 12;
  const wall = new Set<number>();
  for (let y = 0; y < 10; y++) wall.add(y * w + 6); // wall with a gap at y=10,11
  const pass = (x: number, y: number): boolean => !wall.has(y * w + x);
  const p = findPath(w, h, { x: 1, y: 1 }, { x: 10, y: 1 }, pass);
  check('astar: routes around wall', !!p && p.length > 9 && p[p.length - 1]!.x === 10 && p.every((s) => pass(s.x, s.y)));
  const blocked = findPath(w, h, { x: 1, y: 1 }, { x: 10, y: 1 }, (x, y) => pass(x, y) && y < 10);
  check('astar: null when sealed off', blocked === null);
  const diag = findPath(5, 5, { x: 0, y: 0 }, { x: 1, y: 1 }, (x, y) => !((x === 1 && y === 0) || (x === 0 && y === 1)));
  check('astar: no diagonal corner cutting', diag === null);
  const open = findPath(w, h, { x: 0, y: 0 }, { x: 5, y: 5 }, () => true);
  check('astar: diagonal optimal', open?.length === 5);
  const goalBlocked = findPath(w, h, { x: 0, y: 0 }, { x: 3, y: 0 }, (x, y) => !(x === 3 && y === 0));
  check('astar: goal tile is enterable even if occupied', goalBlocked?.length === 3);
}

// ---- Persistence --------------------------------------------------------------------------
const sword: Item = { uid: 'i-1', base: 'sword', name: 'Fiery Steel Blade of the Bear', slot: 'weapon', rarity: 'rare', qty: 1, stats: { atk: 9, maxHp: 12 }, value: 120, ilvl: 5 };
const potion: Item = { uid: 'i-2', base: 'health_potion', name: 'Health Potion', slot: 'consumable', rarity: 'common', qty: 3, stats: {}, effect: { hp: 50 }, value: 10, ilvl: 1 };

const dir = mkdtempSync(join(tmpdir(), 'aethergrid-'));
const dbPath = join(dir, 'test.db');
try {
  const pw = await hashPassword('hunter22');
  check('scrypt: correct password verifies', await verifyPassword('hunter22', pw.salt, pw.hash));
  check('scrypt: wrong password rejected', !(await verifyPassword('hunter23', pw.salt, pw.hash)));
  await dummyVerify('x');

  let db = new GameDb(dbPath);
  const acct = db.createAccount('Alice', pw.salt, pw.hash, 'arcanist');
  check('db: account created with class stats', !!acct && acct.cls === 'arcanist' && acct.hp === 80 && acct.mp === 110);
  check('db: duplicate name (case-insensitive) rejected', db.createAccount('alice', pw.salt, pw.hash, 'vanguard') === null);
  const rec = acct!;
  rec.level = 4; rec.xp = 77; rec.gold = 321; rec.zone = 'wilds'; rec.x = 70; rec.y = 120;
  rec.bag[3] = potion; rec.equip.weapon = sword; rec.bank[7] = { ...potion, uid: 'i-3', qty: 9 };
  rec.quests['goblin_menace'] = { progress: 4, status: 'active' };
  db.saveCharacter(rec);
  const dropId = db.addDrop('wilds', 71, 121, 55, sword, 60_000);
  db.addDrop('wilds', 1, 1, 5, null, -1000); // already expired
  db.logChat('global', 'Alice', 'hello world');
  db.setMeta('seed', String(SEED));
  db.close();

  // "Server restart": reopen the same file.
  db = new GameDb(dbPath);
  const user = db.findUser('ALICE');
  check('db: user lookup is case-insensitive and survives restart', !!user && user.name === 'Alice');
  check('db: stored password verifies after restart', !!user && await verifyPassword('hunter22', user.salt, user.hash));
  const back = db.loadCharacter(user!.id)!;
  check('db: character scalars persisted', back.level === 4 && back.xp === 77 && back.gold === 321 && back.zone === 'wilds' && back.x === 70 && back.y === 120);
  check('db: bag item persisted at its slot', JSON.stringify(back.bag[3]) === JSON.stringify(potion) && back.bag[0] === null);
  check('db: equipped item persisted', JSON.stringify(back.equip.weapon) === JSON.stringify(sword) && back.equip.armor === null);
  check('db: bank item persisted', back.bank[7]?.qty === 9);
  check('db: quest progress persisted', back.quests['goblin_menace']?.progress === 4);
  // Re-saving after moving an item must not leave stale rows.
  back.bag[3] = null; back.bag[5] = potion;
  db.saveCharacter(back);
  const again = db.loadCharacter(user!.id)!;
  check('db: re-save replaces inventory rows', again.bag[3] === null && again.bag[5]?.uid === 'i-2');
  const drops = db.loadDrops();
  check('db: live drop persisted, expired drop pruned', drops.length === 1 && drops[0]!.item?.name === sword.name && drops[0]!.gold === 55);
  db.removeDrop(dropId);
  check('db: drop removal', db.loadDrops().length === 0);
  check('db: chat log + meta', db.recentGlobalChat(5)[0]?.text === 'hello world' && db.getMeta('seed') === String(SEED));
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
