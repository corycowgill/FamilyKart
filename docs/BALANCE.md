# Balance report

Generated with the headless harness (`scripts/simulate.ts`):

```
npm run sim -- --races 150 --track all --difficulty all --seed 1
```

That is 150 AI-only races: 6 karts per race, all 5 tracks (chicago, neighborhood, kitchen, dogpark, snow), and
easy/normal/hard in rotation, so each track/difficulty pair gets 10 races. The grid order is shuffled with a seeded
RNG for every race. All numbers below come from that run unless marked *baseline*. *Baseline* is the tuning before
this pass, measured the same way. Expect about ±4 percentage points of noise on a win rate at this sample size
(1 SD at 150 races).

## Headline

| metric | baseline | now | target |
| --- | --- | --- | --- |
| race completion | 100% (Chicago only)\* | **100%** | 100% |
| highest win rate | bro2 43–49% | **dad 27.3%** | ≤ ~28% |
| lowest win rate | grandma 0.8–3% | **mom 8.7%** | ≥ ~8% |
| avg winning time | 2:42 (Chicago) | 2:55 | 3–5 min |
| avg race end (last finisher) | 3:04 (Chicago) | 3:14 | 3–5 min |
| worst race end | 6:40 (stuck AI) | 3:50 | — |
| physics instabilities | 0 | 0 | 0 |
| sim speed | — | ~300x real time | — |

\*On the new tracks, baseline AI karts could get trapped (see "Bugs fixed"). One Chicago race took 6:40 because a
single kart was stuck for minutes.

## Win rates per character

| character | stats (spd/acc/hnd/wt) | special (cooldown) | win % | podium % | avg pos | baseline win % |
| --- | --- | --- | --- | --- | --- | --- |
| Dad | 4/3/3/4 | Dad Boost (36 s) | 27.3 | 62.7 | 3.0 | 39 |
| Bro 2 | 4/5/3/2 | Lightning Dash (36 s) | 22.7 | 63.3 | 3.0 | 43 |
| Lupin | 3/5/4/1 | Puppy Panic (10 s) | 19.3 | 53.3 | 3.3 | 3 |
| Grandma | 3/3/4/3 | Grandma's Revenge (26 s) | 11.3 | 40.0 | 3.9 | 3 |
| Bro 1 | 4/3/5/2 | Turbo Drift (12 s) | 10.7 | 41.3 | 3.7 | 12 |
| Mom | 3/4/4/2 | Mom Shield (10 s) | 8.7 | 39.3 | 4.0 | 2 |

The baseline column comes from the same rotation of all tracks and difficulties: 120 races, measured just before
the tuning change. On Chicago only, the baseline was bro2 49%, dad 33%, bro1 11%, lupin 4%, mom 1.7% and
grandma 0.8%.

**No character dominates any more.** Dad and Bro 2 are still the strongest overall, by about 1 position on average,
but neither is above the ~28% ceiling. The spread varies by track and difficulty (see the harness output): for
example, Dad wins 40% on dogpark and 38% on easy. Mom on easy and Bro 1 on neighborhood/dogpark are the weakest
cells. Each cell is only 30–50 races, so read them as directional.

### Why the baseline was lopsided

The tuning was isolated with an experiment that equalised stats and/or disabled specials:

1. **The speed stat dominated.** Top speed was `26 + 1.0 × speed`, so a 4-star kart was 3.4% faster than a
   3-star kart. AI racers drive nearly identical lines, so that gap is about 5 s per race. With specials disabled,
   the 4-speed karts (Dad, Bro 1, Bro 2) won about 31% each and the 3-speed karts about 2%.
2. **Handling is worth almost nothing to the AI.** `AIDriver` plans corner speed from `AI_DIFFICULTY.cornerGrip`,
   not from the kart's handling. The corners are wide enough that the AI rarely corners at the limit. Making AI
   corner speed scale with handling was tried, and it made no measurable difference.
3. **Two specials were overpowered.** With all stats equal, Dad Boost alone took Dad to a 52% win rate (2 s at
   +48% every 22 s, fired on every straight). Lightning Dash took Bro 2 to 53% (+60% burst plus a shove that
   costs nearby rivals 25% of their speed). Grandma's pie was also strong (+22% win rate). Mom's shield, Turbo Drift
   and Puppy Panic were each worth only a few percent.

## Item mix (per race, 6 karts)

* About 101 box pickups, 59 items granted (the rest happen while a kart already holds an item), and 54 items used.
* Share of granted items: banana 20.6%, turboSoda 17.5%, bubbleShield 15.2%, pizza 13.9%, pothole 11.1%,
  dog bone 10.3%, rocket 5.8%, mystery 5.7%. Mystery boxes resolve evenly across the other 7 items.
* Position weighting works: the leader never rolls a rocket (checked by unit tests), and last place gets about
  3× the comeback-item share.
* There are **46 hits per race**, about 7.7 per kart. By cause: pothole 24%, banana 14%, tennis ball (Puppy Panic
  plus the dog-park cannon) 19%, track hazards (snowplow, rolling fruit, sprinklers) 22%, pizza 9%, pie 8%,
  bone 2%, rocket 2%.
* There are about 4 shield blocks per race.
* With a 2.2 s invulnerability window after each hit, nobody gets stun-locked. Unit tests cover this.

## Windy City Gust (new item)

`windyGust` hits every racer **ahead** of the user, wherever they are on the track. Each victim's speed is scaled
by ×0.65 over 0.6 s (applied gradually by `ItemSystem.step`, never a spin-out). It also gets a 5 m/s shove toward
the outside of the road, a 0.6 s "blown" state (`sim.items.blownTime(id)`) and 0.8 s of invulnerability, so gusts
cannot stun-lock. A bubble shield deflects the wind and is **not** popped. Rockets and invulnerable karts are
unaffected. Tuning lives in `ITEM_TUNING.gust`.

* Weight: `p > 0.2 ? 1.4·(p − 0.2) : 0`. The front of the pack never gets it, and last place gets about 10% of its
  rolls as gusts. It is also one of the Mystery Box outcomes.
* AI: fires it when 2 or more unshielded racers are within 80 m ahead. Otherwise it occasionally fires with only
  one racer in range, and rarely at random on low skill.
* Harness, `--races 120 --track all --difficulty all`, seeds 1–4 (480 races): all PASS. Gust is 3.5% of granted
  items, and "wind" is about 6.2 hits per race.
* Win rates, 4-seed average without → with the gust: dad 23.6 → 24.4%, mom 10.6 → 9.2%, bro1 21.9 → 21.7%,
  bro2 21.9 → 21.7%, lupin 9.8 → 12.1%, grandma 12.3 → 11.0%. Every change is within about 1 standard error
  (±1.4–2%).
* With the default seed 1, dad reaches 28.3% and bro1 26.7%. Without the gust, seed 1 had bro1 at 27.5%.
* An earlier version also popped shields and cancelled boosts. It cost Mom about 3 points (Mom Shield got used up
  by gusts), so both were dropped.

## AI drifting is ineffective

* AI karts start about **105 drifts per race (17 per kart)**, and each one includes a hop. **Only 5.4% end in a
  boost**, almost all tier 1. Across 150 races there were 14 tier-2 and 3 tier-3 boosts.
* The cause is a mismatch between drift physics and the AI. The tightest a drift can go, with full counter-steer,
  is about `0.45 × driftSteer ≈ 0.86 rad/s`, which is a radius of about 30 m at 26 m/s. The AI starts drifts on
  corners with curvature above 0.018, a radius of 55 m or more. On those, the kart over-rotates within about 0.3 s,
  the steering error flips sign, and the `sameDir` check releases the drift before tier 1 (0.9 s of charge).
  Increasing the release tolerance in `AIDriver` raised the boost rate to about 12% but did not shorten lap
  times, so I did not ship it.
* Visible effect: AI karts bunny-hop constantly (about 195 jumps per race in total, including ramps).
* Turbo Drift is mostly wasted on AI Bro 1, which is part of why his special cooldown is now short.

**Recommendation (AIDriver):** only start a drift when the curvature ahead is above about 0.03 and lasts at least
1 s at the current speed. While drifting, steer to hold the racing line using the drift-tightness range: steer = 0
is neutral, counter-steer opens the line. Release on tier 2 at the corner exit, not on error sign. Alternatively,
widen the drift arc in physics by lowering the `0.45` minimum factor to about 0.25. That also changes the feel for
humans, so it needs a playtest.

## Race durations against the 3–5 minute target

| difficulty | avg winner | avg last finisher |
| --- | --- | --- |
| easy | 3:13 | 3:33 |
| normal | 2:51 | 3:12 |
| hard | 2:41 | 2:58 |

Per track, average lap times are 58 s (chicago), 59 s (neighborhood), 62 s (kitchen), 66 s (dogpark) and 65 s
(snow). The best AI lap was 44.5 s.

AI winners on normal and hard finish just under 3 minutes. A human field usually finishes slower than the AI
(fewer drift boosts, more wall contact), so a typical human race will land around 3:00–3:30. That is inside the
target, but near the bottom of it. If races feel short, either:

* make tracks about 10% longer (around 1,800 m), or
* use 4 laps on the shortest tracks (chicago, neighborhood). That gives about 3:45–4:00.

Lowering `maxSpeed` is not recommended, because it costs feel.

## Recovery and stability

* About 0.25 respawns per race. Most are deliberate falls (gaps or bridge jumps). The rest are stuck recoveries
  (3 in 150 races).
* No NaNs, no speed above 70 m/s, no kart below `killY` without a respawn, no kart outside the walls for more than
  1 s, and no progress stalls.
* Ruled out by unit tests: continuous boosting stays bounded at `maxSpeed × (1 + boostPower)`.

## Changes made in this pass

Each sim change is listed with its before and after values.

**Tuning:**

| file | constant | before | after | why |
| --- | --- | --- | --- | --- |
| `src/sim/kart/kartConfig.ts` | `maxSpeed` | `26 + 1.0·speed` (27–31) | `28.1 + 0.4·speed` (28.5–30.1) | The speed stat decided races. Unchanged at 3.5 stars. |
| `src/sim/kart/kartConfig.ts` | `acceleration` | `9 + 1.8·acc` (10.8–18) | `12.6 + 0.9·acc` (13.5–17.1) | 5-acceleration karts recovered from every hit much faster. Unchanged at 4 stars. |
| `src/data/characters.ts` | Dad Boost cooldown | 22 | 36 | The strongest special by far. |
| `src/data/characters.ts` | Lightning Dash cooldown | 20 | 36 | Burst plus a shove that slows rivals. |
| `src/data/characters.ts` | Grandma's Revenge cooldown | 24 | 26 | A reliable homing hit. |
| `src/data/characters.ts` | Mom Shield cooldown | 24 | 10 | Purely defensive. The AI only fires it in the top 2 or when targeted. |
| `src/data/characters.ts` | Turbo Drift cooldown | 20 | 12 | Little value without good drifting. |
| `src/data/characters.ts` | Puppy Panic cooldown | 20 | 10 | Only hurts racers directly behind. |

**Bugs fixed (found by the harness):**

1. `src/sim/race/RaceSim.ts` (`updateProgress`). Before: any change in progress above 60 m in one step was
   discarded. A respawn that sent a kart *forward* (for example, it had driven 100 m the wrong way, then respawned
   at its last safe spot) froze `raceDistance` until the kart had lapped the whole track again. It lost a lap,
   positions froze, and the AI watchdog looped. After: on the first step after a respawn, progress is resynced,
   capped at the furthest distance the kart has reached, so a respawn can never gain progress.
2. `src/sim/kart/KartPhysics.ts`. The respawn teleport now also restores `k.mainS` from `lastSafe.mainS`.
   Previously `mainS` stayed stale for the teleport step, so the resync in fix 1 missed it.
3. `src/sim/ai/AIDriver.ts`, shortcut approach. An AI that had committed to a shortcut, then got spun out right at
   the junction, steered toward the shortcut's first point. That point can sit a few metres *behind* the nominal
   `from` fraction, so the AI turned around and drove the wrong way, sometimes for minutes. After: it also abandons
   the shortcut when its steering target is physically behind it along the road. Shortcuts are still used at about
   4.3 entries per race.
4. `src/sim/ai/AIDriver.ts`, new no-progress watchdog (`AI_NO_PROGRESS_RESPAWN = 8` s). An AI kart turned
   backwards against a shoulder wall could cycle between its reverse and forward recovery forever. Its speed stayed
   above the physics stuck threshold, so it never respawned. Now any AI racer with no gain in race progress for 8 s
   asks for a normal respawn.

## Further tuning recommendations

1. **Mom (8.7%) and Bro 1 (10.7%) are still at the bottom.** They need value from their specials, not shorter
   cooldowns:
   * Make the AI fire Mom Shield when any projectile is in flight or a hazard is ahead within 30 m, not only when
     she is in the top 2. Alternatively, give the shield a small (+10%, 0.5 s) launch boost.
   * Turbo Drift will only pay off once AI drifting works (see above).
2. **Dad still leads on easy (38%) and dogpark (40%).** On easy, the other AIs barely drift or fight, so a plain
   straight-line boost is worth relatively more. If this persists after the drift fix, reduce Dad Boost to 1.6 s
   instead of lengthening the cooldown further. 36 s is already long for a human player.
3. **Potholes are the most common hit (24%).** They only slow you and do not spin you, so this is fine. If the
   chaos feels too high, lower the pothole weight for the leader from `1.5·lead + 0.4` to about `1.0·lead + 0.4`.
4. **Hit rate.** About 7.7 hits per kart per race is lively but on the edge for young players. A good first lever
   is `ITEM_TUNING.boxRespawn` (2.5 s): raising it to 4 s would cut items, and so hits, by roughly a quarter.
5. Re-run `npm run sim -- --races 150 --track all --difficulty all` after any track or tuning change. CI can use
   the non-zero exit code as a gate.
