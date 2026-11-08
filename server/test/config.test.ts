import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { SandboxConfigError, loadConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';
import { FakeAi } from '../src/fakes/ai.ts';

/** HMS_MODE=sandbox fails loudly when its settings are missing (docs/DECISIONS.md D-108). All values here are dummies. */

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hms-config-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const DUMMY_SECRET = 'dummy-secret-for-config-tests';

describe('HMS_MODE=sandbox', () => {
  it('refuses to start when sandbox.env is missing, naming what is missing and never a value', () => {
    let err: unknown = null;
    try {
      loadConfig({ HMS_MODE: 'sandbox', HMS_SECRETS_DIR: tempDir(), HMS_DB_PATH: ':memory:' });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof SandboxConfigError, `expected a SandboxConfigError, got ${String(err)}`);
    assert.deepEqual(err.missing, ['PAYPAL_ENV', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_MERCHANT_EMAIL', 'PAYPAL_MERCHANT_ID', 'PAYPAL_BUYER_EMAIL', 'PAYPAL_PAYOUT_EMAIL']);
    assert.match(err.message, /^HMS_MODE=sandbox needs the PayPal sandbox settings/);
    assert.match(err.message, /Nothing was started\. Run npm run keys/);
  });

  it('names only the missing settings of an incomplete file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'sandbox.env'), `PAYPAL_ENV=sandbox\nPAYPAL_CLIENT_ID=dummy-client\nPAYPAL_CLIENT_SECRET=${DUMMY_SECRET}\n`);
    let err: unknown = null;
    try {
      loadConfig({ HMS_MODE: 'sandbox', HMS_SECRETS_DIR: dir, HMS_DB_PATH: ':memory:' });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof SandboxConfigError);
    assert.deepEqual(err.missing, ['PAYPAL_MERCHANT_EMAIL', 'PAYPAL_MERCHANT_ID', 'PAYPAL_BUYER_EMAIL', 'PAYPAL_PAYOUT_EMAIL']);
    assert.equal(err.source, 'sandbox.env');
    assert.ok(!err.message.includes(DUMMY_SECRET) && !err.message.includes('dummy-client'), 'no value in the message');
  });

  it('runs the simulated PayPal only with the explicit opt-in, and says why', () => {
    const c = loadConfig({ HMS_MODE: 'sandbox', HMS_SECRETS_DIR: tempDir(), HMS_DB_PATH: ':memory:', HMS_SANDBOX_FALLBACK: 'fake' });
    assert.equal(c.mode, 'fake');
    assert.equal(c.sandboxFallback, true);
    assert.match(c.modeReason, /^HMS_MODE=sandbox but process env is missing PAYPAL_ENV, .*: running fake\.$/);
  });

  it('starts in sandbox mode with a complete file, and the default stays the simulated PayPal', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'sandbox.env'),
      [
        'PAYPAL_ENV=sandbox',
        'PAYPAL_CLIENT_ID=dummy-client',
        `PAYPAL_CLIENT_SECRET=${DUMMY_SECRET}`,
        'PAYPAL_MERCHANT_EMAIL=merchant@business.example.com',
        'PAYPAL_MERCHANT_ID=DUMMYMERCHANT',
        'PAYPAL_BUYER_EMAIL=buyer@personal.example.com',
        'PAYPAL_PAYOUT_EMAIL=payouts@personal.example.com',
      ].join('\n'),
    );
    const c = loadConfig({ HMS_MODE: 'sandbox', HMS_SECRETS_DIR: dir, HMS_DB_PATH: ':memory:' });
    assert.equal(c.mode, 'sandbox');
    assert.equal(c.paypal?.payoutReceiverEmail, 'payouts@personal.example.com');
    // The payout receiver's older name is still read (D-132).
    const old = tempDir();
    writeFileSync(join(old, 'sandbox.env'), readFileSync(join(dir, 'sandbox.env'), 'utf8').replace('PAYPAL_PAYOUT_EMAIL=', 'PAYPAL_TW_PAYOUT_EMAIL='));
    assert.equal(loadConfig({ HMS_MODE: 'sandbox', HMS_SECRETS_DIR: old, HMS_DB_PATH: ':memory:' }).paypal?.payoutReceiverEmail, 'payouts@personal.example.com');
    assert.equal(c.sandboxFallback, false);
    assert.equal(loadConfig({ HMS_SECRETS_DIR: tempDir(), HMS_DB_PATH: ':memory:' }).mode, 'fake');
  });

  it('refuses to start when the sandbox adapter cannot be built, unless the opt-in is set', async () => {
    const dir = tempDir();
    const base = loadConfig({ HMS_SECRETS_DIR: dir, HMS_DB_PATH: ':memory:', HMS_UPLOAD_DIR: join(dir, 'uploads'), HMS_CROWD: '0' });
    // Sandbox mode without settings reaching the adapter.
    const broken = { ...base, mode: 'sandbox' as const, paypal: null };
    const refused = await createServer(broken, { workers: false, ai: new FakeAi(), log: () => undefined }).then(
      async (s) => {
        await s.close();
        return null;
      },
      (e: unknown) => e,
    );
    assert.match(String(refused), /HMS_MODE=sandbox, but no PayPal sandbox settings were loaded\. Nothing was started\./);
    const s = await createServer({ ...broken, sandboxFallback: true }, { workers: false, ai: new FakeAi(), log: () => undefined });
    try {
      assert.equal(s.app.config.mode, 'fake');
      assert.match(s.app.config.modeReason, /but no PayPal sandbox settings were loaded: running fake\.$/);
    } finally {
      await s.close();
    }
  });
});
