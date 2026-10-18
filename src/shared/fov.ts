/**
 * Raycast field of view. A tile is visible if a Bresenham ray between the origin and the tile
 * (tried in both directions, which removes most pillar artifacts) crosses no opaque tile.
 * The target tile itself may be opaque, so walls are seen.
 */
export type OpaqueFn = (x: number, y: number) => boolean;

export function lineClear(x0: number, y0: number, x1: number, y1: number, opaque: OpaqueFn): boolean {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  while (x !== x1 || y !== y1) {
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    if (x === x1 && y === y1) break;
    if (opaque(x, y)) return false;
  }
  return true;
}

/** Symmetric-ish line of sight between two tiles. */
export function hasLos(ax: number, ay: number, bx: number, by: number, opaque: OpaqueFn): boolean {
  return lineClear(ax, ay, bx, by, opaque) || lineClear(bx, by, ax, ay, opaque);
}

/**
 * Compute visible tiles within `radius` (vertical) of (ox, oy). `aspect` stretches the horizontal
 * reach: terminal cells are about twice as tall as wide, so aspect 2 makes sight look circular on
 * screen. Returns tile indices (y * w + x) sorted ascending, i.e. row-major.
 */
export function computeFov(ox: number, oy: number, radius: number, w: number, h: number, opaque: OpaqueFn, aspect = 1): number[] {
  const out: number[] = [];
  const r2 = radius * radius + radius * 0.5;
  const rx = Math.ceil(radius * aspect);
  const y0 = Math.max(0, oy - radius);
  const y1 = Math.min(h - 1, oy + radius);
  const x0 = Math.max(0, ox - rx);
  const x1 = Math.min(w - 1, ox + rx);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - ox) / aspect;
      const dy = y - oy;
      if (dx * dx + dy * dy > r2) continue;
      if ((x === ox && y === oy) || hasLos(ox, oy, x, y, opaque)) out.push(y * w + x);
    }
  }
  return out;
}

/** Encode sorted row-major tile indices as flat [y, x, len] triples. */
export function indicesToSpans(indices: readonly number[], w: number): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < indices.length) {
    const start = indices[i]!;
    const y = Math.floor(start / w);
    let len = 1;
    while (i + len < indices.length && indices[i + len] === start + len && Math.floor((start + len) / w) === y) len++;
    out.push(y, start - y * w, len);
    i += len;
  }
  return out;
}
