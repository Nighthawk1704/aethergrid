// Double-buffered ANSI renderer: remembers the previous frame and emits only what changed.
import { unpack, type Rgb } from '../shared/colors';
import { ATTR, Screen } from '../shared/ui/screen';

/** Nearest xterm-256 colour for terminals without truecolor. */
export function rgbTo256(c: Rgb): number {
  const [r, g, b] = unpack(c);
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 23);
  }
  const q = (v: number): number => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

export class AnsiRenderer {
  private prevCh: string[] = [];
  private prevFg = new Int32Array(0);
  private prevBg = new Int32Array(0);
  private prevAt = new Uint8Array(0);
  private valid = false;
  private curFg = -2;
  private curBg = -2;
  private curAt = -1;

  constructor(private readonly trueColor: boolean) {}

  /** Force a full repaint on the next frame (after a resize, say). */
  invalidate(): void { this.valid = false; }

  private colour(code: 38 | 48, c: Rgb): string {
    if (this.trueColor) {
      const [r, g, b] = unpack(c);
      return `${code};2;${r};${g};${b}`;
    }
    return `${code};5;${rgbTo256(c)}`;
  }

  private sgr(fg: number, bg: number, at: number): string {
    if (fg === this.curFg && bg === this.curBg && at === this.curAt) return '';
    this.curFg = fg; this.curBg = bg; this.curAt = at;
    const p = ['0'];
    if (at & ATTR.BOLD) p.push('1');
    if (at & ATTR.DIM) p.push('2');
    if (at & ATTR.UNDERLINE) p.push('4');
    if (at & ATTR.REVERSE) p.push('7');
    p.push(this.colour(38, fg), this.colour(48, bg));
    return `\x1b[${p.join(';')}m`;
  }

  /**
   * Produce the escape sequences that turn the previous frame into `s`, drawn at terminal offset
   * (offX, offY) (0-based). The whole update is wrapped in a synchronized-output block so terminals
   * that support it never show a half-drawn frame.
   */
  frame(s: Screen, offX = 0, offY = 0): string {
    const n = s.w * s.h;
    let out = '';
    if (!this.valid || this.prevCh.length !== n) {
      this.prevCh = new Array<string>(n).fill('\0');
      this.prevFg = new Int32Array(n).fill(-1);
      this.prevBg = new Int32Array(n).fill(-1);
      this.prevAt = new Uint8Array(n).fill(255);
      this.valid = true;
      this.curFg = this.curBg = -2; this.curAt = -1;
      out += '\x1b[0m\x1b[2J';
    }
    let cursorX = -1, cursorY = -1;
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) {
        const i = y * s.w + x;
        const ch = s.ch[i]!, fg = s.fg[i]!, bg = s.bg[i]!, at = s.at[i]!;
        // A space only shows its background, so foreground/attribute changes are invisible.
        const same = this.prevCh[i] === ch && this.prevBg[i] === bg
          && (ch === ' ' || (this.prevFg[i] === fg && this.prevAt[i] === at));
        if (same) continue;
        this.prevCh[i] = ch; this.prevFg[i] = fg; this.prevBg[i] = bg; this.prevAt[i] = at;
        if (cursorY !== y || cursorX !== x) out += `\x1b[${offY + y + 1};${offX + x + 1}H`;
        // Spaces only show their background, so reuse whatever foreground/attributes are already active.
        let f = fg, a = at;
        if (ch === ' ') {
          f = this.curFg >= 0 ? this.curFg : fg;
          a = this.curAt >= 0 ? this.curAt & ~(ATTR.UNDERLINE | ATTR.REVERSE) : 0;
        }
        out += this.sgr(f, bg, a) + ch;
        cursorX = x + 1; cursorY = y;
      }
    }
    if (!out) return '';
    // The frame ends with an SGR reset, so the terminal's state no longer matches our cache.
    this.curFg = this.curBg = -2;
    this.curAt = -1;
    return `\x1b[?2026h${out}\x1b[0m\x1b[?2026l`;
  }
}
