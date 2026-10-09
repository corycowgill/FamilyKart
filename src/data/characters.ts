import type { CharacterId, KartStats, SpecialId } from '../sim/types';

export interface CharacterDef {
  id: CharacterId;
  name: string;
  title: string;
  tagline: string;
  stats: KartStats;
  special: { id: SpecialId; name: string; description: string; cooldown: number };
  colors: { primary: string; secondary: string; accent: string; suit: string; suitAccent: string };
  emblem: 'x' | 'heart' | 'soccer' | 'bolt' | 'paw' | 'flower';
  /** Engine pitch multiplier so karts sound distinct. */
  enginePitch: number;
  /** AI personality tweaks. */
  ai: { aggression: number; risk: number; drift: number };
}

export const CHARACTERS: CharacterDef[] = [
  {
    id: 'dad', name: 'Dad', title: 'The Powerhouse', tagline: 'Confident, competitive, and slightly overenthusiastic.',
    stats: { speed: 4, acceleration: 3, handling: 3, weight: 4 },
    special: { id: 'dadBoost', name: 'Dad Boost', description: 'A massive straight-line burst with roaring exhaust flames.', cooldown: 36 },
    colors: { primary: '#1f4fd1', secondary: '#d62b2b', accent: '#ffffff', suit: '#1b2a55', suitAccent: '#d62b2b' },
    emblem: 'x', enginePitch: 0.85, ai: { aggression: 0.8, risk: 0.5, drift: 0.7 },
  },
  {
    id: 'mom', name: 'Mom', title: 'The Strategist', tagline: 'Clever, calm under pressure, and always smiling when she passes you.',
    stats: { speed: 3, acceleration: 4, handling: 4, weight: 2 },
    special: { id: 'momShield', name: 'Mom Shield', description: 'A protective bubble that blocks incoming attacks.', cooldown: 10 },
    colors: { primary: '#e84fb0', secondary: '#8a3fd1', accent: '#ffffff', suit: '#7b2fb5', suitAccent: '#e84fb0' },
    emblem: 'heart', enginePitch: 1.05, ai: { aggression: 0.5, risk: 0.3, drift: 0.8 },
  },
  {
    id: 'bro1', name: 'Bro 1', title: 'The Technician', tagline: 'Focused, strategic, and loves a clean overtake.',
    stats: { speed: 4, acceleration: 3, handling: 5, weight: 2 },
    special: { id: 'turboDrift', name: 'Turbo Drift', description: 'Drift boosts charge faster and hit harder for a while.', cooldown: 12 },
    colors: { primary: '#d81e1e', secondary: '#151515', accent: '#ffffff', suit: '#161616', suitAccent: '#d81e1e' },
    emblem: 'soccer', enginePitch: 1.1, ai: { aggression: 0.6, risk: 0.6, drift: 1 },
  },
  {
    id: 'bro2', name: 'Bro 2', title: 'The Wildcard', tagline: 'Playful, fearless, and always taking the risky shortcut.',
    stats: { speed: 4, acceleration: 5, handling: 3, weight: 2 },
    special: { id: 'lightningDash', name: 'Lightning Dash', description: 'A sudden burst that bumps nearby racers aside.', cooldown: 36 },
    colors: { primary: '#5cc72e', secondary: '#151515', accent: '#ffd21f', suit: '#1f5fd1', suitAccent: '#ffd21f' },
    emblem: 'bolt', enginePitch: 1.25, ai: { aggression: 0.7, risk: 0.95, drift: 0.6 },
  },
  {
    id: 'lupin', name: 'Lupin', title: 'The Chaos Machine', tagline: 'A fluffy Tibetan Terrier with zero brakes and maximum joy.',
    stats: { speed: 3, acceleration: 5, handling: 4, weight: 1 },
    special: { id: 'puppyPanic', name: 'Puppy Panic', description: 'Drops bouncing tennis balls that spin out racers behind.', cooldown: 10 },
    colors: { primary: '#ffcc1f', secondary: '#2a2a2a', accent: '#ffffff', suit: '#1d3a7a', suitAccent: '#ffffff' },
    emblem: 'paw', enginePitch: 1.4, ai: { aggression: 0.5, risk: 0.8, drift: 0.5 },
  },
  {
    id: 'grandma', name: 'Grandma', title: 'The Secret Weapon', tagline: 'Cheerful, sweet, and surprisingly ruthless.',
    stats: { speed: 3, acceleration: 3, handling: 4, weight: 3 },
    special: { id: 'grandmasRevenge', name: "Grandma's Revenge", description: 'Launches a homing pie at the racer ahead.', cooldown: 26 },
    colors: { primary: '#8fe3c8', secondary: '#ffffff', accent: '#ffd23f', suit: '#2ec4c4', suitAccent: '#ffffff' },
    emblem: 'flower', enginePitch: 0.95, ai: { aggression: 0.9, risk: 0.4, drift: 0.6 },
  },
];

export const characterById = (id: CharacterId): CharacterDef => {
  const c = CHARACTERS.find((ch) => ch.id === id);
  if (!c) throw new Error(`Unknown character ${id}`);
  return c;
};
