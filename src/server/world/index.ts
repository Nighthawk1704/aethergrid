import { generateDungeonFloor } from './dungeon';
import { generateTown } from './town';
import { generateWilds } from './wilds';
import type { World, ZoneData } from './grid';

export * from './grid';

/** Build the complete, deterministic world for a seed and wire the zone links together. */
export function generateWorld(seed: number): World {
  const oakhaven = generateTown(seed);
  const wilds = generateWilds(seed);
  const c1 = generateDungeonFloor(seed, 1);
  const c2 = generateDungeonFloor(seed, 2);
  const c3 = generateDungeonFloor(seed, 3);

  const connect = (upper: ZoneData, lower: ZoneData): void => {
    const down = upper.stairsDown!, up = lower.stairsUp!;
    upper.links.set(upper.grid.idx(down.x, down.y), { zone: lower.id, x: up.x, y: up.y });
    lower.links.set(lower.grid.idx(up.x, up.y), { zone: upper.id, x: down.x, y: down.y });
  };
  connect(wilds, c1);
  connect(c1, c2);
  connect(c2, c3);

  return { seed, zones: { oakhaven, wilds, catacombs1: c1, catacombs2: c2, catacombs3: c3 } };
}
