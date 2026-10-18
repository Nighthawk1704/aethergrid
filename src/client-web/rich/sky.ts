// Day / night cycle and the crescent moon.
import { clamp01, hash2 } from './noise';

export type TimeMode = 'auto' | 'day' | 'night';

export interface TimeOfDay {
  /** 0 = full daylight, 1 = deepest night. */
  night: number;
  /** Clock hour 0..24. */
  hour: number;
}

/** One full day lasts this long in real time. */
export const DAY_MS = 10 * 60_000;
/** Where in the day the world starts, so a visitor sees dusk fall within seconds. */
const START_PHASE = 0.76;

export function timeOfDay(nowMs: number, mode: TimeMode, t0: number): TimeOfDay {
  if (mode === 'day') return { night: 0, hour: 12 };
  if (mode === 'night') return { night: 1, hour: 0 };
  const phase = (START_PHASE + (nowMs - t0) / DAY_MS) % 1;
  // phase 0.5 is noon; the deep-night plateau covers about a third of the day.
  const night = clamp01((Math.abs(phase - 0.5) - 0.17) / 0.15);
  return { night: night * night * (3 - 2 * night), hour: phase * 24 };
}

export const formatHour = (h: number): string => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;

export const MOON_R = 5;
export const MOON_W = MOON_R * 4 + 2;
export const MOON_H = MOON_R * 2 + 2;

/**
 * One cell of the pixelated crescent, at offset (dx, dy) cells from the moon's centre. Cells are twice
 * as tall as wide, so x is halved to get a circle. Returns null outside the lit crescent.
 */
export function moonCell(dx: number, dy: number): { ch: string; bright: number } | null {
  const x = dx / 2, y = dy;
  const R = MOON_R;
  const outer = Math.hypot(x, y);
  if (outer > R) return null;
  const cut = Math.hypot(x - 0.75 * R, y + 0.12 * R);
  const cutR = 0.92 * R;
  if (cut < cutR) return null;
  const edge = Math.min(R - outer, cut - cutR) / R; // 0 at either rim
  const b = clamp01(0.55 + edge * 1.6 + (hash2(dx, dy, 5) - 0.5) * 0.25);
  const ch = b > 0.9 ? '0' : b > 0.8 ? '%' : b > 0.68 ? 'O' : b > 0.55 ? 'o' : '.';
  return { ch, bright: b };
}
