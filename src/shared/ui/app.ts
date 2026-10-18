// GameApp: the whole client minus the host environment. A host (terminal or browser) feeds it key
// events and a clock, and blits `render()` to the screen.
import { NAME_MAX, PASSWORD_MAX, SCREEN_H, SCREEN_W } from '../constants';
import { NAME_RE } from '../protocol';
import { CLASS_IDS } from '../gamedata';
import { ClientState } from '../client/state';
import { NetClient, type ClientMsg } from '../client/net';
import { C } from '../colors';
import { isPrintable, type KeyEvent } from './keys';
import { drawLogin, formClass, newLoginForm, type LoginForm } from './login';
import { activeModal, drawModal, modalKey, newUiState, type ModalHost } from './modals';
import { CHAT_TABS, chatTabsOf, drawChat, drawMinimap, drawStats, drawViewport, type RenderCtx } from './panels';
import { Screen } from './screen';
import type { ClassId } from '../types';

export interface Credentials { name: string; password: string; register?: boolean; cls?: ClassId }

export interface AppOptions {
  url: string;
  /** Clock in ms; defaults to Date.now. */
  now?: () => number;
  /** Log in automatically as soon as the connection opens. */
  credentials?: Credentials;
  /** Called when the user signs in successfully (hosts may remember the name). */
  onLogin?: (name: string) => void;
  initialName?: string;
}

export class GameApp {
  st: ClientState;
  readonly net: NetClient;
  readonly screen = new Screen(SCREEN_W, SCREEN_H);
  private readonly overlay = new Screen(SCREEN_W, SCREEN_H);
  readonly ui = newUiState();
  readonly form: LoginForm = newLoginForm();

  chatTab = 0;
  chatFocus = false;
  chatInput = '';
  chatScroll = 0;
  readonly unread = [false, false, false, false];
  private readonly history: string[] = [];
  private histIdx = -1;
  private seenChat = 0;
  private lastMove = 0;
  private wantCreds: Credentials | null;
  private lastCreds: Credentials | null = null;

  status = 'Connecting...';
  closedReason = '';
  open = false;
  quit = false;
  private readonly now: () => number;

  constructor(private readonly opts: AppOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.st = new ClientState(this.now);
    this.wantCreds = opts.credentials ?? null;
    if (opts.initialName) this.form.name = opts.initialName;
    this.net = new NetClient({
      onPacket: (p) => {
        this.st.apply(p);
        if (p.t === 'hello') this.onHello();
        if (p.t === 'auth' && p.ok) this.opts.onLogin?.(p.name);
      },
      onOpen: () => { this.open = true; this.status = 'Connected.'; },
      onClose: (reason) => { this.open = false; this.closedReason = reason; this.status = `Disconnected: ${reason}`; },
    });
  }

  // ---- Connection -------------------------------------------------------------------------
  connect(): void {
    this.status = `Connecting to ${this.opts.url} ...`;
    this.closedReason = '';
    this.st = new ClientState(this.now);
    this.seenChat = 0;
    this.net.connect(this.opts.url);
  }

  private onHello(): void {
    if (this.wantCreds) {
      this.sendLogin(this.wantCreds);
      this.wantCreds = null;
    } else if (this.lastCreds && this.st.kicked === '') {
      // Reconnect after a drop: sign back in silently.
      this.sendLogin(this.lastCreds);
    }
  }

  private sendLogin(c: Credentials): void {
    this.lastCreds = c;
    if (c.register) this.net.send({ t: 'register', name: c.name, password: c.password, cls: c.cls ?? 'vanguard' });
    else this.net.send({ t: 'login', name: c.name, password: c.password });
  }

  send(msg: ClientMsg): void { this.net.send(msg); }

  get inGame(): boolean { return this.st.authed; }
  get disconnected(): boolean { return !this.open && (this.st.authed || this.closedReason !== ''); }

  // ---- Per-frame update ---------------------------------------------------------------------
  /** Call roughly every 100 ms. */
  update(ticks = 1): void {
    this.st.advance(ticks);
    this.st.pruneFx(1200);
    // Unread markers for chat tabs other than the active one.
    const fresh = this.st.chatTotal - this.seenChat;
    if (fresh > 0) {
      const lines = this.st.chat.slice(-Math.min(fresh, this.st.chat.length));
      for (const l of lines) {
        for (const t of chatTabsOf(l.chan)) if (t !== this.chatTab) this.unread[t] = true;
      }
      this.seenChat = this.st.chatTotal;
    }
    if (!this.st.trade && (this.ui.tradeOffer.size || this.ui.tradeGold)) { this.ui.tradeOffer.clear(); this.ui.tradeGold = 0; }
  }

  // ---- Rendering ----------------------------------------------------------------------------
  /** The shared panels' render context (also used by hosts that compose their own layout). */
  renderCtx(now = this.now()): RenderCtx {
    return {
      st: this.st, now, chatTab: this.chatTab, chatFocus: this.chatFocus, chatInput: this.chatInput,
      unread: this.unread, latency: this.net.latency, chatScroll: this.chatScroll,
    };
  }

  /** Modal windows and the disconnect notice only, on an otherwise blank (black) 100x34 screen. */
  renderOverlay(): Screen | null {
    const modal = activeModal(this.st, this.ui) !== 'none';
    const lost = this.disconnected || !!this.st.kicked;
    if (!modal && !lost) return null;
    const s = this.overlay;
    s.clear(C.black);
    if (modal) drawModal(s, this.st, this.ui);
    if (lost) this.drawDisconnected(s);
    return s;
  }

  private drawDisconnected(s: Screen): void {
    const msg = this.st.kicked || `Connection lost (${this.closedReason || 'unknown'})`;
    s.fill(20, 13, 60, 7, 0x200808);
    s.box(20, 13, 60, 7, C.brightRed, 'Disconnected', C.brightRed, 0x200808);
    s.center(20, 60, 15, msg.slice(0, 56), C.white, 0x200808);
    s.center(20, 60, 17, 'Press R to reconnect, Ctrl+C to quit', C.dim, 0x200808);
  }

  render(): Screen {
    const s = this.screen;
    s.clear(C.black);
    const now = this.now();
    if (!this.st.authed) {
      drawLogin(s, this.form, now, this.status, this.st.authError);
      return s;
    }
    const ctx = this.renderCtx(now);
    drawViewport(s, ctx);
    drawStats(s, ctx);
    drawMinimap(s, ctx);
    drawChat(s, ctx);
    if (activeModal(this.st, this.ui) !== 'none') s.dim(0.35);
    drawModal(s, this.st, this.ui);
    if (this.disconnected || this.st.kicked) this.drawDisconnected(s);
    return s;
  }

  // ---- Input --------------------------------------------------------------------------------
  handleKey(k: KeyEvent): void {
    if (k.ctrl && (k.key === 'c' || k.key === 'C')) { this.quit = true; return; }
    if (!this.st.authed) {
      if (this.disconnected && (k.key === 'r' || k.key === 'R') && !this.form.name) return this.connect();
      return this.loginKey(k);
    }
    if (this.disconnected || this.st.kicked) {
      if (k.key === 'r' || k.key === 'R') { this.st.kicked = ''; this.connect(); }
      return;
    }
    const host: ModalHost = { st: this.st, ui: this.ui, send: (m) => this.send(m) };
    if (activeModal(this.st, this.ui) !== 'none') { modalKey(host, k); return; }
    if (this.chatFocus) return this.chatKey(k);
    this.gameKey(k);
  }

  private loginKey(k: KeyEvent): void {
    const f = this.form;
    const fields = f.register ? 4 : 3;
    switch (k.key) {
      case 'Tab': case 'ArrowDown': f.field = (f.field + 1) % fields; return;
      case 'ArrowUp': f.field = (f.field + fields - 1) % fields; return;
      case 'ArrowLeft': case 'ArrowRight': {
        if (f.field === 0) f.register = !f.register;
        else if (f.field === 3) f.cls = (f.cls + (k.key === 'ArrowRight' ? 1 : CLASS_IDS.length - 1)) % CLASS_IDS.length;
        return;
      }
      case 'Backspace':
        if (f.field === 1) f.name = f.name.slice(0, -1);
        else if (f.field === 2) f.pass = f.pass.slice(0, -1);
        return;
      case 'Enter': return this.submitLogin();
    }
    if (!isPrintable(k)) return;
    if (f.field === 1 && f.name.length < NAME_MAX && /[A-Za-z0-9_]/.test(k.key)) f.name += k.key;
    else if (f.field === 2 && f.pass.length < PASSWORD_MAX) f.pass += k.key;
    else if (f.field === 0 && (k.key === ' ')) f.register = !f.register;
  }

  private submitLogin(): void {
    const f = this.form;
    this.st.authError = '';
    if (!this.open) { this.st.authError = 'Not connected to the server yet.'; return; }
    if (f.name.length < 3 || !NAME_RE.test(f.name)) { this.st.authError = 'Name: 3-16 characters, letters/digits/_, starting with a letter.'; return; }
    if (f.pass.length < (f.register ? 4 : 1)) { this.st.authError = 'Password must be at least 4 characters.'; return; }
    this.status = 'Signing in...';
    this.sendLogin({ name: f.name, password: f.pass, register: f.register, cls: formClass(f) });
  }

  private chatKey(k: KeyEvent): void {
    switch (k.key) {
      case 'Escape': this.chatFocus = false; this.chatInput = ''; this.histIdx = -1; return;
      case 'Enter': {
        const text = this.chatInput.trim();
        if (text) {
          this.send({ t: 'chat', text });
          if (this.history[0] !== text) this.history.unshift(text);
          if (this.history.length > 30) this.history.pop();
        }
        this.chatFocus = false; this.chatInput = ''; this.histIdx = -1;
        return;
      }
      case 'Backspace': this.chatInput = this.chatInput.slice(0, -1); return;
      case 'Tab': this.setChatTab((this.chatTab + 1) % CHAT_TABS.length); return;
      case 'ArrowUp':
        if (this.history.length) { this.histIdx = Math.min(this.history.length - 1, this.histIdx + 1); this.chatInput = this.history[this.histIdx]!; }
        return;
      case 'ArrowDown':
        this.histIdx = Math.max(-1, this.histIdx - 1);
        this.chatInput = this.histIdx >= 0 ? this.history[this.histIdx]! : '';
        return;
      case 'PageUp': this.chatScroll += 4; return;
      case 'PageDown': this.chatScroll = Math.max(0, this.chatScroll - 4); return;
    }
    if (isPrintable(k) && this.chatInput.length < 200) this.chatInput += k.key;
  }

  setChatTab(i: number): void {
    this.chatTab = (i + CHAT_TABS.length) % CHAT_TABS.length;
    this.unread[this.chatTab] = false;
    this.chatScroll = 0;
  }

  private move(dx: -1 | 0 | 1, dy: -1 | 0 | 1): void {
    const t = this.now();
    if (t - this.lastMove < 45) return; // key-repeat can outpace the 10 Hz server; no use flooding it
    this.lastMove = t;
    this.send({ t: 'move', dx, dy });
  }

  /** Public so hosts with real key-up events (browser) can drive continuous movement. */
  moveDir(dx: -1 | 0 | 1, dy: -1 | 0 | 1): void { this.move(dx, dy); }

  private gameKey(k: KeyEvent): void {
    switch (k.key) {
      case 'ArrowUp': case 'w': case 'W': return this.move(0, -1);
      case 'ArrowDown': case 's': case 'S': return this.move(0, 1);
      case 'ArrowLeft': case 'a': case 'A': return this.move(-1, 0);
      case 'ArrowRight': case 'd': case 'D': return this.move(1, 0);
      case 'q': case 'Q': case 'Home': return this.move(-1, -1);
      case 'z': case 'Z': case 'End': return this.move(-1, 1);
      case 'E': return this.move(1, -1); // Shift+E (plain e interacts)
      case 'C': return this.move(1, 1); // Shift+C (plain c opens the sheet)
      case ' ': case 'e': return this.send({ t: 'interact' });
      case '>': case '.': return this.send({ t: 'stairs', dir: 'down' });
      case '<': case ',': return this.send({ t: 'stairs', dir: 'up' });
      case '1': case '2': case '3': case '4': return this.send({ t: 'skill', slot: Number(k.key) as 1 | 2 | 3 | 4 });
      case 'Tab': return this.send({ t: 'target', mode: 'next' });
      case 'Escape': this.send({ t: 'target', mode: 'clear' }); return;
      case 'i': case 'I': this.ui.modal = 'inventory'; return;
      case 'c': this.ui.modal = 'character'; return;
      case '?': case 'h': case 'H': this.ui.modal = 'help'; return;
      case '[': return this.setChatTab(this.chatTab - 1);
      case ']': return this.setChatTab(this.chatTab + 1);
      case 'PageUp': this.chatScroll += 4; return;
      case 'PageDown': this.chatScroll = Math.max(0, this.chatScroll - 4); return;
      case 'Enter': this.chatFocus = true; this.chatScroll = 0; this.unread[this.chatTab] = false; return;
      case '/': this.chatFocus = true; this.chatInput = '/'; return;
    }
  }
}

