// CRT post-processing on the main canvas: fine scanlines, a vignette and a faint phosphor mask.
import type { MakeCanvas } from './atlas';

export class CrtPost {
  private scan: CanvasPattern | null = null;
  private vignette: HTMLCanvasElement | null = null;
  private W = 0;
  private H = 0;

  constructor(private readonly make: MakeCanvas) {}

  resize(W: number, H: number, dpr: number, g: CanvasRenderingContext2D): void {
    this.W = W; this.H = H;
    // Scanlines: one dark row every few device pixels.
    const period = Math.max(3, Math.round(2.2 * dpr) + 1);
    const p = this.make(1, period);
    const pg = p.getContext('2d')!;
    pg.fillStyle = 'rgba(0,0,0,0.26)';
    pg.fillRect(0, 0, 1, Math.max(1, Math.round(dpr * 0.9)));
    this.scan = g.createPattern(p, 'repeat');
    // Vignette, pre-rendered once per size.
    const v = this.make(W, H);
    const vg = v.getContext('2d')!;
    const grad = vg.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.hypot(W, H) * 0.56);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.6, 'rgba(0,0,6,0.22)');
    grad.addColorStop(1, 'rgba(0,0,8,0.72)');
    vg.fillStyle = grad;
    vg.fillRect(0, 0, W, H);
    this.vignette = v;
  }

  apply(g: CanvasRenderingContext2D, t: number): void {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    if (this.vignette) g.drawImage(this.vignette, 0, 0);
    if (this.scan) {
      g.fillStyle = this.scan;
      g.fillRect(0, 0, this.W, this.H);
    }
    // A barely-there brightness breathing, like an old tube.
    g.fillStyle = `rgba(160,200,255,${0.012 + 0.008 * Math.sin(t * 9)})`;
    g.globalCompositeOperation = 'screen';
    g.fillRect(0, 0, this.W, this.H);
    g.globalCompositeOperation = 'source-over';
  }
}
