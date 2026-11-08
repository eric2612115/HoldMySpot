import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { join } from 'node:path';
import { zonedLocalToEpoch } from '@holdmyspot/shared';
import { SERVER_ROOT } from '../src/config.ts';
import { testServer, type TestServer } from './helpers.ts';

/**
 * The zero-key demo calls neither PayPal nor a model (docs/TECHNICAL-DETAILS.md, "What is simulated"; claims.md H4; D-149):
 * the hero day on the real AI services with the recorded model answers and the PayPal emulator, with
 * every outgoing call refused and recorded. Both ways out are watched: `fetch` (the PayPal REST
 * client's sandbox transport, the model providers and the Anthropic SDK use it) and raw sockets
 * (`net.Socket.prototype.connect`, under every HTTP client). The test drives the server in process, so
 * nothing needs a socket at all; a local socket would still be allowed.
 */

const sf = (hhmm: string) => zonedLocalToEpoch(`2026-11-12 ${hhmm}`, 'America/Los_Angeles')!;
const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

describe('the zero-key demo makes no network call', () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const realConnect = net.Socket.prototype.connect;
  let s: TestServer | undefined;

  before(async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(`fetch ${url}`);
      throw new Error(`network call refused by the test: ${url}`);
    }) as typeof fetch;
    net.Socket.prototype.connect = function connect(this: net.Socket, ...args: unknown[]) {
      const first = args[0];
      const host = typeof first === 'object' && first !== null ? ((first as { host?: string; path?: string }).path ? 'localhost' : ((first as { host?: string }).host ?? 'localhost')) : String(args[1] ?? 'localhost');
      if (!LOCAL.has(host)) {
        calls.push(`connect ${host}`);
        throw new Error(`network call refused by the test: ${host}`);
      }
      return (realConnect as unknown as (...a: unknown[]) => net.Socket).apply(this, args);
    } as typeof net.Socket.prototype.connect;
    s = await testServer({ demo: true, crowd: true, ai: 'real', env: { HMS_AI_FIXTURES_DIR: join(SERVER_ROOT, 'fixtures', 'ai') } });
    await s.director!.start('hero', null);
    s.app.clock.pause();
    await s.at(sf('14:05'));
  });

  after(async () => {
    globalThis.fetch = realFetch;
    net.Socket.prototype.connect = realConnect;
    await s?.done();
  });

  it('plays the hero day, captures and payouts included, with no call leaving the process', () => {
    assert.equal(s!.director!.state().status, 'finished');
    assert.deepEqual(calls, [], 'no fetch and no socket to another host');
    const bid = s!.app.store.bids.first("requester_id = 'mia'")!;
    const hold = s!.app.store.holds.must(bid.holdId!);
    assert.deepEqual([hold.amount.cents, hold.capturedCents, hold.releasedCents], [6370, 5826, 544], 'the money moved on the PayPal emulator');
    assert.equal(s!.app.store.payouts.where("recipient_user_id = 'wei' AND status = 'succeeded'").length, 2);
    const receipt = s!.app.store.proofs.first("kind = 'purchase' AND status = 'passed'")!;
    assert.equal(receipt.ai?.mode, 'replay', 'the receipt was read from a recorded answer, not by a model call');
  });
});
