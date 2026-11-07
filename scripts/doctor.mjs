#!/usr/bin/env node
// Checks that HoldMySpot can run here and says what each run would use. Names only, never values.
//
//   npm run doctor                  human output
//   npm run doctor -- --json        one JSON object (for scripts and AI agents)
//   npm run doctor -- --live-ai     also one tiny live model call (a few tokens) with the configured AI key
//   npm run doctor -- --offline     no network at all (skips the PayPal OAuth check)
//
// Exit code: 0 when the zero-key demo (npm run demo) can start, 1 when it cannot.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AI_KEY_NAMES,
  DEFAULT_PORTS,
  KEYS_FROM_ENV,
  LICENCE_FILES,
  PACKAGES,
  REPO,
  RUN_DIR,
  SANDBOX_ALIASES,
  SANDBOX_NAMES,
  aiPing,
  bold,
  describePayPalFailure,
  dim,
  fetchJson,
  fileMode,
  green,
  launchEnv,
  licenceSources,
  nodeStatus,
  npmVersion,
  packageStatus,
  paypalToken,
  portFree,
  portOwner,
  probeServer,
  readDotenvFile,
  red,
  resolvePorts,
  shown,
  yellow,
} from './common.mjs';

const USAGE = `Check HoldMySpot's setup: Node and npm, packages, ports, keys (names only), PayPal sandbox OAuth,
the AI provider each run would use, and the AG licence sources.

  npm run doctor [-- options]

Options:
  --json                    print one JSON object instead of text
  --offline                 no network (skip the PayPal OAuth check)
  --live-ai                 make one tiny live model call with the configured AI key (costs a few tokens)
  --port-offset <n>, --server-port <p>, --web-port <p>, --ops-port <p>   ports to check (default ${DEFAULT_PORTS.server}, ${DEFAULT_PORTS.web}, ${DEFAULT_PORTS.ops})
  -h, --help
`;

async function main() {
  let args;
  try {
    ({ values: args } = parseArgs({
      options: {
        json: { type: 'boolean' },
        offline: { type: 'boolean' },
        'live-ai': { type: 'boolean' },
        'port-offset': { type: 'string' },
        'server-port': { type: 'string' },
        'web-port': { type: 'string' },
        'ops-port': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const report = { ok: true, blockers: [], warnings: [], node: null, npm: null, packages: {}, ports: {}, secrets: {}, paypal: {}, ai: {}, licences: {}, runs: {} };
  const block = (msg) => {
    report.ok = false;
    report.blockers.push(msg);
  };
  const warn = (msg) => report.warnings.push(msg);

  // Node and npm.
  const node = nodeStatus();
  report.node = { version: node.version, ok: node.ok };
  if (!node.ok) block(node.text);
  const npm = npmVersion();
  report.npm = { version: npm, ok: Boolean(npm) };
  if (!npm) block('npm was not found on PATH.');

  // Packages.
  for (const p of PACKAGES) {
    const s = packageStatus(p);
    report.packages[p] = s;
    if (!s.installed) block(`${p}/ is not installed: run npm run setup`);
    else if (!s.upToDate) warn(`${p}/ is ${s.detail}: run npm run setup`);
  }
  report.fixtures = {
    replayAnswers: countJson(path.join(REPO, 'server', 'fixtures', 'ai')),
    demoPhotos: countDirs(path.join(REPO, 'server', 'fixtures', 'proofs')),
  };

  // Ports.
  let ports;
  try {
    ports = resolvePorts(args);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  // The advice repeats the port flags this check was given, so following it stops the right launcher.
  const flags = portFlags(args);
  const offset = args['port-offset'] === undefined ? 0 : Number(args['port-offset']);
  const elsewhere = `--port-offset ${offset + 10}`;
  for (const [name, port] of Object.entries(ports)) {
    const free = await portFree(port);
    let holder = null;
    if (!free) {
      const health = await fetchJson(`http://127.0.0.1:${port}/api/health`, 1200);
      holder = health?.contractVersion ? 'HoldMySpot' : (portOwner(port) ?? 'another program');
      block(
        holder === 'HoldMySpot'
          ? `${name} port ${port} is in use by HoldMySpot: if npm run demo is already running, open its URLs; else stop it (npm run demo -- --stop${flags}) or use other ports (npm run demo -- ${elsewhere})`
          : `${name} port ${port} is in use (${holder}): stop it, or run npm run demo -- ${elsewhere} (and pass the same flag here)`,
      );
    }
    report.ports[name] = { port, free, holder };
  }
  // This repo's own launcher on these ports (its record in .run/): the demo is running, which is fine.
  report.demoRunning = Object.values(report.ports).some((p) => p.holder === 'HoldMySpot') && fs.existsSync(path.join(RUN_DIR, `dev-${ports.server}.json`));

  // Secrets folder and keys (names only).
  const demo = launchEnv({ mode: 'fake', ai: 'auto', ports });
  const sandbox = launchEnv({ mode: 'sandbox', ai: 'auto', ports });
  const dir = demo.secrets.dir;
  report.secrets = { folder: demo.secrets.source, path: shown(dir), exists: fs.existsSync(dir), outsideRepo: Boolean(demo.secrets.outside), files: {} };
  // Keys from a folder outside the repo make this machine differ from a fresh clone (D-131).
  if (demo.secrets.outside) warn(`Keys are read from ${shown(dir)} (HMS_SECRETS_DIR), outside this repo: a fresh clone elsewhere has none of them. Unset HMS_SECRETS_DIR to check the zero-key path.`);
  for (const f of ['sandbox.env', 'ai.env', LICENCE_FILES.grid.file, LICENCE_FILES.studio.file]) {
    const file = path.join(dir, f);
    const mode = fileMode(file);
    report.secrets.files[f] = mode === null ? 'absent' : `present, mode ${mode.toString(8)}`;
    if (mode !== null && (mode & 0o077) !== 0) warn(`${shown(file)} can be read by other users: chmod 600 it`);
  }
  const sandboxEnv = readDotenvFile(path.join(dir, 'sandbox.env')) ?? new Map();
  // The payout receiver's older name (PAYPAL_TW_PAYOUT_EMAIL) still counts.
  const value = (name) => process.env[name] || sandboxEnv.get(name) || (SANDBOX_ALIASES[name] ? process.env[SANDBOX_ALIASES[name]] || sandboxEnv.get(SANDBOX_ALIASES[name]) : '');
  const where = (name) => (process.env[name] || (SANDBOX_ALIASES[name] && process.env[SANDBOX_ALIASES[name]]) ? 'set (process env)' : 'set (sandbox.env)');
  report.paypal.names = Object.fromEntries(SANDBOX_NAMES.map((n) => [n, value(n) ? where(n) : 'missing']));
  // What a person supplies: npm run keys -- --from-env reads these four and finds the rest itself.
  report.paypal.keysFromEnv = KEYS_FROM_ENV;
  const aiEnv = readDotenvFile(path.join(dir, 'ai.env')) ?? new Map();
  report.ai.keys = Object.fromEntries(AI_KEY_NAMES.map((n) => [n, process.env[n] ? 'set (process env)' : aiEnv.get(n) ? 'set (ai.env)' : 'not in env or ai.env']));

  // PayPal OAuth (only with keys, only the token call).
  const clientId = value('PAYPAL_CLIENT_ID');
  const secret = value('PAYPAL_CLIENT_SECRET');
  if (!clientId || !secret) report.paypal.oauth = 'skipped (no PayPal keys)';
  else if (args.offline) report.paypal.oauth = 'skipped (--offline)';
  else {
    const r = await paypalToken(clientId, secret);
    if (r.ok) {
      report.paypal.oauth = 'ok: the PayPal sandbox accepted the client ID and secret';
      report.paypal.features = Object.fromEntries(r.features.map((f) => [f.feature, f.ok ? 'yes' : `no (tick "${f.dashboard}" on the app page)`]));
      if (!r.features.find((f) => f.feature === 'payouts')?.ok) warn('The PayPal app has no Payouts scope: queuer payouts will fail in sandbox mode (developer.paypal.com > Apps & Credentials > your app > Features > Payouts).');
    } else {
      report.paypal.oauth = `failed: ${describePayPalFailure(r)}`;
      warn(`PayPal OAuth failed: ${describePayPalFailure(r)}`);
    }
  }

  // What each run would use, from the server's own code.
  if (report.packages.server.installed) {
    const probes = {};
    for (const [name, env] of [
      ['npm run demo', demo],
      ['npm run dev:sandbox', sandbox],
    ]) {
      const p = probeServer(env.server);
      probes[name] = p;
      if (!p.ok) {
        report.runs[name] = { error: p.error };
        if (name === 'npm run demo') block(`the server settings could not be read: ${p.error}`);
        continue;
      }
      const v = p.value;
      const sandboxRun = name === 'npm run dev:sandbox';
      const refused = sandboxRun && v.mode !== 'sandbox';
      report.runs[name] = {
        paypal: v.mode === 'sandbox' ? 'PayPal sandbox' : refused ? 'not ready: npm run dev:sandbox refuses to start until these are set' : 'simulated PayPal (fake mode)',
        // The probe asks the server with the fake fallback on; the real start refuses instead of falling back.
        paypalReason: refused ? v.modeReason.replace(/: running fake\.$/, '.') : v.modeReason,
        // With PayPal not ready the server would fall back to fake mode; say what AI the sandbox run will use once it is.
        ai: refused ? (v.ai.provider === 'fake' ? 'recorded answers and rules (no AI key)' : `${v.ai.provider} ${v.ai.model}, mode live (once PayPal is ready)`) : aiText(v.ai),
        aiReason: v.ai.reason,
        aiKeys: v.ai.keys,
        serverEnvLocal: v.local,
      };
    }
    {
      // Key presence from the server's own search (environment, ai.env, HMS_AI_KEY_FILES), names and file names only.
      const v = probes['npm run demo'];
      if (v?.ok) {
        const src = v.value.ai.sources;
        report.ai.keys = {
          ANTHROPIC_API_KEY: v.value.ai.keys.anthropic ? `present (${src.anthropic})` : 'absent',
          OPENAI_API_KEY: v.value.ai.keys.openai ? `present (${src.openai})` : 'absent',
          MODEL_API_KEY: v.value.ai.keys.muse ? `present (${src.muse})` : 'absent',
        };
      }
    }
    const sb = report.runs['npm run dev:sandbox'];
    if (sb && !sb.error && !sb.paypal.startsWith('PayPal sandbox')) report.paypal.sandboxReady = `no: ${sb.paypalReason.replace(/\.$/, '')}`;
    else if (sb && !sb.error) report.paypal.sandboxReady = 'yes';
  } else {
    report.runs = { note: 'install server/ first (npm run setup) to see what each run would use' };
  }

  // Optional live AI call.
  if (args['live-ai']) {
    if (!report.packages.server.installed) report.ai.liveCheck = 'skipped (server not installed)';
    else if (args.offline) report.ai.liveCheck = 'skipped (--offline)';
    else {
      const r = aiPing(sandbox.server);
      report.ai.liveCheck = r.ok ? r.value : { ok: false, reason: r.error };
      if (r.ok && !r.value.ok) warn(`The live AI check failed: ${r.value.reason}`);
    }
  }

  report.licences = licenceSources();

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  printHuman({ ...report, args }, ports);
  return report.ok ? 0 : 1;
}

/** The port flags as given (" --port-offset 100" or the single-port flags), for advice that must hit the same ports. */
function portFlags(args) {
  return ['port-offset', 'server-port', 'web-port', 'ops-port'].filter((k) => args[k] !== undefined).map((k) => ` --${k} ${args[k]}`).join('');
}

/** The AI a run uses, in words. */
function aiText(ai) {
  if (ai.mode === 'fake') return 'rules only (no model)';
  if (ai.mode === 'replay') {
    const live = ai.provider === 'fake' ? 'no AI key, so nothing can call a model' : `${ai.provider} ${ai.model} only with --ai live`;
    return `recorded model answers for the demo photos (replay, offline), rules for other photos; ${live}`;
  }
  return `${ai.provider} ${ai.model}, ${ai.mode} (real model calls)`;
}

function countJson(dir) {
  let n = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) if (entry.isFile() && entry.name.endsWith('.json')) n++;
  } catch {
    return 0;
  }
  return n;
}

function countDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).length;
  } catch {
    return 0;
  }
}

function printHuman(r, ports) {
  const ok = (b) => (b ? green('ok  ') : red('FAIL'));
  const out = [];
  out.push(bold('HoldMySpot doctor'), '');
  out.push(`  ${ok(r.node.ok)} Node ${r.node.version} ${dim('(needs 24 or newer; .nvmrc)')}`);
  out.push(`  ${ok(r.npm.ok)} npm ${r.npm.version ?? 'not found'}`);
  for (const [p, s] of Object.entries(r.packages)) out.push(`  ${s.installed ? (s.upToDate ? green('ok  ') : yellow('warn')) : red('FAIL')} ${p.padEnd(7)} ${s.detail}`);
  out.push(`  ${green('ok  ')} demo data: ${r.fixtures.replayAnswers} recorded AI answers, ${r.fixtures.demoPhotos} demo photo cases`);
  for (const [name, p] of Object.entries(r.ports)) out.push(`  ${ok(p.free)} port ${p.port} (${name}) ${p.free ? 'free' : `in use by ${p.holder}`}`);
  out.push('', bold('Keys (names only)'));
  out.push(`  Secrets folder: ${r.secrets.folder}${r.secrets.exists || r.secrets.folder.startsWith('none') ? '' : ' (does not exist yet)'}`);
  for (const [f, s] of Object.entries(r.secrets.files)) out.push(`    ${f.padEnd(22)} ${s}`);
  const missingNames = Object.entries(r.paypal.names).filter(([, v]) => v === 'missing').map(([k]) => k);
  out.push(`  PayPal sandbox: ${Object.keys(r.paypal.names).length - missingNames.length}/${Object.keys(r.paypal.names).length} names set${missingNames.length > 0 ? `; missing ${missingNames.join(', ')}` : ''}`);
  if (missingNames.length > 0) out.push(dim(`    npm run keys asks for ${r.paypal.keysFromEnv.join(', ')} (or reads them with --from-env) and finds the rest itself.`));
  out.push(`    OAuth check: ${r.paypal.oauth}`);
  if (r.paypal.features) out.push(`    Features: ${Object.entries(r.paypal.features).map(([k, v]) => `${k} ${v}`).join('; ')}`);
  out.push(`  AI keys: ${Object.entries(r.ai.keys).map(([k, v]) => `${k} ${v}`).join('; ')}`);
  if (r.ai.liveCheck) out.push(`    Live check: ${r.ai.liveCheck.ok ? green(`ok (${r.ai.liveCheck.provider} ${r.ai.liveCheck.model}, ${r.ai.liveCheck.latencyMs} ms)`) : red(`failed: ${r.ai.liveCheck.reason}`)}`);
  out.push(`  AG licences: grid ${r.licences.grid.source}; studio ${r.licences.studio.source}`);
  out.push('', bold('What each run would use'));
  if (r.runs.note) out.push(`  ${r.runs.note}`);
  for (const [name, v] of Object.entries(r.runs)) {
    if (name === 'note') continue;
    if (v.error) {
      out.push(`  ${name}: ${red(`could not read the server settings (${v.error})`)}`);
      continue;
    }
    out.push(`  ${bold(name)}`);
    out.push(`    PayPal: ${v.paypal}${v.paypal.startsWith('PayPal sandbox') ? '' : dim(` (${v.paypalReason.replace(/\.$/, '')})`)}`);
    out.push(`    AI:     ${v.ai} ${dim(`(${v.aiReason})`)}`);
    if (v.serverEnvLocal?.length > 0) out.push(dim(`    server/.env.local sets ${v.serverEnvLocal.join(', ')}`));
  }
  if (r.warnings.length > 0) out.push('', bold('Warnings'), ...r.warnings.map((w) => `  ${yellow('-')} ${w}`));
  out.push('');
  if (r.ok) {
    out.push(green(bold('Ready: npm run demo can start (no keys needed).')));
    if (r.paypal.sandboxReady && r.paypal.sandboxReady !== 'yes') out.push(dim(`PayPal sandbox mode is not ready (${r.paypal.sandboxReady.slice(4)}): npm run keys, then npm run dev:sandbox.`));
    else if (r.paypal.sandboxReady === 'yes') out.push(green('PayPal sandbox mode is ready too: npm run dev:sandbox.'));
  } else {
    out.push(red(bold('Not ready: npm run demo cannot start yet.')), ...r.blockers.map((b) => `  ${red('-')} ${b}`));
  }
  const again = portFlags(r.args ?? {});
  if (!r.ok) out.push(dim(`Fix the above, then run npm run doctor${again ? ` --${again}` : ''} again.`));
  console.log(out.join('\n'));
}

main().then((code) => process.exit(code));
