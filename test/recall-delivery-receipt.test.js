import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { newMindV2State } from '../src/mind-v2-state.js';
import {
  applyRecallDeliveryDraft,
  commitRecallDeliveryOnSuccessfulResponse,
  createRecallDeliveryDraft,
  initializeRecallDeliveryState,
  recallDeliveryDiagnostic,
} from '../src/recall-delivery-receipt.js';

const NOW = new Date('2026-08-09T16:00:00.000Z');

function composition(selected, overrides = {}) {
  return {
    candidate: { fallbackToFormal: false },
    diagnostic: { memoryReferenceCount: selected.length },
    audit: { selected },
    ...overrides,
  };
}

function item(memoryId, status = 'active', reviewState = 'confirmed') {
  return { memoryId, status, reviewState };
}

test('initialization adds an empty independent receipt area without touching existing Mind layers', () => {
  const legacy = newMindV2State(NOW);
  delete legacy.recallDeliveryReceipts;
  legacy.appraisals.push({ id: 'appraisal-preserved' });
  legacy.openLoops.push({ id: 'loop-preserved' });
  const initialized = initializeRecallDeliveryState(legacy, NOW);
  assert.equal(initialized.changed, true);
  assert.deepEqual(initialized.state.recallDeliveryReceipts, []);
  assert.deepEqual(initialized.state.appraisals, [{ id: 'appraisal-preserved' }]);
  assert.deepEqual(initialized.state.openLoops, [{ id: 'loop-preserved' }]);
  assert.deepEqual(initialized.state.idempotency.recallDeliveries, {});
});

test('draft contains only final eligible rendered Memory references and deduplicates a Context', () => {
  const draft = createRecallDeliveryDraft({
    composition: composition([
      item('memory-active'),
      item('memory-active'),
      item('memory-contested', 'contested', 'confirmed'),
      item('memory-pending', 'active', 'pending'),
      item('memory-historical', 'historical', 'confirmed'),
    ]),
    sessionId: 'private-session',
    contextDigest: 'abcdef1234567890',
    contextDeliveryId: 'context-delivery-1',
    deliveredAt: NOW,
    sourceOperation: 'mcp:xinchao_context',
  });
  assert.deepEqual(draft.memories, [
    { memoryId: 'memory-active', memoryStatusAtDelivery: 'active' },
    { memoryId: 'memory-contested', memoryStatusAtDelivery: 'contested' },
  ]);
  assert.equal(draft.sessionFingerprint.length, 32);
  assert.equal('query' in draft, false);
  assert.equal('content' in draft, false);
});

test('formal delivery is persisted once per Memory and context delivery identity', () => {
  const state = initializeRecallDeliveryState(newMindV2State(NOW), NOW).state;
  const draft = createRecallDeliveryDraft({
    composition: composition([item('memory-a'), item('memory-b')]),
    sessionId: 'session-a',
    contextDigest: 'abcdef1234567890',
    contextDeliveryId: 'context-a',
    deliveredAt: NOW,
    sourceOperation: 'mcp:xinchao_context',
  });
  let nextId = 0;
  const first = applyRecallDeliveryDraft(state, draft, { idFactory: () => `delivery-${++nextId}` });
  assert.equal(first.addedCount, 2);
  assert.deepEqual(first.state.recallDeliveryReceipts.map((entry) => entry.deliveryId), [
    'delivery-1', 'delivery-2',
  ]);
  const repeated = applyRecallDeliveryDraft(first.state, draft, { idFactory: () => `delivery-${++nextId}` });
  assert.equal(repeated.addedCount, 0);
  assert.equal(repeated.state.revision, first.state.revision);
  assert.deepEqual(recallDeliveryDiagnostic(repeated.state), { count: 2, idempotencyCount: 2 });
});

test('shadow, fallback, filtered-only and non-MCP compositions produce no draft', () => {
  const base = {
    sessionId: 'session', contextDigest: 'abcdef1234567890', deliveredAt: NOW,
  };
  assert.equal(createRecallDeliveryDraft({
    ...base,
    composition: composition([item('memory-a')], { candidate: { fallbackToFormal: true } }),
    sourceOperation: 'mcp:xinchao_context',
  }), null);
  assert.equal(createRecallDeliveryDraft({
    ...base,
    composition: composition([item('memory-pending', 'active', 'pending')]),
    sourceOperation: 'mcp:xinchao_context',
  }), null);
  assert.equal(createRecallDeliveryDraft({
    ...base,
    composition: composition([item('memory-a')]),
    sourceOperation: 'shadow:context',
  }), null);
});

test('receipt commit occurs only after a successful response finish event', async () => {
  const calls = [];
  const draft = { contextDeliveryId: 'context-a' };
  const failedResponse = new EventEmitter();
  assert.equal(commitRecallDeliveryOnSuccessfulResponse(failedResponse, draft, async (value) => {
    calls.push(value);
  }), true);
  failedResponse.emit('close');
  failedResponse.emit('finish');
  await Promise.resolve();
  assert.equal(calls.length, 0);

  const successfulResponse = new EventEmitter();
  commitRecallDeliveryOnSuccessfulResponse(successfulResponse, draft, async (value) => {
    calls.push(value);
  });
  successfulResponse.emit('finish');
  successfulResponse.emit('close');
  await Promise.resolve();
  assert.deepEqual(calls, [draft]);
});
