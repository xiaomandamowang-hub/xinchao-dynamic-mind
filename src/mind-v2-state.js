export const MIND_V2_SCHEMA_VERSION = 1;

export class MindV2StateError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MindV2StateError';
    this.code = code;
  }
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new MindV2StateError('mind_v2_invalid_timestamp');
  }
  return date.toISOString();
}

export function newMindV2State(now = new Date()) {
  return {
    schemaVersion: MIND_V2_SCHEMA_VERSION,
    revision: 0,
    lastSettledAt: isoTimestamp(now),
    appraisals: [],
    openLoops: [],
    recallDeliveryReceipts: [],
    resonance: [],
    idempotency: {},
  };
}

export function validateMindV2State(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new MindV2StateError('mind_v2_invalid_state');
  }
  if (state.schemaVersion !== MIND_V2_SCHEMA_VERSION) {
    throw new MindV2StateError('mind_v2_unknown_schema');
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new MindV2StateError('mind_v2_invalid_state');
  }
  if (typeof state.lastSettledAt !== 'string') {
    throw new MindV2StateError('mind_v2_invalid_state');
  }
  isoTimestamp(state.lastSettledAt);
  if (!Array.isArray(state.appraisals)
    || !Array.isArray(state.openLoops)
    || !Array.isArray(state.resonance)
    || !state.idempotency
    || typeof state.idempotency !== 'object'
    || Array.isArray(state.idempotency)) {
    throw new MindV2StateError('mind_v2_invalid_state');
  }
  return state;
}
