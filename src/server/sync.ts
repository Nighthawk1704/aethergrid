// Per-player state replication: FOV, delta-compressed tiles, entity spawn/update/despawn, self state.
import { computeFov, indicesToSpans } from '../shared/fov';
import { xpForLevel } from '../shared/gamedata';
import type { ServerPacket, TileRun } from '../shared/protocol';
import { tileCode } from '../shared/tiles';
import type { EntityDelta, SelfState, WireEntity, FxEvent } from '../shared/types';
import { Loot, Monster, Npc, Player, type Actor } from './entities';
import type { Game } from './game';

type StatePacket = Extract<ServerPacket, { t: 'state' }>;

/** Character cells are ~2x taller than wide; stretching sight horizontally makes it look circular. */
export const FOV_ASPECT = 2;

const WIRE_KEYS: (keyof WireEntity)[] = ['x', 'y', 'n', 't', 'hp', 'mhp', 'lv', 'fl'];

function knownMap(p: Player): Uint8Array {
  const id = p.zone.def.id;
  let k = p.known.get(id);
  if (!k) { k = new Uint8Array(p.zone.grid.w * p.zone.grid.h); p.known.set(id, k); }
  return k;
}

/** Recompute the player's field of view and return changed tile runs plus the visibility spans. */
function updateView(p: Player): { tiles: TileRun[]; vis?: number[] } {
  const z = p.zone;
  const g = z.grid;
  const known = knownMap(p);
  const list = computeFov(p.x, p.y, z.def.fov, g.w, g.h, (x, y) => g.opaque(x, y), FOV_ASPECT);

  // Tiles whose remembered value differs from reality (new or mutated) are sent, grouped into row runs.
  const tiles: TileRun[] = [];
  let run: { y: number; x: number; s: string; next: number } | null = null;
  for (const idx of list) {
    const actual = g.tiles[idx]! + 1;
    if (known[idx] === actual) { if (run) { tiles.push([run.y, run.x, run.s]); run = null; } continue; }
    known[idx] = actual;
    const y = Math.floor(idx / g.w), x = idx - y * g.w;
    if (run && run.y === y && run.next === x) { run.s += tileCode(actual - 1); run.next++; }
    else {
      if (run) tiles.push([run.y, run.x, run.s]);
      run = { y, x, s: tileCode(actual - 1), next: x + 1 };
    }
  }
  if (run) tiles.push([run.y, run.x, run.s]);

  const prev = p.visList;
  let same = prev.length === list.length;
  for (let i = 0; same && i < list.length; i++) if (prev[i] !== list[i]) same = false;
  p.visList = list;
  p.visSet = new Set(list);
  p.fovDirty = false;
  return same ? { tiles } : { tiles, vis: indicesToSpans(list, g.w) };
}

function visibleTo(p: Player, a: Actor): boolean {
  if (a.dead) return false;
  if (!p.visSet.has(p.zone.grid.idx(a.x, a.y))) return false;
  if (a instanceof Player && a.stealthed && a !== p) {
    return a.partyId !== 0 && a.partyId === p.partyId || a.dist(p) <= 2;
  }
  return true;
}

function diffWire(prev: WireEntity, next: WireEntity): EntityDelta | null {
  let d: EntityDelta | null = null;
  for (const k of WIRE_KEYS) {
    if (prev[k] !== next[k]) {
      d ??= { id: next.id };
      (d as Record<string, unknown>)[k] = next[k];
    }
  }
  return d;
}

function diffSelf(p: Player, s: SelfState): Partial<SelfState> | null {
  const out: Record<string, unknown> = {};
  let any = false;
  const put = (k: string, v: unknown, sig: string): void => {
    if (p.lastSelf[k] === sig && !p.forceSelf) return;
    p.lastSelf[k] = sig;
    out[k] = v;
    any = true;
  };
  const scalars = ['id', 'name', 'cls', 'lv', 'xp', 'xpNext', 'hp', 'mp', 'gold', 'x', 'y', 'zone', 'target', 'pvp', 'partyId'] as const;
  for (const k of scalars) put(k, s[k], String(s[k]));
  put('stats', s.stats, JSON.stringify(s.stats));

  // Cooldowns and buffs tick down on the client, so only resend when a timer is (re)started or cleared.
  let cdChanged = p.forceSelf;
  for (let i = 0; i < 4; i++) {
    if (p.cd[i]! > p.cdSent[i]! || (p.cd[i] === 0 && p.cdSent[i]! > 0)) cdChanged = true;
  }
  if (cdChanged) { p.cdSent = [...p.cd] as typeof p.cdSent; out.cd = [...p.cd]; any = true; }
  else for (let i = 0; i < 4; i++) p.cdSent[i] = Math.max(0, p.cdSent[i]! - 1);

  let buffChanged = p.forceSelf || p.buffSent.size !== p.buffs.size;
  for (const [id, b] of p.buffs) {
    const sent = p.buffSent.get(id);
    if (sent === undefined || b.ticks > sent) buffChanged = true;
  }
  if (buffChanged) {
    p.buffSent = new Map([...p.buffs].map(([id, b]) => [id, b.ticks]));
    out.buffs = p.buffViews();
    any = true;
  } else for (const [id, t] of p.buffSent) p.buffSent.set(id, Math.max(0, t - 1));

  return any ? (out as Partial<SelfState>) : null;
}

export function syncPlayer(game: Game, p: Player): void {
  const z = p.zone;
  const pkt: StatePacket = { t: 'state', s: 0, tick: game.tick, ack: p.session.lastClientSeq };
  let dirty = false;

  const you = diffSelf(p, p.selfState(xpForLevel(p.level)));
  if (you) { pkt.you = you; dirty = true; }
  p.forceSelf = false;

  if (p.fovDirty) {
    const { tiles, vis } = updateView(p);
    if (tiles.length) { pkt.tiles = tiles; dirty = true; }
    if (vis) { pkt.vis = vis; dirty = true; }
  }

  // Entities in view.
  const seen = new Set<number>();
  const spawn: WireEntity[] = [];
  const update: EntityDelta[] = [];
  const consider = (id: number, wire: () => WireEntity): void => {
    seen.add(id);
    const w = wire();
    const prev = p.sent.get(id);
    if (!prev) { spawn.push(w); p.sent.set(id, w); return; }
    const d = diffWire(prev, w);
    if (d) { update.push(d); p.sent.set(id, w); }
  };
  for (const o of z.players.values()) if (o !== p && visibleTo(p, o)) consider(o.id, () => o.toWire(p.partyId));
  for (const m of z.monsters) if (visibleTo(p, m)) consider(m.id, () => (m as Monster).toWire());
  for (const n of z.npcs) if (visibleTo(p, n)) consider(n.id, () => (n as Npc).toWire());
  for (const l of z.loot.values()) if (p.visSet.has(z.grid.idx(l.x, l.y))) consider(l.id, () => (l as Loot).toWire());
  const despawn: number[] = [];
  for (const id of p.sent.keys()) if (!seen.has(id)) despawn.push(id);
  for (const id of despawn) p.sent.delete(id);
  if (spawn.length) { pkt.spawn = spawn; dirty = true; }
  if (update.length) { pkt.update = update; dirty = true; }
  if (despawn.length) { pkt.despawn = despawn; dirty = true; }

  if (z.fx.length) {
    const fx: FxEvent[] = z.fx.filter((e) => p.visSet.has(z.grid.idx(e.x, e.y)));
    if (fx.length) { pkt.fx = fx; dirty = true; }
  }

  if (dirty) game.send(p.session, pkt);
}
