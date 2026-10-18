// Client-side mirror of the world, built purely from server packets.
import { tileFromCode } from '../tiles';
import type { ServerPacket } from '../protocol';
import type {
  ChatChannel, FxEvent, InventoryView, Item, PartyMemberView, QuestView, SelfState, ShopEntry, TradeView, WireEntity, ZoneId,
} from '../types';

export interface ZoneMap {
  id: ZoneId;
  name: string;
  w: number;
  h: number;
  origin: { x: number; y: number };
  pvp: boolean;
  fov: number;
  depth: number;
  /** tile id + 1 per cell; 0 = never seen. */
  known: Uint8Array;
  /** 1 where currently in line of sight. */
  vis: Uint8Array;
}

export interface ChatLine { chan: ChatChannel; from: string; text: string; ts: number }
export interface ActiveFx extends FxEvent { born: number }

export interface ShopState { npc: string; stock: ShopEntry[]; sellRate: number }
export interface QuestState { npc: string; quests: QuestView[] }
export interface DialogState { npc: string; lines: string[]; options: { id: string; label: string }[] }

export const MAX_CHAT = 400;

export class ClientState {
  connected = false;
  authed = false;
  authError = '';
  kicked = '';
  myId = 0;
  tick = 0;
  me: SelfState | null = null;
  zone: ZoneMap | null = null;
  readonly maps = new Map<ZoneId, ZoneMap>();
  readonly entities = new Map<number, WireEntity>();
  inv: InventoryView | null = null;
  chat: ChatLine[] = [];
  /** Total chat lines ever received (the buffer itself is capped). */
  chatTotal = 0;
  party: PartyMemberView[] = [];
  fx: ActiveFx[] = [];

  shop: ShopState | null = null;
  bank: (Item | null)[] | null = null;
  quests: QuestState | null = null;
  trade: TradeView | null = null;
  dialog: DialogState | null = null;

  /**
   * Tile runs written since a renderer last drained this list: [zone, y, x, length]. Lets a renderer
   * rebuild only the terrain chunks that changed. Capped so an unused list cannot grow without bound.
   */
  tileUpdates: [ZoneId, number, number, number][] = [];

  /** Bumped on every state packet, lets renderers skip work when nothing changed. */
  revision = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  apply(p: ServerPacket): void {
    this.revision++;
    switch (p.t) {
      case 'hello': this.connected = true; break;
      case 'auth':
        if (p.ok) { this.authed = true; this.myId = p.id; this.authError = ''; } else this.authError = p.error;
        break;
      case 'zone': this.enterZone(p); break;
      case 'state': this.applyState(p); break;
      case 'inv': this.inv = { bag: p.bag, equip: p.equip, gold: p.gold }; break;
      case 'chat': this.addChat({ chan: p.chan, from: p.from, text: p.text, ts: p.ts }); break;
      case 'shop': this.shop = p.open ? { npc: p.npc, stock: p.stock, sellRate: p.sellRate } : null; break;
      case 'bank': this.bank = p.open ? p.items : null; break;
      case 'quests': this.quests = p.open ? { npc: p.npc, quests: p.quests } : null; break;
      case 'trade': this.trade = p.open ? p.trade ?? null : null; break;
      case 'dialog': this.dialog = { npc: p.npc, lines: p.lines, options: p.options }; break;
      case 'party': this.party = p.members; break;
      case 'error': this.addChat({ chan: 'system', from: 'Server', text: p.message, ts: this.now() }); break;
      case 'kick': this.kicked = p.reason; break;
      case 'pong': break;
    }
  }

  addChat(line: ChatLine): void {
    this.chatTotal++;
    this.chat.push(line);
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
  }

  private enterZone(p: Extract<ServerPacket, { t: 'zone' }>): void {
    let m = this.maps.get(p.zone);
    if (!m) {
      m = {
        id: p.zone, name: p.name, w: p.w, h: p.h, origin: p.origin, pvp: p.pvp, fov: p.fov, depth: p.depth,
        known: new Uint8Array(p.w * p.h), vis: new Uint8Array(p.w * p.h),
      };
      this.maps.set(p.zone, m);
    }
    m.vis.fill(0);
    this.zone = m;
    this.entities.clear();
    this.fx = [];
    this.shop = null; this.bank = null; this.quests = null; this.dialog = null;
  }

  private applyState(p: Extract<ServerPacket, { t: 'state' }>): void {
    this.tick = p.tick;
    if (p.you) this.me = { ...(this.me ?? ({} as SelfState)), ...p.you };
    const z = this.zone;
    if (p.despawn) for (const id of p.despawn) this.entities.delete(id);
    if (p.spawn) for (const e of p.spawn) this.entities.set(e.id, e);
    if (p.update) {
      for (const d of p.update) {
        const e = this.entities.get(d.id);
        if (e) Object.assign(e, d);
      }
    }
    if (z && p.tiles) {
      for (const [y, x, run] of p.tiles) {
        if (this.tileUpdates.length < 4000) this.tileUpdates.push([z.id, y, x, run.length]);
        for (let i = 0; i < run.length; i++) {
          if (x + i < z.w && y < z.h) z.known[y * z.w + x + i] = tileFromCode(run.charCodeAt(i)) + 1;
        }
      }
    }
    if (z && p.vis) {
      z.vis.fill(0);
      for (let i = 0; i < p.vis.length; i += 3) {
        const y = p.vis[i]!, x = p.vis[i + 1]!, len = p.vis[i + 2]!;
        z.vis.fill(1, y * z.w + x, y * z.w + x + len);
      }
    }
    if (p.fx) {
      const born = this.now();
      for (const f of p.fx) this.fx.push({ ...f, born });
    }
  }

  /** Count down server timers locally between packets (cooldowns, buffs). Call once per 100 ms. */
  advance(ticks = 1): void {
    const me = this.me;
    if (!me) return;
    if (me.cd) me.cd = me.cd.map((c) => Math.max(0, c - ticks)) as SelfState['cd'];
    if (me.buffs?.length) me.buffs = me.buffs.map((b) => ({ ...b, ticks: b.ticks - ticks })).filter((b) => b.ticks > 0);
  }

  pruneFx(maxAgeMs: number): void {
    const cutoff = this.now() - maxAgeMs;
    if (this.fx.length && this.fx[0]!.born < cutoff) this.fx = this.fx.filter((f) => f.born >= cutoff);
  }

  tileAt(x: number, y: number): number {
    const z = this.zone;
    if (!z || x < 0 || y < 0 || x >= z.w || y >= z.h) return -1;
    return z.known[y * z.w + x]! - 1;
  }

  isVisible(x: number, y: number): boolean {
    const z = this.zone;
    return !!z && x >= 0 && y >= 0 && x < z.w && y < z.h && z.vis[y * z.w + x] === 1;
  }
}
