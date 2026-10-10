import type * as THREE from 'three';
import type { CharacterId } from '../../sim/types';
import type { LiveryId } from './liveries';
import { canvasTex, drawEmblem, type EmblemKind } from './textures';

/**
 * Livery decals (transparent canvas textures): a hood graphic and a side graphic per livery.
 * Hood canvases are sized to each kart's hood plane so badges stay round.
 * Hood canvas: x = across the kart, top row = towards the driver, bottom row = the nose.
 */

type Ctx = CanvasRenderingContext2D;

const STAR = 'M50,0L60.5,31.8L93.3,25L71,50L93.3,75L60.5,68.2L50,100L39.5,68.2L6.7,75L29,50L6.7,25L39.5,31.8Z';
const INITIAL: Record<CharacterId, string> = { dad: 'D', mom: 'M', bro1: '1', bro2: '2', lupin: 'L', grandma: 'G' };

function star(ctx: Ctx, cx: number, cy: number, size: number, fill: string, stroke?: string, lw = 0): void {
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 100, size / 100);
  const p = new Path2D(STAR);
  if (stroke) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = (lw * 100) / size;
    ctx.strokeStyle = stroke;
    ctx.stroke(p);
  }
  ctx.fillStyle = fill;
  ctx.fill(p);
  ctx.restore();
}

function rrect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Racer number roundel (keeps each kart recognisable in a livery). */
function roundel(ctx: Ctx, id: CharacterId, emblem: EmblemKind, x: number, y: number, r: number, ring: string, bg = '#ffffff', ink = '#151515'): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = r * 0.16;
  ctx.strokeStyle = ring;
  ctx.stroke();
  if (id === 'lupin' || id === 'grandma' || id === 'mom' || id === 'bro1') {
    drawEmblem(ctx, emblem, x, y + (emblem === 'heart' ? r * 0.06 : 0), r * 0.66, { fill: emblem === 'heart' ? '#e84fb0' : emblem === 'paw' ? ink : undefined, outline: emblem === 'heart' ? '#ffffff' : undefined, petals: '#ffffff', center: '#ffd23f' });
    if (emblem === 'flower') {
      ctx.beginPath();
      ctx.arc(x, y, r * 0.66, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = ink;
    ctx.font = `bold ${Math.round(r * 1.25)}px Arial Black, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(INITIAL[id], x, y + r * 0.06);
  }
}

function text(ctx: Ctx, s: string, x: number, y: number, size: number, fill: string, stroke?: string, lw = 0, font = 'Arial Black, Arial, sans-serif'): void {
  ctx.font = `bold ${size}px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (stroke) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.strokeText(s, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(s, x, y);
}

function hotDog(ctx: Ctx, x: number, y: number, len: number, thick: number, vertical: boolean): void {
  ctx.save();
  ctx.translate(x, y);
  if (vertical) ctx.rotate(Math.PI / 2);
  const hl = len / 2;
  // bun
  ctx.fillStyle = '#e8b56a';
  ctx.strokeStyle = '#8a5a22';
  ctx.lineWidth = thick * 0.08;
  rrect(ctx, -hl * 0.92, -thick * 0.62, hl * 1.84, thick * 1.24, thick * 0.6);
  ctx.fill();
  ctx.stroke();
  // sausage
  ctx.fillStyle = '#b8402c';
  rrect(ctx, -hl, -thick * 0.28, hl * 2, thick * 0.56, thick * 0.28);
  ctx.fill();
  ctx.stroke();
  // toppings: relish, tomato, pickle spear, mustard zigzag
  ctx.fillStyle = '#3fbf2a';
  for (let i = -3; i <= 3; i++) {
    ctx.beginPath();
    ctx.arc(i * hl * 0.25, -thick * 0.18, thick * 0.08, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#e8322a';
  for (const i of [-2, 0, 2]) {
    ctx.beginPath();
    ctx.ellipse(i * hl * 0.3 + hl * 0.12, thick * 0.22, thick * 0.14, thick * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#ffd21f';
  ctx.lineWidth = thick * 0.1;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i <= 12; i++) {
    const px = -hl * 0.85 + (i / 12) * hl * 1.7;
    const py = (i % 2 ? -1 : 1) * thick * 0.14;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.restore();
}

function sailboat(ctx: Ctx, x: number, y: number, s: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#0b2d6b';
  ctx.lineWidth = s * 0.06;
  ctx.lineJoin = 'round';
  // sails
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.9);
  ctx.lineTo(s * 0.55, s * 0.15);
  ctx.lineTo(0, s * 0.15);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-s * 0.08, -s * 0.65);
  ctx.lineTo(-s * 0.45, s * 0.15);
  ctx.lineTo(-s * 0.08, s * 0.15);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // hull
  ctx.fillStyle = '#e4002b';
  ctx.beginPath();
  ctx.moveTo(-s * 0.6, s * 0.25);
  ctx.lineTo(s * 0.7, s * 0.25);
  ctx.lineTo(s * 0.45, s * 0.5);
  ctx.lineTo(-s * 0.4, s * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function waves(ctx: Ctx, x0: number, x1: number, y: number, amp: number, period: number, color: string, lw: number): void {
  ctx.beginPath();
  for (let x = x0; x <= x1; x += 2) {
    const yy = y + Math.sin(((x - x0) / period) * Math.PI * 2) * amp;
    if (x === x0) ctx.moveTo(x, yy);
    else ctx.lineTo(x, yy);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function swirl(ctx: Ctx, x: number, y: number, r: number, color: string, lw: number, dir = 1): void {
  ctx.beginPath();
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const a = t * Math.PI * 3.2 * dir;
    const rr = r * (1 - t * 0.75);
    const px = x + Math.cos(a) * rr - (1 - t) * r * 2.4 * dir;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function musicNote(ctx: Ctx, x: number, y: number, s: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.12;
  ctx.beginPath();
  ctx.ellipse(-s * 0.3, s * 0.5, s * 0.28, s * 0.2, -0.4, 0, Math.PI * 2);
  ctx.ellipse(s * 0.45, s * 0.35, s * 0.28, s * 0.2, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-s * 0.06, s * 0.45);
  ctx.lineTo(-s * 0.06, -s * 0.6);
  ctx.lineTo(s * 0.7, -s * 0.78);
  ctx.lineTo(s * 0.7, s * 0.3);
  ctx.stroke();
  ctx.restore();
}

function neon(ctx: Ctx, color: string, blur: number, draw: () => void): void {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  draw();
  draw();
  ctx.restore();
}

function lRoundel(ctx: Ctx, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = r * 0.16;
  ctx.strokeStyle = '#00a1de';
  ctx.stroke();
  text(ctx, 'L', x, y + r * 0.05, Math.round(r * 1.3), '#22272f');
}

function pizzaSlice(ctx: Ctx, x: number, y: number, s: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(0, s);
  ctx.lineTo(-s * 0.75, -s * 0.6);
  ctx.quadraticCurveTo(0, -s * 0.95, s * 0.75, -s * 0.6);
  ctx.closePath();
  ctx.fillStyle = '#ffd35a';
  ctx.fill();
  ctx.lineWidth = s * 0.06;
  ctx.strokeStyle = '#7a3b12';
  ctx.stroke();
  // crust
  ctx.beginPath();
  ctx.moveTo(-s * 0.8, -s * 0.62);
  ctx.quadraticCurveTo(0, -s * 1.02, s * 0.8, -s * 0.62);
  ctx.lineWidth = s * 0.2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#a8652e';
  ctx.stroke();
  ctx.fillStyle = '#b3261e';
  for (const [px, py] of [[-0.3, -0.35], [0.3, -0.3], [0, 0.05], [-0.1, 0.45], [0.25, 0.25]]) {
    ctx.beginPath();
    ctx.arc(px * s, py * s, s * 0.13, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Hood decal for a livery (null = no hood graphic). `aspect` = plane length / width. */
export function liveryHoodTexture(liv: LiveryId, id: CharacterId, aspect: number): THREE.Texture | null {
  if (liv === 'bean') return null;
  const W = 256;
  const H = Math.max(128, Math.min(512, Math.round((W * aspect) / 8) * 8));
  return canvasTex(`livhood:${liv}:${id}:${H}`, W, H, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h * 0.52;
    const m = Math.min(w, h);
    switch (liv) {
      case 'chicagoFlag': {
        // the Chicago flag laid across the hood
        const fw = w * 0.9;
        const fh = Math.min(h * 0.62, fw * 0.62);
        const x0 = cx - fw / 2;
        const y0 = cy - fh / 2;
        rrect(ctx, x0, y0, fw, fh, 10);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.15)';
        ctx.stroke();
        ctx.fillStyle = '#41b6e6';
        ctx.fillRect(x0, y0 + fh * 0.12, fw, fh * 0.16);
        ctx.fillRect(x0, y0 + fh * 0.72, fw, fh * 0.16);
        for (let i = 0; i < 4; i++) star(ctx, x0 + fw * (0.17 + i * 0.22), cy, fh * 0.34, '#e4002b');
        break;
      }
      case 'windyCity': {
        ctx.globalAlpha = 0.95;
        swirl(ctx, cx + m * 0.1, cy - m * 0.15, m * 0.13, '#ffffff', m * 0.045, 1);
        swirl(ctx, cx - m * 0.12, cy + m * 0.18, m * 0.1, '#ffffff', m * 0.04, -1);
        // little cloud
        ctx.fillStyle = '#ffffff';
        for (const [dx, dy, r] of [[0, 0, 0.11], [0.1, 0.02, 0.08], [-0.1, 0.03, 0.08], [0.05, -0.06, 0.08]]) {
          ctx.beginPath();
          ctx.arc(cx + m * 0.22 + dx * m, cy + m * 0.3 + dy * m, r * m, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        break;
      }
      case 'lowerWacker': {
        // forward-pointing sodium chevrons + a green street sign
        ctx.fillStyle = '#ffb020';
        for (let i = 0; i < 3; i++) {
          const y = h * 0.55 + i * m * 0.13;
          ctx.beginPath();
          ctx.moveTo(cx - m * 0.28, y);
          ctx.lineTo(cx, y + m * 0.12);
          ctx.lineTo(cx + m * 0.28, y);
          ctx.lineTo(cx + m * 0.28, y + m * 0.06);
          ctx.lineTo(cx, y + m * 0.18);
          ctx.lineTo(cx - m * 0.28, y + m * 0.06);
          ctx.closePath();
          ctx.fill();
        }
        rrect(ctx, cx - w * 0.42, h * 0.16, w * 0.84, m * 0.24, 8);
        ctx.fillStyle = '#0d6b3a';
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        text(ctx, 'LOWER WACKER', cx, h * 0.16 + m * 0.12, Math.round(m * 0.1), '#ffffff', undefined, 0, 'Arial, sans-serif');
        break;
      }
      case 'chicagoDog':
        hotDog(ctx, cx, cy, h * 0.78, w * 0.3, true);
        break;
      case 'bluesClub':
        neon(ctx, '#ff3fa4', 14, () => text(ctx, 'BLUES', cx, h * 0.3, Math.round(m * 0.24), 'rgba(0,0,0,0)', '#ff7cc4', 6, 'Georgia, serif'));
        neon(ctx, '#3fd8ff', 14, () => musicNote(ctx, cx, h * 0.66, m * 0.22, '#8fe9ff'));
        break;
      case 'lTrain': {
        // CTA line-colour stripe across the hood + an "L" roundel
        const cols = ['#c60c30', '#00a1de', '#62361b', '#009b3a', '#f9461c', '#522398', '#e27ea6', '#f9e300'];
        const sw = (w * 0.9) / cols.length;
        cols.forEach((c, i) => {
          ctx.fillStyle = c;
          ctx.fillRect(w * 0.05 + i * sw, h * 0.2, sw + 0.5, m * 0.08);
        });
        lRoundel(ctx, cx, h * 0.6, m * 0.24);
        break;
      }
      case 'deepDish':
        pizzaSlice(ctx, cx, cy, m * 0.36);
        break;
      case 'lakeMichigan': {
        ctx.beginPath();
        ctx.arc(cx, cy, m * 0.36, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy, m * 0.31, 0, Math.PI * 2);
        ctx.fillStyle = '#7fd3f0';
        ctx.fill();
        ctx.save();
        ctx.clip();
        ctx.fillStyle = '#0e3f80';
        ctx.fillRect(cx - m * 0.4, cy + m * 0.1, m * 0.8, m * 0.4);
        waves(ctx, cx - m * 0.35, cx + m * 0.35, cy + m * 0.1, m * 0.025, m * 0.14, '#ffffff', 4);
        ctx.restore();
        sailboat(ctx, cx, cy - m * 0.02, m * 0.2);
        break;
      }
    }
  });
}

/** Side decal (512x160, transparent) for a livery. */
export function liverySideTexture(liv: LiveryId, id: CharacterId, emblem: EmblemKind): THREE.Texture | null {
  return canvasTex(`livside:${liv}:${id}`, 512, 160, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const rx = w * 0.5;
    const ry = h * 0.48;
    switch (liv) {
      case 'chicagoFlag':
        ctx.fillStyle = '#41b6e6';
        ctx.fillRect(0, h * 0.12, w, h * 0.13);
        ctx.fillRect(0, h * 0.75, w, h * 0.13);
        for (const x of [0.13, 0.3, 0.7, 0.87]) star(ctx, w * x, ry, h * 0.42, '#e4002b');
        roundel(ctx, id, emblem, rx, ry, 46, '#e4002b');
        break;
      case 'windyCity':
        ctx.globalAlpha = 0.95;
        swirl(ctx, w * 0.82, h * 0.36, 26, '#ffffff', 9, 1);
        swirl(ctx, w * 0.24, h * 0.68, 20, '#ffffff', 8, 1);
        waves(ctx, w * 0.05, w * 0.4, h * 0.3, 5, 90, '#ffffff', 6);
        waves(ctx, w * 0.6, w * 0.95, h * 0.75, 5, 90, '#ffffff', 6);
        ctx.globalAlpha = 1;
        roundel(ctx, id, emblem, rx, ry, 46, '#2a7fd0');
        break;
      case 'lowerWacker':
        rrect(ctx, w * 0.06, h * 0.32, w * 0.3, h * 0.34, 8);
        ctx.fillStyle = '#0d6b3a';
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        text(ctx, 'LOWER WACKER DR', w * 0.21, h * 0.49, 15, '#ffffff', undefined, 0, 'Arial, sans-serif');
        roundel(ctx, id, emblem, rx, ry, 46, '#ffb020', '#ffb020', '#15161a');
        for (let i = 0; i < 4; i++) {
          ctx.fillStyle = '#ffb020';
          ctx.beginPath();
          const x = w * 0.66 + i * 40;
          ctx.moveTo(x, h * 0.3);
          ctx.lineTo(x + 22, h * 0.48);
          ctx.lineTo(x, h * 0.66);
          ctx.lineTo(x + 12, h * 0.66);
          ctx.lineTo(x + 34, h * 0.48);
          ctx.lineTo(x + 12, h * 0.3);
          ctx.closePath();
          ctx.fill();
        }
        break;
      case 'chicagoDog':
        hotDog(ctx, w * 0.3, ry, w * 0.42, h * 0.5, false);
        text(ctx, 'NO KETCHUP!', w * 0.76, h * 0.3, 26, '#f5c518', '#7a4a10', 6);
        roundel(ctx, id, emblem, w * 0.76, h * 0.68, 34, '#3fae2a');
        break;
      case 'bluesClub':
        neon(ctx, '#ff3fa4', 12, () => text(ctx, 'Blues', w * 0.22, ry, 62, 'rgba(0,0,0,0)', '#ff7cc4', 5, 'Georgia, serif'));
        neon(ctx, '#3fd8ff', 12, () => {
          musicNote(ctx, w * 0.78, h * 0.42, 34, '#8fe9ff');
          musicNote(ctx, w * 0.92, h * 0.6, 22, '#8fe9ff');
        });
        roundel(ctx, id, emblem, rx, ry, 44, '#ff3fa4', '#12206b', '#ffffff');
        break;
      case 'lTrain': {
        // like the side of an L car: windows, a line-colour stripe and the destination sign
        ctx.fillStyle = '#22272f';
        for (const x of [0.06, 0.66, 0.82]) {
          rrect(ctx, w * x, h * 0.14, w * 0.13, h * 0.36, 10);
          ctx.fill();
        }
        rrect(ctx, w * 0.06, h * 0.62, w * 0.3, h * 0.24, 6);
        ctx.fill();
        text(ctx, 'LOOP', w * 0.21, h * 0.745, 28, '#ffbf3c', undefined, 0, 'Arial, sans-serif');
        lRoundel(ctx, rx, ry, 46);
        break;
      }
      case 'deepDish':
        for (const [x, y, r] of [[0.12, 0.38, 22], [0.28, 0.62, 18], [0.72, 0.36, 20], [0.88, 0.62, 24], [0.36, 0.3, 14], [0.64, 0.7, 15]]) {
          ctx.beginPath();
          ctx.arc(w * x, h * y, r, 0, Math.PI * 2);
          ctx.fillStyle = '#9e1f17';
          ctx.fill();
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.beginPath();
          ctx.arc(w * x + r * 0.25, h * y + r * 0.2, r * 0.25, 0, Math.PI * 2);
          ctx.fill();
        }
        roundel(ctx, id, emblem, rx, ry, 46, '#a8652e', '#ffd35a');
        break;
      case 'lakeMichigan':
        sailboat(ctx, w * 0.2, h * 0.45, 46);
        for (const [x, y] of [[0.75, 0.25], [0.83, 0.18], [0.9, 0.3]]) {
          ctx.beginPath();
          ctx.moveTo(w * x - 10, h * y);
          ctx.quadraticCurveTo(w * x - 5, h * y - 8, w * x, h * y);
          ctx.quadraticCurveTo(w * x + 5, h * y - 8, w * x + 10, h * y);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
        roundel(ctx, id, emblem, rx, ry, 46, '#1fb5b0');
        break;
      case 'bean':
        roundel(ctx, id, emblem, rx, ry, 40, '#9aa3ad');
        break;
    }
  });
}

/** Little double-sided Chicago flag for the flag accessory. */
export function miniFlagTexture(): THREE.Texture | null {
  return canvasTex('livflag', 180, 120, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#41b6e6';
    ctx.fillRect(0, h * 0.12, w, h * 0.16);
    ctx.fillRect(0, h * 0.72, w, h * 0.16);
    for (let i = 0; i < 4; i++) star(ctx, w * (0.16 + i * 0.227), h * 0.5, h * 0.36, '#e4002b');
  });
}
