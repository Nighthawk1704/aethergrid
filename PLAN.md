# AetherGrid — Implementation Plan

Real-time multiplayer ASCII MMORPG. Authoritative Node/TypeScript server (10 Hz tick),
`ws` JSON protocol, SQLite persistence, a raw-ANSI terminal client and an HTML5-canvas web client.

## Key architecture decisions

| Topic | Decision | Why |
|---|---|---|
| Runtime | Node >= 22, ESM, `tsx` for execution, `tsc --noEmit` for type checking | Node 22+ ships a global browser-style `WebSocket`, so the TUI, web and bot clients share one network layer |
| Server pattern | Authoritative tick loop (100 ms), clean OO: `Actor` → `Player` / `Monster` / `Npc`, plus per-tick systems (input, ai, combat, buffs, respawn, sync) run in a fixed order | Predictable, easy to test |
| Active simulation | Only zones that contain players are simulated | 5 zones, most of the time 1-2 are awake |
| Protocol | JSON, `{t: type, s: seq}`. Client seq is acked in `state.ack`. Map state is delta-compressed: only newly explored / mutated tiles are sent (row runs), visibility as spans, entities as spawn/update/despawn | Small packets, fog of war enforced server-side (no map leak) |
| FOV | Server-side raycasting (Bresenham ray per tile in radius). Client keeps remembered tiles (dimmed) | Hidden monsters/players are never sent |
| Pathfinding | A* (8-way, no corner cutting, node-capped) for monster AI and bots | |
| Rendering | **One shared screen composer** (`src/shared/ui`) renders the 100x34 cell buffer; TUI diffs it to ANSI, web paints it to canvas | Both clients are pixel-for-pixel the same layout, one place to fix UI bugs |
| Persistence | `better-sqlite3`, WAL, tables: `users`, `characters`, `inventory` (bag/equip/bank), `world_drops`, `chat_log`, `character_quests`, `meta` | |
| World | Seeded (mulberry32 + simplex noise + BSP), deterministic per seed | Same seed => same world across restarts |

## Phases

- [x] **Phase 1 — Scaffolding & shared protocol**
  - [x] `package.json`, deps installed, native modules verified
  - [x] `tsconfig.json`, directory structure
  - [x] `src/shared`: constants, colors, tiles, types, game data tables, protocol (+ validators)
  - [x] `tsc --noEmit` clean
- [x] **Phase 2 — Database & world engine** (`npm test` → 75 checks)
  - [x] SQLite schema + data-access layer, scrypt auth
  - [x] RNG + simplex noise, Oakhaven / Wilds / Catacombs (BSP x3) generators
  - [x] FOV raycasting, A*
  - [x] Self-test: determinism, connectivity between zones, DB round-trip across reopen
- [x] **Phase 3 — Authoritative game loop & combat** (`npm run test:game` → 124 end-to-end checks, 30/30 clean runs)
  - [x] 10 Hz loop, sessions, state diffing, packet handlers
  - [x] Monster AI state machine (A* chase, flee, leash, give-up on unreachable, pack aggro, dragon breath telegraph), spawning, respawn
  - [x] Combat math, skills, buffs, cooldowns, loot, XP/leveling, death
  - [x] Items/affixes, shops, bank, quests, trade, party (shared XP + loot rolls), chat commands, harvesting
- [x] **Phase 4 — Terminal client** (`npm run test:tui` → 26 checks; verified live in a pty)
  - [x] Shared UI composer (`src/shared/ui`): viewport, stats, minimap + nearby, chat tabs, inventory / sheet / shop / bank / quest / dialog / trade / help modals, login screen
  - [x] `GameApp`: key handling, chat focus + history, reconnect, shared by TUI / web / (bots use the net layer only)
  - [x] ANSI renderer with front/back buffer diffing, truecolor + 256-color fallback, synchronized output; terminal emulator test replays frames pixel-exact
  - [x] Raw-mode input (arrows, SS3, Home/End, lone ESC, Ctrl+C), alt screen, resize handling, size check
- [x] **Phase 5 — Web client & bot simulator**
  - [x] Express static host + esbuild bundle (auto-rebuilt when sources change), canvas renderer, CRT glow / scanlines / vignette / flicker (F2 toggles)
  - [x] Held-key movement with WASD diagonals; shipped bundle exercised against a live server with a stubbed canvas
  - [x] `npm run simulate-bots` (10 bots: frontier exploration, A* travel, class-specific combat, potions, loot, equip upgrades, shopping, chat, party accept, auto-reconnect) and `npm run demo`
- [x] **Phase 6 — Verification & polish**
  - [x] `tsc --noEmit` clean; `npm run check` passes (75 + 26 + ~125 checks)
  - [x] Real-process restart: SIGINT save, same world, ground drops restored, bots reconnect with progress intact
  - [x] `README.md`
