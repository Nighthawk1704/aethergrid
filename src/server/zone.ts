import type { ZoneDef } from '../shared/constants';
import { ZONES } from '../shared/constants';
import { isWalkable } from '../shared/tiles';
import type { FxEvent, ZoneId } from '../shared/types';
import { Actor, Loot, Monster, Npc, Player } from './entities';
import { TileGrid, type ZoneData } from './world';

export interface TileChange { idx: number; t: number }

/** Mutable runtime state of one zone: live grid, entities, spatial index, per-tick event buffers. */
export class ZoneRuntime {
  readonly def: ZoneDef;
  readonly grid: TileGrid;
  readonly players = new Map<number, Player>();
  readonly monsters: Monster[] = [];
  readonly npcs: Npc[] = [];
  readonly loot = new Map<number, Loot>();
  private readonly occupant = new Map<number, Actor>();
  private readonly lootAt = new Map<number, Loot>();
  /** Tile mutations since the last sync (doors, harvested resources). */
  tileChanges: TileChange[] = [];
  fx: FxEvent[] = [];
  /** idx -> tick at which an opened door should close again. */
  readonly doorTimers = new Map<number, number>();
  /** Harvested resource tiles waiting to regrow. */
  readonly regrow: { idx: number; tile: number; at: number }[] = [];

  constructor(readonly id: ZoneId, readonly data: ZoneData) {
    this.def = ZONES[id];
    this.grid = new TileGrid(data.grid.w, data.grid.h);
    this.grid.tiles.set(data.grid.tiles);
  }

  get active(): boolean { return this.players.size > 0; }

  // ---- Actors ------------------------------------------------------------------------------
  addActor(a: Actor, x: number, y: number): void {
    a.zone = this;
    a.x = x;
    a.y = y;
    this.occupant.set(this.grid.idx(x, y), a);
    if (a instanceof Player) this.players.set(a.id, a);
  }

  removeActor(a: Actor): void {
    const i = this.grid.idx(a.x, a.y);
    if (this.occupant.get(i) === a) this.occupant.delete(i);
    if (a instanceof Player) this.players.delete(a.id);
  }

  moveActor(a: Actor, x: number, y: number): void {
    const from = this.grid.idx(a.x, a.y);
    if (this.occupant.get(from) === a) this.occupant.delete(from);
    a.x = x;
    a.y = y;
    this.occupant.set(this.grid.idx(x, y), a);
  }

  actorAt(x: number, y: number): Actor | undefined {
    return this.occupant.get(this.grid.idx(x, y));
  }

  /** Terrain-walkable and nobody standing there. */
  isFree(x: number, y: number): boolean {
    return this.grid.inBounds(x, y) && isWalkable(this.grid.get(x, y)) && !this.occupant.has(this.grid.idx(x, y));
  }

  /** Free for path planning: closed doors count as passable, occupied tiles do not. */
  planFree(x: number, y: number): boolean {
    return this.grid.passable(x, y) && !this.occupant.has(this.grid.idx(x, y));
  }

  /** Living actors (any kind) within Chebyshev distance `r` of a point. */
  actorsNear(x: number, y: number, r: number): Actor[] {
    const out: Actor[] = [];
    for (let yy = y - r; yy <= y + r; yy++) {
      for (let xx = x - r; xx <= x + r; xx++) {
        const a = this.occupant.get(this.grid.idx(xx, yy));
        if (a && !a.dead && this.grid.inBounds(xx, yy)) out.push(a);
      }
    }
    return out;
  }

  /** Nearest tile (spiral) that satisfies `ok`, starting at x,y. */
  findNear(x: number, y: number, ok: (x: number, y: number) => boolean, maxR = 6): { x: number; y: number } | null {
    for (let r = 0; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (ok(x + dx, y + dy)) return { x: x + dx, y: y + dy };
        }
      }
    }
    return null;
  }

  // ---- Tiles -------------------------------------------------------------------------------
  setTile(x: number, y: number, t: number): void {
    if (!this.grid.inBounds(x, y) || this.grid.get(x, y) === t) return;
    this.grid.set(x, y, t);
    this.tileChanges.push({ idx: this.grid.idx(x, y), t });
    for (const p of this.players.values()) p.fovDirty = true;
  }

  // ---- Loot --------------------------------------------------------------------------------
  lootOn(x: number, y: number): Loot | undefined {
    return this.lootAt.get(this.grid.idx(x, y));
  }
  addLoot(l: Loot): void {
    this.loot.set(l.id, l);
    this.lootAt.set(this.grid.idx(l.x, l.y), l);
  }
  removeLoot(l: Loot): void {
    this.loot.delete(l.id);
    const i = this.grid.idx(l.x, l.y);
    if (this.lootAt.get(i) === l) this.lootAt.delete(i);
  }

  emitFx(x: number, y: number, text: string, kind: FxEvent['kind']): void {
    if (this.players.size > 0) this.fx.push({ x, y, text, kind });
  }
}
