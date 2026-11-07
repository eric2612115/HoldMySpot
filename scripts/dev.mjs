#!/usr/bin/env node
// Starts HoldMySpot: the server, the web app and the ops console together, waits until each
// answers, prints the URLs and what to click, and stops everything it started on Ctrl-C.
//
//   npm run demo                     zero keys: simulated PayPal, recorded AI answers, a seeded market
//   npm run dev:sandbox              the real PayPal sandbox (keys from npm run keys), a live AI model when a key exists
//   npm run demo -- --ai live        simulated PayPal with a live AI model (needs an AI key)
//   npm run demo -- --port-offset 10 --no-ops
//   npm run gates -- plan            node scripts/sandbox-gates.mjs with the same secrets folder
//   npm run ai:eval -- --live        the AI accuracy eval (server/scripts/ai-eval.ts) with the same keys
//
// It stops only the processes it started (by process group). Logs go to .run/logs/.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AI_KEY_NAMES,
  DEFAULT_PORTS,
  REPO,
  RUN_DIR,
  bold,
  cyan,
  dim,
  fetchJson,
  green,
  launchEnv,
  licenceSources,
  packageStatus,
  portFree,
  portOwner,
  probeServer,
  red,
  requireNode,
  resolvePorts,
  shown,
  yellow,
} from './common.mjs';

const USAGE = `HoldMySpot launcher

  npm run demo [-- options]          simulated PayPal (no keys), recorded AI answers, seeded market
  npm run dev:sandbox [-- options]   the real PayPal sandbox; a live AI model when a key exists

Options:
  --mode demo|sandbox      PayPal: demo (simulated, the default) or sandbox (needs npm run keys)
  --ai auto|live|replay|rules
                           AI: auto (default: replay with simulated PayPal, live in sandbox when a key
                           exists), live (needs a key), replay (recorded answers), rules (no model at all)
  --port-offset <n>        add n to every default port (${DEFAULT_PORTS.server}, ${DEFAULT_PORTS.web}, ${DEFAULT_PORTS.ops})
  --server-port <p>, --web-port <p>, --ops-port <p>
  --no-web, --no-ops       do not start that app
  --no-ag-licence          ignore every AG licence key: the ops console runs in AG's trial mode
  --logs                   also print the apps' logs here (they always go to .run/logs/)
  --smoke                  start, check that everything answers, print the URLs, stop (exit 0 when healthy)
  --dry-run                print what would start, with which settings (names only); start nothing
  --no-install             do not run npm run setup when packages are missing
  --stop                   stop a launcher still running on these ports (only what it started)
  -h, --help

Also: npm run gates -- <args> and npm run ai:eval -- <args> run those tools with the same keys.
`;

const READY_TIMEOUT_MS = { server: 60_000, web: 120_000, ops: 120_000 };

function fail(message, code = 1) {
  console.error(`\n${red('Not started:')} ${message}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Pass-through tools that need the same secrets folder (gates, ai-eval)
// ---------------------------------------------------------------------------

function passthrough(tool, rest) {
  requireNode();
  const { server: env, secrets } = launchEnv({ mode: process.env.HMS_MODE || 'fake', ai: 'auto', ports: DEFAULT_PORTS, demo: false });
  delete env.HMS_PORT;
  delete env.HMS_MODE;
  delete env.HMS_WEB_ORIGINS;
  const target =
    tool === 'gates'
      ? { cwd: REPO, args: [path.join('scripts', 'sandbox-gates.mjs'), ...rest] }
      : { cwd: path.join(REPO, 'server'), args: ['--no-warnings', path.join('scripts', 'ai-eval.ts'), ...rest] };
  if (tool === 'ai-eval' && !packageStatus('server').installed) fail('server/ is not installed yet. Run: npm run setup');
  console.log(dim(`Secrets folder: ${secrets.source}`));
  const child = spawn(process.execPath, target.args, { cwd: target.cwd, env, stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

const children = [];
let stopping = false;
let streamLogs = false;

const WINDOWS = process.platform === 'win32';
let logPorts = DEFAULT_PORTS;

function logPath(name) {
  return path.join(RUN_DIR, 'logs', `${name}-${logPorts[name]}.log`);
}

/** Stops a child and everything it started: its process group, or its process tree on Windows. */
function killTree(pid, signal) {
  if (WINDOWS) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

function startChild(name, command, args, { cwd, env }) {
  fs.mkdirSync(path.dirname(logPath(name)), { recursive: true });
  const log = fs.openSync(logPath(name), 'w');
  const child = spawn(command, args, { cwd, env, detached: !WINDOWS, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { name, child, pid: child.pid, exited: null, log };
  const write = (chunk) => {
    try {
      fs.writeSync(log, chunk);
    } catch {
      // The log is advice only.
    }
    if (streamLogs) {
      for (const line of String(chunk).split('\n')) if (line.trim()) process.stdout.write(`${dim(`[${name}]`)} ${line}\n`);
    }
  };
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  child.on('exit', (code, signal) => {
    entry.exited = { code, signal };
    if (!stopping) {
      console.error(`\n${red(`${name} stopped on its own`)} (${signal ?? `exit ${code}`}). Last lines of ${shown(logPath(name))}:`);
      console.error(tail(logPath(name), 25));
      void shutdown(1);
    }
  });
  children.push(entry);
  return entry;
}

function tail(file, lines) {
  try {
    const text = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    return text.slice(-lines).map((l) => `    ${l}`).join('\n');
  } catch {
    return '    (no log)';
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM to each child's process group (vite's helpers included), SIGKILL after 6 s. */
async function stopChildren() {
  for (const c of children) if (!c.exited) killTree(c.pid, 'SIGTERM');
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && children.some((c) => !c.exited && alive(c.pid))) await sleep(100);
  for (const c of children) if (!c.exited && alive(c.pid)) killTree(c.pid, 'SIGKILL');
}

let pidFile = null;

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  if (children.length > 0) console.log(dim('\nStopping what this launcher started...'));
  await stopChildren();
  if (pidFile) fs.rmSync(pidFile, { force: true });
  process.exit(code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(name, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const entry = children.find((c) => c.name === name);
  while (Date.now() < deadline) {
    if (entry?.exited) return false;
    if (await check()) return true;
    await sleep(400);
  }
  return false;
}

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// --stop
// ---------------------------------------------------------------------------

function pidFileFor(ports) {
  return path.join(RUN_DIR, `dev-${ports.server}.json`);
}

/** The command line of a process (ps), to make sure a recorded pid is still ours before stopping it. */
function commandOf(pid) {
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

async function stopPrevious(ports) {
  const file = pidFileFor(ports);
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.log(`No launcher is recorded for server port ${ports.server} (${shown(file)} is missing).`);
    return 0;
  }
  let stopped = 0;
  if (rec.pid && alive(rec.pid) && commandOf(rec.pid).includes('scripts/dev.mjs')) {
    process.kill(rec.pid, 'SIGTERM');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && alive(rec.pid)) await sleep(150);
    stopped++;
  }
  for (const c of rec.children ?? []) {
    if (!c.pid || !alive(c.pid)) continue;
    const cmd = commandOf(c.pid);
    if (!c.match || !cmd.includes(c.match)) continue;
    killTree(c.pid, 'SIGTERM');
    stopped++;
  }
  fs.rmSync(file, { force: true });
  console.log(stopped > 0 ? `Stopped the launcher on server port ${ports.server}.` : 'Nothing recorded was still running.');
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parse(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string' },
      ai: { type: 'string' },
      'port-offset': { type: 'string' },
      'server-port': { type: 'string' },
      'web-port': { type: 'string' },
      'ops-port': { type: 'string' },
      'no-web': { type: 'boolean' },
      'no-ops': { type: 'boolean' },
      'no-ag-licence': { type: 'boolean' },
      logs: { type: 'boolean' },
      smoke: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'no-install': { type: 'boolean' },
      stop: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  return values;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'gates' || argv[0] === 'ai-eval') return passthrough(argv[0], argv.slice(1));

  let args;
  try {
    args = parse(argv);
  } catch (err) {
    fail(`${err.message}\nRun with --help for the options.`, 2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  requireNode();

  const mode = (args.mode ?? 'demo').toLowerCase();
  if (!['demo', 'fake', 'sandbox'].includes(mode)) fail('--mode must be demo or sandbox.', 2);
  const paypal = mode === 'sandbox' ? 'sandbox' : 'fake';
  const ai = (args.ai ?? 'auto').toLowerCase();
  if (!['auto', 'live', 'replay', 'rules'].includes(ai)) fail('--ai must be auto, live, replay or rules.', 2);
  let ports;
  try {
    ports = resolvePorts(args);
  } catch (err) {
    fail(err.message, 2);
  }
  if (args.stop) process.exit(await stopPrevious(ports));
  logPorts = ports;
  const apps = { web: !args['no-web'], ops: !args['no-ops'] };
  streamLogs = Boolean(args.logs);

  // Packages: install what is missing (npm run setup), unless told not to.
  const needed = ['shared', 'server', ...(apps.web ? ['web'] : []), ...(apps.ops ? ['ops'] : [])];
  const missing = needed.filter((p) => !packageStatus(p).installed);
  if (missing.length > 0) {
    if (args['no-install'] || args['dry-run']) fail(`not installed yet: ${missing.join(', ')}. Run: npm run setup`);
    console.log(yellow(`Packages not installed yet (${missing.join(', ')}): running npm run setup first.`));
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'setup.mjs'), '--only', missing.join(',')], { stdio: 'inherit' });
    if (r.status !== 0) fail('npm run setup failed (see above).');
  }
  for (const p of needed) {
    const s = packageStatus(p);
    if (s.installed && !s.upToDate) console.log(yellow(`${p}/: ${s.detail}. If something fails, run npm run setup.`));
  }

  // Settings, and the server's own view of them (PayPal mode, AI provider).
  const env = launchEnv({ mode: paypal, ai, ports });
  // --no-ag-licence: the ops console ignores every AG key (ops/vite.config.ts reads HMS_AG_TRIAL).
  if (args['no-ag-licence']) env.ops.HMS_AG_TRIAL = '1';
  const studioLicence = licenceSources(env.ops).studio;
  const probe = probeServer(env.server);
  if (!probe.ok) fail(`could not read the server settings (${probe.error}). Run npm run doctor.`);
  const view = probe.value;
  if (paypal === 'sandbox' && view.mode !== 'sandbox') {
    const missingNames = /missing (.+?): running fake/.exec(view.modeReason)?.[1] ?? '';
    fail(
      [
        `PayPal sandbox mode needs credentials the server could not find.`,
        `  Secrets folder: ${env.secrets.source}${env.secrets.pass ? ` (${shown(env.secrets.dir)})` : ''}`,
        `  Missing: ${missingNames || view.modeReason}`,
        `  Fix: npm run keys (asks for the sandbox app's client ID and secret, a sandbox buyer email and a payout`,
        `  receiver email; or set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_BUYER_EMAIL, PAYPAL_PAYOUT_EMAIL and run`,
        `  npm run keys -- --from-env). Or run the zero-key demo: npm run demo`,
      ].join('\n'),
    );
  }
  const aiLive = view.ai.mode === 'live' || view.ai.mode === 'record';
  if (ai === 'live' && !aiLive) {
    fail(`--ai live needs an AI key, and none was found (${AI_KEY_NAMES.join(', ')}; ${view.ai.reason}). Add one with npm run keys, or run without --ai live.`);
  }

  const aiLine = aiLive
    ? `${view.ai.provider} ${view.ai.model}, live (each photo check is a real model call)`
    : view.ai.mode === 'replay'
      ? 'recorded answers of a real model for the demo photos (replay; no network), rules for any other photo'
      : 'rules only (no model)';
  const payLine = paypal === 'sandbox' ? 'PayPal sandbox (real sandbox API calls, no real money)' : 'simulated PayPal (same rules as the sandbox, no network, no keys)';

  if (args['dry-run']) {
    console.log(bold('HoldMySpot launcher: dry run (nothing started)'));
    console.log(`  PayPal: ${payLine}`);
    console.log(`  AI:     ${aiLine}`);
    console.log(`  ${view.ai.bootLine}`);
    console.log(`  Secrets folder: ${env.secrets.source}`);
    console.log(`  Ports: server ${ports.server}${apps.web ? `, web ${ports.web}` : ''}${apps.ops ? `, ops ${ports.ops}` : ''}`);
    const names = Object.keys(env.server).filter((k) => k.startsWith('HMS_') && process.env[k] !== env.server[k]).sort();
    console.log(`  Server settings set here: ${names.join(', ')}`);
    if (apps.ops) console.log(`  AG Studio licence: ${studioLicence.present ? `${studioLicence.source} (found, value not shown)` : studioLicence.source}`);
    return;
  }

  // Ports.
  const wanted = [['server', ports.server], ...(apps.web ? [['web', ports.web]] : []), ...(apps.ops ? [['ops', ports.ops]] : [])];
  const busy = [];
  for (const [name, port] of wanted) {
    if (await portFree(port)) continue;
    const health = await fetchJson(`http://127.0.0.1:${port}/api/health`);
    const who = health?.contractVersion ? (name === 'server' ? 'a HoldMySpot server is already running there' : 'a HoldMySpot dev server is already running there') : (portOwner(port) ?? 'in use');
    busy.push(`  ${name} port ${port}: ${who}`);
  }
  if (busy.length > 0) {
    fail(
      [
        'a port is taken:',
        ...busy,
        'Stop that process (if this launcher started it: run the same command with --stop added), or pick other ports,',
        `for example: npm run ${paypal === 'sandbox' ? 'dev:sandbox' : 'demo'} -- --port-offset 10`,
      ].join('\n'),
    );
  }

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => void shutdown(0));

  const t0 = Date.now();
  console.log(bold(`Starting HoldMySpot: ${payLine}; AI ${aiLine.split(' (')[0]}.`));
  const server = startChild('server', process.execPath, ['src/main.ts'], { cwd: path.join(REPO, 'server'), env: env.server });
  const viteArgs = (port) => [path.join('node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'];
  if (apps.web) startChild('web', process.execPath, viteArgs(ports.web), { cwd: path.join(REPO, 'web'), env: env.web });
  if (apps.ops) startChild('ops', process.execPath, viteArgs(ports.ops), { cwd: path.join(REPO, 'ops'), env: env.ops });

  pidFile = pidFileFor(ports);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(
    pidFile,
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ports, children: children.map((c) => ({ name: c.name, pid: c.pid, match: c.name === 'server' ? 'src/main.ts' : 'vite.js' })) }, null, 2)}\n`,
  );

  const api = `http://127.0.0.1:${ports.server}`;
  const serverUp = await waitFor('server', async () => (await fetchJson(`${api}/api/health`))?.ok === true, READY_TIMEOUT_MS.server);
  if (!serverUp) {
    if (!server.exited) console.error(`\n${red('The server did not answer')} on ${api}/api/health. Last lines of ${shown(logPath('server'))}:\n${tail(logPath('server'), 25)}`);
    return shutdown(1);
  }
  console.log(`  ${green('ok')} server   ${api}  ${dim(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`)}`);
  for (const name of ['web', 'ops']) {
    if (!apps[name]) continue;
    const base = `http://127.0.0.1:${ports[name]}`;
    const up = await waitFor(name, async () => (await httpOk(`${base}/`)) && (await fetchJson(`${base}/api/health`))?.ok === true, READY_TIMEOUT_MS[name]);
    if (!up) {
      if (!children.find((c) => c.name === name)?.exited) console.error(`\n${red(`The ${name} app did not answer`)} on ${base}/ (or its /api proxy). Last lines of ${shown(logPath(name))}:\n${tail(logPath(name), 25)}`);
      return shutdown(1);
    }
    console.log(`  ${green('ok')} ${name.padEnd(6)}   ${base}  ${dim(`(${((Date.now() - t0) / 1000).toFixed(1)} s, /api reaches the server)`)}`);
  }
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  printBanner({ ports, apps, paypal, aiLine, aiLive, seconds, view, hero: await heroMoney(), studioLicence, args });
  if (args.smoke) {
    console.log(green('Smoke check passed: every app answered. Stopping.'));
    return shutdown(0);
  }
  await new Promise(() => {});
}

/**
 * The hero's money for the banner, from the shared money rules (shared/src/money.ts) on the worked
 * example's inputs (docs/DOMAIN.md section 7: shop price cap $36, max fee $12, shipping budget $12;
 * the receipt says $34.00 and the label $8.75), so the banner follows the fee model (D-118).
 * Null when the rules cannot be loaded; the banner then names no amount.
 */
async function heroMoney() {
  try {
    const m = await import(new URL('../shared/src/money.ts', import.meta.url).href);
    const bid = { qty: 1, retailCapCents: 3600, maxFeeCents: 1200, shippingBudgetCents: 1200 };
    const held = m.bidLimitCents(bid);
    const caps = m.jobCaps(bid, { qty: 1, feeCents: bid.maxFeeCents });
    const charged = m.receiptCapture(caps, 3400).amountCents + m.shippingCapture(caps, 875, 0).amountCents;
    const usd = (cents) => m.formatUsd(cents, { exact: true });
    return { held: usd(held), charged: usd(charged), released: usd(held - charged) };
  } catch {
    return null;
  }
}

function printBanner({ ports, apps, paypal, aiLine, aiLive, seconds, view, hero, studioLicence, args }) {
  const web = `http://127.0.0.1:${ports.web}`;
  const ops = `http://127.0.0.1:${ports.ops}`;
  const api = `http://127.0.0.1:${ports.server}`;
  const flags = ['port-offset', 'server-port', 'web-port', 'ops-port'].filter((k) => args[k] !== undefined).map((k) => ` --${k} ${args[k]}`).join('');
  const lines = [
    '',
    bold(`HoldMySpot is running (ready in ${seconds} s)`),
    `  PayPal: ${paypal === 'sandbox' ? 'PayPal sandbox: real sandbox calls, no real money' : 'simulated PayPal (fake mode): no network, no keys, same rules as the sandbox'}`,
    `  AI:     ${aiLine}`,
    '',
  ];
  if (apps.web) lines.push(`  ${bold('Web app')}      ${cyan(`${web}/?demo=1`)}   the market map (a phone layout)`);
  if (apps.ops) lines.push(`  ${bold('Ops console')}  ${cyan(`${ops}/`)}   queuer board; market dashboard at ${cyan(`${ops}/#/market`)}`);
  lines.push(`  ${bold('API')}          ${cyan(`${api}/api/health`)}   (also /api/config, /api/books)`);
  if (apps.ops) lines.push(dim(`  AG Studio licence: ${studioLicence.present ? `${studioLicence.source} (value not shown)` : studioLicence.source}`));
  lines.push('', bold('What to click'));
  let n = 0;
  const next = () => `${++n}.`;
  if (paypal === 'sandbox') {
    // The scripted day waits for a PayPal approval no screen offers, so sandbox mode starts with a person's own request (D-123, D-129).
    if (apps.web) {
      lines.push(
        `  ${next()} Web app: tap "Mochi Bunny plush", then "Set my max fee". PayPal's own buttons appear; click one and`,
        `     approve the hold as your sandbox buyer in PayPal's window (or the overlay PayPal shows when pop-ups are`,
        `     blocked). The money chip then shows the hold, for example "$63.70 held".`,
      );
    }
    lines.push(
      `  ${next()} Finish that errand with no password: ${bold(`npm run errand${flags ? ` --${flags}` : ''}`)} plays Wei (claim, check-in, receipt,`,
      `     tracking): PayPal captures, releases the rest and pays out. Do it on this fresh market, before Play.`,
      `  ${next()} Read it back from PayPal (GET calls only): ${bold(`npm run paypal:check -- --bid <request id>${flags}`)}`,
      `     (npm run errand prints the id). The order book's "Next step" also moves the market clock for your requests.`,
    );
    if (apps.ops) lines.push(`  ${next()} Ops console ${cyan(`${ops}/`)}: the Bryntum board and ${cyan(`${ops}/#/market`)} (AG Studio) show the same server.`, dim(`     The Play button runs the zero-key script only: in sandbox mode its first request waits for an approval.`));
  } else {
    if (apps.web) {
      lines.push(
        `  ${next()} Web app, on this fresh market: tap "Mochi Bunny plush", "Set my max fee", then "Hold ${hero ? hero.held : 'the hold'} with PayPal";`,
        `     approve it in the sheet labelled "Simulated PayPal". The money chip (top right) shows the hold. "Map"`,
        `     (bottom right) opens the overview with a list sorted by $/hour.`,
      );
    }
    if (apps.ops) {
      lines.push(
        `  ${next()} Ops console: press the round Play button next to the clock (top right). The scripted day runs at 60x from`,
        `     10:30, with your request as Mia's if you placed one: Wei checks in at Paper Moon Toys and his fee steps down`,
        `     to her $12 request; Rex's fake receipt is caught by the AI read and the rules ($0 moves); Lin takes Priya's`,
        `     request at $10; Mia is charged ${hero ? `${hero.charged} in two captures (processing and payouts at cost` : 'in two captures (processing and payouts at cost'}`,
        `     included) and ${hero ? `${hero.released} is` : 'the rest is'} released. "Market" (top left) opens the AG Studio dashboard.`,
        `  ${next()} Sponsor replays (in the browser, any server state): Bryntum ${cyan(`${ops}/?backend=mock&at=11:21`)}`,
        `     and AG Studio ${cyan(`${ops}/?backend=mock&at=12:05#/market`)} ("Widest gap" in the market desk panel).`,
      );
    }
  }
  if (!aiLive) lines.push(dim(`  AI checks replay saved answers. For a live model: npm run keys (AI section), then npm run demo -- --ai live`));
  if (paypal !== 'sandbox') lines.push(dim(`  For the real PayPal sandbox: npm run keys (PayPal section), then npm run dev:sandbox`));
  lines.push('', dim(`Logs: .run/logs/   Stop: Ctrl-C, or npm run ${paypal === 'sandbox' ? 'dev:sandbox' : 'demo'} -- --stop${flags} (only what this launcher started).   ${view.ai.bootLine}`), '');
  console.log(lines.join('\n'));
}

// A closed output pipe (for example `npm run demo | head`) must not take the apps down with it.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') streamLogs = false;
});
process.on('uncaughtException', (err) => {
  if (err?.code === 'EPIPE') return;
  console.error(red(err?.stack ?? String(err)));
  void shutdown(1);
});

main().catch((err) => {
  console.error(red(err?.stack ?? String(err)));
  void shutdown(1);
});
