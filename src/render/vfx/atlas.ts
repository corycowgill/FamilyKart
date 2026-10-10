import * as THREE from 'three';

/**
 * Hand-drawn (canvas) particle sprite atlas, 4x4 cells. Shapes are bold and flat-shaded ("cel")
 * in white / light grey so the per-particle colour tints them; additive glow sprites keep a bright
 * alpha core which the particle shader turns into a white-hot centre that catches the bloom.
 */
export const SPRITE = {
  SOFT: 0,
  STAR: 1,
  SPARKLE: 2,
  PUFF: 3,
  FLAME: 4,
  RING: 5,
  CONFETTI: 6,
  SNOW: 7,
  DROP: 8,
  LEAF: 9,
  SHARD: 10,
  STREAMER: 11,
  BLOB: 12,
  BALL: 13,
  DUST: 14,
  BURST: 15,
} as const;
export type SpriteId = (typeof SPRITE)[keyof typeof SPRITE];

const CELL = 128;
const PAD = 8;

let atlas: THREE.CanvasTexture | null = null;

/** Shared atlas texture (lazily drawn once; re-uploads itself if a race disposes it). */
export function particleAtlas(): THREE.Texture {
  if (atlas) return atlas;
  const c = document.createElement('canvas');
  c.width = c.height = CELL * 4;
  const g = c.getContext('2d')!;
  const draw: Array<(g: CanvasRenderingContext2D) => void> = [soft, star, sparkle, puff, flame, ring, confetti, snow, drop, leaf, shard, streamer, blob, ball, dust, burst];
  draw.forEach((fn, i) => {
    g.save();
    g.translate((i % 4) * CELL, Math.floor(i / 4) * CELL);
    g.beginPath();
    g.rect(PAD / 2, PAD / 2, CELL - PAD, CELL - PAD);
    g.clip();
    g.translate(CELL / 2, CELL / 2);
    fn(g);
    g.restore();
  });
  atlas = new THREE.CanvasTexture(c);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 1;
  return atlas;
}

const R = CELL / 2 - PAD;

function soft(g: CanvasRenderingContext2D): void {
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, R);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(255,255,255,0.8)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(-R, -R, R * 2, R * 2);
}

function starPath(g: CanvasRenderingContext2D, pts: number, ro: number, ri: number, rot = -Math.PI / 2): void {
  g.beginPath();
  for (let i = 0; i < pts * 2; i++) {
    const r = i % 2 ? ri : ro;
    const a = rot + (i * Math.PI) / pts;
    if (i === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
}

function star(g: CanvasRenderingContext2D): void {
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, R);
  grd.addColorStop(0, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(-R, -R, R * 2, R * 2);
  // chunky rounded five-point star
  g.lineJoin = 'round';
  starPath(g, 5, R * 0.82, R * 0.38);
  g.fillStyle = '#ffffff';
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.stroke();
}

function sparkle(g: CanvasRenderingContext2D): void {
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.55);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(-R, -R, R * 2, R * 2);
  starPath(g, 4, R, R * 0.14, 0);
  g.fillStyle = '#ffffff';
  g.fill();
}

function cloud(g: CanvasRenderingContext2D, s: number, lumps: Array<[number, number, number]>): void {
  g.beginPath();
  for (const [x, y, r] of lumps) {
    g.moveTo(x * s + r * s, y * s);
    g.arc(x * s, y * s, r * s, 0, Math.PI * 2);
  }
}

const PUFF_LUMPS: Array<[number, number, number]> = [[0, 6, 30], [-22, 10, 20], [22, 12, 19], [-12, -14, 22], [14, -12, 21], [0, -24, 16]];
function puff(g: CanvasRenderingContext2D): void {
  const s = R / 52;
  // shadow side, then the lit side offset up-left (two-tone cel shading), then a rim highlight
  cloud(g, s, PUFF_LUMPS);
  g.fillStyle = '#b9c1cf';
  g.fill();
  g.save();
  cloud(g, s, PUFF_LUMPS);
  g.clip();
  g.translate(-6 * s, -8 * s);
  cloud(g, s * 0.94, PUFF_LUMPS);
  g.fillStyle = '#ffffff';
  g.fill();
  g.restore();
}

function dust(g: CanvasRenderingContext2D): void {
  const s = R / 50;
  const L: Array<[number, number, number]> = [[0, 4, 28], [-20, 8, 18], [20, 10, 17], [-8, -14, 20], [12, -10, 18]];
  cloud(g, s, L);
  g.fillStyle = 'rgba(214,214,214,0.92)';
  g.fill();
  g.save();
  cloud(g, s, L);
  g.clip();
  g.translate(-5 * s, -6 * s);
  cloud(g, s * 0.9, L);
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.fill();
  g.restore();
}

function flame(g: CanvasRenderingContext2D): void {
  const path = (k: number) => {
    g.beginPath();
    g.moveTo(0, -R * k);
    g.bezierCurveTo(R * 0.55 * k, -R * 0.25 * k, R * 0.75 * k, R * 0.5 * k, 0, R * 0.82 * k);
    g.bezierCurveTo(-R * 0.75 * k, R * 0.5 * k, -R * 0.55 * k, -R * 0.25 * k, 0, -R * k);
  };
  path(1);
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.fill();
  g.translate(0, R * 0.18);
  path(0.62);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fill();
  g.translate(0, R * 0.12);
  path(0.32);
  g.fillStyle = 'rgba(255,255,255,1)';
  g.fill();
}

function ring(g: CanvasRenderingContext2D): void {
  g.beginPath();
  g.arc(0, 0, R * 0.8, 0, Math.PI * 2);
  g.lineWidth = R * 0.22;
  g.strokeStyle = '#ffffff';
  g.stroke();
}

function confetti(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#ffffff';
  g.fillRect(-R * 0.75, -R * 0.38, R * 1.5, R * 0.76);
  g.fillStyle = 'rgba(0,0,0,0.16)';
  g.fillRect(-R * 0.75, R * 0.12, R * 1.5, R * 0.26);
}

function snow(g: CanvasRenderingContext2D): void {
  g.strokeStyle = '#ffffff';
  g.lineCap = 'round';
  g.lineWidth = 8;
  for (let i = 0; i < 6; i++) {
    g.save();
    g.rotate((i * Math.PI) / 3);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, -R * 0.9);
    g.moveTo(0, -R * 0.5);
    g.lineTo(-R * 0.22, -R * 0.7);
    g.moveTo(0, -R * 0.5);
    g.lineTo(R * 0.22, -R * 0.7);
    g.stroke();
    g.restore();
  }
}

function drop(g: CanvasRenderingContext2D): void {
  g.beginPath();
  g.moveTo(0, -R * 0.95);
  g.bezierCurveTo(R * 0.25, -R * 0.4, R * 0.62, 0, R * 0.62, R * 0.3);
  g.arc(0, R * 0.3, R * 0.62, 0, Math.PI);
  g.bezierCurveTo(-R * 0.62, 0, -R * 0.25, -R * 0.4, 0, -R * 0.95);
  g.fillStyle = '#d8e6f2';
  g.fill();
  g.beginPath();
  g.ellipse(-R * 0.2, R * 0.2, R * 0.14, R * 0.26, 0.3, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
}

function leaf(g: CanvasRenderingContext2D): void {
  g.beginPath();
  g.moveTo(0, -R * 0.95);
  g.quadraticCurveTo(R * 0.75, -R * 0.2, 0, R * 0.9);
  g.quadraticCurveTo(-R * 0.75, -R * 0.2, 0, -R * 0.95);
  g.fillStyle = '#ffffff';
  g.fill();
  g.beginPath();
  g.moveTo(0, -R * 0.95);
  g.quadraticCurveTo(-R * 0.75, -R * 0.2, 0, R * 0.9);
  g.fillStyle = '#c8ccc8';
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(0, -R * 0.8);
  g.lineTo(0, R * 1.0);
  g.stroke();
}

function shard(g: CanvasRenderingContext2D): void {
  g.beginPath();
  g.moveTo(-R * 0.7, R * 0.6);
  g.lineTo(R * 0.1, -R * 0.85);
  g.lineTo(R * 0.75, R * 0.45);
  g.closePath();
  g.fillStyle = '#c9ced8';
  g.fill();
  g.beginPath();
  g.moveTo(-R * 0.7, R * 0.6);
  g.lineTo(R * 0.1, -R * 0.85);
  g.lineTo(R * 0.05, R * 0.3);
  g.closePath();
  g.fillStyle = '#ffffff';
  g.fill();
}

function streamer(g: CanvasRenderingContext2D): void {
  g.strokeStyle = '#ffffff';
  g.lineWidth = 12;
  g.lineCap = 'round';
  g.beginPath();
  for (let i = 0; i <= 24; i++) {
    const x = -R * 0.9 + (i / 24) * R * 1.8;
    const y = Math.sin((i / 24) * Math.PI * 3) * R * 0.3;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
}

function blob(g: CanvasRenderingContext2D): void {
  const s = R / 50;
  const L: Array<[number, number, number]> = [[0, 0, 30], [-26, 8, 14], [24, -10, 15], [8, 26, 12], [-12, -26, 12], [28, 18, 8], [-30, -14, 8]];
  cloud(g, s, L);
  g.fillStyle = '#e1e4ea';
  g.fill();
  g.save();
  cloud(g, s, L);
  g.clip();
  g.translate(-4 * s, -5 * s);
  cloud(g, s * 0.92, L);
  g.fillStyle = '#ffffff';
  g.fill();
  g.restore();
  g.beginPath();
  g.ellipse(-10 * s, -10 * s, 7 * s, 4 * s, -0.6, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
}

function ball(g: CanvasRenderingContext2D): void {
  g.beginPath();
  g.arc(0, 0, R * 0.8, 0, Math.PI * 2);
  g.fillStyle = '#f2f2f2';
  g.fill();
  g.save();
  g.clip();
  g.beginPath();
  g.arc(-R * 0.15, -R * 0.15, R * 0.75, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
  g.strokeStyle = '#8a8a8a';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(-R * 0.95, 0, R * 0.7, -0.9, 0.9);
  g.stroke();
  g.beginPath();
  g.arc(R * 0.95, 0, R * 0.7, Math.PI - 0.9, Math.PI + 0.9);
  g.stroke();
  g.restore();
}

function burst(g: CanvasRenderingContext2D): void {
  // toon explosion "pow": spiky outer star, softer body, white core
  g.lineJoin = 'round';
  starPath(g, 9, R * 0.98, R * 0.62, 0.2);
  g.fillStyle = 'rgba(255,255,255,0.6)';
  g.fill();
  starPath(g, 9, R * 0.72, R * 0.45, 0.5);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fill();
  g.beginPath();
  g.arc(0, 0, R * 0.36, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
}
