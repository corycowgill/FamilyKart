import { sampleSpline } from '../sim/track/spline';
import type { TrackDef } from '../sim/types';

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
  g.font = '34px serif';
  g.fillText(THEME_ICON[def.theme], 10, 42);
}
