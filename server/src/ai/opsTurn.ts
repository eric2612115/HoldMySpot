import { randomUUID } from 'node:crypto';
import type { OpsAgentMessage, OpsAgentToolCall, OpsAgentTurnRequest, OpsAgentTurnResponse } from '@holdmyspot/shared';
import type { AiProvider } from '@holdmyspot/shared/ports';
import type { ResolvedAi } from './config.ts';
import { AiError } from './errors.ts';
import type { JsonSchema } from './schemas.ts';

/**
 * One turn of an ops console agent (D-100): the market desk in AG Studio,
 * the Studio built-in agents it delegates to, and the board's rescheduler.
 * The console runs every tool; the server only holds the key and asks the
 * model what to do next.
 *
 * Every provider answers through `json()` with one schema: `say` (text for
 * the operator) and `calls` (tool calls, each with its arguments as an
 * encoded JSON object). That works the same on Anthropic, Muse and any
 * OpenAI-compatible endpoint, none of which needs native tool calling here.
 *
 * Turns are live only: never recorded as fixtures and never replayed, since
 * every question is new. Without a live model the call fails with
 * `unavailable` and the console uses its offline planner or its rules.
 */

/** Kept apart from prompts.ts so changing it never touches the recorded photo answers. */
export function opsTurnSystem(objectArgs: boolean): string {
  const args = objectArgs
    ? '"arguments": the arguments as a JSON object, for example {"tool": "read_market", "arguments": {"topic": "holds"}}'
    : '"arguments": the arguments as a JSON object encoded in a string, for example {"tool": "read_market", "arguments": "{\\"topic\\":\\"holds\\"}"}';
  return `You are one agent in the operator console of HoldMySpot, a market on the queue fee: requesters in the US post requests backed by PayPal holds; queuers near a shop post offers (their fee steps down on a clock after check-in) and stand in line; a verified receipt triggers PayPal captures and PayPal Payouts to the queuer.
You work in turns. Each turn is one JSON object with "say" and "calls", and nothing else: no code fences, no text around it.
- "calls" lists the tools to run now, in order. Each call has "tool" (the tool's name) and ${args}. The arguments must match that tool's parameter schema exactly.
- Tool results come back to you in the next turn. Call tools only when you need them; several calls may go in one turn.
- "say" is text for the operator. Leave it empty while you are still calling tools; when you have what you need, answer in "say" with empty "calls".
Never invent amounts, ids, names or times: take them from tool results or the conversation. Code decides money; you never set an amount.
Write plain English: short sentences, US dollars with cents.`;
}

const MAX_TOOL_TEXT = 6000;
const MAX_MESSAGE_TEXT = 4000;
const MAX_MESSAGES = 40;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} ...(cut, ${text.length - max} more characters)` : text);

/**
 * The turn's schema. Arguments are a free JSON object where the provider
 * accepts one (Meta's and OpenAI-compatible endpoints, non-strict); Anthropic's
 * strict structured output takes them as an encoded string instead.
 */
function turnSchema(toolNames: readonly string[], objectArgs: boolean): JsonSchema {
  const call: JsonSchema = {
    type: 'object',
    properties: {
      tool: toolNames.length > 0 ? { type: 'string', enum: [...toolNames] } : { type: 'string' },
      arguments: objectArgs ? { type: 'object', description: 'The arguments, as a JSON object.' } : { type: 'string', description: 'The arguments as a JSON object, encoded in a string.' },
    },
    required: ['tool', 'arguments'],
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: {
      say: { type: 'string', description: 'Text for the operator; empty while calling tools.' },
      calls: { type: 'array', items: call },
    },
    required: ['say', 'calls'],
    additionalProperties: false,
  };
}

function toolChoiceLine(choice: OpsAgentTurnRequest['toolChoice'], names: readonly string[]): string {
  if (names.length === 0 || choice === 'none') return 'Do not call any tool this turn: answer in "say".';
  if (choice === 'required') return 'Call at least one tool this turn.';
  if (typeof choice === 'object') return `Call the tool ${choice.name} this turn.`;
  return 'Call tools if you need them, else answer.';
}

/** The conversation as plain text, newest last; long tool results are cut. */
export function renderConversation(messages: readonly OpsAgentMessage[]): string {
  const kept = messages.length > MAX_MESSAGES ? [messages[0]!, ...messages.slice(-(MAX_MESSAGES - 1))] : [...messages];
  const lines: string[] = [];
  if (kept.length < messages.length) lines.push(`(${messages.length - kept.length} older messages left out)`);
  for (const m of kept) {
    if (m.role === 'tool') {
      lines.push(`[tool result for ${m.callId ?? 'a call'}]\n${clip(m.text, MAX_TOOL_TEXT)}`);
      continue;
    }
    const text = clip(m.text, MAX_MESSAGE_TEXT);
    const calls = (m.calls ?? []).map((c) => `  call ${c.id}: ${c.name} ${clip(c.arguments, 1200)}`).join('\n');
    lines.push(`[${m.role}]${text ? `\n${text}` : ''}${calls ? `\n${calls}` : ''}`);
  }
  return lines.join('\n\n');
}

export function renderPrompt(req: OpsAgentTurnRequest): string {
  const names = req.tools.map((t) => t.name);
  const tools = req.tools.length
    ? req.tools.map((t) => `- ${t.name}: ${t.description}\n  arguments schema: ${JSON.stringify(t.parameters)}`).join('\n')
    : '(none)';
  return [`TOOLS\n${tools}`, `THIS TURN\n${toolChoiceLine(req.toolChoice, names)}`, `CONVERSATION (oldest first)\n${renderConversation(req.messages)}`, 'Write the next turn.'].join('\n\n');
}

/** Arguments as a JSON object: tolerates an object, code fences and surrounding prose; {} when nothing parses. */
export function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  const attempts = [raw, raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')];
  const brace = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (brace >= 0 && end > brace) attempts.push(raw.slice(brace, end + 1));
  for (const text of attempts) {
    try {
      const value = JSON.parse(text) as unknown;
      // A model sometimes encodes the object twice.
      const once = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
      if (once && typeof once === 'object' && !Array.isArray(once)) return once as Record<string, unknown>;
    } catch {
      // try the next form
    }
  }
  return {};
}

interface TurnOutput {
  say: string;
  calls: { tool: string; arguments: unknown }[];
}

/** The JSON object in a model's text: as is, inside code fences, or between the first "{" and the last "}". */
export function extractJsonObject(text: string): string | null {
  const candidates = [text.trim(), text.replace(/^[\s\S]*?```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/, '')];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return c;
    } catch {
      // next
    }
  }
  return null;
}

/**
 * For OpenAI-compatible endpoints (Muse included): when a turn's answer wraps
 * its JSON in code fences or a sentence, hand the provider the JSON alone.
 * Only the ops agents' provider uses it; nothing is logged or kept.
 */
export function lenientJsonFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const res = await base(input, init);
    if (!res.ok) return res;
    const text = await res.text();
    const again = (body: string) => new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    try {
      const payload = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] };
      const message = payload.choices?.[0]?.message;
      if (message && typeof message.content === 'string') {
        try {
          JSON.parse(message.content);
        } catch {
          const fixed = extractJsonObject(message.content);
          if (fixed !== null) {
            message.content = fixed;
            return again(JSON.stringify(payload));
          }
        }
      }
    } catch {
      // not a Chat Completions body: leave it to the provider
    }
    return again(text);
  };
}

/**
 * The provider the ops agents may call, from the same AI settings as every
 * other model call: the live provider in `live` and `record` mode (record
 * keeps nothing for these turns), none in `replay` or `fake` mode, with the
 * reason the console shows next to its offline planner.
 */
export function opsTurnProvider(resolved: ResolvedAi, injected: AiProvider | null, live: () => AiProvider | null): { provider: AiProvider | null; reason: string } {
  if (injected) return injected.mode === 'live' ? { provider: injected, reason: '' } : { provider: null, reason: `The ${injected.id} provider is not live (${injected.mode}).` };
  const s = resolved.settings;
  if (s.provider === 'fake') return { provider: null, reason: `No AI model: ${s.reason}.` };
  if (s.mode !== 'live' && s.mode !== 'record') {
    return { provider: null, reason: `The server's AI is in ${s.mode} mode, which never calls a model; start it with --ai live (HMS_AI_MODE=live) for the ops agents.` };
  }
  const provider = live();
  return provider ? { provider, reason: '' } : { provider: null, reason: `No key for the ${s.provider} provider.` };
}

/** Runs one turn on a live provider; throws AiError when there is none or it fails. */
export async function runOpsTurn(req: OpsAgentTurnRequest, provider: AiProvider | null, offlineReason: string): Promise<OpsAgentTurnResponse> {
  if (!provider || provider.mode !== 'live') throw new AiError('unavailable', offlineReason);
  const names = req.tools.map((t) => t.name);
  const objectArgs = provider.id !== 'anthropic';
  const system = `${opsTurnSystem(objectArgs)}\n\nYou are the "${req.agent}" agent. Your own instructions follow.\n\n${req.instructions || '(none)'}`;
  const ask = (prompt: string) =>
    provider.json<TurnOutput>({
      task: 'ops_agent',
      system,
      prompt,
      images: [],
      schemaName: 'ops_agent_turn',
      schema: turnSchema(names, objectArgs),
      effort: 'low',
      fixtureKey: `ops-agent-${randomUUID()}`,
    });
  let res: Awaited<ReturnType<typeof ask>>;
  try {
    res = await ask(renderPrompt(req));
  } catch (e) {
    // One retry when the answer was not the JSON asked for (it happens on long tool schemas).
    if (!(e instanceof AiError) || e.kind !== 'invalid_output') throw e;
    res = await ask(`${renderPrompt(req)}\n\nYour previous answer was not valid JSON for this schema. Reply with the JSON object only.`);
  }
  const allowed = new Set(names);
  const noTools = req.toolChoice === 'none';
  const calls: OpsAgentToolCall[] = noTools
    ? []
    : (res.data.calls ?? [])
        .filter((c) => allowed.has(c.tool))
        .slice(0, 8)
        .map((c) => ({ id: `call_${randomUUID().slice(0, 12)}`, name: c.tool, arguments: JSON.stringify(parseArguments(c.arguments)) }));
  const say = typeof res.data.say === 'string' ? res.data.say.trim() : '';
  if (!say && calls.length === 0) throw new AiError('invalid_output', 'The model returned an empty turn.');
  return { say, calls, ai: res.stamp };
}
