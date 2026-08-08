import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeShadowContextCandidate,
  ShadowContextCompositionRunner,
} from '../src/shadow-context-composer.js';

function baseEnvelope({ handoff = '', dream = 'dream residue', longBase = false } = {}) {
  const sections = [
    {
      id: 'dynamic_state',
      source: 'xinchao',
      content: longBase ? 'current dynamic state '.repeat(60) : 'fatigue=0.2 curiosity=0.8',
      estimatedTokens: longBase ? 300 : 12,
    },
  ];
  if (handoff) sections.push({ id: 'handoff_notes', source: 'xinchao', content: handoff, estimatedTokens: 12 });
  if (dream) sections.push({ id: 'dream_residue', source: 'xinchao', content: dream, estimatedTokens: 8 });
  const additionalContext = sections.map((section) => `[${section.id}]\n${section.content}`).join('\n\n');
  return {
    version: 1,
    system: 'xinchao-dynamic-mind',
    mode: 'session_start',
    sessionId: 'session-a',
    generatedAt: '2026-08-08T01:00:00.000Z',
    expiresAt: '2026-08-08T01:15:00.000Z',
    delivered: true,
    sections,
    additionalContext,
    estimatedTokens: 32,
    digest: 'formal-digest',
  };
}

function fragment(id, content, overrides = {}) {
  return {
    title: overrides.title ?? id,
    content,
    text: `[memory_id=${id}] ${content}`,
    provenance: {
      memory_id: id,
      source_type: overrides.source_type ?? 'projects',
      memory_source: 'ChatGPT',
      retrieval_tool: overrides.tool ?? 'search',
      occurred_at: overrides.occurred_at ?? '2026-08-07T01:00:00.000Z',
      status: overrides.status ?? 'active',
      review_state: overrides.review_state ?? 'confirmed',
      supersedes: overrides.supersedes ?? [],
      layer: overrides.layer ?? null,
      importance: overrides.importance ?? null,
      salience: overrides.salience ?? null,
      continuity_signal: overrides.continuity_signal ?? false,
    },
  };
}

function material(kind, fragments) {
  return {
    kind,
    fragments,
    provenance: fragments.map((item) => item.provenance),
  };
}

test('candidate keeps required order, preserves base sections and deduplicates Memory IDs', () => {
  const base = baseEnvelope({ handoff: 'continue the memory adapter project', longBase: true });
  const shared = fragment('mem_shared', 'adapter project boundary and tests');
  const result = composeShadowContextCandidate({
    baseEnvelope: base,
    continuityMaterial: material('recent_continuity', [shared]),
    recentMaterial: material('recent_material', [shared, fragment('mem_project', 'phase two project work')]),
    maxTokens: 1000,
    memoryMaxRatio: 0.5,
    now: new Date('2026-08-08T01:00:00.000Z'),
  });

  assert.deepEqual(result.candidate.sections.map((section) => section.id), [
    'dynamic_state',
    'handoff_notes',
    'recent_continuity',
    'recent_material',
    'dream_residue',
  ]);
  assert.equal(result.audit.baseSectionsPreserved, true);
  assert.equal(result.audit.dropped.some((item) => item.reason === 'duplicate_memory_id'), true);
  assert.equal(new Set(result.audit.selected.map((item) => item.memoryId)).size, result.audit.selected.length);
  assert.ok(result.candidate.estimatedTokens <= 1000);
  assert.equal(result.candidate.returnedToClient, false);
});

test('pending, superseded and historical memories are excluded while contested stays explicit', () => {
  const result = composeShadowContextCandidate({
    baseEnvelope: baseEnvelope({ longBase: true }),
    continuityMaterial: material('recent_continuity', [
      fragment('mem_pending', 'pending fact', { status: 'pending' }),
      fragment('mem_superseded', 'old fact', { status: 'superseded' }),
      fragment('mem_historical', 'raw history', { status: 'historical' }),
      fragment('mem_contested', 'contested fact', { status: 'contested' }),
    ]),
    maxTokens: 1000,
    topicHint: 'fact',
  });
  assert.deepEqual(result.audit.selected.map((item) => item.memoryId), ['mem_contested']);
  assert.equal(result.audit.selected[0].reason, 'selected_contested_with_provenance');
  assert.deepEqual(new Set(result.audit.dropped.map((item) => item.reason)), new Set([
    'status_pending',
    'status_superseded',
    'status_historical',
  ]));
});

test('newer selected version replaces an older selected version through supersedes provenance', () => {
  const result = composeShadowContextCandidate({
    baseEnvelope: baseEnvelope({ longBase: true }),
    continuityMaterial: material('recent_continuity', [
      fragment('mem_old', 'old project decision'),
      fragment('mem_new', 'new project decision', { supersedes: ['mem_old'] }),
    ]),
    maxTokens: 1000,
    topicHint: 'project decision',
  });
  assert.deepEqual(result.audit.selected.map((item) => item.memoryId), ['mem_new']);
  assert.equal(result.audit.dropped.some((item) => (
    item.memoryId === 'mem_old' && item.reason === 'superseded_by_selected'
  )), true);
});

test('handoff wins over a near-duplicate long-term memory', () => {
  const handoff = 'continue memory adapter phase two context composition tests';
  const result = composeShadowContextCandidate({
    baseEnvelope: baseEnvelope({ handoff }),
    continuityMaterial: material('recent_continuity', [fragment('mem_same', handoff)]),
    maxTokens: 500,
  });
  assert.equal(result.audit.selected.length, 0);
  assert.equal(result.audit.dropped[0].reason, 'duplicate_of_handoff');
  assert.equal(result.candidate.sections.some((section) => section.id === 'recent_continuity'), false);
});

test('composition is deterministic and never mutates formal context or Memory material', () => {
  const base = baseEnvelope({ longBase: true });
  const continuity = material('recent_continuity', [
    fragment('mem_long', 'long relevant memory '.repeat(200)),
    fragment('mem_second', 'second relevant memory'),
  ]);
  const beforeBase = structuredClone(base);
  const beforeMemory = structuredClone(continuity);
  const options = {
    baseEnvelope: base,
    continuityMaterial: continuity,
    maxTokens: 700,
    memoryMaxRatio: 0.5,
    topicHint: 'relevant memory',
  };
  const first = composeShadowContextCandidate(options);
  const second = composeShadowContextCandidate(options);
  assert.equal(first.candidate.digest, second.candidate.digest);
  assert.equal(first.candidate.additionalContext, second.candidate.additionalContext);
  assert.ok(first.candidate.estimatedTokens <= 700);
  assert.deepEqual(base, beforeBase);
  assert.deepEqual(continuity, beforeMemory);
  assert.equal(first.audit.baseSectionsPreserved, true);
});

test('Memory failure returns an exact formal candidate and does not throw', async () => {
  const base = baseEnvelope();
  const runner = new ShadowContextCompositionRunner({
    recentContinuityMaterial: async () => { throw new Error('Memory unavailable'); },
  });
  const result = await runner.compose({ baseEnvelope: base, sessionId: 'failure-session' });
  assert.equal(result.candidate.additionalContext, base.additionalContext);
  assert.deepEqual(result.candidate.sections, base.sections);
  assert.equal(result.candidate.digest, base.digest);
  assert.equal(result.candidate.fallbackToFormal, true);
  assert.equal(result.diagnostic.errorCode, 'memory_unavailable');
});

test('zero relevant memories preserves the exact formal candidate', () => {
  const base = baseEnvelope();
  const result = composeShadowContextCandidate({
    baseEnvelope: base,
    continuityMaterial: material('recent_continuity', []),
    maxTokens: 500,
  });
  assert.equal(result.candidate.additionalContext, base.additionalContext);
  assert.equal(result.candidate.digest, base.digest);
  assert.equal(result.candidate.estimatedTokens, base.estimatedTokens);
  assert.deepEqual(result.candidate.sections, base.sections);
  assert.equal(result.candidate.fallbackToFormal, false);
});

test('explicit no-recall conversation intent avoids every Memory call', async () => {
  let reads = 0;
  const base = baseEnvelope();
  const runner = new ShadowContextCompositionRunner({
    recentContinuityMaterial: async () => { reads += 1; return material('recent_continuity', []); },
  });
  const result = await runner.compose({
    baseEnvelope: base,
    sessionId: 'ordinary-chat',
    topicHint: '今天随便聊聊，没有需要继续的项目',
  });
  assert.equal(reads, 0);
  assert.equal(result.candidate.digest, base.digest);
  assert.equal(result.diagnostic.memoryReferenceCount, 0);
});

test('unscoped session start does not admit memories merely because they are recent', async () => {
  let continuityReads = 0;
  let recentReads = 0;
  const base = baseEnvelope();
  const client = {
    recentContinuityMaterial: async () => {
      continuityReads += 1;
      return material('recent_continuity', [
        fragment('mem_recent_a', 'recent relationship detail'),
        fragment('mem_recent_b', 'recent project detail'),
      ]);
    },
    recentMaterial: async () => {
      recentReads += 1;
      return material('recent_material', []);
    },
  };
  const runner = new ShadowContextCompositionRunner(client);
  const result = await runner.compose({ baseEnvelope: base, sessionId: 'unscoped' });
  assert.equal(continuityReads, 1);
  assert.equal(recentReads, 0);
  assert.equal(result.diagnostic.memoryReferenceCount, 0);
  assert.equal(result.audit.gate.kind, 'unscoped_session_start');
  assert.equal(result.audit.dropped.every((item) => item.reason === 'unscoped_without_salience_signal'), true);
  assert.equal(result.candidate.additionalContext, base.additionalContext);
});

test('unscoped session start allows at most one explicitly salient continuity memory', () => {
  const result = composeShadowContextCandidate({
    baseEnvelope: baseEnvelope({ longBase: true }),
    continuityMaterial: material('recent_continuity', [
      fragment('mem_critical', 'critical continuity', { importance: 'critical' }),
      fragment('mem_salient', 'salient continuity', { salience: 0.95 }),
    ]),
    maxTokens: 1000,
  });
  assert.deepEqual(result.audit.selected.map((item) => item.memoryId), ['mem_critical']);
  assert.equal(result.audit.gate.maxReferences, 1);
  assert.equal(result.audit.dropped.some((item) => (
    item.memoryId === 'mem_salient' && item.reason === 'reference_limit'
  )), true);
});

test('explicit topic can admit two relevant memories but never a third', () => {
  const result = composeShadowContextCandidate({
    baseEnvelope: baseEnvelope({ longBase: true }),
    continuityMaterial: material('recent_continuity', [
      fragment('mem_project_a', 'memory adapter project tests'),
      fragment('mem_project_b', 'memory adapter project deployment'),
      fragment('mem_project_c', 'memory adapter project report'),
    ]),
    topicHint: 'memory adapter project',
    maxTokens: 1000,
  });
  assert.equal(result.audit.selected.length, 2);
  assert.equal(result.audit.gate.kind, 'explicit_continuity');
  assert.equal(result.audit.dropped.some((item) => item.reason === 'reference_limit'), true);
});

test('memory budget is bounded by both absolute and relative caps without trimming base sections', () => {
  const base = baseEnvelope({ handoff: 'continue memory adapter project', longBase: true });
  const result = composeShadowContextCandidate({
    baseEnvelope: base,
    continuityMaterial: material('recent_continuity', [
      fragment('mem_budget_a', 'memory adapter project '.repeat(80)),
      fragment('mem_budget_b', 'memory adapter deployment '.repeat(80)),
    ]),
    topicHint: 'memory adapter project',
    maxTokens: 1000,
    memoryMaxTokens: 70,
    memoryMaxRatio: 0.5,
  });
  assert.ok(result.audit.memoryBudget <= 70);
  assert.ok(result.audit.memoryBudget <= result.audit.relativeMemoryLimit);
  assert.ok(result.audit.memoryTokens <= 70);
  assert.equal(result.audit.baseSectionsPreserved, true);
});

test('same session reads once and runtime diagnostics contain no Memory body or IDs', async () => {
  let reads = 0;
  const base = baseEnvelope();
  const client = {
    recentContinuityMaterial: async () => {
      reads += 1;
      return material('recent_continuity', [fragment('mem_private', 'private summary')]);
    },
    recentMaterial: async () => material('recent_material', []),
  };
  const runner = new ShadowContextCompositionRunner(client);
  const first = await runner.compose({ baseEnvelope: base, sessionId: 'same-session' });
  const second = await runner.compose({ baseEnvelope: base, sessionId: 'same-session' });
  assert.equal(reads, 1);
  assert.equal(second.diagnostic.errorCode, 'duplicate_session');
  assert.deepEqual(Object.keys(first.diagnostic).sort(), [
    'digest',
    'errorCode',
    'latencyMs',
    'memoryReferenceCount',
    'sectionCount',
    'sectionTokens',
    'totalTokens',
  ]);
  const serialized = JSON.stringify(first.diagnostic);
  assert.doesNotMatch(serialized, /mem_private|private summary|query|content|provenance/);
});
