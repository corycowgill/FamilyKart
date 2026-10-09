import * as THREE from 'three';
import { characterById } from '../data/characters';
import type { KartState } from '../sim/types';
import { buildCharacter } from './models/characterModels';
import { buildKart } from './models/kartModels';
import type { CharacterRig, KartRig } from './models/types';
import type { Effects } from './Particles';

const DRIFT_COLORS = ['#fff4d0', '#4fb4ff', '#ff9a2e', '#c45cff'];
const tmp = new THREE.Vector3();

/** Visual representation of one kart + driver, driven from interpolated sim state. */
export class KartView {
  readonly root = new THREE.Group();
  readonly kart: KartRig;
  readonly character: CharacterRig;
  private wheelSpin = 0;
  private shield: THREE.Mesh;
  private flames: THREE.Mesh[] = [];
  private lean = 0;
  private pitch = 0;
  private hopOffset = 0;
  private shadowBlob: THREE.Mesh;
  private label?: THREE.Sprite;
  readonly interpPos = new THREE.Vector3();
  interpYaw = 0;

  constructor(private state: KartState, showLabel: boolean) {
    const def = characterById(state.character);
    this.kart = buildKart(def);
    this.character = buildCharacter(state.character);
    this.kart.seat.add(this.character.root);
    this.root.add(this.kart.root);

    const shieldMat = new THREE.MeshPhysicalMaterial({
      color: '#9fe8ff', transparent: true, opacity: 0.28, roughness: 0.05, metalness: 0, transmission: 0, clearcoat: 1,
      emissive: '#4fc8ff', emissiveIntensity: 0.25, depthWrite: false, side: THREE.DoubleSide,
    });
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(1.9, 24, 16), shieldMat);
    this.shield.position.y = 1.0;
    this.shield.visible = false;
    this.root.add(this.shield);

    const flameMat = new THREE.MeshBasicMaterial({ color: '#ffb02e', transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    for (const ex of this.kart.exhausts) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.2, 10).rotateX(-Math.PI / 2).translate(0, 0, -0.6), flameMat.clone());
      f.visible = false;
      ex.add(f);
      this.flames.push(f);
    }
    const blobTex = makeBlobTexture();
    this.shadowBlob = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 3.2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.55 }),
    );
    this.shadowBlob.renderOrder = 1;
    this.root.add(this.shadowBlob);
    if (showLabel) {
      this.label = makeLabel(def.name, def.colors.primary);
      this.label.position.y = 3.1;
      this.root.add(this.label);
    }
  }

  update(dt: number, alpha: number, time: number, fx: Effects | null): void {
    const k = this.state;
    // interpolate between previous and current sim step
    this.interpPos.set(
      k.prevPos.x + (k.pos.x - k.prevPos.x) * alpha,
      k.prevPos.y + (k.pos.y - k.prevPos.y) * alpha,
      k.prevPos.z + (k.pos.z - k.prevPos.z) * alpha,
    );
    let dy = k.yaw - k.prevYaw;
    if (dy > Math.PI) dy -= Math.PI * 2;
    if (dy < -Math.PI) dy += Math.PI * 2;
    this.interpYaw = k.prevYaw + dy * alpha;
    const respawning = k.respawnTime > 0;
    this.root.visible = !respawning || Math.floor(time * 12) % 2 === 0;
    this.root.position.copy(this.interpPos);
    this.root.rotation.y = this.interpYaw;

    // body lean & pitch
    const speed = k.forwardSpeed;
    const targetLean = (k.drift.active ? k.drift.dir * 0.16 : k.steerVisual * 0.09 * Math.min(1, Math.abs(speed) / 15));
    this.lean += (targetLean - this.lean) * Math.min(1, dt * 8);
    const targetPitch = k.grounded ? -k.suspension * 0.4 + (k.boostTime > 0 ? -0.05 : 0) : Math.max(-0.25, Math.min(0.25, -k.vy * 0.02));
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 8);
    this.kart.body.rotation.z = this.lean;
    this.kart.body.rotation.x = this.pitch;
    this.kart.body.position.y = -k.suspension * 0.25;
    // extra visual drift yaw (kart rotated into the slide)
    this.hopOffset += ((k.drift.active ? k.drift.dir * -0.28 : 0) - this.hopOffset) * Math.min(1, dt * 7);
    this.kart.root.rotation.y = this.hopOffset;

    // wheels
    this.wheelSpin += (speed / 0.36) * dt;
    for (const w of this.kart.wheels) w.rotation.x = this.wheelSpin;
    for (const p of this.kart.frontPivots) p.rotation.y = -k.steerVisual * 0.45;

    // shield
    this.shield.visible = k.shieldTime > 0;
    if (this.shield.visible) {
      const s = 1 + Math.sin(time * 6) * 0.03;
      this.shield.scale.set(s, s, s);
      this.shield.rotation.y = time;
      (this.shield.material as THREE.MeshPhysicalMaterial).opacity = k.shieldTime < 1.5 && Math.floor(time * 10) % 2 ? 0.1 : 0.28;
    }
    // invulnerability flicker
    const flicker = k.invulnTime > 0 && k.spinTime <= 0 && k.respawnTime <= 0 && Math.floor(time * 16) % 2 === 0;
    this.kart.root.visible = !flicker;

    // boost flames
    const boosting = k.boostTime > 0;
    const flameColor = k.boostKind === 'drift3' ? '#d070ff' : k.boostKind === 'drift2' ? '#ff8a2e' : k.boostKind === 'drift1' ? '#58b8ff' : k.boostKind === 'rocket' ? '#ff4a2e' : '#ffb02e';
    for (const f of this.flames) {
      f.visible = boosting;
      if (boosting) {
        const sc = 0.8 + Math.random() * 0.6 + (k.boostKind === 'rocket' || k.boostKind === 'special' ? 0.8 : 0);
        f.scale.set(1, 1, sc);
        (f.material as THREE.MeshBasicMaterial).color.set(flameColor);
      }
    }

    // shadow blob stays on the ground
    this.shadowBlob.position.y = k.groundY - this.interpPos.y + 0.05;
    this.shadowBlob.scale.setScalar(Math.max(0.4, 1 - (this.interpPos.y - k.groundY) * 0.12));
    this.shadowBlob.visible = !respawning;

    // driver animation
    this.character.update(dt, {
      steer: k.steerVisual, speed, drifting: k.drift.active, driftDir: k.drift.dir, airborne: !k.grounded,
      boosting, reaction: k.reaction, reactionTime: k.reactionTime, time,
    });

    if (!fx || respawning) return;
    // particles: drift sparks & smoke, boost fire, offroad dust
    const emitRate = Math.min(1, dt * 60);
    if (k.drift.active && k.grounded) {
      for (const rc of this.kart.rearContacts) {
        rc.getWorldPosition(tmp);
        if (Math.random() < 0.7 * emitRate) {
          fx.smoke.emit({ x: tmp.x, y: tmp.y + 0.2, z: tmp.z, spread: 0.6, vy: 1.2, color: '#e8e8e8', size: 0.9, life: 0.7, grow: 2.4, drag: 2 });
        }
        if (k.drift.tier > 0) {
          const c = DRIFT_COLORS[k.drift.tier];
          fx.glow.emit({ x: tmp.x, y: tmp.y + 0.15, z: tmp.z, spread: 2.5, vy: 2.5, color: c, size: 0.35 + k.drift.tier * 0.08, life: 0.35, gravity: 12, drag: 2, count: k.drift.tier + 1 });
        } else if (Math.random() < 0.4) {
          fx.glow.emit({ x: tmp.x, y: tmp.y + 0.15, z: tmp.z, spread: 1.5, vy: 1.5, color: '#fff2b0', size: 0.2, life: 0.25, gravity: 10 });
        }
      }
    }
    if (boosting) {
      for (const ex of this.kart.exhausts) {
        ex.getWorldPosition(tmp);
        fx.glow.emit({ x: tmp.x, y: tmp.y, z: tmp.z, vx: -Math.sin(this.interpYaw) * 4, vz: -Math.cos(this.interpYaw) * 4, spread: 0.8, color: flameColor, size: 0.6, life: 0.25, drag: 3, count: 2 });
      }
    }
    if (k.offroad && k.grounded && Math.abs(speed) > 5) {
      const rc = this.kart.rearContacts[Math.random() < 0.5 ? 0 : 1];
      rc.getWorldPosition(tmp);
      fx.smoke.emit({ x: tmp.x, y: tmp.y + 0.2, z: tmp.z, spread: 0.8, vy: 1.5, color: k.surface === 'mud' ? '#6b4a2b' : '#b59a6a', size: 0.8, life: 0.6, grow: 2, drag: 2 });
    }
    if (k.spinTime > 0 && Math.random() < 0.5) {
      fx.glow.emit({ x: this.interpPos.x, y: this.interpPos.y + 2.4, z: this.interpPos.z, spread: 1.2, color: '#ffe14a', size: 0.4, life: 0.4 });
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.kart.dispose();
    this.character.dispose();
    this.shield.geometry.dispose();
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.Material && (o === this.shadowBlob || this.flames.includes(o))) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
  }
}

let blobTex: THREE.Texture | null = null;
function makeBlobTexture(): THREE.Texture {
  if (blobTex) return blobTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.7)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  blobTex = new THREE.CanvasTexture(c);
  return blobTex;
}

function makeLabel(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.font = 'bold 36px "Baloo 2", "Arial Rounded MT Bold", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.strokeText(text, 128, 34);
  g.fillStyle = color;
  g.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
  s.scale.set(2.4, 0.6, 1);
  return s;
}
