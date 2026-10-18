import { Rng, hashSeed } from '../../shared/rng';
import { Simplex2 } from '../../shared/noise';
import { T } from '../../shared/tiles';
import { ZONES } from '../../shared/constants';
import { TileGrid, type Link, type ZoneData } from './grid';

const TOWN = { x0: 15, y0: 15, x1: 64, y1: 64 };

function building(g: TileGrid, x0: number, y0: number, x1: number, y1: number, door: { x: number; y: number }, pathTo: number, pathFrom: number): void {
  g.rect(x0, y0, x1, y1, T.WALL);
  g.rect(x0 + 1, y0 + 1, x1 - 1, y1 - 1, T.WOOD_FLOOR);
  g.set(door.x, door.y, T.DOOR_CLOSED);
  // Short road from the door to the main avenue.
  const dir = pathTo > pathFrom ? 1 : -1;
  for (let x = pathFrom; x !== pathTo + dir; x += dir) g.set(x, door.y, T.ROAD);
}

/** Oakhaven: a walled town surrounded by forest, exit via the north gate road. */
export function generateTown(seed: number): ZoneData {
  const def = ZONES.oakhaven;
  const g = new TileGrid(def.w, def.h, T.GRASS);
  const rng = new Rng(hashSeed(seed, 'oakhaven'));
  const noise = new Simplex2(hashSeed(seed, 'oakhaven-noise'));

  // Surrounding forest.
  for (let y = 0; y < def.h; y++) {
    for (let x = 0; x < def.w; x++) {
      const n = noise.fbm(x * 0.09, y * 0.09, 3);
      const m = noise.fbm(x * 0.06 + 100, y * 0.06 + 100, 2);
      g.set(x, y, n > 0.12 ? T.TREE : m > 0.2 ? T.FLOOR : T.GRASS);
    }
  }

  // Town interior: cobbles with grassy parks.
  g.rect(TOWN.x0, TOWN.y0, TOWN.x1, TOWN.y1, T.FLOOR);
  for (let y = TOWN.y0 + 1; y < TOWN.y1; y++) {
    for (let x = TOWN.x0 + 1; x < TOWN.x1; x++) {
      if (noise.fbm(x * 0.15 + 300, y * 0.15 + 300, 2) > 0.18 && rng.chance(0.85)) g.set(x, y, T.GRASS);
    }
  }
  // Perimeter wall.
  for (let x = TOWN.x0; x <= TOWN.x1; x++) { g.set(x, TOWN.y0, T.WALL); g.set(x, TOWN.y1, T.WALL); }
  for (let y = TOWN.y0; y <= TOWN.y1; y++) { g.set(TOWN.x0, y, T.WALL); g.set(TOWN.x1, y, T.WALL); }

  // Avenues and plaza.
  g.rect(39, TOWN.y0, 41, TOWN.y1 - 1, T.ROAD);
  g.rect(TOWN.x0 + 1, 39, TOWN.x1 - 1, 41, T.ROAD);
  g.rect(35, 35, 45, 45, T.ROAD);

  // North gate road out to the zone border (cleared of trees), ending in GATE tiles.
  for (let y = 0; y < TOWN.y0; y++) {
    for (let x = 36; x <= 44; x++) g.set(x, y, x >= 39 && x <= 41 ? T.ROAD : T.GRASS);
  }
  g.rect(39, 0, 41, 0, T.GATE);

  // Buildings: Inn (NW), Blacksmith (NE), Alchemist (SW), Guild & Bank (SE).
  building(g, 24, 22, 36, 32, { x: 36, y: 27 }, 38, 37);
  building(g, 44, 22, 56, 32, { x: 44, y: 27 }, 42, 43);
  building(g, 24, 47, 36, 57, { x: 36, y: 52 }, 38, 37);
  building(g, 44, 47, 56, 57, { x: 44, y: 52 }, 42, 43);
  g.set(50, 52, T.BANK);

  // Quest board on the plaza.
  g.set(36, 37, T.BOARD);

  const links = new Map<number, Link>();
  for (let x = 39; x <= 41; x++) links.set(g.idx(x, 0), { zone: 'wilds', x: 75 + (x - 40), y: 146 });

  return {
    id: 'oakhaven',
    grid: g,
    arrival: { x: 40, y: 42 },
    respawn: { x: 40, y: 42 },
    links,
    npcs: [
      { npc: 'marta', x: 30, y: 27 },
      { npc: 'brannoc', x: 50, y: 27 },
      { npc: 'elowen', x: 30, y: 52 },
      { npc: 'hale', x: 37, y: 37 },
    ],
    mobs: [],
  };
}
