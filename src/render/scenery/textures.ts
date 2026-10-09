import * as THREE from 'three';
import { Rng } from '../../core/rng';

/** Procedural canvas textures shared by the track view and scenery builders. */

export type Draw = (g: CanvasRenderingContext2D, w: number, h: number, rng: Rng) => void;

export function canvasTexture(w: number, h: number, draw: Draw, opts: { seed?: number; repeat?: boolean; srgb?: boolean; mips?: boolean } = {}): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g, w, h, new Rng(opts.seed ?? 1234));
  const t = new THREE.CanvasTexture(c);
  if (opts.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat !== false) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (opts.mips === false) {
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
  }
  return t;
}

/** Sprinkle random speckles (noise) of given colors. */
export function speckle(g: CanvasRenderingContext2D, w: number, h: number, rng: Rng, colors: string[], count: number, size: [number, number], alpha = 1): void {
  g.globalAlpha = alpha;
  for (let i = 0; i < count; i++) {
    g.fillStyle = colors[rng.int(colors.length)];
    const s = rng.range(size[0], size[1]);
    g.fillRect(rng.next() * w, rng.next() * h, s, s);
  }
  g.globalAlpha = 1;
}

export function blobs(g: CanvasRenderingContext2D, w: number, h: number, rng: Rng, colors: string[], count: number, r: [number, number], alpha = 0.25): void {
  g.globalAlpha = alpha;
  for (let i = 0; i < count; i++) {
    g.fillStyle = colors[rng.int(colors.length)];
    const x = rng.next() * w, y = rng.next() * h, rr = rng.range(r[0], r[1]);
    for (const [ox, oy] of [[0, 0], [w, 0], [-w, 0], [0, h], [0, -h]]) {
      g.beginPath();
      g.ellipse(x + ox, y + oy, rr, rr * rng.range(0.6, 1), rng.next() * 3, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.globalAlpha = 1;
}

export interface RoadTexOpts {
  base: string;
  speck: string[];
  edge?: string | null; // edge line color
  center?: string | null; // center dash color
  centerSolid?: boolean;
  lanes?: number; // dashed lane lines count (in addition to center)
  patches?: string[];
  edgeInset?: number; // 0..0.5 fraction
  style?: 'asphalt' | 'placemat' | 'dirt' | 'snow';
}

/** Road texture: u = across (0..1 left->right), v = along. One tile = roadTileLen meters. */
export function roadTexture(o: RoadTexOpts, seed = 7): THREE.CanvasTexture {
  return canvasTexture(256, 512, (g, w, h, rng) => {
    g.fillStyle = o.base;
    g.fillRect(0, 0, w, h);
    if (o.patches) blobs(g, w, h, rng, o.patches, 26, [10, 40], 0.18);
    speckle(g, w, h, rng, o.speck, 4500, [1, 2.5], 0.55);
    const inset = (o.edgeInset ?? 0.035) * w;
    if (o.style === 'placemat') {
      // woven placemat strip
      g.globalAlpha = 0.07;
      g.fillStyle = '#000';
      for (let y = 0; y < h; y += 8) g.fillRect(0, y, w, 2);
      for (let x = 0; x < w; x += 8) g.fillRect(x, 0, 2, h);
      g.globalAlpha = 1;
      g.fillStyle = o.edge ?? '#fff';
      g.fillRect(inset, 0, 10, h);
      g.fillRect(w - inset - 10, 0, 10, h);
      if (o.center) {
        g.fillStyle = o.center;
        for (let y = 0; y < h; y += 64) {
          g.beginPath();
          g.arc(w / 2, y + 32, 9, 0, Math.PI * 2);
          g.fill();
        }
      }
      return;
    }
    if (o.style === 'dirt') {
      // tire ruts
      g.globalAlpha = 0.16;
      g.fillStyle = '#3a2410';
      for (const x of [0.3, 0.38, 0.62, 0.7]) g.fillRect(x * w - 6, 0, 12, h);
      g.globalAlpha = 1;
      // grass tufts at the edges
      for (let i = 0; i < 260; i++) {
        const side = rng.chance(0.5);
        const x = side ? rng.range(0, inset * 2.2) : w - rng.range(0, inset * 2.2);
        g.fillStyle = rng.pick(['#5d9e3a', '#77b84a', '#4c8a30']);
        g.fillRect(x, rng.next() * h, rng.range(2, 6), rng.range(4, 10));
      }
      return;
    }
    if (o.style === 'snow') {
      g.globalAlpha = 0.22;
      g.fillStyle = '#7b8ea8';
      for (const x of [0.28, 0.36, 0.64, 0.72]) {
        for (let y = 0; y < h; y += 6) g.fillRect(x * w - 7 + Math.sin(y * 0.05) * 2, y, 14, 3);
      }
      g.globalAlpha = 1;
    }
    if (o.edge) {
      g.fillStyle = o.edge;
      g.fillRect(inset, 0, 7, h);
      g.fillRect(w - inset - 7, 0, 7, h);
    }
    if (o.center) {
      g.fillStyle = o.center;
      if (o.centerSolid) {
        g.fillRect(w / 2 - 7, 0, 5, h);
        g.fillRect(w / 2 + 2, 0, 5, h);
      } else for (let y = 0; y < h; y += 128) g.fillRect(w / 2 - 4, y + 16, 8, 64);
    }
    const lanes = o.lanes ?? 0;
    if (lanes > 0) {
      g.fillStyle = o.edge ?? '#fff';
      g.globalAlpha = 0.8;
      for (let l = 1; l <= lanes; l++) {
        const x = (l / (lanes + 1)) * w;
        if (Math.abs(x - w / 2) < 4 && o.center) continue;
        for (let y = 0; y < h; y += 128) g.fillRect(x - 3, y + 40, 6, 48);
      }
      g.globalAlpha = 1;
    }
    // subtle wear in the racing grooves
    g.globalAlpha = 0.07;
    g.fillStyle = '#000';
    g.fillRect(w * 0.25, 0, w * 0.12, h);
    g.fillRect(w * 0.63, 0, w * 0.12, h);
    g.globalAlpha = 1;
  }, { seed });
}

export function stripeTexture(a: string, b: string, n = 2, horizontal = false): THREE.CanvasTexture {
  return canvasTexture(64, 64, (g, w, h) => {
    for (let i = 0; i < n; i++) {
      g.fillStyle = i % 2 ? b : a;
      if (horizontal) g.fillRect(0, (i * h) / n, w, h / n + 1);
      else g.fillRect(0, (i * h) / n, w, h / n + 1);
    }
    void horizontal;
  });
}

export function checkerTexture(a = '#ffffff', b = '#151515', n = 8): THREE.CanvasTexture {
  const t = canvasTexture(128, 128, (g, w, h) => {
    const s = w / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 ? b : a;
      g.fillRect(x * s, y * s, s, (h / n) + 0.5);
    }
  });
  t.magFilter = THREE.NearestFilter;
  return t;
}

export function grassTexture(base: string, dark: string, light: string, seed = 3, flowers?: string[]): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g, w, h, rng) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    blobs(g, w, h, rng, [dark, light], 40, [12, 40], 0.2);
    for (let i = 0; i < 2600; i++) {
      g.strokeStyle = rng.chance(0.5) ? dark : light;
      g.globalAlpha = 0.35;
      const x = rng.next() * w, y = rng.next() * h;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + rng.range(-1.5, 1.5), y - rng.range(2, 5));
      g.stroke();
    }
    g.globalAlpha = 1;
    if (flowers) for (let i = 0; i < 70; i++) {
      g.fillStyle = rng.pick(flowers);
      g.beginPath();
      g.arc(rng.next() * w, rng.next() * h, rng.range(1.2, 2.4), 0, Math.PI * 2);
      g.fill();
    }
  }, { seed });
}

export function noiseTexture(base: string, colors: string[], seed = 5, blobColors?: string[], size = 256): THREE.CanvasTexture {
  return canvasTexture(size, size, (g, w, h, rng) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    if (blobColors) blobs(g, w, h, rng, blobColors, 40, [10, 46], 0.2);
    speckle(g, w, h, rng, colors, (w * h) / 14, [1, 2.5], 0.5);
  }, { seed });
}

export function tileTexture(base: string, grout: string, n = 4, jitter = 0.06, seed = 9): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g, w, h, rng) => {
    g.fillStyle = grout;
    g.fillRect(0, 0, w, h);
    const s = w / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const c = new THREE.Color(base);
      c.offsetHSL(0, 0, rng.range(-jitter, jitter));
      g.fillStyle = `#${c.getHexString()}`;
      g.fillRect(x * s + 2, y * s + 2, s - 4, s - 4);
    }
    speckle(g, w, h, rng, ['#000', '#fff'], 1200, [1, 2], 0.08);
  }, { seed });
}

export function brickTexture(base: string, mortar = '#d9cfc0', seed = 11): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g, w, h, rng) => {
    g.fillStyle = mortar;
    g.fillRect(0, 0, w, h);
    const bh = 16, bw = 42;
    for (let row = 0; row * bh < h; row++) {
      const off = (row % 2) * (bw / 2);
      for (let x = -bw; x < w + bw; x += bw) {
        const c = new THREE.Color(base);
        c.offsetHSL(rng.range(-0.015, 0.015), 0, rng.range(-0.07, 0.07));
        g.fillStyle = `#${c.getHexString()}`;
        g.fillRect(x + off + 1.5, row * bh + 1.5, bw - 3, bh - 3);
      }
    }
  }, { seed });
}

/**
 * Building facade texture: one tile = WIN_CELL meters (see windowedMaterial). White-ish wall with
 * windows; tint via material/instance color. `lit` adds an emissive companion map.
 */
export function windowTexture(opts: { wall?: string; glass?: string; glass2?: string; frame?: number; bands?: boolean; seed?: number } = {}): THREE.CanvasTexture {
  return canvasTexture(128, 128, (g, w, h, rng) => {
    g.fillStyle = opts.wall ?? '#f2f2f2';
    g.fillRect(0, 0, w, h);
    const cols = 4, rows = 4;
    const cw = w / cols, ch = h / rows;
    const fr = opts.frame ?? 0.22;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      g.fillStyle = rng.chance(0.25) ? (opts.glass2 ?? '#7fa6c9') : (opts.glass ?? '#5b84ad');
      if (opts.bands) g.fillRect(0, y * ch + ch * fr, w, ch * (1 - fr * 1.6));
      else g.fillRect(x * cw + cw * fr * 0.6, y * ch + ch * fr, cw * (1 - fr * 1.2), ch * (1 - fr * 1.6));
    }
    // reflections
    g.globalAlpha = 0.18;
    g.fillStyle = '#ffffff';
    for (let y = 0; y < rows; y++) g.fillRect(0, y * ch + ch * fr, w, 3);
    g.globalAlpha = 1;
  }, { seed: opts.seed ?? 21 });
}

/** Emissive window mask: random lit windows (night/dusk). */
export function windowLitTexture(color = '#ffd27a', p = 0.45, seed = 22, bands = false): THREE.CanvasTexture {
  return canvasTexture(128, 128, (g, w, h, rng) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    const cols = 4, rows = 4, cw = w / cols, ch = h / rows, fr = 0.22;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (!rng.chance(p)) continue;
      g.fillStyle = color;
      g.globalAlpha = rng.range(0.5, 1);
      if (bands) g.fillRect(x * cw, y * ch + ch * fr, cw, ch * (1 - fr * 1.6));
      else g.fillRect(x * cw + cw * fr * 0.6, y * ch + ch * fr, cw * (1 - fr * 1.2), ch * (1 - fr * 1.6));
    }
    g.globalAlpha = 1;
  }, { seed });
}

export function textTexture(text: string, opts: { w?: number; h?: number; bg?: string; fg?: string; font?: string; stroke?: string; border?: string } = {}): THREE.CanvasTexture {
  const w = opts.w ?? 512, h = opts.h ?? 128;
  return canvasTexture(w, h, (g) => {
    if (opts.bg) {
      g.fillStyle = opts.bg;
      g.fillRect(0, 0, w, h);
    } else g.clearRect(0, 0, w, h);
    if (opts.border) {
      g.strokeStyle = opts.border;
      g.lineWidth = h * 0.08;
      g.strokeRect(h * 0.06, h * 0.06, w - h * 0.12, h - h * 0.12);
    }
    let size = Math.floor(h * 0.62);
    g.font = opts.font ?? `900 ${size}px "Arial Black", Impact, sans-serif`;
    if (!opts.font) {
      // shrink to fit inside the border
      while (size > 8 && g.measureText(text).width > w * 0.9) {
        size -= 2;
        g.font = `900 ${size}px "Arial Black", Impact, sans-serif`;
      }
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (opts.stroke) {
      g.strokeStyle = opts.stroke;
      g.lineWidth = h * 0.08;
      g.strokeText(text, w / 2, h * 0.54);
    }
    g.fillStyle = opts.fg ?? '#fff';
    g.fillText(text, w / 2, h * 0.54);
  }, { repeat: false });
}

/** Animated-boost chevrons: v along the pad. */
export function chevronTexture(a = '#ffe14d', b = '#ff7a1a'): THREE.CanvasTexture {
  return canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = '#1b2bff';
    g.globalAlpha = 0.0;
    g.fillRect(0, 0, w, h);
    g.globalAlpha = 1;
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, a);
    grad.addColorStop(1, b);
    g.fillStyle = grad;
    for (let k = 0; k < 2; k++) {
      const y0 = k * (h / 2);
      g.beginPath();
      g.moveTo(w * 0.08, y0 + h * 0.36);
      g.lineTo(w * 0.5, y0 + h * 0.06);
      g.lineTo(w * 0.92, y0 + h * 0.36);
      g.lineTo(w * 0.92, y0 + h * 0.48);
      g.lineTo(w * 0.5, y0 + h * 0.2);
      g.lineTo(w * 0.08, y0 + h * 0.48);
      g.closePath();
      g.fill();
    }
  });
}

export function waterTexture(base: string, light: string, seed = 31): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g, w, h, rng) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    blobs(g, w, h, rng, [light], 30, [10, 30], 0.12);
    g.strokeStyle = light;
    g.lineCap = 'round';
    for (let i = 0; i < 90; i++) {
      g.globalAlpha = rng.range(0.25, 0.7);
      g.lineWidth = rng.range(1, 2.5);
      const x = rng.next() * w, y = rng.next() * h, l = rng.range(8, 26);
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + l / 2, y - 3, x + l, y);
      g.stroke();
    }
    g.globalAlpha = 1;
  }, { seed });
}

/** Soft round sprite (particles, glows). */
export function dotTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)'): THREE.CanvasTexture {
  return canvasTexture(64, 64, (g, w, h) => {
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }, { repeat: false });
}

/** Rectangular flag designs. */
export function flagTexture(kind: 'chicago' | 'checker' | 'usa' | 'pennant'): THREE.CanvasTexture {
  if (kind === 'checker') return checkerTexture('#ffffff', '#111111', 6);
  return canvasTexture(192, 128, (g, w, h) => {
    if (kind === 'chicago') drawChicagoFlag(g, 0, 0, w, h); else if (kind === 'usa') {
      for (let i = 0; i < 13; i++) {
        g.fillStyle = i % 2 ? '#ffffff' : '#c8202f';
        g.fillRect(0, (i * h) / 13, w, h / 13 + 1);
      }
      g.fillStyle = '#26307a';
      g.fillRect(0, 0, w * 0.42, h * 0.54);
    } else {
      g.fillStyle = '#ff4fa3';
      g.fillRect(0, 0, w, h);
    }
  }, { repeat: false });
}

export function star(g: CanvasRenderingContext2D, x: number, y: number, ro: number, ri: number, n: number): void {
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? ri : ro;
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    if (i === 0) g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    else g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
}

/** Crowd texture for grandstands (rows of colorful people). */
export function crowdTexture(seed = 41): THREE.CanvasTexture {
  return canvasTexture(256, 128, (g, w, h, rng) => {
    g.fillStyle = '#4a4f5c';
    g.fillRect(0, 0, w, h);
    const rows = 4;
    for (let r = 0; r < rows; r++) {
      const y = (r + 0.5) * (h / rows);
      for (let x = 6; x < w; x += 12) {
        g.fillStyle = rng.pick(['#e8443a', '#2f7de1', '#ffd23f', '#3ccf6e', '#ffffff', '#ff8a3d', '#b05cf0', '#14315e']);
        g.fillRect(x - 4, y - 2, 8, 14);
        g.fillStyle = rng.pick(['#f1c8a5', '#d6a37c', '#8d5a3b', '#f7d9bf']);
        g.beginPath();
        g.arc(x, y - 6, 4, 0, Math.PI * 2);
        g.fill();
      }
    }
  }, { seed });
}

/** The Chicago municipal flag: white field, two light-blue stripes, four red six-pointed stars. */
export function drawChicagoFlag(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  g.fillStyle = '#ffffff';
  g.fillRect(x, y, w, h);
  g.fillStyle = '#41B6E6';
  g.fillRect(x, y + h / 6, w, h / 6);
  g.fillRect(x, y + (h * 4) / 6, w, h / 6);
  g.fillStyle = '#E4002B';
  const r = Math.min(h * 0.14, w * 0.075);
  for (let i = 0; i < 4; i++) star(g, x + w * (0.2 + i * 0.2), y + h * 0.5, r, r * 0.5, 6);
}

/** Vertical lamp-post banner (u across, v up): Chicago flag on top, CHICAGO lettering below. */
export function chicagoBannerTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 256, (g, w, h) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    drawChicagoFlag(g, 0, 0, w, h * 0.42);
    g.fillStyle = '#41B6E6';
    g.fillRect(0, h * 0.42, w, h * 0.58);
    g.fillStyle = '#ffffff';
    g.font = '900 30px "Arial Black", Impact, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    'CHI'.split('').forEach((c, i) => g.fillText(c, w / 2, h * 0.52 + i * 34));
    g.fillStyle = '#E4002B';
    star(g, w / 2, h * 0.93, 11, 5.5, 6);
  }, { repeat: false });
}

/**
 * Equirectangular reflection map for chrome objects (the Bean): sky gradient, puffy clouds, a ring of
 * skyline silhouettes at the horizon and a pale plaza below. `dusk` paints a lit winter evening.
 */
export function cityEnvTexture(dusk: boolean): THREE.CanvasTexture {
  const t = canvasTexture(1024, 512, (g, w, h, rng) => {
    const sky = g.createLinearGradient(0, 0, 0, h * 0.5);
    if (dusk) {
      sky.addColorStop(0, '#1d2350');
      sky.addColorStop(0.6, '#6b4f86');
      sky.addColorStop(1, '#f29a7a');
    } else {
      sky.addColorStop(0, '#2f7fe0');
      sky.addColorStop(0.65, '#8cc4f5');
      sky.addColorStop(1, '#ffe6c4');
    }
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h * 0.5);
    if (!dusk) {
      g.fillStyle = 'rgba(255,255,255,0.9)';
      for (let i = 0; i < 14; i++) {
        const cx = rng.next() * w, cy = rng.range(h * 0.12, h * 0.36);
        for (let k = 0; k < 5; k++) {
          g.beginPath();
          g.ellipse(cx + rng.range(-40, 40), cy + rng.range(-8, 8), rng.range(18, 40), rng.range(8, 16), 0, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    // ground: plaza near the horizon, darker straight down
    const gr = g.createLinearGradient(0, h * 0.5, 0, h);
    gr.addColorStop(0, dusk ? '#c9cfdc' : '#b9b4aa');
    gr.addColorStop(0.3, dusk ? '#eef3fb' : '#d8d2c6');
    gr.addColorStop(1, dusk ? '#9aa3b8' : '#6f6a62');
    g.fillStyle = gr;
    g.fillRect(0, h * 0.5, w, h * 0.5);
    // skyline ring
    let x = 0;
    while (x < w) {
      const bw = rng.range(10, 34), bh = rng.range(14, 90) * (rng.chance(0.1) ? 1.6 : 1);
      const col = dusk ? rng.pick(['#232744', '#2c2f52', '#1b1f3a']) : rng.pick(['#5d7391', '#7d8fa8', '#c9b79a', '#3c4656', '#9fb3c9']);
      g.fillStyle = col;
      g.fillRect(x, h * 0.5 - bh, bw, bh);
      g.fillStyle = dusk ? '#ffd27a' : 'rgba(255,255,255,0.35)';
      for (let yy = h * 0.5 - bh + 3; yy < h * 0.5 - 2; yy += 5) for (let xx = x + 2; xx < x + bw - 2; xx += 4) if (rng.chance(dusk ? 0.35 : 0.25)) g.fillRect(xx, yy, 2, 2);
      x += bw + rng.range(0, 6);
    }
    // people specks on the plaza
    for (let i = 0; i < 160; i++) {
      g.fillStyle = rng.pick(['#e8443a', '#2f7de1', '#ffd23f', '#3ccf6e', '#222', '#ffffff']);
      g.fillRect(rng.next() * w, rng.range(h * 0.52, h * 0.62), 2, 4);
    }
  }, { seed: dusk ? 991 : 990, repeat: false });
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}
