import '@fontsource-variable/fredoka/wght.css';
import '@fontsource-variable/figtree/wght.css';
import '../styles/tokens.css';
import './judge.css';

/** The hosted judge's page (D-163): two phones on the visitor's own market, three one-click steps and two more scenes. */

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The scenes this page plays in the visitor's own market (server/src/demo/scripts): the hero errand behind
 * steps 1 to 3, and the two in "More scenes", each with the requester and the queuer its phones follow.
 */
interface Scene {
  requester: { id: string; name: string };
  queuer: { id: string; name: string };
  city: 'sf' | 'nyc';
  start: string;
  done: string;
}

const HERO_SCENE: Scene = {
  requester: { id: 'mia', name: 'Mia' },
  queuer: { id: 'wei', name: 'Wei' },
  city: 'sf',
  start: '',
  done: 'The whole errand ran. Open the ops console to see it from the other side.',
};

const SCENES: Record<string, Scene> = {
  hero: HERO_SCENE,
  'local-errand': {
    requester: { id: 'jun', name: 'Jun' },
    queuer: { id: 'dana', name: 'Dana' },
    city: 'nyc',
    start: "Jun asks for a shortcake in New York; Dana checks in, buys it and hands it over with Jun's code. About a minute.",
    done: "Done: one capture at the handover code, and Dana is paid. Jun's phone shows the money.",
  },
  'sold-out': {
    ...HERO_SCENE,
    start: 'Wei and Rex check in at Paper Moon Toys, then both report the Mochi Bunny plush sold out. About half a minute.',
    done: "Done: two reports closed the book, so every hold on the plush was released and $0 was charged. Mia's and Wei's phones say so.",
  },
};

// Side by side each phone follows only its own person, one event stream each: browsers allow six
// connections per origin on HTTP/1.1. A narrow screen has one phone and the app's person switch.
// `backend=server`: the phones always use this visitor's market, even when two 3D maps loading at once
// slow the app's quick health probe past its timeout.
function phoneUrls(scene: Scene): { left: string; right: string; narrow: string } {
  const base = `/?demo=1&hosted=1&backend=server${scene.city === 'sf' ? '' : `&city=${scene.city}`}`;
  const r = scene.requester.id;
  const q = scene.queuer.id;
  return {
    left: `${base}&solo=1&phone=requester&as=${r}&queuer=${r}`,
    right: `${base}&solo=1&phone=queuer&as=${q}&queuer=${q}`,
    narrow: `${base}&phone=requester&as=${r}${scene === HERO_SCENE ? '' : `&queuer=${q}`}`,
  };
}

interface Info {
  market: 'alive' | 'none' | 'gone';
  marketMode: 'fake' | 'sandbox' | null;
  sandbox: { available: boolean; leftToday: number };
  demo: { status: string; stepIndex: number; scriptId: string | null } | null;
  money: { heldCents: number; capturedCents: number; releasedCents: number; paidCents: number } | null;
}

interface ErrandStatus {
  errand: { status: string; steps: string[]; error: string | null } | null;
  ledger: { kind: string; amount: string; status: string; paypalId: string | null }[];
}

let broke = false;
let sawFinish = false;
let info: Info | null = null;
let errandTimer = 0;
/** The scene the phones were last pointed at. */
let shown = 'hero';

const hold = el<HTMLButtonElement>('hold');
const run = el<HTMLButtonElement>('run');
const breakIt = el<HTMLButtonElement>('break');
const reset = el<HTMLButtonElement>('reset');
const sandbox = el<HTMLButtonElement>('sandbox');
const sandboxChoice = el('sandbox-choice');
const scenes = el('scenes');
const sceneButtons = [...scenes.querySelectorAll<HTMLButtonElement>('button[data-scene]')];
const hint = el('hint');
const ids = el<HTMLOListElement>('ids');
const mia = el<HTMLIFrameElement>('mia');
const wei = el<HTMLIFrameElement>('wei');
const narrow = window.matchMedia('(max-width: 899px)');

const sceneOf = (id: string | null | undefined): Scene => SCENES[id ?? 'hero'] ?? HERO_SCENE;

/** Points both phones at the scene's two people (and their city). */
function loadPhones(id = 'hero'): void {
  shown = SCENES[id] ? id : 'hero';
  const scene = sceneOf(shown);
  const urls = phoneUrls(scene);
  mia.src = narrow.matches ? urls.narrow : urls.left;
  if (!narrow.matches) wei.src = urls.right;
  else wei.removeAttribute('src');
  el('left-name').textContent = scene.requester.name;
  el('right-name').textContent = scene.queuer.name;
  el('paid-label').textContent = `${scene.queuer.name} paid`;
  mia.title = `${scene.requester.name}'s phone`;
  wei.title = `${scene.queuer.name}'s phone`;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  const json = (text ? JSON.parse(text) : null) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(json?.error?.message ?? `The server answered ${res.status}.`);
  return json;
}

function say(text: string): void {
  hint.textContent = text;
}

function paint(): void {
  const status = info?.demo?.status ?? 'idle';
  const stepIndex = info?.demo?.stepIndex ?? 0;
  const scriptId = info?.demo?.scriptId ?? 'hero';
  // Another scene plays on its own: steps 1 to 3 wait for Start over.
  const otherScene = scriptId !== 'hero';
  const sandboxMode = info?.marketMode === 'sandbox';
  const running = status === 'running';
  const finished = status === 'finished';
  hold.disabled = sandboxMode || otherScene || running || finished || broke || stepIndex > 2;
  breakIt.disabled = sandboxMode || otherScene || running || finished || broke;
  el('break-step').hidden = sandboxMode;
  el('run').querySelector('span')!.textContent = sandboxMode ? 'Let Wei run the errand' : running ? 'Running…' : finished ? 'Done' : 'Run the whole errand';
  run.disabled = sandboxMode ? errandTimer !== 0 : otherScene || running || finished || broke;
  el('note').textContent = sandboxMode ? "Your own private copy on PayPal's real sandbox. No real money moves." : 'Your own private copy. PayPal is simulated.';
  sandboxChoice.hidden = !info?.sandbox.available || sandboxMode || info.sandbox.leftToday <= 0;
  scenes.hidden = sandboxMode;
  for (const b of sceneButtons) b.setAttribute('aria-pressed', String(b.dataset.scene === scriptId));
  // A reload, or a scene started elsewhere: point the phones at this scene's people when they are others.
  if (info && scriptId !== shown) {
    if (phoneUrls(sceneOf(scriptId)).left !== phoneUrls(sceneOf(shown)).left) loadPhones(scriptId);
    else shown = scriptId;
  }
  const m = info?.money;
  el('held').textContent = usd(m?.heldCents ?? 0);
  el('captured').textContent = usd(m?.capturedCents ?? 0);
  el('released').textContent = usd(m?.releasedCents ?? 0);
  el('paid').textContent = usd(m?.paidCents ?? 0);
  if (finished && !sawFinish) say(sceneOf(scriptId).done);
  sawFinish = finished;
}

/** Counts the page's own actions, so a poll that was in flight while one changed the market is dropped. */
let epoch = 0;

async function refresh(): Promise<void> {
  const asked = epoch;
  let got: Info;
  try {
    got = await call<Info>('GET', '/api/hosted/info');
  } catch {
    return;
  }
  if (asked !== epoch) return;
  info = got;
  el('gone').hidden = info.market !== 'gone';
  paint();
}

async function act(fn: () => Promise<unknown>): Promise<void> {
  epoch++;
  try {
    await fn();
  } catch (err) {
    say(err instanceof Error ? err.message : 'That did not work.');
  }
  epoch++;
  await refresh();
}

hold.addEventListener('click', () => {
  void act(async () => {
    await call('POST', '/api/hosted/hold', {});
    say('PayPal now holds the most this errand could cost. Nothing is charged.');
  });
});

run.addEventListener('click', () => {
  void act(async () => {
    if (info?.marketMode === 'sandbox') {
      await call('POST', '/api/hosted/errand', {});
      say('Wei is running the errand on PayPal’s sandbox.');
      followErrand();
      return;
    }
    await call('POST', '/api/hosted/run', {});
    say('Watch both phones. It takes about a minute and a half.');
  });
});

breakIt.addEventListener('click', () => {
  void act(async () => {
    await call('POST', '/api/hosted/break', {});
    broke = true;
    wei.contentWindow?.postMessage({ type: 'hms:break' }, window.location.origin);
    say('Wei has sample photos and “Fake receipt” is picked. Press Send on his phone: receipts that fail the checks move $0.');
  });
});

reset.addEventListener('click', () => {
  void act(async () => {
    await call('POST', '/api/demo/reset', { scriptId: 'hero' });
    broke = false;
    window.clearInterval(errandTimer);
    errandTimer = 0;
    ids.hidden = true;
    say('');
    loadPhones();
  });
});

for (const button of sceneButtons) {
  button.addEventListener('click', () => {
    const id = button.dataset.scene!;
    say('Setting up the scene…');
    void act(async () => {
      await call('POST', '/api/demo/start', { scriptId: id, speed: 60 });
      broke = false;
      sawFinish = false;
      ids.hidden = true;
      loadPhones(id);
      say(sceneOf(id).start);
    });
  });
}

sandbox.addEventListener('click', () => {
  void act(async () => {
    await call('POST', '/api/demo/session', { mode: 'sandbox' });
    say("Tap the plush on Mia's phone, set the fee, and approve in PayPal's window with the sandbox buyer login from the Devpost testing instructions.");
    loadPhones();
  });
});

el('again').addEventListener('click', () => window.location.reload());

function showErrand(s: ErrandStatus): void {
  if (s.errand?.status === 'failed') say(`The errand stopped: ${s.errand.error ?? 'unknown error'}`);
  else if (s.errand?.status === 'done') say('Done. These are PayPal’s own ids.');
  ids.hidden = s.ledger.length === 0;
  ids.replaceChildren(
    ...s.ledger.map((e) => {
      const li = document.createElement('li');
      li.textContent = `${e.kind} ${e.amount} ${e.status}${e.paypalId ? ` · ${e.paypalId}` : ''}`;
      return li;
    }),
  );
}

function followErrand(): void {
  window.clearInterval(errandTimer);
  errandTimer = window.setInterval(() => {
    void call<ErrandStatus>('GET', '/api/hosted/errand').then((s) => {
      showErrand(s);
      if (s.errand?.status !== 'running') {
        window.clearInterval(errandTimer);
        errandTimer = 0;
        void refresh();
      }
    });
  }, 3000);
}

narrow.addEventListener('change', () => loadPhones(shown));
loadPhones();
void refresh();
window.setInterval(() => {
  if (document.visibilityState === 'visible') void refresh();
}, 2000);
