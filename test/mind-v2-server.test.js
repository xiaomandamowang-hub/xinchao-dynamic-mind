import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

async function startServer({ directory, enabled }) {
  const port = await freePort();
  const output = { value: '' };
  const token = 'mind-v2-store-test-token-0123456789abcdef';
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(port),
      SERVICE_TOKEN: token,
      STATE_PATH: join(directory, 'state.json'),
      TRANSITION_JOURNAL_PATH: join(directory, 'transitions.jsonl'),
      OAUTH_STATE_PATH: join(directory, 'oauth.json'),
      OMBRE_HEARTBEAT_FILE: join(directory, 'missing-heartbeat.json'),
      MIND_V2_STORE_ENABLED: String(enabled),
      MIND_V2_STATE_PATH: join(directory, 'mind-v2-state.json'),
      MIND_V2_APPRAISALS_ENABLED: 'false',
      MIND_V2_OPEN_LOOPS_ENABLED: 'false',
      MIND_V2_RESONANCE_ENABLED: 'false',
      SETTLE_INTERVAL_MINUTES: '1440',
      SHADOW_MODE: 'true',
      MODEL_ENABLED: 'false',
      MEMORY_V1_ENABLED: 'false',
      BARK_ENABLED: 'false',
      DAYTIME_EMERGENCE_ENABLED: 'false',
      CONTEXT_OMBRE_ENABLED: 'false',
      MCP_ENABLED: 'false',
      OAUTH_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output.value += chunk; });
  child.stderr.on('data', (chunk) => { output.value += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`test server exited: ${output.value}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) {
        if (!enabled || output.value.includes('mind_v2_store_status')) {
          return { child, output, baseUrl, token };
        }
      }
    } catch {
      // The child may still be binding its loopback port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`test server startup timed out: ${output.value}`);
}

async function stopServer(child) {
  if (child.exitCode == null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
}

test('disabled Mind v2 preserves startup behavior and creates no file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-mind-v2-server-off-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const running = await startServer({ directory, enabled: false });
  t.after(() => stopServer(running.child));
  await assert.rejects(() => stat(join(directory, 'mind-v2-state.json')), { code: 'ENOENT' });
  assert.doesNotMatch(running.output.value, /mind_v2_store_status/);
});

test('enabled empty Store is independent from Base state and survives restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-mind-v2-server-on-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseState = newState(new Date('2026-08-09T12:00:00.000Z'));
  await writeFile(join(directory, 'state.json'), `${JSON.stringify(baseState, null, 2)}\n`);

  const first = await startServer({ directory, enabled: true });
  const stateResponse = await fetch(`${first.baseUrl}/v1/state`, {
    headers: { authorization: `Bearer ${first.token}` },
  });
  assert.deepEqual(await stateResponse.json(), baseState);
  const contextResponse = await fetch(
    `${first.baseUrl}/v1/context?mode=inspect&session_id=mind-v2-store&force=true`,
    { headers: { authorization: `Bearer ${first.token}` } },
  );
  const context = await contextResponse.json();
  assert.deepEqual(context.sections.map((section) => section.id), ['dynamic_state']);
  assert.doesNotMatch(context.additionalContext, /appraisal|open.?loop|resonance/i);
  const mindPath = join(directory, 'mind-v2-state.json');
  const beforeRestart = await readFile(mindPath, 'utf8');
  assert.match(first.output.value, /"event":"mind_v2_store_status"/);
  assert.doesNotMatch(first.output.value, /appraisals|openLoops|resonance/);
  await stopServer(first.child);

  const restarted = await startServer({ directory, enabled: true });
  t.after(() => stopServer(restarted.child));
  assert.equal(await readFile(mindPath, 'utf8'), beforeRestart);
  if (process.platform !== 'win32') {
    assert.equal((await stat(mindPath)).mode & 0o777, 0o600);
  }
});

test('corrupt Mind v2 file is omitted while Base health remains available', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-mind-v2-server-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateMarker = 'private-appraisal-must-not-enter-log';
  await writeFile(join(directory, 'mind-v2-state.json'), `{${privateMarker}`);
  const running = await startServer({ directory, enabled: true });
  t.after(() => stopServer(running.child));
  assert.equal((await fetch(`${running.baseUrl}/health`)).status, 200);
  assert.match(running.output.value, /"status":"omitted"/);
  assert.match(running.output.value, /"errorCode":"mind_v2_parse_failed"/);
  assert.doesNotMatch(running.output.value, new RegExp(privateMarker));
  assert.equal(await readFile(join(directory, 'mind-v2-state.json'), 'utf8'), `{${privateMarker}`);
});
