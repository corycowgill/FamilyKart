import type { ItemId } from '../types';

export interface ItemDef {
  id: ItemId;
  name: string;
  icon: string; // emoji used for the HUD inventory icon
  description: string;
  kind: 'boost' | 'projectile' | 'drop' | 'defense' | 'random';
}

export const ITEMS: Record<ItemId, ItemDef> = {
  turboSoda: { id: 'turboSoda', name: 'Turbo Soda', icon: '🥤', description: 'Fizzy speed boost.', kind: 'boost' },
  flyingPizza: { id: 'flyingPizza', name: 'Flying Pizza', icon: '🍕', description: 'Homes in on the racer ahead.', kind: 'projectile' },
  bananaPeel: { id: 'bananaPeel', name: 'Banana Peel', icon: '🍌', description: 'Drop it behind you.', kind: 'drop' },
  bubbleShield: { id: 'bubbleShield', name: 'Bubble Shield', icon: '🫧', description: 'Blocks one attack.', kind: 'defense' },
  giantDogBone: { id: 'giantDogBone', name: 'Giant Dog Bone', icon: '🦴', description: 'Rolls forward and knocks racers aside.', kind: 'projectile' },
  chicagoPothole: { id: 'chicagoPothole', name: 'Chicago Pothole', icon: '🕳️', description: 'Leaves a nasty pothole behind.', kind: 'drop' },
  rocketKart: { id: 'rocketKart', name: 'Rocket Kart', icon: '🚀', description: 'Huge boost, plows through hazards, less steering.', kind: 'boost' },
  mysteryBox: { id: 'mysteryBox', name: 'Mystery Box', icon: '❓', description: 'Turns into a random item.', kind: 'random' },
};

/**
 * Position-weighted item odds. p = 0 for the leader, 1 for last place.
 * Leaders get defensive / weak items, trailing racers get comeback items.
 */
export function itemWeights(p: number): Partial<Record<ItemId, number>> {
  const lead = 1 - p;
  return {
    bananaPeel: 3 * lead + 0.5,
    bubbleShield: 2 * lead + 0.6,
    chicagoPothole: 1.5 * lead + 0.4,
    turboSoda: 1 + 2 * p,
    flyingPizza: 0.4 + 2.4 * p,
    giantDogBone: 0.6 + 1.2 * Math.min(p * 2, 1) * (1 - p * 0.5),
    rocketKart: p > 0.55 ? 3 * (p - 0.55) * 2 : 0,
    mysteryBox: 0.6,
  };
}
