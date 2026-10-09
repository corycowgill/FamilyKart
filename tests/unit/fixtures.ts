/**
 * Synthetic track fixtures + helpers so physics / race tests don't depend on art tracks.
 */
import type { Vec3 } from '../../src/core/math';
import { createKart } from '../../src/sim/kart/KartPhysics';
import { tuningFromStats } from '../../src/sim/kart/kartConfig';
import { characterById } from '../../src/data/characters';
import { RaceSim, type RaceConfig } from '../../src/sim/race/RaceSim';
import { Track, type TrackQuery, type TrackSample } from '../../src/sim/track/Track';
import type { CharacterId, KartInput, KartState, TrackDef, TrackPoint } from '../../src/sim/types';

export const ALL_CHARACTERS: CharacterId[] = ['dad', 'mom', 'bro1', 'bro2', 'lupin', 'grandma'];

/** Build a complete TrackDef with sensible empty defaults. */
export function makeTrackDef(id: string, points: TrackPoint[], extra: Partial<TrackDef> = {}): TrackDef {
  return {
    id,
    name: id,
    theme: 'neighborhood',
    description: 'test fixture',
    difficulty: 1,
    laps: 3,
    points,
    width: 18,
    shoulder: 7,
    shortcuts: [],
    surfaces: [],
    boostPads: [],
    ramps: [],
    gaps: [],
    itemRows: [],
    hazards: [],
    landmarks: [],
    lighting: {
      skyTop: '#000', skyBottom: '#000', fog: '#000', fogNear: 1, fogFar: 2, sun: '#fff', sunIntensity: 1, ambient: '#fff', ground: '#0f0',
    },
    music: { tempo: 120, root: 60, scale: 'major', style: 'test' },
    ...extra,
  };
}

/** Round oval, ~ 2*pi*90 ≈ 570 m long, constant gentle curvature. Runs counter-clockwise seen from +y (left turns). */
export const OVAL_POINTS: TrackPoint[] = Array.from({ length: 16 }, (_, i) => {
  const a = (i / 16) * Math.PI * 2;
  return [Math.cos(a) * 110, Math.sin(a) * 70] as TrackPoint;
});

/**
 * Stadium loop: a 500 m straight along x = 0 heading +z (s ≈ 0..500), a right-hand hairpin, the back straight
 * along x = -80 heading -z, and another hairpin back to the start.
 */
export const STADIUM_POINTS: TrackPoint[] = [
  [0, -250], [0, -125], [0, 0], [0, 125], [0, 250],
  [-15, 285], [-40, 298], [-65, 285],
  [-80, 250], [-80, 125], [-80, 0], [-80, -125], [-80, -250],
  [-65, -285], [-40, -298], [-15, -285],
];

export const OVAL: TrackDef = makeTrackDef('test-oval', OVAL_POINTS, { laps: 3, itemRows: [0.3, 0.75] });
export const STADIUM: TrackDef = makeTrackDef('test-stadium', STADIUM_POINTS, { laps: 2, itemRows: [0.2] });

const STADIUM_LENGTH = new Track(STADIUM).length;

/** Stadium with a ramp at s = 200 that clears a 12 m gap at s = 203..215. */
export const JUMP_STADIUM: TrackDef = makeTrackDef('test-jump', STADIUM_POINTS, {
  laps: 2,
  ramps: [{ t: 200 / STADIUM_LENGTH, impulse: 9, length: 9 }],
  gaps: [{ from: 203 / STADIUM_LENGTH, to: 215 / STADIUM_LENGTH }],
});

/** Stadium with a gap at s = 200..215 and no ramp: driving in means falling in. */
export const GAP_STADIUM: TrackDef = makeTrackDef('test-gap', STADIUM_POINTS, {
  laps: 2,
  gaps: [{ from: 200 / STADIUM_LENGTH, to: 215 / STADIUM_LENGTH }],
});

/**
 * An infinite flat road plane as a Track stand-in for pure vehicle-dynamics tests (no walls, no features).
 * Only the members stepKart touches are implemented.
 */
export function flatPlane(): Track {
  const sample = (s: number): TrackSample => ({
    x: 0, y: 0, z: s, tx: 0, tz: 1, nx: -1, nz: 0, halfWidth: 1e6, s, mainS: s, curvature: 0, gap: false, slope: 0,
  });
  const query = (pos: Vec3): TrackQuery => ({
    pathId: 0, index: 0, s: pos.z, mainS: pos.z, lateral: -pos.x, halfWidth: 1e6, wallDist: 1e6 + 7, groundY: 0, inGap: false,
    surface: 'road', onRoad: true, contained: true, nx: -1, nz: 0, tx: 0, tz: 1,
  });
  return { query, sampleAt: (_p: number, s: number) => sample(s), ramps: [], boostPads: [] } as unknown as Track;
}

/** A standalone kart (not in a RaceSim) at the origin facing +z. */
export function makeKart(character: CharacterId = 'dad', pos: Vec3 = { x: 0, y: 0, z: 0 }, yaw = 0): KartState {
  return createKart(0, character, tuningFromStats(characterById(character).stats), pos, yaw, pos.z);
}

export const input = (p: Partial<KartInput> = {}): KartInput => ({ throttle: 0, steer: 0, drift: false, useItem: false, useSpecial: false, ...p });

/** Put a kart on a path at distance s with a lateral offset, facing along the track, at rest. */
export function placeKart(track: Track, k: KartState, s: number, lateral = 0, speed = 0): void {
  const smp = track.sampleAt(0, s);
  const yaw = Math.atan2(smp.tx, smp.tz);
  k.pos = { x: smp.x + smp.nx * lateral, y: smp.y, z: smp.z + smp.nz * lateral };
  k.prevPos = { ...k.pos };
  k.yaw = k.prevYaw = yaw;
  k.vel = { x: smp.tx * speed, y: 0, z: smp.tz * speed };
  k.forwardSpeed = speed;
  k.vy = 0;
  k.grounded = true;
  k.mainS = s;
  k.lateral = lateral;
  k.pathId = 0;
  k.lastSafe = { pos: { ...k.pos }, yaw, mainS: s, pathId: 0 };
}

/** Place a kart inside a RaceSim, keeping race progress consistent with its new position. */
export function placeInSim(sim: RaceSim, k: KartState, s: number, lateral = 0, speed = 0): void {
  placeKart(sim.track, k, s, lateral, speed);
  k.raceDistance = s;
}

/** Simple centre-line follower used to drive "human" karts in tests. dir = -1 drives the wrong way. */
export function followTrack(track: Track, k: KartState, lateral = 0, dir = 1, throttle = 1): KartInput {
  const look = 8 + Math.max(0, k.forwardSpeed) * 0.4;
  const smp = track.sampleAt(0, k.mainS + look * dir);
  const tx = smp.x + smp.nx * lateral, tz = smp.z + smp.nz * lateral;
  let err = Math.atan2(tx - k.pos.x, tz - k.pos.z) - k.yaw;
  while (err > Math.PI) err -= Math.PI * 2;
  while (err < -Math.PI) err += Math.PI * 2;
  return input({ throttle, steer: Math.max(-1, Math.min(1, -err * 2.5)) });
}

/** A RaceSim with only human karts (they sit still unless driven), skipped past the countdown. */
export function humanSim(track: TrackDef | Track, n = 2, extra: Partial<RaceConfig> = {}): RaceSim {
  const sim = new RaceSim({
    track,
    racers: ALL_CHARACTERS.slice(0, n).map((c, i) => ({ character: c, playerIndex: i })),
    difficulty: 'normal',
    seed: 99,
    countdown: 0.05,
    ...extra,
  });
  while (sim.phase === 'countdown') sim.step([]);
  sim.drainEvents();
  return sim;
}

export function aiSim(track: TrackDef | Track, extra: Partial<RaceConfig> = {}, chars: CharacterId[] = ALL_CHARACTERS): RaceSim {
  return new RaceSim({
    track,
    racers: chars.map((c) => ({ character: c, playerIndex: -1 })),
    difficulty: 'normal',
    seed: 1,
    ...extra,
  });
}

/** Run a sim to completion; returns all events. */
export function runToEnd(sim: RaceSim, maxSteps = 60 * 900): ReturnType<RaceSim['drainEvents']> {
  const all: ReturnType<RaceSim['drainEvents']> = [];
  let n = 0;
  while (sim.phase !== 'finished' && n++ < maxSteps) {
    sim.step();
    for (const e of sim.drainEvents()) all.push(e);
  }
  return all;
}
