import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MindV2Store } from '../src/mind-v2-store.js';
import { newMindV2State } from '../src/mind-v2-state.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-mind-v2-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'mind-v2-state.json') };
}

test('disabled store neither reads nor creates a file', async (t) => {
  const { path } = await fixture(t);
  const store = new MindV2Store(path);
  assert.deepEqual(await store.initialize(), {
    status: 'disabled', state: null, digest: null, errorCode: null,
  });
  await assert.rejects(() => store.write(newMindV2State()), /mind_v2_store_disabled/);
  await assert.rejects(() => stat(path), { code: 'ENOENT' });
});

test('first enable creates the empty schema with mode 0600', async (t) => {
  const { path } = await fixture(t);
  const now = new Date('2026-08-09T12:00:00.000Z');
  const store = new MindV2Store(path, { enabled: true, factory: () => newMindV2State(now) });
  const result = await store.initialize();
  assert.equal(result.status, 'created');
  assert.deepEqual(result.state, {
    schemaVersion: 1,
    revision: 0,
    lastSettledAt: now.toISOString(),
    appraisals: [],
    openLoops: [],
    recallDeliveryReceipts: [],
    resonance: [],
    idempotency: {},
  });
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test('repeat initialization and restart recover the exact state', async (t) => {
  const { path } = await fixture(t);
  const state = newMindV2State(new Date('2026-08-09T12:00:00.000Z'));
  const store = new MindV2Store(path, { enabled: true, factory: () => state });
  await store.initialize();
  const before = await readFile(path, 'utf8');
  assert.equal((await store.initialize()).status, 'ready');
  const restarted = new MindV2Store(path, { enabled: true });
  assert.deepEqual((await restarted.initialize()).state, state);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('serialized atomic updates leave valid JSON and no temp files', async (t) => {
  const { directory, path } = await fixture(t);
  const store = new MindV2Store(path, {
    enabled: true,
    factory: () => newMindV2State(new Date('2026-08-09T12:00:00.000Z')),
  });
  await store.initialize();
  await Promise.all(Array.from({ length: 20 }, () => store.update((state) => {
    state.revision += 1;
    return state;
  })));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).revision, 20);
  const entries = await import('node:fs/promises').then(({ readdir }) => readdir(directory));
  assert.deepEqual(entries, ['mind-v2-state.json']);
});

test('corrupt, empty and unknown-schema files are omitted without overwrite', async (t) => {
  for (const [name, body, code] of [
    ['corrupt', '{private future text', 'mind_v2_parse_failed'],
    ['empty', '', 'mind_v2_parse_failed'],
    ['future', JSON.stringify({ ...newMindV2State(), schemaVersion: 2 }), 'mind_v2_unknown_schema'],
  ]) {
    const { path } = await fixture(t);
    await writeFile(path, body, { mode: 0o600 });
    const store = new MindV2Store(path, { enabled: true });
    const result = await store.initialize();
    assert.equal(result.status, 'omitted', name);
    assert.equal(result.errorCode, code, name);
    assert.equal(result.state, null, name);
    assert.equal(await readFile(path, 'utf8'), body, name);
  }
});

test('deleting the store safely rebuilds a new empty state', async (t) => {
  const { path } = await fixture(t);
  const store = new MindV2Store(path, { enabled: true });
  await store.initialize();
  await rm(path);
  const rebuilt = await store.initialize();
  assert.equal(rebuilt.status, 'created');
  assert.equal(rebuilt.state.schemaVersion, 1);
  assert.equal(rebuilt.state.revision, 0);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test('atomic replacement restores restrictive permissions', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows does not expose POSIX mode enforcement');
    return;
  }
  const { path } = await fixture(t);
  const store = new MindV2Store(path, { enabled: true });
  const created = await store.initialize();
  await chmod(path, 0o644);
  await store.write(created.state);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
