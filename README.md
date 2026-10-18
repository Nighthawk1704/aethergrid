# AetherGrid

A real-time multiplayer ASCII MMORPG. One authoritative Node/TypeScript server, two clients
(a full-screen **terminal** client and a **browser** client with a retro CRT look), SQLite
persistence, and a bot simulator that populates the world.

## Quick start

Requires **Node.js 22+** (the clients use the built-in `WebSocket`).

```bash
npm install
npm run demo          # server + web client + 10 AI players in one process
```

Then either open **http://localhost:8765** or, in a terminal of at least **100×34**, run `npm run client`.

Or run the pieces separately:

| Command | What it does |
|---|---|
| `npm run server` | Game server + web client on `http://localhost:8765` (`PORT` to change). The web bundle is built automatically. |
| `npm run client` | Terminal client. `-- --url ws://host:8765/ws`, or `-- --user NAME --pass PW [--register --class arcanist]` to skip the login screen. |
| `npm run simulate-bots` | Spawns 10 AI players against a running server (`-- --count 20 --url ws://…`). |
| `npm run demo` | Server and bots together. |
| `npm run check` | Type-check + every test suite. |

The world is generated from a seed that is stored in the database on first run, so restarts
produce the identical world. Set `AETHER_SEED` before the *first* run to choose it, and
`AETHER_DB` to move the database (default `data/aethergrid.db`).

## Playing

Create a hero (Vanguard, Arcanist or Shadowblade) on the login screen — select the *Mode* row and
press → to switch to Register. You start in **Oakhaven**, a walled safe town with an inn (heals you),
a blacksmith, an alchemist, a bank chest and a quest board. The north gate leads to the
**Whispering Wilds**; stairs in one of its ruins descend into the three-floor **Sunken
Catacombs**, where the **Ancient Dragon** waits on floor 3.

| Key | Action |
|---|---|
| `W A S D` / arrows | Move. Walking into things attacks, talks, chops, mines, opens doors and chests |
| `Q` `Z` `Shift+E` `Shift+C` (or `Home` `End`) | Diagonals (NW, SW, NE, SE). In the browser, holding two of WASD also moves diagonally |
| `Space` / `E` | Interact: talk, loot, open doors, harvest |
| `>` / `<` (or `.` / `,`) | Stairs down / up |
| `1` `2` | Class skills · `3` health potion · `4` mana potion |
| `Tab` / `Esc` | Cycle target / clear target. Spells aim at the target, otherwise where you face |
| `I` · `C` · `?` | Inventory · character sheet · help |
| `Enter` | Chat (Enter sends, Esc cancels). `[` `]` switch tabs, PgUp/PgDn scroll |
| `F2` (browser) | Toggle the CRT effect |
| `F3` (browser) | Cycle time of day: auto → night → day |

> **Key conflict in the original brief:** `E` and `C` were assigned both to diagonals and to
> interact / character sheet. Plain `e` and `c` do the latter; the diagonals are `Shift+E` /
> `Shift+C`.

**Chat commands:** `/say` `/shout` `/w <user> <msg>` `/r` `/me` `/who` `/help` ·
`/party invite|accept|decline|leave|kick <user>` `/p <msg>` · `/trade <user>` `/trade accept|cancel` ·
`/pvp on|off` · `/unstuck`. Plain text is `/say` (proximity). The **Global** tab shows everything
except combat; **Local**, **Combat** and **System** are filtered views.

**Systems:** 3 classes with 2 skills each · monster AI (idle → patrol → aggro with A* → flee →
respawn) · procedural items (*Rusty Iron Sword*, *Fiery Steel Blade of the Bear*) · 20-slot bag,
4 equipment slots, 40-slot bank · merchants, innkeeper, quests · party XP sharing and loot rolls
within 15 tiles · player trading · opt-in PvP (only in the Wilds and Catacombs; Oakhaven is
always safe) · tree/ore harvesting that regrows.

## Architecture

```
src/
  shared/            used by server AND clients
    protocol.ts        packet types + strict validation of client input
    constants.ts       tick rate, layout, zone definitions
    gamedata.ts        classes, skills, monsters, NPCs, quests, XP curve
    tiles.ts colors.ts types.ts rng.ts noise.ts fov.ts path.ts
    client/            NetClient (WebSocket), ClientState (mirror built from packets)
    ui/                the 100x34 screen: panels, modals, login, GameApp (input + render)
  server/
    main.ts            Express (static web client, /api/status) + WebSocket upgrade
    game.ts            10 Hz tick loop, sessions, auth, routing, zone transfer, loot
    player.ts ai.ts combat.ts economy.ts social.ts sync.ts    per-tick systems
    world/             seeded generators: town, wilds (simplex noise), BSP dungeons
    db.ts auth.ts      better-sqlite3 schema/DAO, scrypt password hashing
    bots.ts demo.ts    AI players
  client-tui/        raw-ANSI terminal client (diffing double-buffered renderer)
  client-web/        browser client; rich/ holds the atmospheric world renderer (see below)
```

* **Authoritative server.** Clients only send intent (`move`, `skill`, `chat`, …). The server
  validates everything, runs a fixed 100 ms tick, and decides all outcomes.
* **Protocol.** JSON text frames `{t, s, …}` with sequence ids in both directions (the server
  echoes the last processed client id as `ack`). Map state is **delta-compressed**: tiles are sent
  only when first seen or changed (row runs), visibility as row spans, entities as
  spawn/update/despawn, your own stats only when a field changes. Roughly 200 bytes per player
  per tick under load.
* **Fog of war is enforced server-side.** Field of view is raycast on the server; unseen tiles and
  entities are never sent, so a modified client cannot reveal the map. Sight is elliptical
  (2× wider than tall) so it looks circular in character cells.
* **One renderer, two shells.** Both clients render the same `GameApp` into the same character
  buffer. The TUI diffs it to ANSI (TrueColor, 256-color fallback, synchronized output); the
  browser paints it to a canvas with phosphor glow, scanlines, vignette and flicker.
* **Persistence.** SQLite (WAL): `users`, `characters`, `inventory` (bag/equip/bank),
  `character_quests`, `world_drops` (ground loot survives restarts), `chat_log`, `meta`. Characters
  autosave every ~30 s and on logout, zone change, inn rest, trade and shutdown.
* **Security basics.** scrypt-hashed passwords with per-user salts and a dummy hash for unknown
  names (no user enumeration by timing), validation of every packet, per-connection rate limiting,
  chat rate limiting, message size caps, one session per account.

## The browser's rich renderer

The browser does not paint the 100×34 grid the terminal uses. `src/client-web/rich/` draws the world on a
much finer glyph grid (about 240 columns), where every map tile is a 3×3 block of varied, tonal ASCII:

* **Terrain** — layered greens for grass and canopy (`" , ' \ / ` ; & # %`), stacked `[ ] = #` brickwork for
  walls and ruins, `= : -` roads. Static terrain is cached per 12×12-tile chunk; glyphs come from a shared atlas.
* **Light** — a per-tile light mask is multiplied over the scene: day/night cycle (10 real minutes, starting
  at dusk), a lantern around you, remembered ground fading to dark blue, always-dark catacombs.
* **Water** — visible water mirrors the land, trees and entities above it (flipped glyphs, fading with depth),
  distorted by travelling sine waves and broken up by currents. At night a pixelated crescent moon with a halo
  mirrors itself onto the nearest water, with a glitter path.
* **Life** — a smoothly following camera, interpolated entity movement, swaying grass and trees, fireflies,
  floating `-12` / `MISS` combat text, name labels over every head (collision-avoided), and a bloom/scanline/
  vignette CRT finish. Windows fade the world down and slide in.
* **HUD** — translucent status panel (textured bars, load, group), FPS / frame-time readout, target frame,
  skill bar with cooldowns, plus the chat and minimap panels shared with the terminal client. The *load* figure
  is cosmetic: it is computed from item types in your bag and gear, since the game has no weight stat.

Only the shared client hooks (`ClientState.tileUpdates`, `GameApp.renderCtx/renderOverlay`) were added; the
server, protocol and the terminal client are unchanged.

## Tests

`npm run check` runs the type checker and three suites:

* `npm test` — world generation determinism and connectivity (every NPC, stairs, boss and mob
  spawn is reachable), FOV, A*, scrypt, and SQLite persistence across close/reopen.
* `npm run test:game` — ~125 end-to-end checks against a real server with real WebSocket clients
  and manually driven ticks: auth, fog-of-war deltas, doors, shops, harvesting, zone transfers,
  monster AI, every class skill, chat, party XP sharing, PvP rules, trade, bank, quests, death,
  malformed input, persistence across a server restart, and a 40-player load run
  (≈2 ms average tick).
* `npm run test:tui` — key parsing, and the ANSI renderer replayed through a terminal emulator and
  compared cell by cell with the source frame.

## Known limits

* The browser renderer was checked by rendering real frames from a live server through a software canvas and
  by running the shipped bundle end to end, but not yet in a real browser: its frame rate on your GPU is unmeasured
  (it drops to every other refresh if frames get expensive). `F2` disables the CRT effects if they cost too much.
* Explored-map memory is kept per session (not saved between logins).
* Everything runs in one process; it is sized for dozens of simultaneous players, not thousands.
