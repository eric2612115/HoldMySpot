import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_ROOT } from '../../src/config.ts';
import { after, describe, it } from 'node:test';
import { inspect } from 'node:util';
import { loadSandboxEnvFile, maskId, parseDotenv, secretsDir } from '../../src/paypal/index.ts';

/** The file-only credentials loader used by the probe script. All values here are dummies. */

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hms-paypal-creds-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const DUMMY_SECRET = 'dummy-secret-for-tests-only';

function writeEnv(dir: string, lines: string[], mode = 0o600): void {
  const file = join(dir, 'sandbox.env');
  writeFileSync(file, `${lines.join('\n')}\n`, { mode });
  chmodSync(file, mode);
}

describe('sandbox.env loader', () => {
  it('reports a missing file by name, without throwing', () => {
    const r = loadSandboxEnvFile({ dir: join(tempDir(), 'nope') });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.missing, ['PAYPAL_ENV', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']);
    assert.match(r.reason, /not found/);
  });

  it('loads a complete file and keeps the secret out of JSON and console output', () => {
    const dir = tempDir();
    writeEnv(dir, [
      '# comment',
      'PAYPAL_ENV=sandbox',
      'PAYPAL_CLIENT_ID=AbCdEf0123456789xyz',
      `PAYPAL_CLIENT_SECRET="${DUMMY_SECRET}"`,
      'PAYPAL_MERCHANT_EMAIL=merchant@business.example.com',
      'export PAYPAL_BUYER_EMAIL=buyer@personal.example.com',
    ]);
    const r = loadSandboxEnvFile({ dir });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.settings.clientSecret, DUMMY_SECRET);
    assert.equal(r.settings.clientId, 'AbCdEf0123456789xyz');
    assert.equal(r.settings.webhookId, null);
    assert.deepEqual(r.missingRecommended, ['PAYPAL_MERCHANT_ID', 'PAYPAL_PAYOUT_EMAIL']);
    assert.deepEqual(r.warnings, []);
    assert.ok(!JSON.stringify(r).includes(DUMMY_SECRET));
    assert.ok(!inspect(r, { depth: 5 }).includes(DUMMY_SECRET));
  });

  it('refuses anything but the sandbox, and names missing variables only', () => {
    const live = tempDir();
    writeEnv(live, ['PAYPAL_ENV=live', 'PAYPAL_CLIENT_ID=x', `PAYPAL_CLIENT_SECRET=${DUMMY_SECRET}`]);
    const r1 = loadSandboxEnvFile({ dir: live });
    assert.equal(r1.ok, false);
    if (!r1.ok) {
      assert.match(r1.reason, /sandbox/);
      assert.ok(!r1.reason.includes(DUMMY_SECRET));
    }
    const partial = tempDir();
    writeEnv(partial, ['PAYPAL_ENV=sandbox', 'PAYPAL_CLIENT_ID=x']);
    const r2 = loadSandboxEnvFile({ dir: partial });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.deepEqual(r2.missing, ['PAYPAL_CLIENT_SECRET']);
  });

  it('warns when other users can read the file', () => {
    const dir = tempDir();
    writeEnv(dir, ['PAYPAL_ENV=sandbox', 'PAYPAL_CLIENT_ID=x', `PAYPAL_CLIENT_SECRET=${DUMMY_SECRET}`], 0o644);
    const r = loadSandboxEnvFile({ dir });
    assert.equal(r.ok, true);
    assert.match(r.warnings.join(' '), /chmod 600/);
  });

  it('parses dotenv quirks', () => {
    const m = parseDotenv('A=1\r\nexport B = two \nC="quoted # not a comment"\nD=plain # comment\n# E=no\nF=\nG=\'single\'');
    assert.deepEqual(Object.fromEntries(m), { A: '1', B: 'two', C: 'quoted # not a comment', D: 'plain', F: '', G: 'single' });
  });

  it("finds the secrets folder from HMS_SECRETS_DIR, else the repo's own .secrets/ (D-131)", () => {
    assert.equal(secretsDir({}), join(SERVER_ROOT, '..', '.secrets'));
    assert.equal(secretsDir({ HMS_SECRETS_DIR: '/tmp/x' }), '/tmp/x');
    assert.equal(secretsDir({ HMS_SECRETS_DIR: '~/s' }), join(homedir(), 's'));
  });

  it('masks long client ids for display', () => {
    assert.equal(maskId('BAA_hcABCDEFGHIJKLMNOPQRSThkE4'), 'BAA_hc...hkE4');
    assert.equal(maskId('short'), 'short');
  });
});
