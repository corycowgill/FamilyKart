import { CHICAGO } from '../src/data/tracks/chicago';
import { RaceSim } from '../src/sim/race/RaceSim';
const sim = new RaceSim({ track: CHICAGO, racers: ['dad','mom','brennan','parker','lupin','grandma'].map((c) => ({ character: c as any, playerIndex: -1 })), difficulty: 'hard', seed: 7, timeLimit: 400 });
let last = 0;
while (sim.phase !== 'finished' && sim.time < 130) { sim.step(); const k = sim.karts[Number(process.argv[2]??0)];
 if (sim.time - last > 2) { last = sim.time; console.log(sim.time.toFixed(0), k.character, 'spd', k.forwardSpeed.toFixed(1), 'rd', k.raceDistance.toFixed(0), 'mainS', k.mainS.toFixed(0), 'path', k.pathId, 'pos', k.pos.x.toFixed(0), k.pos.z.toFixed(0), k.pos.y.toFixed(1), 'boost', k.boostTime.toFixed(1), k.surface, 'lap', k.lapsCompleted); } sim.drainEvents(); }
