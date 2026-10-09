import { sampleSpline } from '../sim/track/spline';
import type { TrackDef } from '../sim/types';
import { CHI, CTA, STAR_PATH, stationFor } from './chicagoArt';

const THEME_BG: Record<TrackDef['theme'], [string, string]> = {
  chicago: ['#7ec8ff', '#3d8fe0'],
  neighborhood: ['#bff0a0', '#5fae4a'],
  kitchen: ['#ffe7c2', '#e3a86b'],
  dogpark: ['#c8f59a', '#4caf50'],
  snow: ['#e6f2ff', '#8fb3d9'],
};

const THEME_ICON: Record<TrackDef['theme'], string> = {
  chicago: '🏙️', neighborhood: '🏡', kitchen: '🥣', dogpark: '🐶', snow: '❄️',
};

/** Draws a stylised top-down preview of a track layout for the track-select cards. */
export function drawTrackPreview(canvas: HTMLCanvasElement, def: TrackDef): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const W = canvas.width, H = canvas.height;
  const [a, b] = THEME_BG[def.theme];
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, a);
  grd.addColorStop(1, b);
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  // playful dots
  g.fillStyle = 'rgba(255,255,255,0.18)';
  for (let i = 0; i < 40; i++) {
    g.beginPath();
    g.arc((i * 97) % W, (i * 53) % H, 3 + (i % 4), 0, Math.PI * 2);
    g.fill();
  }
  if (def.theme === 'chicago' || def.theme === 'snow') drawSkyline(g, W, H, def.theme === 'snow' ? 'rgba(70,100,150,0.28)' : 'rgba(20,40,90,0.25)');
  const pts = sampleSpline(def.points, def.width, 6, true);
  const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const sc = Math.min((W * 0.8) / (maxX - minX), (H * 0.78) / (maxZ - minZ));
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const tx = (x: number) => W / 2 - (x - cx) * sc;
  const tz = (z: number) => H / 2 - (z - cz) * sc;
  const path = () => {
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(tx(p.x), tz(p.z)) : g.moveTo(tx(p.x), tz(p.z))));
    g.closePath();
  };
  g.lineJoin = 'round';
  path();
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 16;
  g.stroke();
  path();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 11;
  g.stroke();
  path();
  g.strokeStyle = '#3b3f55';
  g.lineWidth = 7;
  g.stroke();
  for (const sc2 of def.shortcuts) {
    const sp = sampleSpline(sc2.points, sc2.width, 4, false);
    g.beginPath();
    sp.forEach((p, i) => (i ? g.lineTo(tx(p.x), tz(p.z)) : g.moveTo(tx(p.x), tz(p.z))));
    g.setLineDash([5, 5]);
    g.strokeStyle = '#ffd23f';
    g.lineWidth = 4;
    g.stroke();
    g.setLineDash([]);
  }
  const s0 = pts[0];
  g.fillStyle = '#ff3b3b';
  g.beginPath();
  g.arc(tx(s0.x), tz(s0.z), 7, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = 3;
  g.stroke();
  // CTA-style line bullet holding the theme icon
  const line = CTA[stationFor(def.theme).line];
  g.beginPath();
  g.arc(30, 30, 22, 0, Math.PI * 2);
  g.fillStyle = line;
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = '#fff';
  g.stroke();
  g.font = '24px serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(THEME_ICON[def.theme], 30, 32);
  g.textAlign = 'start';
  g.textBaseline = 'alphabetic';
  // the four Chicago stars
  const star = new Path2D(STAR_PATH);
  for (let i = 0; i < 4; i++) {
    g.save();
    g.translate(W - 98 + i * 22, 10);
    g.scale(0.19, 0.19);
    g.fillStyle = CHI.red;
    g.strokeStyle = '#fff';
    g.lineWidth = 14;
    g.lineJoin = 'round';
    g.stroke(star);
    g.fill(star);
    g.restore();
  }
}

/** Low-contrast Chicago skyline silhouette along the bottom of the card. */
function drawSkyline(g: CanvasRenderingContext2D, W: number, H: number, color: string): void {
  g.fillStyle = color;
  const base = H;
  // [x, width, height] blocks, scaled to the card width
  const blocks: Array<[number, number, number]> = [
    [0, 22, 40], [20, 18, 58], [36, 26, 34], [60, 16, 72], [74, 22, 50], [104, 20, 44], [122, 16, 62], [136, 26, 38],
    [190, 22, 46], [210, 14, 66], [222, 24, 40], [244, 18, 56], [262, 22, 36], [282, 20, 52], [300, 20, 30],
  ];
  const sx = W / 320;
  for (const [x, w, hgt] of blocks) g.fillRect(x * sx, base - hgt * sx, w * sx, hgt * sx);
  // stepped "tallest tower" with twin antennas
  const tx = 160 * sx;
  g.fillRect(tx, base - 96 * sx, 22 * sx, 96 * sx);
  g.fillRect(tx + 3 * sx, base - 110 * sx, 16 * sx, 14 * sx);
  g.fillRect(tx + 5 * sx, base - 128 * sx, 2 * sx, 18 * sx);
  g.fillRect(tx + 15 * sx, base - 124 * sx, 2 * sx, 14 * sx);
  // tapered tower with antennas
  const hx = 92 * sx;
  g.beginPath();
  g.moveTo(hx, base);
  g.lineTo(hx + 3 * sx, base - 84 * sx);
  g.lineTo(hx + 13 * sx, base - 84 * sx);
  g.lineTo(hx + 16 * sx, base);
  g.fill();
  g.fillRect(hx + 4 * sx, base - 98 * sx, 1.5 * sx, 14 * sx);
  g.fillRect(hx + 11 * sx, base - 98 * sx, 1.5 * sx, 14 * sx);
}
