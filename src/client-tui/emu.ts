// A minimal terminal emulator covering exactly what AnsiRenderer emits (cursor positioning, SGR,
// clear, mode toggles). Used to verify the renderer and to inspect real TUI sessions.
import { ATTR } from '../shared/ui/screen';

export interface Cell { ch: string; fg: number; bg: number; at: number }
export class Emu {
  cells: Cell[];
  x = 0; y = 0;
  fg = -1; bg = -1; at = 0;
  bytes = 0;
  constructor(readonly w: number, readonly h: number, readonly trueColor: boolean) {
    this.cells = Array.from({ length: w * h }, () => ({ ch: ' ', fg: -1, bg: -1, at: 0 }));
  }
  write(data: string): void {
    this.bytes += data.length;
    for (let i = 0; i < data.length; i++) {
      const c = data[i]!;
      if (c !== '\x1b') { this.put(c); continue; }
      const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(data.slice(i, i + 64));
      if (!m) throw new Error(`unexpected escape at ${i}: ${JSON.stringify(data.slice(i, i + 12))}`);
      i += m[0].length - 1;
      const p = m[1]!, f = m[2]!;
      if (f === 'H') { const [r, cc] = p.split(';').map(Number); this.y = (r ?? 1) - 1; this.x = (cc ?? 1) - 1; }
      else if (f === 'J') this.cells.forEach((cell) => { cell.ch = ' '; cell.fg = -1; cell.bg = -1; cell.at = 0; });
      else if (f === 'm') this.sgr(p === '' ? [0] : p.split(';').map(Number));
      else if (f === 'h' || f === 'l') { /* mode set/reset, ignored */ }
      else throw new Error(`unsupported CSI ${f}`);
    }
  }
  private put(ch: string): void {
    if (this.x >= this.w || this.y >= this.h) throw new Error(`wrote outside the screen at ${this.x},${this.y}`);
    const cell = this.cells[this.y * this.w + this.x]!;
    cell.ch = ch; cell.fg = this.fg; cell.bg = this.bg; cell.at = this.at;
    this.x++;
  }
  private sgr(p: number[]): void {
    for (let i = 0; i < p.length; i++) {
      const v = p[i]!;
      if (v === 0) { this.fg = -1; this.bg = -1; this.at = 0; }
      else if (v === 1) this.at |= ATTR.BOLD;
      else if (v === 2) this.at |= ATTR.DIM;
      else if (v === 4) this.at |= ATTR.UNDERLINE;
      else if (v === 7) this.at |= ATTR.REVERSE;
      else if (v === 38 || v === 48) {
        let col: number;
        if (p[i + 1] === 2) { col = ((p[i + 2]! & 255) << 16) | ((p[i + 3]! & 255) << 8) | (p[i + 4]! & 255); i += 4; }
        else { col = 1_000_000_000 + p[i + 2]!; i += 2; }
        if (v === 38) this.fg = col; else this.bg = col;
      }
    }
  }

  /** Visible text, one string per row. */
  text(): string {
    const rows: string[] = [];
    for (let y = 0; y < this.h; y++) rows.push(this.cells.slice(y * this.w, (y + 1) * this.w).map((c) => c.ch).join('').replace(/\s+$/, ''));
    return rows.join('\n');
  }
}
