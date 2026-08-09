import test from 'node:test';
import assert from 'node:assert/strict';
import { newMindV2State } from '../src/mind-v2-state.js';
import {
  initializeMemoryResonanceState,
  RESONANCE_BASE_INTENSITY,
  RESONANCE_GLOBAL_CAP,
  RESONANCE_HALF_LIFE_MINUTES,
  RESONANCE_PER_MEMORY_CAP,
  resonanceEffectiveIntensity,
  settleMemoryResonance,
} from '../src/memory-resonance.js';

const START = new Date('2026-08-10T00:00:00.000Z');

function at(minutes) {
  return new Date(START.getTime() + minutes * 60_000);
}

function receipt(id, memoryId, minutes = 0, status = 'active') {
  return {
    deliveryId: id,
    memoryId,
    memoryStatusAtDelivery: status,
    contextDeliveryId: `context-${id}`,
    sessionFingerprint: 'a'.repeat(32),
    contextDigest: 'b'.repeat(16),
    deliveredAt: at(minutes).toISOString(),
    sourceOperation: 'mcp:xinchao_context',
  };
}

function stateWith(receipts = []) {
  const state = newMindV2State(START);
  state.recallDeliveryReceipts = receipts;
  state.appraisals = [{ id: 'appraisal-preserved' }];
  state.openLoops = [{ id: 'loop-preserved' }];
  return state;
}

test('Resonance migration adds only bounded receipt-consumption state', () => {
  const state = stateWith();
  const migrated = initializeMemoryResonanceState(state, START);
  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.state.resonance, []);
  assert.deepEqual(migrated.state.idempotency.resonanceReceipts, {});
  assert.equal(migrated.state.idempotency.resonanceReceiptCursor, 0);
  assert.deepEqual(migrated.state.appraisals, state.appraisals);
  assert.deepEqual(migrated.state.openLoops, state.openLoops);
});

test('first eligible persisted receipt creates fixed deterministic Resonance', () => {
  const input = stateWith([receipt('receipt-1', 'memory-1')]);
  const result = settleMemoryResonance(input, START);
  assert.equal(result.activatedCount, 1);
  assert.equal(result.state.resonance.length, 1);
  assert.deepEqual(result.state.resonance[0], {
    memoryId: 'memory-1',
    sourceReceiptId: 'receipt-1',
    firstRecalledAt: START.toISOString(),
    lastRecalledAt: START.toISOString(),
    repeatCount: 0,
    baseIntensity: 0.18,
    effectiveIntensity: 0.18,
    halfLifeMinutes: 45,
    expiresAt: at(360).toISOString(),
    sessionFingerprint: 'a'.repeat(32),
    contextDigest: 'b'.repeat(16),
  });
});

test('duplicate receipt is consumed once and never repeats settlement', () => {
  const duplicate = receipt('receipt-same', 'memory-1');
  const first = settleMemoryResonance(stateWith([duplicate, structuredClone(duplicate)]), START);
  assert.equal(first.consumedCount, 1);
  assert.equal(first.state.resonance[0].repeatCount, 0);
  assert.equal(first.state.idempotency.resonanceReceiptCursor, 2);
  const repeated = settleMemoryResonance(first.state, START);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.consumedCount, 0);
  assert.equal(repeated.state.revision, first.state.revision);
});

test('a later delivery refreshes with repeat decay and never adds intensities', () => {
  const first = settleMemoryResonance(
    stateWith([receipt('receipt-1', 'memory-1')]),
    START,
  );
  const next = structuredClone(first.state);
  next.recallDeliveryReceipts.push(receipt('receipt-2', 'memory-1', 10));
  const refreshed = settleMemoryResonance(next, at(10));
  const resonance = refreshed.state.resonance[0];
  assert.equal(resonance.repeatCount, 1);
  assert.equal(resonance.sourceReceiptId, 'receipt-2');
  assert.equal(resonance.firstRecalledAt, START.toISOString());
  assert.equal(resonance.lastRecalledAt, at(10).toISOString());
  assert.equal(resonance.effectiveIntensity, 0.127279);
  assert.ok(resonance.effectiveIntensity < RESONANCE_BASE_INTENSITY);
});

test('45 minute half-life and six hour hard TTL are deterministic', () => {
  const first = settleMemoryResonance(
    stateWith([receipt('receipt-1', 'memory-1')]),
    START,
  );
  const half = settleMemoryResonance(first.state, at(RESONANCE_HALF_LIFE_MINUTES));
  assert.equal(half.state.resonance[0].effectiveIntensity, 0.09);
  const expired = settleMemoryResonance(half.state, at(360));
  assert.deepEqual(expired.state.resonance, []);
  assert.equal(expired.expiredCount, 1);
});

test('per-Memory and deterministic global intensity caps hold', () => {
  assert.equal(resonanceEffectiveIntensity({
    lastRecalledAt: START.toISOString(),
    halfLifeMinutes: 45,
    repeatCount: 0,
    baseIntensity: 1,
  }, START), RESONANCE_PER_MEMORY_CAP);
  const result = settleMemoryResonance(stateWith([
    receipt('receipt-a', 'memory-a'),
    receipt('receipt-b', 'memory-b'),
    receipt('receipt-c', 'memory-c'),
  ]), START);
  assert.equal(result.diagnostic.globalIntensity, RESONANCE_GLOBAL_CAP);
  assert.deepEqual(result.state.resonance.map((item) => item.effectiveIntensity), [0.15, 0.15, 0.15]);
});

test('only active confirmed receipts activate; every other status is consumed without activation', () => {
  const result = settleMemoryResonance(stateWith([
    receipt('active', 'memory-active'),
    receipt('contested', 'memory-contested', 0, 'contested'),
    receipt('pending', 'memory-pending', 0, 'pending'),
    receipt('superseded', 'memory-superseded', 0, 'superseded'),
    receipt('historical', 'memory-historical', 0, 'historical'),
  ]), START);
  assert.deepEqual(result.state.resonance.map((item) => item.memoryId), ['memory-active']);
  assert.equal(result.consumedCount, 5);
  assert.equal(result.skippedCount, 4);
});

test('no formal receipt means no Resonance and all other layers remain unchanged', () => {
  const input = stateWith();
  const receiptsBefore = structuredClone(input.recallDeliveryReceipts);
  const result = settleMemoryResonance(input, START);
  assert.deepEqual(result.state.resonance, []);
  assert.deepEqual(result.state.recallDeliveryReceipts, receiptsBefore);
  assert.deepEqual(result.state.appraisals, input.appraisals);
  assert.deepEqual(result.state.openLoops, input.openLoops);
});

test('consumed receipt evidence is bounded while the cursor prevents re-consumption', () => {
  const receipts = Array.from({ length: 300 }, (_, index) => (
    receipt(`contested-${index}`, `memory-${index}`, 0, 'contested')
  ));
  const first = settleMemoryResonance(stateWith(receipts), START);
  assert.equal(Object.keys(first.state.idempotency.resonanceReceipts).length, 256);
  assert.equal(first.state.idempotency.resonanceReceiptCursor, 300);
  const repeated = settleMemoryResonance(first.state, START);
  assert.equal(repeated.consumedCount, 0);
  assert.deepEqual(repeated.state.resonance, []);
});
