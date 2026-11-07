import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiAgentRequest, AiAgentResult, AiJsonRequest, AiJsonResult, AiProvider, AiTask } from '@holdmyspot/shared/ports';
import { AiError } from './errors.ts';
import { imageSha256 } from './replay.ts';
import { validateJson } from './schemas.ts';

/**
 * The rules-only provider: no model and no network.
 *
 * For demo and test photos it returns the `truth.json` sidecar that sits next
 * to the image (what a careful reader would copy from it), found by the
 * image's SHA-256. For any other photo it reads nothing, and the services turn
 * that into "needs review". It writes no text: services use templates and the
 * agent uses its written policy instead.
 */

export const FAKE_MODEL = 'rules-v1';

export interface TruthSource {
  /** The answer for these images, or undefined when they are not known fixtures. */
  lookup(task: AiTask, imageShas: readonly string[]): unknown;
}

interface TruthEntry {
  images: string[];
  outputs: Partial<Record<AiTask, unknown>>;
}

function findEntry(entries: readonly TruthEntry[], task: AiTask, shas: readonly string[]): unknown {
  for (const e of entries) {
    if (e.outputs[task] === undefined) continue;
    if (shas.every((s) => e.images.includes(s))) return e.outputs[task];
  }
  return undefined;
}

/** In-memory truth, for tests. */
export class MemoryTruth implements TruthSource {
  readonly #entries: TruthEntry[] = [];

  add(imageBytes: readonly Uint8Array[], outputs: Partial<Record<AiTask, unknown>>): this {
    this.#entries.push({ images: imageBytes.map((b) => createHash('sha256').update(b).digest('hex')), outputs });
    return this;
  }

  lookup(task: AiTask, imageShas: readonly string[]): unknown {
    return findEntry(this.#entries, task, imageShas);
  }
}

/**
 * Truth sidecars on disk: `<dir>/<case>/truth.json` with
 * `{ "images": ["receipt.png", "item.png"], "outputs": { "purchase_proof": {...} } }`.
 * The folder is read once, on first use.
 */
export class FixtureTruth implements TruthSource {
  readonly dir: string;
  #entries: TruthEntry[] | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  #load(): TruthEntry[] {
    if (this.#entries) return this.#entries;
    const entries: TruthEntry[] = [];
    if (existsSync(this.dir)) {
      for (const name of readdirSync(this.dir).sort()) {
        const caseDir = join(this.dir, name);
        const file = join(caseDir, 'truth.json');
        if (!existsSync(file)) continue;
        try {
          const t = JSON.parse(readFileSync(file, 'utf8')) as { images: string[]; outputs: Partial<Record<AiTask, unknown>> };
          const images = t.images.map((img) => createHash('sha256').update(readFileSync(join(caseDir, img))).digest('hex'));
          entries.push({ images, outputs: t.outputs });
        } catch {
          // A broken fixture folder is skipped; the eval reports it.
        }
      }
    }
    this.#entries = entries;
    return entries;
  }

  lookup(task: AiTask, imageShas: readonly string[]): unknown {
    return findEntry(this.#load(), task, imageShas);
  }
}

export class FakeProvider implements AiProvider {
  readonly id = 'fake' as const;
  readonly model = FAKE_MODEL;
  readonly mode = 'fake' as const;
  readonly vision = true;
  readonly #truth: TruthSource;

  constructor(truth: TruthSource) {
    this.#truth = truth;
  }

  async json<T>(req: AiJsonRequest): Promise<AiJsonResult<T>> {
    const t0 = performance.now();
    if (req.images.length === 0) {
      throw new AiError('unsupported', 'Rules-only mode writes no text; a template is used instead.');
    }
    const out = this.#truth.lookup(req.task, req.images.map(imageSha256));
    if (out === undefined) {
      throw new AiError('no_truth', 'Rules-only mode has no AI reader, and this photo is not a demo fixture.');
    }
    const problems = validateJson(req.schema, out);
    if (problems.length > 0) throw new AiError('invalid_output', `Fixture truth does not match the schema: ${problems.slice(0, 3).join('; ')}`);
    return {
      data: out as T,
      stamp: { provider: 'fake', model: FAKE_MODEL, mode: 'fake', latencyMs: Math.round(performance.now() - t0) },
      usage: null,
    };
  }

  async agent(_req: AiAgentRequest): Promise<AiAgentResult> {
    throw new AiError('unsupported', 'Rules-only mode runs the written agent policy instead of a model.');
  }
}
