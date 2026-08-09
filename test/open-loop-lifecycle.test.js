import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newMindV2State } from '../src/mind-v2-state.js';
import { MindV2Store } from '../src/mind-v2-store.js';
import { sourceEventFingerprint } from '../src/appraisal-lifecycle.js';
import {
  OPEN_LOOP_TTL_POLICY,
  applyOpenLoopOperation,
  initializeOpenLoopState,
  projectOpenLoops,
  settleOpenLoops,
} from '../src/open-loop-lifecycle.js';

const NOW = new Date('2026-08-09T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function addReceipt(state, eventId, processedAt = NOW, source = 'mcp') {
  const next = structuredClone(state);
  next.idempotency.sourceEventReceipts ??= {};
  const eventFingerprint = sourceEventFingerprint(eventId);
  next.idempotency.sourceEventReceipts[eventFingerprint] = {
    eventFingerprint,
    source,
    processedAt: new Date(processedAt).toISOString(),
    baseRevision: 1,
  };
  return next;
}

function operation(action, operationId, sourceEventId, overrides = {}) {
  return {
    action,
    operationId,
    sourceEventId,
    loopKey: 'project:mind-v2-open-loop',
    ...(action === 'open' ? {
      kind: 'task',
      summary: 'A bounded implementation remains unfinished.',
      expectation: 'Finish and verify the lifecycle slice.',
      relatedMemoryIds: [],
      priority: 'high',
    } : {
      closureReason: action === 'resolve'
        ? 'The later real event confirms completion.'
        : 'Shen Gui deliberately chooses to let this go.',
    }),
    ...overrides,
  };
}

test('Open Loop migration initializes only its empty indexes', () => {
  const initial = newMindV2State(NOW);
  initial.appraisals.push({ id: 'appraisal-preserved' });
  const first = initializeOpenLoopState(initial, NOW);
  assert.equal(first.changed, true);
  assert.deepEqual(first.state.openLoops, []);
  assert.deepEqual(first.state.appraisals, [{ id: 'appraisal-preserved' }]);
  assert.deepEqual(first.state.idempotency.openLoopOperations, {});
  assert.deepEqual(first.state.idempotency.sourceEventReceipts, {});
  const second = initializeOpenLoopState(first.state, NOW);
  assert.equal(second.changed, false);
  assert.deepEqual(second.state, first.state);
});

test('only a landed real event receipt can open a loop', () => {
  const empty = initializeOpenLoopState(newMindV2State(NOW), NOW).state;
  assert.throws(
    () => applyOpenLoopOperation(empty, operation('open', 'op-missing', 'missing'), NOW),
    /open_loop_source_event_not_found/,
  );
  const internal = addReceipt(empty, 'internal-event', NOW, 'heartbeat');
  assert.throws(
    () => applyOpenLoopOperation(internal, operation('open', 'op-internal', 'internal-event'), NOW),
    /open_loop_source_not_real/,
  );
  const future = addReceipt(empty, 'future-event', new Date(NOW.getTime() + 1_000));
  assert.throws(
    () => applyOpenLoopOperation(future, operation('open', 'op-future', 'future-event'), NOW),
    /open_loop_source_event_future/,
  );
});

test('default TTL is 30 days and explicit task due dates are bounded', () => {
  let state = addReceipt(newMindV2State(NOW), 'open-default');
  const opened = applyOpenLoopOperation(
    state,
    operation('open', 'op-default', 'open-default'),
    NOW,
    { idFactory: () => 'loop-default' },
  );
  assert.equal(
    opened.loop.expiresAt,
    new Date(NOW.getTime() + OPEN_LOOP_TTL_POLICY.defaultDays * DAY_MS).toISOString(),
  );
  assert.equal('ttlDays' in opened.loop, false);

  const dueAt = new Date(NOW.getTime() + 60 * DAY_MS).toISOString();
  state = addReceipt(opened.state, 'open-due', NOW);
  const due = applyOpenLoopOperation(
    state,
    operation('open', 'op-due', 'open-due', { loopKey: 'plan:due', kind: 'shared_plan', dueAt }),
    NOW,
    { idFactory: () => 'loop-due' },
  );
  assert.equal(due.loop.expiresAt, dueAt);

  assert.throws(
    () => applyOpenLoopOperation(
      addReceipt(due.state, 'relationship-due', NOW),
      operation('open', 'op-relationship-due', 'relationship-due', {
        loopKey: 'relationship:reply', kind: 'relationship', dueAt,
      }),
      NOW,
    ),
    /open_loop_relationship_due_at_forbidden/,
  );
  assert.throws(
    () => applyOpenLoopOperation(
      addReceipt(due.state, 'far-due', NOW),
      operation('open', 'op-far-due', 'far-due', {
        loopKey: 'task:far', dueAt: new Date(NOW.getTime() + 366 * DAY_MS).toISOString(),
      }),
      NOW,
    ),
    /open_loop_due_at_too_far/,
  );
});

test('operation id is idempotent and duplicate loop keys fail closed', () => {
  const state = addReceipt(newMindV2State(NOW), 'event-idempotent');
  const input = operation('open', 'operation-same', 'event-idempotent');
  const first = applyOpenLoopOperation(state, input, NOW, { idFactory: () => 'loop-1' });
  const repeated = applyOpenLoopOperation(first.state, input, NOW, { idFactory: () => 'loop-2' });
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.state.openLoops.length, 1);
  assert.throws(
    () => applyOpenLoopOperation(first.state, { ...input, priority: 'low' }, NOW),
    /open_loop_operation_id_conflict/,
  );
  assert.throws(
    () => applyOpenLoopOperation(first.state, { ...input, relatedMemoryIds: ['mem_changed'] }, NOW),
    /open_loop_operation_id_conflict/,
  );
  assert.throws(
    () => applyOpenLoopOperation(
      first.state,
      operation('open', 'operation-second', 'event-idempotent'),
      NOW,
    ),
    /open_loop_already_open/,
  );
});

test('resolve requires a later real event and differs strictly from release', () => {
  let state = addReceipt(newMindV2State(NOW), 'open-resolve');
  const opened = applyOpenLoopOperation(
    state,
    operation('open', 'op-open-resolve', 'open-resolve'),
    NOW,
    { idFactory: () => 'loop-resolved' },
  );
  assert.throws(
    () => applyOpenLoopOperation(
      opened.state,
      operation('resolve', 'op-resolve-same', 'open-resolve'),
      new Date(NOW.getTime() + 60_000),
    ),
    /open_loop_new_source_event_required/,
  );
  const later = new Date(NOW.getTime() + 60 * 60 * 1000);
  state = addReceipt(opened.state, 'resolve-event', later);
  const resolved = applyOpenLoopOperation(
    state,
    operation('resolve', 'op-resolve', 'resolve-event'),
    later,
  );
  assert.equal(resolved.loop.status, 'resolved');
  assert.match(resolved.loop.closureReason, /confirms completion/);

  state = addReceipt(resolved.state, 'open-release', new Date(later.getTime() + 60 * 60 * 1000));
  const releaseOpenedAt = new Date(later.getTime() + 60 * 60 * 1000);
  const releaseOpened = applyOpenLoopOperation(
    state,
    operation('open', 'op-open-release', 'open-release', { loopKey: 'relationship:waiting', kind: 'relationship' }),
    releaseOpenedAt,
    { idFactory: () => 'loop-released' },
  );
  const releaseEventAt = new Date(releaseOpenedAt.getTime() + 60 * 60 * 1000);
  state = addReceipt(releaseOpened.state, 'release-event', releaseEventAt);
  const released = applyOpenLoopOperation(
    state,
    operation('release', 'op-release', 'release-event', { loopKey: 'relationship:waiting' }),
    releaseEventAt,
  );
  assert.equal(released.loop.status, 'released');
  assert.notEqual(released.loop.status, 'resolved');
  assert.match(released.loop.closureReason, /chooses to let this go/);
});

test('expiry is deterministic and reopening requires a later real interaction', () => {
  let state = addReceipt(newMindV2State(NOW), 'open-expire');
  const opened = applyOpenLoopOperation(
    state,
    operation('open', 'op-open-expire', 'open-expire'),
    NOW,
    { idFactory: () => 'loop-v1' },
  );
  const expiry = new Date(opened.loop.expiresAt);
  const settled = settleOpenLoops(opened.state, expiry);
  assert.equal(settled.changed, true);
  assert.equal(settled.state.openLoops[0].status, 'expired');
  assert.equal(settled.state.openLoops[0].closureReason, 'expired_by_policy');
  const repeated = settleOpenLoops(settled.state, expiry);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.state, settled.state);

  assert.throws(
    () => applyOpenLoopOperation(
      settled.state,
      operation('open', 'op-reopen-stale', 'open-expire'),
      new Date(expiry.getTime() + 1_000),
    ),
    /open_loop_new_source_event_required/,
  );
  const later = new Date(expiry.getTime() + 60 * 60 * 1000);
  state = addReceipt(settled.state, 'reopen-event', later);
  const reopened = applyOpenLoopOperation(
    state,
    operation('open', 'op-reopen', 'reopen-event'),
    later,
    { idFactory: () => 'loop-v2' },
  );
  assert.equal(reopened.loop.status, 'open');
  assert.equal(reopened.loop.version, 2);
  assert.equal(reopened.state.openLoops[0].status, 'expired');
});

test('projection is minimal and private text never enters diagnostics', () => {
  const state = addReceipt(newMindV2State(NOW), 'projection-event');
  const opened = applyOpenLoopOperation(
    state,
    operation('open', 'op-projection', 'projection-event', {
      summary: 'private summary marker',
      expectation: 'private expectation marker',
      relatedMemoryIds: ['mem_private_marker'],
    }),
    NOW,
    { idFactory: () => 'loop-projection' },
  );
  const projection = projectOpenLoops(opened.state);
  assert.equal(projection.length, 1);
  assert.equal(projection[0].status, 'open');
  assert.equal('summary' in projection[0], false);
  assert.equal('expectation' in projection[0], false);
  assert.equal('relatedMemoryIds' in projection[0], false);
  assert.doesNotMatch(JSON.stringify(projection), /private summary|private expectation|mem_private/);
});

test('restart and settlement preserve deterministic Open Loop state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-open-loop-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'mind-v2-state.json');
  const store = new MindV2Store(path, { enabled: true, factory: () => newMindV2State(NOW) });
  await store.initialize();
  await store.update((current) => {
    const initialized = initializeOpenLoopState(current, NOW).state;
    const withReceipt = addReceipt(initialized, 'restart-event');
    return applyOpenLoopOperation(
      withReceipt,
      operation('open', 'op-restart', 'restart-event'),
      NOW,
      { idFactory: () => 'loop-restart' },
    ).state;
  });
  const restarted = new MindV2Store(path, { enabled: true });
  const beforeExpiry = await restarted.read();
  assert.equal(beforeExpiry.openLoops[0].status, 'open');
  const expiry = new Date(beforeExpiry.openLoops[0].expiresAt);
  await restarted.update((current) => settleOpenLoops(current, expiry).state);
  const afterExpiry = await new MindV2Store(path, { enabled: true }).read();
  assert.equal(afterExpiry.openLoops[0].status, 'expired');
  assert.equal(afterExpiry.openLoops[0].closedAt, expiry.toISOString());
  const repeated = settleOpenLoops(afterExpiry, expiry);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.state, afterExpiry);
});

test('invalid kind, priority, due date, related Memory ID and text fail closed', () => {
  const state = addReceipt(newMindV2State(NOW), 'invalid-event');
  assert.throws(
    () => applyOpenLoopOperation(
      state,
      operation('open', 'op-kind', 'invalid-event', { kind: 'obsession' }),
      NOW,
    ),
    /open_loop_kind_invalid/,
  );
  assert.throws(
    () => applyOpenLoopOperation(
      state,
      operation('open', 'op-priority', 'invalid-event', { priority: 'urgent' }),
      NOW,
    ),
    /open_loop_priority_invalid/,
  );
  assert.throws(
    () => applyOpenLoopOperation(
      state,
      operation('open', 'op-due-format', 'invalid-event', { dueAt: 'next Friday' }),
      NOW,
    ),
    /open_loop_due_at_invalid/,
  );
  assert.throws(
    () => applyOpenLoopOperation(
      state,
      operation('open', 'op-memory-id', 'invalid-event', { relatedMemoryIds: ['contains private text'] }),
      NOW,
    ),
    /open_loop_related_memory_id_invalid/,
  );
  assert.throws(
    () => applyOpenLoopOperation(
      state,
      operation('open', 'op-summary', 'invalid-event', { summary: 'x'.repeat(281) }),
      NOW,
    ),
    /open_loop_summary_too_long/,
  );
});
