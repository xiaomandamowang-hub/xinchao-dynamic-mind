import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { newState } from '../src/engine.js';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(projectDir, 'src', 'server.js');

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function spawnDelegatedServer(directory, port) {
  const token = 'private-authority-test-0123456789abcdef';
  const output = { value: '' };
  const personalityPath = join(directory, 'personality.json');
  const boxPath = join(directory, 'black-box.json');
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(port),
      SERVICE_TOKEN: token,
      PRIVATE_CONTINUITY_AUTHORITY: 'guimai',
      STATE_PATH: join(directory, 'state.json'),
      TRANSITION_JOURNAL_PATH: join(directory, 'transitions.jsonl'),
      OAUTH_STATE_PATH: join(directory, 'oauth.json'),
      PERSONALITY_PATH: personalityPath,
      BOX_STATE_PATH: boxPath,
      CABIN_STATE_PATH: join(directory, 'cabin.json'),
      OMBRE_HEARTBEAT_FILE: join(directory, 'missing-heartbeat.json'),
      SETTLE_INTERVAL_MINUTES: '1440',
      SHADOW_MODE: 'true',
      MODEL_ENABLED: 'false',
      BARK_ENABLED: 'false',
      DAYTIME_EMERGENCE_ENABLED: 'false',
      CONTEXT_OMBRE_ENABLED: 'false',
      MCP_ENABLED: 'false',
      OAUTH_ENABLED: 'false',
      BRIDGE_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output.value += chunk; });
  child.stderr.on('data', (chunk) => { output.value += chunk; });
  return { child, baseUrl: `http://127.0.0.1:${port}`, token, personalityPath, boxPath, output };
}

async function startDelegatedServer(directory) {
  const port = await freePort();
  const runtime = spawnDelegatedServer(directory, port);
  const { child, baseUrl, output } = runtime;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`delegated server exited: ${output.value}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return runtime;
    } catch { /* startup latency */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`delegated server startup timed out: ${output.value}`);
}

async function exercisePrivateReadPaths(runtime) {
  const headers = { authorization: `Bearer ${runtime.token}` };
  const now = await fetch(`${runtime.baseUrl}/v1/now`, { headers });
  assert.equal(now.status, 200);
  const health = await fetch(`${runtime.baseUrl}/health`);
  assert.deepEqual(
    (({ private_continuity_authority, legacy_private_stores }) => ({ private_continuity_authority, legacy_private_stores }))(await health.json()),
    { private_continuity_authority: 'guimai', legacy_private_stores: 'disabled' },
  );
  const personality = await fetch(`${runtime.baseUrl}/v1/dashboard/personality`, { headers });
  assert.equal(personality.status, 200);
  assert.equal((await personality.json()).available, false);
}

async function stop(child) {
  if (child.exitCode == null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
}

test('Guimai authority leaves absent legacy private stores absent after startup and reads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-guimai-authority-'));
  const runtime = await startDelegatedServer(directory);
  t.after(async () => { await stop(runtime.child); await rm(directory, { recursive: true, force: true }); });
  await exercisePrivateReadPaths(runtime);
  await assert.rejects(() => access(runtime.personalityPath), { code: 'ENOENT' });
  await assert.rejects(() => access(runtime.boxPath), { code: 'ENOENT' });
  assert.match(runtime.output.value, /"authority":"guimai","legacyStores":"disabled"/);
});

test('Guimai authority never reads or rewrites existing legacy private stores', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-guimai-authority-existing-'));
  const personalityPath = join(directory, 'personality.json');
  const boxPath = join(directory, 'black-box.json');
  await writeFile(personalityPath, '{"legacy":"personality sentinel"}\n', 'utf8');
  await writeFile(boxPath, '{"legacy":"black box sentinel"}\n', 'utf8');
  const before = {
    personality: await readFile(personalityPath),
    box: await readFile(boxPath),
    personalityStat: await stat(personalityPath),
    boxStat: await stat(boxPath),
  };
  const runtime = await startDelegatedServer(directory);
  t.after(async () => { await stop(runtime.child); await rm(directory, { recursive: true, force: true }); });
  await exercisePrivateReadPaths(runtime);
  assert.deepEqual(await readFile(personalityPath), before.personality);
  assert.deepEqual(await readFile(boxPath), before.box);
  assert.equal((await stat(personalityPath)).mtimeMs, before.personalityStat.mtimeMs);
  assert.equal((await stat(boxPath)).mtimeMs, before.boxStat.mtimeMs);
});

test('Guimai authority refuses startup when legacy pending content still needs an explicit migration', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-guimai-authority-pending-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const state = newState(new Date('2026-09-12T00:00:00Z'));
  state.pending = [{ id: 'legacy-pending', kind: 'memo', status: 'open', content: 'must survive' }];
  const statePath = join(directory, 'state.json');
  await writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8');
  const before = await readFile(statePath);
  const runtime = spawnDelegatedServer(directory, await freePort());
  const [code] = await once(runtime.child, 'exit');
  assert.notEqual(code, 0);
  assert.match(runtime.output.value, /PRIVATE_CONTINUITY_MIGRATION_REQUIRED/);
  assert.deepEqual(await readFile(statePath), before);
  await assert.rejects(() => access(runtime.personalityPath), { code: 'ENOENT' });
  await assert.rejects(() => access(runtime.boxPath), { code: 'ENOENT' });
});
