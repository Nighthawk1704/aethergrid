// Network layer shared by the TUI, the browser and the bots. Uses the standard WebSocket API
// (global in browsers and in Node >= 22).
import { decodeServer, encode, type ClientPacket, type ServerPacket } from '../protocol';

/** Client packet without the sequence id (stamped on send). */
type DistOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type ClientMsg = DistOmit<ClientPacket, 's'>;

export interface NetEvents {
  onPacket(p: ServerPacket): void;
  onOpen?(): void;
  onClose?(reason: string): void;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  latency = 0;

  constructor(private readonly events: NetEvents) {}

  get connected(): boolean { return this.ws?.readyState === 1; }

  connect(url: string): void {
    this.close();
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.events.onOpen?.();
      this.pingTimer = setInterval(() => this.send({ t: 'ping', ts: Date.now() }), 5000);
    };
    ws.onmessage = (ev: MessageEvent) => {
      const p = decodeServer(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (!p) return;
      if (p.t === 'pong') this.latency = Math.max(0, Date.now() - p.ts);
      this.events.onPacket(p);
    };
    ws.onclose = (ev: CloseEvent) => {
      this.cleanup();
      this.events.onClose?.(ev.reason || `closed (${ev.code})`);
    };
    ws.onerror = () => { /* close event follows */ };
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState !== 1) return;
    this.ws.send(encode({ ...msg, s: ++this.seq } as ClientPacket));
  }

  close(): void {
    const ws = this.ws;
    this.cleanup();
    if (ws && ws.readyState <= 1) ws.close();
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws = null;
  }
}
