import type { Vec2 } from './types';

export interface PathOptions {
  /** Hard cap on expanded nodes; protects the tick budget. */
  maxNodes?: number;
  /** Extra movement cost for a tile (default 1). Return Infinity for blocked. */
  cost?: (x: number, y: number) => number;
  diagonal?: boolean;
}

/** Binary min-heap keyed by f-score. */
class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number { return this.keys.length; }
  push(key: number, val: number): void {
    const k = this.keys, v = this.vals;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p]! <= k[i]!) break;
      [k[p], k[i]] = [k[i]!, k[p]!];
      [v[p], v[i]] = [v[i]!, v[p]!];
      i = p;
    }
  }
  pop(): number {
    const k = this.keys, v = this.vals;
    const top = v[0]!;
    const lastK = k.pop()!, lastV = v.pop()!;
    if (k.length > 0) {
      k[0] = lastK; v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l]! < k[m]!) m = l;
        if (r < k.length && k[r]! < k[m]!) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i]!, k[m]!];
        [v[m], v[i]] = [v[i]!, v[m]!];
        i = m;
      }
    }
    return top;
  }
}

const DIRS8: readonly [number, number][] = [
  [0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1],
];

/**
 * A* over a w*h grid. The goal tile is always treated as enterable (it may hold the target
 * entity). Diagonal steps may not cut corners. Returns the path excluding the start, including
 * the goal, or null when unreachable within the node cap.
 */
export function findPath(
  w: number, h: number, start: Vec2, goal: Vec2,
  passable: (x: number, y: number) => boolean, opts: PathOptions = {},
): Vec2[] | null {
  if (start.x === goal.x && start.y === goal.y) return [];
  const maxNodes = opts.maxNodes ?? 600;
  const dirs = opts.diagonal === false ? DIRS8.slice(0, 4) : DIRS8;
  const cost = opts.cost;
  const startIdx = start.y * w + start.x;
  const goalIdx = goal.y * w + goal.x;
  const g = new Map<number, number>([[startIdx, 0]]);
  const parent = new Map<number, number>();
  const closed = new Set<number>();
  const open = new Heap();
  const heur = (x: number, y: number): number => {
    const dx = Math.abs(x - goal.x), dy = Math.abs(y - goal.y);
    return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
  };
  open.push(heur(start.x, start.y), startIdx);
  let expanded = 0;
  const canEnter = (x: number, y: number): boolean => (x === goal.x && y === goal.y) || passable(x, y);

  while (open.size > 0) {
    const cur = open.pop();
    if (closed.has(cur)) continue;
    if (cur === goalIdx) {
      const path: Vec2[] = [];
      for (let n = cur; n !== startIdx; n = parent.get(n)!) path.push({ x: n % w, y: Math.floor(n / w) });
      return path.reverse();
    }
    closed.add(cur);
    if (++expanded > maxNodes) return null;
    const cx = cur % w, cy = Math.floor(cur / w);
    const cg = g.get(cur)!;
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (!canEnter(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!canEnter(cx + dx, cy) || !canEnter(cx, cy + dy))) continue;
      const ni = ny * w + nx;
      if (closed.has(ni)) continue;
      const step = (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) * (cost ? cost(nx, ny) : 1);
      if (!Number.isFinite(step)) continue;
      const ng = cg + step;
      if (ng < (g.get(ni) ?? Infinity)) {
        g.set(ni, ng);
        parent.set(ni, cur);
        open.push(ng + heur(nx, ny), ni);
      }
    }
  }
  return null;
}
