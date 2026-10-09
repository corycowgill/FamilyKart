/**
 * Shared simulation contracts. Everything under src/sim is pure TypeScript with no DOM / Three.js
 * dependency so races can run headless (tests, balance simulation) and in the browser identically.
 */
import type { Vec3 } from '../core/math';

export type CharacterId = 'dad' | 'mom' | 'brennan' | 'parker' | 'lupin' | 'grandma';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type TrackTheme = 'chicago' | 'neighborhood' | 'kitchen' | 'dogpark' | 'snow';
export type SurfaceType = 'road' | 'offroad' | 'ice' | 'mud' | 'milk';

export type ItemId =
  | 'turboSoda'
  | 'flyingPizza'
  | 'bananaPeel'
  | 'bubbleShield'
  | 'giantDogBone'
  | 'chicagoPothole'
  | 'rocketKart'
  | 'mysteryBox';

export type SpecialId = 'dadBoost' | 'momShield' | 'turboDrift' | 'lightningDash' | 'puppyPanic' | 'grandmasRevenge';

/** 1..5 star ratings shown in the UI and converted into tuning values. */
export interface KartStats {
  speed: number;
  acceleration: number;
  handling: number;
  weight: number;
}

/** Concrete physics tuning derived from stats (see kart/kartConfig.ts). */
export interface KartTuning {
  maxSpeed: number;
  acceleration: number;
  reverseSpeed: number;
  brake: number;
  steer: number;
  driftSteer: number;
  traction: number;
  lateralGrip: number;
  driftGrip: number;
  suspension: number;
  mass: number;
  collisionImpulse: number;
  boostMultiplier: number;
  boostDuration: number;
  offroadPenalty: number;
  radius: number;
}

export interface KartInput {
  throttle: number; // -1 (brake/reverse) .. 1
  steer: number; // -1 left .. 1 right
  drift: boolean;
  useItem: boolean;
  useSpecial: boolean;
  rearView?: boolean;
}

export const NO_INPUT: KartInput = { throttle: 0, steer: 0, drift: false, useItem: false, useSpecial: false };

/* ------------------------------------------------------------------ Track definitions (data) */

/** Control point: [x, z, y?, widthOverride?]. Closed loop for the main path. */
export type TrackPoint = [number, number, number?, number?];

export interface TrackRange {
  /** fraction of main-path length 0..1 */
  from: number;
  to: number;
}

export interface ShortcutDef {
  id: string;
  /** Control points of the shortcut corridor, first and last should sit on the main road. */
  points: TrackPoint[];
  width: number;
  /** Main path fractions where the shortcut leaves and rejoins. */
  from: number;
  to: number;
  surface?: SurfaceType;
  /** AI preference 0..1 (scaled by difficulty). */
  aiAppeal: number;
}

export interface TrackDef {
  id: string;
  name: string;
  theme: TrackTheme;
  description: string;
  difficulty: 1 | 2 | 3;
  laps: number;
  points: TrackPoint[];
  width: number;
  /** Drivable off-road margin outside the road before the barrier. */
  shoulder: number;
  shortcuts: ShortcutDef[];
  surfaces: Array<TrackRange & { type: SurfaceType; side?: 'left' | 'right' | 'both' }>;
  boostPads: Array<{ t: number; lateral: number }>;
  ramps: Array<{ t: number; impulse: number; length?: number; shortcut?: string }>;
  /** Gaps in the road (e.g. bridge jump) - must be preceded by a ramp. */
  gaps: TrackRange[];
  itemRows: number[];
  hazards: Array<HazardDef>;
  /** Theme specific landmark placements the renderer uses (positions in world space). */
  landmarks: Array<{ kind: string; x: number; z: number; y?: number; rot?: number; scale?: number }>;
  lighting: {
    skyTop: string;
    skyBottom: string;
    fog: string;
    fogNear: number;
    fogFar: number;
    sun: string;
    sunIntensity: number;
    ambient: string;
    ground: string;
  };
  music: { tempo: number; root: number; scale: 'major' | 'minor' | 'mixolydian' | 'dorian'; style: string };
}

export interface HazardDef {
  kind: 'sprinkler' | 'rollingFruit' | 'snowplow' | 'sprinklerMud' | 'tennisBallCannon' | 'train';
  t: number;
  /** lateral sweep amplitude in meters (moving hazards) */
  sweep?: number;
  period?: number;
  radius?: number;
}

/* ------------------------------------------------------------------ Runtime state */

export interface DriftState {
  active: boolean;
  dir: number; // -1 left, 1 right
  charge: number; // seconds of effective charge
  tier: 0 | 1 | 2 | 3;
  hopPending: boolean;
}

export interface KartState {
  id: number;
  character: CharacterId;
  isHuman: boolean;
  playerIndex: number; // -1 for AI
  tuning: KartTuning;
  pos: Vec3;
  prevPos: Vec3;
  yaw: number;
  prevYaw: number;
  vel: Vec3; // horizontal velocity in x/z, y unused
  vy: number;
  grounded: boolean;
  airTime: number;
  forwardSpeed: number;
  steerVisual: number;
  suspension: number; // visual compression 0..1
  suspensionVel: number;
  drift: DriftState;
  boostTime: number;
  boostPower: number;
  boostKind: 'none' | 'drift1' | 'drift2' | 'drift3' | 'item' | 'pad' | 'special' | 'rocket';
  spinTime: number;
  spinDir: number;
  invulnTime: number;
  shieldTime: number;
  rocketTime: number;
  turboDriftTime: number;
  offroad: boolean;
  surface: SurfaceType;
  // track tracking
  pathId: number;
  sampleHint: number;
  mainS: number;
  lateral: number;
  raceDistance: number;
  lapsCompleted: number;
  nextCheckpoint: number;
  lastLapTime: number;
  bestLapTime: number;
  lapStartTime: number;
  lapTimes: number[];
  finished: boolean;
  finishTime: number;
  finishPlace: number;
  place: number;
  // items
  item: ItemId | null;
  itemRoulette: number; // seconds remaining in roulette animation
  specialCooldown: number;
  specialMax: number;
  // recovery
  stuckTime: number;
  respawnTime: number;
  lastSafe: { pos: Vec3; yaw: number; mainS: number; pathId: number };
  wrongWayTime: number;
  // telemetry
  stats: { overtakes: number; collisions: number; itemsUsed: number; hitsTaken: number; respawns: number; driftBoosts: number; offTrack: number };
  // visual reaction (consumed by renderer)
  reaction: 'none' | 'hit' | 'item' | 'overtake' | 'jump' | 'win' | 'lose';
  reactionTime: number;
}

export type ProjectileKind = 'pizza' | 'pie' | 'bone';
export interface Projectile {
  id: number;
  kind: ProjectileKind;
  owner: number;
  target: number; // kart id or -1
  pos: Vec3;
  prevPos: Vec3;
  yaw: number;
  s: number; // main path distance it is tracking
  lateral: number;
  speed: number;
  life: number;
  age: number;
}

export type HazardKind = 'banana' | 'tennisBall' | 'pothole';
export interface DroppedHazard {
  id: number;
  kind: HazardKind;
  owner: number;
  pos: Vec3;
  vel: Vec3;
  radius: number;
  life: number;
  age: number;
}

export interface ItemBox {
  id: number;
  pos: Vec3;
  respawn: number; // >0 while hidden
}

export interface MovingHazard {
  id: number;
  def: HazardDef;
  pos: Vec3;
  yaw: number;
  radius: number;
  phase: number;
}

export type RacePhase = 'countdown' | 'racing' | 'finished';

export type SimEvent =
  | { type: 'countdown'; n: number }
  | { type: 'go' }
  | { type: 'lap'; kart: number; lap: number; time: number }
  | { type: 'finalLap'; kart: number }
  | { type: 'finish'; kart: number; place: number; time: number }
  | { type: 'raceOver' }
  | { type: 'itemPickup'; kart: number }
  | { type: 'itemGranted'; kart: number; item: ItemId }
  | { type: 'itemUse'; kart: number; item: ItemId }
  | { type: 'special'; kart: number; special: SpecialId }
  | { type: 'hit'; kart: number; by: number; cause: string }
  | { type: 'shieldBlock'; kart: number }
  | { type: 'boost'; kart: number; kind: KartState['boostKind'] }
  | { type: 'driftTier'; kart: number; tier: number }
  | { type: 'driftStart'; kart: number }
  | { type: 'jump'; kart: number }
  | { type: 'land'; kart: number; impact: number }
  | { type: 'bump'; a: number; b: number; impact: number }
  | { type: 'wall'; kart: number; impact: number }
  | { type: 'respawn'; kart: number }
  | { type: 'overtake'; kart: number; passed: number }
  | { type: 'projectile'; id: number; kind: ProjectileKind; owner: number }
  | { type: 'drop'; kind: HazardKind; owner: number };
