// Monster AI state machine: IDLE -> PATROL -> AGGRO (A* chase) -> FLEE (cowards) -> RESPAWN.
import { secs } from '../shared/constants';
import { hasLos } from '../shared/fov';
import { findPath } from '../shared/path';
import { T } from '../shared/tiles';
import type { Vec2 } from '../shared/types';
import { applyDamage, meleeBlocked, strike } from './combat';
import { Monster, Player } from './entities';
import type { Game } from './game';

const SCAN_EVERY = 4;
const REPLAN_EVERY = secs(0.6);
const LOSE_SIGHT_AFTER = secs(4);
/** Give up on a target we cannot path to (e.g. across a river) after this long. */
const UNREACHABLE_AFTER = secs(6);
const GIVE_UP_COOLDOWN = secs(8);

export function updateMonster(game: Game, m: Monster): void {
  const z = m.zone;
  if (m.dead) {
    if (game.tick >= m.respawnAt) respawn(game, m);
    return;
  }
  // Tick-based bookkeeping.
  if (m.moveCd > 0) m.moveCd--;
  if (m.atkCd > 0) m.atkCd--;
  if (m.specialCd > 0) m.specialCd--;
  tickBuffs(m);
  if (m.breath) resolveBreath(game, m);

  // Out-of-combat regeneration.
  if (m.state !== 'AGGRO' && game.tick % 10 === 0 && m.hp < m.maxHp) m.hp = Math.min(m.maxHp, m.hp + Math.ceil(m.maxHp * (m.state === 'FLEE' ? 0.01 : 0.04)));

  if (m.stunned) return;

  switch (m.state) {
    case 'IDLE': return idle(game, m);
    case 'PATROL': return patrol(game, m);
    case 'AGGRO': return aggro(game, m);
    case 'FLEE': return flee(game, m);
    case 'RESPAWN': return;
  }
  void z;
}

function tickBuffs(m: Monster): void {
  for (const [id, b] of m.buffs) {
    if (--b.ticks <= 0) m.buffs.delete(id);
  }
}

function respawn(game: Game, m: Monster): void {
  const z = m.zone;
  const spot = z.findNear(m.home.x, m.home.y, (x, y) => z.isFree(x, y), 5);
  if (!spot) { m.respawnAt = game.tick + secs(5); return; }
  // Do not respawn on top of a player's face.
  m.hp = m.maxHp;
  m.dead = false;
  m.state = 'IDLE';
  m.idleUntil = game.tick + secs(2);
  m.enraged = false;
  m.threat.clear();
  m.targetId = 0;
  z.addActor(m, spot.x, spot.y);
}

// ---- Perception -------------------------------------------------------------------------------
function canSee(m: Monster, p: Player): boolean {
  if (p.dead) return false;
  const d = m.dist(p);
  if (d > m.def.sight) return false;
  if (p.stealthed && d > 1) return false;
  const z = m.zone;
  return hasLos(m.x, m.y, p.x, p.y, (x, y) => z.grid.opaque(x, y));
}

function nearestVisiblePlayer(m: Monster): Player | null {
  let best: Player | null = null;
  let bd = Infinity;
  for (const p of m.zone.players.values()) {
    if (!canSee(m, p)) continue;
    const d = Math.hypot(p.x - m.x, p.y - m.y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// ---- States -----------------------------------------------------------------------------------
function idle(game: Game, m: Monster): void {
  if ((game.tick + m.id) % SCAN_EVERY === 0 && game.tick >= m.noAggroUntil) {
    const p = nearestVisiblePlayer(m);
    if (p) return game.aggroMonster(m, p);
  }
  if (game.tick < m.idleUntil) return;
  // Wander to a nearby point around home most of the time.
  if (game.rng.chance(0.55)) {
    for (let i = 0; i < 6; i++) {
      const dest = { x: m.home.x + game.rng.int(-5, 5), y: m.home.y + game.rng.int(-5, 5) };
      if (!m.zone.isFree(dest.x, dest.y) || (dest.x === m.x && dest.y === m.y)) continue;
      if (planTo(game, m, dest) === 'ok') { m.state = 'PATROL'; return; }
    }
  }
  m.idleUntil = game.tick + game.rng.int(secs(2), secs(6));
}

function patrol(game: Game, m: Monster): void {
  if ((game.tick + m.id) % SCAN_EVERY === 0 && game.tick >= m.noAggroUntil) {
    const p = nearestVisiblePlayer(m);
    if (p) return game.aggroMonster(m, p);
  }
  if (!m.path.length) { m.state = 'IDLE'; m.idleUntil = game.tick + game.rng.int(secs(2), secs(5)); return; }
  followPath(game, m);
}

function aggro(game: Game, m: Monster): void {
  const z = m.zone;
  let target = z.players.get(m.targetId) ?? null;
  if (!target || target.dead) target = retarget(m);
  if (!target) return disengage(game, m);

  const sees = canSee(m, target);
  if (sees) m.lostSightSince = 0;
  else if (!m.lostSightSince) m.lostSightSince = game.tick;
  if (m.lostSightSince && game.tick - m.lostSightSince > LOSE_SIGHT_AFTER && m.dist(target) > 1) {
    // Maybe another player is in view before giving up.
    const other = nearestVisiblePlayer(m);
    if (other) { m.targetId = other.id; m.lostSightSince = 0; } else return disengage(game, m);
  }
  if (Math.max(Math.abs(m.x - m.home.x), Math.abs(m.y - m.home.y)) > m.leash) return disengage(game, m);

  // Cowards run when badly hurt.
  if (m.def.coward && m.hp < m.maxHp * 0.15) {
    m.state = 'FLEE';
    m.fleeUntil = game.tick + secs(12);
    m.path = [];
    z.emitFx(m.x, m.y, '!', 'info');
    return;
  }

  const d = m.dist(target);
  // Dragon: telegraphed fire breath.
  if (m.def.boss && !m.breath && m.specialCd <= 0 && d >= 2 && d <= 7 && sees) {
    m.breath = { at: game.tick + secs(0.9), x: target.x, y: target.y };
    m.specialCd = secs(7);
    game.broadcastZone(z, `The ${m.name} inhales deeply...`);
    return;
  }

  if (d <= 1 && !meleeBlocked(z, m.x, m.y, target.x, target.y)) {
    m.faceX = Math.sign(target.x - m.x);
    m.faceY = Math.sign(target.y - m.y);
    if (m.atkCd <= 0) {
      m.atkCd = m.def.attackTicks;
      strike(game, m, target, { kind: 'phys', mult: 1, label: 'hit' });
    }
    return;
  }
  if (m.rooted || m.moveCd > 0) return;
  chase(game, m, target);
}

function retarget(m: Monster): Player | null {
  // Highest threat among players still around, else nearest visible.
  let best: Player | null = null;
  let bt = 0;
  for (const [id, t] of m.threat) {
    const p = m.zone.players.get(id);
    if (p && !p.dead && t > bt && m.dist(p) <= m.def.sight + 3 && !(p.stealthed && m.dist(p) > 1)) { best = p; bt = t; }
  }
  const t = best ?? nearestVisiblePlayer(m);
  if (t) m.targetId = t.id;
  return t;
}

function disengage(game: Game, m: Monster): void {
  m.noAggroUntil = game.tick + GIVE_UP_COOLDOWN;
  m.unreachableSince = 0;
  m.targetId = 0;
  m.threat.clear();
  m.lostSightSince = 0;
  m.state = 'PATROL';
  m.path = [];
  if (planTo(game, m, m.home) !== 'ok') { m.state = 'IDLE'; m.idleUntil = game.tick + secs(2); }
}

function flee(game: Game, m: Monster): void {
  const z = m.zone;
  const threat = z.players.get(m.targetId) ?? nearestVisiblePlayer(m);
  if (game.tick >= m.fleeUntil || m.hp >= m.maxHp * 0.4 || !threat) {
    m.state = 'IDLE';
    m.idleUntil = game.tick + secs(3);
    m.targetId = 0;
    return;
  }
  if (m.moveCd > 0) return;
  let best: Vec2 | null = null;
  let bd = Math.hypot(m.x - threat.x, m.y - threat.y);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = m.x + dx, ny = m.y + dy;
      if (!z.isFree(nx, ny) || (dx && dy && !(z.grid.walkable(m.x + dx, m.y) && z.grid.walkable(m.x, m.y + dy)))) continue;
      const d = Math.hypot(nx - threat.x, ny - threat.y);
      if (d > bd + 0.01) { bd = d; best = { x: nx, y: ny }; }
    }
  }
  if (best) {
    m.faceX = Math.sign(best.x - m.x);
    m.faceY = Math.sign(best.y - m.y);
    z.moveActor(m, best.x, best.y);
    m.moveCd = Math.max(1, m.moveTicks - 1);
  } else if (m.dist(threat) <= 1 && m.atkCd <= 0) {
    // Cornered: fight back.
    m.atkCd = m.def.attackTicks;
    strike(game, m, threat, { kind: 'phys', mult: 1, label: 'hit' });
  }
}

// ---- Movement ---------------------------------------------------------------------------------
type Plan = 'ok' | 'none' | 'budget';

function planTo(game: Game, m: Monster, goal: Vec2): Plan {
  if (game.pathBudget <= 0) return 'budget';
  game.pathBudget--;
  const z = m.zone;
  const path = findPath(z.grid.w, z.grid.h, { x: m.x, y: m.y }, goal, (x, y) => z.planFree(x, y), { maxNodes: 350 });
  if (!path || !path.length) return 'none';
  m.path = path;
  m.pathTarget = goal;
  m.replanAt = game.tick + REPLAN_EVERY;
  return 'ok';
}

function chase(game: Game, m: Monster, target: Player): void {
  const stale = !m.pathTarget || Math.max(Math.abs(m.pathTarget.x - target.x), Math.abs(m.pathTarget.y - target.y)) > 1;
  const wantsPlan = !m.path.length || stale || game.tick >= m.replanAt + secs(2);
  if (wantsPlan && game.tick >= m.replanAt) {
    const plan = planTo(game, m, { x: target.x, y: target.y });
    if (plan === 'ok') {
      m.unreachableSince = 0;
    } else {
      if (plan === 'none') {
        // No route (across water, walled off, or boxed in by packmates). Retry slowly, then give up.
        m.replanAt = game.tick + REPLAN_EVERY;
        m.unreachableSince ||= game.tick;
        if (game.tick - m.unreachableSince > UNREACHABLE_AFTER) return disengage(game, m);
      }
      return greedyStep(game, m, target);
    }
  } else if (!m.path.length) {
    return greedyStep(game, m, target);
  }
  followPath(game, m);
}

function greedyStep(game: Game, m: Monster, target: Vec2): void {
  const z = m.zone;
  const sx = Math.sign(target.x - m.x), sy = Math.sign(target.y - m.y);
  for (const [dx, dy] of [[sx, sy], [sx, 0], [0, sy]] as const) {
    if (!dx && !dy) continue;
    if (!z.isFree(m.x + dx, m.y + dy)) continue;
    // Same rule as players and A*: no squeezing diagonally between two blocked tiles.
    if (dx && dy && (!z.grid.passable(m.x + dx, m.y) || !z.grid.passable(m.x, m.y + dy))) continue;
    step(game, m, m.x + dx, m.y + dy);
    return;
  }
}

function followPath(game: Game, m: Monster): void {
  if (m.moveCd > 0 || m.rooted) return;
  const next = m.path[0];
  if (!next) return;
  const z = m.zone;
  if (z.grid.get(next.x, next.y) === T.DOOR_CLOSED) {
    game.openDoor(z, next.x, next.y);
    m.moveCd = 2;
    return;
  }
  if (!z.isFree(next.x, next.y)) {
    // Blocked by another actor: if it is the goal we are done, else replan.
    if (m.path.length === 1) { m.path = []; return; }
    m.path = [];
    m.replanAt = 0;
    return;
  }
  m.path.shift();
  step(game, m, next.x, next.y);
}

function step(game: Game, m: Monster, x: number, y: number): void {
  m.faceX = Math.sign(x - m.x);
  m.faceY = Math.sign(y - m.y);
  m.zone.moveActor(m, x, y);
  m.moveCd = m.moveTicks;
  void game;
}

// ---- Dragon breath ----------------------------------------------------------------------------
function resolveBreath(game: Game, m: Monster): void {
  const b = m.breath!;
  const z = m.zone;
  const R = 2;
  if (game.tick < b.at) {
    // Telegraph: warning flames on the impact area.
    if ((b.at - game.tick) % 3 === 0) {
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (z.grid.walkable(b.x + dx, b.y + dy)) z.emitFx(b.x + dx, b.y + dy, '^', 'info');
    }
    return;
  }
  m.breath = null;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (z.grid.walkable(b.x + dx, b.y + dy)) z.emitFx(b.x + dx, b.y + dy, '*', 'burst');
  for (const a of z.actorsNear(b.x, b.y, R)) {
    if (!(a instanceof Player)) continue;
    const raw = m.attackPower * 1.1 * game.rng.range(0.9, 1.1);
    const mit = 100 / (100 + a.stats.def * 3);
    applyDamage(game, m, a, Math.max(1, Math.round(raw * mit)), false, 'burn');
  }
}
