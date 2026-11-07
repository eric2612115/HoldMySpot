import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RULES, bidLimitCents } from '@holdmyspot/shared';
import type { AiStamp, BidTask, BookAsk, MarketMs } from '@holdmyspot/shared';
import type { AiAgentRequest, AiAgentResult, AiJsonRequest, AiJsonResult, AiProvider } from '@holdmyspot/shared/ports';
import { AiError } from '../../src/ai/errors.ts';
import type { RgbaImage } from '../../src/ai/image.ts';

/** Shared builders for the AI tests: images, bids, asks and stand-in providers. */

export function tempDir(prefix = 'hms-ai-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A grey-scale scene from a function of (x, y) to 0..255. */
export function scene(width: number, height: number, f: (x: number, y: number) => number, alpha = 255): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.max(0, Math.min(255, Math.round(f(x, y))));
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = Math.min(255, v + 10);
      data[i + 2] = Math.max(0, v - 10);
      data[i + 3] = alpha;
    }
  }
  return { width, height, data };
}

export const T0 = Date.parse('2026-11-12T10:30:00-08:00');
export const MIN = 60_000;

export function mia(over: Partial<BidTask> = {}): BidTask {
  const qty = over.qty ?? 2;
  const retailCapCents = over.retailCapCents ?? 2800;
  const maxFeeCents = over.maxFeeCents ?? 1200;
  const shippingBudgetCents = over.shippingBudgetCents ?? 3500;
  return {
    id: 'bid-mia',
    requesterId: 'mia',
    requesterName: 'Mia R.',
    shopId: 'little-lantern-toys',
    itemId: 'plush-little-lantern',
    qty,
    remainingQty: qty,
    retailCapCents,
    maxFeeCents,
    shippingBudgetCents,
    limitCents: bidLimitCents({ qty, retailCapCents, maxFeeCents, shippingBudgetCents }),
    destination: { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: '10012' },
    deadlineAt: T0 + 4 * 60 * MIN,
    status: 'open',
    closeReason: null,
    holdId: 'hold-mia',
    paypalOrderId: null,
    paypalAuthorizationId: null,
    agent: { enabled: true, goal: '2 plush by Thursday noon, as cheap as possible', status: 'active', lastRunAt: null, nextRunAt: null },
    createdAt: T0,
    pricedAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function ask(id: string, over: Partial<BookAsk> = {}): BookAsk {
  return {
    id,
    queuerId: 'wei',
    feeCents: 1500,
    clock: null,
    remainingCapacity: 4,
    modes: ['ship'],
    etaAt: T0 + 20 * MIN,
    windowEndsAt: null,
    pricedAt: T0,
    matchable: true,
    targetBidId: null,
    ...over,
  };
}

export const rules = DEFAULT_RULES;

export function stamp(provider: AiStamp['provider'] = 'anthropic', mode: AiStamp['mode'] = 'live'): AiStamp {
  return { provider, model: provider === 'muse' ? 'muse-spark-1.3' : 'claude-opus-5-5', mode, latencyMs: 5 };
}

/** A provider whose answers come from test functions. */
export class StubProvider implements AiProvider {
  readonly id: AiProvider['id'];
  readonly model: string;
  readonly mode: AiProvider['mode'];
  readonly vision = true;
  readonly jsonCalls: AiJsonRequest[] = [];
  readonly agentCalls: AiAgentRequest[] = [];
  readonly onJson: (req: AiJsonRequest) => unknown;
  readonly onAgent: ((req: AiAgentRequest) => Promise<{ summary: string; calls: { name: string; input: unknown }[] }>) | null;

  constructor(opts: {
    id?: AiProvider['id'];
    mode?: AiProvider['mode'];
    json?: (req: AiJsonRequest) => unknown;
    agent?: (req: AiAgentRequest) => Promise<{ summary: string; calls: { name: string; input: unknown }[] }>;
  }) {
    this.id = opts.id ?? 'anthropic';
    this.model = this.id === 'muse' ? 'muse-spark-1.3' : 'claude-opus-5-5';
    this.mode = opts.mode ?? 'live';
    this.onJson = opts.json ?? (() => {
      throw new AiError('unavailable', 'no json stub');
    });
    this.onAgent = opts.agent ?? null;
  }

  async json<T>(req: AiJsonRequest): Promise<AiJsonResult<T>> {
    this.jsonCalls.push(req);
    const data = this.onJson(req);
    return { data: data as T, stamp: { provider: this.id, model: this.model, mode: this.mode, latencyMs: 3 }, usage: null };
  }

  async agent(req: AiAgentRequest): Promise<AiAgentResult> {
    this.agentCalls.push(req);
    if (!this.onAgent) throw new AiError('unsupported', 'no tool use');
    const planned = await this.onAgent(req);
    const toolCalls: AiAgentResult['toolCalls'] = [];
    for (const c of planned.calls) {
      const tool = req.tools.find((t) => t.name === c.name);
      toolCalls.push({ name: c.name, input: c.input, output: tool ? await tool.run(c.input) : { ok: false } });
    }
    return { summary: planned.summary, toolCalls, stamp: { provider: this.id, model: this.model, mode: this.mode, latencyMs: 4 } };
  }
}

export function at(hhmm: string, day = '2026-11-12'): MarketMs {
  return Date.parse(`${day}T${hhmm}:00-08:00`);
}
