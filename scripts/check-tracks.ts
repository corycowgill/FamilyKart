/**
 * Track validation: geometry lint + headless AI-only races on every track.
 * Run: npx tsx scripts/check-tracks.ts [trackId...]
 */
import { TRACKS } from '../src/data/tracks';
import { RaceSim } from '../src/sim/race/RaceSim';
import { Track } from '../src/sim/track/Track';
import type { CharacterId, Difficulty, TrackDef } from '../src/sim/types';

const RACERS: CharacterId[] = ['dad', 'mom', 'brennan', 'parker', 'lupin', 'grandma'];
const RUNS: Array<{ difficulty: Difficulty; seed: number }> = [
  { difficulty: 'normal', seed: 11 },
  { difficulty: 'hard', seed: 222 },
  { difficulty: 'normal', seed: 3333 },
];

const filter = process.argv.slice(2);
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/** Static geometry checks: self-proximity of the main loop, shortcut overlap, wall self-intersection. */
function lint(def: TrackDef, track: Track): string[] {
  const issues: string[] = [];
  const main = track.paths[0];
  const S = main.samples;
  const n = S.length;
  const wd = (i: number) => S[i].halfWidth + def.shoulder;
  // main vs itself
  let worst = Infinity;
  let worstAt = '';
  for (let i = 0; i < n; i += 2) {
    for (let j = i + 2; j < n; j += 2) {
      const ds = Math.min(Math.abs(S[i].s - S[j].s), track.length - Math.abs(S[i].s - S[j].s));
      const need = wd(i) + wd(j) + 4;
      if (ds < need * 2.2) continue;
      if (Math.abs(S[i].y - S[j].y) >= 6) continue;
      const d = Math.hypot(S[i].x - S[j].x, S[i].z - S[j].z);
      if (d - need < worst) {
        worst = d - need;
        worstAt = `(${S[i].x.toFixed(0)},${S[i].z.toFixed(0)})~(${S[j].x.toFixed(0)},${S[j].z.toFixed(0)}) d=${d.toFixed(1)} need=${need.toFixed(1)}`;
      }
    }
  }
  if (worst < 0) issues.push(`main road too close to itself: ${worstAt}`);
  // inner wall self-intersection: radius must exceed wallDist
  for (let i = 0; i < n; i++) {
    const c = Math.abs(S[i].curvature);
    if (c > 1e-4 && 1 / c < wd(i) + 1) {
      issues.push(`corner radius ${(1 / c).toFixed(1)}m < wallDist ${wd(i).toFixed(1)} at (${S[i].x.toFixed(0)},${S[i].z.toFixed(0)})`);
      break;
    }
  }
  // shortcuts vs main away from junctions, and vs other shortcuts
  for (let p = 1; p < track.paths.length; p++) {
    const P = track.paths[p];
    const sc = P.shortcut!;
    const a = sc.from * track.length, b = sc.to * track.length;
    for (const smp of P.samples) {
      if (smp.s < 3 || smp.s > P.length - 3) continue;
      for (let i = 0; i < n; i++) {
        const m = S[i];
        // near junction: skip main samples within the shortcut's span ends
        const da = Math.min(Math.abs(m.s - a), track.length - Math.abs(m.s - a));
        const db = Math.min(Math.abs(m.s - b), track.length - Math.abs(m.s - b));
        const nearJ = (da < 75 && smp.s < 75) || (db < 75 && smp.s > P.length - 75);
        if (nearJ) continue;
        if (Math.abs(m.y - smp.y) >= 6) continue;
        const d = Math.hypot(m.x - smp.x, m.z - smp.z);
        const need = wd(i) + smp.halfWidth + def.shoulder + 1;
        if (d < need) {
          issues.push(`shortcut ${sc.id} overlaps main at (${smp.x.toFixed(0)},${smp.z.toFixed(0)}) s=${smp.s.toFixed(0)} d=${d.toFixed(1)} need=${need.toFixed(1)}`);
          break;
        }
      }
      if (issues.length > 6) break;
    }
    // endpoints on main road?
    for (const end of [P.samples[0], P.samples[P.samples.length - 1]]) {
      const q = track.query({ x: end.x, y: end.y, z: end.z }, 0);
      if (!q || q.pathId !== 0 && !(Math.abs(q.lateral) < 1)) {
        // re-check against main explicitly
      }
      let best = Infinity;
      for (const m of S) best = Math.min(best, Math.hypot(m.x - end.x, m.z - end.z) - m.halfWidth - def.shoulder);
      if (best > 0) issues.push(`shortcut ${sc.id} endpoint (${end.x.toFixed(0)},${end.z.toFixed(0)}) is ${best.toFixed(1)}m outside the main corridor`);
    }
  }
  // slopes
  let maxSlope = 0;
  for (const smp of S) maxSlope = Math.max(maxSlope, Math.abs(smp.slope));
  if (maxSlope > 0.1) issues.push(`max slope ${(maxSlope * 100).toFixed(1)}%`);
  return issues;
}

interface RunStats {
  allFinished: boolean;
  duration: number;
  lapTimes: number[];
  respawns: number;
  walls: number;
  shortcutKarts: number;
  stuck: number;
  hits: number;
}

function runRace(def: TrackDef, track: Track, difficulty: Difficulty, seed: number): RunStats {
  const sim = new RaceSim({ track, racers: RACERS.map((c) => ({ character: c, playerIndex: -1 })), difficulty, seed, timeLimit: 480 });
  let walls = 0, respawns = 0, hits = 0;
  const usedShortcut = new Set<number>();
  const slowTime = new Array(sim.karts.length).fill(0);
  let stuck = 0;
  while (sim.phase !== 'finished') {
    sim.step();
    for (const e of sim.drainEvents()) {
      if (e.type === 'wall') walls++;
      else if (e.type === 'respawn') respawns++;
      else if (e.type === 'hit') hits++;
    }
    if (sim.phase !== 'racing') continue;
    for (const k of sim.karts) {
      if (k.pathId > 0) usedShortcut.add(k.id);
      if (k.finished || k.respawnTime > 0 || k.spinTime > 0) {
        slowTime[k.id] = 0;
        continue;
      }
      if (Math.abs(k.forwardSpeed) < 2) {
        slowTime[k.id] += sim.dt;
        if (Math.abs(slowTime[k.id] - 2) < sim.dt / 2) stuck++;
      } else slowTime[k.id] = 0;
    }
  }
  void def;
  const lapTimes = sim.karts.flatMap((k) => k.lapTimes);
  return {
    allFinished: sim.karts.every((k) => k.finished),
    duration: Math.max(...sim.karts.map((k) => (k.finished ? k.finishTime : sim.time))),
    lapTimes,
    respawns,
    walls,
    shortcutKarts: usedShortcut.size,
    stuck,
    hits,
  };
}

let failed = false;
const rows: string[] = [];
for (const def of TRACKS) {
  if (filter.length && !filter.includes(def.id)) continue;
  const track = new Track(def);
  const issues = lint(def, track);
  console.log(`\n=== ${def.name} (${def.id}) length ${track.length.toFixed(0)} m, shortcuts ${track.paths.slice(1).map((p) => p.length.toFixed(0) + 'm').join(', ')}`);
  if (issues.length) {
    failed = true;
    for (const i of issues) console.log('  LINT:', i);
  } else console.log('  lint ok');
  for (const r of RUNS) {
    const t0 = Date.now();
    const st = runRace(def, track, r.difficulty, r.seed);
    const lt = st.lapTimes;
    const lapMin = Math.min(...lt), lapMax = Math.max(...lt), lapAvg = lt.reduce((a, b) => a + b, 0) / lt.length;
    const ok = st.allFinished && st.duration > 140 && st.duration < 280 && st.respawns <= 4;
    if (!ok) failed = true;
    const line =
      `  ${r.difficulty.padEnd(6)} seed ${String(r.seed).padEnd(5)} finished=${st.allFinished ? 'ALL' : 'NO '} race ${fmt(st.duration)} ` +
      `laps ${lapMin.toFixed(1)}/${lapAvg.toFixed(1)}/${lapMax.toFixed(1)}s respawns ${st.respawns} walls ${st.walls} hits ${st.hits} ` +
      `shortcut ${st.shortcutKarts}/6 stuck ${st.stuck} ${ok ? 'OK' : 'FAIL'} (${Date.now() - t0}ms)`;
    console.log(line);
    rows.push(`${def.id.padEnd(13)}${line.trim()}`);
  }
}
console.log('\nSummary');
for (const r of rows) console.log(r);
console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL TRACKS PASS');
process.exitCode = failed ? 1 : 0;
