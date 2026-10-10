import * as THREE from 'three';
import { characterById } from '../data/characters';
import type { KartState } from '../sim/types';
import { buildCharacter } from './models/characterModels';
import { buildKart } from './models/kartModels';
import { optimizeKartRig } from './models/optimize';
import type { CharacterRig, KartRig } from './models/types';
import { sprayColor, SPRITE, type Effects } from './Particles';
import { createShieldMaterial } from './vfx/Shield';
import { WindVolume } from './vfx/Wind';

export const DRIFT_COLORS = ['#fff4d0', '#4fb4ff', '#ff9a2e', '#d05cff'];
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

/** Visual representation of one kart + driver, driven from interpolated sim state. */
export class KartView {
  readonly root = new THREE.Group();
  readonly kart: KartRig;
  readonly character: CharacterRig;
  private wheelSpin = 0;
  private shield: THREE.Mesh;
  private shieldMat: ReturnType<typeof createShieldMaterial>;
  /** >0 while the shield bursts after blocking a hit */
  private shieldPop = 0;
  private wind: WindVolume | null = null;
  private tornado: WindVolume | null = null;
  /** seconds left of the Windy City Gust "blown" state (set by the session each frame) */
  blown = 0;
  private quality: 'low' | 'medium' | 'high';
  private flames: THREE.Mesh[] = [];
  private flameCores: THREE.Mesh[] = [];
  private flameGlows: THREE.Sprite[] = [];
  private lean = 0;
  private pitch = 0;
  private hopOffset = 0;
  private shadowBlob: THREE.Mesh;
  private label?: THREE.Sprite;
  readonly interpPos = new THREE.Vector3();
  interpYaw = 0;
  /** Local (root space, +Z forward) head/tail light positions for the time-of-day kart lights. */
  readonly lightAnchors: { head: THREE.Vector3[]; tail: THREE.Vector3[] };
  /** 0..1 brake-light amount (decelerating / standing still / reversing) */
  brake = 0;
  private prevSpeed = 0;
  private trailPrev: Array<{ x: number; y: number; z: number } | null> = [null, null];

  constructor(private state: KartState, showLabel: boolean, quality: 'low' | 'medium' | 'high' = 'high') {
    const def = characterById(state.character);
    this.quality = quality;
    this.kart = buildKart(def);
    this.character = buildCharacter(state.character);
    this.kart.seat.add(this.character.root);
    // ~130 meshes per racer -> merge everything that never moves (big draw-call saving with 6 karts)
    optimizeKartRig(this.kart, this.character);
    // real shadows only from the bigger parts on high; below that the soft blob shadow does the job
    this.kart.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      m.castShadow = m.castShadow && quality === 'high' && (m.geometry.boundingSphere?.radius ?? 0) > 0.3;
    });
    this.root.add(this.kart.root);
    // head / tail light anchors from the kart's bounds (models stay untouched)
    {
      const box = new THREE.Box3();
      this.kart.root.updateMatrixWorld(true);
      this.kart.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.geometry) return;
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        const b = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
        // ignore the driver's head (tall) so lights sit on the chassis
        if (b.min.y > 1.2) return;
        box.union(b);
      });
      if (box.isEmpty()) box.set(new THREE.Vector3(-0.8, 0, -1.2), new THREE.Vector3(0.8, 1, 1.3));
      const hx = Math.max(0.3, (box.max.x - box.min.x) * 0.32);
      const y = box.min.y + Math.min(0.55, (box.max.y - box.min.y) * 0.35) + 0.12;
      this.lightAnchors = {
        head: [new THREE.Vector3(-hx, y, box.max.z - 0.05), new THREE.Vector3(hx, y, box.max.z - 0.05)],
        tail: [new THREE.Vector3(-hx * 0.95, y + 0.05, box.min.z + 0.05), new THREE.Vector3(hx * 0.95, y + 0.05, box.min.z + 0.05)],
      };
    }

    this.shieldMat = createShieldMaterial();
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(1.9, quality === 'low' ? 20 : 32, quality === 'low' ? 14 : 22), this.shieldMat);
    this.shield.position.y = 1.0;
    this.shield.visible = false;
    this.shield.renderOrder = 8;
    this.root.add(this.shield);
    // wind lines streaming past the player's kart at high speed (stylised speed lines in 3D)
    if (state.isHuman && quality !== 'low') {
      this.wind = new WindVolume({ kind: 'tunnel', radius: 2.3, length: 10, lanes: quality === 'high' ? 26 : 18, density: 0.3, color: '#ffffff' });
      this.wind.mesh.position.set(0, 0.9, 1.2);
      this.root.add(this.wind.mesh);
    }

    // layered boost flame: coloured outer cone + white-hot core + additive glow sprite (blooms)
    const flameMat = new THREE.MeshBasicMaterial({ color: '#ffb02e', transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
    const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff4c8').multiplyScalar(2.2), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const glowTex = makeGlowTexture();
    for (const ex of this.kart.exhausts) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.2, 10, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.6), flameMat.clone());
      f.visible = false;
      f.renderOrder = 6;
      ex.add(f);
      this.flames.push(f);
      const core = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.65, 8, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.32), coreMat);
      core.renderOrder = 7;
      f.add(core);
      this.flameCores.push(core);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: '#ffb02e', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9 }));
      glow.scale.setScalar(1.1);
      glow.position.z = -0.15;
      glow.renderOrder = 6;
      glow.visible = false;
      ex.add(glow);
      this.flameGlows.push(glow);
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

  /** Sim state this view follows (read-only use by time-of-day kart lights). */
  get kartState(): KartState {
    return this.state;
  }

  update(dt: number, alpha: number, time: number, fx: Effects | null): void {
    const k = this.state;
    if (dt > 0) {
      // brake lights: decelerating hard, nearly stopped or reversing
      const decel = (this.prevSpeed - k.forwardSpeed) / dt;
      this.prevSpeed = k.forwardSpeed;
      const target = (decel > 5 && k.forwardSpeed > 1) || Math.abs(k.forwardSpeed) < 0.6 || k.forwardSpeed < -0.5 ? 1 : 0;
      this.brake += (target - this.brake) * Math.min(1, dt * (target > this.brake ? 18 : 5));
    }
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

    // shield (fresnel hex bubble; bursts with a ripple when it blocks a hit)
    const shieldOn = k.shieldTime > 0;
    if (this.shieldPop > 0) this.shieldPop = Math.max(0, this.shieldPop - dt);
    this.shield.visible = shieldOn || this.shieldPop > 0;
    if (this.shield.visible) {
      this.shieldMat.tick(dt, time);
      let s = 1 + Math.sin(time * 6) * 0.03;
      let op = shieldOn && k.shieldTime < 1.5 && Math.floor(time * 10) % 2 ? 0.35 : 1;
      if (!shieldOn) {
        // burst: swell and fade out
        const t = 1 - this.shieldPop / 0.45;
        s *= 1 + t * 0.6;
        op = (1 - t) * 1.4;
      }
      this.shield.scale.set(s, s, s);
      this.shield.rotation.y = time * 0.6;
      this.shieldMat.uniforms.opacity.value = op;
    }
    // invulnerability flicker
    const flicker = k.invulnTime > 0 && k.spinTime <= 0 && k.respawnTime <= 0 && Math.floor(time * 16) % 2 === 0;
    this.kart.root.visible = !flicker;

    // boost flames
    const boosting = k.boostTime > 0;
    const flameColor = k.boostKind === 'drift3' ? '#d070ff' : k.boostKind === 'drift2' ? '#ff8a2e' : k.boostKind === 'drift1' ? '#58b8ff' : k.boostKind === 'rocket' ? '#ff4a2e' : '#ffb02e';
    const big = k.boostKind === 'rocket' || k.boostKind === 'special' || k.boostKind === 'drift3';
    const bigger = k.boostKind === 'rocket' || (k.boostKind === 'special' && k.character === 'dad');
    this.flames.forEach((f, i) => {
      f.visible = boosting;
      const g = this.flameGlows[i];
      g.visible = boosting;
      if (boosting) {
        const sc = 0.8 + Math.random() * 0.6 + (big ? 0.8 : 0) + (bigger ? 0.9 : 0);
        const w = 1 + (big ? 0.35 : 0) + (bigger ? 0.4 : 0) + Math.random() * 0.15;
        f.scale.set(w, w, sc);
        (f.material as THREE.MeshBasicMaterial).color.set(flameColor).multiplyScalar(1.8);
        const gm = g.material as THREE.SpriteMaterial;
        gm.color.set(flameColor).multiplyScalar(1.4);
        g.scale.setScalar((bigger ? 1.9 : big ? 1.3 : 0.9) * (0.9 + Math.random() * 0.2));
      }
    });

    // shadow blob stays on the ground
    this.shadowBlob.position.y = k.groundY - this.interpPos.y + 0.05;
    this.shadowBlob.scale.setScalar(Math.max(0.4, 1 - (this.interpPos.y - k.groundY) * 0.12));
    this.shadowBlob.visible = !respawning;

    // driver animation
    this.character.update(dt, {
      steer: k.steerVisual, speed, drifting: k.drift.active, driftDir: k.drift.dir, airborne: !k.grounded,
      boosting, reaction: k.reaction, reactionTime: k.reactionTime, time,
    });

    // speed wind lines (player karts): fade in near top speed, full on boost
    if (this.wind) {
      const sp01 = Math.max(0, speed) / k.tuning.maxSpeed;
      const amt = respawning ? 0 : Math.min(1, Math.max(0, (sp01 - 0.72) / 0.28) * 0.55 + (boosting ? 0.6 : 0));
      this.wind.uniforms.color.value.set(boosting ? flameColor : '#ffffff').multiplyScalar(1.6);
      this.wind.set(amt * (this.quality === 'high' ? 0.75 : 0.55), time, 2.2 + sp01 * 2.5);
    }
    // gust victims: a swirling little twister around the kart
    if (this.blown > 0 && this.quality !== 'low' && !this.tornado) {
      this.tornado = new WindVolume({ kind: 'tornado', radius: 1.8, length: 3.6, lanes: 14, swirl: 0.6, density: 0.45, color: '#e9f6ff' });
      this.root.add(this.tornado.mesh);
    }
    if (this.tornado) this.tornado.set(Math.min(1, this.blown * 2.5) * 0.9, time, 1.2, -1.6);

    if (!fx || respawning) return;
    this.emitParticles(dt, time, fx, flameColor, boosting, bigger);
  }

  /** Particles: drift sparks & tyre smoke, boost fire, wind trails, off-road spray, spin stars, auras. */
  private emitParticles(dt: number, time: number, fx: Effects, flameColor: string, boosting: boolean, bigger: boolean): void {
    const k = this.state;
    const speed = k.forwardSpeed;
    const emitRate = Math.min(1, dt * 60);
    const D = fx.density;
    const lowQ = fx.quality === 'low';
    const fwx = Math.sin(this.interpYaw), fwz = Math.cos(this.interpYaw);
    const skids = fx.skids;
    if (k.drift.active && k.grounded) {
      const tier = k.drift.tier;
      this.kart.rearContacts.forEach((rc, wi) => {
        rc.getWorldPosition(tmp);
        skids?.add(k.id * 2 + wi, tmp.x, k.groundY + 0.1, tmp.z);
        // billowing cel-shaded tyre smoke
        if (Math.random() < 0.25 * emitRate * D) {
          fx.puff(tmp.x, tmp.y + 0.2, tmp.z, k.surface === 'road' ? '#e4e6ec' : sprayColor(fx.theme, k.surface).color, 0.36 + tier * 0.05, {
            vx: -fwx * 3, vz: -fwz * 3, vy: 0.8, spread: 0.5, life: 0.5 + tier * 0.06, grow: 2.0, opacity: 0.75,
          });
        }
        // outward direction of this wheel (sparks fan out behind and to the side)
        const side = wi === 0 ? -1 : 1;
        const ox = fwz * side, oz = -fwx * side;
        if (tier > 0) {
          const c = DRIFT_COLORS[tier];
          const n = fx.n(tier * 2 + 1);
          for (let i = 0; i < n; i++) {
            fx.glow.emit({
              x: tmp.x, y: tmp.y + 0.15, z: tmp.z, vx: -fwx * (5 + tier * 2) + ox * 3, vz: -fwz * (5 + tier * 2) + oz * 3, vy: 2.5 + Math.random() * (2 + tier),
              spread: 2.6, color: '#ffffff', color2: c, size: 0.3 + tier * 0.07, life: 0.3 + tier * 0.05, gravity: 16, drag: 1.2, stretch: 1.6, floor: k.groundY + 0.05,
            });
          }
          // stylised wheel flame / glow (Mario Kart style) grows with the tier
          if (!lowQ && Math.random() < 0.8 * emitRate) {
            fx.glow.emit({ x: tmp.x - fwx * 0.3, y: tmp.y + 0.35, z: tmp.z - fwz * 0.3, vx: -fwx * 3, vz: -fwz * 3, vy: 1.5, color: '#ffffff', color2: c, sprite: tier >= 2 ? SPRITE.FLAME : SPRITE.SOFT, size: 0.6 + tier * 0.3, life: 0.14, curve: 'flash' });
          }
          if (tier === 3 && !lowQ && Math.random() < 0.25 * emitRate) {
            fx.glow.emit({ x: tmp.x, y: tmp.y + 0.4, z: tmp.z, vy: 3, spread: 1.5, color: '#ffb8ff', sprite: SPRITE.SPARKLE, size: 0.45, life: 0.4, spin: 4, curve: 'shrink' });
          }
        } else if (Math.random() < 0.35) {
          fx.glow.emit({ x: tmp.x, y: tmp.y + 0.15, z: tmp.z, vx: -fwx * 3, vz: -fwz * 3, spread: 1.5, vy: 1.5, color: '#fff2b0', size: 0.14, life: 0.22, gravity: 10, stretch: 1 });
        }
      });
    } else if (skids) {
      skids.lift(k.id * 2);
      skids.lift(k.id * 2 + 1);
    }
    // night light trails: boosting karts leave thin streaks from their tail lights (evenly spaced dots)
    if (boosting && fx.night > 0.4 && fx.quality !== 'low' && speed > 10) {
      const cy = Math.cos(this.interpYaw), sy = Math.sin(this.interpYaw);
      const gap = fx.quality === 'high' ? 0.35 : 0.6;
      this.lightAnchors.tail.forEach((a, i) => {
        const x = this.interpPos.x + a.x * cy + a.z * sy, y = this.interpPos.y + a.y, z = this.interpPos.z - a.x * sy + a.z * cy;
        const p = this.trailPrev[i];
        if (!p) {
          this.trailPrev[i] = { x, y, z };
          return;
        }
        const d = Math.hypot(x - p.x, z - p.z);
        if (d > 6) {
          this.trailPrev[i] = { x, y, z };
          return;
        }
        const steps = Math.min(8, Math.floor(d / gap));
        for (let j = 1; j <= steps; j++) {
          const f = (j * gap) / d;
          fx.glow.emit({ x: p.x + (x - p.x) * f, y: p.y + (y - p.y) * f, z: p.z + (z - p.z) * f, color: flameColor, size: 0.22, life: 0.35, drag: 0 });
        }
        if (steps > 0) {
          const f = (steps * gap) / d;
          this.trailPrev[i] = { x: p.x + (x - p.x) * f, y: p.y + (y - p.y) * f, z: p.z + (z - p.z) * f };
        }
      });
    } else {
      this.trailPrev[0] = this.trailPrev[1] = null;
    }
    if (boosting) {
      const rocket = k.boostKind === 'rocket';
      for (const ex of this.kart.exhausts) {
        ex.getWorldPosition(tmp);
        const bx = -fwx * 5, bz = -fwz * 5;
        // layered exhaust: toon flame tongues + hot sparks (+ thick fire trail and smoke for rockets / Dad)
        fx.glow.emit({ x: tmp.x, y: tmp.y, z: tmp.z, vx: bx, vz: bz, vy: 0.6, spread: 0.6, color: '#fff3c0', color2: flameColor, sprite: SPRITE.FLAME, size: bigger ? 0.9 : 0.55, life: bigger ? 0.32 : 0.2, drag: 3, grow: 0.5, count: lowQ ? 1 : 2 });
        if (!lowQ && Math.random() < 0.5 * D) fx.glow.emit({ x: tmp.x, y: tmp.y, z: tmp.z, vx: bx * 1.4, vz: bz * 1.4, vy: 1.5, spread: 1.5, color: flameColor, size: 0.12, life: 0.35, gravity: 4, stretch: 1 });
        if (bigger) {
          fx.glow.emit({ x: tmp.x - fwx * 0.6, y: tmp.y, z: tmp.z - fwz * 0.6, vx: bx * 0.6, vz: bz * 0.6, vy: 0.8, spread: 0.8, color: '#ffe08a', color2: rocket ? '#ff3a1a' : '#ff7a1a', sprite: SPRITE.FLAME, size: 1.3, life: 0.4, drag: 2.5, grow: 0.6, count: fx.n(2) });
          if (Math.random() < 0.6 * emitRate * D) fx.puff(tmp.x - fwx * 1.2, tmp.y + 0.2, tmp.z - fwz * 1.2, rocket ? '#c9c2d2' : '#ddd4d8', 0.6, { vx: bx * 0.2, vz: bz * 0.2, vy: 1.5, spread: 0.6, life: 0.9, grow: 2.4 });
        }
      }
    }
    const special = k.surface === 'ice' || k.surface === 'milk' || k.surface === 'mud';
    if ((k.offroad || special) && k.grounded && Math.abs(speed) > 5) {
      // ground spray by surface / theme: grass bits + leaves, dirt clods, snow powder, milk splashes, ice glitter
      const sc = sprayColor(fx.theme, k.surface);
      const rc = this.kart.rearContacts[Math.random() < 0.5 ? 0 : 1];
      rc.getWorldPosition(tmp);
      const back = Math.min(1, Math.abs(speed) / 25);
      const vx = -fwx * 3 * back, vz = -fwz * 3 * back;
      if (k.offroad || k.surface !== 'ice') {
        if (Math.random() < 0.6 * emitRate) fx.smoke.emit({ x: tmp.x, y: tmp.y + 0.2, z: tmp.z, vx, vz, spread: 0.8, vy: 1.5 + back, color: sc.color, sprite: SPRITE.DUST, size: 0.55, life: 0.55, grow: 2, drag: 2, curve: 'shrink', spin: 1 });
      }
      if (!lowQ && Math.random() < 0.6 * D) {
        if (sc.chunk) fx.smoke.emit({ x: tmp.x, y: tmp.y + 0.2, z: tmp.z, vx: vx * 1.6, vz: vz * 1.6, vy: 3 + back * 2, spread: 1.4, color: sc.chunk, sprite: sc.sprite ?? SPRITE.SHARD, size: 0.22, life: 0.6, gravity: 14, spin: 10, floor: k.groundY + 0.05 });
        if (sc.glow) fx.glow.emit({ x: tmp.x, y: tmp.y + 0.2, z: tmp.z, vx: vx * 1.5, vz: vz * 1.5, spread: 1.2, vy: 2.5, color: sc.glow, sprite: sc.sprite ?? SPRITE.SOFT, size: 0.22, life: 0.45, gravity: 9, drag: 1, spin: 4, stretch: k.surface === 'milk' ? 1 : 0 });
      }
    }
    if (k.spinTime > 0) {
      // dizzy star swirl around the head
      for (let i = 0; i < 3; i++) {
        const a = time * 9 + (i * Math.PI * 2) / 3;
        fx.glow.emit({ x: this.interpPos.x + Math.cos(a) * 0.9, y: this.interpPos.y + 2.3, z: this.interpPos.z + Math.sin(a) * 0.9, color: '#ffe14a', sprite: SPRITE.STAR, size: 0.42, life: 0.16, curve: 'flash' });
      }
    }
    if (this.blown > 0 && Math.random() < 0.6 * emitRate * D) {
      const a = time * 7 + Math.random() * 6;
      fx.smoke.emit({ x: this.interpPos.x + Math.cos(a) * 1.6, y: this.interpPos.y + 0.4 + Math.random() * 2, z: this.interpPos.z + Math.sin(a) * 1.6, vx: -Math.sin(a) * 6, vz: Math.cos(a) * 6, vy: 2, color: Math.random() < 0.5 ? '#e8a43a' : '#9ccf4a', sprite: SPRITE.LEAF, size: 0.32, life: 0.6, drag: 1, spin: 8 });
    }
    if (k.turboDriftTime > 0 && Math.random() < 0.7 * emitRate) {
      // Turbo Drift: purple aura licking up around the kart
      const a = Math.random() * Math.PI * 2;
      fx.glow.emit({ x: this.interpPos.x + Math.cos(a) * 1.2, y: this.interpPos.y + 0.3, z: this.interpPos.z + Math.sin(a) * 1.4, vy: 2.5, spread: 0.3, color: '#e0a0ff', color2: '#7a2cff', sprite: SPRITE.FLAME, size: 0.7, life: 0.35, curve: 'shrink' });
      if (!lowQ) fx.glow.emit({ x: this.interpPos.x, y: this.interpPos.y + 1, z: this.interpPos.z, spread: 1.6, vy: 1.5, color: '#d58bff', sprite: SPRITE.SPARKLE, size: 0.35, life: 0.45, spin: 5, curve: 'shrink' });
    }
    if (k.itemRoulette > 0 && k.isHuman && Math.random() < 0.6 * emitRate) {
      // mystery roulette: rainbow sparkles popping above the driver
      const hue = (time * 1.5) % 1;
      fx.glow.emit({ x: this.interpPos.x, y: this.interpPos.y + 2.8, z: this.interpPos.z, spread: 1.4, vy: 1.2, color: new THREE.Color().setHSL(hue, 0.9, 0.6), sprite: Math.random() < 0.5 ? SPRITE.STAR : SPRITE.SPARKLE, size: 0.38, life: 0.5, spin: 6, curve: 'shrink' });
    }
    void tmp2;
  }

  /** Shield blocked a hit: ripple from `from` (world position of the threat, optional) and burst. */
  shieldBlock(from?: THREE.Vector3, keep = false): void {
    const dir = from ? tmp2.copy(from).sub(this.interpPos) : tmp2.set(Math.random() - 0.5, 0.3, Math.random() - 0.5);
    // into the shield's local (rotating) frame
    dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), -(this.interpYaw + this.shield.rotation.y));
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    this.shieldMat.ripple(dir);
    if (!keep) this.shieldPop = 0.45;
  }

  /** Shield colours: item bubble (cyan/violet) or Mom's special (pink/gold). */
  setShieldStyle(style: 'bubble' | 'mom'): void {
    this.shieldMat.uniforms.color.value.set(style === 'mom' ? '#ff6fc8' : '#5fd2ff');
    this.shieldMat.uniforms.color2.value.set(style === 'mom' ? '#ffd36a' : '#c58bff');
  }

  /** World position between the exhausts (heat shimmer anchor). */
  exhaustWorld(out: THREE.Vector3): THREE.Vector3 {
    const ex = this.kart.exhausts;
    if (!ex.length) return out.copy(this.interpPos).add(tmp.set(-Math.sin(this.interpYaw) * 1.3, 0.5, -Math.cos(this.interpYaw) * 1.3));
    out.set(0, 0, 0);
    for (const e of ex) out.add(e.getWorldPosition(tmp));
    return out.multiplyScalar(1 / ex.length);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.kart.dispose();
    this.character.dispose();
    this.shield.geometry.dispose();
    this.shieldMat.dispose();
    this.wind?.dispose();
    this.tornado?.dispose();
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.Material && (o === this.shadowBlob || this.flames.includes(o) || this.flameCores.includes(o))) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
    for (const g of this.flameGlows) g.material.dispose();
  }
}

let glowTex: THREE.Texture | null = null;
function makeGlowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
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
