/**
 * Dev preview for tracks & environments.
 * track-preview.html?track=<id>&cam=overview|start|chase&s=<meters>&quality=high&debug=1&karts=1&t=<seconds>
 * Orbit: drag to rotate (overview), keys 1/2/3 switch camera, space toggles fly-along.
 */
import * as THREE from 'three';
import { TRACKS, trackById } from '../data/tracks';
import { Environment } from '../render/Environment';
import { SCENERY } from '../render/scenery';
import { buildTrackView } from '../render/track/TrackView';
import { Track } from '../sim/track/Track';

const params = new URLSearchParams(location.search);
const trackId = params.get('track') ?? 'chicago';
const quality = (params.get('quality') ?? 'high') as 'low' | 'medium' | 'high';
let camMode = params.get('cam') ?? 'overview';
let camS = Number(params.get('s') ?? 0);
const fixedTime = params.get('t') !== null ? Number(params.get('t')) : null;
const showKarts = params.get('karts') !== '0';
const pathParam = Number(params.get('path') ?? 0);
const hud = document.getElementById('hud')!;

const def = trackById(trackId);
const track = new Track(def);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = quality !== 'low';
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 6000);
const env = new Environment(scene, def.lighting, quality);
let view = buildTrackView(track, quality);
scene.add(view.group);
view.showDebug?.(params.get('debug') === '1');

// simple kart stand-ins on the grid for scale
if (showKarts) {
  const colors = ['#e8443a', '#2f7de1', '#ffd23f', '#3ccf6e', '#ff7ac8', '#8a5cf0'];
  const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.3, 12).rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1b });
  track.startGrid(6).forEach((g, i) => {
    const k = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.55, 2.2), new THREE.MeshStandardMaterial({ color: colors[i], roughness: 0.35 }));
    body.position.y = 0.5;
    body.castShadow = true;
    k.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 8), new THREE.MeshStandardMaterial({ color: '#f1c8a5' }));
    head.position.set(0, 1.25, -0.2);
    head.castShadow = true;
    k.add(head);
    for (const [x, z] of [[-0.75, 0.75], [0.75, 0.75], [-0.75, -0.75], [0.75, -0.75]]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(x, 0.32, z);
      k.add(w);
    }
    k.position.set(g.pos.x, g.pos.y, g.pos.z);
    k.rotation.y = g.yaw;
    scene.add(k);
  });
}

let scenery: { update(dt: number, t: number): void; dispose?(): void } | null = null;
const sceneryGroup = new THREE.Group();
scene.add(sceneryGroup);
const t0 = performance.now();
SCENERY[def.theme]()
  .then((build) => {
    scenery = build({ track, group: sceneryGroup, quality });
    if (params.get('rebuild') === '1') {
      // exercise dispose + rebuild (leak / double-dispose check)
      renderer.render(scene, camera);
      scenery.dispose?.();
      view.dispose();
      const before = renderer.info.memory.geometries;
      view = buildTrackView(track, quality);
      scene.add(view.group);
      scenery = build({ track, group: sceneryGroup, quality });
      console.log(`rebuild ok (geometries after dispose ${before})`);
    }
  })
  .catch((e) => {
    console.error(e);
    hud.textContent = String(e);
  })
  .finally(() => {
    const ms = performance.now() - t0;
    // let a couple of frames render before flagging ready (screenshots)
    let frames = 0;
    const wait = () => {
      if (++frames > 3) {
        (window as unknown as { __ready: boolean }).__ready = true;
        let tris = 0, calls = 0;
        renderer.render(scene, camera);
        tris = renderer.info.render.triangles;
        calls = renderer.info.render.calls;
        console.log(`build ${ms.toFixed(0)}ms, draw calls ${calls}, triangles ${tris}`);
        (window as unknown as { __stats: unknown }).__stats = { calls, tris, buildMs: ms };
      } else requestAnimationFrame(wait);
    };
    requestAnimationFrame(wait);
  });

// --- camera
const bounds = view.field.bounds;
const center = new THREE.Vector3((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
let orbitYaw = Number(params.get('yaw') ?? 0.6);
let orbitPitch = Number(params.get('pitch') ?? 0.95);
let orbitDist = span * Number(params.get('zoom') ?? 0.95);
let flying = false;

function placeCamera(): THREE.Vector3 {
  if (camMode === 'overview') {
    const p = new THREE.Vector3(
      center.x + Math.sin(orbitYaw) * Math.cos(orbitPitch) * orbitDist,
      Math.sin(orbitPitch) * orbitDist,
      center.z + Math.cos(orbitYaw) * Math.cos(orbitPitch) * orbitDist,
    );
    camera.position.copy(p);
    camera.lookAt(center);
    return center;
  }
  if (camMode === 'look') {
    const p = (params.get('p') ?? '0,50,0').split(',').map(Number);
    const a = (params.get('at') ?? '0,0,0').split(',').map(Number);
    camera.position.set(p[0], p[1], p[2]);
    const at = new THREE.Vector3(a[0], a[1], a[2]);
    camera.lookAt(at);
    return at;
  }
  const pid = camMode === 'chase' ? Math.min(pathParam, track.paths.length - 1) : 0;
  const s = camMode === 'start' ? track.length - 30 : camS;
  const a = track.sampleAt(pid, s);
  const b = track.sampleAt(pid, s + 6);
  const back = camMode === 'start' ? 14 : 6;
  const up = camMode === 'start' ? 6 : 2.5;
  const c = track.sampleAt(pid, s - back);
  camera.position.set(c.x, Math.max(c.y, a.y) + up, c.z);
  const look = new THREE.Vector3(b.x + b.tx * 6, b.y + 1.2, b.z + b.tz * 6);
  camera.lookAt(look);
  return new THREE.Vector3(a.x, a.y, a.z);
}

let dragging = false;
let lx = 0, ly = 0;
renderer.domElement.addEventListener('pointerdown', (e) => {
  dragging = true;
  lx = e.clientX;
  ly = e.clientY;
});
window.addEventListener('pointerup', () => (dragging = false));
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  orbitYaw -= (e.clientX - lx) * 0.005;
  orbitPitch = Math.min(1.5, Math.max(0.1, orbitPitch + (e.clientY - ly) * 0.005));
  lx = e.clientX;
  ly = e.clientY;
});
window.addEventListener('wheel', (e) => (orbitDist *= e.deltaY > 0 ? 1.1 : 0.9));
window.addEventListener('keydown', (e) => {
  if (e.key === '1') camMode = 'overview';
  if (e.key === '2') camMode = 'start';
  if (e.key === '3') camMode = 'chase';
  if (e.key === ' ') {
    camMode = 'chase';
    flying = !flying;
  }
  if (e.key === 'd') view.showDebug?.(true);
  if (e.key === 'n') {
    const i = TRACKS.findIndex((t) => t.id === trackId);
    location.search = `?track=${TRACKS[(i + 1) % TRACKS.length].id}`;
  }
});
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

let last = performance.now();
let time = fixedTime ?? 0;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (fixedTime === null) time += dt;
  if (flying) camS += dt * 28;
  const focus = placeCamera();
  env.follow(focus);
  view.update(dt, time);
  scenery?.update(dt, time);
  renderer.render(scene, camera);
  hud.textContent = `${def.name}  len ${track.length.toFixed(0)}m  cam ${camMode} s=${camS.toFixed(0)}  calls ${renderer.info.render.calls} tris ${renderer.info.render.triangles}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
