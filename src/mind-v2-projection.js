import { estimateTokens, trimToTokenBudget } from './context-envelope.js';
import { resonanceEffectiveIntensity } from './memory-resonance.js';

export const MIND_V2_PROJECTION_MAX_TOKENS = 180;
export const MIND_V2_PROJECTION_LAYER_CAP = 3;

const DISCLAIMER = '以下内容只是沈归当前的主观理解、未完成牵引和记忆余波，不是客观事实，也不是新的 Memory 证据。当前用户消息、正式事实与带来源的 Memory 优先。';
const PRIORITY = Object.freeze({ high: 3, medium: 2, low: 1 });
const KIND = Object.freeze({ relationship: '关系事项', task: '任务', shared_plan: '共同计划' });

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function boundedText(value, tokens) {
  return trimToTokenBudget(compact(value), tokens);
}

function activeBefore(record, status, nowMs) {
  const expiresAt = Date.parse(record?.expiresAt ?? '');
  return record?.status === status && Number.isFinite(expiresAt) && expiresAt > nowMs;
}

function compareTimeDesc(left, right, ...fields) {
  for (const field of fields) {
    const delta = Date.parse(right?.[field] ?? '') - Date.parse(left?.[field] ?? '');
    if (Number.isFinite(delta) && delta !== 0) return delta;
  }
  return 0;
}

function appraisalLine(item) {
  const interpretation = boundedText(item.interpretation, 22);
  if (!interpretation) return '';
  const relation = boundedText(item.relationalMeaning, 12);
  return `当前主观理解/感受：${interpretation}${relation ? `；关系感受：${relation}` : ''}（不是客观事实）。`;
}

function loopLine(item) {
  const summary = boundedText(item.summary, 18);
  if (!summary) return '';
  const expectation = boundedText(item.expectation, 14);
  const kind = KIND[item.kind] ?? '未完成事项';
  return `仍未解决/仍想继续（${kind}）：${summary}${expectation ? `；期待：${expectation}` : ''}（期待不代表已发生）。`;
}

function resonanceLine(memory) {
  const content = boundedText(memory?.projectionText, 26);
  return content ? `最近回想起的记忆仍有余波：${content}（不作为新事实）。` : '';
}

function selectAppraisals(state, nowMs) {
  return (state.appraisals ?? [])
    .filter((item) => activeBefore(item, 'active', nowMs))
    .sort((left, right) => (
      (Number(right.relevance) || 0) - (Number(left.relevance) || 0)
      || compareTimeDesc(left, right, 'updatedAt', 'createdAt')
      || compact(left.subjectKey).localeCompare(compact(right.subjectKey))
    ))
    .slice(0, MIND_V2_PROJECTION_LAYER_CAP);
}

function selectOpenLoops(state, nowMs) {
  return (state.openLoops ?? [])
    .filter((item) => activeBefore(item, 'open', nowMs))
    .sort((left, right) => (
      (PRIORITY[right.priority] ?? 0) - (PRIORITY[left.priority] ?? 0)
      || Date.parse(left.expiresAt) - Date.parse(right.expiresAt)
      || compareTimeDesc(left, right, 'updatedAt', 'openedAt')
      || compact(left.loopKey).localeCompare(compact(right.loopKey))
    ))
    .slice(0, MIND_V2_PROJECTION_LAYER_CAP);
}

function selectResonance(state, now) {
  const nowMs = now.getTime();
  return (state.resonance ?? [])
    .filter((item) => {
      const expiresAt = Date.parse(item?.expiresAt ?? '');
      return Number.isFinite(expiresAt) && expiresAt > nowMs
        && resonanceEffectiveIntensity(item, now) > 0;
    })
    .sort((left, right) => (
      resonanceEffectiveIntensity(right, now) - resonanceEffectiveIntensity(left, now)
      || compareTimeDesc(left, right, 'lastRecalledAt')
      || compact(left.memoryId).localeCompare(compact(right.memoryId))
    ))
    .slice(0, MIND_V2_PROJECTION_LAYER_CAP);
}

function appendIfFits(selected, candidate, budget) {
  if (!candidate?.text) return false;
  const next = [DISCLAIMER, ...selected.map((item) => item.text), candidate.text].join('\n');
  if (estimateTokens(next) > budget) return false;
  selected.push(candidate);
  return true;
}

export async function buildMindV2Projection(state, {
  memoryClient,
  now = new Date(),
  maxTokens = MIND_V2_PROJECTION_MAX_TOKENS,
} = {}) {
  const generatedAt = new Date(now);
  const budget = Math.max(1, Math.min(MIND_V2_PROJECTION_MAX_TOKENS, Number(maxTokens) || 1));
  const candidates = {
    open_loop: selectOpenLoops(state, generatedAt.getTime())
      .map((item) => ({ layer: 'open_loop', text: loopLine(item) })),
    appraisal: selectAppraisals(state, generatedAt.getTime())
      .map((item) => ({ layer: 'appraisal', text: appraisalLine(item) })),
    resonance: [],
  };

  let lookupFailures = 0;
  for (const item of selectResonance(state, generatedAt)) {
    try {
      const memory = await memoryClient?.directProjectionMemory(item.memoryId);
      if (memory) candidates.resonance.push({ layer: 'resonance', text: resonanceLine(memory) });
    } catch {
      lookupFailures += 1;
    }
  }

  const selected = [];
  const layers = ['open_loop', 'appraisal', 'resonance'];
  // Give each populated layer one bounded slot, then spend remaining budget by frozen priority.
  for (const layer of layers) appendIfFits(selected, candidates[layer][0], budget);
  for (const layer of layers) {
    for (const candidate of candidates[layer].slice(1)) appendIfFits(selected, candidate, budget);
  }

  const text = selected.length ? [DISCLAIMER, ...selected.map((item) => item.text)].join('\n') : '';
  const counts = selected.reduce((result, item) => {
    result[item.layer] = (result[item.layer] ?? 0) + 1;
    return result;
  }, {});
  return {
    text,
    estimatedTokens: estimateTokens(text),
    diagnostic: {
      projectedCount: selected.length,
      tokenCount: estimateTokens(text),
      layerCount: Object.keys(counts).length,
      appraisalCount: counts.appraisal ?? 0,
      openLoopCount: counts.open_loop ?? 0,
      resonanceCount: counts.resonance ?? 0,
      lookupFailures,
    },
  };
}
