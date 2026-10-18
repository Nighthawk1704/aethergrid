// Headless bot simulator: N AI-controlled players that connect over WebSocket like real clients,
// so a fresh server immediately feels populated.
//   npm run simulate-bots [-- --count 10 --url ws://localhost:8765/ws]
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { DEFAULT_PORT } from '../shared/constants';
import { NetClient } from '../shared/client/net';
import { ClientState } from '../shared/client/state';
import { findPath } from '../shared/path';
import { Rng } from '../shared/rng';
import { T, tileDef } from '../shared/tiles';
import { EF, EQUIP_SLOTS, STAT_KEYS, type ClassId, type EquipSlot, type Item, type Vec2, type WireEntity } from '../shared/types';

const NAMES = ['Aldric', 'Brynn', 'Cassia', 'Dorian', 'Elara', 'Fenwick', 'Garrick', 'Hilda', 'Ivo', 'Jorun', 'Kestrel', 'Lyra', 'Marek', 'Nyx', 'Orin', 'Petra'];
const CLASSES: ClassId[] = ['vanguard', 'arcanist', 'shadowblade', 'vanguard', 'arcanist', 'shadowblade', 'vanguard', 'shadowblade', 'arcanist', 'vanguard'];
const SAY = [
  'Anyone seen goblins nearby?', 'Watch out for the orcs in the east.', 'Good hunting, everyone.', 'My sword arm is tired...',
  'Found some iron ore up north.', 'Is the dragon really on floor three?', 'Need a healing potion, badly.', 'Elowen sells good potions in town.',
  'This forest never ends.', 'Beautiful day for an adventure.', 'Careful, goblins run when hurt.', 'Anyone want to party up?',
];
const SHOUT = ['Looking for a party in the Wilds!', 'WTS rusty swords, cheap!', 'Dragon slayers wanted!', 'Oakhaven inn is the best healer.'];
const REPLY = ['Hello there, traveller!', 'Well met!', 'Greetings!', 'Hi! Stay safe out there.'];

const TOWN_GATE: Vec2 = { x: 40, y: 1 };
const ALCHEMIST: Vec2 = { x: 30, y: 52 };
const SMITH: Vec2 = { x: 50, y: 27 };

function itemScore(it: Item): number {
  let v = 0;
  const w: Record<string, number> = { atk: 4, mag: 4, def: 4, crit: 5, maxHp: 0.8, maxMp: 0.8 };
  for (const k of STAT_KEYS) v += (it.stats[k] ?? 0) * (w[k] ?? 1);
  return v;
}

export interface BotReport { name: string; cls: ClassId; level: number; zone: string; hp: string; gold: number; kills: number; deaths: number; state: string }

export class Bot {
  readonly name: string;
  readonly st = new ClientState();
  private readonly net: NetClient;
  private readonly rng: Rng;
  private think: ReturnType<typeof setInterval> | null = null;
  private state = 'boot';
  private goal: Vec2 | null = null;
  private goalUntil = 0;
  private lastPos = '';
  private stuckSince = 0;
  private blacklist = new Map<string, number>();
  private nextSay: number;
  private nextShout: number;
  private lastShopTrip = 0;
  private lastEquipCheck = '';
  private shopping: 'none' | 'alchemist' | 'smith' = 'none';
  private shopDoneAt = 0;
  private lowHpSince = 0;
  private lastUnstuck = 0;
  kills = 0;
  deaths = 0;
  stopped = false;
  private authTried: 'login' | 'register' | null = null;

  constructor(readonly index: number, private readonly url: string) {
    this.name = `${NAMES[index % NAMES.length]}_bot`;
    this.rng = new Rng(index * 7919 + 13);
    this.nextSay = Date.now() + this.rng.int(15_000, 45_000);
    this.nextShout = Date.now() + this.rng.int(90_000, 240_000);
    this.net = new NetClient({
      onPacket: (p) => this.onPacket(p),
      onClose: () => { this.state = 'offline'; if (!this.stopped) setTimeout(() => this.connect(), 3000 + this.rng.int(0, 2000)); },
    });
  }

  get cls(): ClassId { return CLASSES[this.index % CLASSES.length]!; }
  private get password(): string { return `botpass-${this.name}`; }

  connect(): void {
    this.st.authed = false;
    this.authTried = null;
    this.net.connect(this.url);
  }

  stop(): void {
    this.stopped = true;
    if (this.think) clearInterval(this.think);
    this.net.close();
  }

  private onPacket(p: Parameters<ClientState['apply']>[0]): void {
    this.st.apply(p);
    if (p.t === 'hello') {
      this.authTried = 'login';
      this.net.send({ t: 'login', name: this.name, password: this.password });
    } else if (p.t === 'auth' && !p.ok) {
      if (this.authTried === 'login') {
        this.authTried = 'register';
        this.net.send({ t: 'register', name: this.name, password: this.password, cls: this.cls });
      } else console.error(`[bot ${this.name}] auth failed: ${p.error}`);
    } else if (p.t === 'auth' && p.ok) {
      this.state = 'start';
      if (!this.think) this.think = setInterval(() => this.tick(), 220 + this.index * 7);
    } else if (p.t === 'chat') {
      this.onChat(p.chan, p.from, p.text);
      if (/slain by/.test(p.text) && p.text.startsWith('You have been slain')) this.deaths++;
    } else if (p.t === 'state' && p.fx) {
      for (const f of p.fx) if (f.kind === 'xp') this.kills++;
    }
  }

  private onChat(chan: string, from: string, text: string): void {
    if (/You gain|Quest/.test(text)) return;
    if (chan === 'combat' && /^You (hit|bash|scorch|freeze|stab|backstab|whirl)/.test(text) && /for \d+/.test(text)) return;
    if (chan === 'party' && /invites you to a party/.test(text)) {
      setTimeout(() => this.net.send({ t: 'chat', text: '/party accept' }), 800 + this.rng.int(0, 1500));
    } else if ((chan === 'local' || chan === 'whisper') && !from.endsWith('_bot') && from !== '*' && from !== this.name) {
      if (chan === 'whisper' || /\b(hi|hello|hey|greetings)\b/i.test(text) || text.toLowerCase().includes(this.name.toLowerCase().replace('_bot', ''))) {
        if (this.rng.chance(0.7)) {
          const reply = this.rng.pick(REPLY);
          setTimeout(() => this.net.send({ t: 'chat', text: chan === 'whisper' ? `/w ${from} ${reply}` : reply }), 1200 + this.rng.int(0, 2500));
        }
      }
    }
  }

  // ---- Helpers ------------------------------------------------------------------------------
  private get me() { return this.st.me!; }
  private dist(a: Vec2, b: Vec2): number { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }
  private send(text: string): void { this.net.send({ t: 'chat', text }); }

  private hostiles(): WireEntity[] {
    return [...this.st.entities.values()].filter((e) => e.k === 'monster' && !(e.fl & EF.DEAD));
  }

  private potion(base: string): boolean {
    return !!this.st.inv?.bag.some((i) => i?.base === base);
  }

  private occupied(): Set<number> {
    const z = this.st.zone!;
    const s = new Set<number>();
    for (const e of this.st.entities.values()) if (e.k !== 'loot') s.add(e.y * z.w + e.x);
    return s;
  }

  /** A* over the client's map. `optimistic` lets unexplored tiles count as walkable (the bots know the town layout). */
  private pathTo(goal: Vec2, optimistic = false): Vec2[] | null {
    const z = this.st.zone;
    if (!z) return null;
    const occ = this.occupied();
    const passable = (x: number, y: number): boolean => {
      const k = z.known[y * z.w + x]!;
      if (!k) return optimistic;
      const t = k - 1;
      if (t === T.GATE && !(x === goal.x && y === goal.y)) return false;
      return (tileDef(t).walk || t === T.DOOR_CLOSED) && !occ.has(y * z.w + x);
    };
    return findPath(z.w, z.h, { x: this.me.x, y: this.me.y }, goal, passable, {
      maxNodes: 5000, cost: (x, y) => (z.known[y * z.w + x] ? 1 : 1.6),
    });
  }

  private step(path: Vec2[]): void {
    const n = path[0];
    if (!n) return;
    this.net.send({ t: 'move', dx: Math.sign(n.x - this.me.x) as -1 | 0 | 1, dy: Math.sign(n.y - this.me.y) as -1 | 0 | 1 });
  }

  private walkTo(goal: Vec2, optimistic = false): boolean {
    const path = this.pathTo(goal, optimistic);
    if (!path || !path.length) return false;
    this.step(path);
    return true;
  }

  /** Nearest known walkable tile bordering unexplored space, skipping recently failed ones. */
  private frontier(): Vec2 | null {
    const z = this.st.zone!;
    const now = Date.now();
    const start = this.me.y * z.w + this.me.x;
    const seen = new Uint8Array(z.w * z.h);
    const q = [start];
    seen[start] = 1;
    let best: Vec2 | null = null;
    let bestScore = Infinity;
    for (let qi = 0; qi < q.length && qi < 9000; qi++) {
      const cur = q[qi]!;
      const cx = cur % z.w, cy = Math.floor(cur / z.w);
      const d = Math.abs(cx - this.me.x) + Math.abs(cy - this.me.y);
      if (d > 6) {
        let edge = false;
        for (let dy = -2; dy <= 2 && !edge; dy += 2) for (let dx = -2; dx <= 2 && !edge; dx += 2) {
          const nx = cx + dx, ny = cy + dy;
          if (nx > 0 && ny > 0 && nx < z.w - 1 && ny < z.h - 1 && !z.known[ny * z.w + nx]) edge = true;
        }
        const key = `${cx >> 3},${cy >> 3}`;
        if (edge && (this.blacklist.get(key) ?? 0) < now) {
          const score = d + this.rng.next() * 18;
          if (score < bestScore) { bestScore = score; best = { x: cx, y: cy }; }
          if (qi > 400 && best) break;
        }
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= z.w || ny >= z.h) continue;
        const ni = ny * z.w + nx;
        if (seen[ni]) continue;
        const k = z.known[ni]!;
        if (!k) continue;
        const t = k - 1;
        if (!(tileDef(t).walk || t === T.DOOR_CLOSED) || t === T.GATE) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
    return best;
  }

  // ---- Decision loop ------------------------------------------------------------------------
  private tick(): void {
    const st = this.st;
    if (!st.authed || !st.me || !st.zone || this.stopped) return;
    const me = this.me;
    const now = Date.now();

    // Windows left open by accident (shop/bank) must not block play.
    if (st.dialog) { this.net.send({ t: 'dialog', choice: 'close' }); st.dialog = null; }
    if (st.quests && this.shopping === 'none') { this.net.send({ t: 'quest', op: 'close' }); st.quests = null; }
    if (st.bank) { this.net.send({ t: 'bank', op: 'close' }); st.bank = null; }
    if (st.trade) this.net.send({ t: 'trade', op: 'cancel' });

    if (st.shop) return this.shopTick();
    this.maybeEquip();

    // Social chatter.
    if (now > this.nextSay && st.zone.id !== 'catacombs3') {
      this.send(this.rng.pick(SAY));
      this.nextSay = now + this.rng.int(40_000, 120_000);
    }
    if (now > this.nextShout) {
      this.send(`/shout ${this.rng.pick(SHOUT)}`);
      this.nextShout = now + this.rng.int(180_000, 420_000);
    }

    // Survival first.
    const hpFrac = me.hp / me.stats.maxHp;
    const foes = this.hostiles();
    const near = foes.filter((e) => this.dist(e, me) <= 9);
    if (hpFrac < 0.4 && this.potion('health_potion')) { this.net.send({ t: 'skill', slot: 3 }); this.state = 'quaff'; }
    if (me.mp < me.stats.maxMp * 0.2 && this.potion('mana_potion') && me.cls !== 'vanguard') this.net.send({ t: 'skill', slot: 4 });

    if (hpFrac < 0.3 && st.zone.id !== 'oakhaven') {
      this.state = 'flee';
      this.lowHpSince ||= now;
      const threat = near[0];
      if (threat) {
        const dx = Math.sign(me.x - threat.x) as -1 | 0 | 1, dy = Math.sign(me.y - threat.y) as -1 | 0 | 1;
        this.net.send({ t: 'move', dx, dy });
      } else if (now - this.lastUnstuck > 4000 && now - this.lowHpSince > 3000) {
        this.lastUnstuck = now;
        this.send('/unstuck');
      }
      return;
    }
    this.lowHpSince = 0;

    if (st.zone.id === 'oakhaven') return this.townTick(hpFrac);

    // Fight what we can handle.
    const prey = near
      .filter((e) => e.lv <= me.lv + 2 && (e.t !== 'dragon' || me.lv >= 18))
      .sort((a, b) => this.dist(a, me) - this.dist(b, me))[0];
    const danger = near.find((e) => e.lv > me.lv + 3 || (e.t === 'dragon' && me.lv < 18));
    if (danger && this.dist(danger, me) <= 6 && !prey) {
      this.state = 'avoid';
      this.net.send({ t: 'move', dx: Math.sign(me.x - danger.x) as -1 | 0 | 1, dy: Math.sign(me.y - danger.y) as -1 | 0 | 1 });
      return;
    }
    if (prey) return this.fight(prey);

    // Pick up loot we can see.
    const loot = [...st.entities.values()].filter((e) => e.k === 'loot' && this.dist(e, me) <= 10).sort((a, b) => this.dist(a, me) - this.dist(b, me))[0];
    if (loot) {
      this.state = 'loot';
      if (this.dist(loot, me) <= 1) this.net.send({ t: 'interact' });
      else this.walkTo(loot);
      return;
    }

    // Full bag or out of potions: head to town.
    const full = (st.inv?.bag.filter(Boolean).length ?? 0) >= 17;
    if ((full || (!this.potion('health_potion') && me.gold >= 60)) && now - this.lastShopTrip > 120_000 && now - this.lastUnstuck > 6000 && !near.length) {
      this.lastShopTrip = now;
      this.lastUnstuck = now;
      this.state = 'trip-home';
      this.send('/unstuck');
      return;
    }

    // Deeper dungeons once strong enough.
    if (st.zone.id === 'wilds' && me.lv >= 6 && this.rng.chance(0.02)) {
      const stairs = this.findTile(T.STAIRS_DOWN);
      if (stairs) this.goal = stairs;
    }
    if (st.zone.id.startsWith('catacombs')) {
      if (this.goal && this.dist(this.goal, me) === 0) {
        const t = this.st.tileAt(me.x, me.y);
        if (t === T.STAIRS_DOWN && me.lv >= 10) { this.net.send({ t: 'stairs', dir: 'down' }); this.goal = null; }
      }
      if (me.lv >= 9 && this.rng.chance(0.01)) { const s = this.findTile(T.STAIRS_DOWN); if (s) this.goal = s; }
    }
    this.explore(now);
  }

  private findTile(tile: number): Vec2 | null {
    const z = this.st.zone!;
    for (let i = 0; i < z.known.length; i++) if (z.known[i] === tile + 1) return { x: i % z.w, y: Math.floor(i / z.w) };
    return null;
  }

  private explore(now: number): void {
    const me = this.me;
    const z = this.st.zone!;
    const pos = `${z.id}:${me.x},${me.y}`;
    if (pos !== this.lastPos) { this.lastPos = pos; this.stuckSince = now; }
    this.state = 'explore';
    // Standing still against an obstacle for a while: abandon this goal.
    if (now - this.stuckSince > 3500) {
      if (this.goal) this.blacklist.set(`${this.goal.x >> 3},${this.goal.y >> 3}`, now + 90_000);
      this.goal = null;
      this.stuckSince = now;
      this.net.send({ t: 'move', dx: this.rng.int(-1, 1) as -1 | 0 | 1, dy: this.rng.int(-1, 1) as -1 | 0 | 1 });
      return;
    }
    if (!this.goal || this.dist(this.goal, me) <= 1 || now > this.goalUntil) {
      if (this.goal && this.dist(this.goal, me) <= 2) this.blacklist.set(`${this.goal.x >> 3},${this.goal.y >> 3}`, now + 60_000);
      this.goal = this.frontier();
      this.goalUntil = now + 25_000;
      if (!this.goal) {
        // Nothing left to explore here: forget the map memory of blacklists and wander.
        this.blacklist.clear();
        this.net.send({ t: 'move', dx: this.rng.int(-1, 1) as -1 | 0 | 1, dy: this.rng.int(-1, 1) as -1 | 0 | 1 });
        return;
      }
    }
    if (!this.walkTo(this.goal)) { this.blacklist.set(`${this.goal.x >> 3},${this.goal.y >> 3}`, now + 90_000); this.goal = null; }
  }

  // ---- Combat -------------------------------------------------------------------------------
  private fight(prey: WireEntity): void {
    const me = this.me;
    const d = this.dist(prey, me);
    this.state = `fight ${prey.n}`;
    if (this.st.entities.get(me.target)?.id !== prey.id && me.target !== prey.id) this.net.send({ t: 'target', mode: 'next' });
    const cd = me.cd;
    const adjacent = d <= 1;
    const foesAdj = this.hostiles().filter((e) => this.dist(e, me) <= 1).length;
    switch (me.cls) {
      case 'vanguard':
        if (foesAdj >= 2 && cd[1] === 0 && me.mp >= 15) this.net.send({ t: 'skill', slot: 2 });
        else if (adjacent && cd[0] === 0 && me.mp >= 8) this.net.send({ t: 'skill', slot: 1 });
        break;
      case 'arcanist':
        if (adjacent && cd[1] === 0 && me.mp >= 14) this.net.send({ t: 'skill', slot: 2 });
        else if (d >= 2 && d <= 7 && cd[0] === 0 && me.mp >= 12) this.net.send({ t: 'skill', slot: 1 });
        break;
      case 'shadowblade':
        if (!me.buffs.some((b) => b.id === 'stealth') && cd[1] === 0 && me.mp >= 10 && d <= 4 && me.hp < me.stats.maxHp * 0.7) this.net.send({ t: 'skill', slot: 2 });
        else if (adjacent && cd[0] === 0 && me.mp >= 6) this.net.send({ t: 'skill', slot: 1 });
        break;
    }
    // Casters keep their distance while the nova/fireball recharge.
    if (me.cls === 'arcanist' && adjacent && cd[1] > 0 && me.hp < me.stats.maxHp * 0.6) {
      this.net.send({ t: 'move', dx: Math.sign(me.x - prey.x) as -1 | 0 | 1, dy: Math.sign(me.y - prey.y) as -1 | 0 | 1 });
      return;
    }
    if (me.cls === 'arcanist' && d >= 2 && d <= 6 && (cd[0] === 0 || me.mp >= 12)) return; // stand and cast
    if (adjacent) this.net.send({ t: 'move', dx: Math.sign(prey.x - me.x) as -1 | 0 | 1, dy: Math.sign(prey.y - me.y) as -1 | 0 | 1 });
    else if (!this.walkTo(prey)) this.explore(Date.now());
  }

  // ---- Town ---------------------------------------------------------------------------------
  private townTick(hpFrac: number): void {
    const me = this.me;
    const now = Date.now();
    if (hpFrac < 0.7 || me.mp < me.stats.maxMp * 0.5) { this.state = 'rest'; return; } // town regen is fast
    const bag = this.st.inv?.bag ?? [];
    const junk = bag.some((i) => i && (i.slot === 'material' || (i.slot !== 'consumable' && !this.isUpgradeCandidate(i))));
    // Sell junk at the smith, then buy potions at the alchemist, then head out.
    if (this.shopping === 'none' && now > this.shopDoneAt) {
      if (junk) this.shopping = 'smith';
      else if (me.gold >= 30 && (this.countPotions('health_potion') < 4)) this.shopping = 'alchemist';
    }
    if (this.shopping === 'smith') { this.state = 'to-smith'; if (this.dist(me, SMITH) > 1) { this.walkTo(SMITH, true); return; } this.net.send({ t: 'move', dx: Math.sign(SMITH.x - me.x) as -1 | 0 | 1, dy: Math.sign(SMITH.y - me.y) as -1 | 0 | 1 }); return; }
    if (this.shopping === 'alchemist') { this.state = 'to-alchemist'; if (this.dist(me, ALCHEMIST) > 1) { this.walkTo(ALCHEMIST, true); return; } this.net.send({ t: 'move', dx: Math.sign(ALCHEMIST.x - me.x) as -1 | 0 | 1, dy: Math.sign(ALCHEMIST.y - me.y) as -1 | 0 | 1 }); return; }

    this.state = 'to-gate';
    if (!this.walkTo(TOWN_GATE, true)) this.net.send({ t: 'move', dx: 0, dy: -1 });
  }

  private countPotions(base: string): number {
    return (this.st.inv?.bag ?? []).reduce((n, i) => n + (i?.base === base ? i.qty : 0), 0);
  }

  private isUpgradeCandidate(it: Item): boolean {
    if (!EQUIP_SLOTS.includes(it.slot as EquipSlot)) return false;
    const cur = this.st.inv?.equip[it.slot as EquipSlot];
    return !cur || itemScore(it) > itemScore(cur);
  }

  private shopTick(): void {
    const shop = this.st.shop!;
    const me = this.me;
    const bag = this.st.inv?.bag ?? [];
    this.shopDoneAt = Date.now() + 60_000;
    if (this.shopping === 'smith' || shop.npc.includes('Brannoc')) {
      const idx = bag.findIndex((i) => i && (i.slot === 'material' || (i.slot !== 'consumable' && !this.isUpgradeCandidate(i))));
      if (idx >= 0) { this.net.send({ t: 'shop', op: 'sell', index: idx }); return; }
      // Buy an armour/weapon upgrade if affordable.
      const best = shop.stock.map((e, i) => ({ e, i })).filter(({ e }) => e.price <= me.gold - 40 && this.isUpgradeCandidate(e.item))
        .sort((a, b) => itemScore(b.e.item) - itemScore(a.e.item))[0];
      if (best && bag.some((i) => i === null)) { this.net.send({ t: 'shop', op: 'buy', index: best.i }); return; }
    } else {
      const tier = me.lv >= 16 ? 3 : me.lv >= 10 ? 2 : me.lv >= 5 ? 1 : 0;
      const hp = shop.stock[tier], mp = shop.stock[4 + tier];
      if (hp && me.gold >= hp.price + 10 && this.countPotions('health_potion') < 6) { this.net.send({ t: 'shop', op: 'buy', index: tier }); return; }
      if (mp && me.cls !== 'vanguard' && me.gold >= mp.price + 10 && this.countPotions('mana_potion') < 4) { this.net.send({ t: 'shop', op: 'buy', index: 4 + tier }); return; }
    }
    this.net.send({ t: 'shop', op: 'close' });
    this.st.shop = null;
    this.shopping = 'none';
  }

  private maybeEquip(): void {
    const inv = this.st.inv;
    if (!inv) return;
    const sig = inv.bag.map((i) => i?.uid ?? '-').join(',');
    if (sig === this.lastEquipCheck) return;
    this.lastEquipCheck = sig;
    inv.bag.forEach((it, slot) => {
      if (it && this.isUpgradeCandidate(it)) { this.net.send({ t: 'inv', op: 'equip', slot }); this.lastEquipCheck = ''; }
    });
  }

  report(): BotReport {
    const me = this.st.me;
    return {
      name: this.name, cls: this.cls, level: me?.lv ?? 0, zone: this.st.zone?.id ?? '-', hp: me ? `${me.hp}/${me.stats.maxHp}` : '-',
      gold: me?.gold ?? 0, kills: this.kills, deaths: this.deaths, state: this.state,
    };
  }
}

export function startBots(url: string, count: number, quiet = false): { bots: Bot[]; stop: () => void } {
  const bots: Bot[] = [];
  for (let i = 0; i < count; i++) {
    const b = new Bot(i, url);
    bots.push(b);
    setTimeout(() => b.connect(), i * 600);
  }
  const reporter = setInterval(() => {
    if (quiet) return;
    const online = bots.filter((b) => b.st.authed).length;
    console.log(`[bots] ${online}/${count} online`);
    for (const b of bots) {
      const r = b.report();
      console.log(`  ${r.name.padEnd(14)} ${r.cls.padEnd(11)} L${String(r.level).padEnd(2)} ${r.zone.padEnd(11)} hp ${r.hp.padEnd(9)} ${String(r.gold).padStart(5)}g  ${r.state}`);
    }
  }, 30_000);
  return { bots, stop: () => { clearInterval(reporter); for (const b of bots) b.stop(); } };
}

// ---- CLI ----------------------------------------------------------------------------------------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const url = arg('url') ?? process.env.AETHER_URL ?? `ws://localhost:${process.env.PORT ?? DEFAULT_PORT}/ws`;
  const count = Number(arg('count') ?? process.env.BOTS ?? 10);
  console.log(`[bots] spawning ${count} AI players -> ${url}`);
  const { stop } = startBots(url, count);
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
}
