import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { loadConfig, validateConfig, validateServiceToken } from './config.js';
import { applyDriveFeedback, applyOmbreHeartbeat, barkAllowed, breathDreamContext, contactIdleAllowed, daytimeEmergenceAllowed, dreamAllowed, newState, pickIntent, proactiveBarkAllowed, recordBark, recordDaytimeEmergence, recordDream, scheduleDaytimeEmergence, settleAndApplyConversationEvent, settleState, topDrives } from './engine.js';
import { selectUniqueBark } from './bark-dedupe.js';
import { StateStore } from './state-store.js';
import { MindV2Store } from './mind-v2-store.js';
import { ModelClient } from './model-client.js';
import { OmbreClient } from './ombre-client.js';
import { MemoryV1Client, MemoryV1ShadowObserver } from './memory-client.js';
import { promoteShadowContextCandidate, ShadowContextCompositionRunner } from './shadow-context-composer.js';
import { BarkClient } from './bark-client.js';
import { readOmbreHeartbeat } from './heartbeat-store.js';
import { buildContextEnvelope, contextDeliveryState, recordContextDelivery } from './context-envelope.js';
import { TransitionJournal } from './transition-journal.js';
import { handleMcpMessage } from './mcp-protocol.js';
import { OAuthProvider } from './oauth-provider.js';
import { recordHandoffNote } from './handoff-notes.js';
import { SYSTEM_VERSION } from './version.js';
import {
  applyAppraisalOperation,
  initializeAppraisalState,
  registerAppraisalSourceEvent,
  settleAppraisals,
} from './appraisal-lifecycle.js';
import {
  applyOpenLoopOperation,
  initializeOpenLoopState,
  settleOpenLoops,
} from './open-loop-lifecycle.js';

const config = validateConfig(loadConfig());
validateServiceToken(config.serviceToken);

const store = new StateStore(config.statePath, () => newState());
const mindV2Store = new MindV2Store(config.mindV2.statePath, {
  enabled: config.mindV2.storeEnabled,
});
const appraisalEnabled = config.mindV2.storeEnabled && config.mindV2.appraisalsEnabled;
const openLoopEnabled = config.mindV2.storeEnabled && config.mindV2.openLoopsEnabled;
const mindV2SourceReceiptsEnabled = appraisalEnabled || openLoopEnabled;
const model = new ModelClient(config.model);
const ombre = new OmbreClient(config.ombre);
const memoryV1 = new MemoryV1Client(config.memoryV1);
const memoryV1Shadow = new MemoryV1ShadowObserver(memoryV1, {
  ttlMinutes: config.memoryV1.dedupeTtlMinutes,
});
const shadowContextComposition = new ShadowContextCompositionRunner(memoryV1, {
  ttlMinutes: config.memoryV1.dedupeTtlMinutes,
  maxTokens: config.memoryV1.shadowContextMaxTokens,
  memoryMaxTokens: config.memoryV1.shadowContextMemoryMaxTokens,
  memoryMaxRatio: config.memoryV1.shadowContextMemoryMaxRatio,
  maxMemoryReferences: config.memoryV1.shadowContextMaxReferences,
  perMemoryMaxTokens: config.memoryV1.shadowContextPerMemoryMaxTokens,
});
const bark = new BarkClient(config.bark);
const journal = new TransitionJournal(config.journalPath);
const oauth = new OAuthProvider(config.oauth, (event, fields = {}) => log(event, fields));
await oauth.init();
let cyclePromise = null;

function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

function mindV2ErrorCode(error) {
  const code = String(error?.code ?? error?.message ?? '');
  return /^(mind_v2_|appraisal_)[a-z0-9_]+$/.test(code)
    ? code
    : 'mind_v2_appraisal_failed';
}

async function registerRealEventForAppraisal(event, source, baseState, now) {
  if (!mindV2SourceReceiptsEnabled || !['mcp', 'api'].includes(source)) return;
  let outcome;
  try {
    const persisted = await mindV2Store.update((mindState) => {
      outcome = registerAppraisalSourceEvent(mindState, {
        eventId: event.eventId ?? event.event_id,
        source,
        baseState,
        baseRevision: baseState.revision,
      }, now);
      return outcome.state;
    });
    log('mind_v2_appraisal_source', {
      status: outcome.duplicate ? 'duplicate' : 'recorded',
      revision: persisted.revision,
      errorCode: null,
    });
  } catch (error) {
    log('mind_v2_appraisal_source', {
      status: 'omitted',
      errorCode: mindV2ErrorCode(error),
    });
  }
}

function openLoopErrorCode(error) {
  const code = String(error?.code ?? error?.message ?? '');
  return /^(mind_v2_|open_loop_)[a-z0-9_]+$/.test(code)
    ? code
    : 'mind_v2_open_loop_failed';
}

async function recordAppraisalOperation(operation, now = new Date()) {
  if (!appraisalEnabled) throw new Error('appraisal_disabled');
  let outcome;
  try {
    const persisted = await mindV2Store.update((mindState) => {
      outcome = applyAppraisalOperation(mindState, operation, now);
      return outcome.state;
    });
    log('mind_v2_appraisal_operation', {
      status: outcome.duplicate ? 'duplicate' : 'applied',
      action: outcome.action,
      revision: persisted.revision,
      appraisalCount: persisted.appraisals.length,
      errorCode: null,
    });
    return {
      revision: persisted.revision,
      action: outcome.action,
      duplicate: outcome.duplicate,
      appraisal: outcome.projection,
    };
  } catch (error) {
    const code = mindV2ErrorCode(error);
    log('mind_v2_appraisal_operation', { status: 'rejected', errorCode: code });
    throw new Error(code);
  }
}

async function settleMindV2Appraisals(now = new Date()) {
  if (!appraisalEnabled) return;
  let outcome;
  try {
    const persisted = await mindV2Store.update((mindState) => {
      outcome = settleAppraisals(mindState, now);
      return outcome.state;
    });
    if (outcome.changed) {
      log('mind_v2_appraisal_settled', {
        status: 'settled',
        expiredCount: outcome.expired,
        revision: persisted.revision,
        errorCode: null,
      });
    }
  } catch (error) {
    log('mind_v2_appraisal_settled', {
      status: 'omitted',
      errorCode: mindV2ErrorCode(error),
    });
  }
}

async function recordOpenLoopOperation(operation, now = new Date()) {
  if (!openLoopEnabled) throw new Error('open_loop_disabled');
  let outcome;
  try {
    const persisted = await mindV2Store.update((mindState) => {
      outcome = applyOpenLoopOperation(mindState, operation, now);
      return outcome.state;
    });
    log('mind_v2_open_loop_operation', {
      status: outcome.duplicate ? 'duplicate' : 'applied',
      action: outcome.action,
      revision: persisted.revision,
      openLoopCount: persisted.openLoops.length,
      errorCode: null,
    });
    return {
      revision: persisted.revision,
      action: outcome.action,
      duplicate: outcome.duplicate,
      openLoop: outcome.projection,
    };
  } catch (error) {
    const code = openLoopErrorCode(error);
    log('mind_v2_open_loop_operation', { status: 'rejected', errorCode: code });
    throw new Error(code);
  }
}

async function settleMindV2OpenLoops(now = new Date()) {
  if (!openLoopEnabled) return;
  let outcome;
  try {
    const persisted = await mindV2Store.update((mindState) => {
      outcome = settleOpenLoops(mindState, now);
      return outcome.state;
    });
    if (outcome.changed) {
      log('mind_v2_open_loop_settled', {
        status: 'settled',
        expiredCount: outcome.expired,
        revision: persisted.revision,
        errorCode: null,
      });
    }
  } catch (error) {
    log('mind_v2_open_loop_settled', {
      status: 'omitted',
      errorCode: openLoopErrorCode(error),
    });
  }
}

async function observeMemoryV1(kind, options = {}) {
  if (!config.memoryV1.enabled || !config.memoryV1.shadowEnabled) return;
  const diagnostic = await memoryV1Shadow.observe(kind, options);
  log('memory_v1_shadow_read', {
    kind: diagnostic.kind,
    status: diagnostic.status,
    latencyMs: diagnostic.latencyMs,
    resultCount: diagnostic.resultCount,
    estimatedTokens: diagnostic.estimatedTokens,
    truncated: diagnostic.truncated,
    errorCode: diagnostic.errorCode,
  });
}

async function composeMemoryV1Context(baseEnvelope, { sessionId, now, maxTokens, formal = false }) {
  const result = await shadowContextComposition.compose({
    baseEnvelope,
    sessionId,
    now,
    maxTokens,
  });
  log(formal ? 'memory_v1_context_composed' : 'memory_v1_shadow_context_composed', result.diagnostic);
  return result;
}

async function updateState(meta, mutate) {
  let before;
  const after = await store.update((current) => {
    before = structuredClone(current);
    return mutate(current);
  });
  try {
    await journal.recordTransition({
      before,
      after,
      type: meta.type,
      source: meta.source,
      sessionId: meta.sessionId,
      eventId: meta.eventId,
      details: meta.details,
      force: meta.force,
      at: meta.at,
    });
  } catch (error) {
    log('transition_journal_failed', { type: meta.type, message: error.message });
  }
  return after;
}

async function synchronizeOmbreHeartbeat() {
  let recordedAt;
  try {
    recordedAt = await readOmbreHeartbeat(config.heartbeat.filePath);
  } catch (error) {
    log('ombre_heartbeat_read_failed', { message: error.message });
    return null;
  }
  if (!recordedAt) return null;

  let observed = false;
  const state = await updateState({
    type: 'ombre_heartbeat',
    source: 'ombre-file',
    at: new Date(recordedAt),
  }, (current) => {
    const previous = Date.parse(current.lastHeartbeatAt ?? '');
    if (Number.isFinite(previous) && previous >= recordedAt.getTime()) return current;
    observed = true;
    return applyOmbreHeartbeat(current, recordedAt).state;
  });
  if (observed) log('ombre_heartbeat_observed', { revision: state.revision });
  return state;
}

async function runCycle() {
  if (cyclePromise) return cyclePromise;
  cyclePromise = (async () => {
    const now = new Date();
    await synchronizeOmbreHeartbeat();
    let settled;
    await updateState({
      type: 'settle',
      source: 'timer',
      at: now,
    }, (state) => {
      settled = settleState(state, now, config.sleepAfterMinutes, config.settle);
      return settled.state;
    });

    let state = settled.state;
    let dreamCreated = false;
    let barkSent = false;
    let daytimeSent = false;
    // Dream residue follows a short quiet period; autonomous contact remains
    // reserved for a genuine long absence.
    const dreamContactIsIdle = contactIdleAllowed(state, now, config.heartbeat.dreamMinIdleHours);
    const proactiveContactIsIdle = contactIdleAllowed(state, now, config.heartbeat.proactiveMinIdleHours);

    if (dreamAllowed(state, now, config.dreamMinIntervalHours, config.dreamMaxPerDay)) {
      if (!config.memoryV1.shadowContextEnabled) {
        void observeMemoryV1('recentMaterial', {
          dedupeKey: `dream:${now.toISOString()}`,
          now,
        });
      }
      let material = '';
      if (!config.shadowMode && config.ombre.readEnabled) {
        try { material = await ombre.recentMaterial(); }
        catch (error) { log('ombre_read_failed', { message: error.message }); }
      }

      let generated;
      if (config.shadowMode) {
        generated = new ModelClient({ ...config.model, enabled: false }).fallback(topDrives(state));
      } else {
        try {
          generated = await model.generateDream({ state, material, topDrives: topDrives(state) });
        } catch (error) {
          log('dream_model_failed', { message: error.message });
          generated = new ModelClient({ ...config.model, enabled: false }).fallback(topDrives(state));
        }
      }

      const dream = { id: randomUUID(), createdAt: now.toISOString(), ...generated, ombreBucketId: null };
      if (!config.shadowMode && config.ombre.writeEnabled) {
        try { dream.ombreBucketId = await ombre.storeDream(dream); }
        catch (error) { log('ombre_write_failed', { message: error.message }); }
      }

      state = await updateState({
        type: 'dream_recorded',
        source: config.shadowMode ? 'rule-seed' : 'model',
        details: { dreamCreated: true },
        at: now,
      }, (latest) => {
        if (!dreamAllowed(latest, now, config.dreamMinIntervalHours, config.dreamMaxPerDay)) return latest;
        return recordDream(latest, dream);
      });
      dreamCreated = true;
      log('dream_settled', { source: dream.source, shadow: config.shadowMode, usedBreath: Boolean(material), revision: state.revision });

      if (!config.shadowMode && config.bark.enabled && dreamContactIsIdle && barkAllowed(state, now, config.bark.minIntervalHours, config.bark.maxPerDay, 'dream')) {
        try {
          let modelFailed = false;
          const selected = await selectUniqueBark({
            state,
            onRejected: ({ attempt, similarity }) => log('bark_duplicate_rejected', { kind: 'dream', attempt, similarity }),
            generate: async ({ recentMessages, rejectedMessage }) => {
              if (modelFailed) return dream.residue;
              try {
                return await model.generateDreamPush({ dream, recentMessages, rejectedMessage });
              } catch (error) {
                modelFailed = true;
                log('dream_push_model_failed', { message: error.message });
                return dream.residue;
              }
            },
          });
          if (selected.reason === 'duplicate') {
            log('bark_duplicate_skipped', { kind: 'dream', attempts: selected.attempts });
          }
          if (selected.message) {
            const result = await bark.send(selected.message);
            if (result.sent) {
              state = await updateState({
                type: 'bark_sent',
                source: 'bark',
                details: { barkSent: true, kind: 'dream' },
                at: now,
              }, (latest) => recordBark(latest, now, { kind: 'dream', message: selected.message }));
              barkSent = true;
              log('bark_sent', { kind: 'dream', revision: state.revision });
            }
          }
        } catch (error) { log('bark_failed', { kind: 'dream', message: error.message }); }
      }
    }

    if (!config.shadowMode && config.bark.enabled && proactiveContactIsIdle && !dreamCreated && proactiveBarkAllowed(state, now, config.bark.autonomousMinIntervalHours, config.bark.maxPerDay, config.bark.minDrive)) {
      if (!config.memoryV1.shadowContextEnabled) {
        void observeMemoryV1('thoughtMaterial', {
          dedupeKey: `thought:${now.toISOString()}`,
          now,
        });
      }
      let selected;
      let modelFailed = false;
      try {
        selected = await selectUniqueBark({
          state,
          onRejected: ({ attempt, similarity }) => log('bark_duplicate_rejected', { kind: 'autonomous_thought', attempt, similarity }),
          generate: async ({ recentMessages, rejectedMessage }) => {
            if (modelFailed) return new ModelClient({ ...config.model, enabled: false }).fallbackThought(topDrives(state));
            try {
              return await model.generateThought({ state, topDrives: topDrives(state), recentMessages, rejectedMessage });
            } catch (error) {
              modelFailed = true;
              log('thought_model_failed', { message: error.message });
              return new ModelClient({ ...config.model, enabled: false }).fallbackThought(topDrives(state));
            }
          },
        });
      } catch (error) {
        log('thought_model_failed', { message: error.message });
        selected = { message: '', reason: 'empty', attempts: 1 };
      }
      if (selected.reason === 'duplicate') {
        log('bark_duplicate_skipped', { kind: 'autonomous_thought', attempts: selected.attempts });
      }
      if (selected.message) {
        try {
          const result = await bark.send(selected.message);
          if (result.sent) {
            state = await updateState({
              type: 'bark_sent',
              source: 'bark',
              details: { barkSent: true, kind: 'autonomous_thought' },
              at: now,
            }, (latest) => recordBark(latest, now, { kind: 'autonomous_thought', message: selected.message }));
            barkSent = true;
            log('bark_sent', { kind: 'autonomous_thought', source: selected.candidate?.source, revision: state.revision });
          }
        } catch (error) { log('bark_failed', { kind: 'autonomous_thought', message: error.message }); }
      }
    }

    if (!state.nextDaytimeEmergenceAt && config.daytime.enabled) {
      state = await updateState({
        type: 'daytime_emergence_scheduled',
        source: 'timer',
        at: now,
      }, (latest) => scheduleDaytimeEmergence(latest, now, config.daytime.minIntervalHours, config.daytime.maxIntervalHours));
      log('daytime_emergence_scheduled', { nextAt: state.nextDaytimeEmergenceAt, revision: state.revision });
    } else if (!config.shadowMode && config.daytime.enabled && config.ombre.readEnabled && config.bark.enabled && daytimeEmergenceAllowed(state, now, config.daytime)) {
      let selected = { message: '', candidate: { source: 'none' }, reason: 'empty', attempts: 1 };
      try {
        const material = await ombre.daytimeMaterial();
        if (material.trim()) {
          selected = await selectUniqueBark({
            state,
            onRejected: ({ attempt, similarity }) => log('bark_duplicate_rejected', { kind: 'daytime_emergence', attempt, similarity }),
            generate: ({ recentMessages, rejectedMessage }) => model.generateDaytimeEmergence({ material, recentMessages, rejectedMessage }),
          });
        }
      } catch (error) {
        log('daytime_emergence_failed', { message: error.message });
      }
      if (selected.reason === 'duplicate') {
        log('bark_duplicate_skipped', { kind: 'daytime_emergence', attempts: selected.attempts });
      }
      if (selected.message) {
        try {
          const result = await bark.send(selected.message);
          if (result.sent) {
            state = await updateState({
              type: 'daytime_emergence_sent',
              source: 'bark',
              details: { daytimeSent: true },
              at: now,
            }, (latest) => recordDaytimeEmergence(latest, selected.message, now, config.daytime.timeZone));
            daytimeSent = true;
            log('bark_sent', { kind: 'daytime_emergence', source: selected.candidate?.source, revision: state.revision });
          }
        } catch (error) {
          log('bark_failed', { kind: 'daytime_emergence', message: error.message });
        }
      } else {
        log('daytime_emergence_skipped', { reason: selected.reason === 'duplicate' ? 'duplicate' : 'no_pushworthy_material' });
      }
      state = await updateState({
        type: 'daytime_emergence_scheduled',
        source: 'timer',
        at: now,
      }, (latest) => scheduleDaytimeEmergence(latest, now, config.daytime.minIntervalHours, config.daytime.maxIntervalHours));
      log('daytime_emergence_scheduled', { nextAt: state.nextDaytimeEmergenceAt, revision: state.revision });
    }
    await settleMindV2Appraisals(now);
    await settleMindV2OpenLoops(now);
    return { state, dreamCreated, barkSent, daytimeSent };
  })().finally(() => { cyclePromise = null; });
  return cyclePromise;
}

function safeEqual(supplied, expected) {
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function auditEventFingerprint(value) {
  const eventId = String(value ?? '').trim();
  return eventId
    ? createHash('sha256').update(eventId, 'utf8').digest('hex').slice(0, 24)
    : '';
}

function authorized(request) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  return safeEqual(supplied, config.serviceToken);
}

function mcpPath(url) {
  return url.pathname === '/mcp' || url.pathname.startsWith('/mcp/');
}

function transportSessionId(request, initialize = false) {
  const supplied = String(request.headers['mcp-session-id'] ?? '').trim();
  if (!initialize && /^[A-Za-z0-9._~-]{1,120}$/.test(supplied)) return supplied;
  return `mcp-${randomUUID()}`;
}

function negotiatedProtocolVersion(request, payload, result) {
  const supported = new Set(['2025-03-26', '2025-06-18']);
  const values = [
    result?.body?.result?.protocolVersion,
    request.headers['mcp-protocol-version'],
    payload?.params?.protocolVersion,
  ];
  return values.find((value) => supported.has(String(value))) ?? '2025-06-18';
}

function mcpAuthorized(request, url) {
  if (authorized(request)) return true;
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  if (oauth.validateAccessToken(bearer)) return true;
  if (!config.mcp.pathToken || !url.pathname.startsWith('/mcp/')) return false;
  const supplied = decodeURIComponent(url.pathname.slice('/mcp/'.length));
  return safeEqual(supplied, config.mcp.pathToken);
}

async function body(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error('request body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function sendMcp(response, status, value, extraHeaders = {}) {
  const headers = {
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  if (value == null) {
    response.writeHead(status, headers);
    return response.end();
  }
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  return response.end(JSON.stringify(value));
}

async function createContextEnvelope({
  sessionId,
  mode = 'session_start',
  maxTokens = config.context.defaultMaxTokens,
  force = false,
  now = new Date(),
}) {
  let state = await store.read();
  const delivery = contextDeliveryState(state, sessionId, mode, now, config.context.handoffOnceHours);
  let ombreText = '';
  let ombreWarning = '';
  if (
    mode === 'session_start'
    && (!delivery.alreadyDelivered || force)
    && config.context.ombreEnabled
    && config.ombre.readEnabled
  ) {
    try {
      ombreText = await ombre.recentContinuityMaterial(config.context.ombreMaxTokens);
    } catch (error) {
      ombreWarning = 'ombre_unavailable';
      log('context_ombre_read_failed', { message: error.message });
    }
  }
  const baseEnvelope = buildContextEnvelope({
    state,
    sessionId,
    mode,
    ombreText,
    maxTokens,
    ttlMinutes: config.context.ttlMinutes,
    now,
    alreadyDelivered: delivery.alreadyDelivered,
    force,
  });
  let envelope = baseEnvelope;
  if (baseEnvelope.delivered && mode === 'session_start') {
    if (config.memoryV1.enabled && config.memoryV1.contextEnabled) {
      const composition = await composeMemoryV1Context(baseEnvelope, {
        sessionId,
        now,
        maxTokens,
        formal: true,
      });
      envelope = promoteShadowContextCandidate(baseEnvelope, composition);
    } else if (config.memoryV1.enabled && config.memoryV1.shadowEnabled && config.memoryV1.shadowContextEnabled) {
      void composeMemoryV1Context(baseEnvelope, { sessionId, now, maxTokens });
    } else {
      void observeMemoryV1('recentContinuityMaterial', {
        dedupeKey: `context:${sessionId}`,
        now,
        maxTokens: config.context.ombreMaxTokens,
      });
    }
  }
  if (envelope.delivered) {
    state = await updateState({
      type: 'context_delivery',
      source: 'context-adapter',
      sessionId,
      details: {
        delivered: true,
        force,
        mode,
        ombreIncluded: Boolean(ombreText),
        estimatedTokens: envelope.estimatedTokens,
        sectionCount: envelope.sections.length,
      },
      at: now,
    }, (current) => recordContextDelivery(current, {
      sessionId,
      mode,
      digest: envelope.digest,
      deliveredAt: now,
    }));
  }
  try {
    await journal.recordContext({
      mode,
      sessionId,
      digest: envelope.digest,
      estimatedTokens: envelope.estimatedTokens,
      sectionCount: envelope.sections.length,
      delivered: envelope.delivered,
      alreadyDelivered: envelope.alreadyDelivered,
      ombreIncluded: Boolean(ombreText),
      at: now,
    });
  } catch (error) {
    log('context_audit_failed', { message: error.message });
  }
  return ombreWarning ? { ...envelope, warnings: [ombreWarning] } : envelope;
}

async function recordConversationEvent(event, source = 'api', now = new Date()) {
  let applied;
  const auditDetails = {};
  const state = await updateState({
    type: source === 'heartbeat' ? 'conversation_heartbeat' : 'conversation_event',
    source: source === 'mcp' ? 'mcp' : 'api',
    sessionId: event.sessionId ?? event.session_id,
    eventId: auditEventFingerprint(event.eventId ?? event.event_id),
    details: auditDetails,
    at: now,
  }, (current) => {
    applied = settleAndApplyConversationEvent(current, event, now, {
      sleepAfterMinutes: config.sleepAfterMinutes,
      settle: config.settle,
      interaction: config.interaction,
    });
    Object.assign(auditDetails, {
      changed: applied.changed,
      duplicate: applied.duplicate,
      interactionApplied: applied.interaction?.applied,
      reasonCode: applied.interaction?.reasonCode,
      settledHours: Number(applied.settled.elapsedHours.toFixed(4)),
    });
    return applied.state;
  });
  await registerRealEventForAppraisal(event, source, state, now);
  return {
    revision: state.revision,
    consciousness: state.consciousness,
    pendingAwareness: state.pendingAwareness,
    sessionId: applied.sessionId || null,
    sessionCreated: applied.sessionCreated,
    duplicate: applied.duplicate,
    interaction: applied.interaction,
    settledHours: Number(applied.settled.elapsedHours.toFixed(4)),
  };
}

async function saveHandoffNote(note, source = 'mcp', now = new Date()) {
  let applied;
  const state = await updateState({
    type: 'handoff_note',
    source,
    sessionId: note.sessionId,
    eventId: auditEventFingerprint(note.eventId),
    details: {
      noteLength: String(note.note ?? '').length,
      ttlHours: note.ttlHours,
    },
    at: now,
  }, (current) => {
    applied = recordHandoffNote(current, { ...note, now });
    return applied.state;
  });
  return {
    revision: state.revision,
    duplicate: applied.duplicate,
    noteLength: applied.noteLength,
  };
}

function handoffNoteFromHttp(payload = {}) {
  return {
    sessionId: payload.sessionId ?? payload.session_id,
    eventId: payload.eventId ?? payload.event_id,
    note: payload.note,
    ttlHours: payload.ttlHours ?? payload.ttl_hours,
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      return send(response, 200, {
        ok: true,
        system: 'xinchao-dynamic-mind',
        mode: config.shadowMode ? 'shadow' : 'active',
        version: SYSTEM_VERSION,
      });
    }
    if (await oauth.handle(request, response, url)) return;
    if (config.mcp.enabled && mcpPath(url)) {
      if (!mcpAuthorized(request, url)) {
        if (oauth.enabled) response.setHeader('WWW-Authenticate', oauth.wwwAuthenticate());
        return sendMcp(response, 401, { error: 'unauthorized' });
      }
      if (request.method === 'DELETE') {
        return sendMcp(response, 204, null, {
          'Mcp-Session-Id': transportSessionId(request),
          'MCP-Protocol-Version': '2025-06-18',
        });
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST, DELETE');
        return sendMcp(response, 405, { error: 'method not allowed' });
      }
      const payload = await body(request);
      const sessionId = transportSessionId(request, payload?.method === 'initialize');
      const result = await handleMcpMessage(payload, {
        defaultSessionId: sessionId,
        triggerPolicy: config.chatgptTrigger,
        context: async (args) => {
          if (!config.context.enabled) throw new Error('心潮 Context Envelope 当前未启用');
          return createContextEnvelope(args);
        },
        event: async (event) => {
          const result = await recordConversationEvent(event, 'mcp');
          return {
            revision: result.revision,
            consciousness: result.consciousness,
            sessionId: result.sessionId,
            sessionCreated: result.sessionCreated,
            duplicate: result.duplicate,
            interaction: result.interaction,
            settledHours: result.settledHours,
          };
        },
        handoffNote: async (note) => saveHandoffNote(note, 'mcp'),
        appraisal: appraisalEnabled
          ? async (operation) => recordAppraisalOperation(operation)
          : undefined,
        openLoop: openLoopEnabled
          ? async (operation) => recordOpenLoopOperation(operation)
          : undefined,
      });
      if (payload?.method === 'initialize' || payload?.method === 'tools/call') {
        log('mcp_request', {
          method: payload.method,
          tool: payload?.params?.name ? String(payload.params.name).slice(0, 80) : undefined,
          session: auditEventFingerprint(sessionId),
          status: result.status,
        });
      }
      return sendMcp(response, result.status, result.body, {
        'Mcp-Session-Id': sessionId,
        'MCP-Protocol-Version': negotiatedProtocolVersion(request, payload, result),
      });
    }
    if (!authorized(request)) return send(response, 401, { error: 'unauthorized' });

    if (request.method === 'GET' && url.pathname === '/v1/state') {
      return send(response, 200, await store.read());
    }
    if (request.method === 'GET' && url.pathname === '/v1/breath-context') {
      const state = await store.read();
      return send(response, 200, {
        ...breathDreamContext(state, new Date()),
        generatedAt: new Date().toISOString(),
      });
    }
    if (request.method === 'GET' && url.pathname === '/v1/context') {
      if (!config.context.enabled) return send(response, 503, { error: 'context envelope disabled' });
      const now = new Date();
      const sessionId = String(url.searchParams.get('session_id') ?? 'default').trim().slice(0, 120) || 'default';
      const requestedMode = String(url.searchParams.get('mode') ?? 'session_start').trim().toLowerCase();
      const mode = ['session_start', 'turn', 'inspect'].includes(requestedMode) ? requestedMode : 'session_start';
      const force = ['1', 'true', 'yes', 'on'].includes(String(url.searchParams.get('force') ?? '').toLowerCase());
      const maxTokens = Number(url.searchParams.get('max_tokens') ?? config.context.defaultMaxTokens);
      return send(response, 200, await createContextEnvelope({
        sessionId,
        mode,
        maxTokens,
        force,
        now,
      }));
    }
    if (request.method === 'GET' && url.pathname === '/v1/intent') {
      const state = await store.read();
      const intent = pickIntent(state);
      return send(response, 200, { intent, topDrives: topDrives(state), thoughtPool: state.thoughtPool ?? null, fatigue: state.fatigue ?? 0 });
    }
    if (request.method === 'POST' && url.pathname === '/v1/settle') {
      const result = await runCycle();
      return send(response, 200, { revision: result.state.revision, consciousness: result.state.consciousness, dreamCreated: result.dreamCreated, barkSent: result.barkSent, daytimeSent: result.daytimeSent });
    }
    if (request.method === 'POST' && (url.pathname === '/v1/conversation-event' || url.pathname === '/v1/heartbeat')) {
      const event = await body(request);
      const source = url.pathname === '/v1/heartbeat' ? 'heartbeat' : 'api';
      return send(response, 200, await recordConversationEvent(event, source));
    }
    if (request.method === 'POST' && url.pathname === '/v1/handoff-note') {
      const payload = await body(request);
      return send(response, 200, await saveHandoffNote(handoffNoteFromHttp(payload), 'api'));
    }
    if (request.method === 'POST' && url.pathname === '/v1/drive-feedback') {
      const payload = await body(request);
      const now = new Date();
      const state = await updateState({
        type: 'drive_feedback',
        source: 'api',
        eventId: payload.eventId ?? payload.event_id,
        at: now,
      }, (current) => applyDriveFeedback(current, payload.driveDeltas ?? {}, now));
      return send(response, 200, { revision: state.revision, topDrives: topDrives(state) });
    }
    return send(response, 404, { error: 'not found' });
  } catch (error) {
    log('request_failed', { message: error.message });
    return send(response, 400, { error: error.message });
  }
});

server.listen(config.port, '127.0.0.1', async () => {
  await store.read();
  if (config.mindV2.storeEnabled) {
    const result = await mindV2Store.initialize();
    log('mind_v2_store_status', {
      status: result.status,
      digest: result.digest,
      errorCode: result.errorCode,
    });
    if (appraisalEnabled && result.state) {
      try {
        let migration;
        const migrated = await mindV2Store.update((mindState) => {
          migration = initializeAppraisalState(mindState, new Date());
          return migration.state;
        });
        log('mind_v2_appraisal_status', {
          status: migration.changed ? 'migrated' : 'ready',
          revision: migrated.revision,
          appraisalCount: migrated.appraisals.length,
          errorCode: null,
        });
        await settleMindV2Appraisals(new Date());
      } catch (error) {
        log('mind_v2_appraisal_status', {
          status: 'omitted',
          errorCode: mindV2ErrorCode(error),
        });
      }
    }
    if (openLoopEnabled && result.state) {
      try {
        let migration;
        const migrated = await mindV2Store.update((mindState) => {
          migration = initializeOpenLoopState(mindState, new Date());
          return migration.state;
        });
        log('mind_v2_open_loop_status', {
          status: migration.changed ? 'migrated' : 'ready',
          revision: migrated.revision,
          openLoopCount: migrated.openLoops.length,
          errorCode: null,
        });
        await settleMindV2OpenLoops(new Date());
      } catch (error) {
        log('mind_v2_open_loop_status', {
          status: 'omitted',
          errorCode: openLoopErrorCode(error),
        });
      }
    }
  }
  log('service_started', { port: config.port, shadow: config.shadowMode, modelEnabled: config.model.enabled, barkEnabled: config.bark.enabled });
});

const timer = setInterval(() => runCycle().catch((error) => log('cycle_failed', { message: error.message })), config.settleIntervalMinutes * 60_000);
timer.unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
