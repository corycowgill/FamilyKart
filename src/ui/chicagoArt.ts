/**
 * Reusable Chicago-flavoured UI art: the six-pointed Chicago flag star, flag stripes,
 * CTA "L" line colours and the per-track "station" identities used by the menus and HUD.
 * Everything here is plain SVG/HTML strings so it is cheap to drop into innerHTML.
 */
import type { TrackDef } from '../sim/types';

/** Chicago flag colours. */
export const CHI = {
  red: '#E4002B',
  blue: '#41B6E6',
  white: '#FFFFFF',
} as const;

/** CTA "L" line colours (used for menu "line bullets" and track station signs). */
export const CTA = {
  red: '#C60C30',
  blue: '#00A1DE',
  brown: '#62361B',
  green: '#009B3A',
  orange: '#F9461C',
  purple: '#522398',
  pink: '#E27EA6',
  yellow: '#F9E300',
} as const;
export type CtaLine = keyof typeof CTA;

/** Six sharp points, 0..100 viewBox (same shape as the stars on the Chicago flag). */
export const STAR_PATH = 'M50,0L60.5,31.8L93.3,25L71,50L93.3,75L60.5,68.2L50,100L39.5,68.2L6.7,75L29,50L6.7,25L39.5,31.8Z';

/** Inline SVG Chicago star. `cls` lets CSS size/animate it. */
export function starSvg(cls = 'chi-star', fill: string = CHI.red, stroke = ''): string {
  const s = stroke ? ` stroke="${stroke}" stroke-width="7" stroke-linejoin="round" paint-order="stroke"` : '';
  return `<svg class="${cls}" viewBox="-4 -4 108 108" aria-hidden="true"><path d="${STAR_PATH}" fill="${fill}"${s}/></svg>`;
}

/** The four flag stars in a row. */
export function starRow(n = 4, cls = 'chi-star'): string {
  return `<span class="star-row">${Array.from({ length: n }, () => starSvg(cls, CHI.red, '#fff')).join('')}</span>`;
}

/** Mini Chicago flag: white field, two light-blue stripes, four red stars. */
export function flagSvg(cls = 'chi-flag'): string {
  const stars = [0, 1, 2, 3].map((i) => `<path d="${STAR_PATH}" transform="translate(${32 + i * 34},11) scale(0.18)" fill="${CHI.red}"/>`).join('');
  return `<svg class="${cls}" viewBox="0 0 180 40" aria-hidden="true"><rect width="180" height="40" rx="3" fill="#fff"/><rect y="4.5" width="180" height="6" fill="${CHI.blue}"/><rect y="29.5" width="180" height="6" fill="${CHI.blue}"/>${stars}</svg>`;
}

/** CTA line bullet: a coloured disc holding an icon (emoji or short text). */
export function lineBullet(line: CtaLine, icon: string): string {
  return `<span class="line-bullet" style="--line:${CTA[line]}">${icon}</span>`;
}

export interface TrackStation {
  line: CtaLine;
  lineName: string;
  stop: string; // the "neighborhood" shown on the station sign
}

/** Each track is a stop on its own L line. Keyed by theme so new tracks get a sensible sign. */
const STATIONS: Record<TrackDef['theme'], TrackStation> = {
  chicago: { line: 'red', lineName: 'Red Line', stop: 'The Loop' },
  neighborhood: { line: 'green', lineName: 'Green Line', stop: 'Bungalow Belt' },
  kitchen: { line: 'orange', lineName: 'Orange Line', stop: 'Pizza Row' },
  dogpark: { line: 'brown', lineName: 'Brown Line', stop: 'Dog Beach' },
  snow: { line: 'blue', lineName: 'Blue Line', stop: 'Lake Effect' },
};

/** Per-track overrides for tracks that share a theme. */
const TRACK_STATIONS: Record<string, TrackStation> = {
  sweethome: { line: 'purple', lineName: 'Purple Line', stop: 'Bronzeville' },
};

export function stationFor(theme: TrackDef['theme'], trackId?: string): TrackStation {
  return (trackId && TRACK_STATIONS[trackId]) || STATIONS[theme] || { line: 'purple', lineName: 'Purple Line', stop: 'Express' };
}

/** Theatre-marquee bulb frame markup (decorative, CSS does the chasing lights). */
export const MARQUEE_BULBS = '<span class="bulbs" aria-hidden="true"></span>';

/** Chicago-flag confetti: falling red stars and light-blue ribbons. */
export function confettiHtml(n = 26): string {
  let out = '';
  for (let i = 0; i < n; i++) {
    // deterministic scatter so screenshots are stable
    const left = (i * 37 + 11) % 100;
    const delay = ((i * 0.53) % 4).toFixed(2);
    const dur = (4.5 + ((i * 7) % 5) * 0.6).toFixed(2);
    const size = 12 + ((i * 5) % 4) * 5;
    const body = i % 3 === 2
      ? `<i class="ribbon" style="height:${size * 1.4}px"></i>`
      : starSvg('', i % 4 === 0 ? CHI.blue : CHI.red, '#fff');
    out += `<span class="confetti" style="left:${left}%;width:${size}px;animation-delay:-${delay}s;animation-duration:${dur}s">${body}</span>`;
  }
  return `<div class="confetti-layer" aria-hidden="true">${out}</div>`;
}
