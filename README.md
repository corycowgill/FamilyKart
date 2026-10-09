# 🏁 Cowgill Kart Racing

A colorful, chaotic, family-themed 3D arcade kart racer that runs in the browser.
Dad, Mom, Brennan, Parker, Lupin (the fluffy Tibetan Terrier) and Grandma race each other through Chicago,
their neighborhood, a giant kitchen, Lupin's dog park and a Chicago snowstorm.

Built with **TypeScript + Three.js + Vite**. Everything (characters, karts, tracks, music, sound effects) is
generated procedurally at runtime, so the whole game is a small static site.

## Play

```bash
npm install
npm run dev        # http://localhost:5173
```

### Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Accelerate | W / ↑ | Right trigger |
| Brake / reverse | S / ↓ | Left trigger |
| Steer | A D / ← → | Left stick |
| Drift / hop | Space | Right bumper |
| Use item | E | A (south) |
| Character special | F | X (west) |
| Look back | Q | Y (north) |
| Pause | Esc | Start |

**Drifting:** hold Space while steering into a corner. Sparks go blue → orange → purple; release for a mini-turbo.

2-player split screen: P1 uses WASD + Space/E/F, P2 uses arrows + Right-Shift / Enter / Comma (or two gamepads).

Steering assist for younger racers can be turned on in Settings or on the track-select screen.

### Modes
- **Quick Race**: pick a racer, a track and a difficulty, then race the other five family members over 3 laps.
- **Grand Prix**: two four-race cups with points (15/12/10/8/6/4) and a podium ceremony.
- **Time Trial**: race solo against the clock and your saved ghost.
- **2-Player Versus**: split-screen racing on one computer.
- **Garage**: browse the karts and your records.

Records, settings, cup results and ghosts are saved in `localStorage`.

### Debug mode
Press **`** (backquote) during a race to open the debug overlay (physics state, checkpoints, AI targets, racing line).
While it's open: `1`–`8` give items, `O` recharges your special, `R` restarts, `N` switches character, and `K` toggles autopilot.
URL flags for testing: `?laps=1` (one-lap races) and `?autopilot` (the AI drives your kart).

## Development

```bash
npm run typecheck   # strict TypeScript
npm test            # Vitest unit/integration tests (headless simulation)
npm run sim -- --races 120 --track all --difficulty all   # AI-only race telemetry harness
npm run e2e         # Playwright browser tests (builds + previews the game)
npm run build       # production build in dist/
```

### Architecture

```
src/
  core/       math, seeded RNG, event emitter
  sim/        pure TypeScript simulation; no DOM or Three.js, so it runs headless
    track/    spline sampling, Track runtime (projection, shortcuts, gaps, ramps, racing line)
    kart/     arcade kart physics shared by humans and AI (drift tiers, boosts, walls, recovery)
    race/     RaceSim: fixed 60 Hz step, laps/checkpoints, positions, collisions, results
    items/    item boxes, position-weighted odds, projectiles, hazards, signature specials
    ai/       AIDriver: racing line, speed planning, drifting, overtaking, shortcuts, item strategy
  data/       characters and track definitions (data-driven)
  render/     Three.js views: environment, track mesh, scenery per theme (lazy-loaded), kart & character models,
              particles, chase camera, showroom, podium, ghost
  audio/      procedural Web Audio engine: SFX, per-track generative music, engine voices
  game/       Game (screens & mode flow), RaceSession (sim + scene + loop)
  ui/         HUD, menus, portraits, CSS
  input/      keyboard + gamepad with remapping
  persist/    save data (settings, records, cups, ghosts)
```

The simulation runs at a fixed 60 Hz and rendering interpolates between steps. AI racers use the same
kart controller as the player. They follow a curvature-based racing line, brake for corners, drift,
overtake, take shortcuts, use items and recover when stuck. Rubber-banding is mild and configurable.

Collision uses a custom track-relative system rather than Rapier: karts are projected onto the track
splines, which gives walls, surfaces, shortcuts and gaps, and kart-to-kart contact is resolved with
sphere impulses. This keeps the simulation deterministic and fast enough to run hundreds of races headless.

## Deploying to Render.com
`render.yaml` defines a static site: build `npm ci && npm run build`, publish `dist/`, with immutable caching for hashed assets.
In Render, create a **Blueprint** from this repository, or a **Static Site** with those settings.
