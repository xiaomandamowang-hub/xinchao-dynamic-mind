import { createHash, randomUUID } from 'node:crypto';
import { sourceEventFingerprint } from './appraisal-lifecycle.js';

const ACTIONS = new Set(['open', 'resolve', 'release']);
const KINDS = new Set(['relationship', 'task', 'shared_plan']);
const PRIORITIES = new Set(['low', 'medium', 'high']);
const DEFAULT_TTL_DAYS = 30;
const MAX_DUE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export const OPEN_LOOP_TTL_POLICY = Object.freeze({
  defaultDays: DEFAULT_TTL_DAYS,
  maxExplicitDueDays: MAX_DUE_DAYS,
});

export class OpenLoopError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OpenLoopError';
    this.code = code;
  }
}

const iso = (value) => new Date(value).toISOString();

function fingerprint(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 24);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
}

function stableFingerprint(value) {
  const stable = JSON.stringify(canonical(value));
  return createHash('sha256').update(stable, 'utf8').digest('hex').slice(0, 24);
}

function requiredText(value, name, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new OpenLoopError(`open_loop_${name}_required`);
  if (text.length > maxLength) throw new OpenLoopError(`open_loop_${name}_too_long`);
  return text;
}

function optionalDueAt(value) {
  if (value == null || value === '') return null;
  const text = requiredText(value, 'due_at', 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)) {
    throw new OpenLoopError('open_loop_due_at_invalid');
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new OpenLoopError('open_loop_due_at_invalid');
  return new Date(timestamp).toISOString();
}

function relatedMemoryIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new OpenLoopError('open_loop_related_memory_ids_invalid');
  }
  const result = [];
  for (const item of value) {
    const memoryId = String(item ?? '').trim();
    if (!memoryId || memoryId.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(memoryId)) {
      throw new OpenLoopError('open_loop_related_memory_id_invalid');
    }
    if (!result.includes(memoryId)) result.push(memoryId);
  }
  return result;
}

function ensureStructures(input) {
  const state = structuredClone(input);
  state.openLoops = Array.isArray(state.openLoops) ? state.openLoops : [];
  state.idempotency = state.idempotency && typeof state.idempotency === 'object'
    && !Array.isArray(state.idempotency) ? state.idempotency : {};
  state.idempotency.openLoopOperations ??= {};
  state.idempotency.sourceEventReceipts ??= {};
  return state;
}

function changedStructures(input) {
  return !Array.isArray(input.openLoops)
    || !input.idempotency
    || typeof input.idempotency !== 'object'
    || Array.isArray(input.idempotency)
    || !input.idempotency.openLoopOperations
    || !input.idempotency.sourceEventReceipts;
}

function touch(state, now) {
  state.revision = Number(state.revision ?? 0) + 1;
  state.lastSettledAt = iso(now);
  return state;
}

export function initializeOpenLoopState(input, now = new Date()) {
  const changed = changedStructures(input);
  const state = ensureStructures(input);
  if (changed) touch(state, now);
  return { state, changed };
}

function normalizeOperation(input) {
  const action = requiredText(input.action, 'action', 16).toLowerCase();
  if (!ACTIONS.has(action)) throw new OpenLoopError('open_loop_action_invalid');
  const operationId = requiredText(input.operationId ?? input.operation_id, 'operation_id', 120);
  const sourceEventId = requiredText(input.sourceEventId ?? input.source_event_id, 'source_event_id', 120);
  const loopKey = requiredText(input.loopKey ?? input.loop_key, 'loop_key', 120);
  const common = { action, operationId, sourceEventId, loopKey };
  if (action !== 'open') {
    return {
      ...common,
      closureReason: requiredText(
        input.closureReason ?? input.closure_reason,
        'closure_reason',
        240,
      ),
    };
  }
  const kind = requiredText(input.kind, 'kind', 24).toLowerCase();
  if (!KINDS.has(kind)) throw new OpenLoopError('open_loop_kind_invalid');
  const priority = requiredText(input.priority, 'priority', 16).toLowerCase();
  if (!PRIORITIES.has(priority)) throw new OpenLoopError('open_loop_priority_invalid');
  const dueAt = optionalDueAt(input.dueAt ?? input.due_at);
  if (kind === 'relationship' && dueAt) {
    throw new OpenLoopError('open_loop_relationship_due_at_forbidden');
  }
  return {
    ...common,
    kind,
    summary: requiredText(input.summary, 'summary', 280),
    expectation: requiredText(input.expectation, 'expectation', 280),
    relatedMemoryIds: relatedMemoryIds(input.relatedMemoryIds ?? input.related_memory_ids),
    priority,
    dueAt,
  };
}

function payloadForFingerprint(operation) {
  const payload = { ...operation };
  delete payload.operationId;
  return payload;
}

function latestForKey(state, loopKey) {
  return state.openLoops
    .filter((item) => item.loopKey === loopKey)
    .sort((left, right) => Number(right.version) - Number(left.version))[0] ?? null;
}

function openForKey(state, loopKey) {
  return state.openLoops.find((item) => item.loopKey === loopKey && item.status === 'open') ?? null;
}

function safeProjection(item) {
  if (!item) return null;
  return {
    id: item.id,
    loopKey: item.loopKey,
    kind: item.kind,
    priority: item.priority,
    status: item.status,
    version: item.version,
    openedAt: item.openedAt,
    updatedAt: item.updatedAt,
    expiresAt: item.expiresAt,
    closedAt: item.closedAt,
    closureReason: item.closureReason,
  };
}

function validatedReceipt(state, sourceEventId, now) {
  const eventFingerprint = sourceEventFingerprint(sourceEventId);
  const receipt = state.idempotency.sourceEventReceipts[eventFingerprint];
  if (!receipt) throw new OpenLoopError('open_loop_source_event_not_found');
  const processedAt = Date.parse(receipt.processedAt ?? '');
  if (!Number.isFinite(processedAt)) throw new OpenLoopError('open_loop_source_event_invalid');
  if (processedAt > now.getTime()) throw new OpenLoopError('open_loop_source_event_future');
  if (!['mcp', 'api'].includes(receipt.source)) throw new OpenLoopError('open_loop_source_not_real');
  return { eventFingerprint, processedAt };
}

function expiresAtFor(operation, now) {
  if (!operation.dueAt) return new Date(now.getTime() + DEFAULT_TTL_DAYS * DAY_MS).toISOString();
  const dueTimestamp = Date.parse(operation.dueAt);
  if (dueTimestamp <= now.getTime()) throw new OpenLoopError('open_loop_due_at_not_future');
  if (dueTimestamp > now.getTime() + MAX_DUE_DAYS * DAY_MS) {
    throw new OpenLoopError('open_loop_due_at_too_far');
  }
  return new Date(dueTimestamp).toISOString();
}

export function settleOpenLoops(input, now = new Date()) {
  const state = ensureStructures(input);
  let expired = 0;
  for (const item of state.openLoops) {
    if (item.status !== 'open') continue;
    const expiresAt = Date.parse(item.expiresAt ?? '');
    if (!Number.isFinite(expiresAt) || expiresAt > now.getTime()) continue;
    item.status = 'expired';
    item.closedAt = new Date(expiresAt).toISOString();
    item.updatedAt = item.closedAt;
    item.closureReason = 'expired_by_policy';
    expired += 1;
  }
  if (expired) touch(state, now);
  return { state, changed: expired > 0, expired };
}

export function applyOpenLoopOperation(input, rawOperation, now = new Date(), {
  idFactory = randomUUID,
} = {}) {
  const operation = normalizeOperation(rawOperation);
  const state = ensureStructures(input);
  const operationFingerprint = fingerprint(operation.operationId);
  const payloadFingerprint = stableFingerprint(payloadForFingerprint(operation));
  const priorOperation = state.idempotency.openLoopOperations[operationFingerprint];
  if (priorOperation) {
    if (priorOperation.payloadFingerprint !== payloadFingerprint) {
      throw new OpenLoopError('open_loop_operation_id_conflict');
    }
    const existing = state.openLoops.find((item) => item.id === priorOperation.loopId) ?? null;
    return {
      state,
      changed: false,
      duplicate: true,
      action: priorOperation.action,
      loop: existing,
      projection: safeProjection(existing),
    };
  }

  const source = validatedReceipt(state, operation.sourceEventId, now);
  const settled = settleOpenLoops(state, now);
  const working = settled.state;
  let loop;

  if (operation.action === 'open') {
    if (openForKey(working, operation.loopKey)) {
      throw new OpenLoopError('open_loop_already_open');
    }
    const previous = latestForKey(working, operation.loopKey);
    if (previous) {
      const closedAt = Date.parse(previous.closedAt ?? '');
      if (!Number.isFinite(closedAt) || source.processedAt <= closedAt) {
        throw new OpenLoopError('open_loop_new_source_event_required');
      }
    }
    loop = {
      id: idFactory(),
      loopKey: operation.loopKey,
      kind: operation.kind,
      summary: operation.summary,
      expectation: operation.expectation,
      openedByEventId: operation.sourceEventId,
      openedSourceEventFingerprint: source.eventFingerprint,
      openedSourceProcessedAt: new Date(source.processedAt).toISOString(),
      relatedMemoryIds: operation.relatedMemoryIds,
      priority: operation.priority,
      status: 'open',
      openedAt: iso(now),
      updatedAt: iso(now),
      expiresAt: expiresAtFor(operation, now),
      closedAt: null,
      closureReason: null,
      closureEventFingerprint: null,
      version: previous ? Number(previous.version) + 1 : 1,
      operationFingerprint,
    };
    working.openLoops.push(loop);
  } else {
    loop = openForKey(working, operation.loopKey);
    if (!loop) throw new OpenLoopError('open_loop_active_not_found');
    const openedAt = Date.parse(loop.openedAt ?? '');
    if (loop.openedSourceEventFingerprint === source.eventFingerprint
      || !Number.isFinite(openedAt)
      || source.processedAt <= openedAt) {
      throw new OpenLoopError('open_loop_new_source_event_required');
    }
    loop.status = operation.action === 'resolve' ? 'resolved' : 'released';
    loop.updatedAt = iso(now);
    loop.closedAt = iso(now);
    loop.closureReason = operation.closureReason;
    loop.closureEventFingerprint = source.eventFingerprint;
  }

  working.idempotency.openLoopOperations[operationFingerprint] = {
    operationFingerprint,
    payloadFingerprint,
    action: operation.action,
    loopId: loop.id,
    sourceEventFingerprint: source.eventFingerprint,
    processedAt: iso(now),
  };
  touch(working, now);
  return {
    state: working,
    changed: true,
    duplicate: false,
    action: operation.action,
    loop,
    projection: safeProjection(loop),
  };
}

export function projectOpenLoops(input) {
  return ensureStructures(input).openLoops
    .filter((item) => item.status === 'open')
    .sort((left, right) => {
      const rank = { high: 3, medium: 2, low: 1 };
      return Number(rank[right.priority] ?? 0) - Number(rank[left.priority] ?? 0)
        || Date.parse(left.expiresAt) - Date.parse(right.expiresAt)
        || String(left.id).localeCompare(String(right.id));
    })
    .map(safeProjection);
}
