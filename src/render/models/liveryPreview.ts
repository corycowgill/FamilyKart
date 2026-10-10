/**
 * Dev preview for kart paint jobs (served by `npx vite` at /livery-preview.html).
 *
 *   ?liv=lTrain              one livery on all six karts (default: chicagoFlag); liv=factory = no livery
 *   ?liv=all&ids=dad          every livery on one kart, in a grid
 *   ?ids=dad,lupin           which karts (comma separated)
 *   ?yaw=30                  turntable yaw in degrees (default 35)
 *   ?cam=front|side|back|top camera preset
 *   ?night=1                 dark lighting (check neon / sodium glow)
 *
 * Sets window.__ready once rendered.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CHARACTERS, characterById } from '../../data/characters';
import type { CharacterId } from '../../sim/types';
import { buildCharacter } from './characterModels';
import { buildKart, clearLiveries, setLivery } from './kartModels';
import { LIVERIES, liveryById, type LiveryId } from './liveries';

declare global {
  interface Window {
    __ready?: boolean;
  }
}

const q = new URLSearchParams(location.search);
const livParam = q.get('liv') ?? 'chicagoFlag';
const ids = (q.get('ids')?.split(',') as CharacterId[] | undefined) ?? CHARACTERS.map((c) => c.id);
const yaw = ((q.has('yaw') ? Number(q.get('yaw')) : 35) * Math.PI) / 180;
const cam = q.get('cam') ?? 'front';
const night = q.get('night') === '1';

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = night ? 0.9 : 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(night ? '#0b1030' : '#8fcbff');
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = night ? 0.12 : 0.6;
scene.add(new THREE.HemisphereLight(night ? '#3a4a90' : '#d8ecff', '#4a3a30', night ? 0.35 : 1.1));
const sun = new THREE.DirectionalLight(night ? '#9fb0ff' : '#fff3dd', night ? 0.4 : 2.6);
sun.position.set(6, 11, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 50 });
scene.add(sun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshStandardMaterial({ color: night ? '#22253a' : '#c9d3c2', roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

type Cell = { id: CharacterId; liv: LiveryId | null; label: string };
const cells: Cell[] = [];
if (livParam === 'all') {
  for (const id of ids) {
    cells.push({ id, liv: null, label: `${characterById(id).name}: factory` });
    for (const l of LIVERIES) cells.push({ id, liv: l.id, label: l.name });
  }
} else {
  const liv = livParam === 'factory' ? null : (livParam as LiveryId);
  for (const id of ids) cells.push({ id, liv, label: characterById(id).name });
}

const cols = cells.length <= 3 ? cells.length : cells.length <= 6 ? 3 : cells.length <= 10 ? 5 : 6;
const rows = Math.ceil(cells.length / cols);
const sx = 3.0;
const sz = 3.4;
cells.forEach((c, i) => {
  clearLiveries();
  setLivery(c.id, c.liv);
  const kart = buildKart(characterById(c.id));
  const ch = buildCharacter(c.id);
  kart.seat.add(ch.root);
  ch.update(0.016, { steer: 0, speed: 0, drifting: false, driftDir: 0, airborne: false, boosting: false, reaction: 'none', reactionTime: 0, time: 0.4 });
  const col = i % cols;
  const row = Math.floor(i / cols);
  kart.root.position.set((col - (cols - 1) / 2) * sx, 0, (row - (rows - 1) / 2) * sz);
  kart.root.rotation.y = yaw;
  scene.add(kart.root);
});

const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.05, 300);
const span = Math.max(cols * sx, rows * sz * 1.4);
const d = span * (cells.length <= 3 ? 0.95 : 1.2) + 2.2;
switch (cam) {
  case 'side':
    camera.position.set(0, d * 0.25, d);
    break;
  case 'back':
    camera.position.set(-d * 0.3, d * 0.45, -d * 0.9);
    break;
  case 'top':
    camera.position.set(0, d, d * 0.35);
    break;
  default:
    camera.position.set(0, d * 0.55, d * 0.85);
}
camera.lookAt(0, 0.4, 0);

const hud = document.getElementById('hud')!;
hud.textContent = livParam === 'all' ? `${characterById(ids[0]).name}: all liveries (factory, ${LIVERIES.map((l) => l.name).join(', ')})` : livParam === 'factory' ? 'Factory paint' : `${liveryById(livParam as LiveryId).name}`;

renderer.render(scene, camera);
requestAnimationFrame(() => {
  renderer.render(scene, camera);
  window.__ready = true;
});
