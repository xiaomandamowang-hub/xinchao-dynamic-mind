import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(projectDir, 'src', 'server.js');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

async function fakeMemory(items, { fail = false } = {}) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const payload = raw ? JSON.parse(raw) : {};
    if (payload.method === 'notifications/initialized') {
      response.writeHead(202).end();
      return;
    }
    if (fail && payload.method === 'tools/call') {
      response.writeHead(503).end();
      return;
    }
    if (payload.method === 'initialize') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0', id: payload.id,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-memory', version: '1' } },
      }));
      return;
    }
    const name = payload.params?.name;
    calls.push(name);
    let structuredContent = { items: [] };
    if (name === 'surface' || name === 'recall_timeline' || name === 'search') {
      structuredContent = { items };
    } else if (name === 'fetch') {
      structuredContent = { memory: items.find((item) => item.id === payload.params?.arguments?.id) ?? null };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      jsonrpc: '2.0', id: payload.id,
      result: { content: [], structuredContent, isError: false },
    }));
  });
  const port = await listen(server);
  return { server, calls, url: `http://127.0.0.1:${port}/mcp` };
}

async function startMind(directory, memoryUrl, { corrupt = false } = {}) {
  const probe = createServer();
  const port = await listen(probe);
  await close(probe);
  const token = 'recall-delivery-server-test-token-0123456789abcdef';
  const pathToken = 'recall-delivery-mcp-path-token';
  const output = { value: '' };
  if (corrupt) await writeFile(join(directory, 'mind-v2-state.json'), '{private-corrupt-canary');
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
      MIND_V2_STORE_ENABLED: 'true',
      MIND_V2_STATE_PATH: join(directory, 'mind-v2-state.json'),
      MIND_V2_APPRAISALS_ENABLED: 'false',
      MIND_V2_OPEN_LOOPS_ENABLED: 'false',
      MIND_V2_RECALL_DELIVERY_RECEIPTS_ENABLED: 'true',
      MIND_V2_RESONANCE_ENABLED: 'false',
      SETTLE_INTERVAL_MINUTES: '1440',
      SHADOW_MODE: 'true',
      MODEL_ENABLED: 'false',
      MEMORY_V1_ENABLED: 'true',
      MEMORY_V1_MCP_URL: memoryUrl,
      MEMORY_V1_CONTEXT_ENABLED: 'true',
      MEMORY_V1_SHADOW_CONTEXT_ENABLED: 'true',
      MEMORY_V1_DETAIL_FETCHES: '1',
      BARK_ENABLED: 'false',
      DAYTIME_EMERGENCE_ENABLED: 'false',
      CONTEXT_OMBRE_ENABLED: 'false',
      MCP_ENABLED: 'true',
      MCP_PATH_TOKEN: pathToken,
      OAUTH_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output.value += chunk; });
  child.stderr.on('data', (chunk) => { output.value += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const readyEvent = corrupt ? 'mind_v2_store_status' : 'mind_v2_recall_delivery_status';
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`test server exited: ${output.value}`);
    try {
      const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
      if (health.ok && output.value.includes(readyEvent)) {
        return { child, output, baseUrl, token, pathToken };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`test server startup timed out: ${output.value}`);
}

async function stopMind(child) {
  if (child.exitCode == null && child.signalCode == null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
}

async function mcpContext(mind, sessionId) {
  return fetch(`${mind.baseUrl}/mcp/${mind.pathToken}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-session-id': sessionId,
      connection: 'close',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'xinchao_context', arguments: {} },
    }),
    signal: AbortSignal.timeout(3_000),
  });
}

async function addHandoff(mind, sessionId) {
  const response = await fetch(`${mind.baseUrl}/v1/handoff-note`, {
    method: 'POST',
    headers: { authorization: `Bearer ${mind.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      event_id: `handoff-${sessionId}`,
      note: 'continue alpha architecture and beta deployment',
      ttl_hours: 6,
    }),
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200);
}

async function waitForReceipts(path, count) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if ((state.recallDeliveryReceipts ?? []).length === count) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`receipt count did not reach ${count}`);
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('successful formal MCP Context records deduplicated receipts only after delivery', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-recall-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canaryId = 'memory-id-canary-must-not-enter-log';
  const canaryBody = 'memory body canary must not enter runtime log';
  const memory = await fakeMemory([
    {
      id: canaryId, type: 'project', source: 'git', title: 'Alpha architecture',
      summary: `alpha architecture decision ${canaryBody}`, content: `alpha architecture decision ${canaryBody}`,
      status: 'active', review_state: 'confirmed', occurred_at: '2026-08-08T00:00:00.000Z',
    },
    {
      id: 'memory-contested-beta', type: 'project', source: 'git', title: 'Beta deployment',
      summary: 'beta deployment remains under review', content: 'beta deployment remains under review',
      status: 'contested', review_state: 'confirmed', occurred_at: '2026-08-08T01:00:00.000Z',
    },
  ]);
  t.after(() => close(memory.server));
  const mind = await startMind(directory, memory.url);
  t.after(() => stopMind(mind.child));
  await addHandoff(mind, 'receipt-session');

  const response = await mcpContext(mind, 'receipt-session');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result.isError, false);
  assert.match(payload.result.content[0].text, /alpha architecture/i);

  const mindPath = join(directory, 'mind-v2-state.json');
  const state = await waitForReceipts(mindPath, 2);
  assert.equal(state.recallDeliveryReceipts.length, 2);
  assert.deepEqual(new Set(state.recallDeliveryReceipts.map((item) => item.memoryStatusAtDelivery)), new Set(['active', 'contested']));
  assert.equal(new Set(state.recallDeliveryReceipts.map((item) => item.contextDeliveryId)).size, 1);
  assert.equal(state.appraisals.length, 0);
  assert.equal(state.openLoops.length, 0);
  assert.equal(state.resonance.length, 0);
  assert.equal(memory.calls.includes('remember'), false);
  assert.equal(memory.calls.includes('read_evidence'), false);

  const baseAfterDelivery = await readFile(join(directory, 'state.json'));
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(sha(await readFile(join(directory, 'state.json'))), sha(baseAfterDelivery));
  assert.doesNotMatch(mind.output.value, new RegExp(canaryId));
  assert.doesNotMatch(mind.output.value, new RegExp(canaryBody));
  assert.match(mind.output.value, /"event":"mind_v2_recall_delivery"/);

  const duplicate = await mcpContext(mind, 'receipt-session');
  assert.equal(duplicate.status, 200);
  await duplicate.arrayBuffer();
  await new Promise((resolve) => setTimeout(resolve, 75));
  const repeated = JSON.parse(await readFile(mindPath, 'utf8'));
  assert.equal(repeated.recallDeliveryReceipts.length, 2);

  await stopMind(mind.child);
  const restarted = await startMind(directory, memory.url);
  t.after(() => stopMind(restarted.child));
  const recovered = JSON.parse(await readFile(mindPath, 'utf8'));
  assert.equal(recovered.recallDeliveryReceipts.length, 2);
  assert.deepEqual(recovered.recallDeliveryReceipts, repeated.recallDeliveryReceipts);
});

test('Memory failure falls back to Base Context without a false receipt', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-recall-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const memory = await fakeMemory([], { fail: true });
  t.after(() => close(memory.server));
  const mind = await startMind(directory, memory.url);
  t.after(() => stopMind(mind.child));
  await addHandoff(mind, 'fallback-session');
  const response = await mcpContext(mind, 'fallback-session');
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await new Promise((resolve) => setTimeout(resolve, 75));
  const state = JSON.parse(await readFile(join(directory, 'mind-v2-state.json'), 'utf8'));
  assert.equal(state.recallDeliveryReceipts.length, 0);
  assert.doesNotMatch(mind.output.value, /"event":"mind_v2_recall_delivery"/);
});

test('corrupt Mind Store omits receipt capability while Base remains healthy', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-recall-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const memory = await fakeMemory([]);
  t.after(() => close(memory.server));
  const mind = await startMind(directory, memory.url, { corrupt: true });
  t.after(() => stopMind(mind.child));
  const health = await fetch(`${mind.baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.match(mind.output.value, /"errorCode":"mind_v2_parse_failed"/);
  assert.doesNotMatch(mind.output.value, /private-corrupt-canary/);
});
