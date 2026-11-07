import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import { SecretValue, aiBootLine, keyFileEntries, readDotenvKeys, resolveAiSettings } from '../../src/ai/config.ts';
import { loadLocalEnv } from '../../src/localenv.ts';
import { tempDir } from './helpers.ts';

const A = 'sk-ant-test-0123456789';
const M = 'muse-test-9876543210';
const OTHER = 'do-not-read-this-value';

function secrets(): { dir: string; extra: string } {
  const dir = tempDir();
  writeFileSync(join(dir, 'ai.env'), `# AI keys\nANTHROPIC_API_KEY=${A}\nOTHER_SECRET=${OTHER}\n`);
  const extra = join(dir, 'extra.env');
  writeFileSync(extra, `export MODEL_API_KEY='${M}'\nPAYPAL_CLIENT_SECRET=${OTHER}\n`);
  return { dir, extra };
}

describe('AI keys', () => {
  it('reads only the two key names from dotenv files', () => {
    const { dir } = secrets();
    const keys = readDotenvKeys(join(dir, 'ai.env'), ['ANTHROPIC_API_KEY', 'MODEL_API_KEY']);
    assert.deepEqual([...keys.keys()], ['ANTHROPIC_API_KEY']);
    assert.equal(keys.get('ANTHROPIC_API_KEY')?.reveal(), A);
  });

  it('picks Anthropic first and never shows a value in reports, JSON or logs', () => {
    const { dir, extra } = secrets();
    const r = resolveAiSettings({ env: { HMS_AI_KEY_FILES: extra }, secretsDir: dir });
    assert.equal(r.settings.provider, 'anthropic');
    assert.equal(r.settings.model, 'claude-opus-5-5');
    assert.equal(r.settings.mode, 'replay', 'fake runtime mode defaults to replay');
    assert.deepEqual(r.sources, { anthropic: 'ai.env', muse: 'extra.env' });
    assert.equal(r.report.anthropicKeyPresent && r.report.museKeyPresent, true);
    for (const shown of [JSON.stringify(r), inspect(r, { depth: 10 }), aiBootLine(r), String(r.keys.anthropic)]) {
      for (const secret of [A, M, OTHER]) assert.ok(!shown.includes(secret), `a value leaked into: ${shown.slice(0, 80)}`);
    }
    assert.equal(r.keys.muse?.reveal(), M);
  });

  it('narrows a key file to the names after #, so only MODEL_API_KEY is read from another project', () => {
    const dir = tempDir();
    const other = join(dir, 'other-project.env');
    writeFileSync(other, `ANTHROPIC_API_KEY=${A}\nMODEL_API_KEY=${M}\nSECRET=${OTHER}\n`);
    assert.deepEqual(keyFileEntries(`${other}#MODEL_API_KEY`), [{ file: other, names: ['MODEL_API_KEY'] }]);
    assert.deepEqual(keyFileEntries(`${other}#SECRET+NOPE`), [], 'unknown names can never widen what is read');
    const r = resolveAiSettings({ env: { HMS_AI_KEY_FILES: `${other}#MODEL_API_KEY` }, secretsDir: tempDir() });
    assert.equal(r.report.anthropicKeyPresent, false, 'the Anthropic key in that file is not read');
    assert.equal(r.settings.provider, 'muse');
    assert.equal(r.keys.muse?.reveal(), M);
    assert.ok(r.report.searched.some((x) => x.endsWith('(MODEL_API_KEY only)')));
  });

  it('takes only HMS_* settings from server/.env.local, never over the process environment', () => {
    const dir = tempDir();
    const file = join(dir, '.env.local');
    writeFileSync(file, `HMS_AI_KEY_FILES=/x/.env#MODEL_API_KEY\nMODEL_API_KEY=${M}\nHMS_PORT=9999\n`);
    const env: Record<string, string | undefined> = { HMS_PORT: '8796' };
    assert.deepEqual(loadLocalEnv(file, env), ['HMS_AI_KEY_FILES']);
    assert.deepEqual(env, { HMS_PORT: '8796', HMS_AI_KEY_FILES: '/x/.env#MODEL_API_KEY' });
  });

  it('prefers the process environment over files', () => {
    const { dir } = secrets();
    const r = resolveAiSettings({ env: { ANTHROPIC_API_KEY: 'sk-from-env' }, secretsDir: dir });
    assert.equal(r.sources.anthropic, 'process env');
    assert.equal(r.keys.anthropic?.reveal(), 'sk-from-env');
  });

  it('SecretValue hides itself everywhere', () => {
    const s = new SecretValue('xyz-secret');
    assert.equal(`${s}`, '[redacted]');
    assert.equal(JSON.stringify({ s }), '{"s":"[redacted]"}');
    assert.ok(!inspect(s).includes('xyz'));
  });
});

describe('provider and mode', () => {
  const none = () => ({ secretsDir: tempDir() });

  it('falls back to replay of saved answers without any key, with no network', () => {
    const r = resolveAiSettings({ env: {}, ...none() });
    assert.deepEqual([r.settings.provider, r.settings.model, r.settings.mode], ['fake', 'rules-v1', 'replay']);
    assert.match(r.settings.reason, /no AI key/);
    const live = resolveAiSettings({ env: {}, runtimeMode: 'sandbox', ...none() });
    assert.equal(live.settings.mode, 'replay', 'live is impossible without a key');
  });

  it('forces rules only when the provider is set to fake', () => {
    const r = resolveAiSettings({ env: { HMS_AI_PROVIDER: 'fake', ANTHROPIC_API_KEY: 'k' }, ...none() });
    assert.deepEqual([r.settings.provider, r.settings.mode], ['fake', 'fake']);
  });

  it('runs live in sandbox mode with a key, and honours explicit choices', () => {
    assert.equal(resolveAiSettings({ env: { MODEL_API_KEY: 'k' }, runtimeMode: 'sandbox', ...none() }).settings.mode, 'live');
    const muse = resolveAiSettings({ env: { MODEL_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, aiProvider: 'muse', aiMode: 'record', ...none() });
    assert.deepEqual([muse.settings.provider, muse.settings.model, muse.settings.mode], ['muse', 'muse-spark-1.3', 'record']);
    const missing = resolveAiSettings({ env: { ANTHROPIC_API_KEY: 'a' }, aiProvider: 'muse', ...none() });
    assert.equal(missing.settings.provider, 'fake');
    assert.match(missing.settings.reason, /MODEL_API_KEY was not found/);
  });
});
