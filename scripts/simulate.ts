/**
 * Headless race simulation harness: runs AI-only races as fast as possible and prints telemetry.
 *
 *   npm run sim -- --races 120 --track all --difficulty all --seed 1 --json out.json
 *
 * Exits non-zero if any race fails to complete (all karts finished) or any physics instability is detected.
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Rng } from '../src/core/rng';
import { CHARACTERS } from '../src/data/characters';
import { TRACKS } from '../src/data/tracks/index';
import { PHYSICS } from '../src/sim/kart/kartConfig';
import { RaceSim } from '../src/sim/race/RaceSim';
import { Track } from '../src/sim/track/Track';
import type { CharacterId, Difficulty, ItemId, KartState, SimEvent, SpecialId } from '../src/sim/types';

/* ------------------------------------------------------------------ CLI */

interface Options {
  races: number;
  track: string;
  difficulty: string;
  seed: number;
  json?: string;
  timeLimit: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { races: 60, track: 'all', difficulty: 'all', seed: 1, timeLimit: 600, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--races': o.races = Math.max(1, parseInt(next(), 10)); break;
      case '--track': o.track = next(); break;
      case '--difficulty': o.difficulty = next(); break;
      case '--seed': o.seed = parseInt(next(), 10) >>> 0; break;
      case '--json': o.json = next(); break;
      case '--time-limit': o.timeLimit = parseFloat(next()); break;
      case '--quiet': o.quiet = true; break;
      case '--help':
      case '-h':
        console.log('Usage: npm run sim -- [--races N] [--track id|all] [--difficulty easy|normal|hard|all] [--seed S] [--json out.json] [--time-limit sec] [--quiet]');
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument ${a}`);
    }
  }
  return o;
}

/* ------------------------------------------------------------------ Telemetry */

const SPEED_SANITY = 70; // m/s absolute sanity bound
const OUTSIDE_WALL_LIMIT = 1; // seconds a kart may sit outside the barrier before it's flagged
const PROGRESS_STALL_LIMIT = 4; // seconds of fast forward driving on the road without race progress

interface Instability {
  race: number;
  track: string;
  kart: string;
  kind: 'nan' | 'overspeed' | 'belowKillY' | 'outsideWalls' | 'progressStall';
  time: number;
  detail: string;
}

interface RaceRecord {
  index: number;
  track: string;
  difficulty: Difficulty;
  seed: number;
  grid: CharacterId[];
  completed: boolean;
  duration: number; // sim time when the race ended
  winnerTime: number;
  results: Array<{ character: CharacterId; place: number; finished: boolean; time: number; bestLap: number }>;
  wallMs: number;
}

const CHAR_IDS = CHARACTERS.map((c) => c.id);

interface Counters {
  overtakes: number;
  bumps: number;
  walls: number;
  hits: number;
  hitsByCause: Record<string, number>;
  shieldBlocks: number;
  respawns: number;
  respawnFall: number;
  respawnStuck: number;
  respawnLost: number;
  jumps: number;
  driftStarts: number;
  driftTierEvents: Record<string, number>;
  driftBoosts: Record<string, number>;
  boostsByKind: Record<string, number>;
  itemPickups: number;
  itemsGranted: Record<string, number>;
  itemsUsed: Record<string, number>;
  mysteryResults: Record<string, number>;
  specials: Record<string, number>;
}

const newCounters = (): Counters => ({
  overtakes: 0, bumps: 0, walls: 0, hits: 0, hitsByCause: {}, shieldBlocks: 0, respawns: 0, respawnFall: 0, respawnStuck: 0, respawnLost: 0,
  jumps: 0, driftStarts: 0, driftTierEvents: {}, driftBoosts: {}, boostsByKind: {}, itemPickups: 0, itemsGranted: {}, itemsUsed: {},
  mysteryResults: {}, specials: {},
});

const inc = (r: Record<string, number>, k: string, n = 1) => (r[k] = (r[k] ?? 0) + n);

interface CharAgg {
  races: number;
  wins: number;
  podiums: number;
  placeSum: number;
  places: number[]; // index 0 => P1
  overtakes: number;
  hitsTaken: number;
  itemsUsed: number;
  driftBoosts: number;
  respawns: number;
  winsByDifficulty: Record<string, number>;
  racesByDifficulty: Record<string, number>;
  winsByTrack: Record<string, number>;
  racesByTrack: Record<string, number>;
  gridSlotSum: number;
}

const newCharAgg = (): CharAgg => ({
  races: 0, wins: 0, podiums: 0, placeSum: 0, places: [0, 0, 0, 0, 0, 0], overtakes: 0, hitsTaken: 0, itemsUsed: 0, driftBoosts: 0, respawns: 0,
  winsByDifficulty: {}, racesByDifficulty: {}, winsByTrack: {}, racesByTrack: {}, gridSlotSum: 0,
});

/* ------------------------------------------------------------------ Race runner */

function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

interface KartWatch {
  outside: number;
  stall: number;
  lastDist: number;
  flagged: Set<string>;
}

function runRace(
  index: number,
  track: Track,
  difficulty: Difficulty,
  seed: number,
  timeLimit: number,
  c: Counters,
  instabilities: Instability[],
  lapTimes: number[],
): RaceRecord {
  const grid = shuffle(CHAR_IDS, new Rng(seed ^ 0x9e3779b9));
  const sim = new RaceSim({
    track,
    racers: grid.map((ch) => ({ character: ch, playerIndex: -1 })),
    difficulty,
    seed,
    timeLimit,
  });
  const watch: KartWatch[] = sim.karts.map(() => ({ outside: 0, stall: 0, lastDist: -Infinity, flagged: new Set() }));
  const flag = (k: KartState, kind: Instability['kind'], detail: string) => {
    const w = watch[k.id];
    if (w.flagged.has(kind)) return; // one report per kart per kind per race
    w.flagged.add(kind);
    instabilities.push({ race: index, track: track.def.id, kart: k.character, kind, time: +sim.time.toFixed(2), detail });
  };
  const t0 = performance.now();
  const dt = sim.dt;
  const mysteryPending = new Set<number>();
  while (sim.phase !== 'finished') {
    sim.step();
    const events = sim.drainEvents();
    for (const e of events) countEvent(e, sim, c, mysteryPending);
    if (sim.phase === 'countdown') continue;
    for (const k of sim.karts) {
      const w = watch[k.id];
      const vals = [k.pos.x, k.pos.y, k.pos.z, k.vel.x, k.vel.z, k.vy, k.yaw, k.raceDistance];
      if (vals.some((v) => !Number.isFinite(v))) {
        flag(k, 'nan', `pos=(${k.pos.x},${k.pos.y},${k.pos.z}) vel=(${k.vel.x},${k.vel.z})`);
        continue;
      }
      const sp = Math.hypot(k.vel.x, k.vel.z, k.vy);
      if (sp > SPEED_SANITY) flag(k, 'overspeed', `speed ${sp.toFixed(1)} m/s`);
      if (k.respawnTime > 0) {
        w.outside = 0;
        w.stall = 0;
        w.lastDist = -Infinity;
        continue;
      }
      if (k.pos.y < PHYSICS.killY - 0.5) flag(k, 'belowKillY', `y=${k.pos.y.toFixed(2)} without respawn`);
      const q = track.query(k.pos, k.pathId);
      if (q && !q.inGap && Math.abs(q.lateral) > q.wallDist + 0.5 && !q.contained) {
        // could be legitimately between overlapping corridors; only flag if no path contains it for a while
        w.outside += dt;
        if (w.outside > OUTSIDE_WALL_LIMIT) flag(k, 'outsideWalls', `lateral ${q.lateral.toFixed(1)} vs wallDist ${q.wallDist.toFixed(1)} on path ${q.pathId} at s=${q.s.toFixed(0)}`);
      } else w.outside = 0;
      // progress desync: driving forward on the road at speed while raceDistance doesn't move
      if (!k.finished && k.grounded && k.forwardSpeed > 10 && q && q.contained && !q.inGap) {
        if (k.raceDistance <= w.lastDist + 0.01) {
          w.stall += dt;
          if (w.stall > PROGRESS_STALL_LIMIT) flag(k, 'progressStall', `raceDistance stuck at ${k.raceDistance.toFixed(0)} (mainS ${k.mainS.toFixed(0)}, path ${k.pathId})`);
        } else w.stall = 0;
      } else w.stall = 0;
      w.lastDist = Math.max(w.lastDist, k.raceDistance);
    }
  }
  const wallMs = performance.now() - t0;
  for (const k of sim.karts) lapTimes.push(...k.lapTimes);
  const res = sim.results();
  const winner = res[0];
  return {
    index,
    track: track.def.id,
    difficulty,
    seed,
    grid,
    completed: sim.karts.every((k) => k.finished),
    duration: sim.time,
    winnerTime: winner.finished ? winner.time : NaN,
    results: res.map((r) => ({ character: r.character, place: r.place, finished: r.finished, time: r.time, bestLap: r.bestLap })),
    wallMs,
  };
}

function countEvent(e: SimEvent, sim: RaceSim, c: Counters, mysteryPending: Set<number>): void {
  switch (e.type) {
    case 'overtake': c.overtakes++; break;
    case 'bump': c.bumps++; break;
    case 'wall': c.walls++; break;
    case 'hit': c.hits++; inc(c.hitsByCause, e.cause); break;
    case 'shieldBlock': c.shieldBlocks++; break;
    case 'jump': c.jumps++; break;
    case 'driftStart': c.driftStarts++; break;
    case 'driftTier': inc(c.driftTierEvents, `tier${e.tier}`); break;
    case 'boost':
      inc(c.boostsByKind, e.kind);
      if (e.kind.startsWith('drift')) inc(c.driftBoosts, e.kind);
      break;
    case 'itemPickup': c.itemPickups++; break;
    case 'itemGranted':
      if (mysteryPending.has(e.kart)) {
        mysteryPending.delete(e.kart);
        inc(c.mysteryResults, e.item);
      } else inc(c.itemsGranted, e.item);
      break;
    case 'itemUse':
      inc(c.itemsUsed, e.item);
      if (e.item === 'mysteryBox') mysteryPending.add(e.kart);
      break;
    case 'special': inc(c.specials, e.special); break;
    case 'respawn': {
      c.respawns++;
      const k = sim.karts[e.kart];
      const q = sim.track.query(k.pos, k.pathId);
      if (!q) c.respawnLost++;
      else if (k.pos.y < -1 || q.inGap || k.pos.y < q.groundY - 1) c.respawnFall++;
      else c.respawnStuck++;
      break;
    }
    default:
      break;
  }
}

/* ------------------------------------------------------------------ Report helpers */

const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : '-');
const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '-');
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);
const mmss = (t: number) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}` : '-');

function table(rows: Array<Array<string | number>>, header: string[]): string {
  const all = [header, ...rows.map((r) => r.map(String))];
  const widths = header.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  return all.map((r, ri) => r.map((cell, i) => (i === 0 ? pad(cell, widths[i]) : lpad(cell, widths[i]))).join('  ') + (ri === 0 ? `\n${widths.map((w) => '-'.repeat(w)).join('  ')}` : '')).join('\n');
}

/* ------------------------------------------------------------------ Main */

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const trackDefs = opts.track === 'all' ? TRACKS : TRACKS.filter((t) => t.id === opts.track);
  if (!trackDefs.length) throw new Error(`Unknown track '${opts.track}'. Known: ${TRACKS.map((t) => t.id).join(', ')}`);
  const diffs: Difficulty[] = opts.difficulty === 'all' ? ['easy', 'normal', 'hard'] : [opts.difficulty as Difficulty];
  for (const d of diffs) if (!['easy', 'normal', 'hard'].includes(d)) throw new Error(`Unknown difficulty '${d}'`);

  const tracks = trackDefs.map((d) => new Track(d));
  const combos: Array<{ track: Track; difficulty: Difficulty }> = [];
  for (const track of tracks) for (const difficulty of diffs) combos.push({ track, difficulty });

  const counters = newCounters();
  const instabilities: Instability[] = [];
  const races: RaceRecord[] = [];
  const lapTimesByTrack: Record<string, number[]> = {};
  const chars: Record<string, CharAgg> = Object.fromEntries(CHAR_IDS.map((c) => [c, newCharAgg()]));
  const statTotals = { overtakes: 0, collisions: 0, itemsUsed: 0, hitsTaken: 0, respawns: 0, driftBoosts: 0 };

  console.log(`Simulating ${opts.races} AI races | tracks: ${trackDefs.map((t) => t.id).join(', ')} | difficulty: ${diffs.join(', ')} | seed ${opts.seed}`);
  const wall0 = performance.now();
  let simSeconds = 0;
  for (let i = 0; i < opts.races; i++) {
    const { track, difficulty } = combos[i % combos.length];
    const seed = (opts.seed * 1000003 + i * 7919) >>> 0;
    const laps = (lapTimesByTrack[track.def.id] ??= []);
    const before = instabilities.length;
    const rec = runRace(i, track, difficulty, seed, opts.timeLimit, counters, instabilities, laps);
    races.push(rec);
    simSeconds += rec.duration;
    rec.grid.forEach((ch, slot) => (chars[ch].gridSlotSum += slot + 1));
    for (const r of rec.results) {
      const a = chars[r.character];
      a.races++;
      a.placeSum += r.place;
      a.places[r.place - 1]++;
      inc(a.racesByDifficulty, difficulty);
      inc(a.racesByTrack, track.def.id);
      if (r.place === 1) {
        a.wins++;
        inc(a.winsByDifficulty, difficulty);
        inc(a.winsByTrack, track.def.id);
      }
      if (r.place <= 3) a.podiums++;
    }
    if (!opts.quiet) {
      const flags = instabilities.length - before;
      process.stdout.write(
        `  race ${lpad(i + 1, 3)}  ${pad(track.def.id, 12)} ${pad(difficulty, 6)}  ${rec.completed ? 'OK ' : 'DNF'}  ${mmss(rec.duration)}  winner ${pad(rec.results[0].character, 8)} ${flags ? `  !${flags} instability` : ''}\n`,
      );
    }
  }
  // per-kart stats aggregated via the karts' own counters are already reflected in events; recompute totals from events
  statTotals.overtakes = counters.overtakes;
  statTotals.collisions = counters.bumps + counters.walls;
  statTotals.itemsUsed = Object.values(counters.itemsUsed).reduce((a, b) => a + b, 0);
  statTotals.hitsTaken = counters.hits;
  statTotals.respawns = counters.respawns;
  statTotals.driftBoosts = Object.values(counters.driftBoosts).reduce((a, b) => a + b, 0);
  const wallSec = (performance.now() - wall0) / 1000;

  const completed = races.filter((r) => r.completed).length;
  const durations = races.map((r) => r.duration);
  const winnerTimes = races.map((r) => r.winnerTime).filter(Number.isFinite);
  const R = races.length;

  const out: string[] = [];
  out.push('');
  out.push('=== RACE SIMULATION REPORT ===');
  out.push(`Races: ${R}   completed: ${completed}/${R} (${pct(completed, R)})   sim time ${f1(simSeconds)} s in ${wallSec.toFixed(2)} s wall  => ${(simSeconds / wallSec).toFixed(0)}x real time`);
  out.push(`Race duration (last finisher): avg ${mmss(mean(durations))}  min ${mmss(Math.min(...durations))}  max ${mmss(Math.max(...durations))}`);
  out.push(`Winning time:                  avg ${mmss(mean(winnerTimes))}  min ${mmss(Math.min(...winnerTimes))}  max ${mmss(Math.max(...winnerTimes))}`);

  out.push('');
  out.push('-- Per track --');
  const trackRows = tracks.map((t) => {
    const rs = races.filter((r) => r.track === t.def.id);
    const laps = lapTimesByTrack[t.def.id] ?? [];
    return [t.def.id, rs.length, pct(rs.filter((r) => r.completed).length, rs.length), t.def.laps, f1(t.length), f1(mean(laps)), f1(Math.min(...laps)), mmss(mean(rs.map((r) => r.winnerTime).filter(Number.isFinite))), mmss(mean(rs.map((r) => r.duration)))];
  });
  out.push(table(trackRows, ['track', 'races', 'done', 'laps', 'length m', 'avg lap s', 'best lap s', 'avg win', 'avg end']));

  out.push('');
  out.push('-- Per difficulty --');
  out.push(table(diffs.map((d) => {
    const rs = races.filter((r) => r.difficulty === d);
    return [d, rs.length, pct(rs.filter((r) => r.completed).length, rs.length), mmss(mean(rs.map((r) => r.winnerTime).filter(Number.isFinite))), mmss(mean(rs.map((r) => r.duration)))];
  }), ['difficulty', 'races', 'done', 'avg win', 'avg end']));

  out.push('');
  out.push('-- Characters (finishing position distribution) --');
  out.push(table(CHAR_IDS.map((c) => {
    const a = chars[c];
    return [c, a.races, pct(a.wins, a.races), pct(a.podiums, a.races), f1(a.placeSum / Math.max(1, a.races)), ...a.places.map((n) => n), f1(a.gridSlotSum / Math.max(1, a.races))];
  }), ['character', 'races', 'win %', 'podium %', 'avg pos', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'avg grid']));
  if (diffs.length > 1) {
    out.push('');
    out.push('   win % by difficulty');
    out.push(table(CHAR_IDS.map((c) => [c, ...diffs.map((d) => pct(chars[c].winsByDifficulty[d] ?? 0, chars[c].racesByDifficulty[d] ?? 0))]), ['character', ...diffs]));
  }
  if (tracks.length > 1) {
    out.push('');
    out.push('   win % by track');
    out.push(table(CHAR_IDS.map((c) => [c, ...tracks.map((t) => pct(chars[c].winsByTrack[t.def.id] ?? 0, chars[c].racesByTrack[t.def.id] ?? 0))]), ['character', ...tracks.map((t) => t.def.id)]));
  }

  const perRace = (n: number) => (n / R).toFixed(1);
  out.push('');
  out.push('-- Racing --');
  out.push(`overtakes ${counters.overtakes} (${perRace(counters.overtakes)}/race)   kart bumps ${counters.bumps} (${perRace(counters.bumps)}/race)   wall hits ${counters.walls} (${perRace(counters.walls)}/race)   jumps ${counters.jumps}`);
  out.push(`drift starts ${counters.driftStarts} (${perRace(counters.driftStarts)}/race)   tier reached: ${JSON.stringify(counters.driftTierEvents)}`);
  const db = counters.driftBoosts;
  const dbTotal = (db.drift1 ?? 0) + (db.drift2 ?? 0) + (db.drift3 ?? 0);
  out.push(`drift boosts ${dbTotal} (${perRace(dbTotal)}/race, ${pct(dbTotal, counters.driftStarts)} of drifts)   tier1 ${db.drift1 ?? 0}  tier2 ${db.drift2 ?? 0}  tier3 ${db.drift3 ?? 0}`);
  out.push(`boosts by kind: ${JSON.stringify(counters.boostsByKind)}`);

  out.push('');
  out.push('-- Items --');
  const used = counters.itemsUsed;
  const usedTotal = Object.values(used).reduce((a, b) => a + b, 0);
  const grantedTotal = Object.values(counters.itemsGranted).reduce((a, b) => a + b, 0);
  out.push(`box pickups ${counters.itemPickups} (${perRace(counters.itemPickups)}/race)   items granted ${grantedTotal}   items used ${usedTotal} (${perRace(usedTotal)}/race)`);
  const itemIds: ItemId[] = ['turboSoda', 'flyingPizza', 'bananaPeel', 'bubbleShield', 'giantDogBone', 'chicagoPothole', 'rocketKart', 'mysteryBox'];
  out.push(table(itemIds.map((id) => [id, counters.itemsGranted[id] ?? 0, pct(counters.itemsGranted[id] ?? 0, grantedTotal), used[id] ?? 0, counters.mysteryResults[id] ?? 0]), ['item', 'granted', 'share', 'used', 'from mystery']));
  out.push(`hits ${counters.hits} (${perRace(counters.hits)}/race) by cause ${JSON.stringify(counters.hitsByCause)}   shield blocks ${counters.shieldBlocks}`);
  const specialIds: SpecialId[] = ['dadBoost', 'momShield', 'turboDrift', 'lightningDash', 'puppyPanic', 'grandmasRevenge'];
  out.push(`specials: ${specialIds.map((s) => `${s} ${counters.specials[s] ?? 0}`).join('  ')}`);

  out.push('');
  out.push('-- Recovery --');
  out.push(`respawns ${counters.respawns} (${perRace(counters.respawns)}/race)   track exits / falls ${counters.respawnFall}   stuck recoveries ${counters.respawnStuck}   lost (off map) ${counters.respawnLost}`);

  out.push('');
  out.push('-- Physics stability --');
  const byKind: Record<string, number> = {};
  for (const s of instabilities) inc(byKind, s.kind);
  out.push(`NaN ${byKind.nan ?? 0}   overspeed(>${SPEED_SANITY} m/s) ${byKind.overspeed ?? 0}   below killY w/o respawn ${byKind.belowKillY ?? 0}   outside walls >${OUTSIDE_WALL_LIMIT}s ${byKind.outsideWalls ?? 0}   progress stalls ${byKind.progressStall ?? 0}`);
  for (const s of instabilities.slice(0, 15)) out.push(`  ! race ${s.race + 1} ${s.track} ${s.kart} t=${s.time}: ${s.kind} - ${s.detail}`);
  if (instabilities.length > 15) out.push(`  ... ${instabilities.length - 15} more`);
  const dnf = races.filter((r) => !r.completed);
  for (const r of dnf.slice(0, 10)) out.push(`  ! DNF race ${r.index + 1} ${r.track} ${r.difficulty} seed ${r.seed}: ${r.results.filter((x) => !x.finished).map((x) => x.character).join(', ')}`);

  const ok = completed === R && instabilities.length === 0;
  out.push('');
  out.push(ok ? 'RESULT: PASS (100% completion, no instability)' : 'RESULT: FAIL');
  console.log(out.join('\n'));

  if (opts.json) {
    const json = {
      options: opts,
      summary: {
        races: R, completed, completionRate: completed / R, simSeconds, wallSeconds: wallSec, speedup: simSeconds / wallSec,
        avgDuration: mean(durations), minDuration: Math.min(...durations), maxDuration: Math.max(...durations), avgWinnerTime: mean(winnerTimes),
      },
      tracks: Object.fromEntries(tracks.map((t) => [t.def.id, { length: t.length, laps: t.def.laps, avgLap: mean(lapTimesByTrack[t.def.id] ?? []) }])),
      characters: chars,
      counters,
      totals: statTotals,
      instabilities,
      races,
      pass: ok,
    };
    writeFileSync(opts.json, JSON.stringify(json, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2));
    console.log(`Wrote ${opts.json}`);
  }
  process.exitCode = ok ? 0 : 1;
}

main();
