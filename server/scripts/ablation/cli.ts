import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AiProviderId } from '@holdmyspot/shared';
import type { AiProvider } from '@holdmyspot/shared/ports';
import { buildAiPort } from '../../src/ai/index.ts';
import { loadLocalEnv } from '../../src/localenv.ts';
import { ABLATION_DOC, ABLATION_JSON, REPO_ROOT, repoPath, runAblation, summarize } from './ablate.ts';
import type { AblationRow } from './ablate.ts';
import { renderJson, renderMarkdown } from './render.ts';

/**
 * `npm run ablation` (also `npm run ai:eval -- --ablate`): decides every fixture
 * photo three ways and writes docs/ABLATION.md and docs/evidence/ablation.json.
 * Recorded answers by default: no key, no network. `--live` asks the configured
 * model again and writes to .run/ablation/, so the committed page always stays
 * the recorded run that server/test/ablation.test.ts checks. Keys are never printed.
 */

const USAGE = `Decide every fixture photo three ways: Rules + AI, the rules on the true reading (truth.json), and the model without the job, not asked for a verdict (docs/ABLATION.md).

  npm run ablation [-- options]          same as npm run ai:eval -- --ablate [options]

With no options it replays the model's recorded answers (server/fixtures/ai, no key, no network)
and rewrites docs/ABLATION.md and docs/evidence/ablation.json.

Options:
  --check            compare those two files with a fresh run; exit 1 when they differ (writes nothing)
  --live             the configured model reads every photo again (one call per photo; needs a key);
                     writes to .run/ablation/ so the committed page stays the recorded run
  --provider <id>    with --live: auto, anthropic, muse or openai
  --only <ids>       only these cases (comma-separated); writes to .run/ablation/
  --out <dir>        write ABLATION.md and ablation.json into this folder instead
  -h, --help
`;

export interface AblationArgs {
  check: boolean;
  live: boolean;
  provider: string | null;
  only: string[] | null;
  out: string | null;
  help: boolean;
}

/** The options, or the reason they are refused. */
export function parseAblationArgs(argv: readonly string[]): AblationArgs | string {
  const a: AblationArgs = { check: false, live: false, provider: null, only: null, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${v} needs a value`);
      return next;
    };
    try {
      if (v === '--check') a.check = true;
      else if (v === '--live') a.live = true;
      else if (v === '--provider') a.provider = value();
      else if (v === '--only') a.only = value().split(',').map((s) => s.trim()).filter(Boolean);
      else if (v === '--out') a.out = value();
      else if (v === '--help' || v === '-h') a.help = true;
      else return `Unknown option ${v}.`;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  if (a.check && (a.live || a.only || a.out)) return '--check compares the full recorded run with the committed files; it takes no --live, --only or --out.';
  if (a.provider && !a.live) return '--provider needs --live.';
  if (a.provider && !['auto', 'anthropic', 'muse', 'openai'].includes(a.provider)) return '--provider must be auto, anthropic, muse or openai.';
  return a;
}

/** The commit and Node version this run used, for the log (not in the page: the page must not change with every commit). */
function runHeader(): string {
  const git = (args: string[]) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  const head = git(['rev-parse', '--short', 'HEAD']);
  if (head.status !== 0) return `not a git checkout, Node ${process.version}`;
  const dirty = (git(['status', '--porcelain']).stdout ?? '').trim() !== '';
  return `commit ${head.stdout.trim()}${dirty ? ' with uncommitted changes' : ''}, Node ${process.version}`;
}

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const read = (file: string) => (existsSync(file) ? lf(readFileSync(file, 'utf8')) : null);

function line(r: AblationRow): string {
  const ai = r.aiOnly.outcome === 'passes' ? 'passes' : 'stopped';
  const v = (s: string) => (s === 'needs_review' ? 'needs review' : s).padEnd(13);
  return `  ${r.category.padEnd(8)} ${r.id.padEnd(32)} Rules + AI ${v(r.rulesAndAi.status)} true reading ${v(r.rulesOnly.status)} model alone ${ai.padEnd(8)} ${r.answer.error ? `error: ${r.answer.error}` : r.answer.stamp}`;
}

export async function ablationCli(argv: readonly string[]): Promise<number> {
  const args = parseAblationArgs(argv);
  if (typeof args === 'string') {
    console.error(`${args}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  console.log(`Ablation: ${runHeader()}`);

  let provider: AiProvider | undefined;
  if (args.live) {
    loadLocalEnv();
    const port = buildAiPort({ runtimeMode: 'fake', aiMode: 'live', ...(args.provider ? { aiProvider: args.provider as 'auto' | AiProviderId } : {}) });
    console.log(port.bootLine);
    if (port.info.mode !== 'live') {
      console.error('No AI key was found for a live run (checked ANTHROPIC_API_KEY, MODEL_API_KEY and OPENAI_API_KEY by name only). Nothing was sent.');
      return 2;
    }
    provider = port.provider;
  }

  let result;
  try {
    result = await runAblation({ ...(provider ? { provider } : {}), only: args.only, onCase: (r) => console.log(line(r)) });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (args.only) {
    const missing = args.only.filter((id) => !result.rows.some((r) => r.id === id));
    if (missing.length) console.log(`No such case: ${missing.join(', ')}`);
  }

  const s = summarize(result);
  const { fake: F, genuine: G, review: R, total: N } = s.cases;
  console.log('');
  console.log(`Cases: ${N} (${F} fakes, ${G} genuine, ${R} for review)`);
  for (const [label, x] of [
    ['Rules + AI                       ', s.rulesAndAi],
    ['Rules on the true reading        ', s.rulesOnly],
    ['Model without the job, no verdict', s.aiOnly],
  ] as const) {
    console.log(`${label}  fakes stopped ${x.fakesStopped}/${F}  genuine passed ${x.genuinePassed}/${G}  review stopped ${x.reviewStopped}/${R}  exact verdicts ${x.exactVerdicts === null ? '-' : `${x.exactVerdicts}/${N}`}`);
  }
  console.log(`Fakes stopped by code alone ${s.layers.codeAlone.length}/${F}; only by a rule on the model's reading ${s.layers.readingOnly.length}/${F}`);
  console.log(result.answers === 'live' ? `Model calls: ${N}.` : 'No model was called in this run.');

  const committed = !args.live && !args.only && !args.out;
  const runNote = committed
    ? undefined
    : `Run on ${new Date().toISOString().slice(0, 10)} (UTC)${args.only ? `, cases: ${args.only.join(', ')}` : ''}${result.answers === 'live' ? ', live answers' : ', recorded answers'}.`;
  const md = renderMarkdown(result, { committed, ...(runNote ? { runNote } : {}) });
  const json = renderJson(result);

  if (args.check) {
    const stale = [
      [ABLATION_DOC, md],
      [ABLATION_JSON, json],
    ].filter(([file, want]) => read(file as string) !== want);
    if (stale.length) {
      console.error(`Out of date: ${stale.map(([f]) => repoPath(f as string)).join(', ')}. Run npm run ablation and commit the result.`);
      return 1;
    }
    console.log(`Up to date: ${repoPath(ABLATION_DOC)} and ${repoPath(ABLATION_JSON)}.`);
    return 0;
  }

  const outDir = args.out ? (isAbsolute(args.out) ? args.out : resolve(process.env.INIT_CWD ?? process.cwd(), args.out)) : join(REPO_ROOT, '.run', 'ablation');
  const targets: [string, string][] = committed
    ? [
        [ABLATION_DOC, md],
        [ABLATION_JSON, json],
      ]
    : [
        [join(outDir, 'ABLATION.md'), md],
        [join(outDir, 'ablation.json'), json],
      ];
  for (const [file, text] of targets) {
    if (read(file) === text) {
      console.log(`Unchanged: ${repoPath(file)}`);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`Wrote ${repoPath(file)}`);
  }
  return 0;
}
