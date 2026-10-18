import { Rng, hashSeed } from '../../shared/rng';
import { Simplex2 } from '../../shared/noise';
import { findPath } from '../../shared/path';
import { T } from '../../shared/tiles';
import { ZONES } from '../../shared/constants';
import { ZONE_SPAWNS } from '../../shared/gamedata';
import type { MonsterId, Vec2 } from '../../shared/types';
import { TileGrid, floodReachable, type Link, type MobSpawn, type ZoneData } from './grid';

const START: Vec2 = { x: 75, y: 146 };
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

interface Ruin { x0: number; y0: number; x1: number; y1: number; c: Vec2 }

/** The Whispering Wilds: noise-driven biomes, rivers, lakes, ruins, roads with bridges, roaming mobs. */
export function generateWilds(seed: number): ZoneData {
  const def = ZONES.wilds;
  const { w: W, h: H } = def;
  const g = new TileGrid(W, H, T.GRASS);
  const rng = new Rng(hashSeed(seed, 'wilds'));
  const elev = new Simplex2(hashSeed(seed, 'wilds-elev'));
  const moist = new Simplex2(hashSeed(seed, 'wilds-moist'));
  const river = new Simplex2(hashSeed(seed, 'wilds-river'));
  const jitter = new Simplex2(hashSeed(seed, 'wilds-road'));

  // ---- Biomes --------------------------------------------------------------------------------
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const e = elev.fbm(x * 0.03, y * 0.03, 4);
      const m = moist.fbm(x * 0.05, y * 0.05, 3);
      const r = Math.abs(river.fbm(x * 0.016, y * 0.016, 2));
      let t: number;
      if (e < -0.36) t = T.WATER;
      else if (e < -0.29) t = T.SHALLOW;
      else if (r < 0.02) t = T.WATER;
      else if (r < 0.038) t = T.SHALLOW;
      else if (e < -0.2) t = T.SAND;
      else if (e > 0.36) t = rng.chance(0.07) ? T.ORE : rng.chance(0.12) ? T.RUBBLE : T.FLOOR;
      else if (m > 0.12) t = rng.chance(0.5) ? T.TREE : T.GRASS;
      else if (m > -0.1) t = rng.chance(0.08) ? T.TREE : T.GRASS;
      else t = rng.chance(0.2) ? T.GRASS : T.FLOOR;
      g.set(x, y, t);
    }
  }

  // Rock outcrops with ore, so mining quests are always satisfiable.
  for (let n = 0, placed = 0; n < 400 && placed < 16; n++) {
    const c = { x: rng.int(10, W - 11), y: rng.int(10, H - 11) };
    const d = dist(c, START);
    if (d < 20 || d > 100 || g.get(c.x, c.y) === T.WATER || g.get(c.x, c.y) === T.SHALLOW) continue;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (dx * dx + dy * dy > 10 + rng.int(-2, 2)) continue;
        const t = g.get(c.x + dx, c.y + dy);
        if (t === T.WATER || t === T.SHALLOW) continue;
        g.set(c.x + dx, c.y + dy, rng.chance(0.28) ? T.ORE : rng.chance(0.3) ? T.RUBBLE : T.FLOOR);
      }
    }
    placed++;
  }

  // World border cliff.
  for (let x = 0; x < W; x++) { g.set(x, 0, T.WALL); g.set(x, H - 1, T.WALL); }
  for (let y = 0; y < H; y++) { g.set(0, y, T.WALL); g.set(W - 1, y, T.WALL); }

  // Gate clearing and approach road.
  for (let dy = -7; dy <= 7; dy++) {
    for (let dx = -7; dx <= 7; dx++) {
      if (dx * dx + dy * dy <= 49 && START.y + dy < H - 1) g.set(START.x + dx, START.y + dy, T.GRASS);
    }
  }
  g.rect(74, 140, 76, H - 2, T.ROAD);
  g.rect(74, H - 1, 76, H - 1, T.GATE);

  // ---- Ruins ---------------------------------------------------------------------------------
  const ruins: Ruin[] = [];
  const tryRuin = (minD: number, area: { x0: number; y0: number; x1: number; y1: number }): Ruin | null => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const w = rng.int(7, 11), h = rng.int(7, 10);
      const x0 = rng.int(area.x0, area.x1 - w), y0 = rng.int(area.y0, area.y1 - h);
      const c = { x: x0 + (w >> 1), y: y0 + (h >> 1) };
      if (dist(c, START) < minD) continue;
      if (ruins.some((r) => dist(r.c, c) < 26)) continue;
      let wet = false;
      for (let y = y0 - 1; y <= y0 + h; y++) for (let x = x0 - 1; x <= x0 + w; x++) {
        const t = g.get(x, y);
        if (t === T.WATER || t === T.SHALLOW || t === T.WALL) wet = true;
      }
      if (wet) continue;
      return { x0, y0, x1: x0 + w - 1, y1: y0 + h - 1, c };
    }
    return null;
  };
  const dungeonRuin = tryRuin(80, { x0: 12, y0: 10, x1: W - 12, y1: 60 }) ?? tryRuin(40, { x0: 8, y0: 8, x1: W - 8, y1: H - 30 });
  if (!dungeonRuin) throw new Error('worldgen: could not place dungeon ruin');
  ruins.push(dungeonRuin);
  for (let i = 0; i < 8; i++) {
    const r = tryRuin(30, { x0: 8, y0: 8, x1: W - 8, y1: H - 24 });
    if (r) ruins.push(r);
  }
  for (const r of ruins) {
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const edge = x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1;
        g.set(x, y, edge ? (rng.chance(0.25) ? T.RUBBLE : T.RUIN_WALL) : rng.chance(0.15) ? T.RUBBLE : T.FLOOR);
      }
    }
    // Two entrance gaps (north/south) so ruins are enterable.
    for (let k = 0; k < 2; k++) {
      g.set(r.c.x + k, r.y0, T.RUBBLE);
      g.set(r.c.x - k, r.y1, T.RUBBLE);
    }
  }
  const stairsDown = { ...dungeonRuin.c };
  g.set(stairsDown.x, stairsDown.y, T.STAIRS_DOWN);

  // ---- Roads (A* with water bridges) ----------------------------------------------------------
  const roadCost = (x: number, y: number): number => {
    const t = g.get(x, y);
    const j = 1.1 + 0.4 * jitter.noise(x * 0.2, y * 0.2);
    switch (t) {
      case T.ROAD: case T.BRIDGE: return 0.5;
      case T.WATER: return 7 * j;
      case T.SHALLOW: return 3 * j;
      case T.TREE: return 5 * j;
      case T.ORE: return 8 * j;
      case T.RUIN_WALL: return 6 * j;
      default: return j;
    }
  };
  const carveRoad = (from: Vec2, to: Vec2): void => {
    const path = findPath(W, H, from, to, (x, y) => {
      const t = g.get(x, y);
      return t !== T.WALL && t !== T.VOID && t !== T.GATE;
    }, { maxNodes: 60000, cost: roadCost });
    if (!path) return;
    for (const p of path) {
      const t = g.get(p.x, p.y);
      if (t === T.STAIRS_DOWN || t === T.GATE) continue;
      g.set(p.x, p.y, t === T.WATER ? T.BRIDGE : t === T.SHALLOW ? T.SHALLOW : T.ROAD);
    }
  };
  const roadStart = { x: 75, y: 140 };
  carveRoad(roadStart, { x: stairsDown.x, y: stairsDown.y + 1 });
  for (const r of ruins.slice(1)) carveRoad(roadStart, { x: r.c.x, y: r.y1 });
  g.set(stairsDown.x, stairsDown.y, T.STAIRS_DOWN);

  // ---- Links ---------------------------------------------------------------------------------
  const links = new Map<number, Link>();
  for (let x = 74; x <= 76; x++) links.set(g.idx(x, H - 1), { zone: 'oakhaven', x: 40 + (x - 75), y: 2 });

  // ---- Monster camps -------------------------------------------------------------------------
  const reach = floodReachable(g, START);
  const spawnable = (x: number, y: number): boolean => {
    const t = g.get(x, y);
    return reach[g.idx(x, y)] === 1 && (t === T.GRASS || t === T.FLOOR || t === T.SAND || t === T.RUBBLE);
  };
  const table = ZONE_SPAWNS.wilds;
  const pickMonster = (d: number): { monster: MonsterId; level: number } => {
    const lv = Math.max(1, Math.min(11, 1 + Math.floor((d - 20) / 11)));
    const eligible = table.filter((e) => lv >= e.lv[0] - 1 && lv <= e.lv[1] + 3);
    const e = eligible.length ? rng.weighted(eligible, (it) => it.weight) : table[0]!;
    return { monster: e.monster, level: Math.max(1, Math.min(12, lv + rng.int(-1, 1))) };
  };
  const mobs: MobSpawn[] = [];
  const camps: Vec2[] = [];
  const addCamp = (c: Vec2, forced?: MonsterId): void => {
    const pick = pickMonster(dist(c, START));
    const monster = forced ?? pick.monster;
    const n = monster === 'goblin' ? rng.int(2, 3) : rng.int(1, 2);
    const used = new Set<number>();
    for (let i = 0, tries = 0; i < n && tries < 30; tries++) {
      const x = c.x + rng.int(-2, 2), y = c.y + rng.int(-2, 2);
      if (!spawnable(x, y) || used.has(g.idx(x, y))) continue;
      used.add(g.idx(x, y));
      mobs.push({ monster, level: pick.level, x, y });
      i++;
    }
    camps.push(c);
  };
  for (const r of ruins) {
    const c = { x: r.c.x + 1, y: r.c.y + 1 };
    if (spawnable(c.x, c.y)) addCamp(c, 'skeleton');
  }
  for (let attempt = 0; attempt < 6000 && camps.length < 60; attempt++) {
    const c = { x: rng.int(3, W - 4), y: rng.int(3, H - 4) };
    if (!spawnable(c.x, c.y)) continue;
    if (dist(c, START) < 22) continue;
    if (camps.some((o) => dist(o, c) < 9)) continue;
    addCamp(c);
  }

  return {
    id: 'wilds',
    grid: g,
    arrival: { x: 75, y: 145 },
    respawn: { x: 75, y: 145 },
    stairsDown,
    links,
    npcs: [],
    mobs,
  };
}
