import { T, isOpaque, isWalkable } from '../../shared/tiles';
import type { MonsterId, Vec2, ZoneId } from '../../shared/types';

export class TileGrid {
  readonly tiles: Uint8Array;
  constructor(readonly w: number, readonly h: number, fill: number = T.VOID) {
    this.tiles = new Uint8Array(w * h).fill(fill);
  }
  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  get(x: number, y: number): number {
    return this.inBounds(x, y) ? this.tiles[y * this.w + x]! : T.VOID;
  }
  set(x: number, y: number, t: number): void {
    if (this.inBounds(x, y)) this.tiles[y * this.w + x] = t;
  }
  rect(x0: number, y0: number, x1: number, y1: number, t: number): void {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, t);
  }
  walkable(x: number, y: number): boolean {
    return isWalkable(this.get(x, y));
  }
  /** Walkable for planning purposes: closed doors can be opened by the mover. */
  passable(x: number, y: number): boolean {
    const t = this.get(x, y);
    return isWalkable(t) || t === T.DOOR_CLOSED;
  }
  opaque(x: number, y: number): boolean {
    return !this.inBounds(x, y) || isOpaque(this.get(x, y));
  }
  idx(x: number, y: number): number {
    return y * this.w + x;
  }
}

export interface MobSpawn { monster: MonsterId; level: number; x: number; y: number }
export interface NpcSpawn { npc: string; x: number; y: number }
export interface Link { zone: ZoneId; x: number; y: number }

export interface ZoneData {
  id: ZoneId;
  grid: TileGrid;
  /** Where new arrivals without a link land. */
  arrival: Vec2;
  /** Where dead players respawn. */
  respawn: Vec2;
  stairsUp?: Vec2;
  stairsDown?: Vec2;
  /** Tile index -> destination, for GATE / stairs tiles. */
  links: Map<number, Link>;
  npcs: NpcSpawn[];
  mobs: MobSpawn[];
}

export interface World {
  seed: number;
  zones: Record<ZoneId, ZoneData>;
}

/** Tiles reachable from `from` by 8-way walking (no corner cutting). */
export function floodReachable(grid: TileGrid, from: Vec2, extraBlocked?: (x: number, y: number) => boolean): Uint8Array {
  const seen = new Uint8Array(grid.w * grid.h);
  const stack: number[] = [grid.idx(from.x, from.y)];
  seen[stack[0]!] = 1;
  const ok = (x: number, y: number): boolean => grid.passable(x, y) && !(extraBlocked?.(x, y));
  while (stack.length) {
    const cur = stack.pop()!;
    const cx = cur % grid.w, cy = Math.floor(cur / grid.w);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (!grid.inBounds(nx, ny) || !ok(nx, ny)) continue;
        if (dx && dy && (!ok(cx + dx, cy) || !ok(cx, cy + dy))) continue;
        const ni = ny * grid.w + nx;
        if (seen[ni]) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
  }
  return seen;
}
