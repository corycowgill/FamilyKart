import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { SceneryContext, SceneryHandle } from './types';
import { Batch, ctxBits, disposeGroup, M, mergeColored, setInstance, timeOfDay, trimShadows, vcMat } from './common';
import { getField } from './field';
import { canvasTexture, dotTexture, drawChicagoFlag, drawChicagoSkyline, star, tileTexture } from './textures';
import { beam, chicagoHotDog, deepDishPizza, drawGreetingsPoster, drawText, giardinieraJar, italianBeef, Kit, popcornTin, SignAtlas } from './chicagoLandmarks';

type P = Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]>;

const FLOOR_Y = -60;

/** Cereal box face texture. */
function cerealTexture(name: string, bg: string, fg: string, seed: number): THREE.CanvasTexture {
  return canvasTexture(256, 384, (g, w, h, rng) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    for (let i = 0; i < 8; i++) {
      g.beginPath();
      g.arc(rng.next() * w, rng.next() * h, rng.range(20, 60), 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(w / 2, h * 0.68, w * 0.38, h * 0.13, 0, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = rng.pick(['#ff5fa2', '#ffd23f', '#3ccf6e', '#ff8a3d', '#8a5cf0']);
      g.lineWidth = 7;
      g.beginPath();
      g.arc(w / 2 + rng.range(-80, 80), h * 0.64 + rng.range(-24, 18), 9, 0, Math.PI * 2);
      g.stroke();
    }
    g.textAlign = 'center';
    g.lineWidth = 8;
    g.strokeStyle = '#00000066';
    const words = name.split(' ');
    words.forEach((word, i) => {
      let size = 54;
      g.font = `900 ${size}px "Arial Black", Impact, sans-serif`;
      while (size > 20 && g.measureText(word).width > w - 24) g.font = `900 ${--size}px "Arial Black", Impact, sans-serif`;
      g.strokeText(word, w / 2, 80 + i * 62);
      g.fillStyle = fg;
      g.fillText(word, w / 2, 80 + i * 62);
    });
    // "Made in Chicago" badge: a little flag + star roundel
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(w - 46, h - 46, 36, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#41B6E6';
    g.fillRect(w - 80, h - 62, 68, 8);
    g.fillRect(w - 80, h - 38, 68, 8);
    g.fillStyle = '#E4002B';
    star(g, w - 46, h - 46, 13, 6.5, 6);
    drawChicagoFlag(g, 14, h - 52, 60, 40);
  }, { repeat: false, seed });
}

function labelTexture(text: string, bg: string, fg: string, w = 256, h = 256): THREE.CanvasTexture {
  return canvasTexture(w, h, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = fg;
    g.font = `900 ${Math.floor(h * 0.24)}px "Arial Black", Impact, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2);
  }, { repeat: false });
}

/** The view out of the kitchen window: two-flat rooftops, the downtown skyline and the L structure. */
function windowViewTexture(tod: 'day' | 'sunset' | 'night'): THREE.CanvasTexture {
  return canvasTexture(1024, 640, (g, w, h, rng) => {
    const night = tod === 'night', sunset = tod === 'sunset';
    const sky = g.createLinearGradient(0, 0, 0, h * 0.7);
    sky.addColorStop(0, night ? '#0b1030' : sunset ? '#3b3f8f' : '#4f9fea');
    sky.addColorStop(1, night ? '#2a3366' : sunset ? '#ff9a6b' : '#d6f0ff');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    if (!night) {
      g.fillStyle = sunset ? 'rgba(255,200,170,0.75)' : 'rgba(255,255,255,0.92)';
      for (let i = 0; i < 7; i++) {
        const cx = rng.next() * w, cy = rng.range(40, 200);
        for (let k = 0; k < 5; k++) {
          g.beginPath();
          g.ellipse(cx + rng.range(-50, 50), cy + rng.range(-10, 10), rng.range(30, 60), rng.range(12, 24), 0, 0, Math.PI * 2);
          g.fill();
        }
      }
    } else {
      g.fillStyle = '#ffffff';
      for (let i = 0; i < 60; i++) g.fillRect(rng.next() * w, rng.next() * h * 0.4, 2, 2);
    }
    drawChicagoSkyline(g, -20, h * 0.84, w + 40, h * 0.72, rng, night
      ? { tones: ['#1c2238', '#232a44', '#2a3150'], dark: '#0d1020', glass: '#2d3c63', windows: 'rgba(255,214,120,0.85)' }
      : sunset ? { tones: ['#6a5a7a', '#7a6886', '#8a7a92'], dark: '#2a2236', glass: '#8c86a8', windows: 'rgba(255,220,160,0.45)' } : {});
    // foreground two-flat rooftops with water tanks and chimneys
    let x = -10;
    while (x < w) {
      const bw = rng.range(90, 150), top = h * rng.range(0.86, 0.9);
      g.fillStyle = rng.pick(night ? ['#3a2018', '#4a281c', '#2e1a14'] : ['#9a4a32', '#b25a3c', '#7d3f2a', '#a8805a']);
      g.fillRect(x, top, bw, h - top);
      g.fillStyle = night ? '#1a1410' : '#e9dcc4';
      g.fillRect(x - 3, top - 8, bw + 6, 10);
      g.fillStyle = night ? 'rgba(255,200,110,0.9)' : '#3a4a5e';
      for (let wy = top + 24; wy < h - 20; wy += 50) for (let wx = x + 16; wx < x + bw - 26; wx += 40) if (!night || rng.chance(0.6)) g.fillRect(wx, wy, 20, 30);
      if (rng.chance(0.4)) {
        g.fillStyle = night ? '#120c08' : '#6b4a2e';
        g.fillRect(x + bw * 0.6, top - 52, 30, 34);
        g.beginPath();
        g.moveTo(x + bw * 0.6 - 4, top - 52);
        g.lineTo(x + bw * 0.6 + 15, top - 66);
        g.lineTo(x + bw * 0.6 + 34, top - 52);
        g.fill();
        g.fillRect(x + bw * 0.6 + 4, top - 18, 3, 12);
        g.fillRect(x + bw * 0.6 + 23, top - 18, 3, 12);
      }
      x += bw + rng.range(4, 14);
    }
    // the green elevated L structure (the train runs on top: see lTrainTexture)
    const deck = h * 0.8;
    g.fillStyle = night ? '#1e2a1c' : '#3f5a3a';
    g.fillRect(0, deck, w, 18);
    g.strokeStyle = night ? '#1e2a1c' : '#3f5a3a';
    g.lineWidth = 4;
    for (let cx = 0; cx < w; cx += 36) {
      g.beginPath();
      g.moveTo(cx, deck + 18);
      g.lineTo(cx + 18, deck + 2);
      g.lineTo(cx + 36, deck + 18);
      g.stroke();
    }
    for (let cx = 60; cx < w; cx += 210) g.fillRect(cx, deck + 18, 12, h - deck);
  }, { repeat: false, seed: 1871 });
}

/** CTA L train cars on a transparent strip; slid across the window by animating the texture offset. */
function lTrainTexture(): THREE.CanvasTexture {
  const t = canvasTexture(1024, 640, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const deck = h * 0.8, carW = 172, carH = 58;
    for (let i = 0; i < 4; i++) {
      const x = 170 + i * (carW + 6);
      g.fillStyle = '#d4d9df';
      g.fillRect(x, deck - carH, carW, carH);
      g.fillStyle = '#9aa0a8';
      g.fillRect(x + 4, deck - carH - 5, carW - 8, 6);
      g.fillStyle = '#1f5fbf';
      g.fillRect(x, deck - 20, carW, 5);
      g.fillStyle = '#c60c30';
      g.fillRect(x, deck - 14, carW, 4);
      g.fillStyle = '#2a3446';
      for (let k = 0; k < 6; k++) g.fillRect(x + 8 + k * 27, deck - carH + 10, 20, 18);
      g.fillStyle = '#7d848e';
      g.fillRect(x + carW * 0.33, deck - carH + 6, 2, carH - 12);
      g.fillRect(x + carW * 0.66, deck - carH + 6, 2, carH - 12);
      g.fillStyle = '#222';
      g.fillRect(x + 14, deck - 6, 40, 6);
      g.fillRect(x + carW - 54, deck - 6, 40, 6);
    }
    // destination sign on the lead car
    g.fillStyle = '#111';
    g.fillRect(170 + 3 * (carW + 6) + carW - 50, deck - carH + 6, 44, 14);
    g.fillStyle = '#ffb000';
    g.font = '900 11px Arial';
    g.fillText('LOOP', 170 + 3 * (carW + 6) + carW - 44, deck - carH + 17);
  }, { repeat: false });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Crayon scribble helper: wobbly polyline. */
function crayon(g: CanvasRenderingContext2D, pts: Array<[number, number]>, col: string, wdt = 6, close = false): void {
  g.strokeStyle = col;
  g.lineWidth = wdt;
  g.lineCap = g.lineJoin = 'round';
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  if (close) g.closePath();
  g.stroke();
}

function paper(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rot: number, draw: () => void): void {
  g.save();
  g.translate(x + w / 2, y + h / 2);
  g.rotate(rot);
  g.translate(-w / 2, -h / 2);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(5, 6, w, h);
  g.fillStyle = '#fffdf6';
  g.fillRect(0, 0, w, h);
  draw();
  g.restore();
}

function magnet(g: CanvasRenderingContext2D, x: number, y: number, col: string): void {
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.beginPath();
  g.arc(x + 2, y + 3, 11, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = col;
  g.beginPath();
  g.arc(x, y, 11, 0, Math.PI * 2);
  g.fill();
}

/** Fridge door collage: kid drawings, Chicago-flag magnets, letter magnets and NO KETCHUP. */
function drawFridgeArt(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = '#e9eef3';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#9aa5b1';
  g.fillRect(0, h * 0.655, w, 7);
  // 1. the family go-kart race
  paper(g, 24, 36, 280, 220, -0.06, () => {
    g.fillStyle = '#ffe066';
    g.beginPath();
    g.arc(240, 40, 24, 0, Math.PI * 2);
    g.fill();
    crayon(g, [[10, 170], [270, 170]], '#555', 8);
    const kart = (x: number, col: string) => {
      g.fillStyle = col;
      g.fillRect(x, 130, 56, 26);
      g.fillStyle = '#222';
      g.beginPath();
      g.arc(x + 10, 160, 9, 0, Math.PI * 2);
      g.arc(x + 46, 160, 9, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#f1c8a5';
      g.beginPath();
      g.arc(x + 28, 118, 12, 0, Math.PI * 2);
      g.fill();
    };
    kart(16, '#2f7de1');
    kart(96, '#e8443a');
    kart(176, '#ffd23f');
    g.fillStyle = '#e8443a';
    g.font = '900 24px "Comic Sans MS", "Chalkboard SE", sans-serif';
    g.textAlign = 'center';
    g.fillText('MY FAMILY RACE!', 140, 205);
  });
  magnet(g, 160, 40, '#E4002B');
  // 2. I <3 CHICAGO with the Bean and skyline
  paper(g, 270, 250, 220, 250, 0.08, () => {
    g.fillStyle = '#41B6E6';
    for (const [bx, bh] of [[20, 90], [52, 140], [84, 70], [120, 160], [158, 110], [186, 80]]) g.fillRect(bx, 200 - bh, 26, bh);
    g.fillStyle = '#222';
    g.fillRect(124, 30, 4, 12);
    g.fillRect(134, 30, 4, 12);
    g.fillStyle = '#b9c2cc';
    g.beginPath();
    g.ellipse(110, 214, 60, 24, 0, Math.PI, 0);
    g.fill();
    g.fillStyle = '#E4002B';
    g.font = '900 30px "Comic Sans MS", "Chalkboard SE", sans-serif';
    g.textAlign = 'center';
    g.fillText('I \u2665 CHICAGO', 110, 42);
  });
  magnet(g, 380, 252, '#41B6E6');
  // 3. Lupin
  paper(g, 30, 300, 220, 200, 0.05, () => {
    g.fillStyle = '#f3e3c3';
    for (const [x, y, r] of [[110, 110, 50], [70, 120, 30], [150, 120, 30], [110, 62, 34], [80, 50, 18], [140, 50, 18]]) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#222';
    g.beginPath();
    g.arc(98, 60, 5, 0, Math.PI * 2);
    g.arc(122, 60, 5, 0, Math.PI * 2);
    g.arc(110, 76, 7, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#2f7de1';
    g.font = '900 30px "Comic Sans MS", "Chalkboard SE", sans-serif';
    g.textAlign = 'center';
    g.fillText('LUPIN', 110, 186);
  });
  magnet(g, 140, 302, '#3ccf6e');
  // Chicago-flag magnets
  for (const [x, y, r] of [[330, 40, 0.1], [400, 120, -0.12], [60, 540, 0.08], [300, 560, -0.05]]) {
    g.save();
    g.translate(x, y);
    g.rotate(r);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(4, 5, 120, 80);
    drawChicagoFlag(g, 0, 0, 120, 80);
    g.restore();
  }
  // letter magnets
  const letters: Array<[string, string]> = [['C', '#E4002B'], ['H', '#2f7de1'], ['I', '#ffd23f'], ['T', '#3ccf6e'], ['O', '#ff8a3d'], ['W', '#2f7de1'], ['N', '#E4002B']];
  g.font = '900 54px "Arial Black", Impact, sans-serif';
  g.textAlign = 'center';
  letters.forEach(([c, col], i) => {
    g.save();
    g.translate(60 + (i % 4) * 62 + (i > 3 ? 30 : 0), 610 + (i > 3 ? 60 : 0));
    g.rotate((i % 3) * 0.12 - 0.12);
    g.fillStyle = col;
    g.fillText(c, 0, 0);
    g.restore();
  });
  // NO KETCHUP magnet (round)
  const kx = 400, ky = 660;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(kx, ky, 72, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#d0121f';
  g.fillRect(kx - 14, ky - 36, 28, 56);
  g.fillRect(kx - 7, ky - 52, 14, 18);
  g.strokeStyle = '#d0121f';
  g.lineWidth = 12;
  g.beginPath();
  g.arc(kx, ky - 8, 50, 0, Math.PI * 2);
  g.moveTo(kx - 36, ky - 44);
  g.lineTo(kx + 36, ky + 28);
  g.stroke();
  g.fillStyle = '#111';
  g.font = '900 22px "Arial Black", Impact, sans-serif';
  g.fillText('NO KETCHUP!', kx, ky + 62);
  // pizza night note (lower door)
  paper(g, 20, h * 0.71, 220, 140, -0.04, () => {
    g.fillStyle = '#E4002B';
    g.font = '900 30px "Comic Sans MS", "Chalkboard SE", sans-serif';
    g.textAlign = 'center';
    g.fillText('FRIDAY =', 110, 50);
    g.fillText('DEEP DISH!', 110, 92);
    g.fillStyle = '#d99a4e';
    g.beginPath();
    g.arc(110, 124, 10, 0, Math.PI * 2);
    g.fill();
  });
  magnet(g, 130, h * 0.71 + 6, '#ffd23f');
}

/** Retro transit poster: an L train curving round the Loop. */
function drawLPoster(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = '#00a1de';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#ffffff';
  g.fillRect(0, h * 0.62, w, h * 0.38);
  // elevated structure + train
  g.fillStyle = '#3f5a3a';
  g.fillRect(0, h * 0.5, w, 12);
  for (let x = 20; x < w; x += 70) g.fillRect(x, h * 0.5, 10, h * 0.12);
  for (let i = 0; i < 3; i++) {
    const x = 20 + i * 118;
    g.fillStyle = '#d4d9df';
    g.fillRect(x, h * 0.5 - 62, 110, 60);
    g.fillStyle = '#c60c30';
    g.fillRect(x, h * 0.5 - 16, 110, 6);
    g.fillStyle = '#2a3446';
    for (let k = 0; k < 4; k++) g.fillRect(x + 8 + k * 26, h * 0.5 - 52, 18, 18);
  }
  drawChicagoSkyline(g, 0, h * 0.5 - 64, w, h * 0.22, new Rng(5), { tones: ['#66c4ec', '#7fd0f0', '#8ad6f2'], dark: '#0b4f73', glass: '#9fdcf5', windows: 'rgba(255,255,255,0.3)' });
  drawText(g, 'RIDE THE L!', w, h * 0.16, { fg: '#ffffff', stroke: '#004a73' });
  g.save();
  g.translate(0, h * 0.66);
  drawText(g, 'CHICAGO', w, h * 0.16, { fg: '#c60c30' });
  g.translate(0, h * 0.16);
  drawText(g, 'RED - BLUE - BROWN - GREEN\nORANGE - PURPLE - PINK', w, h * 0.14, { fg: '#222222', weight: 700 });
  g.restore();
  const lines = ['#c60c30', '#00a1de', '#62361b', '#009b3a', '#f9461c', '#522398', '#e27ea6'];
  lines.forEach((c, i) => {
    g.fillStyle = c;
    g.fillRect((i * w) / 7, h - 14, w / 7 + 1, 14);
  });
}

/** Dish towel printed with the Chicago flag, CHICAGO lettering and a fringe. */
function drawFlagTowel(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#41B6E6';
  g.fillRect(0, 22, w, 14);
  g.fillRect(0, h - 66, w, 14);
  drawChicagoFlag(g, 18, 60, w - 36, (w - 36) * 0.66);
  g.fillStyle = '#E4002B';
  g.font = '900 34px "Arial Black", Impact, sans-serif';
  g.textAlign = 'center';
  g.fillText('CHICAGO', w / 2, h - 90);
  g.fillStyle = '#d9dde2';
  for (let x = 4; x < w; x += 10) g.fillRect(x, h - 26, 4, 26);
}

function drawCookbook(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = '#b0201a';
  g.fillRect(0, 0, w, h);
  for (let y = 0; y < 2; y++) for (let x = 0; x < w / 16; x++) {
    g.fillStyle = (x + y) % 2 ? '#ffffff' : '#b0201a';
    g.fillRect(x * 16, y * 16, 16, 16);
    g.fillRect(x * 16, h - 32 + y * 16, 16, 16);
  }
  drawText(g, 'DEEP DISH', w, 130, { fg: '#ffd23f', stroke: '#5a0d08' });
  g.save();
  g.translate(0, 110);
  drawText(g, 'DELIGHTS', w, 70, { fg: '#ffffff' });
  g.restore();
  // pie illustration
  const cx = w / 2, cy = 300;
  g.fillStyle = '#2a2a2e';
  g.beginPath();
  g.ellipse(cx, cy + 14, 130, 54, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#d99a4e';
  g.beginPath();
  g.ellipse(cx, cy, 120, 48, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#c22d1b';
  g.beginPath();
  g.ellipse(cx, cy - 4, 104, 38, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffd65c';
  g.fillRect(cx + 40, cy - 30, 12, 50);
  g.save();
  g.translate(0, 380);
  drawText(g, 'A CHICAGO FAMILY\nCOOKBOOK', w, 90, { fg: '#ffffff' });
  g.restore();
  g.fillStyle = '#41B6E6';
  g.fillRect(0, 36, w, 8);
}

function drawRadioFace(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = '#f1e6cf';
  g.fillRect(0, 0, w, h);
  // speaker grille
  g.fillStyle = '#3a2a1e';
  g.beginPath();
  g.arc(110, h / 2, 74, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#c9a227';
  for (let y = h / 2 - 60; y <= h / 2 + 60; y += 14) for (let x = 50; x <= 170; x += 14) if ((x - 110) ** 2 + (y - h / 2) ** 2 < 62 ** 2) g.fillRect(x - 2, y - 2, 5, 5);
  // dial
  g.fillStyle = '#1d1d22';
  g.fillRect(210, 30, 280, 70);
  g.fillStyle = '#ffd27a';
  g.font = '700 18px monospace';
  g.textAlign = 'center';
  ['88', '92', '96', '100', '104', '108'].forEach((n, i) => g.fillText(n, 236 + i * 46, 58));
  g.fillStyle = '#E4002B';
  g.fillRect(372, 34, 4, 62);
  g.fillStyle = '#ffd27a';
  g.fillText('CHI-FM  BLUES & SOUL', 350, 90);
  // knobs
  for (const x of [260, 440]) {
    g.fillStyle = '#5a3a26';
    g.beginPath();
    g.arc(x, 145, 26, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#c9a227';
    g.fillRect(x - 2, 121, 4, 18);
  }
  g.fillStyle = '#c8202f';
  g.font = '900 20px "Arial Black", Impact, sans-serif';
  g.fillText('\u266A SWEET HOME \u266B', 350, 152);
}

export function buildKitchen(ctx: SceneryContext): SceneryHandle {
  const { track, group, quality } = ctx;
  const { bag, density, placer } = ctxBits(ctx);
  const field = getField(track);
  const rng = new Rng(1717);
  const def = track.def;
  const lm = (kind: string) => def.landmarks.filter((l) => l.kind === kind);
  const updaters: Array<(dt: number, t: number) => void> = [];
  const kit = new Kit(bag, group, { lit: 0, snow: false, quality });
  const tod = timeOfDay(group);
  /** second atlas for the big wall / fridge art (the kit's own atlas holds the prop labels) */
  const wallArt = new SignAtlas(2048);
  // keep the Chicago food / props clear of the scattered cutlery and cereal (they are built later)
  const PROP_R: Record<string, number> = { giardiniera: 1.3, deepDish: 1.4, italianBeef: 0.9, chicagoDog: 0.75, popcornTin: 1.9, radio: 1.6, cookbook: 1.6 };
  for (const l of def.landmarks) if (PROP_R[l.kind]) placer.reserve(l.x, l.z, PROP_R[l.kind] * (l.scale ?? 12) + 4);
  const vc = vcMat(bag, { roughness: 0.55 });
  const vcShiny = vcMat(bag, { roughness: 0.22, metalness: 0.2 });
  const b = field.bounds;
  const sx0 = b.minX - 60, sx1 = b.maxX + 60, sz0 = b.minZ - 60, sz1 = b.maxZ + 60; // counter slab extents
  const cx = (sx0 + sx1) / 2, cz = (sz0 + sz1) / 2;
  const parts: P = [];
  const shiny: P = [];
  const addMesh = (p: P, mat: THREE.Material, cast = true) => {
    if (!p.length) return;
    const m = new THREE.Mesh(bag.add(mergeColored(p)), mat);
    m.castShadow = cast;
    m.receiveShadow = true;
    group.add(m);
  };

  /* ------------------------------------------------ floor + room */
  {
    const ft = bag.add(tileTexture('#f2efe6', '#c9c2b4', 2, 0.03, 4));
    ft.repeat.set(160, 160);
    // checkerboard floor tiles
    const floorTex = bag.add(canvasTexture(128, 128, (g, w, h) => {
      g.fillStyle = '#f4efe3';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#2f3d5c';
      g.fillRect(0, 0, w / 2, h / 2);
      g.fillRect(w / 2, h / 2, w / 2, h / 2);
      g.fillStyle = 'rgba(0,0,0,0.15)';
      g.fillRect(0, 0, w, 2);
      g.fillRect(0, 0, 2, h);
    }));
    floorTex.repeat.set(70, 70);
    const floor = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(4000, 4000)), bag.add(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.4 })));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, FLOOR_Y, cz);
    floor.receiveShadow = true;
    group.add(floor);
    void ft;
    // walls of the room with a tiled backsplash, a window and upper cabinets
    const R = 520;
    const wallTex = bag.add(canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#fbe7b5';
      g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,0.4)';
      for (let x = 0; x < w; x += 32) g.fillRect(x, 0, 12, h);
    }));
    wallTex.repeat.set(30, 6);
    const wallMat = bag.add(new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9 }));
    const tiles = bag.add(tileTexture('#9fd3e6', '#ffffff', 4, 0.05, 6));
    tiles.repeat.set(40, 6);
    const tileMat = bag.add(new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.3 }));
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const wall = new THREE.Group();
      const w = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(R * 2.4, 900)), wallMat);
      w.position.set(0, 390, 0);
      wall.add(w);
      const sp = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(R * 2.4, 110)), tileMat);
      sp.position.set(0, 55, 0.5);
      wall.add(sp);
      wall.position.set(cx + Math.sin(a) * -R, 0, cz + Math.cos(a) * -R);
      wall.rotation.y = a;
      group.add(wall);
    }
    // window on the north wall with bright daylight
    // ...looking out at the skyline, with an L train rattling past now and then
    const viewTex = bag.add(windowViewTexture(tod));
    const win = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(320, 200)), bag.add(new THREE.MeshBasicMaterial({ map: viewTex, toneMapped: false, fog: false })));
    win.position.set(cx + 60, 230, cz + R - 1);
    win.rotation.y = Math.PI;
    win.name = 'windowView';
    group.add(win);
    const trainTex = bag.add(lTrainTexture());
    const train = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(320, 200)), bag.add(new THREE.MeshBasicMaterial({ map: trainTex, alphaTest: 0.5, toneMapped: false, fog: false })));
    train.position.set(cx + 60, 230, cz + R - 1.6);
    train.rotation.y = Math.PI;
    train.name = 'windowTrain';
    group.add(train);
    updaters.push((_dt, t) => {
      const c = (t % 15) / 9;
      trainTex.offset.x = c < 1 ? 0.95 - c * 1.9 : -1;
    });
    // SWEET HOME CHICAGO neon on the wall beside the window, a Chicago flag on the east wall
    const neon = kit.neon.text('SWEET HOME\nCHICAGO', 512, 210, { bg: '#1c1430', fg: '#ff6fb0', bulbs: '#ffe066', stroke: '#41B6E6' });
    kit.solid.push([new THREE.BoxGeometry(236, 100, 4), '#2a1f3d', M.t(cx - 245, 185, cz + R - 3)]);
    kit.neon.quad(neon, 228, 94, M.trs(cx - 245, 185, cz + R - 5.2, 0, Math.PI, 0));
    const flag = wallArt.draw(384, 256, (g, w, h) => drawChicagoFlag(g, 0, 0, w, h), 'wallFlag');
    wallArt.quad(flag, 180, 120, M.trs(cx + R - 2, 260, cz + 60, 0, -Math.PI / 2, 0));
    // "Greetings from Chicago" poster on the south wall, Chicago-flag bunting on the west wall
    const poster = wallArt.draw(512, 384, (g, w, hh) => drawGreetingsPoster(g, w, hh), 'greetings');
    kit.solid.push([new THREE.BoxGeometry(236, 178, 3), '#8a5a2b', M.t(cx - 60, 118, cz - R + 2)]);
    wallArt.quad(poster, 224, 168, M.t(cx - 60, 118, cz - R + 3.6));
    const lPoster = wallArt.draw(384, 512, (g, w, hh) => drawLPoster(g, w, hh), 'lPoster');
    kit.solid.push([new THREE.BoxGeometry(132, 172, 3), '#2b2b30', M.t(cx + 190, 116, cz - R + 2)]);
    wallArt.quad(lPoster, 124, 165, M.t(cx + 190, 116, cz - R + 3.6));
    const pennant = wallArt.draw(128, 128, (g, w, hh) => {
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(w, 0);
      g.lineTo(w / 2, hh);
      g.closePath();
      g.fill();
      g.fillStyle = '#41B6E6';
      g.fillRect(0, hh * 0.08, w, hh * 0.1);
      g.fillStyle = '#E4002B';
      star(g, w / 2, hh * 0.38, w * 0.16, w * 0.08, 6);
    }, 'pennant');
    for (let i = 0; i < 18; i++) {
      const z = cz - 230 + i * 27;
      const sag = Math.sin((i / 17) * Math.PI) * 18;
      wallArt.quad(pennant, 22, 22, M.trs(cx - R + 2, 236 - sag, z, 0, Math.PI / 2, 0));
    }
    kit.steel.push([new THREE.BoxGeometry(0.6, 0.6, 470), '#f4f4f4', M.t(cx - R + 1.6, 247 - 9, cz + 5)]);
    for (const dz of [-92, 92]) kit.solid.push([new THREE.CylinderGeometry(2, 2, 6, 8).rotateZ(Math.PI / 2), '#c9a227', M.t(cx + R - 3, 322, cz + 60 + dz)]);
    kit.solid.push([new THREE.CylinderGeometry(1.2, 1.2, 190, 8).rotateX(Math.PI / 2), '#8a5a2b', M.t(cx + R - 4, 322, cz + 60)]);
    const wparts: P = [
      [new THREE.BoxGeometry(340, 14, 12), '#ffffff', M.t(cx + 60, 125, cz + R - 4)],
      [new THREE.BoxGeometry(340, 14, 12), '#ffffff', M.t(cx + 60, 335, cz + R - 4)],
      [new THREE.BoxGeometry(14, 220, 12), '#ffffff', M.t(cx - 103, 230, cz + R - 4)],
      [new THREE.BoxGeometry(14, 220, 12), '#ffffff', M.t(cx + 223, 230, cz + R - 4)],
      [new THREE.BoxGeometry(10, 200, 8), '#ffffff', M.t(cx + 60, 230, cz + R - 4)],
      // upper cabinets on the west wall
      [new THREE.BoxGeometry(70, 140, 500), '#7fb3d9', M.t(cx - R + 35, 330, cz)],
      [new THREE.BoxGeometry(72, 6, 502), '#5d8fb8', M.t(cx - R + 35, 258, cz)],
    ];
    for (let z = -220; z <= 220; z += 110) wparts.push([new THREE.BoxGeometry(4, 120, 96), '#9cc7e6', M.t(cx - R + 71, 330, cz + z)]);
    for (let z = -220; z <= 220; z += 110) wparts.push([new THREE.BoxGeometry(6, 26, 6), '#c9a227', M.t(cx - R + 75, 290, cz + z + 30)]);
    // curtains
    wparts.push([new THREE.BoxGeometry(70, 240, 6), '#ff8fab', M.t(cx - 130, 230, cz + R - 12)]);
    wparts.push([new THREE.BoxGeometry(70, 240, 6), '#ff8fab', M.t(cx + 250, 230, cz + R - 12)]);
    addMesh(wparts, vc, false);
  }

  /* ------------------------------------------------ table legs + counter base */
  {
    const ch = field.channels[0];
    const legs: P = [];
    if (ch) {
      // table occupies x > channel; legs at its corners
      const tx0 = ch.cx + ch.halfWidth + 30, tx1 = sx1 - 25;
      for (const x of [tx0, tx1]) for (const z of [sz0 + 25, sz1 - 25]) {
        legs.push([new THREE.CylinderGeometry(9, 6, -FLOOR_Y, 12), '#b9773f', M.t(x, FLOOR_Y / 2, z)]);
      }
    }
    addMesh(legs, vc);
  }

  /* ------------------------------------------------ cereal boxes */
  const cereal = [
    ['WINDY CITY OS', '#e8443a', '#ffd23f'],
    ['CHOCO BEANS', '#5a2f1c', '#ff9fd0'],
    ['L-TRAIN LOOPS', '#2f7de1', '#ffffff'],
    ['LAKE FLAKES', '#ffb302', '#1d3f73'],
  ] as const;
  lm('cerealBox').forEach((c, i) => {
    const [name, bg, fg] = cereal[i % cereal.length];
    const front = bag.add(cerealTexture(name, bg, fg, 50 + i));
    const side = bag.add(new THREE.MeshStandardMaterial({ color: bg, roughness: 0.6 }));
    const face = bag.add(new THREE.MeshStandardMaterial({ map: front, roughness: 0.5 }));
    const m = new THREE.Mesh(bag.add(new THREE.BoxGeometry(30, 46, 10)), [side, side, side, side, face, face]);
    m.position.set(c.x, field.height(c.x, c.z) + 23, c.z);
    m.rotation.y = c.rot ?? 0;
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    placer.reserve(c.x, c.z, 18);
  });

  /* ------------------------------------------------ toaster with popping toast */
  for (const c of lm('toaster')) {
    const y = field.height(c.x, c.z);
    shiny.push([new THREE.BoxGeometry(34, 22, 20), '#dfe5ec', M.t(c.x, y + 11, c.z)]);
    shiny.push([new THREE.CylinderGeometry(10, 10, 34, 16, 1).rotateZ(Math.PI / 2), '#dfe5ec', M.trs(c.x, y + 22, c.z, 0, 0, 0, 1, 0.25, 1)]);
    parts.push([new THREE.BoxGeometry(26, 0.6, 3), '#222', M.t(c.x, y + 24.6, c.z - 4)]);
    parts.push([new THREE.BoxGeometry(26, 0.6, 3), '#222', M.t(c.x, y + 24.6, c.z + 4)]);
    parts.push([new THREE.BoxGeometry(3, 6, 2), '#222', M.t(c.x + 18, y + 14, c.z)]);
    placer.reserve(c.x, c.z, 22);
    const toastGeo = bag.add(mergeColored([
      [new THREE.BoxGeometry(22, 18, 2), '#e3a05a', M.t(0, 0, 0)],
      [new THREE.BoxGeometry(18, 15, 2.2), '#f7d6a0', M.t(0, -1, 0)],
    ]));
    const toast = new THREE.InstancedMesh(toastGeo, vc, 2);
    toast.castShadow = true;
    group.add(toast);
    updaters.push((_dt, t) => {
      for (let i = 0; i < 2; i++) {
        const ph = (t * 0.5 + i * 0.13) % 3;
        const pop = ph < 0.6 ? Math.sin((ph / 0.6) * Math.PI) * 26 : 0;
        setInstance(toast, i, c.x, y + 22 + pop, c.z + (i ? 4 : -4), 0, 0, 0, 1);
      }
      toast.instanceMatrix.needsUpdate = true;
    });
  }

  /* ------------------------------------------------ fridge (stands on the floor): magnets, kid art, flag towel */
  for (const c of lm('fridge')) {
    const h = 260;
    const yaw = c.rot ?? Math.PI; // front (+Z local) faces the counter
    const F = M.trs(c.x, FLOOR_Y, c.z, 0, yaw, 0);
    const at = (lx: number, ly: number, lz: number, rx = 0, ry = 0, rz = 0) => F.clone().multiply(M.trs(lx, ly, lz, rx, ry, rz));
    shiny.push([new THREE.BoxGeometry(80, h, 70), '#e9eef3', at(0, h / 2, 0)]);
    parts.push([new THREE.BoxGeometry(80.5, 2, 70.5), '#9aa5b1', at(0, h * 0.62, 0)]);
    parts.push([new THREE.BoxGeometry(4, 50, 4), '#9aa5b1', at(-33, h * 0.78, 37)]);
    // lower door: horizontal bar handle with the dish towel folded over it
    parts.push([new THREE.BoxGeometry(46, 3, 3), '#9aa5b1', at(14, 116, 39.5)]);
    for (const hx of [-7, 35]) parts.push([new THREE.BoxGeometry(3, 3, 5), '#9aa5b1', at(hx, 116, 37.5)]);
    const art = wallArt.draw(512, 1024, (g, w, hh) => drawFridgeArt(g, w, hh), 'fridgeArt');
    wallArt.quad(art, 74, 148, at(0, 184, 35.4));
    const towel = wallArt.draw(256, 384, (g, w, hh) => drawFlagTowel(g, w, hh), 'flagTowel');
    wallArt.quad(towel, 30, 45, at(18, 116 - 22, 41.8, -0.06, 0, 0.03));
    wallArt.quad(towel, 30, 6, at(18, 117.6, 39.5, -Math.PI / 2, 0, 0));
    placer.reserve(c.x, c.z, 55);
  }

  /* ------------------------------------------------ stove top with glowing burners + frying pan & egg */
  const burnerMat = bag.add(new THREE.MeshStandardMaterial({ color: '#330000', emissive: '#ff4a1a', emissiveIntensity: 1.2, roughness: 0.5 }));
  for (const c of lm('stove')) {
    const y = field.height(c.x, c.z);
    parts.push([new THREE.BoxGeometry(70, 1.2, 54), '#1c1d22', M.t(c.x, y + 0.6, c.z)]);
    const rings = new THREE.Mesh(bag.add(mergeColored([
      ...[[-17, -13], [17, -13], [-17, 13], [17, 13]].flatMap(([dx, dz]) => [
        [new THREE.TorusGeometry(9, 0.9, 6, 32).rotateX(Math.PI / 2), '#ffffff', M.t(c.x + dx, y + 1.3, c.z + dz)] as [THREE.BufferGeometry, string, THREE.Matrix4],
        [new THREE.TorusGeometry(5, 0.8, 6, 24).rotateX(Math.PI / 2), '#ffffff', M.t(c.x + dx, y + 1.3, c.z + dz)] as [THREE.BufferGeometry, string, THREE.Matrix4],
      ]),
    ])), burnerMat);
    group.add(rings);
    updaters.push((_dt, t) => {
      burnerMat.emissiveIntensity = 1.0 + Math.sin(t * 3) * 0.35;
    });
    // pan with an egg on the front-left burner
    shiny.push([new THREE.CylinderGeometry(12, 10, 3, 24), '#3b3f47', M.t(c.x - 17, y + 2.8, c.z + 13)]);
    shiny.push([new THREE.BoxGeometry(24, 1.6, 3), '#3b3f47', M.trs(c.x - 38, y + 4, c.z + 13, 0, 0, 0.12)]);
    parts.push([new THREE.CylinderGeometry(7, 7, 0.6, 20), '#ffffff', M.trs(c.x - 16, y + 4.4, c.z + 12, 0, 0, 0, 1, 1, 0.8)]);
    parts.push([new THREE.SphereGeometry(3, 12, 8), '#ffb000', M.trs(c.x - 15, y + 4.8, c.z + 12, 0, 0, 0, 1, 0.5, 1)]);
    placer.reserve(c.x, c.z, 40);
  }

  /* ------------------------------------------------ plates with pancakes, mug, milk carton */
  for (const c of lm('plate')) {
    const y = field.height(c.x, c.z);
    parts.push([new THREE.CylinderGeometry(18, 14, 2, 32), '#ffffff', M.t(c.x, y + 1, c.z)]);
    parts.push([new THREE.TorusGeometry(16.5, 0.6, 6, 40).rotateX(Math.PI / 2), '#2f7de1', M.t(c.x, y + 2, c.z)]);
    for (let k = 0; k < 4; k++) parts.push([new THREE.CylinderGeometry(10 - k * 0.3, 10 - k * 0.3, 1.6, 24), k % 2 ? '#d9934a' : '#e7a75e', M.t(c.x + rng.range(-0.6, 0.6), y + 2.8 + k * 1.6, c.z + rng.range(-0.6, 0.6))]);
    parts.push([new THREE.BoxGeometry(4, 1.6, 4), '#fff2a8', M.t(c.x, y + 9.5, c.z)]);
    parts.push([new THREE.CylinderGeometry(10.2, 10.2, 0.3, 24), '#8a4a10', M.t(c.x, y + 9.0, c.z)]);
    placer.reserve(c.x, c.z, 20);
  }
  for (const c of lm('mug')) {
    const y = field.height(c.x, c.z);
    parts.push([new THREE.CylinderGeometry(8, 7.5, 16, 24), '#ff7a3d', M.t(c.x, y + 8, c.z)]);
    parts.push([new THREE.CylinderGeometry(7.2, 7.2, 0.5, 24), '#4a2a14', M.t(c.x, y + 14.5, c.z)]);
    parts.push([new THREE.TorusGeometry(4.5, 1.3, 8, 16), '#ff7a3d', M.t(c.x + 9, y + 8, c.z)]);
    placer.reserve(c.x, c.z, 14);
  }
  for (const c of lm('milkCarton')) {
    const y = field.height(c.x, c.z);
    const tex = bag.add(labelTexture('MILK', '#ffffff', '#2f7de1'));
    const mat = bag.add(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
    const box = new THREE.Mesh(bag.add(new THREE.BoxGeometry(14, 30, 14)), mat);
    box.position.set(c.x, y + 15, c.z);
    box.rotation.y = 0.4;
    box.castShadow = true;
    group.add(box);
    parts.push([new THREE.ConeGeometry(10, 8, 4).rotateY(Math.PI / 4), '#e8f2ff', M.trs(c.x, y + 34, c.z, 0, 0.4, 0, 1, 1, 1)]);
    placer.reserve(c.x, c.z, 12);
  }

  /* ------------------------------------------------ fruit bowl */
  for (const c of lm('fruitBowl')) {
    const y = field.height(c.x, c.z);
    parts.push([new THREE.SphereGeometry(13, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), '#2fb5a8', M.trs(c.x, y + 11, c.z, 0, 0, 0, 1, 0.85, 1)]);
    parts.push([new THREE.CylinderGeometry(6, 7, 1.5, 20), '#2fb5a8', M.t(c.x, y + 0.75, c.z)]);
    const fruit = ['#ff8a1a', '#e8443a', '#ffb000', '#7ccf3a', '#ff8a1a', '#e8443a'];
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      parts.push([new THREE.SphereGeometry(5, 14, 10), fruit[i % fruit.length], M.t(c.x + Math.cos(a) * 6, y + 13 + (i % 3), c.z + Math.sin(a) * 6)]);
    }
    parts.push([new THREE.TorusGeometry(10, 2.2, 8, 20, Math.PI * 0.8), '#ffe14d', M.trs(c.x, y + 17, c.z, 0.4, 0.3, 0.3)]);
    placer.reserve(c.x, c.z, 15);
  }

  /* ------------------------------------------------ chairs around the table */
  for (const c of lm('chair')) {
    const seatY = FLOOR_Y + 36;
    const face = Math.atan2(cx - c.x, cz - c.z);
    const m = M.trs(c.x, 0, c.z, 0, face, 0);
    const p = (g: THREE.BufferGeometry, col: string, local: THREE.Matrix4) => parts.push([g, col, m.clone().multiply(local)]);
    p(new THREE.BoxGeometry(40, 4, 40), '#c0392b', M.t(0, seatY, 0));
    for (const [dx, dz] of [[-17, -17], [17, -17], [-17, 17], [17, 17]]) p(new THREE.BoxGeometry(3, 36, 3), '#8a5a2b', M.t(dx, FLOOR_Y + 18, dz));
    p(new THREE.BoxGeometry(40, 50, 3), '#8a5a2b', M.t(0, seatY + 27, -19));
    p(new THREE.BoxGeometry(34, 8, 3.4), '#c0392b', M.t(0, seatY + 40, -19));
  }

  /* ------------------------------------------------ cutting-board bridge + giant wooden spoon */
  for (const c of lm('spoonBridge')) {
    const smp = (() => {
      let best = track.sampleAt(0, 0), bd = Infinity;
      for (const s of track.paths[0].samples) {
        const d = (s.x - c.x) ** 2 + (s.z - c.z) ** 2;
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
      return best;
    })();
    const yaw = Math.atan2(smp.tx, smp.tz);
    const wd = smp.halfWidth + def.shoulder + 2;
    parts.push([new THREE.BoxGeometry(wd * 2, 3, 70), '#c98a4b', M.trs(smp.x, smp.y - 1.8, smp.z, 0, yaw, 0)]);
    parts.push([new THREE.BoxGeometry(wd * 2 + 0.2, 0.6, 70.2), '#a86c35', M.trs(smp.x, smp.y - 2.6, smp.z, 0, yaw, 0)]);
    // a wooden spoon lying across the aisle beside the board
    const sx = smp.x + smp.nx * (wd + 30), sz = smp.z + smp.nz * (wd + 30);
    parts.push([new THREE.BoxGeometry(7, 2, 110), '#d79a5a', M.trs(sx, smp.y + 0.2, sz, 0, yaw, 0)]);
    parts.push([new THREE.SphereGeometry(13, 18, 10), '#d79a5a', M.trs(sx + smp.tx * 60, smp.y + 1.5, sz + smp.tz * 60, 0, yaw, 0, 1, 0.25, 1.4)]);
  }

  /* ------------------------------------------------ napkin tunnel over the shortcut */
  {
    const sc = track.paths[1];
    if (sc) {
      const mid = track.sampleAt(1, sc.length * 0.5);
      const r = mid.halfWidth + def.shoulder + 1.5;
      const tunnelTex = bag.add(canvasTexture(128, 128, (g, w, h) => {
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#ff9fc4';
        for (let x = 0; x < w; x += 32) g.fillRect(x, 0, 14, h);
        g.fillStyle = 'rgba(0,0,0,0.06)';
        for (let y = 0; y < h; y += 8) g.fillRect(0, y, w, 1);
      }));
      tunnelTex.repeat.set(6, 2);
      const tun = new THREE.Mesh(bag.add(new THREE.CylinderGeometry(r, r, 40, 32, 1, true, 0, Math.PI).rotateZ(Math.PI / 2)), bag.add(new THREE.MeshStandardMaterial({ map: tunnelTex, side: THREE.DoubleSide, roughness: 0.9 })));
      tun.position.set(mid.x, mid.y, mid.z);
      tun.rotation.y = Math.atan2(mid.tx, mid.tz) + Math.PI / 2;
      tun.castShadow = true;
      group.add(tun);
      placer.reserve(mid.x, mid.z, 24);
    }
  }

  /* ------------------------------------------------ utensils, salt & pepper, sugar bowl */
  {
    const spots = placer.scatter(Math.round(8 * density + 2), { minX: sx0 + 30, maxX: sx1 - 30, minZ: sz0 + 30, maxZ: sz1 - 30 }, 14, 6);
    spots.forEach((s, i) => {
      const m = M.trs(s.x, s.y, s.z, 0, s.yaw, 0);
      const p = (g: THREE.BufferGeometry, col: string, local: THREE.Matrix4) => shiny.push([g, col, m.clone().multiply(local)]);
      const kind = i % 4;
      if (kind === 0) {
        // fork
        p(new THREE.BoxGeometry(4, 1.2, 50), '#d7dde5', M.t(0, 0.6, -10));
        p(new THREE.BoxGeometry(9, 1.2, 8), '#d7dde5', M.t(0, 0.6, 18));
        for (let k = -1.5; k <= 1.5; k++) p(new THREE.BoxGeometry(1.2, 1.2, 12), '#d7dde5', M.t(k * 2.6, 0.6, 28));
      } else if (kind === 1) {
        // spoon
        p(new THREE.BoxGeometry(4, 1.2, 50), '#d7dde5', M.t(0, 0.6, -10));
        p(new THREE.SphereGeometry(8, 16, 8), '#d7dde5', M.trs(0, 1.2, 22, 0, 0, 0, 0.8, 0.2, 1.2));
      } else if (kind === 2) {
        // butter knife
        p(new THREE.BoxGeometry(4, 1.6, 30), '#5a3a26', M.t(0, 0.8, -15));
        p(new THREE.BoxGeometry(6, 0.8, 34), '#d7dde5', M.t(0, 0.4, 16));
      } else {
        // salt & pepper
        p(new THREE.CylinderGeometry(4, 4.5, 14, 16), '#ffffff', M.t(-5, 7, 0));
        p(new THREE.SphereGeometry(4, 12, 8), '#c0c6ce', M.t(-5, 14, 0));
        p(new THREE.CylinderGeometry(4, 4.5, 14, 16), '#3b3f47', M.t(5, 7, 0));
        p(new THREE.SphereGeometry(4, 12, 8), '#c0c6ce', M.t(5, 14, 0));
      }
    });
  }

  /* ------------------------------------------------ hanging pendant lamp above the table */
  {
    const lx = (field.channels[0]?.cx ?? 0) + 160, lz = 0;
    shiny.push([new THREE.CylinderGeometry(0.6, 0.6, 300, 6), '#333', M.t(lx, 330, lz)]);
    shiny.push([new THREE.ConeGeometry(30, 26, 24, 1, true), '#ffcc33', M.t(lx, 170, lz)]);
    const bulb = new THREE.Mesh(bag.add(new THREE.SphereGeometry(8, 16, 12)), bag.add(new THREE.MeshBasicMaterial({ color: '#fff4c2', toneMapped: false })));
    bulb.position.set(lx, 158, lz);
    group.add(bulb);
  }

  /* ------------------------------------------------ cereal loops + blueberries scattered */
  {
    const loopGeo = bag.add(new THREE.TorusGeometry(1.2, 0.55, 6, 12).rotateX(Math.PI / 2).translate(0, 0.55, 0));
    const loops = new Batch(loopGeo, bag.add(new THREE.MeshStandardMaterial({ roughness: 0.7 })), { cast: false, name: 'cerealLoops' });
    const cols = ['#ff5fa2', '#ffd23f', '#3ccf6e', '#ff8a3d', '#8a5cf0', '#e8443a'];
    const rect = { minX: sx0 + 5, maxX: sx1 - 5, minZ: sz0 + 5, maxZ: sz1 - 5 };
    for (const s of placer.scatter(Math.round(420 * density), rect, 1.3, 1.5, Infinity, 6, false)) {
      if (field.channelAt(s.x, s.z)) continue;
      loops.add(s.x, s.y, s.z, s.yaw, 1, 1, 1, rng.pick(cols), rng.range(-0.15, 0.15));
    }
    loops.build(group);
    const berries = new Batch(bag.add(new THREE.SphereGeometry(1.25, 10, 8).translate(0, 1.1, 0)), bag.add(new THREE.MeshStandardMaterial({ color: '#5566c4', roughness: 0.35 })), { cast: false });
    for (const s of placer.scatter(Math.round(80 * density), rect, 1.7, 1.5, Infinity, 6, false)) if (!field.channelAt(s.x, s.z)) berries.add(s.x, s.y, s.z, 0);
    berries.build(group);
    // sugar cubes
    const sugar = new Batch(bag.add(new THREE.BoxGeometry(3, 3, 3).translate(0, 1.5, 0)), bag.add(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 })), {});
    for (const s of placer.scatter(Math.round(40 * density), rect, 2.2, 2, Infinity, 6, false)) if (!field.channelAt(s.x, s.z)) sugar.add(s.x, s.y, s.z, s.yaw);
    sugar.build(group);
  }

  /* ------------------------------------------------ steam from the pan (particles) */
  {
    const st = lm('stove')[0];
    if (st) {
      const N = quality === 'low' ? 40 : 90;
      const g = new THREE.BufferGeometry();
      const seeds = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) seeds.set([rng.range(-6, 6), rng.next(), rng.range(-6, 6)], i * 3);
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 20, 0), 60);
      bag.add(g);
      const timeU = { value: 0 };
      const mat = bag.add(new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uTime: timeU, uMap: { value: bag.add(dotTexture()) } },
        vertexShader: `attribute vec3 aSeed; uniform float uTime; varying float vA;
          void main(){ float l = fract(uTime*0.25 + aSeed.y); vec3 p = vec3(aSeed.x + sin(l*6.0+aSeed.z)*3.0, l*45.0, aSeed.z);
          vA = sin(l*3.14159); vec4 mv = modelViewMatrix*vec4(p,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = (14.0 + l*30.0) * (300.0 / -mv.z); }`,
        fragmentShader: `uniform sampler2D uMap; varying float vA; void main(){ float a = texture2D(uMap, gl_PointCoord).a; gl_FragColor = vec4(1.0,1.0,1.0, a*vA*0.35); }`,
      }));
      const pts = new THREE.Points(g, mat);
      pts.position.set(st.x - 17, field.height(st.x, st.z) + 5, st.z + 13);
      group.add(pts);
      updaters.push((_dt, t) => (timeU.value = t));
    }
  }

  /* ------------------------------------------------ Chicago food on the counter + table */
  const onTop = (x: number, z: number, r: number) => {
    placer.reserve(x, z, r);
    return field.height(x, z);
  };
  {
    const p = lm('deepDish')[0] ?? { x: -125, z: 132, rot: 2.4, scale: 13 };
    deepDishPizza(kit, p.x, onTop(p.x, p.z, (p.scale ?? 13) * 1.3), p.z, p.rot ?? 0, p.scale ?? 13, undefined, p.y ?? 0.32);
  }
  for (const p of lm('italianBeef')) italianBeef(kit, p.x, onTop(p.x, p.z, (p.scale ?? 26) * 0.8), p.z, p.rot ?? 0, p.scale ?? 26);
  for (const p of lm('chicagoDog')) chicagoHotDog(kit, p.x, onTop(p.x, p.z, (p.scale ?? 24) * 0.7), p.z, p.rot ?? 0, p.scale ?? 24);
  for (const p of lm('giardiniera')) giardinieraJar(kit, p.x, onTop(p.x, p.z, (p.scale ?? 10) * 1.3), p.z, p.rot ?? 0, p.scale ?? 10);
  for (const p of lm('popcornTin')) popcornTin(kit, p.x, onTop(p.x, p.z, (p.scale ?? 12) * 1.2), p.z, p.rot ?? 0, p.scale ?? 12);

  /* ------------------------------------------------ deep-dish cookbook on a stand */
  for (const p of lm('cookbook')) {
    const y = onTop(p.x, p.z, 18);
    const B = M.trs(p.x, y, p.z, 0, p.rot ?? 0, 0);
    const at = (lx: number, ly: number, lz: number, rx = 0) => B.clone().multiply(M.trs(lx, ly, lz, rx, 0, 0));
    const tilt = -0.28;
    kit.solid.push([new THREE.BoxGeometry(32, 42, 5), '#f4ecd8', at(0, 22, 0, tilt)]);
    kit.solid.push([new THREE.BoxGeometry(33, 43, 1.2), '#b0201a', at(0, 22.2, 2.9, tilt)]);
    kit.solid.push([new THREE.BoxGeometry(2.5, 43, 6.4), '#8a1812', at(-16.6, 22.2, 0.3, tilt)]);
    const cover = kit.paint.draw(384, 512, (g, w, hh) => drawCookbook(g, w, hh), 'cookbook');
    kit.paint.quad(cover, 31, 41.3, at(0, 22.2, 3.55, tilt));
    // wooden stand
    kit.solid.push([new THREE.BoxGeometry(36, 2, 8), '#a8733f', at(0, 1, 2)]);
    kit.solid.push([new THREE.BoxGeometry(3, 34, 2), '#a8733f', at(0, 16, -6, 0.38)]);
    kit.solid.push([new THREE.BoxGeometry(34, 3, 2), '#8a5a2b', at(0, 2.5, 5.5)]);
  }

  /* ------------------------------------------------ retro radio playing (notes float out) */
  for (const p of lm('radio')) {
    const y = onTop(p.x, p.z, 18);
    const B = M.trs(p.x, y, p.z, 0, p.rot ?? 0, 0);
    const at = (lx: number, ly: number, lz: number, rx = 0, ry = 0, rz = 0) => B.clone().multiply(M.trs(lx, ly, lz, rx, ry, rz));
    kit.gloss.push([new THREE.BoxGeometry(30, 16, 11), '#c8202f', at(0, 8.6, 0)]);
    for (const ex of [-15, 15]) kit.gloss.push([new THREE.CylinderGeometry(8, 8, 11, 16, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(ex < 0 ? Math.PI / 2 : -Math.PI / 2), '#c8202f', at(ex, 8.6, 0, 0, 0, 0)]);
    kit.solid.push([new THREE.BoxGeometry(46, 1, 11.4), '#e9dcc4', at(0, 0.5, 0)]);
    const face = kit.paint.draw(512, 192, (g, w, hh) => drawRadioFace(g, w, hh), 'radioFace');
    kit.paint.quad(face, 42, 15.7, at(0, 8.6, 5.65));
    kit.gloss.push([new THREE.TorusGeometry(10, 0.9, 6, 18, Math.PI), '#d8dde3', at(0, 16.6, 0)]);
    beam(kit.steel, [12, 16.6, -3], [26, 44, -6], 0.5, '#d8dde3', B);
    kit.glow.push([new THREE.SphereGeometry(0.9, 8, 6), '#ffd23f', at(26, 44, -6)]);
    // floating music notes
    const noteGeo = bag.add(mergeColored([
      [new THREE.SphereGeometry(1.4, 10, 8), '#ffffff', M.trs(0, 0, 0, 0, 0, 0.5, 1.2, 0.85, 0.6)],
      [new THREE.BoxGeometry(0.45, 6, 0.45), '#ffffff', M.t(1.35, 3, 0)],
      [new THREE.BoxGeometry(2.2, 0.8, 0.45), '#ffffff', M.trs(2.3, 5.6, 0, 0, 0, -0.5)],
    ]));
    const N = quality === 'low' ? 5 : 9;
    const notes = new THREE.InstancedMesh(noteGeo, bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, emissive: '#331a33' })), N);
    const nc = ['#ff5fa2', '#41B6E6', '#ffd23f', '#3ccf6e', '#E4002B', '#b26bff'];
    for (let i = 0; i < N; i++) notes.setColorAt(i, new THREE.Color(nc[i % nc.length]));
    notes.frustumCulled = false;
    notes.name = 'radioNotes';
    group.add(notes);
    const yaw = p.rot ?? 0;
    updaters.push((_dt, t) => {
      for (let i = 0; i < N; i++) {
        const c = (t * 0.22 + i / N) % 1;
        const side = i % 2 ? 1 : -1;
        const lx = side * (8 + c * 20) + Math.sin(t * 2 + i) * 3, ly = 18 + c * 46, lz = 4 + c * 10;
        const sc = Math.sin(c * Math.PI) * 1.2;
        setInstance(notes, i, p.x + Math.cos(yaw) * lx + Math.sin(yaw) * lz, y + ly, p.z - Math.sin(yaw) * lx + Math.cos(yaw) * lz, 0, yaw + Math.sin(t * 3 + i) * 0.5, Math.sin(t * 2.5 + i) * 0.3, Math.max(0.01, sc));
      }
      notes.instanceMatrix.needsUpdate = true;
    });
  }

  addMesh(parts, vc);
  addMesh(shiny, vcShiny);
  kit.flush();
  wallArt.build(bag, group, false, 0.22);
  trimShadows(group, quality);

  return {
    update(dt: number, time: number) {
      for (const u of updaters) u(dt, time);
      kit.update(dt, time);
    },
    dispose() {
      disposeGroup(group);
      bag.dispose();
    },
  };
}
