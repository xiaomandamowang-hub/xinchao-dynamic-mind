import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryV1Client, MemoryV1ShadowObserver } from '../src/memory-client.js';

function config(overrides = {}) {
  return {
    url: 'http://memory.invalid/mcp',
    token: '',
    timeoutMs: 1000,
    maxResults: 6,
    maxTokens: 200,
    detailFetches: 1,
    continuityDays: 30,
    dedupeTtlMinutes: 30,
    ...overrides,
  };
}

function response(value) {
  return { result: { structuredContent: value } };
}

test('recent continuity unions timeline and surface with provenance and deduplication', async () => {
  const client = new MemoryV1Client(config());
  const calls = [];
  client.call = async (name, args) => {
    calls.push({ name, args });
    if (name === 'surface') return response({ items: [
      { id: 'mem_shared', title: 'Shared', summary: 'surface copy', type: 'relationship', source: 'ChatGPT' },
      { id: 'mem_core', title: 'Core', summary: 'stable preference', type: 'core', source: 'ChatGPT' },
    ] });
    return response({ items: [
      { id: 'mem_shared', title: 'Shared', summary: 'new timeline copy', type: 'relationship', source: 'ChatGPT', occurred_at: '2026-08-08T01:00:00.000Z' },
    ] });
  };

  const material = await client.recentContinuityMaterial({
    now: new Date('2026-08-08T02:00:00.000Z'),
    maxTokens: 200,
  });

  assert.deepEqual(calls.map((item) => item.name), ['surface', 'recall_timeline']);
  assert.equal(material.provenance.length, 2);
  assert.equal(material.provenance[0].memory_id, 'mem_shared');
  assert.equal(material.provenance[0].retrieval_tool, 'recall_timeline');
  assert.match(material.text, /memory_id=mem_core/);
  assert.ok(material.estimatedTokens <= 200);
  assert.equal(material.readOnly, true);
});

test('recent material searches summaries then fetches only the configured details', async () => {
  const client = new MemoryV1Client(config({ detailFetches: 1 }));
  const calls = [];
  client.call = async (name, args) => {
    calls.push({ name, args });
    if (name === 'search') return response({ items: [
      { id: 'mem_a', title: 'A', summary: 'summary A', type: 'episode', source: 'ChatGPT' },
      { id: 'mem_b', title: 'B', summary: 'summary B', type: 'project', source: 'ChatGPT' },
    ] });
    return response({ memory: {
      id: args.id,
      title: 'A',
      summary: 'summary A',
      content: 'full redacted detail A',
      type: 'episode',
      source: 'ChatGPT',
    } });
  };

  const material = await client.recentMaterial({ maxTokens: 200 });

  assert.deepEqual(calls.map((item) => item.name), ['search', 'fetch']);
  assert.equal(calls[1].args.id, 'mem_a');
  assert.equal(material.provenance[0].retrieval_tool, 'fetch');
  assert.match(material.text, /full redacted detail A/);
  assert.ok(material.estimatedTokens <= 200);
});

test('the transport refuses every tool outside the read-only allowlist', async () => {
  const client = new MemoryV1Client(config());
  await assert.rejects(() => client.call('remember', {}), /not allowed/);
  await assert.rejects(() => client.call('read_evidence', {}), /not allowed/);
});

test('shadow failure degrades to empty diagnostics and never throws into the caller', async () => {
  const observer = new MemoryV1ShadowObserver({
    recentMaterial: async () => { throw new Error('fetch failed'); },
  });
  const result = await observer.observe('recentMaterial', { dedupeKey: 'dream-1' });
  assert.equal(result.status, 'degraded');
  assert.equal(result.resultCount, 0);
  assert.deepEqual(result.provenance, []);
  assert.equal(result.readOnly, true);
});

test('shadow observer suppresses duplicate delivery without persisting state', async () => {
  let reads = 0;
  const observer = new MemoryV1ShadowObserver({
    recentContinuityMaterial: async () => {
      reads += 1;
      return {
        provenance: [{ memory_id: 'mem_a', source_type: 'episode', retrieval_tool: 'surface' }],
        estimatedTokens: 12,
        truncated: false,
      };
    },
  });
  const first = await observer.observe('recentContinuityMaterial', { dedupeKey: 'context:session-a' });
  const second = await observer.observe('recentContinuityMaterial', { dedupeKey: 'context:session-a' });
  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'duplicate');
  assert.equal(reads, 1);
});
