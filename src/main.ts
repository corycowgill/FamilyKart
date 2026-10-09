import './ui/styles.css';
import { Game } from './game/Game';

const viewport = document.getElementById('viewport')!;
const ui = document.getElementById('ui')!;
const loader = document.getElementById('boot-loader')!;
const bar = loader.querySelector<HTMLElement>('.boot-bar div')!;

function fail(err: unknown): void {
  console.error(err);
  loader.classList.remove('hidden');
  loader.innerHTML = `<div class="boot-logo">Oops!</div><div style="max-width:560px;text-align:center;font-size:18px">Cowgill Kart Racing needs a browser with WebGL2 support. ${err instanceof Error ? err.message : ''}</div>`;
}

async function boot(): Promise<void> {
  const test = document.createElement('canvas');
  if (!test.getContext('webgl2')) throw new Error('WebGL2 is not available.');
  const game = new Game(viewport, ui);
  (window as unknown as { __game: Game }).__game = game;
  game.updateFpsVisibility();
  await game.start((p) => (bar.style.width = `${Math.round(p * 100)}%`));
  // let the Hallucinated Games ident finish before revealing the title (the game loads underneath it)
  await ((window as unknown as { __studioIntro?: Promise<void> }).__studioIntro ?? Promise.resolve());
  loader.classList.add('hidden');
  setTimeout(() => loader.remove(), 600);
}

boot().catch(fail);
