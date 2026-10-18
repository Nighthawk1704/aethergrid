import { Rng, hashSeed } from '../../shared/rng';
import { T } from '../../shared/tiles';
import { ZONES } from '../../shared/constants';
import { ZONE_SPAWNS } from '../../shared/gamedata';
import type { Vec2, ZoneId } from '../../shared/types';
import { TileGrid, type MobSpawn, type ZoneData } from './grid';

interface Room { x: number; y: number; w: number; h: number; cx: number; cy: number }
interface Leaf { x: number; y: number; w: number; h: number; a?: Leaf; b?: Leaf; room?: Room }

const MIN_LEAF = 12;
const MAX_LEAF = 26;

const makeRoom = (x: number, y: number, w: number, h: number): Room => ({
  x, y, w, h, cx: x + (w >> 1), cy: y + (h >> 1),
});

function splitLeaf(leaf: Leaf, rng: Rng): boolean {
  if (leaf.a) return false;
  let horizontal = rng.chance(0.5);
  if (leaf.w > leaf.h * 1.25) horizontal = false;
  else if (leaf.h > leaf.w * 1.25) horizontal = true;
  const span = horizontal ? leaf.h : leaf.w;
  if (span < MIN_LEAF * 2) return false;
  const at = rng.int(MIN_LEAF, span - MIN_LEAF);
  if (horizontal) {
    leaf.a = { x: leaf.x, y: leaf.y, w: leaf.w, h: at };
    leaf.b = { x: leaf.x, y: leaf.y + at, w: leaf.w, h: leaf.h - at };
  } else {
    leaf.a = { x: leaf.x, y: leaf.y, w: at, h: leaf.h };
    leaf.b = { x: leaf.x + at, y: leaf.y, w: leaf.w - at, h: leaf.h };
  }
  return true;
}

function leaves(leaf: Leaf, out: Leaf[] = []): Leaf[] {
  if (leaf.a && leaf.b) { leaves(leaf.a, out); leaves(leaf.b, out); } else out.push(leaf);
  return out;
}

function anyRoom(leaf: Leaf, rng: Rng): Room {
  if (leaf.room) return leaf.room;
  return anyRoom(rng.chance(0.5) ? leaf.a! : leaf.b!, rng);
}

/** Breadth-first walking distance (doors count as passable) from a start tile. -1 = unreachable. */
function bfs(g: TileGrid, from: Vec2): Int32Array {
  const dist = new Int32Array(g.w * g.h).fill(-1);
  const queue = [g.idx(from.x, from.y)];
  dist[queue[0]!] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    const cx = cur % g.w, cy = Math.floor(cur / g.w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy;
      if (!g.inBounds(nx, ny) || !g.passable(nx, ny)) continue;
      const ni = ny * g.w + nx;
      if (dist[ni] !== -1) continue;
      dist[ni] = dist[cur]! + 1;
      queue.push(ni);
    }
  }
  return dist;
}

/**
 * One Catacombs floor generated with Binary Space Partitioning: leaves hold rooms, sibling rooms are
 * joined by L-shaped corridors, corridor mouths get doors. Floor 1/2 have `<` and `>`; floor 3 has
 * `<` and a boss arena containing the Ancient Dragon.
 */
export function generateDungeonFloor(seed: number, floor: 1 | 2 | 3): ZoneData {
  const id = `catacombs${floor}` as ZoneId;
  const def = ZONES[id];
  const g = new TileGrid(def.w, def.h, T.VOID);
  const rng = new Rng(hashSeed(seed, 'catacombs', floor));

  // ---- BSP partition ---------------------------------------------------------------------
  const root: Leaf = { x: 1, y: 1, w: def.w - 2, h: def.h - 2 };
  const queue: Leaf[] = [root];
  while (queue.length) {
    const leaf = queue.shift()!;
    if ((leaf.w > MAX_LEAF || leaf.h > MAX_LEAF || rng.chance(0.75)) && splitLeaf(leaf, rng)) queue.push(leaf.a!, leaf.b!);
  }
  const allLeaves = leaves(root);
  const largest = allLeaves.reduce((best, l) => (l.w * l.h > best.w * best.h ? l : best), allLeaves[0]!);

  const rooms: Room[] = [];
  for (const leaf of allLeaves) {
    if (floor === 3 && leaf === largest) {
      leaf.room = makeRoom(leaf.x + 1, leaf.y + 1, leaf.w - 2, leaf.h - 2);
    } else {
      const w = rng.int(5, Math.max(5, leaf.w - 3)), h = rng.int(5, Math.max(5, leaf.h - 3));
      leaf.room = makeRoom(leaf.x + rng.int(1, leaf.w - w - 1), leaf.y + rng.int(1, leaf.h - h - 1), w, h);
    }
    rooms.push(leaf.room);
    g.rect(leaf.room.x, leaf.room.y, leaf.room.x + leaf.room.w - 1, leaf.room.y + leaf.room.h - 1, T.FLOOR);
  }
  const bossRoom = floor === 3 ? largest.room! : null;

  // ---- Corridors -------------------------------------------------------------------------
  const carve = (x: number, y: number): void => { if (g.get(x, y) === T.VOID) g.set(x, y, T.FLOOR); };
  const joinRooms = (leaf: Leaf): void => {
    if (!leaf.a || !leaf.b) return;
    joinRooms(leaf.a); joinRooms(leaf.b);
    const a = anyRoom(leaf.a, rng), b = anyRoom(leaf.b, rng);
    const stepX = (y: number, x0: number, x1: number): void => { for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) carve(x, y); };
    const stepY = (x: number, y0: number, y1: number): void => { for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) carve(x, y); };
    if (rng.chance(0.5)) { stepX(a.cy, a.cx, b.cx); stepY(b.cx, a.cy, b.cy); }
    else { stepY(a.cx, a.cy, b.cy); stepX(b.cy, a.cx, b.cx); }
  };
  joinRooms(root);

  // ---- Doors at corridor mouths ----------------------------------------------------------
  const isFloor = (x: number, y: number): boolean => g.get(x, y) === T.FLOOR;
  for (const r of rooms) {
    const candidates: Vec2[] = [];
    for (let x = r.x; x < r.x + r.w; x++) {
      if (isFloor(x, r.y - 1) && !isFloor(x - 1, r.y - 1) && !isFloor(x + 1, r.y - 1)) candidates.push({ x, y: r.y - 1 });
      if (isFloor(x, r.y + r.h) && !isFloor(x - 1, r.y + r.h) && !isFloor(x + 1, r.y + r.h)) candidates.push({ x, y: r.y + r.h });
    }
    for (let y = r.y; y < r.y + r.h; y++) {
      if (isFloor(r.x - 1, y) && !isFloor(r.x - 1, y - 1) && !isFloor(r.x - 1, y + 1)) candidates.push({ x: r.x - 1, y });
      if (isFloor(r.x + r.w, y) && !isFloor(r.x + r.w, y - 1) && !isFloor(r.x + r.w, y + 1)) candidates.push({ x: r.x + r.w, y });
    }
    for (const c of candidates) if (rng.chance(0.55)) g.set(c.x, c.y, T.DOOR_CLOSED);
  }

  // ---- Stairs ----------------------------------------------------------------------------
  const roomCenter = (r: Room): Vec2 => ({ x: r.cx, y: r.cy });
  const farthestFrom = (from: Room, exclude: Room[]): Room => {
    const d = bfs(g, roomCenter(from));
    let best = rooms[0]!;
    let bestD = -1;
    for (const r of rooms) {
      if (exclude.includes(r)) continue;
      const rd = d[g.idx(r.cx, r.cy)]!;
      if (rd > bestD) { bestD = rd; best = r; }
    }
    return best;
  };
  let upRoom: Room, downRoom: Room | null = null;
  if (bossRoom) {
    upRoom = farthestFrom(bossRoom, [bossRoom]);
  } else {
    upRoom = rng.pick(rooms);
    downRoom = farthestFrom(upRoom, [upRoom]);
  }
  const stairsUp = roomCenter(upRoom);
  g.set(stairsUp.x, stairsUp.y, T.STAIRS_UP);
  let stairsDown: Vec2 | undefined;
  if (downRoom) {
    stairsDown = roomCenter(downRoom);
    g.set(stairsDown.x, stairsDown.y, T.STAIRS_DOWN);
  }

  // ---- Flooded pools and rubble ----------------------------------------------------------
  for (const r of rooms) {
    if (r === upRoom || r === downRoom || r === bossRoom) continue;
    if (r.w >= 9 && r.h >= 9 && rng.chance(0.4)) {
      const rr = Math.min(r.w, r.h) / 2 - 2;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
        const d = Math.hypot(x - r.cx, y - r.cy);
        if (d <= rr - 1.2) g.set(x, y, T.WATER);
        else if (d <= rr) g.set(x, y, T.SHALLOW);
      }
    }
  }
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    if (g.get(x, y) === T.FLOOR && rng.chance(0.03)) g.set(x, y, T.RUBBLE);
  }

  // ---- Walls around everything walkable --------------------------------------------------
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const t = g.get(x, y);
    if (t === T.VOID || t === T.WALL) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (g.get(x + dx, y + dy) === T.VOID && g.inBounds(x + dx, y + dy)) g.set(x + dx, y + dy, T.WALL);
    }
  }

  // ---- Monsters --------------------------------------------------------------------------
  const table = ZONE_SPAWNS[id];
  const mobs: MobSpawn[] = [];
  const taken = new Set<number>();
  for (const r of rooms) {
    if (r === upRoom) continue;
    const count = r === bossRoom ? 4 : Math.max(1, Math.min(4, Math.floor((r.w * r.h) / 28) + rng.int(0, 1)));
    for (let i = 0, tries = 0; i < count && tries < 40; tries++) {
      const x = rng.int(r.x, r.x + r.w - 1), y = rng.int(r.y, r.y + r.h - 1);
      const t = g.get(x, y);
      if ((t !== T.FLOOR && t !== T.RUBBLE) || taken.has(g.idx(x, y))) continue;
      if (bossRoom && r === bossRoom && Math.hypot(x - r.cx, y - r.cy) < 3) continue;
      taken.add(g.idx(x, y));
      const e = rng.weighted(table, (it) => it.weight);
      mobs.push({ monster: e.monster, level: rng.int(e.lv[0], e.lv[1]), x, y });
      i++;
    }
  }
  if (bossRoom) mobs.push({ monster: 'dragon', level: 20, x: bossRoom.cx, y: bossRoom.cy });

  return {
    id,
    grid: g,
    arrival: stairsUp,
    respawn: stairsUp,
    stairsUp,
    stairsDown,
    links: new Map(),
    npcs: [],
    mobs,
  };
}
