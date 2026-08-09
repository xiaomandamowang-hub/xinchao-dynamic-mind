import { createHash, randomUUID } from 'node:crypto';

const REAL_EVENT_SOURCES = new Set(['mcp', 'api']);
const ACTIONS = new Set(['create', 'revise', 'release']);
const PERSISTENCE = Object.freeze({
  fleeting: Object.freeze({ reviewHours: 6, expireHours: 24 }),
  situational: Object.freeze({ reviewHours: 24, expireHours: 72 }),
  significant: Object.freeze({ reviewHours: 48, expireHours: 168 }),
});

export const APPRAISAL_PERSISTENCE_WINDOWS = PERSISTENCE;

export class AppraisalError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AppraisalError';
    this.code = code;
  }
}

const iso = (value) => new Date(value).toISOString();
const plusHours = (value, hours) => new Date(new Date(value).getTime() + hours * 3_600_000).toISOString();

function fingerprint(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 24);
}

function stableFingerprint(value) {
  const stable = JSON.stringify(value, Object.keys(value).sort());
  return createHash('sha256').update(stable, 'utf8').digest('hex').slice(0, 24);
}

function requiredText(value, name, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new AppraisalError(`appraisal_${name}_required`);
  if (text.length > maxLength) throw new AppraisalError(`appraisal_${name}_too_long`);
  return text;
}

function optionalText(value, name, maxLength) {
  if (value == null || value === '') return null;
  return requiredText(value, name, maxLength);
}

function boundedNumber(value, name, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new AppraisalError(`appraisal_${name}_invalid`);
  }
  return Number(number.toFixed(4));
}

function ensureStructures(input) {
  const state = structuredClone(input);
  state.appraisals = Array.isArray(state.appraisals) ? state.appraisals : [];
  state.idempotency = state.idempotency && typeof state.idempotency === 'object'
    && !Array.isArray(state.idempotency) ? state.idempotency : {};
  state.idempotency.appraisalOperations ??= {};
  state.idempotency.sourceEventReceipts ??= {};
  return state;
}

function changedStructures(input) {
  return !input.idempotency
    || typeof input.idempotency !== 'object'
    || Array.isArray(input.idempotency)
    || !input.idempotency.appraisalOperations
    || !input.idempotency.sourceEventReceipts;
}

function touch(state, now) {
  state.revision = Number(state.revision ?? 0) + 1;
  state.lastSettledAt = iso(now);
  return state;
}

export function initializeAppraisalState(input, now = new Date()) {
  const changed = changedStructures(input);
  const state = ensureStructures(input);
  if (changed) touch(state, now);
  return { state, changed };
}

export function sourceEventFingerprint(eventId) {
  return fingerprint(requiredText(eventId, 'source_event_id', 120));
}

export function registerAppraisalSourceEvent(input, {
  eventId,
  source,
  baseState,
  baseRevision,
}, now = new Date()) {
  if (!REAL_EVENT_SOURCES.has(source)) {
    throw new AppraisalError('appraisal_source_not_real');
  }
  const state = ensureStructures(input);
  const eventFingerprint = sourceEventFingerprint(eventId);
  const baseEvent = (baseState?.recentConversationEvents ?? [])
    .find((item) => item?.eventFingerprint === eventFingerprint);
  if (!baseEvent) throw new AppraisalError('appraisal_source_event_not_found');
  const processedAt = Date.parse(baseEvent.processedAt ?? '');
  if (!Number.isFinite(processedAt)) throw new AppraisalError('appraisal_source_event_invalid');
  if (processedAt > now.getTime()) throw new AppraisalError('appraisal_source_event_future');
  const existing = state.idempotency.sourceEventReceipts[eventFingerprint];
  if (existing) return { state, changed: false, duplicate: true, receipt: existing };
  const receipt = {
    eventFingerprint,
    source,
    processedAt: new Date(processedAt).toISOString(),
    baseRevision: Number.isSafeInteger(baseRevision) ? baseRevision : Number(baseState?.revision ?? 0),
  };
  state.idempotency.sourceEventReceipts[eventFingerprint] = receipt;
  touch(state, now);
  return { state, changed: true, duplicate: false, receipt };
}

function normalizeOperation(input) {
  const action = requiredText(input.action, 'action', 16).toLowerCase();
  if (!ACTIONS.has(action)) throw new AppraisalError('appraisal_action_invalid');
  const operationId = requiredText(input.operationId ?? input.operation_id, 'operation_id', 120);
  const sourceEventId = requiredText(input.sourceEventId ?? input.source_event_id, 'source_event_id', 120);
  const subjectKey = requiredText(input.subjectKey ?? input.subject_key, 'subject_key', 120);
  const common = { action, operationId, sourceEventId, subjectKey };
  if (action === 'release') return common;
  const persistenceClass = requiredText(
    input.persistenceClass ?? input.persistence_class,
    'persistence_class',
    24,
  ).toLowerCase();
  if (!PERSISTENCE[persistenceClass]) {
    throw new AppraisalError('appraisal_persistence_class_invalid');
  }
  return {
    ...common,
    interpretation: requiredText(input.interpretation, 'interpretation', 480),
    valence: boundedNumber(input.valence, 'valence', -1, 1),
    relevance: boundedNumber(input.relevance, 'relevance', 0, 1),
    certainty: boundedNumber(input.certainty, 'certainty', 0, 1),
    controllability: boundedNumber(input.controllability, 'controllability', 0, 1),
    relationalMeaning: optionalText(
      input.relationalMeaning ?? input.relational_meaning,
      'relational_meaning',
      240,
    ),
    persistenceClass,
  };
}

function payloadForFingerprint(operation) {
  const payload = { ...operation };
  delete payload.operationId;
  return payload;
}

function latestForSubject(state, subjectKey) {
  return state.appraisals
    .filter((item) => item.subjectKey === subjectKey)
    .sort((left, right) => Number(right.version) - Number(left.version))[0] ?? null;
}

function activeForSubject(state, subjectKey) {
  return state.appraisals.find((item) => item.subjectKey === subjectKey && item.status === 'active') ?? null;
}

function safeSummary(item, now = new Date()) {
  if (!item) return null;
  return {
    id: item.id,
    subjectKey: item.subjectKey,
    version: item.version,
    status: item.status,
    persistenceClass: item.persistenceClass,
    reviewAt: item.reviewAt,
    expiresAt: item.expiresAt,
    reviewDue: item.status === 'active' && Date.parse(item.reviewAt) <= now.getTime(),
  };
}

export function settleAppraisals(input, now = new Date()) {
  const state = ensureStructures(input);
  let expired = 0;
  for (const item of state.appraisals) {
    if (item.status !== 'active') continue;
    const expiresAt = Date.parse(item.expiresAt ?? '');
    if (!Number.isFinite(expiresAt) || expiresAt > now.getTime()) continue;
    item.status = 'expired';
    item.expiredAt = new Date(expiresAt).toISOString();
    item.updatedAt = item.expiredAt;
    expired += 1;
  }
  if (expired) touch(state, now);
  return { state, changed: expired > 0, expired };
}

export function applyAppraisalOperation(input, rawOperation, now = new Date(), {
  idFactory = randomUUID,
} = {}) {
  const operation = normalizeOperation(rawOperation);
  const state = ensureStructures(input);
  const operationFingerprint = fingerprint(operation.operationId);
  const payloadFingerprint = stableFingerprint(payloadForFingerprint(operation));
  const priorOperation = state.idempotency.appraisalOperations[operationFingerprint];
  if (priorOperation) {
    if (priorOperation.payloadFingerprint !== payloadFingerprint) {
      throw new AppraisalError('appraisal_operation_id_conflict');
    }
    const existing = state.appraisals.find((item) => item.id === priorOperation.appraisalId) ?? null;
    return {
      state,
      changed: false,
      duplicate: true,
      action: priorOperation.action,
      appraisal: existing,
      projection: safeSummary(existing, now),
    };
  }

  const sourceFingerprint = sourceEventFingerprint(operation.sourceEventId);
  const receipt = state.idempotency.sourceEventReceipts[sourceFingerprint];
  if (!receipt) throw new AppraisalError('appraisal_source_event_not_found');
  const sourceTime = Date.parse(receipt.processedAt ?? '');
  if (!Number.isFinite(sourceTime)) throw new AppraisalError('appraisal_source_event_invalid');
  if (sourceTime > now.getTime()) throw new AppraisalError('appraisal_source_event_future');

  const settled = settleAppraisals(state, now);
  const working = settled.state;
  let appraisal;
  if (operation.action === 'release') {
    appraisal = activeForSubject(working, operation.subjectKey);
    if (!appraisal) throw new AppraisalError('appraisal_active_subject_not_found');
    if (appraisal.sourceEventFingerprint === sourceFingerprint) {
      throw new AppraisalError('appraisal_new_source_event_required');
    }
    appraisal.status = 'released';
    appraisal.releasedAt = iso(now);
    appraisal.updatedAt = iso(now);
    appraisal.releaseSourceEventFingerprint = sourceFingerprint;
    appraisal.releaseOperationFingerprint = operationFingerprint;
  } else {
    const active = activeForSubject(working, operation.subjectKey);
    if (operation.action === 'create' && active) {
      throw new AppraisalError('appraisal_active_subject_requires_revision');
    }
    if (operation.action === 'revise' && !active) {
      throw new AppraisalError('appraisal_active_subject_not_found');
    }
    const previous = operation.action === 'revise'
      ? active
      : latestForSubject(working, operation.subjectKey);
    if (previous && previous.sourceEventFingerprint === sourceFingerprint) {
      throw new AppraisalError('appraisal_new_source_event_required');
    }
    const windows = PERSISTENCE[operation.persistenceClass];
    appraisal = {
      id: idFactory(),
      subjectKey: operation.subjectKey,
      version: previous ? Number(previous.version) + 1 : 1,
      status: 'active',
      interpretation: operation.interpretation,
      valence: operation.valence,
      relevance: operation.relevance,
      certainty: operation.certainty,
      controllability: operation.controllability,
      relationalMeaning: operation.relationalMeaning,
      persistenceClass: operation.persistenceClass,
      sourceEventFingerprint: sourceFingerprint,
      operationFingerprint,
      createdAt: iso(now),
      updatedAt: iso(now),
      reviewAt: plusHours(now, windows.reviewHours),
      expiresAt: plusHours(now, windows.expireHours),
      supersedes: previous?.id ?? null,
      supersededBy: null,
    };
    if (previous) previous.supersededBy = appraisal.id;
    if (operation.action === 'revise') {
      previous.status = 'revised';
      previous.revisedAt = iso(now);
      previous.updatedAt = iso(now);
    }
    working.appraisals.push(appraisal);
  }

  working.idempotency.appraisalOperations[operationFingerprint] = {
    operationFingerprint,
    payloadFingerprint,
    action: operation.action,
    appraisalId: appraisal.id,
    sourceEventFingerprint: sourceFingerprint,
    processedAt: iso(now),
  };
  touch(working, now);
  return {
    state: working,
    changed: true,
    duplicate: false,
    action: operation.action,
    appraisal,
    projection: safeSummary(appraisal, now),
  };
}

export function projectActiveAppraisals(input, now = new Date()) {
  return ensureStructures(input).appraisals
    .filter((item) => item.status === 'active')
    .sort((left, right) => Number(right.relevance) - Number(left.relevance)
      || Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .map((item) => ({
      id: item.id,
      subjectKey: item.subjectKey,
      version: item.version,
      interpretation: item.interpretation,
      valence: item.valence,
      relevance: item.relevance,
      certainty: item.certainty,
      controllability: item.controllability,
      relationalMeaning: item.relationalMeaning,
      persistenceClass: item.persistenceClass,
      sourceEventFingerprint: item.sourceEventFingerprint,
      reviewAt: item.reviewAt,
      expiresAt: item.expiresAt,
      reviewDue: Date.parse(item.reviewAt) <= now.getTime(),
    }));
}
