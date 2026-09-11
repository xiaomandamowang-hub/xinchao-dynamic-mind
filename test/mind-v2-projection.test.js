import test from 'node:test';
import assert from 'node:assert/strict';
import { newMindV2State } from '../src/mind-v2-state.js';
import { estimateTokens } from '../src/context-envelope.js';
import {
  buildMindV2Projection,
  MIND_V2_PROJECTION_LAYER_CAP,
  MIND_V2_PROJECTION_MAX_TOKENS,
} from '../src/mind-v2-projection.js';

const NOW = new Date('2026-08-10T08:00:00.000Z');
const FUTURE = '2026-08-10T12:00:00.000Z';

function appraisal(index, overrides = {}) {
  return {
    id: `internal-appraisal-${index}`,
    subjectKey: `subject-${index}`,
    status: 'active',
    interpretation: `Interpretation ${index}`,
    relationalMeaning: `Relational meaning ${index}`,
    relevance: 0.9 - index / 100,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    expiresAt: FUTURE,
    ...overrides,
  };
}

function loop(index, overrides = {}) {
  return {
    id: `internal-loop-${index}`,
    loopKey: `loop-${index}`,
    kind: 'task',
    summary: `Unfinished item ${index}`,
    expectation: `Continue item ${index}`,
    priority: index === 0 ? 'high' : 'medium',
    status: 'open',
    openedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    expiresAt: FUTURE,
    ...overrides,
  };
}

function resonance(index, overrides = {}) {
  return {
    memoryId: `memory-${index}`,
    sourceReceiptId: `receipt-${index}`,
    firstRecalledAt: NOW.toISOString(),
    lastRecalledAt: NOW.toISOString(),
    repeatCount: index,
    baseIntensity: 0.18,
    effectiveIntensity: 0.18,
    halfLifeMinutes: 45,
    expiresAt: FUTURE,
    ...overrides,
  };
}

function client(statuses = {}) {
  const calls = [];
  return {
    calls,
    async directProjectionMemory(memoryId) {
      calls.push(memoryId);
      const value = statuses[memoryId];
      return value === undefined ? { projectionText: 'Confirmed remembered material' } : value;
    },
  };
}

test('empty Mind v2 state produces no projection section material', async () => {
  const result = await buildMindV2Projection(newMindV2State(NOW), { memoryClient: client(), now: NOW });
  assert.equal(result.text, '');
  assert.equal(result.diagnostic.projectedCount, 0);
});

test('projection includes only current subjective and unresolved material without internal metadata', async () => {
  const state = newMindV2State(NOW);
  state.appraisals = [
    appraisal(0),
    appraisal(1, { status: 'revised' }),
    appraisal(2, { expiresAt: NOW.toISOString() }),
  ];
  state.openLoops = [
    loop(0),
    loop(1, { status: 'resolved' }),
    loop(2, { status: 'released' }),
    loop(3, { status: 'expired' }),
  ];
  state.resonance = [resonance(0), resonance(1, { expiresAt: NOW.toISOString() })];
  const memoryClient = client();

  const result = await buildMindV2Projection(state, { memoryClient, now: NOW });

  assert.match(result.text, /不是客观事实/);
  assert.match(result.text, /Unfinished item 0/);
  assert.match(result.text, /Interpretation 0/);
  assert.match(result.text, /Confirmed remembered material/);
  assert.doesNotMatch(result.text, /Interpretation [12]/);
  assert.doesNotMatch(result.text, /Unfinished item [123]/);
  assert.doesNotMatch(result.text, /internal-|receipt-|memory-0|0\.18|2026-/);
  assert.deepEqual(memoryClient.calls, ['memory-0']);
});

test('Memory lookup suppression and failure omit only Resonance material', async () => {
  const state = newMindV2State(NOW);
  state.appraisals = [appraisal(0)];
  state.resonance = [resonance(0), resonance(1), resonance(2)];
  const memoryClient = client({
    'memory-0': null,
    'memory-1': null,
    'memory-2': null,
  });
  memoryClient.directProjectionMemory = async (id) => {
    memoryClient.calls.push(id);
    if (id === 'memory-2') throw new Error('unavailable');
    return null;
  };

  const result = await buildMindV2Projection(state, { memoryClient, now: NOW });
  assert.match(result.text, /Interpretation 0/);
  assert.doesNotMatch(result.text, /recently recalled|memory-/i);
  assert.equal(result.diagnostic.lookupFailures, 1);
});

test('per-layer caps, total token cap and ordering are deterministic', async () => {
  const state = newMindV2State(NOW);
  state.openLoops = Array.from({ length: 6 }, (_, index) => loop(index));
  state.appraisals = Array.from({ length: 6 }, (_, index) => appraisal(index));
  state.resonance = Array.from({ length: 6 }, (_, index) => resonance(index));
  const memoryClient = client();
  const first = await buildMindV2Projection(state, { memoryClient, now: NOW });
  const second = await buildMindV2Projection(structuredClone(state), { memoryClient: client(), now: NOW });

  assert.equal(first.text, second.text);
  assert.ok(first.diagnostic.openLoopCount <= MIND_V2_PROJECTION_LAYER_CAP);
  assert.ok(first.diagnostic.appraisalCount <= MIND_V2_PROJECTION_LAYER_CAP);
  assert.ok(first.diagnostic.resonanceCount <= MIND_V2_PROJECTION_LAYER_CAP);
  assert.ok(estimateTokens(first.text) <= MIND_V2_PROJECTION_MAX_TOKENS);
  assert.ok(first.text.indexOf('Unfinished item') < first.text.indexOf('Interpretation'));
});
