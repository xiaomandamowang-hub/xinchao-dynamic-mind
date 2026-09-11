import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPRAISAL_PERSISTENCE_WINDOWS,
  applyAppraisalOperation,
  initializeAppraisalState,
  projectActiveAppraisals,
  registerAppraisalSourceEvent,
  settleAppraisals,
  sourceEventFingerprint,
} from '../src/appraisal-lifecycle.js';
import { newMindV2State } from '../src/mind-v2-state.js';

const NOW = new Date('2026-08-09T12:00:00.000Z');

function baseState(eventId, processedAt = NOW) {
  return {
    revision: 7,
    recentConversationEvents: [{
      eventFingerprint: sourceEventFingerprint(eventId),
      interactionType: 'reflection',
      processedAt: processedAt.toISOString(),
    }],
  };
}

function receipt(state, eventId, now = NOW, source = 'mcp', base = baseState(eventId, now)) {
  return registerAppraisalSourceEvent(state, {
    eventId,
    source,
    baseState: base,
    baseRevision: base.revision,
  }, now).state;
}

function appraisal(action, operationId, sourceEventId, overrides = {}) {
  return {
    action,
    operationId,
    sourceEventId,
    subjectKey: 'relationship:trust',
    interpretation: 'This interaction currently feels like a deliberate repair attempt.',
    valence: 0.45,
    relevance: 0.8,
    certainty: 0.65,
    controllability: 0.4,
    relationalMeaning: 'The relationship may be moving back toward mutual trust.',
    persistenceClass: 'situational',
    ...overrides,
  };
}

test('Appraisal migration only initializes its idempotency indexes', () => {
  const initial = newMindV2State(NOW);
  const first = initializeAppraisalState(initial, NOW);
  assert.equal(first.changed, true);
  assert.deepEqual(first.state.idempotency, {
    appraisalOperations: {},
    sourceEventReceipts: {},
  });
  assert.deepEqual(first.state.appraisals, []);
  assert.deepEqual(first.state.openLoops, []);
  assert.deepEqual(first.state.resonance, []);
  assert.equal(first.state.revision, 1);
  const repeated = initializeAppraisalState(first.state, NOW);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.state, first.state);
});

test('only a landed real conversation event can become an Appraisal source', () => {
  const initial = newMindV2State(NOW);
  const registered = registerAppraisalSourceEvent(initial, {
    eventId: 'real-event-1',
    source: 'mcp',
    baseState: baseState('real-event-1'),
    baseRevision: 7,
  }, NOW);
  assert.equal(registered.changed, true);
  assert.equal(registered.duplicate, false);
  assert.equal(registered.receipt.source, 'mcp');
  assert.equal('eventId' in registered.receipt, false);
  const repeated = registerAppraisalSourceEvent(registered.state, {
    eventId: 'real-event-1', source: 'mcp', baseState: baseState('real-event-1'), baseRevision: 7,
  }, NOW);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.state.revision, registered.state.revision);

  for (const source of ['heartbeat', 'shadow', 'test', 'dream', 'thought']) {
    assert.throws(
      () => registerAppraisalSourceEvent(initial, {
        eventId: `not-real-${source}`,
        source,
        baseState: baseState(`not-real-${source}`),
      }, NOW),
      /appraisal_source_not_real/,
    );
  }
  assert.throws(
    () => registerAppraisalSourceEvent(initial, {
      eventId: 'missing', source: 'api', baseState: baseState('another-event'),
    }, NOW),
    /appraisal_source_event_not_found/,
  );
  const future = new Date(NOW.getTime() + 1);
  assert.throws(
    () => registerAppraisalSourceEvent(initial, {
      eventId: 'future', source: 'api', baseState: baseState('future', future),
    }, NOW),
    /appraisal_source_event_future/,
  );
});

test('create uses fixed persistence windows and never accepts a free TTL', () => {
  for (const [persistenceClass, windows] of Object.entries(APPRAISAL_PERSISTENCE_WINDOWS)) {
    const eventId = `create-${persistenceClass}`;
    const state = receipt(newMindV2State(NOW), eventId);
    const result = applyAppraisalOperation(
      state,
      appraisal('create', `op-${persistenceClass}`, eventId, {
        persistenceClass,
        relevance: 1,
        ttlHours: 99999,
      }),
      NOW,
      { idFactory: () => `appraisal-${persistenceClass}` },
    );
    assert.equal(result.appraisal.status, 'active');
    assert.equal(result.appraisal.version, 1);
    assert.equal(
      result.appraisal.reviewAt,
      new Date(NOW.getTime() + windows.reviewHours * 3_600_000).toISOString(),
    );
    assert.equal(
      result.appraisal.expiresAt,
      new Date(NOW.getTime() + windows.expireHours * 3_600_000).toISOString(),
    );
    assert.equal('ttlHours' in result.appraisal, false);
    assert.equal(result.appraisal.sourceEventFingerprint, sourceEventFingerprint(eventId));
  }
});

test('operation_id is idempotent and conflicting reuse is rejected', () => {
  const state = receipt(newMindV2State(NOW), 'event-idempotent');
  const operation = appraisal('create', 'operation-same', 'event-idempotent');
  const first = applyAppraisalOperation(state, operation, NOW, { idFactory: () => 'appraisal-1' });
  const repeated = applyAppraisalOperation(first.state, operation, NOW);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.state.revision, first.state.revision);
  assert.equal(repeated.state.appraisals.length, 1);
  assert.throws(
    () => applyAppraisalOperation(first.state, {
      ...operation,
      interpretation: 'A conflicting retry must not replace the original meaning.',
    }, NOW),
    /appraisal_operation_id_conflict/,
  );
});

test('revision preserves a version and supersedes chain without overwriting history', () => {
  let state = receipt(newMindV2State(NOW), 'event-create');
  const created = applyAppraisalOperation(
    state,
    appraisal('create', 'op-create', 'event-create'),
    NOW,
    { idFactory: () => 'appraisal-v1' },
  );
  const reviseAt = new Date(NOW.getTime() + 2 * 3_600_000);
  state = receipt(created.state, 'event-revise', reviseAt);
  const revised = applyAppraisalOperation(
    state,
    appraisal('revise', 'op-revise', 'event-revise', {
      interpretation: 'New interaction changes the current interpretation.',
      persistenceClass: 'significant',
    }),
    reviseAt,
    { idFactory: () => 'appraisal-v2' },
  );
  const first = revised.state.appraisals[0];
  const second = revised.state.appraisals[1];
  assert.equal(first.status, 'revised');
  assert.equal(first.supersededBy, 'appraisal-v2');
  assert.equal(second.status, 'active');
  assert.equal(second.version, 2);
  assert.equal(second.supersedes, 'appraisal-v1');
  assert.match(first.interpretation, /deliberate repair/);
  assert.match(second.interpretation, /changes the current/);
});

test('release ends the active version and preserves its subjective history', () => {
  let state = receipt(newMindV2State(NOW), 'event-create-release');
  const created = applyAppraisalOperation(
    state,
    appraisal('create', 'op-create-release', 'event-create-release'),
    NOW,
    { idFactory: () => 'appraisal-release' },
  );
  const releaseAt = new Date(NOW.getTime() + 3_600_000);
  state = receipt(created.state, 'event-release', releaseAt);
  const released = applyAppraisalOperation(state, {
    action: 'release',
    operationId: 'op-release',
    sourceEventId: 'event-release',
    subjectKey: 'relationship:trust',
  }, releaseAt);
  assert.equal(released.appraisal.status, 'released');
  assert.equal(released.appraisal.releasedAt, releaseAt.toISOString());
  assert.match(released.appraisal.interpretation, /deliberate repair/);
  assert.deepEqual(projectActiveAppraisals(released.state, releaseAt), []);
});

test('review projection and expiry are deterministic and never auto-reactivate', () => {
  let state = receipt(newMindV2State(NOW), 'event-expire');
  const created = applyAppraisalOperation(
    state,
    appraisal('create', 'op-expire', 'event-expire', { persistenceClass: 'fleeting' }),
    NOW,
    { idFactory: () => 'appraisal-expire-v1' },
  );
  const reviewAt = new Date(NOW.getTime() + 6 * 3_600_000);
  assert.equal(projectActiveAppraisals(created.state, reviewAt)[0].reviewDue, true);
  const expiry = new Date(NOW.getTime() + 24 * 3_600_000);
  const settled = settleAppraisals(created.state, expiry);
  assert.equal(settled.expired, 1);
  assert.equal(settled.state.appraisals[0].status, 'expired');
  assert.equal(settled.state.appraisals[0].expiredAt, expiry.toISOString());
  const repeated = settleAppraisals(settled.state, new Date(expiry.getTime() + 3_600_000));
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.state, settled.state);
  assert.deepEqual(projectActiveAppraisals(repeated.state, expiry), []);

  const reactivateAt = new Date(expiry.getTime() + 2 * 3_600_000);
  state = receipt(repeated.state, 'event-reactivate', reactivateAt);
  const reactivated = applyAppraisalOperation(
    state,
    appraisal('create', 'op-reactivate', 'event-reactivate'),
    reactivateAt,
    { idFactory: () => 'appraisal-expire-v2' },
  );
  assert.equal(reactivated.appraisal.version, 2);
  assert.equal(reactivated.appraisal.supersedes, 'appraisal-expire-v1');
  assert.equal(reactivated.state.appraisals[0].status, 'expired');
});

test('invalid fields and an absent active subject fail closed', () => {
  const state = receipt(newMindV2State(NOW), 'event-invalid');
  assert.throws(
    () => applyAppraisalOperation(state, appraisal('create', 'op-long', 'event-invalid', {
      interpretation: 'x'.repeat(481),
    }), NOW),
    /appraisal_interpretation_too_long/,
  );
  assert.throws(
    () => applyAppraisalOperation(state, appraisal('create', 'op-valence', 'event-invalid', {
      valence: 2,
    }), NOW),
    /appraisal_valence_invalid/,
  );
  assert.throws(
    () => applyAppraisalOperation(state, appraisal('revise', 'op-no-active', 'event-invalid'), NOW),
    /appraisal_active_subject_not_found/,
  );
  assert.throws(
    () => applyAppraisalOperation(state, appraisal('create', 'op-missing-source', 'missing-source'), NOW),
    /appraisal_source_event_not_found/,
  );
  const created = applyAppraisalOperation(
    state,
    appraisal('create', 'op-same-source-create', 'event-invalid'),
    NOW,
    { idFactory: () => 'appraisal-same-source' },
  );
  assert.throws(
    () => applyAppraisalOperation(
      created.state,
      appraisal('revise', 'op-same-source-revise', 'event-invalid'),
      NOW,
    ),
    /appraisal_new_source_event_required/,
  );
  assert.throws(
    () => applyAppraisalOperation(created.state, {
      action: 'release',
      operationId: 'op-same-source-release',
      sourceEventId: 'event-invalid',
      subjectKey: 'relationship:trust',
    }, NOW),
    /appraisal_new_source_event_required/,
  );
});
