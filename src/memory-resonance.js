import { createHash } from 'node:crypto';

export const RESONANCE_BASE_INTENSITY = 0.18;
export const RESONANCE_HALF_LIFE_MINUTES = 45;
export const RESONANCE_HARD_TTL_MINUTES = 360;
export const RESONANCE_PER_MEMORY_CAP = 0.25;
export const RESONANCE_GLOBAL_CAP = 0.45;
const MAX_CONSUMED_RECEIPTS = 256;

export class MemoryResonanceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MemoryResonanceError';
    this.code = code;
  }
}

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sha(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new MemoryResonanceError('resonance_invalid_timestamp');
  return date.getTime();
}

function iso(value) {
  return new Date(timestamp(value)).toISOString();
}

function rounded(value) {
  return Number(Math.max(0, value).toFixed(6));
}

function initializeStructures(state) {
  state.resonance = Array.isArray(state.resonance) ? state.resonance : [];
  state.recallDeliveryReceipts = Array.isArray(state.recallDeliveryReceipts)
    ? state.recallDeliveryReceipts
    : [];
  state.idempotency ??= {};
  state.idempotency.resonanceReceipts ??= {};
  if (!Number.isSafeInteger(state.idempotency.resonanceReceiptCursor)
    || state.idempotency.resonanceReceiptCursor < 0) {
    state.idempotency.resonanceReceiptCursor = 0;
  }
  return state;
}

export function initializeMemoryResonanceState(input, now = new Date()) {
  const state = structuredClone(input);
  const changed = !Array.isArray(state.resonance)
    || !Array.isArray(state.recallDeliveryReceipts)
    || !state.idempotency
    || typeof state.idempotency !== 'object'
    || Array.isArray(state.idempotency)
    || !state.idempotency.resonanceReceipts
    || !Number.isSafeInteger(state.idempotency.resonanceReceiptCursor)
    || state.idempotency.resonanceReceiptCursor < 0;
  initializeStructures(state);
  if (changed) {
    state.revision += 1;
    state.lastSettledAt = iso(now);
  }
  return { state, changed };
}

export function resonanceEffectiveIntensity(record, now = new Date()) {
  const ageMinutes = Math.max(0, (timestamp(now) - timestamp(record.lastRecalledAt)) / 60_000);
  const halfLife = Math.max(1, Number(record.halfLifeMinutes) || RESONANCE_HALF_LIFE_MINUTES);
  const repeats = Math.max(0, Number(record.repeatCount) || 0);
  const base = Math.max(0, Number(record.baseIntensity) || 0);
  return rounded(Math.min(
    RESONANCE_PER_MEMORY_CAP,
    base * Math.exp(-Math.LN2 * ageMinutes / halfLife) / Math.sqrt(1 + repeats),
  ));
}

function capGlobal(records) {
  const total = records.reduce((sum, record) => sum + record.effectiveIntensity, 0);
  if (total <= RESONANCE_GLOBAL_CAP || total <= 0) return records;
  const scale = RESONANCE_GLOBAL_CAP / total;
  return records.map((record) => ({
    ...record,
    effectiveIntensity: rounded(record.effectiveIntensity * scale),
  }));
}

function pruneConsumed(consumed) {
  const entries = Object.entries(consumed)
    .sort((left, right) => {
      const byTime = timestamp(right[1].consumedAt) - timestamp(left[1].consumedAt);
      return byTime || left[0].localeCompare(right[0]);
    })
    .slice(0, MAX_CONSUMED_RECEIPTS);
  return Object.fromEntries(entries);
}

function eligibleReceipt(receipt) {
  return compact(receipt?.sourceOperation) === 'mcp:xinchao_context'
    && compact(receipt?.memoryStatusAtDelivery).toLowerCase() === 'active';
}

function newRecord(receipt) {
  const recalledAt = iso(receipt.deliveredAt);
  return {
    memoryId: compact(receipt.memoryId),
    sourceReceiptId: compact(receipt.deliveryId),
    firstRecalledAt: recalledAt,
    lastRecalledAt: recalledAt,
    repeatCount: 0,
    baseIntensity: RESONANCE_BASE_INTENSITY,
    effectiveIntensity: RESONANCE_BASE_INTENSITY,
    halfLifeMinutes: RESONANCE_HALF_LIFE_MINUTES,
    expiresAt: new Date(timestamp(recalledAt) + RESONANCE_HARD_TTL_MINUTES * 60_000).toISOString(),
    sessionFingerprint: compact(receipt.sessionFingerprint),
    contextDigest: compact(receipt.contextDigest),
  };
}

function refreshRecord(existing, receipt) {
  const recalledAt = iso(receipt.deliveredAt);
  if (timestamp(recalledAt) <= timestamp(existing.lastRecalledAt)) return existing;
  return {
    ...existing,
    sourceReceiptId: compact(receipt.deliveryId),
    lastRecalledAt: recalledAt,
    repeatCount: Math.max(0, Number(existing.repeatCount) || 0) + 1,
    baseIntensity: RESONANCE_BASE_INTENSITY,
    effectiveIntensity: RESONANCE_BASE_INTENSITY,
    halfLifeMinutes: RESONANCE_HALF_LIFE_MINUTES,
    expiresAt: new Date(timestamp(recalledAt) + RESONANCE_HARD_TTL_MINUTES * 60_000).toISOString(),
    sessionFingerprint: compact(receipt.sessionFingerprint),
    contextDigest: compact(receipt.contextDigest),
  };
}

export function settleMemoryResonance(input, now = new Date()) {
  const settledAt = iso(now);
  const nowMs = timestamp(settledAt);
  const original = structuredClone(input);
  const state = initializeStructures(structuredClone(input));
  let cursor = Math.min(state.idempotency.resonanceReceiptCursor, state.recallDeliveryReceipts.length);
  let consumedCount = 0;
  let activatedCount = 0;
  let skippedCount = 0;

  for (; cursor < state.recallDeliveryReceipts.length; cursor += 1) {
    const receipt = state.recallDeliveryReceipts[cursor];
    const deliveredAt = timestamp(receipt?.deliveredAt);
    if (deliveredAt > nowMs) break;
    const receiptId = compact(receipt?.deliveryId);
    const identity = receiptId ? sha(receiptId) : sha(`invalid:${cursor}`);
    if (state.idempotency.resonanceReceipts[identity]) continue;
    consumedCount += 1;
    let outcome = 'ineligible';
    if (receiptId && compact(receipt?.memoryId) && eligibleReceipt(receipt)) {
      const expiresAt = deliveredAt + RESONANCE_HARD_TTL_MINUTES * 60_000;
      if (nowMs < expiresAt) {
        const index = state.resonance.findIndex((record) => record.memoryId === compact(receipt.memoryId));
        const record = index >= 0
          ? refreshRecord(state.resonance[index], receipt)
          : newRecord(receipt);
        if (index >= 0) state.resonance[index] = record;
        else state.resonance.push(record);
        activatedCount += 1;
        outcome = index >= 0 ? 'refreshed' : 'activated';
      } else {
        skippedCount += 1;
        outcome = 'expired_before_settle';
      }
    } else {
      skippedCount += 1;
    }
    state.idempotency.resonanceReceipts[identity] = {
      consumedAt: settledAt,
      outcome,
    };
  }
  state.idempotency.resonanceReceiptCursor = cursor;
  state.idempotency.resonanceReceipts = pruneConsumed(state.idempotency.resonanceReceipts);

  const active = state.resonance
    .filter((record) => timestamp(record.expiresAt) > nowMs)
    .map((record) => ({
      ...record,
      effectiveIntensity: resonanceEffectiveIntensity(record, settledAt),
    }));
  state.resonance = capGlobal(active);

  const changed = JSON.stringify(state) !== JSON.stringify(original);
  if (changed) {
    state.revision += 1;
    state.lastSettledAt = settledAt;
  }
  const intensities = state.resonance.map((record) => record.effectiveIntensity);
  const digest = createHash('sha256').update(JSON.stringify(state.resonance)).digest('hex').slice(0, 16);
  return {
    state,
    changed,
    consumedCount,
    activatedCount,
    skippedCount,
    expiredCount: Math.max(0, (original.resonance?.length ?? 0) - state.resonance.length),
    diagnostic: {
      activeCount: state.resonance.length,
      intensityMin: intensities.length ? Math.min(...intensities) : 0,
      intensityMax: intensities.length ? Math.max(...intensities) : 0,
      globalIntensity: rounded(intensities.reduce((sum, value) => sum + value, 0)),
      digest,
    },
  };
}
