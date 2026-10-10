import * as THREE from 'three';
import { damp } from '../core/math';
import type { Track } from '../sim/track/Track';

export interface CameraTarget {
  pos: THREE.Vector3;
  yaw: number;
  speed: number;
  maxSpeed: number;
  boosting: boolean;
  drifting: boolean;
  driftDir: number;
  airborne: boolean;
  rearView: boolean;
}

/**
 * Spring-damped third-person chase camera: looks ahead, pulls back with speed, widens FOV on boost,
 * leans in drifts, reacts to jumps and keeps itself above the road to avoid clipping into scenery.
 */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  private camPos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private yaw = 0;
  private dist = 6.5;
  private height = 2.6;
  private fov = 68;
  private roll = 0;
  private initialized = false;
  private shake = 0;
  config = { baseDist: 6.2, speedDist: 2.2, baseHeight: 2.5, lookAhead: 6, baseFov: 66, boostFov: 12, yawFollow: 6, posFollow: 9 };

  constructor(private track?: Track) {
    this.camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.3, 4000);
  }

  snap(t: CameraTarget): void {
    this.initialized = false;
    this.update(t, 1 / 60);
  }

  private rear = false;
  /** true while the player looks backwards (no exhaust heat shimmer then) */
  get isRearView(): boolean {
    return this.rear;
  }

  /** Boost "punch": an instant FOV burst that the spring then eases back (anticipation -> burst -> settle). */
  kick(amount: number): void {
    this.fov += 7 * amount;
  }

  addShake(v: number): void {
    this.shake = Math.min(1, this.shake + v);
  }

  update(t: CameraTarget, dt: number): void {
    const c = this.config;
    const sp01 = Math.min(1.4, Math.max(0, t.speed / t.maxSpeed));
    this.rear = t.rearView;
    let targetYaw = t.yaw + (t.drifting ? -t.driftDir * 0.18 : 0);
    if (t.rearView) targetYaw += Math.PI;
    if (!this.initialized) {
      this.yaw = targetYaw;
    } else {
      let d = targetYaw - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * (1 - Math.exp(-(t.rearView ? 30 : c.yawFollow) * dt));
    }
    this.dist = damp(this.dist, c.baseDist + c.speedDist * sp01 + (t.boosting ? 0.8 : 0), 3, dt);
    this.height = damp(this.height, c.baseHeight + (t.airborne ? 0.9 : 0), 3, dt);
    this.fov = damp(this.fov, c.baseFov + sp01 * 6 + (t.boosting ? c.boostFov : 0), 4, dt);
    this.roll = damp(this.roll, t.drifting ? t.driftDir * 0.04 : 0, 4, dt);

    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const desired = new THREE.Vector3(t.pos.x - fx * this.dist, t.pos.y + this.height, t.pos.z - fz * this.dist);
    // keep camera above the road surface under it
    if (this.track) {
      const q = this.track.query(desired, 0);
      if (q && !q.inGap) desired.y = Math.max(desired.y, q.groundY + 1.4);
    }
    if (!this.initialized) {
      this.camPos.copy(desired);
      this.look.set(t.pos.x + fx * c.lookAhead, t.pos.y + 1.2, t.pos.z + fz * c.lookAhead);
      this.initialized = true;
    } else {
      const k = 1 - Math.exp(-c.posFollow * dt);
      this.camPos.x += (desired.x - this.camPos.x) * k;
      this.camPos.z += (desired.z - this.camPos.z) * k;
      this.camPos.y += (desired.y - this.camPos.y) * (1 - Math.exp(-5 * dt));
      // never fall too far behind (big boosts)
      const dx = this.camPos.x - t.pos.x, dz = this.camPos.z - t.pos.z;
      const d = Math.hypot(dx, dz);
      const maxD = this.dist * 1.6;
      if (d > maxD) {
        this.camPos.x = t.pos.x + (dx / d) * maxD;
        this.camPos.z = t.pos.z + (dz / d) * maxD;
      }
      const lk = 1 - Math.exp(-14 * dt);
      const lx = t.pos.x + fx * c.lookAhead, lz = t.pos.z + fz * c.lookAhead, ly = t.pos.y + 1.2;
      this.look.x += (lx - this.look.x) * lk;
      this.look.y += (ly - this.look.y) * (1 - Math.exp(-6 * dt));
      this.look.z += (lz - this.look.z) * lk;
    }
    this.camera.position.copy(this.camPos);
    if (this.shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.25;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.25;
      this.shake = Math.max(0, this.shake - dt * 3);
    }
    this.camera.up.set(Math.sin(this.roll) * Math.cos(this.yaw) * -1, 1, Math.sin(this.roll) * Math.sin(this.yaw));
    this.camera.lookAt(this.look);
    if (Math.abs(this.camera.fov - this.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
