import * as THREE from 'three';
import { CHARACTERS, characterById } from '../data/characters';
import { buildCharacter } from '../render/models/characterModels';
import { buildKart } from '../render/models/kartModels';
import type { CharacterId } from '../sim/types';

/** Renders a portrait image (data URL) of every character once at startup for the 2D UI. */
export class Portraits {
  private urls = new Map<CharacterId, string>();
  private fullUrls = new Map<CharacterId, string>();

  generate(gl: THREE.WebGLRenderer): void {
    const size = 256;
    const rt = new THREE.WebGLRenderTarget(size, size, { samples: 4, colorSpace: THREE.SRGBColorSpace });
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#ffffff', '#6a5a80', 2.2));
    const key = new THREE.DirectionalLight('#fff4e0', 2.6);
    key.position.set(2, 4, 5);
    scene.add(key);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    const pixels = new Uint8Array(size * size * 4);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const prevTarget = gl.getRenderTarget();
    const prevTone = gl.toneMapping;
    for (const def of CHARACTERS) {
      const kart = buildKart(def);
      const ch = buildCharacter(def.id);
      kart.seat.add(ch.root);
      ch.update(0.016, { steer: 0, speed: 0, drifting: false, driftDir: 0, airborne: false, boosting: false, reaction: 'overtake', reactionTime: 0.5, time: 0.3 });
      scene.add(kart.root);
      kart.root.rotation.y = Math.PI + 0.35;
      kart.root.updateMatrixWorld(true);
      // head shot: frame the bounding box of the character's upper part
      const box = new THREE.Box3().setFromObject(ch.root);
      const top = box.max.y;
      const center = new THREE.Vector3((box.min.x + box.max.x) / 2, top - 0.55, (box.min.z + box.max.z) / 2);
      cam.position.set(center.x + 0.6, center.y + 0.15, center.z - 3.2);
      cam.lookAt(center);
      cam.fov = 26;
      cam.updateProjectionMatrix();
      this.urls.set(def.id, this.shot(gl, scene, cam, rt, pixels, ctx, canvas, def.colors.primary));
      // full kart shot
      const kb = new THREE.Box3().setFromObject(kart.root);
      const kc = kb.getCenter(new THREE.Vector3());
      cam.position.set(kc.x + 3.2, kc.y + 1.6, kc.z - 4.6);
      cam.lookAt(kc);
      cam.fov = 34;
      cam.updateProjectionMatrix();
      this.fullUrls.set(def.id, this.shot(gl, scene, cam, rt, pixels, ctx, canvas, def.colors.primary));
      scene.remove(kart.root);
      kart.dispose();
      ch.dispose();
    }
    gl.setRenderTarget(prevTarget);
    gl.toneMapping = prevTone;
    rt.dispose();
  }

  private shot(gl: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera, rt: THREE.WebGLRenderTarget, pixels: Uint8Array, ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, bg: string): string {
    const size = canvas.width;
    gl.setRenderTarget(rt);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(scene, cam);
    gl.readRenderTargetPixels(rt, 0, 0, size, size, pixels);
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      const src = (size - 1 - y) * size * 4;
      img.data.set(pixels.subarray(src, src + size * 4), y * size * 4);
    }
    const grd = ctx.createRadialGradient(size / 2, size / 2, 10, size / 2, size / 2, size * 0.7);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(1, bg);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, size, size);
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = size;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.drawImage(tmp, 0, 0);
    gl.setClearColor(0x000000, 1);
    return canvas.toDataURL('image/png');
  }

  get(id: CharacterId): string {
    return this.urls.get(id) ?? '';
  }
  full(id: CharacterId): string {
    return this.fullUrls.get(id) ?? this.get(id);
  }
  name(id: CharacterId): string {
    return characterById(id).name;
  }
}
