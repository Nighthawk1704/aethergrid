// Per-tick player logic: cooldowns, buffs, regen, queued input (skills, interaction, movement).
import { secs } from '../shared/constants';
import { T } from '../shared/tiles';
import { basicAttack, castSkill, heal, isHostile, meleeBlocked } from './combat';
import { checkWindowRange, talkTo, openBank, openQuests, addItem } from './economy';
import { Npc, Player, type Actor } from './entities';
import type { Game } from './game';
import { makeMaterial } from './items';

const TREE_REGROW = secs(60);
const ORE_REGROW = secs(90);

export function updatePlayer(game: Game, p: Player): void {
  if (p.moveCd > 0) p.moveCd--;
  if (p.atkCd > 0) p.atkCd--;
  if (p.harvestCd > 0) p.harvestCd--;
  for (let i = 0; i < 4; i++) if (p.cd[i]! > 0) p.cd[i]!--;

  tickBuffs(game, p);
  regen(game, p);
  validateTarget(game, p);

  // Skills first (they are the time-critical inputs), then use/interact, then movement.
  if (p.pendingSkills.length) {
    const keep: typeof p.pendingSkills = [];
    for (const ps of p.pendingSkills) {
      if (ps.until < game.tick) continue;
      if (castSkill(game, p, ps.slot) === 'wait') keep.push(ps);
    }
    p.pendingSkills = keep;
  }
  if (p.wantStairs) { useStairs(game, p, p.wantStairs); p.wantStairs = null; }
  if (p.wantInteract) { p.wantInteract = false; interact(game, p); }

  const mv = p.pendingMove;
  if (mv) {
    if (mv.until < game.tick || tryMove(game, p, mv.dx, mv.dy)) p.pendingMove = null;
  }

  if ((game.tick + p.id) % 10 === 0) checkWindowRange(game, p);
}

function tickBuffs(game: Game, p: Player): void {
  for (const [id, b] of p.buffs) {
    if (id === 'regen' && game.tick % 10 === 0) heal(game, p, Math.ceil(p.maxHp * b.power));
    if (--b.ticks <= 0) {
      p.buffs.delete(id);
      if (id === 'might') p.recalc();
      if (id === 'stealth') game.sys(p, 'You reappear.');
    }
  }
}

function regen(game: Game, p: Player): void {
  if (game.tick % 10 !== 0) return;
  const calm = game.tick >= p.combatUntil;
  const town = p.zone.def.id === 'oakhaven';
  if (p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + Math.ceil(p.maxHp * (calm ? (town ? 0.05 : 0.012) : 0)));
  if (p.mp < p.stats.maxMp) p.mp = Math.min(p.stats.maxMp, p.mp + Math.ceil(p.stats.maxMp * (calm ? (town ? 0.06 : 0.02) : 0.005)));
}

function validateTarget(game: Game, p: Player): void {
  if (!p.target) return;
  const t = game.actorById(p.target);
  if (!t || t.dead || t.zone !== p.zone || p.dist(t) > 14 || !p.visSet.has(p.zone.grid.idx(t.x, t.y))) p.target = 0;
}

/** Tab: lock the next visible hostile (nearest first), or clear. */
export function cycleTarget(game: Game, p: Player, clear: boolean): void {
  if (clear) { p.target = 0; return; }
  const z = p.zone;
  const cands: Actor[] = [];
  for (const m of z.monsters) if (!m.dead && p.dist(m) <= 12 && p.visSet.has(z.grid.idx(m.x, m.y))) cands.push(m);
  for (const o of z.players.values()) if (o !== p && isHostile(p, o) && p.dist(o) <= 12 && p.visSet.has(z.grid.idx(o.x, o.y))) cands.push(o);
  if (!cands.length) { p.target = 0; game.sys(p, 'No targets in sight.'); return; }
  cands.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  const i = cands.findIndex((c) => c.id === p.target);
  p.target = cands[(i + 1) % cands.length]!.id;
}

// ---- Movement ---------------------------------------------------------------------------------
/** Returns true when the queued move has been consumed, false when it should wait for a cooldown. */
function tryMove(game: Game, p: Player, dx: number, dy: number): boolean {
  if (p.stunned) return false;
  if (!dx && !dy) return true;
  const z = p.zone;
  const g = z.grid;
  const nx = p.x + dx, ny = p.y + dy;
  p.faceX = dx;
  p.faceY = dy;
  if (p.rooted) return true;
  if (!g.inBounds(nx, ny)) return true;

  const occ = z.actorAt(nx, ny);
  if (occ) {
    if (occ instanceof Npc) {
      if (p.moveCd > 0) return false;
      p.moveCd = 3;
      talkTo(game, p, occ);
      return true;
    }
    if (isHostile(p, occ)) {
      if (meleeBlocked(z, p.x, p.y, nx, ny)) return true; // cannot swing around a solid corner
      if (p.atkCd > 0) return false;
      basicAttack(game, p, occ);
      return true;
    }
    return true; // blocked by a friendly player
  }
  if (p.moveCd > 0) return false;

  const tile = g.get(nx, ny);
  if (tile === T.DOOR_CLOSED) {
    game.openDoor(z, nx, ny);
    p.moveCd = 2;
    return true;
  }
  if (tile === T.TREE || tile === T.ORE) {
    harvest(game, p, nx, ny);
    return true;
  }
  if (tile === T.BANK) { p.moveCd = 3; openBank(game, p); return true; }
  if (tile === T.BOARD) { p.moveCd = 3; openQuests(game, p); return true; }
  if (!g.walkable(nx, ny)) return true;
  // No cutting corners around walls.
  if (dx && dy && (!g.passable(p.x + dx, p.y) || !g.passable(p.x, p.y + dy))) return true;

  z.moveActor(p, nx, ny);
  p.fovDirty = true;
  p.moveCd = p.moveTicks;
  afterStep(game, p);
  return true;
}

function afterStep(game: Game, p: Player): void {
  const z = p.zone;
  const tile = z.grid.get(p.x, p.y);
  if (tile === T.GATE) {
    const link = z.data.links.get(z.grid.idx(p.x, p.y));
    if (link) {
      game.transfer(p, link.zone, link.x, link.y);
      return;
    }
  }
  const loot = z.lootOn(p.x, p.y);
  if (loot) {
    if (!loot.item) game.pickup(p, loot);
    else game.sys(p, `You see ${loot.name} here. Press E to pick it up.`);
  }
  if (tile === T.STAIRS_DOWN) game.sys(p, 'Stairs lead down. Press > to descend.');
  else if (tile === T.STAIRS_UP) game.sys(p, 'Stairs lead up. Press < to ascend.');
}

// ---- Interaction ------------------------------------------------------------------------------
function harvest(game: Game, p: Player, x: number, y: number): void {
  if (p.harvestCd > 0) return;
  const z = p.zone;
  const tile = z.grid.get(x, y);
  const tree = tile === T.TREE;
  const item = makeMaterial(tree ? 'wood' : 'iron_ore', 1 + (game.rng.chance(0.25) ? 1 : 0));
  if (!addItem(game, p, item)) { game.sys(p, 'Your inventory is full.'); return; }
  p.harvestCd = secs(0.8);
  p.atkCd = Math.max(p.atkCd, 4);
  z.setTile(x, y, tree ? T.STUMP : T.RUBBLE);
  z.regrow.push({ idx: z.grid.idx(x, y), tile, at: game.tick + (tree ? TREE_REGROW : ORE_REGROW) + game.rng.int(0, secs(20)) });
  z.emitFx(x, y, `+${item.qty}`, 'info');
  game.sys(p, tree ? `You chop the tree: ${item.qty}x ${item.name}.` : `You mine the vein: ${item.qty}x ${item.name}.`);
}

function interact(game: Game, p: Player): void {
  const z = p.zone;
  // 1. Loot underfoot or adjacent.
  const here = z.lootOn(p.x, p.y);
  if (here) return game.pickup(p, here);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const l = z.lootOn(p.x + dx, p.y + dy);
    if (l) return game.pickup(p, l);
  }
  // 2. NPCs.
  for (const n of z.npcs) if (p.dist(n) <= 1) return talkTo(game, p, n);
  // 3. Special tiles and doors, facing direction first.
  const order: [number, number][] = [[p.faceX, p.faceY]];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) order.push([dx, dy]);
  for (const [dx, dy] of order) {
    const x = p.x + dx, y = p.y + dy;
    switch (z.grid.get(x, y)) {
      case T.BANK: return openBank(game, p);
      case T.BOARD: return openQuests(game, p);
      case T.DOOR_CLOSED: game.openDoor(z, x, y); return;
      case T.DOOR_OPEN:
        if (!z.actorAt(x, y) && !z.lootOn(x, y)) { z.setTile(x, y, T.DOOR_CLOSED); z.doorTimers.delete(z.grid.idx(x, y)); return; }
        break;
      case T.TREE: case T.ORE: return harvest(game, p, x, y);
    }
  }
  game.sys(p, 'There is nothing to interact with here.');
}

function useStairs(game: Game, p: Player, dir: 'up' | 'down'): void {
  const z = p.zone;
  const tile = z.grid.get(p.x, p.y);
  const ok = (dir === 'down' && tile === T.STAIRS_DOWN) || (dir === 'up' && tile === T.STAIRS_UP);
  const link = ok ? z.data.links.get(z.grid.idx(p.x, p.y)) : undefined;
  if (!link) { game.sys(p, dir === 'down' ? 'There are no stairs down here.' : 'There are no stairs up here.'); return; }
  game.transfer(p, link.zone, link.x, link.y);
}
