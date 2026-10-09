import { CHICAGO } from '../src/data/tracks/chicago';
import { RaceSim } from '../src/sim/race/RaceSim';
import { Track } from '../src/sim/track/Track';
const track = new Track(CHICAGO);
console.log('length', track.length.toFixed(0), 'samples', track.paths[0].samples.length, 'shortcut len', track.paths[1]?.length.toFixed(0));
const sim = new RaceSim({ track, racers: ['dad','mom','brennan','parker','lupin','grandma'].map((c) => ({ character: c as any, playerIndex: -1 })), difficulty: 'hard', seed: 7, timeLimit: 400 });
const counts: Record<string, number> = {};
while (sim.phase !== 'finished') { sim.step(); for (const e of sim.drainEvents()) counts[e.type] = (counts[e.type] ?? 0) + 1; }
console.log('time', sim.time.toFixed(1), counts);
for (const k of sim.karts) console.log(k.character, k.finishPlace, k.finished, k.finishTime.toFixed(1), k.lapTimes.map(t=>t.toFixed(1)).join(','), JSON.stringify(k.stats));
