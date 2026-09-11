import { createHash, randomUUID } from 'node:crypto';

const SOURCE_OPERATION = 'mcp:xinchao_context';
const ELIGIBLE_ACTIVE_REVIEW = 'confirmed';
const ELIGIBLE_STATUSES = new Set(['active', 'contested']);

export class RecallDeliveryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RecallDeliveryError';
    this.code = code;
  }
}

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sha(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RecallDeliveryError('recall_delivery_invalid_timestamp');
  return date.toISOString();
}

function safeDigest(value) {
  const digest = compact(value);
  if (!/^[a-f0-9]{8,64}$/i.test(digest)) throw new RecallDeliveryError('recall_delivery_invalid_context_digest');
  return digest.toLowerCase();
}

function initializeStructures(state) {
  state.recallDeliveryReceipts = Array.isArray(state.recallDeliveryReceipts)
    ? state.recallDeliveryReceipts
    : [];
  state.idempotency ??= {};
  state.idempotency.recallDeliveries ??= {};
  return state;
}

export function initializeRecallDeliveryState(input, now = new Date()) {
  const state = structuredClone(input);
  const changed = !Array.isArray(state.recallDeliveryReceipts)
    || !state.idempotency
    || typeof state.idempotency !== 'object'
    || Array.isArray(state.idempotency)
    || !state.idempotency.recallDeliveries;
  initializeStructures(state);
  if (changed) {
    state.revision += 1;
    state.lastSettledAt = iso(now);
  }
  return { state, changed };
}

function eligible(item) {
  const status = compact(item?.status).toLowerCase();
  const reviewState = compact(item?.reviewState).toLowerCase();
  if (!ELIGIBLE_STATUSES.has(status) || reviewState === 'pending') return false;
  if (status === 'active') return reviewState === ELIGIBLE_ACTIVE_REVIEW;
  return true;
}

export function createRecallDeliveryDraft({
  composition,
  sessionId,
  contextDigest,
  contextDeliveryId = randomUUID(),
  deliveredAt = new Date(),
  sourceOperation = SOURCE_OPERATION,
} = {}) {
  if (sourceOperation !== SOURCE_OPERATION) return null;
  if (!composition || composition.candidate?.fallbackToFormal) return null;
  if (!composition.diagnostic?.memoryReferenceCount) return null;
  const unique = new Map();
  for (const item of composition.audit?.selected ?? []) {
    const memoryId = compact(item?.memoryId);
    if (!memoryId || !eligible(item) || unique.has(memoryId)) continue;
    unique.set(memoryId, {
      memoryId,
      memoryStatusAtDelivery: compact(item.status).toLowerCase(),
    });
  }
  if (!unique.size) return null;
  const deliveryId = compact(contextDeliveryId);
  if (!deliveryId) throw new RecallDeliveryError('recall_delivery_context_id_required');
  return {
    contextDeliveryId: deliveryId,
    sessionFingerprint: sha(compact(sessionId)).slice(0, 32),
    contextDigest: safeDigest(contextDigest),
    deliveredAt: iso(deliveredAt),
    sourceOperation,
    memories: [...unique.values()],
  };
}

export function applyRecallDeliveryDraft(input, draft, {
  idFactory = randomUUID,
} = {}) {
  if (!draft || draft.sourceOperation !== SOURCE_OPERATION) {
    throw new RecallDeliveryError('recall_delivery_invalid_source_operation');
  }
  const state = initializeStructures(structuredClone(input));
  const contextDeliveryId = compact(draft.contextDeliveryId);
  const sessionFingerprint = compact(draft.sessionFingerprint);
  const contextDigest = safeDigest(draft.contextDigest);
  const deliveredAt = iso(draft.deliveredAt);
  if (!contextDeliveryId) throw new RecallDeliveryError('recall_delivery_context_id_required');
  if (!/^[a-f0-9]{32}$/i.test(sessionFingerprint)) {
    throw new RecallDeliveryError('recall_delivery_invalid_session_fingerprint');
  }

  const added = [];
  const seen = new Set();
  for (const item of draft.memories ?? []) {
    const memoryId = compact(item?.memoryId);
    const status = compact(item?.memoryStatusAtDelivery).toLowerCase();
    if (!memoryId || seen.has(memoryId) || !ELIGIBLE_STATUSES.has(status)) continue;
    seen.add(memoryId);
    const identity = sha(`${memoryId}\0${contextDeliveryId}`);
    if (state.idempotency.recallDeliveries[identity]) continue;
    const receipt = {
      deliveryId: idFactory(),
      memoryId,
      memoryStatusAtDelivery: status,
      contextDeliveryId,
      sessionFingerprint: sessionFingerprint.toLowerCase(),
      contextDigest,
      deliveredAt,
      sourceOperation: SOURCE_OPERATION,
    };
    state.recallDeliveryReceipts.push(receipt);
    state.idempotency.recallDeliveries[identity] = receipt.deliveryId;
    added.push(receipt);
  }
  if (added.length) {
    state.revision += 1;
    state.lastSettledAt = deliveredAt;
  }
  return {
    state,
    addedCount: added.length,
    duplicateCount: Math.max(0, (draft.memories?.length ?? 0) - added.length),
  };
}

export function recallDeliveryDiagnostic(state) {
  const initialized = initializeStructures(structuredClone(state));
  return {
    count: initialized.recallDeliveryReceipts.length,
    idempotencyCount: Object.keys(initialized.idempotency.recallDeliveries).length,
  };
}

export function commitRecallDeliveryOnSuccessfulResponse(response, draft, commit) {
  if (!draft || !response?.once || typeof commit !== 'function') return false;
  let closedBeforeFinish = false;
  let finished = false;
  response.once('close', () => {
    if (!finished) closedBeforeFinish = true;
  });
  response.once('finish', () => {
    finished = true;
    if (!closedBeforeFinish) void commit(draft);
  });
  return true;
}
