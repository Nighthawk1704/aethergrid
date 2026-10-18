// A fixed-size character-cell framebuffer. Both clients render into this and then blit it
// (TUI: diffed ANSI output; web: canvas fillText).
import { C, scale, type Rgb } from '../colors';

export const ATTR = { BOLD: 1, DIM: 2, UNDERLINE: 4, REVERSE: 8 } as const;
export const KEEP = -1;

export class Screen {
  readonly ch: string[];
  readonly fg: Int32Array;
  readonly bg: Int32Array;
  readonly at: Uint8Array;

  constructor(readonly w: number, readonly h: number) {
    this.ch = new Array<string>(w * h).fill(' ');
    this.fg = new Int32Array(w * h).fill(C.text);
    this.bg = new Int32Array(w * h).fill(C.black);
    this.at = new Uint8Array(w * h);
  }

  clear(bg: Rgb = C.black): void {
    this.ch.fill(' ');
    this.fg.fill(C.text);
    this.bg.fill(bg);
    this.at.fill(0);
  }

  /** Darken everything (used behind modal windows). */
  dim(k: number): void {
    for (let i = 0; i < this.fg.length; i++) {
      this.fg[i] = scale(this.fg[i]!, k);
      this.bg[i] = scale(this.bg[i]!, k);
    }
  }

  inside(x: number, y: number): boolean { return x >= 0 && y >= 0 && x < this.w && y < this.h; }

  /** Set one cell. `bg = KEEP` leaves the existing background (for glyphs over a coloured cell). */
  set(x: number, y: number, ch: string, fg: Rgb, bg: number = KEEP, attr = 0): void {
    if (!this.inside(x, y)) return;
    const i = y * this.w + x;
    this.ch[i] = ch;
    this.fg[i] = fg;
    if (bg !== KEEP) this.bg[i] = bg;
    this.at[i] = attr;
  }

  text(x: number, y: number, s: string, fg: Rgb, bg: number = KEEP, attr = 0): void {
    for (let i = 0; i < s.length; i++) this.set(x + i, y, s[i]!, fg, bg, attr);
  }

  /** Right-aligned text ending at column x (inclusive). */
  textRight(x: number, y: number, s: string, fg: Rgb, bg: number = KEEP, attr = 0): void {
    this.text(x - s.length + 1, y, s, fg, bg, attr);
  }

  center(x: number, w: number, y: number, s: string, fg: Rgb, bg: number = KEEP, attr = 0): void {
    this.text(x + Math.max(0, Math.floor((w - s.length) / 2)), y, s, fg, bg, attr);
  }

  fill(x: number, y: number, w: number, h: number, bg: Rgb, ch = ' ', fg: Rgb = C.text): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, ch, fg, bg, 0);
  }

  /** Single-line box with an optional title embedded in the top edge. */
  box(x: number, y: number, w: number, h: number, fg: Rgb, title = '', titleFg: Rgb = C.borderBright, bg: number = KEEP): void {
    const set = (xx: number, yy: number, c: string): void => this.set(xx, yy, c, fg, bg, 0);
    for (let xx = x + 1; xx < x + w - 1; xx++) { set(xx, y, '─'); set(xx, y + h - 1, '─'); }
    for (let yy = y + 1; yy < y + h - 1; yy++) { set(x, yy, '│'); set(x + w - 1, yy, '│'); }
    set(x, y, '┌'); set(x + w - 1, y, '┐'); set(x, y + h - 1, '└'); set(x + w - 1, y + h - 1, '┘');
    if (title) this.text(x + 2, y, ` ${title} `, titleFg, bg);
  }

  /** Horizontal bar: `frac` of the width filled with `fg`, the rest `empty`. */
  bar(x: number, y: number, w: number, frac: number, fg: Rgb, empty: Rgb, bg: number = KEEP): void {
    const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
    const filled = Math.round(f * w);
    for (let i = 0; i < w; i++) this.set(x + i, y, i < filled ? '█' : '░', i < filled ? fg : empty, bg);
  }

  /** Plain-text dump (for tests and debugging). */
  dump(): string {
    const rows: string[] = [];
    for (let y = 0; y < this.h; y++) rows.push(this.ch.slice(y * this.w, (y + 1) * this.w).join('').replace(/\s+$/, ''));
    return rows.join('\n');
  }
}
