/** 24-bit colors packed as 0xRRGGBB. */
export type Rgb = number;

export const C = {
  black: 0x000000,
  white: 0xffffff,
  brightWhite: 0xffffff,
  text: 0xc8c8c8,
  dim: 0x707070,
  dimmer: 0x444444,
  darkGray: 0x555555,
  floor: 0x4a4a4a,
  gray: 0x909090,
  silver: 0xc0c0c0,
  steel: 0x4682b4,
  red: 0xdd3030,
  brightRed: 0xff3030,
  green: 0x3fc43f,
  grassGreen: 0x2e9b3a,
  darkGreen: 0x1e6b28,
  blue: 0x2f6fe0,
  deepBlue: 0x1a3d8f,
  cyan: 0x40e0f0,
  yellow: 0xffe14a,
  gold: 0xffc700,
  brown: 0x9b6a35,
  darkBrown: 0x5e3f1f,
  magenta: 0xe040e0,
  orange: 0xff9020,
  purple: 0xa070ff,
  pink: 0xff80c0,
  panel: 0x0c0c12,
  border: 0x5a6a8a,
  borderBright: 0x9ab0e0,
  hpRed: 0xd23c3c,
  mpBlue: 0x3c78e6,
  xpGold: 0xc8a020,
} as const;

export const RARITY_COLORS = {
  common: 0xc8c8c8,
  uncommon: 0x4cd964,
  rare: 0x4aa3ff,
  epic: 0xc060ff,
  legendary: 0xffa020,
} as const;

export function rgb(r: number, g: number, b: number): Rgb {
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}
export function unpack(c: Rgb): [number, number, number] {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}
/** Linear blend: t=0 -> a, t=1 -> b. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const [ar, ag, ab] = unpack(a);
  const [br, bg, bb] = unpack(b);
  return rgb(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}
export function scale(c: Rgb, k: number): Rgb {
  const [r, g, b] = unpack(c);
  return rgb(Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k));
}
