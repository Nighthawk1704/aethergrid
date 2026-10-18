// Cached glyph sprites (drawImage is much cheaper than thousands of fillText calls per frame) and a
// painter that blits the shared character-cell Screen onto a canvas, with optional translucency.
import { ATTR, Screen } from '../../shared/ui/screen';

export type MakeCanvas = (w: number, h: number) => HTMLCanvasElement;

export const FONT_FAMILY = '"Cascadia Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace';

/** Colours are quantized to 4 bits per channel so the sprite cache stays small. */
const quant = (c: number): number => (c & 0xf0f0f0) | ((c >> 4) & 0x0f0f0f);
const cssOf = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;

const PAGE = 1024;
const MAX_PAGES = 6;

/**
 * Glyph sprites packed into a few shared pages. One texture per page (instead of one canvas per glyph)
 * keeps creation cheap and lets the GPU batch the drawImage calls that dominate a frame.
 */
export class GlyphAtlas {
  private readonly pages: { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D }[] = [];
  private readonly slots = new Map<string, number>();
  private readonly perRow: number;
  private readonly perPage: number;
  private next = 0;

  constructor(private readonly make: MakeCanvas, readonly cw: number, readonly ch: number, readonly fontPx: number) {
    this.perRow = Math.max(1, Math.floor(PAGE / cw));
    this.perPage = this.perRow * Math.max(1, Math.floor(PAGE / ch));
  }

  private slot(glyph: string, color: number, bold: boolean): number {
    const q = quant(color);
    const key = `${glyph}${q.toString(16)}${bold ? 'b' : ''}`;
    let idx = this.slots.get(key);
    if (idx !== undefined) return idx;
    if (this.next >= this.perPage * MAX_PAGES) { this.slots.clear(); this.next = 0; }
    idx = this.next++;
    const pageNo = Math.floor(idx / this.perPage);
    let page = this.pages[pageNo];
    if (!page) {
      const canvas = this.make(PAGE, PAGE);
      page = { canvas, g: canvas.getContext('2d')! };
      this.pages[pageNo] = page;
    }
    const local = idx % this.perPage;
    const x = (local % this.perRow) * this.cw, y = Math.floor(local / this.perRow) * this.ch;
    const g = page.g;
    g.clearRect(x, y, this.cw, this.ch);
    g.save();
    g.beginPath();
    g.rect(x, y, this.cw, this.ch);
    g.clip();
    g.font = `${bold ? 'bold ' : ''}${this.fontPx}px ${FONT_FAMILY}`;
    g.textBaseline = 'alphabetic';
    g.fillStyle = cssOf(q);
    g.fillText(glyph, x, y + Math.round(this.ch * 0.5 + this.fontPx * 0.34));
    g.restore();
    this.slots.set(key, idx);
    return idx;
  }

  draw(g: CanvasRenderingContext2D, glyph: string, color: number, x: number, y: number, bold = false): void {
    if (glyph === ' ') return;
    const idx = this.slot(glyph, color, bold);
    const local = idx % this.perPage;
    g.drawImage(this.pages[Math.floor(idx / this.perPage)]!.canvas, (local % this.perRow) * this.cw, Math.floor(local / this.perRow) * this.ch, this.cw, this.ch, x, y, this.cw, this.ch);
  }
}

export interface PaintOptions {
  /** Alpha used for non-black cell backgrounds. */
  bgAlpha: number;
  /** Treat pure-black backgrounds as transparent. */
  clearBlack: boolean;
  alpha: number;
}

/** Draws box-drawing and block glyphs as geometry so borders and bars join seamlessly. */
function geometry(g: CanvasRenderingContext2D, ch: string, px: number, py: number, cw: number, chh: number, fontPx: number): boolean {
  const mx = Math.floor(px + cw / 2), my = Math.floor(py + chh / 2);
  const t = Math.max(1, Math.round(fontPx / 12));
  switch (ch) {
    case '█': g.fillRect(px, py, cw, chh); return true;
    case '░': { const a = g.globalAlpha; g.globalAlpha = a * 0.28; g.fillRect(px, py, cw, chh); g.globalAlpha = a; return true; }
    case '▓': { const a = g.globalAlpha; g.globalAlpha = a * 0.8; g.fillRect(px, py, cw, chh); g.globalAlpha = a; return true; }
    case '▒': { const a = g.globalAlpha; g.globalAlpha = a * 0.55; g.fillRect(px, py, cw, chh); g.globalAlpha = a; return true; }
    case '─': g.fillRect(px, my, cw, t); return true;
    case '│': g.fillRect(mx, py, t, chh); return true;
    case '┌': g.fillRect(mx, my, cw - (mx - px), t); g.fillRect(mx, my, t, chh - (my - py)); return true;
    case '┐': g.fillRect(px, my, mx - px + t, t); g.fillRect(mx, my, t, chh - (my - py)); return true;
    case '└': g.fillRect(mx, my, cw - (mx - px), t); g.fillRect(mx, py, t, my - py + t); return true;
    case '┘': g.fillRect(px, my, mx - px + t, t); g.fillRect(mx, py, t, my - py + t); return true;
  }
  return false;
}

export function paintScreen(g: CanvasRenderingContext2D, atlas: GlyphAtlas, s: Screen, dx: number, dy: number, o: PaintOptions): void {
  const { cw, ch, fontPx } = atlas;
  g.save();
  g.globalAlpha = o.alpha;
  for (let y = 0; y < s.h; y++) {
    let x = 0;
    while (x < s.w) {
      const bg = s.bg[y * s.w + x]!;
      let x2 = x + 1;
      while (x2 < s.w && s.bg[y * s.w + x2] === bg) x2++;
      if (!(o.clearBlack && bg === 0)) {
        g.globalAlpha = o.alpha * (bg === 0 ? 1 : o.bgAlpha);
        g.fillStyle = cssOf(bg);
        g.fillRect(dx + x * cw, dy + y * ch, (x2 - x) * cw, ch);
      }
      x = x2;
    }
  }
  g.globalAlpha = o.alpha;
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      const c = s.ch[i]!;
      if (c === ' ') continue;
      const at = s.at[i]!;
      const px = dx + x * cw, py = dy + y * ch;
      g.fillStyle = cssOf(s.fg[i]!);
      if (at & ATTR.DIM) g.globalAlpha = o.alpha * 0.6;
      if (!geometry(g, c, px, py, cw, ch, fontPx)) atlas.draw(g, c, s.fg[i]!, px, py, !!(at & ATTR.BOLD));
      if (at & ATTR.UNDERLINE) g.fillRect(px, py + ch - 2, cw, 1);
      if (at & ATTR.DIM) g.globalAlpha = o.alpha;
    }
  }
  g.restore();
}
