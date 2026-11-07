import type {
  AgAiConversationItem,
  AgAiEvent,
  AgAiOutputItem,
  AgLlmAdapter,
  AgLlmExecuteTurnOptions,
  AgLlmRequest,
  AgLlmResponse,
  AgLlmResponseHandler,
} from 'ag-studio';
import type { OpsAgentMessage, OpsAgentTurnRequest, OpsAgentTurnResponse } from '@holdmyspot/shared';
import { askServer } from '../../agents/brain.ts';

/**
 * AG Studio's LLM boundary (`AgLlmAdapter`, ag-studio 3.1) pointed at our
 * server: every turn of the market desk and of the Studio agents it
 * delegates to (Data, Page, Widget) is POST /api/ops/agents/turn, answered by
 * the server's AI port (D-100). Studio still owns the loop: it builds the
 * conversation, the instructions and the tool schemas, executes every tool
 * call on the page, and calls the adapter again with the results. The key
 * never reaches the browser.
 *
 * The server answers one turn as `say` plus `calls`; this adapter replays it
 * to Studio as AG-UI content events and as the turn's output items (Studio
 * reads tool calls off `complete.output`).
 */

let seq = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(++seq).toString(36)}`;

function textOf(content: readonly { type: string; text?: string; refusal?: string }[]): string {
  return content
    .map((c) => (c.type === 'text' ? (c.text ?? '') : c.type === 'refusal' ? (c.refusal ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** Studio's conversation items as the server's plain conversation. */
export function toMessages(input: readonly AgAiConversationItem[]): OpsAgentMessage[] {
  const out: OpsAgentMessage[] = [];
  for (const item of input) {
    if (item.type === 'message' && item.kind === 'input') {
      out.push({ role: item.role === 'system' ? 'system' : 'user', text: textOf(item.content) });
    } else if (item.type === 'message' && item.kind === 'output') {
      out.push({ role: 'assistant', text: textOf(item.content) });
    } else if (item.type === 'function_call') {
      const call = { id: item.callId, name: item.name, arguments: item.arguments || '{}' };
      const last = out[out.length - 1];
      if (last?.role === 'assistant') last.calls = [...(last.calls ?? []), call];
      else out.push({ role: 'assistant', text: '', calls: [call] });
    } else if (item.type === 'function_call_output') {
      out.push({ role: 'tool', callId: item.callId, text: item.output });
    }
  }
  return out.length > 0 ? out : [{ role: 'user', text: '(no message)' }];
}

export function toTurnRequest(agent: string, request: AgLlmRequest): OpsAgentTurnRequest {
  const choice = request.toolChoice ?? 'auto';
  return {
    agent,
    instructions: request.instructions ?? '',
    messages: toMessages(request.input),
    tools: (request.tools ?? [])
      .filter((t) => (t.kind ?? 'client') === 'client')
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> })),
    toolChoice: typeof choice === 'string' ? choice : { name: choice.name },
  };
}

/** The server's turn as Studio's output items: the message first, then the tool calls in order. */
export function toOutput(turn: OpsAgentTurnResponse): AgAiOutputItem[] {
  const items: AgAiOutputItem[] = [];
  if (turn.say) {
    items.push({ id: nextId('msg'), kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text: turn.say, annotations: [] }] });
  }
  for (const c of turn.calls) {
    items.push({ id: nextId('fc'), kind: 'output', type: 'function_call', callId: c.id, name: c.name, arguments: c.arguments, status: 'completed' });
  }
  return items;
}

function* events(output: readonly AgAiOutputItem[]): Generator<AgAiEvent> {
  for (const item of output) {
    if (item.type === 'message') {
      yield { type: 'TEXT_MESSAGE_START', messageId: item.id, role: 'assistant' } as AgAiEvent;
      for (const chunk of textOf(item.content).match(/\S+\s*/g) ?? []) yield { type: 'TEXT_MESSAGE_CONTENT', messageId: item.id, delta: chunk } as AgAiEvent;
      yield { type: 'TEXT_MESSAGE_END', messageId: item.id } as AgAiEvent;
    } else if (item.type === 'function_call') {
      yield { type: 'TOOL_CALL_START', toolCallId: item.callId, toolCallName: item.name } as AgAiEvent;
      yield { type: 'TOOL_CALL_ARGS', toolCallId: item.callId, delta: item.arguments } as AgAiEvent;
      yield { type: 'TOOL_CALL_END', toolCallId: item.callId } as AgAiEvent;
    }
  }
}

export interface ServerAdapterHooks {
  /** Every answered turn, for the console's own record (which model answered, how fast). */
  onTurn?(agent: string, turn: OpsAgentTurnResponse): void;
}

export function serverLlmAdapter(agent: string, hooks: ServerAdapterHooks = {}): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options?: AgLlmExecuteTurnOptions): AgLlmResponseHandler {
      const id = nextId('turn');
      const createdAt = Date.now();
      const complete: Promise<AgLlmResponse> = askServer(toTurnRequest(agent, request), options?.signal).then(
        (turn) => {
          hooks.onTurn?.(agent, turn);
          return { id, createdAt, status: 'completed', output: toOutput(turn), model: `${turn.ai.provider}/${turn.ai.model}` };
        },
        (err: unknown) => ({
          id,
          createdAt,
          status: options?.signal?.aborted ? 'cancelled' : 'failed',
          error: { code: 'ai_unavailable', message: `The server's model did not answer: ${err instanceof Error ? err.message : String(err)}` },
          output: [],
        }),
      );
      const stream = {
        async *[Symbol.asyncIterator](): AsyncIterator<AgAiEvent> {
          const res = await complete;
          yield* events(res.output);
        },
      };
      return { stream, complete };
    },
  };
}
