import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function startServer(directory, { corrupt = false } = {}) {
  const port = await freePort();
  const token = 'open-loop-server-test-token-0123456789abcdef';
  const pathToken = 'open-loop-mcp-path-token';
  const output = { value: '' };
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
      MIND_V2_APPRAISALS_ENABLED: 'true',
      MIND_V2_OPEN_LOOPS_ENABLED: 'true',
      MIND_V2_RESONANCE_ENABLED: 'false',
      SETTLE_INTERVAL_MINUTES: '1440',
      SHADOW_MODE: 'true',
      MODEL_ENABLED: 'false',
      MEMORY_V1_ENABLED: 'false',
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
  const readyEvent = corrupt ? 'mind_v2_store_status' : 'mind_v2_open_loop_status';
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`test server exited: ${output.value}`);
    try {
      if ((await fetch(`${baseUrl}/health`, {
        headers: { connection: 'close' }, signal: AbortSignal.timeout(500),
      })).ok && output.value.includes(readyEvent)) {
        return { child, output, baseUrl, token, pathToken };
      }
    } catch {
      // The child may still be binding its loopback port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`test server startup timed out: ${output.value}`);
}

async function stopServer(child) {
  if (child.exitCode == null && child.signalCode == null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    if (!graceful && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

async function mcp(server, method, params, id = 1) {
  const response = await fetch(`${server.baseUrl}/mcp/${server.pathToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function mcpCall(server, name, args, id = 1) {
  return mcp(server, 'tools/call', { name, arguments: args }, id);
}

async function conversationEvent(server, eventId) {
  const response = await fetch(`${server.baseUrl}/v1/conversation-event`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
      connection: 'close',
    },
    body: JSON.stringify({
      session_id: 'open-loop-session',
      event_id: eventId,
      interaction_type: 'reflection',
      tone: 'calm',
    }),
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200);
}

const sha = (value) => createHash('sha256').update(value).digest('hex');

test('real event to Open Loop lifecycle is isolated from Base, Appraisal, Memory and Context', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-open-loop-server-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await startServer(directory);
  t.after(() => stopServer(server.child));

  const listed = await mcp(server, 'tools/list', {}, 10);
  const toolNames = listed.result.tools.map((item) => item.name);
  assert.ok(toolNames.includes('xinchao_appraisal'));
  assert.ok(toolNames.includes('xinchao_open_loop'));

  await conversationEvent(server, 'open-loop-real-source-1');
  const basePath = join(directory, 'state.json');
  const mindPath = join(directory, 'mind-v2-state.json');
  const baseAfterEvent = await readFile(basePath);
  const mindAfterEvent = JSON.parse(await readFile(mindPath, 'utf8'));
  assert.equal(mindAfterEvent.appraisals.length, 0);
  assert.equal(mindAfterEvent.openLoops.length, 0);

  const privateSummary = 'private open loop summary marker';
  const privateExpectation = 'private open loop expectation marker';
  const privateMemoryId = 'mem_private_open_loop_marker';
  const opened = await mcpCall(server, 'xinchao_open_loop', {
    action: 'open',
    operation_id: 'open-loop-operation-1',
    source_event_id: 'open-loop-real-source-1',
    loop_key: 'project:open-loop-slice',
    kind: 'task',
    summary: privateSummary,
    expectation: privateExpectation,
    related_memory_ids: [privateMemoryId],
    priority: 'high',
  }, 11);
  assert.equal(opened.result.isError, false);
  assert.equal(opened.result.structuredContent.openLoop.status, 'open');
  assert.equal('summary' in opened.result.structuredContent.openLoop, false);
  assert.equal('expectation' in opened.result.structuredContent.openLoop, false);
  assert.equal('relatedMemoryIds' in opened.result.structuredContent.openLoop, false);
  assert.doesNotMatch(opened.result.content[0].text, /private open loop|mem_private/);
  assert.equal(sha(await readFile(basePath)), sha(baseAfterEvent));

  const mindAfterOpen = await readFile(mindPath);
  const parsedMind = JSON.parse(mindAfterOpen);
  assert.equal(parsedMind.appraisals.length, 0);
  assert.equal(parsedMind.openLoops.length, 1);
  const repeated = await mcpCall(server, 'xinchao_open_loop', {
    action: 'open',
    operation_id: 'open-loop-operation-1',
    source_event_id: 'open-loop-real-source-1',
    loop_key: 'project:open-loop-slice',
    kind: 'task',
    summary: privateSummary,
    expectation: privateExpectation,
    related_memory_ids: [privateMemoryId],
    priority: 'high',
  }, 12);
  assert.equal(repeated.result.structuredContent.duplicate, true);
  assert.equal(sha(await readFile(mindPath)), sha(mindAfterOpen));

  const invalid = await mcpCall(server, 'xinchao_open_loop', {
    action: 'open',
    operation_id: 'open-loop-operation-invalid',
    source_event_id: 'event-that-never-landed',
    loop_key: 'project:invalid',
    kind: 'task',
    summary: 'Must be rejected.',
    expectation: 'Must never persist.',
    priority: 'low',
  }, 13);
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /open_loop_source_event_not_found/);
  assert.equal(sha(await readFile(mindPath)), sha(mindAfterOpen));

  const context = await fetch(
    `${server.baseUrl}/v1/context?mode=inspect&session_id=open-loop-session&force=true`,
    {
      headers: { authorization: `Bearer ${server.token}`, connection: 'close' },
      signal: AbortSignal.timeout(3_000),
    },
  );
  const envelope = await context.json();
  assert.doesNotMatch(
    envelope.additionalContext,
    /private open loop|open-loop-slice|mem_private_open_loop/,
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  await conversationEvent(server, 'open-loop-real-source-2');
  const baseAfterResolveEvent = await readFile(basePath);
  const resolved = await mcpCall(server, 'xinchao_open_loop', {
    action: 'resolve',
    operation_id: 'open-loop-operation-resolve',
    source_event_id: 'open-loop-real-source-2',
    loop_key: 'project:open-loop-slice',
    closure_reason: 'The later real interaction confirms completion.',
  }, 14);
  assert.equal(resolved.result.isError, false);
  assert.equal(resolved.result.structuredContent.openLoop.status, 'resolved');
  assert.equal(sha(await readFile(basePath)), sha(baseAfterResolveEvent));
  assert.doesNotMatch(server.output.value, new RegExp(privateSummary));
  assert.doesNotMatch(server.output.value, new RegExp(privateExpectation));
  assert.doesNotMatch(server.output.value, new RegExp(privateMemoryId));
  await stopServer(server.child);
});

test('corrupt Mind v2 Store omits Open Loop while Base remains healthy', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-open-loop-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateMarker = 'private-open-loop-corrupt-marker';
  const mindPath = join(directory, 'mind-v2-state.json');
  await writeFile(mindPath, `{${privateMarker}`);
  const server = await startServer(directory, { corrupt: true });
  t.after(() => stopServer(server.child));

  const health = await fetch(`${server.baseUrl}/health`, {
    headers: { connection: 'close' }, signal: AbortSignal.timeout(3_000),
  });
  assert.equal(health.status, 200);
  const base = await fetch(`${server.baseUrl}/v1/state`, {
    headers: { authorization: `Bearer ${server.token}`, connection: 'close' },
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(base.status, 200);
  const rejected = await mcpCall(server, 'xinchao_open_loop', {
    action: 'open',
    operation_id: 'corrupt-operation',
    source_event_id: 'missing-source',
    loop_key: 'corrupt:test',
    kind: 'task',
    summary: 'Cannot be stored.',
    expectation: 'Must remain absent.',
    priority: 'low',
  });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /mind_v2_parse_failed/);
  assert.equal(await readFile(mindPath, 'utf8'), `{${privateMarker}`);
  assert.doesNotMatch(server.output.value, new RegExp(privateMarker));
  await stopServer(server.child);
});
