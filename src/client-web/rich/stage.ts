// Composes one frame: world -> HUD -> modal overlay (with fade) -> CRT post. DOM-free, so it can be
// driven by the browser shell or by a headless canvas for testing.
import { SCREEN_H, SCREEN_W } from '../../shared/constants';
import type { GameApp } from '../../shared/ui/app';
import type { Screen } from '../../shared/ui/screen';
import { GlyphAtlas, paintScreen, type MakeCanvas } from './atlas';
import { Hud } from './hud';
import { CrtPost } from './post';
import { timeOfDay, type TimeMode } from './sky';
import { WorldRenderer } from './world';

export interface FrameOptions {
  timeMode: TimeMode;
  crt: boolean;
  fps: number;
  frameMs: number;
  /** Real-time origin of the day cycle. */
  t0: number;
}

export class Stage {
  readonly world: WorldRenderer;
  private readonly hud: Hud;
  private readonly post: CrtPost;
  private uiAtlas: GlyphAtlas;
  private ui = { cw: 8, ch: 16, x: 0, y: 0 };
  private fade = 0;
  private lastOverlay: Screen | null = null;
  private W = 0;
  private H = 0;

  constructor(private readonly g: CanvasRenderingContext2D, private readonly make: MakeCanvas) {
    this.world = new WorldRenderer(g, make);
    this.hud = new Hud(make);
    this.post = new CrtPost(make);
    this.uiAtlas = new GlyphAtlas(make, 8, 16, 13);
  }

  resize(W: number, H: number, dpr: number): void {
    this.W = W; this.H = H;
    this.world.resize(W, H, dpr);
    this.hud.resize(W, H, dpr, this.world.m.fontPx);
    this.post.resize(W, H, dpr, this.g);
    // The shared 100x34 UI (login, windows) is drawn as large as fits, centred.
    const cw = Math.max(5, Math.floor(Math.min((W * 0.96) / SCREEN_W, (H * 0.96) / SCREEN_H / 2.05)));
    const ch = Math.round(cw * 2.05);
    this.uiAtlas = new GlyphAtlas(this.make, cw, ch, Math.round(ch / 1.3));
    this.ui = { cw, ch, x: Math.floor((W - cw * SCREEN_W) / 2), y: Math.floor((H - ch * SCREEN_H) / 2) };
  }

  render(app: GameApp, nowMs: number, dt: number, tSec: number, o: FrameOptions): void {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;

    if (!app.inGame) {
      const bg = g.createLinearGradient(0, 0, 0, this.H);
      bg.addColorStop(0, '#04060f');
      bg.addColorStop(1, '#0a1222');
      g.fillStyle = bg;
      g.fillRect(0, 0, this.W, this.H);
      paintScreen(g, this.uiAtlas, app.render(), this.ui.x, this.ui.y, { bgAlpha: 1, clearBlack: true, alpha: 1 });
      if (o.crt) this.post.apply(g, tSec);
      return;
    }

    const tod = timeOfDay(nowMs, o.timeMode, o.t0);
    this.world.frame(app.st, nowMs, dt, tod, tSec);
    this.hud.draw(g, app, o.fps, o.frameMs, tod, o.timeMode, dt);

    // Windows fade the world down and slide in.
    const ov = app.renderOverlay();
    if (ov) this.lastOverlay = ov;
    this.fade += ((ov ? 1 : 0) - this.fade) * (1 - Math.exp(-dt * 12));
    if (this.fade > 0.015 && this.lastOverlay) {
      g.globalAlpha = 0.62 * this.fade;
      g.fillStyle = '#02040c';
      g.fillRect(0, 0, this.W, this.H);
      paintScreen(g, this.uiAtlas, this.lastOverlay, this.ui.x, this.ui.y + Math.round((1 - this.fade) * this.ui.ch * 1.2), { bgAlpha: 0.95, clearBlack: true, alpha: this.fade });
      g.globalAlpha = 1;
    } else if (!ov) this.lastOverlay = null;

    if (o.crt) this.post.apply(g, tSec);
  }
}
