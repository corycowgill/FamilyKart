import { CHICAGO } from '../src/data/tracks/chicago';
import { RaceSim } from '../src/sim/race/RaceSim';
const sim = new RaceSim({ track: CHICAGO, racers: ['dad','mom','brennan','parker','lupin','grandma'].map((c) => ({ character: c as any, playerIndex: -1 })), difficulty: 'hard', seed: 7, timeLimit: 400 });
const id = Number(process.argv[2] ?? 3);
let slowT = 0;
while (sim.phase !== 'finished') { sim.step(); const k = sim.karts[id];
 for (const e of sim.drainEvents()) if ((e.type==='wall' && e.kart===id) || (e.type==='bump' && (e.a===id||e.b===id))) console.log(sim.time.toFixed(1), e.type, 'mainS', k.mainS.toFixed(0), 'path', k.pathId, 'lat', k.lateral.toFixed(1), 'spd', k.forwardSpeed.toFixed(1));
 if (k.forwardSpeed < 8 && sim.time > 3) { slowT += sim.dt; } else if (slowT > 1) { console.log('slow for', slowT.toFixed(1), 'at', k.mainS.toFixed(0), 'path', k.pathId); slowT = 0 } else slowT = 0;
}
