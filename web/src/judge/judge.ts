import '@fontsource-variable/fredoka/wght.css';
import '@fontsource-variable/figtree/wght.css';
import '../styles/tokens.css';
import './judge.css';

/** The hosted judge's page (D-163): two phones on the visitor's own market and three one-click steps. */

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// Side by side each phone follows only its own person, one event stream each: browsers allow six
// connections per origin on HTTP/1.1. A narrow screen has one phone and the app's Mia/Wei switch.
const PHONES = {
  mia: '/?demo=1&hosted=1&solo=1&phone=requester&as=mia&queuer=mia',
  wei: '/?demo=1&hosted=1&solo=1&phone=queuer&as=wei&queuer=wei',
  narrow: '/?demo=1&hosted=1&phone=requester&as=mia',
};

interface Info {
  market: 'alive' | 'none' | 'gone';
  marketMode: 'fake' | 'sandbox' | null;
  sandbox: { available: boolean; leftToday: number };
  demo: { status: string; stepIndex: number } | null;
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

const hold = el<HTMLButtonElement>('hold');
const run = el<HTMLButtonElement>('run');
const breakIt = el<HTMLButtonElement>('break');
const reset = el<HTMLButtonElement>('reset');
const sandbox = el<HTMLButtonElement>('sandbox');
const hint = el('hint');
const ids = el<HTMLOListElement>('ids');
const mia = el<HTMLIFrameElement>('mia');
const wei = el<HTMLIFrameElement>('wei');
const narrow = window.matchMedia('(max-width: 899px)');

function loadPhones(): void {
  mia.src = narrow.matches ? PHONES.narrow : PHONES.mia;
  if (!narrow.matches) wei.src = PHONES.wei;
  else wei.removeAttribute('src');
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
  const sandboxMode = info?.marketMode === 'sandbox';
  const running = status === 'running';
  const finished = status === 'finished';
  hold.disabled = sandboxMode || running || finished || broke || stepIndex > 2;
  breakIt.disabled = sandboxMode || running || finished || broke;
  el('break-step').hidden = sandboxMode;
  el('run').querySelector('span')!.textContent = sandboxMode ? 'Let Wei run the errand' : running ? 'Running…' : finished ? 'Done' : 'Run the whole errand';
  run.disabled = sandboxMode ? errandTimer !== 0 : running || finished || broke;
  el('note').textContent = sandboxMode ? "Your own private copy on PayPal's real sandbox. No real money moves." : 'Your own private copy. PayPal is simulated.';
  sandbox.hidden = !info?.sandbox.available || sandboxMode || info.sandbox.leftToday <= 0;
  const m = info?.money;
  el('held').textContent = usd(m?.heldCents ?? 0);
  el('captured').textContent = usd(m?.capturedCents ?? 0);
  el('released').textContent = usd(m?.releasedCents ?? 0);
  el('paid').textContent = usd(m?.paidCents ?? 0);
  if (finished && !sawFinish) say('The whole errand ran. Open the ops console to see it from the other side.');
  sawFinish = finished;
}

async function refresh(): Promise<void> {
  try {
    info = await call<Info>('GET', '/api/hosted/info');
  } catch {
    return;
  }
  el('gone').hidden = info.market !== 'gone';
  paint();
}

async function act(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    say(err instanceof Error ? err.message : 'That did not work.');
  }
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

sandbox.addEventListener('click', () => {
  void act(async () => {
    await call('POST', '/api/demo/session', { mode: 'sandbox' });
    say("Tap the plush on Mia's phone, set the fee, and approve in PayPal's window. The test login is in the Devpost notes.");
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

narrow.addEventListener('change', () => loadPhones());
loadPhones();
void refresh();
window.setInterval(() => {
  if (document.visibilityState === 'visible') void refresh();
}, 2000);
