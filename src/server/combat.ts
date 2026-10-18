// Combat: damage math, basic attacks, class skills, XP / leveling, kills, loot and death.
import { MAX_LEVEL, PARTY_SHARE_RANGE, secs } from '../shared/constants';
import { SKILLS, xpForLevel, type SkillDef } from '../shared/gamedata';
import { hasLos } from '../shared/fov';
import { T } from '../shared/tiles';
import type { SkillId, Vec2 } from '../shared/types';
import { Actor, Loot, Monster, Player } from './entities';
import type { Game } from './game';
import { rollMonsterDrop } from './items';

export interface HitOpts {
  kind: 'phys' | 'magic';
  mult: number;
  /** Basic attacks use the better of atk and 60% of mag so casters are not helpless. */
  basic?: boolean;
  forceCrit?: boolean;
  /** Skip the evasion roll (AoE telegraphs, DoTs). */
  noMiss?: boolean;
  label?: string;
}

export function isHostile(a: Actor, b: Actor): boolean {
  if (a === b || a.dead || b.dead) return false;
  if (a instanceof Monster) return b instanceof Player;
  if (a instanceof Player) {
    if (b instanceof Monster) return true;
    if (b instanceof Player) return a.pvp && b.pvp && a.zone.def.pvp && !(a.partyId !== 0 && a.partyId === b.partyId);
  }
  return false;
}

/** Melee cannot swing diagonally past a solid corner (both orthogonal neighbours blocked). */
export function meleeBlocked(z: Actor['zone'], ax: number, ay: number, bx: number, by: number): boolean {
  const dx = bx - ax, dy = by - ay;
  if (!dx || !dy) return false;
  return !z.grid.passable(ax + dx, ay) && !z.grid.passable(ax, ay + dy);
}

const mitigation = (def: number, kind: 'phys' | 'magic'): number => 100 / (100 + def * (kind === 'phys' ? 4 : 2));

function offense(src: Actor, opts: HitOpts): { power: number; crit: number } {
  if (src instanceof Player) {
    const s = src.stats;
    const power = opts.kind === 'magic' ? s.mag : opts.basic ? Math.max(s.atk, s.mag * 0.6) : s.atk;
    return { power, crit: s.crit };
  }
  if (src instanceof Monster) return { power: src.attackPower, crit: 5 };
  return { power: 1, crit: 0 };
}

const defenseOf = (v: Actor): number => (v instanceof Player ? v.stats.def : v instanceof Monster ? v.defense : 0);

/** Resolve one hit. Returns damage dealt (0 on a miss). */
export function strike(game: Game, src: Actor, victim: Actor, opts: HitOpts): number {
  if (victim.dead) return 0;
  const zone = victim.zone;
  breakStealth(src);

  if (!opts.noMiss && victim.stealthed && victim instanceof Player && game.rng.chance(0.4)) {
    zone.emitFx(victim.x, victim.y, 'miss', 'miss');
    if (src instanceof Player) game.combatLog(src, `${victim.name} evades your attack.`);
    game.combatLog(victim, `You evade ${src.name}'s attack.`);
    return 0;
  }

  const o = offense(src, opts);
  const crit = opts.forceCrit || game.rng.chance(o.crit / 100);
  let dmg = o.power * opts.mult * game.rng.range(0.9, 1.1) * (crit ? 1.75 : 1);
  dmg = Math.max(1, Math.round(dmg * mitigation(defenseOf(victim), opts.kind)));
  applyDamage(game, src, victim, dmg, crit, opts.label);
  return dmg;
}

/** Subtract HP, emit effects/log lines, handle threat and death. */
export function applyDamage(game: Game, src: Actor | null, victim: Actor, dmg: number, crit: boolean, label?: string): void {
  const zone = victim.zone;
  victim.hp -= dmg;
  zone.emitFx(victim.x, victim.y, String(dmg), crit ? 'crit' : victim instanceof Player ? 'hurt' : 'hit');

  const verb = label ?? 'hit';
  if (src instanceof Player) {
    src.combatUntil = game.tick + secs(6);
    game.combatLog(src, `You ${verb} ${victim.name} for ${dmg}${crit ? ' (CRIT!)' : ''}.`);
  }
  if (victim instanceof Player) {
    victim.combatUntil = game.tick + secs(6);
    if (victim.openShop || victim.bankOpen) game.closeWindows(victim);
    if (src) game.combatLog(victim, `${src.name} ${src instanceof Monster ? 'hits' : verb + 's'} you for ${dmg}${crit ? ' (CRIT!)' : ''}.`);
  }

  if (victim instanceof Monster && src) {
    victim.threat.set(src.id, (victim.threat.get(src.id) ?? 0) + dmg);
    if (victim.def.berserk && !victim.enraged && victim.hp > 0 && victim.hp < victim.maxHp * 0.5) {
      victim.enraged = true;
      zone.emitFx(victim.x, victim.y, 'RAGE!', 'info');
    }
    if (victim.state !== 'AGGRO' && victim.state !== 'FLEE' && victim.hp > 0) game.aggroMonster(victim, src);
  }

  if (victim.hp <= 0) {
    victim.hp = 0;
    if (victim instanceof Monster) killMonster(game, victim, src);
    else if (victim instanceof Player) killPlayer(game, victim, src);
  }
}

export function breakStealth(a: Actor): void {
  if (a.buffs.delete('stealth')) a.zone.emitFx(a.x, a.y, '?', 'info');
}

export function heal(game: Game, a: Actor, amount: number): void {
  if (a.dead || amount <= 0) return;
  const before = a.hp;
  a.hp = Math.min(a.maxHp, a.hp + amount);
  const got = Math.round(a.hp - before);
  if (got > 0) a.zone.emitFx(a.x, a.y, `+${got}`, 'heal');
}

// ---- Basic attack -----------------------------------------------------------------------------
export function basicAttack(game: Game, p: Player, target: Actor): void {
  if (p.atkCd > 0) return;
  p.atkCd = p.def.attackTicks;
  p.faceX = Math.sign(target.x - p.x);
  p.faceY = Math.sign(target.y - p.y);
  const ambush = p.stealthed;
  strike(game, p, target, { kind: 'phys', mult: 1, basic: true, forceCrit: ambush, label: 'hit' });
}

// ---- Skills -----------------------------------------------------------------------------------
export type CastResult = 'ok' | 'wait' | 'fail';

function say(game: Game, p: Player, text: string): void {
  // Rate-limit "can't do that" feedback so key mashing does not flood the log.
  if (game.tick - p.flagSkillMsgAt < 8) return;
  p.flagSkillMsgAt = game.tick;
  game.sys(p, text);
}

/** Locked target if still valid, else a hostile in the facing direction, else any adjacent hostile. */
function meleeTarget(game: Game, p: Player): Actor | null {
  const z = p.zone;
  const locked = p.target ? game.actorById(p.target) : null;
  if (locked && locked.zone === z && isHostile(p, locked) && p.dist(locked) <= 1 && !meleeBlocked(z, p.x, p.y, locked.x, locked.y)) return locked;
  const ahead = z.actorAt(p.x + p.faceX, p.y + p.faceY);
  if (ahead && isHostile(p, ahead) && !meleeBlocked(z, p.x, p.y, ahead.x, ahead.y)) return ahead;
  for (const a of z.actorsNear(p.x, p.y, 1)) if (isHostile(p, a) && !meleeBlocked(z, p.x, p.y, a.x, a.y)) return a;
  return null;
}

function hostilesAround(p: Player, cx: number, cy: number, r: number): Actor[] {
  return p.zone.actorsNear(cx, cy, r).filter((a) => isHostile(p, a));
}

export function castSkill(game: Game, p: Player, slot: 1 | 2 | 3 | 4): CastResult {
  if (p.stunned) { say(game, p, 'You are stunned!'); return 'fail'; }
  if (slot >= 3) {
    if (p.cd[slot - 1]! > 0) { say(game, p, 'Potion on cooldown.'); return 'fail'; }
    const ok = game.quickPotion(p, slot === 3 ? 'health_potion' : 'mana_potion');
    if (ok) p.cd[slot - 1] = secs(2);
    return ok ? 'ok' : 'fail';
  }
  const id = p.def.skills[slot - 1] as SkillId;
  const sk = SKILLS[id];
  if (p.atkCd > 0) return 'wait';
  if (p.cd[slot - 1]! > 0) { say(game, p, `${sk.name} is on cooldown (${(p.cd[slot - 1]! / 10).toFixed(1)}s).`); return 'fail'; }
  if (p.mp < sk.mp) { say(game, p, `Not enough mana for ${sk.name} (${sk.mp}).`); return 'fail'; }

  const done = runSkill(game, p, sk);
  if (!done) return 'fail';
  p.mp -= sk.mp;
  p.cd[slot - 1] = sk.cd;
  p.atkCd = Math.max(p.atkCd, 3);
  p.combatUntil = game.tick + secs(6);
  return 'ok';
}

function runSkill(game: Game, p: Player, sk: SkillDef): boolean {
  const z = p.zone;
  switch (sk.id) {
    case 'shield_bash': {
      const t = meleeTarget(game, p);
      if (!t) { say(game, p, 'No enemy in reach.'); return false; }
      face(p, t);
      z.emitFx(t.x, t.y, '*', 'burst');
      strike(game, p, t, { kind: 'phys', mult: sk.power, label: 'bash' });
      if (!t.dead) {
        const boss = t instanceof Monster && t.def.boss;
        t.addBuff('stun', boss ? secs(0.8) : secs(2), 0, p.id);
        z.emitFx(t.x, t.y, 'STUN', 'info');
      }
      return true;
    }
    case 'whirlwind': {
      const targets = hostilesAround(p, p.x, p.y, 1).filter((t) => !meleeBlocked(z, p.x, p.y, t.x, t.y));
      if (!targets.length) { say(game, p, 'No enemies nearby.'); return false; }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) z.emitFx(p.x + dx, p.y + dy, '*', 'burst');
      for (const t of targets) strike(game, p, t, { kind: 'phys', mult: sk.power, label: 'whirl into' });
      return true;
    }
    case 'fireball': {
      const impact = fireballImpact(game, p, sk.range);
      if (!impact) { say(game, p, 'Nothing to target.'); return false; }
      for (const pt of impact.path) z.emitFx(pt.x, pt.y, '*', 'burst');
      for (let dy = -sk.radius; dy <= sk.radius; dy++) for (let dx = -sk.radius; dx <= sk.radius; dx++) {
        if (z.grid.walkable(impact.at.x + dx, impact.at.y + dy)) z.emitFx(impact.at.x + dx, impact.at.y + dy, '*', 'burst');
      }
      for (const t of hostilesAround(p, impact.at.x, impact.at.y, sk.radius)) {
        const center = t.x === impact.at.x && t.y === impact.at.y;
        strike(game, p, t, { kind: 'magic', mult: sk.power * (center ? 1 : 0.7), label: 'scorch' });
      }
      return true;
    }
    case 'frost_nova': {
      const targets = hostilesAround(p, p.x, p.y, sk.radius);
      if (!targets.length) { say(game, p, 'No enemies nearby.'); return false; }
      for (let dy = -sk.radius; dy <= sk.radius; dy++) for (let dx = -sk.radius; dx <= sk.radius; dx++) {
        if ((dx || dy) && Math.max(Math.abs(dx), Math.abs(dy)) === sk.radius) z.emitFx(p.x + dx, p.y + dy, '*', 'burst');
      }
      for (const t of targets) {
        strike(game, p, t, { kind: 'magic', mult: sk.power, label: 'freeze' });
        if (!t.dead) {
          const boss = t instanceof Monster && t.def.boss;
          t.addBuff('root', boss ? secs(1) : secs(3), 0, p.id);
          t.addBuff('slow', secs(7), 0, p.id);
          z.emitFx(t.x, t.y, 'ROOT', 'info');
        }
      }
      return true;
    }
    case 'backstab': {
      const t = meleeTarget(game, p);
      if (!t) { say(game, p, 'No enemy in reach.'); return false; }
      face(p, t);
      const dx = p.x - t.x, dy = p.y - t.y;
      const behind = t.faceX * dx + t.faceY * dy < 0
        || t.stunned || t.rooted || (t instanceof Monster && t.state === 'FLEE') || p.stealthed;
      if (behind) z.emitFx(t.x, t.y, 'BACKSTAB', 'info');
      strike(game, p, t, { kind: 'phys', mult: sk.power * (behind ? 2 : 1), forceCrit: false, label: behind ? 'backstab' : 'stab' });
      return true;
    }
    case 'smoke_bomb': {
      p.addBuff('stealth', secs(5), 0, p.id);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) z.emitFx(p.x + dx, p.y + dy, '%', 'burst');
      game.sys(p, 'You vanish in a cloud of smoke.');
      return true;
    }
  }
}

function face(p: Player, t: Actor): void {
  p.faceX = Math.sign(t.x - p.x);
  p.faceY = Math.sign(t.y - p.y);
}

/** Where a fireball lands: locked target if visible and in range, else first obstacle along facing. */
function fireballImpact(game: Game, p: Player, range: number): { at: Vec2; path: Vec2[] } | null {
  const z = p.zone;
  const locked = p.target ? game.actorById(p.target) : null;
  if (locked && locked.zone === z && isHostile(p, locked) && p.dist(locked) <= range
    && hasLos(p.x, p.y, locked.x, locked.y, (x, y) => z.grid.opaque(x, y))) {
    face(p, locked);
    return { at: { x: locked.x, y: locked.y }, path: line(p, locked) };
  }
  const fx = p.faceX || 0, fy = p.faceY || 1;
  const path: Vec2[] = [];
  let last: Vec2 | null = null;
  for (let i = 1; i <= range; i++) {
    const x = p.x + fx * i, y = p.y + fy * i;
    if (!z.grid.walkable(x, y) && z.grid.get(x, y) !== T.WATER && z.grid.get(x, y) !== T.TREE) break;
    if (z.grid.opaque(x, y)) break;
    path.push({ x, y });
    last = { x, y };
    const a = z.actorAt(x, y);
    if (a && isHostile(p, a)) break;
  }
  return last ? { at: last, path } : null;
}

function line(a: Vec2, b: Vec2): Vec2[] {
  const out: Vec2[] = [];
  const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  for (let i = 1; i < n; i++) out.push({ x: Math.round(a.x + ((b.x - a.x) * i) / n), y: Math.round(a.y + ((b.y - a.y) * i) / n) });
  return out;
}

// ---- XP & levels ------------------------------------------------------------------------------
export function awardXp(game: Game, p: Player, amount: number): void {
  if (amount <= 0 || p.level >= MAX_LEVEL) return;
  p.xp += Math.round(amount);
  p.zone.emitFx(p.x, p.y, `+${Math.round(amount)}xp`, 'xp');
  let leveled = false;
  while (p.level < MAX_LEVEL && p.xp >= xpForLevel(p.level)) {
    p.xp -= xpForLevel(p.level);
    p.level++;
    leveled = true;
  }
  if (p.level >= MAX_LEVEL) p.xp = 0;
  if (leveled) {
    p.recalc();
    p.hp = p.maxHp;
    p.mp = p.stats.maxMp;
    p.zone.emitFx(p.x, p.y, 'LEVEL UP!', 'info');
    game.sys(p, `*** You reached level ${p.level}! ***`);
    if (p.level % 5 === 0) game.broadcastSystem(`${p.name} reached level ${p.level}!`, p);
  }
}

// ---- Kills, loot, death -----------------------------------------------------------------------
interface Group { members: Player[]; damage: number }

export function killMonster(game: Game, m: Monster, killer: Actor | null): void {
  const z = m.zone;
  m.dead = true;
  m.state = 'RESPAWN';
  m.respawnAt = game.tick + m.def.respawn + game.rng.int(0, secs(10));
  m.targetId = 0;
  m.path = [];
  m.buffs.clear();
  m.enraged = false;
  m.breath = null;
  z.removeActor(m);
  z.emitFx(m.x, m.y, '%', 'burst');

  // Group credit by damage share (players in the same party count as one group).
  const total = [...m.threat.values()].reduce((a, b) => a + b, 0) || 1;
  const groups = new Map<number, Group>();
  for (const [id, dmg] of m.threat) {
    const pl = game.players.get(id);
    if (!pl || pl.zone !== z) continue;
    const key = pl.partyId || -pl.id;
    let g = groups.get(key);
    if (!g) {
      const members = pl.partyId ? game.partyMembers(pl.partyId).filter((x) => x.zone === z && x.dist(m) <= PARTY_SHARE_RANGE) : [pl];
      g = { members: members.includes(pl) ? members : [pl, ...members], damage: 0 };
      groups.set(key, g);
    }
    g.damage += dmg;
  }
  if (killer instanceof Player && ![...groups.values()].some((g) => g.members.includes(killer))) {
    groups.set(-killer.id, { members: [killer], damage: total * 0.1 });
  }

  const baseXp = m.def.xp * (1 + 0.25 * (m.level - 1));
  let best: Group | null = null;
  for (const g of groups.values()) {
    const share = g.damage / total;
    if (!best || g.damage > best.damage) best = g;
    if (share < 0.1 && !g.members.includes(killer as Player)) continue;
    const n = g.members.length;
    const bonus = 1 + 0.15 * (n - 1);
    for (const pl of g.members) {
      const diff = Math.max(0.1, Math.min(1.6, 1 + (m.level - pl.level) * 0.12));
      awardXp(game, pl, Math.max(1, (baseXp * Math.min(1, share * 1.2) * bonus * diff) / n));
      game.questProgress(pl, `kill:${m.def.id}`, 1);
    }
  }

  dropLoot(game, m, best);
}

function dropLoot(game: Game, m: Monster, winners: Group | null): void {
  const z = m.zone;
  const piles = m.def.boss ? 4 : 1;
  for (let i = 0; i < piles; i++) {
    const gold = Math.round(game.rng.int(m.def.gold[0], m.def.gold[1]) * (1 + 0.1 * m.level));
    const item = rollMonsterDrop(game.rng, m.level, !!m.def.boss);
    const spot = z.findNear(m.x, m.y, (x, y) => z.grid.walkable(x, y) && !z.lootOn(x, y), 4);
    if (!spot) continue;
    let owner = 0;
    if (winners) {
      const near = winners.members.filter((pl) => !pl.dead);
      if (near.length > 1 && item) {
        // Party loot roll: highest d100 wins.
        let top = -1;
        const rolls: string[] = [];
        for (const pl of near) {
          const r = game.rng.int(1, 100);
          rolls.push(`${pl.name} ${r}`);
          if (r > top) { top = r; owner = pl.id; }
        }
        const winner = game.players.get(owner)!;
        for (const pl of near) game.chat(pl, 'party', 'Loot', `[${item.name}] rolls: ${rolls.join(', ')} -> ${winner.name} wins.`);
      } else if (near.length >= 1) owner = near[0]!.id;
    }
    game.spawnLoot(z, spot.x, spot.y, gold, item, owner);
  }
}

export function killPlayer(game: Game, p: Player, killer: Actor | null): void {
  p.dead = true;
  const by = killer ? killer.name : 'unknown causes';
  game.sys(p, `You have been slain by ${by}.`);
  for (const o of p.zone.players.values()) if (o !== p) game.sys(o, `${p.name} was slain by ${by}.`);
  p.zone.emitFx(p.x, p.y, 'X', 'hurt');
  const lost = Math.floor(p.gold * 0.05);
  p.gold -= lost;
  p.xp = Math.floor(p.xp * 0.9);
  p.buffs.clear();
  p.target = 0;
  p.pendingMove = null;
  p.pendingSkills = [];
  p.recalc();
  p.hp = Math.ceil(p.maxHp * 0.5);
  p.mp = Math.ceil(p.stats.maxMp * 0.5);
  p.dead = false;
  const home = game.world.zones.oakhaven.respawn;
  game.transfer(p, 'oakhaven', home.x, home.y);
  game.sys(p, `You awaken in Oakhaven${lost ? ` (lost ${lost} gold and some experience)` : ''}.`);
}
