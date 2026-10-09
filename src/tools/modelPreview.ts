/**
 * Dev preview for the procedural kart + character models.
 *
 *   /model-preview.html                     all six karts in a row on turntables
 *   ?id=lupin                               one racer, big
 *   ?anim=win|hit|drift|steerLeft|steerRight|idle|item|jump|lose|overtake|boost
 *   ?cam=front|chase|side|face|top|back      camera preset (default front 3/4)
 *   ?yaw=30                                 fixed turntable yaw in degrees (default: spinning)
 *   ?freeze=1.3                             simulate exactly N seconds then stop (deterministic screenshots)
 *   ?speed=20                               forward speed (wheel spin, ear flap...)
 *   ?hud=0                                  hide the info overlay
 *
 * Sets window.__ready = true once something has been rendered and window.__tris to triangle counts.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CHARACTERS, characterById } from '../data/characters';
import type { CharacterId } from '../sim/types';
import { buildCharacter } from '../render/models/characterModels';
import { buildKart } from '../render/models/kartModels';
import { countTriangles } from '../render/models/materials';
import type { CharacterAnimState, CharacterRig, KartRig } from '../render/models/types';

const q = new URLSearchParams(location.search);
const only = q.get('id') as CharacterId | null;
const anim = q.get('anim') ?? 'idle';
const cam = q.get('cam') ?? 'front';
const yawParam = q.get('yaw');
const freeze = q.get('freeze') !== null ? Number(q.get('freeze')) : null;
const speedParam = q.get('speed') !== null ? Number(q.get('speed')) : null;

declare global {
  interface Window {
    __ready?: boolean;
    __tris?: Record<string, number>;
  }
}

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
{
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#4fa3f7');
  g.addColorStop(0.6, '#a9d8ff');
  g.addColorStop(1, '#ffe7c4');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  scene.background = t;
}
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

scene.add(new THREE.HemisphereLight('#d8ecff', '#7a6a4a', 1.1));
const sun = new THREE.DirectionalLight('#fff3dd', 2.6);
sun.position.set(6, 11, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -10;
sc.right = 10;
sc.top = 10;
sc.bottom = -10;
sc.near = 1;
sc.far = 40;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun);
const rim = new THREE.DirectionalLight('#c8dcff', 0.9);
rim.position.set(-6, 5, -8);
scene.add(rim);

const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.MeshStandardMaterial({ color: '#c9d3c2', roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

interface Entry {
  id: CharacterId;
  turntable: THREE.Group;
  kart: KartRig;
  char: CharacterRig;
  wheelR: number[];
}

const ids: CharacterId[] = only ? [only] : CHARACTERS.map((c) => c.id);
const spacing = 2.9;
const entries: Entry[] = [];
const tris: Record<string, number> = {};
ids.forEach((id, i) => {
  const def = characterById(id);
  const kart = buildKart(def);
  const char = buildCharacter(id);
  kart.seat.add(char.root);
  const tt = new THREE.Group();
  if (ids.length > 3) {
    // 3 x 2 grid so every racer is readable
    tt.position.set(((i % 3) - 1) * spacing, 0, i < 3 ? 1.6 : -1.9);
  } else tt.position.x = (i - (ids.length - 1) / 2) * spacing;
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.3, 0.06, 48), new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.7 }));
  disc.position.y = -0.03;
  disc.receiveShadow = true;
  tt.add(disc);
  tt.add(kart.root);
  scene.add(tt);
  const wheelR = kart.wheels.map((w) => {
    const b = new THREE.Box3().setFromObject(w);
    return Math.max(0.1, (b.max.y - b.min.y) / 2);
  });
  entries.push({ id, turntable: tt, kart, char, wheelR });
  tris[id] = countTriangles(kart.root);
  tris[`${id}:character`] = countTriangles(char.root);
});
window.__tris = tris;

// ---- camera ----
const camera = new THREE.PerspectiveCamera(only ? 32 : 36, window.innerWidth / window.innerHeight, 0.05, 200);
const single = !!only;
const look = new THREE.Vector3(0, single ? 0.85 : 0.5, single ? 0 : -0.3);
switch (cam) {
  case 'chase':
    camera.position.set(0, single ? 2.3 : 4.6, single ? -5.2 : -10.5);
    break;
  case 'side':
    camera.position.set(single ? 5.5 : 0, single ? 1.3 : 2.4, single ? 0 : 11.5);
    break;
  case 'face':
    camera.position.set(0.25, 1.75, 2.1);
    look.set(0, 1.5, 0);
    camera.fov = 26;
    break;
  case 'top':
    camera.position.set(single ? 3.2 : 4, single ? 4.5 : 9, single ? 3.2 : 9);
    break;
  case 'back':
    camera.position.set(single ? -2.8 : -5, single ? 2.0 : 3.5, single ? -3.6 : -10);
    break;
  default:
    camera.position.set(single ? 2.4 : 0, single ? 1.7 : 4.4, single ? 4.0 : 10.5);
}
camera.lookAt(look);
camera.updateProjectionMatrix();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- animation driver ----
const REACT_DUR: Record<string, number> = { hit: 1.2, item: 0.6, overtake: 0.9, jump: 0.8 };

function stateAt(time: number, prev: CharacterAnimState | null): CharacterAnimState {
  const s: CharacterAnimState = {
    steer: 0, speed: speedParam ?? (anim === 'idle' ? 0 : 18), drifting: false, driftDir: 0, airborne: false, boosting: false,
    reaction: 'none', reactionTime: 0, time,
  };
  switch (anim) {
    case 'steerLeft':
      s.steer = -1;
      break;
    case 'steerRight':
      s.steer = 1;
      break;
    case 'drift':
      s.steer = -0.7;
      s.drifting = true;
      s.driftDir = -1;
      break;
    case 'boost':
      s.boosting = true;
      s.speed = speedParam ?? 28;
      break;
    case 'win':
    case 'lose':
      s.reaction = anim;
      s.reactionTime = 9999;
      s.speed = speedParam ?? 6;
      break;
    case 'hit':
    case 'item':
    case 'overtake':
    case 'jump': {
      const dur = REACT_DUR[anim];
      const period = dur + 0.6;
      const ph = (time + 0.0001) % period;
      if (ph < dur) {
        s.reaction = anim as CharacterAnimState['reaction'];
        s.reactionTime = dur - ph;
        if (anim === 'jump') s.airborne = true;
      }
      break;
    }
    default:
      break;
  }
  void prev;
  return s;
}

const hud = document.getElementById('hud')!;
if (q.get('hud') === '0') hud.classList.add('hidden');
hud.textContent =
  `anim=${anim} cam=${cam}\n` +
  entries.map((e) => `${e.id.padEnd(8)} kart+driver ${tris[e.id]} tris (driver ${tris[`${e.id}:character`]})`).join('\n');

let simTime = 0;
let prevState: CharacterAnimState | null = null;
function step(dt: number) {
  simTime += dt;
  const s = stateAt(simTime, prevState);
  prevState = s;
  for (const e of entries) {
    e.char.update(dt, s);
    e.kart.wheels.forEach((w, i) => {
      w.rotation.x += (s.speed / e.wheelR[i]) * dt;
    });
    for (const p of e.kart.frontPivots) p.rotation.y = -s.steer * 0.4;
    e.kart.body.rotation.z = s.steer * 0.04 + (s.drifting ? s.driftDir * 0.05 : 0);
    const yaw = yawParam !== null ? (Number(yawParam) * Math.PI) / 180 : simTime * 0.45;
    e.turntable.rotation.y = yaw;
    if (s.reaction === 'win') e.kart.body.position.y = Math.abs(Math.sin(simTime * 7)) * 0.03;
  }
}

if (freeze !== null) {
  const dt = 1 / 60;
  const n = Math.max(1, Math.round(freeze / dt));
  for (let i = 0; i < n; i++) step(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(() => {
    renderer.render(scene, camera);
    window.__ready = true;
  });
} else {
  let last = performance.now();
  let frames = 0;
  const loop = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    renderer.render(scene, camera);
    if (++frames === 5) window.__ready = true;
    requestAnimationFrame(loop);
  };
  loop();
}
