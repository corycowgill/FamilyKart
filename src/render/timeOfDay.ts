import * as THREE from 'three';
import type { TrackDef } from '../sim/types';
import type { GradeSettings } from './PostFX';

/** Time of day a race is rendered at. 'day' = the track's own authored lighting. */
export type TimeOfDay = 'day' | 'sunset' | 'night';

export const TIMES_OF_DAY: readonly TimeOfDay[] = ['day', 'sunset', 'night'];

const isTod = (v: unknown): v is TimeOfDay => v === 'day' || v === 'sunset' || v === 'night';

/** Debug / test hook: `?tod=night|sunset|day` in the page URL overrides the session option. */
export function urlTimeOfDay(): TimeOfDay | undefined {
  try {
    const v = new URLSearchParams(globalThis.location?.search ?? '').get('tod');
    return isTod(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The time of day a session should use: URL override, else the option, else 'day'. */
export function resolveTimeOfDay(opt?: TimeOfDay): TimeOfDay {
  return urlTimeOfDay() ?? (isTod(opt) ? opt : 'day');
}

/** Chicago-flavoured tracks (Grand Prix + Sweet Home) get Navy Pier fireworks. */
export function isChicagoTrack(def: TrackDef): boolean {
  return def.theme === 'chicago' || def.scenery === 'sweethome';
}

/** Everything a time-of-day preset changes. `null` from todLook() means "authored daylight". */
export interface TodLook {
  tod: Exclude<TimeOfDay, 'day'>;
  /** 0 = day, ~0.5 = sunset, 1 = night (scales glow effects) */
  night: number;
  indoor: boolean;
  /** derived lighting (sky, fog, hemi colours) */
  lighting: TrackDef['lighting'];
  /** direction*distance from the focus to the sun / moon / lamp */
  keyOffset: THREE.Vector3;
  keyColor: string;
  keyIntensity: number;
  hemiIntensity: number;
  rim: { color: string; intensity: number } | null;
  grade: Partial<GradeSettings>;
  /** sky dome */
  sky: {
    haze: string;
    mid: string | null;
    midAmt: number;
    discCol: string;
    disc: number;
    /** cos of the disc angular radius */
    discCos: number;
    moon: boolean;
    stars: number;
    cover: number;
    cloudLit: string;
    cloudShade: string;
    /** glow around the sun (sunset haze) */
    glow: number;
  };
  envIntensity: number;
  emissive: { map: number; mapMin: number; plain: number; basic: number; windowProb: number };
  /** street-lamp light pools (0 = none) */
  lamps: number;
  lampColor: string;
  /** kart head/tail lights strength */
  headlights: number;
  /** fireworks rate multiplier (0 = none) */
  fireworks: number;
  /** water retint */
  water: { body: number; tint: string; skyTop: string; skyHorizon: string; glint: string; stretch: number };
  /** screen-space sun flare strength */
  flare: number;
  flareColor: string;
  /** wet-road sheen (0..1) */
  wet: number;
}

function sunsetOffset(theme: string): THREE.Vector3 {
  // low, long-shadow sun. Chicago: sets in the west behind the skyline (the lake is east).
  switch (theme) {
    case 'chicago': return new THREE.Vector3(-205, 40, 70);
    case 'snow': return new THREE.Vector3(-190, 30, 120);
    case 'kitchen': return new THREE.Vector3(-200, 70, 90);
    default: return new THREE.Vector3(-170, 42, 130);
  }
}

function moonOffset(theme: string): THREE.Vector3 {
  // Chicago: the moon rises over Lake Michigan (east) so it glints on the water
  switch (theme) {
    case 'chicago': return new THREE.Vector3(200, 105, -55);
    case 'snow': return new THREE.Vector3(150, 120, -110);
    default: return new THREE.Vector3(140, 150, -100);
  }
}

const mix = (a: string, b: string, t: number) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString();

/** Derive a time-of-day look from a track's authored lighting. Returns null for 'day'. */
export function todLook(def: TrackDef, tod: TimeOfDay): TodLook | null {
  if (tod === 'day') return null;
  const L = def.lighting;
  const theme = def.theme;
  const indoor = theme === 'kitchen';
  const chicago = isChicagoTrack(def);
  const lampColor = theme === 'snow' ? '#ffd9a6' : chicago ? '#ffb45e' : theme === 'dogpark' ? '#fff0c4' : '#ffc77a';

  if (indoor) {
    // kitchen: no stars or moon, just warm lamp light (pendant lamps over the counter)
    const night = tod === 'night';
    return {
      tod, night: night ? 1 : 0.5, indoor,
      lighting: {
        ...L,
        skyTop: night ? '#2a1e18' : '#e8a878', skyBottom: night ? '#4a3220' : '#ffd0a0',
        fog: night ? '#3a281a' : '#f0c8a0', fogNear: L.fogNear, fogFar: L.fogFar * 1.1,
        sun: night ? '#ffbf7a' : '#ffb070', sunIntensity: L.sunIntensity,
        ambient: night ? '#ffb27a' : '#ffd6b0', ground: night ? '#5a3a24' : '#d8b896',
      },
      keyOffset: night ? new THREE.Vector3(-25, 230, 30) : sunsetOffset(theme),
      keyColor: night ? '#ffc07e' : '#ffb46e',
      keyIntensity: L.sunIntensity * (night ? 0.42 : 0.8),
      hemiIntensity: night ? 0.3 : 0.7,
      rim: { color: night ? '#ff9a5a' : '#ffc0a0', intensity: night ? 0.45 : 0.5 },
      grade: night
        ? { saturation: 1.14, contrast: 1.1, tint: '#fff0dc', shadowTint: '#e6dcff', highlightTint: '#fff0d6', vignette: 0.48, exposure: 0.92, bloomThreshold: 1.25, bloomStrength: 0.75 }
        : { saturation: 1.16, contrast: 1.08, tint: '#fff0e0', shadowTint: '#f2e6ff', highlightTint: '#ffeed8', vignette: 0.32, exposure: 1.0, bloomThreshold: 1.4, bloomStrength: 0.6 },
      sky: { haze: night ? '#4a3220' : '#ffd0a0', mid: null, midAmt: 0, discCol: '#000000', disc: 0, discCos: 0.9993, moon: false, stars: 0, cover: 1, cloudLit: '#ffffff', cloudShade: '#888888', glow: 0 },
      envIntensity: night ? 0.3 : 0.8,
      emissive: night ? { map: 2.5, mapMin: 1, plain: 1.7, basic: 1.5, windowProb: 0 } : { map: 1.3, mapMin: 0.3, plain: 1.2, basic: 1.1, windowProb: 0 },
      lamps: 0, lampColor,
      headlights: night ? 0.8 : 0.35,
      fireworks: 0,
      water: { body: night ? 0.5 : 0.85, tint: '#ffd8b0', skyTop: night ? '#3a2a20' : '#e8a878', skyHorizon: night ? '#6a4a30' : '#ffd0a0', glint: '#ffc890', stretch: 0 },
      flare: 0, flareColor: '#ffc890',
      wet: 0,
    };
  }

  if (tod === 'sunset') {
    const skyTop = theme === 'snow' ? '#2a2462' : '#3a3584';
    const skyBottom = theme === 'snow' ? '#ff9a6a' : '#ffa060';
    return {
      tod, night: 0.5, indoor,
      lighting: {
        ...L,
        skyTop, skyBottom,
        fog: theme === 'snow' ? '#b7869a' : '#e6a58e',
        fogNear: L.fogNear, fogFar: L.fogFar,
        sun: '#ffb47a', sunIntensity: L.sunIntensity,
        ambient: '#b6a0dc', ground: mix(L.ground, '#5a3a4a', 0.45),
      },
      keyOffset: sunsetOffset(theme),
      keyColor: '#ffa868',
      keyIntensity: L.sunIntensity * 1.05,
      hemiIntensity: 0.85,
      rim: { color: '#ff9cc0', intensity: 0.65 },
      grade: { saturation: 1.2, contrast: 1.08, tint: '#fff2e4', shadowTint: '#e4d8ff', highlightTint: '#ffe8cc', vignette: 0.3, exposure: 1.02, bloomThreshold: 0.9, bloomStrength: 0.85 },
      sky: {
        haze: '#ff8f84', mid: '#e86a9a', midAmt: 0.55, discCol: '#ffc078', disc: 3.2, discCos: 0.9988, moon: false, stars: 0.0,
        cover: 0.62, cloudLit: '#ffb48a', cloudShade: '#7c5a9c', glow: 1.6,
      },
      envIntensity: 0.5,
      emissive: { map: 1.8, mapMin: 0.55, plain: 1.35, basic: 1.2, windowProb: 0.22 },
      lamps: 0.55, lampColor,
      headlights: 0.55,
      fireworks: chicago ? 0.5 : 0,
      water: { body: 0.8, tint: '#ffc0a0', skyTop: '#6a4a9c', skyHorizon: '#ff9a70', glint: '#ffc078', stretch: 0.5 },
      flare: 1, flareColor: '#ffb070',
      wet: 0,
    };
  }

  // night
  const cityGlow = chicago ? '#3b2f5e' : theme === 'snow' ? '#2c3364' : '#22305e';
  return {
    tod, night: 1, indoor,
    lighting: {
      ...L,
      skyTop: '#050a22', skyBottom: cityGlow,
      fog: theme === 'snow' ? '#283258' : '#18204a',
      fogNear: L.fogNear * 1.1, fogFar: L.fogFar * 1.25,
      sun: '#46557a', sunIntensity: L.sunIntensity,
      ambient: '#6f86c8', ground: theme === 'snow' ? '#6a7aa0' : '#2a3048',
    },
    keyOffset: moonOffset(theme),
    keyColor: '#a9bcff',
    keyIntensity: theme === 'snow' ? 0.55 : 0.75,
    hemiIntensity: theme === 'snow' ? 0.8 : 0.95,
    rim: { color: '#7f9cff', intensity: 0.8 },
    grade: { saturation: 1.12, contrast: 1.06, tint: '#f2f4ff', shadowTint: '#ccd6ff', highlightTint: '#fff0d8', vignette: 0.34, exposure: theme === 'snow' ? 1.12 : 1.3, bloomThreshold: theme === 'snow' ? 0.95 : 0.6, bloomStrength: theme === 'snow' ? 0.85 : 1.05 },
    sky: {
      haze: chicago ? '#4a3a66' : '#2a3466', mid: null, midAmt: 0, discCol: '#e6eeff', disc: 1.15, discCos: 0.99976, moon: true, stars: 1,
      cover: 0.72, cloudLit: '#3c4878', cloudShade: '#121836', glow: 0.25,
    },
    envIntensity: 0.4,
    emissive: { map: 4, mapMin: 1.4, plain: 2.2, basic: 1.6, windowProb: 0.42 },
    lamps: 1, lampColor,
    headlights: 1,
    fireworks: chicago ? 1 : 0,
    water: { body: 0.32, tint: '#7088c8', skyTop: '#0a1030', skyHorizon: chicago ? '#4a3a6a' : '#2a3466', glint: '#dfe8ff', stretch: 1 },
    flare: 0, flareColor: '#ffffff',
    wet: 1,
  };
}
