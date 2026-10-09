import * as THREE from 'three';
import type { CharacterId } from '../../sim/types';

/**
 * Procedural CanvasTextures: faces (per expression), suit prints, emblems, kart decals, tyre treads.
 * All textures are cached by key and shared. In non-DOM environments (unit tests) every function
 * returns null and callers fall back to plain colours.
 */

const texCache = new Map<string, THREE.Texture | null>();

type Ctx = CanvasRenderingContext2D;

function hasDom(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

export function canvasTex(key: string, w: number, h: number, draw: (ctx: Ctx, w: number, h: number) => void, opts?: { repeatU?: boolean }): THREE.Texture | null {
  if (texCache.has(key)) return texCache.get(key)!;
  if (!hasDom()) {
    texCache.set(key, null);
    return null;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) {
    texCache.set(key, null);
    return null;
  }
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (opts?.repeatU) t.wrapS = THREE.RepeatWrapping;
  t.userData.shared = true;
  texCache.set(key, t);
  return t;
}

// ---------------------------------------------------------------------------------------------
// Face patch mapping. The face texture is applied to a partial sphere covering the front of the
// head: phi in [PI/2 - PHI_SPAN/2, PI/2 + PHI_SPAN/2], theta (from the top) in [THETA0, THETA0+THETA_SPAN].
// Pixel scale is identical in both directions so circles stay round near the equator.
// ---------------------------------------------------------------------------------------------
export const FACE = { phiSpan: 1.9, theta0: 0.65, thetaSpan: 1.9, size: 512 };
const K = FACE.size / FACE.phiSpan; // px per radian

/** Convert (horizontal angle from face centre, polar angle from top) to face canvas px. */
function fp(dphi: number, theta: number): [number, number] {
  return [FACE.size / 2 + dphi * K, (theta - FACE.theta0) * K];
}

export type Expression = 'normal' | 'blink' | 'determined' | 'shocked' | 'dizzy' | 'laugh' | 'sad';

export interface FaceStyle {
  skin: string;
  iris: string;
  brow: string;
  lip: string;
  blush: number;
  eyeR: number; // radians
  eyeSep: number; // radians from centre
  eyeTheta: number;
  mouthTheta: number;
  mouthW: number; // radians
  browThick: number;
  beard?: string;
  stubble?: boolean;
  lashes?: boolean;
  freckles?: boolean;
  wrinkles?: boolean;
  dog?: boolean;
}

/** Eye positions (dphi, theta) shared with 3D glasses placement. */
export function eyeAngles(st: FaceStyle): Array<[number, number]> {
  return [
    [-st.eyeSep, st.eyeTheta],
    [st.eyeSep, st.eyeTheta],
  ];
}

export function faceTexture(id: CharacterId, st: FaceStyle, expr: Expression): THREE.Texture | null {
  return canvasTex(`face:${id}:${expr}`, FACE.size, FACE.size, (ctx, w, h) => {
    ctx.fillStyle = st.skin;
    ctx.fillRect(0, 0, w, h);
    if (st.dog) drawDogFace(ctx, st, expr);
    else drawHumanFace(ctx, st, expr);
  });
}

function rgba(hex: string, a: number): string {
  const c = new THREE.Color(hex);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
}

function shade(hex: string, f: number): string {
  const c = new THREE.Color(hex);
  if (f < 1) c.multiplyScalar(f);
  else c.lerp(new THREE.Color('#ffffff'), f - 1);
  return `#${c.getHexString()}`;
}

function blush(ctx: Ctx, st: FaceStyle, strength = 1) {
  for (const s of [-1, 1]) {
    const [x, y] = fp(s * (st.eyeSep + 0.13), st.eyeTheta + 0.3);
    const g = ctx.createRadialGradient(x, y, 2, x, y, 48);
    g.addColorStop(0, `rgba(255,105,110,${0.5 * st.blush * strength})`);
    g.addColorStop(1, 'rgba(255,105,110,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, 52, 40, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function eyeOpen(ctx: Ctx, st: FaceStyle, x: number, y: number, r: number, side: number, opts: { pupil?: number; lookY?: number; lookX?: number; lid?: number; lidSlope?: number; lower?: number } = {}) {
  const rx = r * 0.86;
  // white
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(x, y, rx, r, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.clip();
  // iris
  const ix = x + (opts.lookX ?? -side * 0.08) * r;
  const iy = y + (opts.lookY ?? 0.08) * r;
  const ir = r * 0.66 * (opts.pupil ?? 1);
  const g = ctx.createRadialGradient(ix, iy - ir * 0.3, ir * 0.1, ix, iy, ir);
  g.addColorStop(0, shade(st.iris, 1.35));
  g.addColorStop(0.7, st.iris);
  g.addColorStop(1, shade(st.iris, 0.55));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(ix, iy, ir, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#120c0a';
  ctx.beginPath();
  ctx.arc(ix, iy, ir * 0.5, 0, Math.PI * 2);
  ctx.fill();
  // highlights
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(ix - ir * 0.35, iy - ir * 0.4, ir * 0.28, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ix + ir * 0.35, iy + ir * 0.3, ir * 0.12, 0, Math.PI * 2);
  ctx.fill();
  // upper lid (determined / sad)
  if (opts.lid) {
    ctx.fillStyle = st.skin;
    const slope = (opts.lidSlope ?? 0) * side; // + = inner corner lower
    ctx.beginPath();
    ctx.moveTo(x - rx * 1.2, y - r * 1.3);
    ctx.lineTo(x + rx * 1.2, y - r * 1.3);
    ctx.lineTo(x + rx * 1.2, y - r + opts.lid * 2 * r - slope * r);
    ctx.lineTo(x - rx * 1.2, y - r + opts.lid * 2 * r + slope * r);
    ctx.closePath();
    ctx.fill();
  }
  // lower "smile" cheek push
  if (opts.lower) {
    ctx.fillStyle = st.skin;
    ctx.beginPath();
    ctx.ellipse(x, y + r * (2.05 - opts.lower), rx * 1.5, r, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  // outline + lash line
  ctx.strokeStyle = '#2a1712';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, r, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = st.lashes ? 7 : 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (opts.lid) {
    const slope = (opts.lidSlope ?? 0) * side;
    ctx.moveTo(x - rx * 1.02, y - r + opts.lid * 2 * r + slope * r);
    ctx.lineTo(x + rx * 1.02, y - r + opts.lid * 2 * r - slope * r);
  } else {
    ctx.ellipse(x, y, rx, r, 0, Math.PI * 1.08, Math.PI * 1.92);
  }
  ctx.stroke();
  if (st.lashes) {
    ctx.lineWidth = 4;
    const ox = x + side * rx * 0.85;
    ctx.beginPath();
    ctx.moveTo(ox, y - r * 0.55);
    ctx.lineTo(ox + side * 12, y - r * 0.9);
    ctx.moveTo(ox - side * 6, y - r * 0.8);
    ctx.lineTo(ox + side * 4, y - r * 1.15);
    ctx.stroke();
  }
}

function eyeArc(ctx: Ctx, x: number, y: number, r: number, up: boolean, width = 7) {
  ctx.strokeStyle = '#2a1712';
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (up) ctx.arc(x, y + r * 0.45, r * 0.8, Math.PI * 1.15, Math.PI * 1.85);
  else ctx.arc(x, y - r * 0.55, r * 0.8, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();
}

function eyeSpiral(ctx: Ctx, x: number, y: number, r: number, side: number) {
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.9, r, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#2a1712';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  for (let a = 0; a < Math.PI * 6; a += 0.15) {
    const rr = (a / (Math.PI * 6)) * r * 0.85;
    const px = x + Math.cos(a * side) * rr;
    const py = y + Math.sin(a * side) * rr;
    if (a === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

function brow(ctx: Ctx, st: FaceStyle, side: number, lift: number, tilt: number, thick = 1) {
  // tilt > 0 : inner end lower (angry/determined); tilt < 0 : inner end higher (sad/worried)
  const [cx, cy] = fp(side * st.eyeSep, st.eyeTheta - st.eyeR - 0.12 - lift);
  const half = st.eyeR * K * 1.0;
  const innerX = cx - side * half;
  const outerX = cx + side * half;
  ctx.strokeStyle = st.brow;
  ctx.lineCap = 'round';
  ctx.lineWidth = st.browThick * thick;
  ctx.beginPath();
  ctx.moveTo(innerX, cy + tilt * 26);
  ctx.quadraticCurveTo(cx, cy - 10 - tilt * 4, outerX, cy - tilt * 14 + 6);
  ctx.stroke();
}

function mouthPath(ctx: Ctx, x: number, y: number, w: number, depth: number, topCurve: number) {
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y);
  ctx.quadraticCurveTo(x, y + topCurve, x + w / 2, y);
  ctx.bezierCurveTo(x + w * 0.42, y + depth * 1.15, x - w * 0.42, y + depth * 1.15, x - w / 2, y);
  ctx.closePath();
}

function openMouth(ctx: Ctx, st: FaceStyle, x: number, y: number, w: number, depth: number, topCurve: number) {
  ctx.save();
  mouthPath(ctx, x, y, w, depth, topCurve);
  ctx.fillStyle = '#5b1418';
  ctx.fill();
  ctx.clip();
  // tongue
  ctx.fillStyle = '#e8606c';
  ctx.beginPath();
  ctx.ellipse(x, y + depth * 1.0, w * 0.3, depth * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();
  // upper teeth
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y - 4);
  ctx.quadraticCurveTo(x, y + topCurve - 4, x + w / 2, y - 4);
  ctx.lineTo(x + w / 2, y + depth * 0.22);
  ctx.quadraticCurveTo(x, y + topCurve + depth * 0.3, x - w / 2, y + depth * 0.22);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  mouthPath(ctx, x, y, w, depth, topCurve);
  ctx.strokeStyle = st.lip;
  ctx.lineWidth = 4;
  ctx.stroke();
  // dimples
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = rgba(st.lip, 0.7);
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + s * (w / 2 + 2), y + 2, 9, s > 0 ? -Math.PI * 0.5 : Math.PI * 0.5, s > 0 ? Math.PI * 0.3 : Math.PI * 1.3, s < 0);
    ctx.stroke();
  }
}

function beard(ctx: Ctx, st: FaceStyle, mx: number, my: number, mw: number) {
  if (!st.beard) return;
  const col = st.beard;
  ctx.fillStyle = col;
  // circle beard: mustache + goatee wrapped around the mouth
  ctx.beginPath();
  ctx.moveTo(mx, my - 34);
  ctx.bezierCurveTo(mx + mw * 0.55, my - 40, mx + mw * 0.8, my - 12, mx + mw * 0.62, my + 30);
  ctx.bezierCurveTo(mx + mw * 0.5, my + 95, mx - mw * 0.5, my + 95, mx - mw * 0.62, my + 30);
  ctx.bezierCurveTo(mx - mw * 0.8, my - 12, mx - mw * 0.55, my - 40, mx, my - 34);
  ctx.fill();
  // texture strokes
  const rnd = mulberry(7);
  for (let i = 0; i < 420; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = Math.sqrt(rnd());
    const px = mx + Math.cos(a) * rr * mw * 0.66;
    const py = my + 25 + Math.sin(a) * rr * 66;
    ctx.strokeStyle = rnd() > 0.5 ? shade(col, 1.25) : shade(col, 0.75);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + (rnd() - 0.5) * 4, py + 5);
    ctx.stroke();
  }
}

function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawHumanFace(ctx: Ctx, st: FaceStyle, expr: Expression) {
  const r = st.eyeR * K;
  const [mx, my] = fp(0, st.mouthTheta);
  const mw = st.mouthW * K;

  if (st.stubble) {
    const rnd = mulberry(3);
    ctx.fillStyle = rgba('#6d6158', 0.18);
    for (let i = 0; i < 900; i++) {
      const px = mx + (rnd() - 0.5) * mw * 2.6;
      const py = my - 10 + rnd() * 120;
      ctx.fillRect(px, py, 2, 2);
    }
  }
  blush(ctx, st, expr === 'laugh' ? 1.3 : expr === 'sad' ? 0.6 : 1);
  if (st.freckles) {
    const rnd = mulberry(11);
    ctx.fillStyle = rgba('#b9774e', 0.55);
    for (const s of [-1, 1]) {
      for (let i = 0; i < 9; i++) {
        const [fx, fy] = fp(s * (st.eyeSep + 0.02 + rnd() * 0.16), st.eyeTheta + 0.2 + rnd() * 0.1);
        ctx.beginPath();
        ctx.arc(fx, fy, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  if (st.wrinkles) {
    ctx.strokeStyle = rgba('#a86a55', 0.45);
    ctx.lineWidth = 2.5;
    for (const s of [-1, 1]) {
      const [x, y] = fp(s * (st.eyeSep + st.eyeR + 0.06), st.eyeTheta + 0.02);
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(x, y + i * 9);
        ctx.lineTo(x + s * 14, y + i * 13);
        ctx.stroke();
      }
    }
  }

  beard(ctx, st, mx, my, mw);

  // ---- eyes ----
  for (const s of [-1, 1]) {
    const [x, y] = fp(s * st.eyeSep, st.eyeTheta);
    switch (expr) {
      case 'normal':
        eyeOpen(ctx, st, x, y, r, s, { lower: 0.35 });
        break;
      case 'blink':
        eyeArc(ctx, x, y, r, false);
        break;
      case 'determined':
        eyeOpen(ctx, st, x, y, r, s, { lid: 0.32, lidSlope: 0.32, lookY: 0.05, lower: 0.25 });
        break;
      case 'shocked':
        eyeOpen(ctx, st, x, y, r * 1.18, s, { pupil: 0.55, lookX: 0, lookY: 0 });
        break;
      case 'dizzy':
        eyeSpiral(ctx, x, y, r * 1.05, s);
        break;
      case 'laugh':
        eyeArc(ctx, x, y + 6, r, true, 8);
        break;
      case 'sad':
        eyeOpen(ctx, st, x, y, r, s, { lid: 0.3, lidSlope: -0.3, lookY: 0.35 });
        break;
    }
  }
  // ---- brows ----
  for (const s of [-1, 1]) {
    switch (expr) {
      case 'normal':
      case 'blink':
        brow(ctx, st, s, 0.02, -0.15);
        break;
      case 'determined':
        brow(ctx, st, s, -0.05, 1.0, 1.15);
        break;
      case 'shocked':
      case 'dizzy':
        brow(ctx, st, s, 0.12, -0.4);
        break;
      case 'laugh':
        brow(ctx, st, s, 0.1, -0.35);
        break;
      case 'sad':
        brow(ctx, st, s, 0.06, -1.0);
        break;
    }
  }
  // ---- mouth ----
  switch (expr) {
    case 'normal':
    case 'blink':
      openMouth(ctx, st, mx, my, mw, mw * 0.36, 10);
      break;
    case 'laugh':
      openMouth(ctx, st, mx, my - 6, mw * 1.2, mw * 0.62, 6);
      break;
    case 'determined': {
      // confident gritted smirk
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(mx - mw * 0.42, my + 6);
      ctx.quadraticCurveTo(mx, my + 14, mx + mw * 0.48, my - 4);
      ctx.quadraticCurveTo(mx + mw * 0.1, my + 40, mx - mw * 0.42, my + 6);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = st.lip;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.clip();
      ctx.strokeStyle = '#c9b8b0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(mx - mw * 0.45, my + 14);
      ctx.quadraticCurveTo(mx, my + 22, mx + mw * 0.45, my + 6);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'shocked':
      ctx.fillStyle = '#5b1418';
      ctx.beginPath();
      ctx.ellipse(mx, my + 14, mw * 0.2, mw * 0.27, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = st.lip;
      ctx.lineWidth = 4;
      ctx.stroke();
      break;
    case 'dizzy':
      ctx.strokeStyle = st.lip;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const px = mx - mw * 0.4 + (i / 24) * mw * 0.8;
        const py = my + 14 + Math.sin(i * 0.8) * 7;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      break;
    case 'sad':
      ctx.strokeStyle = st.lip;
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(mx - mw * 0.32, my + 30);
      ctx.quadraticCurveTo(mx, my - 2, mx + mw * 0.32, my + 30);
      ctx.stroke();
      // tear
      {
        const [tx, ty] = fp(st.eyeSep + 0.05, st.eyeTheta + st.eyeR + 0.08);
        ctx.fillStyle = '#6ec6ff';
        ctx.beginPath();
        ctx.moveTo(tx, ty - 14);
        ctx.quadraticCurveTo(tx + 10, ty + 4, tx, ty + 8);
        ctx.quadraticCurveTo(tx - 10, ty + 4, tx, ty - 14);
        ctx.fill();
      }
      break;
  }
}

function drawDogFace(ctx: Ctx, st: FaceStyle, expr: Expression) {
  // shaggy strokes everywhere for a fluffy look
  const rnd = mulberry(21);
  for (let i = 0; i < 1600; i++) {
    const x = rnd() * FACE.size;
    const y = rnd() * FACE.size;
    ctx.strokeStyle = rnd() > 0.5 ? shade(st.skin, 1.12) : shade(st.skin, 0.86);
    ctx.lineWidth = 2 + rnd() * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + (rnd() - 0.5) * 8, y + 6, x + (rnd() - 0.5) * 10, y + 12 + rnd() * 6);
    ctx.stroke();
  }
  const r = st.eyeR * K;
  for (const s of [-1, 1]) {
    const [x, y] = fp(s * st.eyeSep, st.eyeTheta);
    // darker fur patch around the eyes (Tibetan Terrier "mask")
    const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 1.9);
    g.addColorStop(0, rgba('#b98d5c', 0.6));
    g.addColorStop(1, rgba('#b98d5c', 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.9, 0, Math.PI * 2);
    ctx.fill();
    switch (expr) {
      case 'blink':
        eyeArc(ctx, x, y, r, false, 8);
        break;
      case 'laugh':
        eyeArc(ctx, x, y + 6, r, true, 9);
        break;
      case 'dizzy':
        eyeSpiral(ctx, x, y, r * 1.05, s);
        break;
      default: {
        const big = expr === 'shocked' ? 1.15 : expr === 'sad' ? 1.08 : 1;
        const rr = r * big;
        if (expr === 'shocked') {
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(x, y, rr * 1.12, 0, Math.PI * 2);
          ctx.fill();
        }
        const eg = ctx.createRadialGradient(x - rr * 0.2, y - rr * 0.3, rr * 0.1, x, y, rr);
        eg.addColorStop(0, '#5a3a24');
        eg.addColorStop(0.6, '#24150c');
        eg.addColorStop(1, '#0d0806');
        ctx.fillStyle = eg;
        ctx.beginPath();
        ctx.arc(x, y, expr === 'shocked' ? rr * 0.7 : rr, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x - rr * 0.32, y - rr * 0.35, rr * (expr === 'sad' ? 0.36 : 0.28), 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x + rr * 0.3, y + rr * 0.32, rr * 0.13, 0, Math.PI * 2);
        ctx.fill();
        if (expr === 'determined' || expr === 'sad') {
          ctx.fillStyle = st.skin;
          const slope = expr === 'determined' ? 0.35 * s : -0.35 * s;
          ctx.beginPath();
          ctx.moveTo(x - rr * 1.3, y - rr * 1.3);
          ctx.lineTo(x + rr * 1.3, y - rr * 1.3);
          ctx.lineTo(x + rr * 1.3, y - rr * 0.35 - slope * rr);
          ctx.lineTo(x - rr * 1.3, y - rr * 0.35 + slope * rr);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    // fluffy brow tufts
    const lift = expr === 'shocked' || expr === 'laugh' ? 0.08 : 0;
    const tilt = expr === 'determined' ? 1 : expr === 'sad' ? -1 : -0.2;
    const [bx, by] = fp(s * st.eyeSep, st.eyeTheta - st.eyeR - 0.1 - lift);
    for (let k = 0; k < 14; k++) {
      const t = k / 13 - 0.5;
      const px = bx + t * r * 2.2;
      const py = by + (-s * t) * tilt * 26 - Math.cos(t * 3) * 6;
      ctx.strokeStyle = k % 2 ? '#8a6238' : '#a77c4c';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px, py + 8);
      ctx.lineTo(px + s * 4, py - 8);
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Suit prints (torso lathe: u around with front at u=0.5, v bottom->top)
// ---------------------------------------------------------------------------------------------

export function suitTexture(id: CharacterId, suit: string, accent: string): THREE.Texture | null {
  return canvasTex(`suit:${id}`, 512, 256, (ctx, w, h) => {
    ctx.fillStyle = suit;
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2;
    // subtle fabric shading
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    switch (id) {
      case 'dad': {
        // red side panels and shoulder yoke
        ctx.fillStyle = accent;
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(cx + s * 80, 0);
          ctx.lineTo(cx + s * 110, 0);
          ctx.lineTo(cx + s * 128, h);
          ctx.lineTo(cx + s * 98, h);
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillRect(0, 0, w, 16);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 16, w, 4);
        drawEmblem(ctx, 'x', cx, 104, 44, { fill: '#ffffff', outline: 'rgba(0,0,0,0)' });
        break;
      }
      case 'mom': {
        ctx.fillStyle = accent;
        // kangaroo pocket
        roundRect(ctx, cx - 62, 170, 124, 58, 20);
        ctx.fill();
        ctx.fillStyle = shade(suit, 0.8);
        ctx.fillRect(0, h - 22, w, 22);
        // zipper + drawstrings
        ctx.strokeStyle = '#f4d7ef';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, 170);
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(cx + s * 22, 4);
          ctx.quadraticCurveTo(cx + s * 26, 50, cx + s * 20, 92);
          ctx.stroke();
        }
        drawEmblem(ctx, 'heart', cx + 52, 96, 16, { fill: accent, outline: '#ffffff' });
        break;
      }
      case 'brennan': {
        ctx.fillStyle = accent;
        for (const s of [-1, 1]) {
          ctx.fillRect(cx + s * 92 - 16, 0, 32, h);
          ctx.fillRect(cx + s * 150 - 6, 0, 12, h);
        }
        ctx.fillStyle = '#ffffff';
        for (const s of [-1, 1]) ctx.fillRect(cx + s * 92 - 2, 0, 4, h);
        ctx.fillStyle = accent;
        ctx.fillRect(0, 0, w, 14);
        drawEmblem(ctx, 'soccer', cx + 40, 92, 20, {});
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 40px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('10', cx - 34, 108);
        break;
      }
      case 'parker': {
        ctx.fillStyle = accent;
        for (const s of [-1, 1]) {
          ctx.fillRect(cx + s * 100 - 9, 0, 18, h);
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, 12);
        ctx.fillStyle = shade(suit, 0.6);
        ctx.fillRect(0, h - 30, w, 30);
        drawEmblem(ctx, 'bolt', cx, 110, 46, { fill: accent, outline: '#0d1b3d' });
        break;
      }
      case 'grandma': {
        const rnd = mulberry(5);
        for (let i = 0; i < 70; i++) {
          drawEmblem(ctx, 'flower', rnd() * w, rnd() * h, 7, { petals: 'rgba(255,255,255,0.75)', center: '#ffd23f' });
        }
        ctx.fillStyle = accent;
        ctx.fillRect(0, 0, w, 14);
        ctx.fillRect(0, h - 16, w, 16);
        for (const s of [-1, 1]) ctx.fillRect(cx + s * 30 - 3, 0, 6, h);
        break;
      }
      default:
        break;
    }
  });
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------------------------------------
// Emblems
// ---------------------------------------------------------------------------------------------

export type EmblemKind = 'x' | 'heart' | 'soccer' | 'bolt' | 'paw' | 'flower';

export function drawEmblem(
  ctx: Ctx,
  kind: EmblemKind,
  cx: number,
  cy: number,
  s: number,
  o: { fill?: string; outline?: string; petals?: string; center?: string } = {},
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  switch (kind) {
    case 'x': {
      // stylised double-slash "X" as on Dad's poster kart
      const f = o.fill ?? '#ffffff';
      const bar = (rot: number, off: number) => {
        ctx.save();
        ctx.rotate(rot);
        ctx.translate(off, 0);
        ctx.beginPath();
        ctx.rect(-s * 0.13, -s * 1.0, s * 0.26, s * 2.0);
        ctx.fillStyle = f;
        ctx.fill();
        if (o.outline) {
          ctx.strokeStyle = o.outline;
          ctx.lineWidth = s * 0.06;
          ctx.stroke();
        }
        ctx.restore();
      };
      bar(Math.PI / 4, -s * 0.17);
      bar(Math.PI / 4, s * 0.17);
      bar(-Math.PI / 4, 0);
      break;
    }
    case 'heart': {
      ctx.beginPath();
      ctx.moveTo(0, s * 0.85);
      ctx.bezierCurveTo(-s * 1.25, -s * 0.05, -s * 0.75, -s * 1.0, 0, -s * 0.45);
      ctx.bezierCurveTo(s * 0.75, -s * 1.0, s * 1.25, -s * 0.05, 0, s * 0.85);
      ctx.closePath();
      ctx.fillStyle = o.fill ?? '#ff6fb5';
      ctx.fill();
      ctx.strokeStyle = o.outline ?? '#ffffff';
      ctx.lineWidth = s * 0.14;
      ctx.stroke();
      // shine
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.ellipse(-s * 0.42, -s * 0.38, s * 0.16, s * 0.1, -0.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'soccer': {
      ctx.beginPath();
      ctx.arc(0, 0, s, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = '#111111';
      const pent = (px: number, py: number, pr: number, rot: number) => {
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
          const a = rot + (i / 5) * Math.PI * 2 - Math.PI / 2;
          const x = px + Math.cos(a) * pr;
          const y = py + Math.sin(a) * pr;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
      };
      pent(0, 0, s * 0.36, 0);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        pent(Math.cos(a) * s * 0.95, Math.sin(a) * s * 0.95, s * 0.33, Math.PI / 5 + a + Math.PI / 2);
        ctx.strokeStyle = '#111111';
        ctx.lineWidth = s * 0.06;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * s * 0.36, Math.sin(a) * s * 0.36);
        ctx.lineTo(Math.cos(a) * s * 0.68, Math.sin(a) * s * 0.68);
        ctx.stroke();
      }
      ctx.restore();
      ctx.beginPath();
      ctx.arc(0, 0, s, 0, Math.PI * 2);
      ctx.strokeStyle = '#111111';
      ctx.lineWidth = s * 0.08;
      ctx.stroke();
      break;
    }
    case 'bolt': {
      ctx.beginPath();
      ctx.moveTo(s * 0.25, -s);
      ctx.lineTo(-s * 0.55, s * 0.12);
      ctx.lineTo(-s * 0.02, s * 0.12);
      ctx.lineTo(-s * 0.3, s);
      ctx.lineTo(s * 0.6, -s * 0.22);
      ctx.lineTo(s * 0.06, -s * 0.22);
      ctx.closePath();
      ctx.fillStyle = o.fill ?? '#ffd21f';
      ctx.fill();
      ctx.strokeStyle = o.outline ?? '#111111';
      ctx.lineWidth = s * 0.08;
      ctx.stroke();
      break;
    }
    case 'paw': {
      ctx.fillStyle = o.fill ?? '#1a1a1a';
      ctx.beginPath();
      ctx.ellipse(0, s * 0.3, s * 0.52, s * 0.44, 0, 0, Math.PI * 2);
      ctx.fill();
      const toes: Array<[number, number, number]> = [
        [-0.62, -0.28, -0.35],
        [-0.22, -0.68, -0.1],
        [0.22, -0.68, 0.1],
        [0.62, -0.28, 0.35],
      ];
      for (const [tx, ty, rot] of toes) {
        ctx.beginPath();
        ctx.ellipse(tx * s, ty * s, s * 0.19, s * 0.25, rot, 0, Math.PI * 2);
        ctx.fill();
      }
      if (o.outline) {
        ctx.strokeStyle = o.outline;
        ctx.lineWidth = s * 0.05;
        ctx.stroke();
      }
      break;
    }
    case 'flower': {
      ctx.fillStyle = o.petals ?? '#ffffff';
      const n = 12;
      for (let i = 0; i < n; i++) {
        ctx.save();
        ctx.rotate((i / n) * Math.PI * 2);
        ctx.beginPath();
        ctx.ellipse(0, -s * 0.55, s * 0.17, s * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
        if (o.outline) {
          ctx.strokeStyle = o.outline;
          ctx.lineWidth = s * 0.03;
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = o.center ?? '#ffcc22';
      ctx.fill();
      ctx.fillStyle = 'rgba(200,120,0,0.35)';
      ctx.beginPath();
      ctx.arc(s * 0.06, s * 0.08, s * 0.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
// Kart decals
// ---------------------------------------------------------------------------------------------

/** Hood decal (square, transparent): emblem + per-kart stripes. */
export function hoodTexture(id: CharacterId, kind: EmblemKind, colors: { primary: string; secondary: string; accent: string }): THREE.Texture | null {
  return canvasTex(`hood:${id}`, 256, 512, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h * 0.42;
    switch (id) {
      case 'dad':
        ctx.fillStyle = colors.secondary;
        for (const s of [-1, 1]) ctx.fillRect(cx + s * 92 - 12, 0, 24, h);
        ctx.fillStyle = '#ffffff';
        for (const s of [-1, 1]) ctx.fillRect(cx + s * 92 - 2, 0, 4, h);
        drawEmblem(ctx, 'x', cx, cy, 70, { fill: '#ffffff', outline: '#0b1d55' });
        break;
      case 'parker':
        ctx.fillStyle = '#151515';
        ctx.beginPath();
        ctx.moveTo(cx - 70, 0);
        ctx.lineTo(cx + 70, 0);
        ctx.lineTo(cx + 105, h);
        ctx.lineTo(cx - 105, h);
        ctx.closePath();
        ctx.fill();
        drawEmblem(ctx, 'bolt', cx, cy, 78, { fill: '#ffd21f', outline: '#151515' });
        break;
      case 'brennan':
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(cx, cy, 86, 0, Math.PI * 2);
        ctx.fill();
        drawEmblem(ctx, 'soccer', cx, cy, 74, {});
        break;
      case 'mom':
        drawEmblem(ctx, 'heart', cx, cy + 10, 84, { fill: '#ffd6ef', outline: '#8a3fd1' });
        break;
      case 'lupin':
        drawEmblem(ctx, 'paw', cx, cy + 6, 84, { fill: '#1a1a1a' });
        break;
      case 'grandma':
        drawEmblem(ctx, 'flower', cx, cy, 86, { petals: '#ffffff', center: '#ffd23f', outline: '#c9d6cf' });
        break;
      default:
        drawEmblem(ctx, kind, cx, cy, 80, {});
    }
  });
}

const INITIAL: Record<CharacterId, string> = { dad: 'D', mom: 'M', brennan: 'B', parker: 'P', lupin: 'L', grandma: 'G' };

/** Side decal (wide, transparent): swoosh stripe, emblem and racer initial. */
export function sideTexture(id: CharacterId, kind: EmblemKind, colors: { primary: string; secondary: string; accent: string }): THREE.Texture | null {
  return canvasTex(`side:${id}`, 512, 160, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    // swoosh stripes
    const stripe = id === 'dad' || id === 'brennan' ? '#ffffff' : colors.accent;
    ctx.fillStyle = stripe;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.62);
    ctx.quadraticCurveTo(w * 0.5, h * 0.45, w, h * 0.3);
    ctx.lineTo(w, h * 0.42);
    ctx.quadraticCurveTo(w * 0.5, h * 0.6, 0, h * 0.76);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = id === 'grandma' ? '#ffffff' : colors.primary === stripe ? colors.secondary : colors.primary;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.82);
    ctx.quadraticCurveTo(w * 0.5, h * 0.68, w, h * 0.5);
    ctx.lineTo(w, h * 0.56);
    ctx.quadraticCurveTo(w * 0.5, h * 0.76, 0, h * 0.9);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    // number roundel
    const rx = w * 0.5;
    const ry = h * 0.42;
    ctx.beginPath();
    ctx.arc(rx, ry, 50, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.strokeStyle = '#151515';
    ctx.stroke();
    if (id === 'grandma' || id === 'lupin' || id === 'brennan' || id === 'mom') {
      drawEmblem(ctx, kind, rx, ry + (kind === 'heart' ? 4 : 0), 34, { fill: kind === 'heart' ? colors.primary : undefined, outline: kind === 'heart' ? '#ffffff' : undefined, petals: '#ffffff', center: '#ffd23f' });
      if (kind === 'flower') {
        ctx.beginPath();
        ctx.arc(rx, ry, 50, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0)';
      }
    } else {
      ctx.fillStyle = '#151515';
      ctx.font = 'bold 64px Arial Black, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(INITIAL[id], rx, ry + 3);
    }
    // little extra emblems along the stripe
    if (id === 'grandma') {
      drawEmblem(ctx, 'flower', w * 0.17, h * 0.4, 26, { petals: '#ffffff', center: '#ffd23f' });
      drawEmblem(ctx, 'flower', w * 0.84, h * 0.28, 20, { petals: '#ffe0f0', center: '#ffd23f' });
    } else if (id === 'lupin') {
      drawEmblem(ctx, 'paw', w * 0.18, h * 0.4, 22, { fill: '#2a2a2a' });
      drawEmblem(ctx, 'paw', w * 0.82, h * 0.3, 18, { fill: '#2a2a2a' });
    } else if (id === 'parker') {
      drawEmblem(ctx, 'bolt', w * 0.2, h * 0.4, 30, { fill: '#ffd21f', outline: '#151515' });
      drawEmblem(ctx, 'bolt', w * 0.82, h * 0.3, 26, { fill: '#ffd21f', outline: '#151515' });
    } else if (id === 'brennan') {
      drawEmblem(ctx, 'soccer', w * 0.18, h * 0.42, 22, {});
    } else if (id === 'mom') {
      drawEmblem(ctx, 'heart', w * 0.18, h * 0.42, 20, { fill: '#ff8fd0', outline: '#ffffff' });
      drawEmblem(ctx, 'heart', w * 0.84, h * 0.3, 15, { fill: '#ffffff', outline: '#ff8fd0' });
    }
  });
}

/** Tyre tread: chevron grooves around the circumference (u) in the middle band of the profile (v). */
export function treadTexture(): THREE.Texture | null {
  return canvasTex('tread', 512, 64, (ctx, w, h) => {
    ctx.fillStyle = '#26262a';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#121214';
    const n = 20;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * w;
      ctx.beginPath();
      ctx.moveTo(x, h * 0.22);
      ctx.lineTo(x + 10, h * 0.22);
      ctx.lineTo(x + 22, h * 0.5);
      ctx.lineTo(x + 10, h * 0.78);
      ctx.lineTo(x, h * 0.78);
      ctx.lineTo(x + 12, h * 0.5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#34343a';
    ctx.fillRect(0, h * 0.1, w, 3);
    ctx.fillRect(0, h * 0.9 - 3, w, 3);
  });
}

export function tennisBallTexture(): THREE.Texture | null {
  return canvasTex('tennis', 256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#d9ef3a';
    ctx.fillRect(0, 0, w, h);
    const rnd = mulberry(9);
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,200,0.35)' : 'rgba(150,170,0,0.3)';
      ctx.fillRect(rnd() * w, rnd() * h, 2, 2);
    }
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 7;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const y = h / 2 + Math.sin((x / w) * Math.PI * 4) * h * 0.28;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
}

export function bandanaTexture(color: string): THREE.Texture | null {
  return canvasTex(`bandana:${color}`, 256, 128, (ctx, w, h) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    const pts: Array<[number, number]> = [
      [0.12, 0.3], [0.32, 0.65], [0.5, 0.35], [0.68, 0.65], [0.88, 0.3], [0.22, 0.85], [0.78, 0.85], [0.5, 0.82],
    ];
    for (const [x, y] of pts) drawEmblem(ctx, 'paw', x * w, y * h, 13, { fill: '#ffffff' });
  });
}
