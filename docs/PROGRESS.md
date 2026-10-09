# Progress

## Completed
- Foundation: Vite + strict TypeScript, Three.js renderer, fixed 60 Hz simulation with interpolated rendering, CI workflow, Render.com blueprint.
- Driving: arcade kart physics (acceleration, braking, reverse, speed-dependent steering, suspension visuals, hop, three-tier drift mini-turbos, boost pads, ramps, gaps, walls, off-road / ice / mud / milk surfaces, kart bumping, automatic recovery).
- Race loop: countdown, 12 ordered checkpoints, laps, positions, overtakes, finish, results, wrong-way detection.
- AI: racing line, curvature speed planning, whole-corner drift planning, overtaking/avoidance, hazard dodging, shortcuts, item and special strategy, stuck recovery + no-progress watchdog, Easy/Normal/Hard, mild rubber-banding.
- Items: Turbo Soda, Flying Pizza, Banana Peel, Bubble Shield, Giant Dog Bone, Chicago Pothole, Rocket Kart, Mystery Box; position-weighted odds; invulnerability window. Six signature specials with cooldowns.
- Family: six procedural cartoon characters and personalised karts with idle/steer/drift/hit/item/jump/win/lose/overtake animations (Lupin ears, tail, tongue).
- Tracks: Chicago Grand Prix, Neighborhood Mayhem, Kitchen Chaos, Lupin's Dog Park, Chicago Snowpocalypse (see tracks workstream).
- Modes: Quick Race, Grand Prix (2 cups), Time Trial with ghost, 2-player split-screen, Garage.
- UI: title with attract-mode race, menus, 3D character showroom, track select previews, HUD (position, lap, timer, speed, minimap, item, special, drift meter, leaderboard), pause, settings (volumes, quality, assist, FPS, key remapping), results with 3D podium.
- Audio: procedural SFX, per-track generative music, engine voices, drift squeal.
- Hallucinated Games studio intro before the title (skip with `?nointro`).
- QA: 102 Vitest tests, `npm run sim` telemetry harness (100% completion across all tracks/difficulties), Playwright e2e suite, debug overlay + dev shortcuts.

## Known limitations
- Collision is a custom track-relative system rather than Rapier (deterministic and much faster for headless simulation).
- Assets are procedural Three.js geometry rather than GLB files; no external asset pipeline needed.
- Real-GPU frame rate has not been measured in this environment (headless software GL runs ~1 FPS); auto quality reduction kicks in below ~32 FPS.
- Online multiplayer is not implemented (future work).

## Next
- Deploy to Render and add a card to the gameCentral index site.
