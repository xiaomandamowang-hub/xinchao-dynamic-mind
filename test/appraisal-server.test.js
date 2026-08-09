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

async function startServer(directory, { readyEvent = 'mind_v2_appraisal_status' } = {}) {
  const port = await freePort();
  const token = 'appraisal-server-test-token-0123456789abcdef';
  const pathToken = 'appraisal-mcp-path-token';
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
      MIND_V2_OPEN_LOOPS_ENABLED: 'false',
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
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`test server exited: ${output.value}`);
    try {
      if ((await fetch(`${baseUrl}/health`, {
        headers: { connection: 'close' },
        signal: AbortSignal.timeout(500),
      })).ok
        && output.value.includes(readyEvent)) {
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

async function mcpCall(server, name, args, id = 1) {
  const response = await fetch(`${server.baseUrl}/mcp/${server.pathToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('real event to Appraisal lifecycle is isolated from Base and Context', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-appraisal-server-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await startServer(directory);
  t.after(() => stopServer(server.child));

  const event = await fetch(`${server.baseUrl}/v1/conversation-event`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
      connection: 'close',
    },
    body: JSON.stringify({
      session_id: 'appraisal-session',
      event_id: 'real-appraisal-source-1',
      interaction_type: 'reflection',
      tone: 'calm',
    }),
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(event.status, 200);
  const basePath = join(directory, 'state.json');
  const mindPath = join(directory, 'mind-v2-state.json');
  const baseAfterEvent = await readFile(basePath);
  const mindAfterEvent = JSON.parse(await readFile(mindPath, 'utf8'));
  assert.equal(Object.keys(mindAfterEvent.idempotency.sourceEventReceipts).length, 1);

  const privateInterpretation = 'This private interpretation must never enter runtime logs.';
  const privateRelationalMeaning = 'This private relational meaning must also stay out of logs.';
  const created = await mcpCall(server, 'xinchao_appraisal', {
    action: 'create',
    operation_id: 'appraisal-operation-1',
    source_event_id: 'real-appraisal-source-1',
    subject_key: 'relationship:repair',
    interpretation: privateInterpretation,
    valence: 0.4,
    relevance: 0.9,
    certainty: 0.7,
    controllability: 0.5,
    relational_meaning: privateRelationalMeaning,
    persistence_class: 'situational',
  });
  assert.equal(created.result.isError, false);
  assert.equal(created.result.structuredContent.action, 'create');
  assert.equal(created.result.structuredContent.appraisal.status, 'active');
  assert.doesNotMatch(created.result.content[0].text, /private interpretation|private relational/i);
  assert.equal(sha(await readFile(basePath)), sha(baseAfterEvent));

  const mindAfterCreate = await readFile(mindPath);
  const repeated = await mcpCall(server, 'xinchao_appraisal', {
    action: 'create',
    operation_id: 'appraisal-operation-1',
    source_event_id: 'real-appraisal-source-1',
    subject_key: 'relationship:repair',
    interpretation: privateInterpretation,
    valence: 0.4,
    relevance: 0.9,
    certainty: 0.7,
    controllability: 0.5,
    relational_meaning: privateRelationalMeaning,
    persistence_class: 'situational',
  }, 2);
  assert.equal(repeated.result.structuredContent.duplicate, true);
  assert.equal(sha(await readFile(mindPath)), sha(mindAfterCreate));

  const invalid = await mcpCall(server, 'xinchao_appraisal', {
    action: 'create',
    operation_id: 'appraisal-operation-invalid',
    source_event_id: 'event-that-never-landed',
    subject_key: 'project:invalid',
    interpretation: 'This must be rejected.',
    valence: 0,
    relevance: 0.5,
    certainty: 0.5,
    controllability: 0.5,
    persistence_class: 'fleeting',
  }, 3);
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /appraisal_source_event_not_found/);
  assert.equal(sha(await readFile(mindPath)), sha(mindAfterCreate));

  const context = await fetch(
    `${server.baseUrl}/v1/context?mode=inspect&session_id=appraisal-session&force=true`,
    {
      headers: { authorization: `Bearer ${server.token}`, connection: 'close' },
      signal: AbortSignal.timeout(3_000),
    },
  );
  const envelope = await context.json();
  assert.deepEqual(envelope.sections.map((section) => section.id), ['dynamic_state']);
  assert.doesNotMatch(envelope.additionalContext, /appraisal|private interpretation|private relational/i);
  assert.doesNotMatch(server.output.value, new RegExp(privateInterpretation));
  assert.doesNotMatch(server.output.value, new RegExp(privateRelationalMeaning));
  await stopServer(server.child);
});

test('corrupt Mind v2 Store omits Appraisal while Base remains healthy', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-appraisal-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateMarker = 'private-appraisal-corrupt-marker';
  const mindPath = join(directory, 'mind-v2-state.json');
  await writeFile(mindPath, `{${privateMarker}`);
  const server = await startServer(directory, { readyEvent: 'mind_v2_store_status' });
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
  const rejected = await mcpCall(server, 'xinchao_appraisal', {
    action: 'create',
    operation_id: 'corrupt-operation',
    source_event_id: 'missing-source',
    subject_key: 'corrupt:test',
    interpretation: 'This cannot be stored.',
    valence: 0,
    relevance: 0.5,
    certainty: 0.5,
    controllability: 0.5,
    persistence_class: 'fleeting',
  });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /mind_v2_parse_failed/);
  assert.equal(await readFile(mindPath, 'utf8'), `{${privateMarker}`);
  assert.doesNotMatch(server.output.value, new RegExp(privateMarker));
  await stopServer(server.child);
});
