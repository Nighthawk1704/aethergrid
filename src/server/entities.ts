import type { WebSocket } from 'ws';
import { INVENTORY_SLOTS } from '../shared/constants';
import { CLASSES, MONSTERS, statsForLevel, type MonsterDef } from '../shared/gamedata';
import {
  EF, STAT_KEYS,
  type AIState, type BuffId, type BuffView, type ClassId, type EntityKind, type EquipSlot, type Item, type SelfState,
  type Stats, type Vec2, type WireEntity, type ZoneId,
} from '../shared/types';
import type { CharacterRecord, QuestProgress } from './db';
import type { MobSpawn } from './world';
import type { ZoneRuntime } from './zone';

let idCounter = 1;
export const nextEntityId = (): number => idCounter++;

export interface Buff { ticks: number; power: number; src: number }

/** Anything that occupies a tile, has HP and can take part in combat. */
export abstract class Actor {
  readonly id = nextEntityId();
  abstract readonly kind: EntityKind;
  zone!: ZoneRuntime;
  x = 0;
  y = 0;
  hp = 1;
  maxHp = 1;
  level = 1;
  name = '';
  faceX = 0;
  faceY = 1;
  moveCd = 0;
  atkCd = 0;
  dead = false;
  readonly buffs = new Map<BuffId, Buff>();

  hasBuff(id: BuffId): boolean { return this.buffs.has(id); }
  addBuff(id: BuffId, ticks: number, power = 0, src = 0): void {
    const cur = this.buffs.get(id);
    if (cur && cur.ticks > ticks) return;
    this.buffs.set(id, { ticks, power, src });
  }
  get stunned(): boolean { return this.buffs.has('stun'); }
  get rooted(): boolean { return this.buffs.has('root'); }
  get stealthed(): boolean { return this.buffs.has('stealth'); }
  dist(o: Vec2): number { return Math.max(Math.abs(this.x - o.x), Math.abs(this.y - o.y)); }

  abstract toWire(viewerPartyId: number): WireEntity;

  protected baseFlags(): number {
    let f = 0;
    if (this.stunned) f |= EF.STUNNED;
    if (this.rooted) f |= EF.ROOTED;
    if (this.stealthed) f |= EF.STEALTH;
    if (this.dead) f |= EF.DEAD;
    return f;
  }
}

export interface PendingMove { dx: -1 | 0 | 1; dy: -1 | 0 | 1; until: number }
export interface PendingSkill { slot: 1 | 2 | 3 | 4; until: number }

export class Player extends Actor {
  readonly kind = 'player' as const;
  cls: ClassId;
  xp: number;
  mp: number;
  gold: number;
  bag: (Item | null)[];
  equip: Record<EquipSlot, Item | null>;
  bank: (Item | null)[];
  quests: Record<string, QuestProgress>;
  stats: Stats;
  cd: [number, number, number, number] = [0, 0, 0, 0];
  target = 0;
  pvp = false;
  partyId = 0;

  // Input queued by the network layer, consumed by the tick.
  pendingMove: PendingMove | null = null;
  pendingSkills: PendingSkill[] = [];
  /** Server's mirror of what the client counts down locally (see sync). */
  cdSent: [number, number, number, number] = [0, 0, 0, 0];
  buffSent = new Map<BuffId, number>();
  wantInteract = false;
  wantStairs: 'up' | 'down' | null = null;

  /** Tick of the last combat action; regen is slower shortly after. */
  combatUntil = 0;
  harvestCd = 0;
  regenAcc = 0;
  unstuckAt = 0;
  nextAutosave = 0;

  // Per-connection map knowledge / delta state used by the sync system.
  known = new Map<ZoneId, Uint8Array>();
  visList: number[] = [];
  visSet = new Set<number>();
  invDirty = true;
  fovDirty = true;
  sent = new Map<number, WireEntity>();
  lastSelf: Record<string, string> = {};
  forceSelf = true;
  flagSkillMsgAt = 0;

  // UI/session context.
  openShop: string | null = null;
  bankOpen = false;
  questOpen = false;
  questNpc = 'Quest Board';
  dialogNpc: string | null = null;
  tradeId = 0;
  lastWhisperFrom = '';

  constructor(
    readonly session: Session,
    readonly rec: CharacterRecord,
  ) {
    super();
    this.name = rec.name;
    this.cls = rec.cls;
    this.level = rec.level;
    this.xp = rec.xp;
    this.mp = rec.mp;
    this.gold = rec.gold;
    this.bag = rec.bag;
    this.equip = rec.equip;
    this.bank = rec.bank;
    this.quests = rec.quests;
    this.stats = statsForLevel(rec.cls, rec.level);
    this.recalc();
    this.hp = Math.max(1, Math.min(rec.hp, this.stats.maxHp));
    this.mp = Math.min(this.mp, this.stats.maxMp);
  }

  get def() { return CLASSES[this.cls]; }

  /** Recompute derived stats from class, level, gear and buffs. */
  recalc(): void {
    const s = statsForLevel(this.cls, this.level);
    for (const it of Object.values(this.equip)) {
      if (!it) continue;
      for (const k of STAT_KEYS) s[k] += it.stats[k] ?? 0;
    }
    const might = this.buffs.get('might');
    if (might) s.atk *= 1 + might.power;
    s.atk = Math.round(s.atk * 10) / 10;
    s.mag = Math.round(s.mag * 10) / 10;
    this.stats = s;
    this.maxHp = s.maxHp;
    if (this.hp > this.maxHp) this.hp = this.maxHp;
    if (this.mp > s.maxMp) this.mp = s.maxMp;
  }

  get moveTicks(): number {
    const base = this.def.moveTicks;
    return this.hasBuff('slow') ? base * 2 : base;
  }

  freeBagSlots(): number { return this.bag.reduce((n, s) => n + (s ? 0 : 1), 0); }

  toRecord(): CharacterRecord {
    const r = this.rec;
    r.level = this.level; r.xp = this.xp; r.hp = Math.max(1, Math.round(this.hp)); r.mp = Math.round(this.mp);
    r.gold = this.gold; r.zone = this.zone.def.id; r.x = this.x; r.y = this.y;
    r.bag = this.bag; r.equip = this.equip; r.bank = this.bank; r.quests = this.quests;
    return r;
  }

  buffViews(): BuffView[] {
    return [...this.buffs.entries()].map(([id, b]) => ({ id, ticks: b.ticks }));
  }

  selfState(xpNext: number): SelfState {
    return {
      id: this.id, name: this.name, cls: this.cls, lv: this.level, xp: this.xp, xpNext,
      hp: Math.round(this.hp), mp: Math.round(this.mp), gold: this.gold, x: this.x, y: this.y, zone: this.zone.def.id,
      stats: this.stats, buffs: this.buffViews(), cd: this.cd, target: this.target, pvp: this.pvp, partyId: this.partyId,
    };
  }

  toWire(viewerPartyId: number): WireEntity {
    let fl = this.baseFlags();
    if (this.partyId && this.partyId === viewerPartyId) fl |= EF.PARTY;
    if (this.pvp) fl |= EF.PVP;
    return { id: this.id, k: 'player', x: this.x, y: this.y, n: this.name, t: this.cls, hp: Math.round(this.hp), mhp: this.maxHp, lv: this.level, fl };
  }
}

/** Network connection state; the Player is attached after authentication. */
export interface Session {
  readonly id: number;
  readonly ws: WebSocket;
  player: Player | null;
  accountId: number;
  authed: boolean;
  authBusy: boolean;
  authFails: number;
  badPackets: number;
  outSeq: number;
  lastClientSeq: number;
  tokens: number;
  lastRefill: number;
  alive: boolean;
  chatTimes: number[];
  closed: boolean;
}

export class Monster extends Actor {
  readonly kind = 'monster' as const;
  readonly def: MonsterDef;
  state: AIState = 'IDLE';
  home: Vec2;
  atk: number;
  defense: number;
  targetId = 0;
  path: Vec2[] = [];
  pathTarget: Vec2 | null = null;
  replanAt = 0;
  idleUntil = 0;
  respawnAt = 0;
  lostSightSince = 0;
  specialCd = 0;
  fleeUntil = 0;
  /** Tick when pathing to the current target first failed (0 = fine). */
  unreachableSince = 0;
  /** After giving up, ignore passive aggro until this tick (damage still aggros). */
  noAggroUntil = 0;
  breath: { at: number; x: number; y: number } | null = null;
  enraged = false;
  readonly threat = new Map<number, number>();
  readonly leash = 18;

  constructor(readonly spawn: MobSpawn) {
    super();
    this.def = MONSTERS[spawn.monster];
    this.name = this.def.name;
    this.level = spawn.level;
    this.home = { x: spawn.x, y: spawn.y };
    this.x = spawn.x;
    this.y = spawn.y;
    const k = 1 + this.def.perLevel * (this.level - 1);
    this.maxHp = Math.round(this.def.hp * k);
    this.atk = Math.round(this.def.atk * k * 10) / 10;
    this.defense = Math.round((this.def.def + this.level * 0.5) * 10) / 10;
    this.hp = this.maxHp;
  }

  get moveTicks(): number {
    let t = this.def.moveTicks;
    if (this.enraged) t = Math.max(1, t - 1);
    return this.hasBuff('slow') ? t * 2 : t;
  }
  get attackPower(): number { return this.enraged ? this.atk * 1.5 : this.atk; }

  toWire(): WireEntity {
    let fl = this.baseFlags() | EF.HOSTILE;
    if (this.state === 'FLEE') fl |= EF.FLEEING;
    if (this.enraged) fl |= EF.ENRAGED;
    return { id: this.id, k: 'monster', x: this.x, y: this.y, n: this.name, t: this.def.id, hp: Math.round(this.hp), mhp: this.maxHp, lv: this.level, fl };
  }
}

export class Npc extends Actor {
  readonly kind = 'npc' as const;
  constructor(readonly npcId: string, readonly role: string, name: string, x: number, y: number) {
    super();
    this.name = name;
    this.x = x;
    this.y = y;
    this.hp = this.maxHp = 1;
  }
  toWire(): WireEntity {
    return { id: this.id, k: 'npc', x: this.x, y: this.y, n: this.name, t: this.role, hp: 1, mhp: 1, lv: 0, fl: 0 };
  }
}

export class Loot {
  readonly id = nextEntityId();
  dbId = 0;
  ownerId = 0;
  ownerUntil = 0;
  constructor(
    public zone: ZoneId,
    public x: number,
    public y: number,
    public gold: number,
    public item: Item | null,
    public expireTick: number,
  ) {}

  get name(): string { return this.item ? this.item.name : `${this.gold} gold`; }

  toWire(): WireEntity {
    const t = this.item ? this.item.slot : 'gold';
    return { id: this.id, k: 'loot', x: this.x, y: this.y, n: this.name, t, hp: 0, mhp: 0, lv: 0, fl: 0 };
  }
}

export const emptyBag = (): (Item | null)[] => new Array<Item | null>(INVENTORY_SLOTS).fill(null);
