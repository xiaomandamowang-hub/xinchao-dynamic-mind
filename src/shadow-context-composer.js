import { createHash } from 'node:crypto';
import { estimateTokens, trimToTokenBudget } from './context-envelope.js';

const BASE_SECTION_IDS = new Set(['dynamic_state', 'handoff_notes', 'dream_residue']);
const ALLOWED_MEMORY_STATUSES = new Set(['active', 'contested']);
const STABLE_MEMORY_TYPES = new Set(['core', 'preferences', 'relationship']);
const GENERIC_TOPIC_UNITS = new Set([
  '今天', '昨天', '最近', '当前', '继续', '关于', '相关', '事情', '记忆', '系统',
  '项目', '讨论', '关系', '没有', '正在', '什么', '哪些', '我们', '聊天',
  '使用', '可以', '发现', '以后', '之前', '后来', '开始', '完成', '相关',
]);

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizedContent(value) {
  return compact(value)
    .replace(/^\[memory_id=[^\]]+\]\s*/i, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function lexicalUnits(value) {
  const text = compact(value)
    .replace(/^\[memory_id=[^\]]+\]\s*/i, '')
    .toLowerCase();
  const units = new Set();
  for (const word of text.match(/[a-z0-9_]{2,}/g) ?? []) units.add(word);
  const cjk = [...text].filter((char) => /[\p{Script=Han}]/u.test(char));
  for (let index = 0; index < cjk.length - 1; index += 1) {
    units.add(`${cjk[index]}${cjk[index + 1]}`);
  }
  if (cjk.length === 1) units.add(cjk[0]);
  return units;
}

function similarity(left, right) {
  const a = lexicalUnits(left);
  const b = lexicalUnits(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function hasTopicAnchor(content, topicHint, sourceType) {
  const contentUnits = lexicalUnits(content);
  const topicUnits = lexicalUnits(topicHint);
  let shared = 0;
  for (const unit of topicUnits) {
    if (GENERIC_TOPIC_UNITS.has(unit)) continue;
    if (!contentUnits.has(unit)) continue;
    if (/^[a-z0-9_]{2,}$/.test(unit)) return true;
    shared += 1;
  }
  return STABLE_MEMORY_TYPES.has(sourceType) ? shared >= 1 : shared >= 2;
}

function explicitMemoryOptOut(topicHint) {
  const text = compact(topicHint);
  if (!text) return false;
  const noRecall = /(?:无需|不用|不需要|没有需要|不必).{0,8}(?:继续|回顾|记忆|项目|相关)/.test(text);
  return noRecall || /(?:随便|普通).{0,4}(?:聊聊|闲聊).{0,12}(?:无需|不用|没有需要|不需要)/.test(text);
}

function hasNegation(value) {
  return /(?:不|不是|没有|并非|取消|停止|never|not|no longer)/i.test(String(value ?? ''));
}

function ageDays(occurredAt, now) {
  const timestamp = Date.parse(occurredAt ?? '');
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (new Date(now).getTime() - timestamp) / 86_400_000);
}

function memoryMarker(provenance) {
  return [
    `memory:${provenance.memory_id}`,
    provenance.source_type || 'unknown',
    provenance.retrieval_tool || 'unknown',
    provenance.status || 'unknown',
    provenance.review_state || 'unreviewed',
  ].join('|');
}

function renderMemoryFragment(fragment, maxTokens, perMemoryMaxTokens) {
  const marker = `[${memoryMarker(fragment.provenance)}]`;
  const prefix = `${marker} ${compact(fragment.title || 'Memory').slice(0, 12)}: `;
  const prefixTokens = estimateTokens(prefix);
  const fragmentBudget = Math.min(maxTokens, Math.max(20, Number(perMemoryMaxTokens) || maxTokens));
  if (prefixTokens + 1 > fragmentBudget) return { text: '', truncated: false };
  const content = trimToTokenBudget(fragment.content, fragmentBudget - prefixTokens);
  return {
    text: content ? `${prefix}${content}` : '',
    truncated: Boolean(content) && content !== fragment.content,
  };
}

function formalFallback(baseEnvelope, errorCode, latencyMs) {
  return {
    candidate: {
      ...structuredClone(baseEnvelope),
      shadow: true,
      returnedToClient: false,
      fallbackToFormal: true,
    },
    diagnostic: {
      sectionCount: baseEnvelope.sections?.length ?? 0,
      totalTokens: baseEnvelope.estimatedTokens ?? 0,
      sectionTokens: Object.fromEntries((baseEnvelope.sections ?? []).map((section) => [
        section.id,
        section.estimatedTokens ?? estimateTokens(section.content),
      ])),
      memoryReferenceCount: 0,
      digest: baseEnvelope.digest,
      latencyMs,
      errorCode,
    },
    audit: {
      selected: [],
      dropped: [],
      overlaps: [],
      fallbackToFormal: true,
      errorCode,
    },
  };
}

function sanitizeFragment(fragment, origin) {
  const provenance = structuredClone(fragment?.provenance ?? {});
  return {
    origin,
    title: compact(fragment?.title || 'Memory'),
    content: compact(fragment?.content || fragment?.text),
    provenance,
  };
}

function statusDropReason(fragment) {
  const status = compact(fragment.provenance.status || 'unknown').toLowerCase();
  const review = compact(fragment.provenance.review_state || '').toLowerCase();
  if (status === 'superseded') return 'status_superseded';
  if (status === 'pending' || review === 'pending') return 'status_pending';
  if (status === 'historical') return 'status_historical';
  if (!ALLOWED_MEMORY_STATUSES.has(status)) return `status_${status || 'unknown'}`;
  return '';
}

function privateAuditEntry(fragment, reason, extra = {}) {
  return {
    memoryId: fragment.provenance.memory_id,
    sourceType: fragment.provenance.source_type,
    origin: fragment.origin,
    status: fragment.provenance.status,
    reviewState: fragment.provenance.review_state,
    safeSummary: compact(fragment.content).slice(0, 180),
    reason,
    ...extra,
  };
}

function selectMemoryFragments({ continuityMaterial, recentMaterial, baseSections, topicHint, now, maxReferences }) {
  const selected = [];
  const dropped = [];
  const overlaps = [];
  const seenIds = new Set();
  const handoffText = baseSections.find((section) => section.id === 'handoff_notes')?.content ?? '';
  const dreamText = baseSections.find((section) => section.id === 'dream_residue')?.content ?? '';
  const dynamicText = baseSections.find((section) => section.id === 'dynamic_state')?.content ?? '';
  const inputs = [
    ...(continuityMaterial?.fragments ?? []).map((item) => sanitizeFragment(item, 'recent_continuity')),
    ...(recentMaterial?.fragments ?? []).map((item) => sanitizeFragment(item, 'recent_material')),
  ];

  for (const fragment of inputs) {
    const id = compact(fragment.provenance.memory_id);
    if (!id) {
      dropped.push(privateAuditEntry(fragment, 'missing_memory_id'));
      continue;
    }
    if (seenIds.has(id)) {
      dropped.push(privateAuditEntry(fragment, 'duplicate_memory_id'));
      continue;
    }

    const statusReason = statusDropReason(fragment);
    if (statusReason) {
      dropped.push(privateAuditEntry(fragment, statusReason));
      seenIds.add(id);
      continue;
    }

    const supersedes = new Set(fragment.provenance.supersedes ?? []);
    const newerSelected = selected.find((item) => (item.provenance.supersedes ?? []).includes(id));
    if (newerSelected) {
      dropped.push(privateAuditEntry(fragment, 'superseded_by_selected', { relatedMemoryId: newerSelected.provenance.memory_id }));
      seenIds.add(id);
      continue;
    }
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      if (!supersedes.has(selected[index].provenance.memory_id)) continue;
      const [removed] = selected.splice(index, 1);
      dropped.push(privateAuditEntry(removed, 'superseded_by_selected', { relatedMemoryId: id }));
    }

    const age = ageDays(fragment.provenance.occurred_at, now);
    if (
      fragment.origin === 'recent_material'
      && age != null
      && age > 365
      && !STABLE_MEMORY_TYPES.has(fragment.provenance.source_type)
    ) {
      dropped.push(privateAuditEntry(fragment, 'stale_recent_material', { ageDays: Number(age.toFixed(1)) }));
      seenIds.add(id);
      continue;
    }

    if (compact(topicHint)) {
      if (!hasTopicAnchor(fragment.content, topicHint, fragment.provenance.source_type)) {
        dropped.push(privateAuditEntry(fragment, 'low_topic_relevance'));
        seenIds.add(id);
        continue;
      }
    }

    const handoffSimilarity = similarity(fragment.content, handoffText);
    if (handoffText && handoffSimilarity >= 0.62) {
      dropped.push(privateAuditEntry(fragment, 'duplicate_of_handoff', { similarity: Number(handoffSimilarity.toFixed(3)) }));
      seenIds.add(id);
      continue;
    }

    const duplicate = selected.find((item) => similarity(fragment.content, item.content) >= 0.9);
    if (duplicate) {
      dropped.push(privateAuditEntry(fragment, 'near_duplicate_memory', { relatedMemoryId: duplicate.provenance.memory_id }));
      seenIds.add(id);
      continue;
    }

    const dreamSimilarity = similarity(fragment.content, dreamText);
    if (dreamText && dreamSimilarity >= 0.35) {
      overlaps.push({
        memoryId: id,
        sectionId: 'dream_residue',
        similarity: Number(dreamSimilarity.toFixed(3)),
        potentialConflict: hasNegation(fragment.content) !== hasNegation(dreamText),
      });
    }
    const dynamicSimilarity = similarity(fragment.content, dynamicText);
    if (dynamicText && dynamicSimilarity >= 0.35) {
      overlaps.push({
        memoryId: id,
        sectionId: 'dynamic_state',
        similarity: Number(dynamicSimilarity.toFixed(3)),
        potentialConflict: hasNegation(fragment.content) !== hasNegation(dynamicText),
      });
    }

    selected.push(fragment);
    seenIds.add(id);
  }

  while (selected.length > maxReferences) {
    const removed = selected.pop();
    dropped.push(privateAuditEntry(removed, 'reference_limit'));
  }

  return { selected, dropped, overlaps };
}

function renderMemoryGroup(fragments, tokenBudget, dropped, perMemoryMaxTokens) {
  const rendered = [];
  let remaining = Math.max(0, Number(tokenBudget) || 0);
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index];
    const separatorTokens = rendered.length ? 1 : 0;
    const fitted = renderMemoryFragment(fragment, remaining - separatorTokens, perMemoryMaxTokens);
    if (!fitted.text) {
      dropped.push(privateAuditEntry(fragment, 'token_budget'));
      continue;
    }
    rendered.push({ fragment, text: fitted.text });
    remaining -= estimateTokens(fitted.text) + separatorTokens;
  }
  return {
    rendered,
    text: rendered.map((item) => item.text).join('\n'),
    usedTokens: rendered.reduce((sum, item) => sum + estimateTokens(item.text), 0) + Math.max(0, rendered.length - 1),
  };
}

export function composeShadowContextCandidate({
  baseEnvelope,
  continuityMaterial,
  recentMaterial = null,
  maxTokens = 2200,
  memoryMaxRatio = 0.5,
  maxMemoryReferences = 3,
  perMemoryMaxTokens = 55,
  topicHint = '',
  now = new Date(),
}) {
  const tokenBudget = Math.max(200, Math.min(4000, Number(maxTokens) || 2200));
  const baseSections = (baseEnvelope.sections ?? [])
    .filter((section) => BASE_SECTION_IDS.has(section.id))
    .map((section) => structuredClone(section));
  const baseTokens = baseSections.reduce((sum, section) => (
    sum + estimateTokens(`[${section.id}]\n${section.content}`)
  ), 0) + Math.max(0, baseSections.length - 1) * 2;
  const remaining = Math.max(0, tokenBudget - baseTokens);
  const shareLimit = Math.max(0.05, Math.min(0.6, memoryMaxRatio));
  const memoryShareBudget = Math.floor(baseTokens * shareLimit / (1 - shareLimit));
  const memoryBudget = Math.max(0, Math.min(remaining, memoryShareBudget));
  const audit = selectMemoryFragments({
    continuityMaterial,
    recentMaterial,
    baseSections,
    topicHint,
    now,
    maxReferences: Math.max(1, Math.min(8, Number(maxMemoryReferences) || 3)),
  });
  const continuity = audit.selected.filter((item) => item.origin === 'recent_continuity');
  const recent = audit.selected.filter((item) => item.origin === 'recent_material');
  const potentialMemorySections = Number(continuity.length > 0) + Number(recent.length > 0);
  const memoryRenderReserve = (continuity.length ? estimateTokens('[recent_continuity]\n') : 0)
    + (recent.length ? estimateTokens('[recent_material]\n') : 0)
    + potentialMemorySections * 2;
  const memoryContentBudget = Math.max(0, memoryBudget - memoryRenderReserve);
  const continuityBudget = recent.length ? Math.floor(memoryContentBudget * 0.7) : memoryContentBudget;
  const renderedContinuity = renderMemoryGroup(continuity, continuityBudget, audit.dropped, perMemoryMaxTokens);
  const recentBudget = Math.max(0, memoryContentBudget - renderedContinuity.usedTokens);
  const renderedRecent = renderMemoryGroup(recent, recentBudget, audit.dropped, perMemoryMaxTokens);

  const memorySections = [];
  if (renderedContinuity.text) {
    memorySections.push({
      id: 'recent_continuity',
      source: 'memory-v1-shadow',
      ttl: 'session-start',
      content: renderedContinuity.text,
      estimatedTokens: estimateTokens(`[recent_continuity]\n${renderedContinuity.text}`),
    });
  }
  if (renderedRecent.text) {
    memorySections.push({
      id: 'recent_material',
      source: 'memory-v1-shadow',
      ttl: 'session-start',
      content: renderedRecent.text,
      estimatedTokens: estimateTokens(`[recent_material]\n${renderedRecent.text}`),
    });
  }


  if (!memorySections.length) {
    const sectionTokens = Object.fromEntries((baseEnvelope.sections ?? []).map((section) => [
      section.id,
      section.estimatedTokens ?? estimateTokens(section.content),
    ]));
    return {
      candidate: {
        ...structuredClone(baseEnvelope),
        shadow: true,
        returnedToClient: false,
        fallbackToFormal: false,
      },
      diagnostic: {
        sectionCount: baseEnvelope.sections?.length ?? 0,
        totalTokens: baseEnvelope.estimatedTokens ?? 0,
        sectionTokens,
        memoryReferenceCount: 0,
        digest: baseEnvelope.digest,
        latencyMs: 0,
        errorCode: null,
      },
      audit: {
        selected: [],
        dropped: audit.dropped,
        overlaps: audit.overlaps,
        baseSectionsPreserved: true,
        memoryBudget,
        memoryTokens: 0,
        memoryShareOfBudget: 0,
        memoryShareOfUsed: 0,
        fallbackToFormal: false,
      },
    };
  }

  const beforeDream = baseSections.filter((section) => section.id !== 'dream_residue');
  const dreams = baseSections.filter((section) => section.id === 'dream_residue');
  const sections = [...beforeDream, ...memorySections, ...dreams];
  const additionalContext = sections.map((section) => `[${section.id}]\n${section.content}`).join('\n\n');
  const totalTokens = estimateTokens(additionalContext);
  const digest = createHash('sha256').update(additionalContext, 'utf8').digest('hex').slice(0, 16);
  const renderedMemory = [...renderedContinuity.rendered, ...renderedRecent.rendered];
  const renderedIds = new Set(renderedMemory.map((item) => item.fragment.provenance.memory_id));
  for (const fragment of audit.selected) {
    if (!renderedIds.has(fragment.provenance.memory_id)) continue;
    const reason = fragment.provenance.status === 'contested'
      ? 'selected_contested_with_provenance'
      : fragment.origin === 'recent_continuity'
        ? 'selected_for_continuity'
        : 'selected_for_topic_material';
    fragment.selectionReason = reason;
  }

  const sectionTokens = Object.fromEntries(sections.map((section) => [
    section.id,
    estimateTokens(`[${section.id}]\n${section.content}`),
  ]));
  const memoryTokens = (sectionTokens.recent_continuity ?? 0) + (sectionTokens.recent_material ?? 0);
  return {
    candidate: {
      version: 1,
      system: baseEnvelope.system,
      mode: baseEnvelope.mode,
      sessionId: baseEnvelope.sessionId,
      generatedAt: baseEnvelope.generatedAt,
      expiresAt: baseEnvelope.expiresAt,
      delivered: false,
      shadow: true,
      returnedToClient: false,
      fallbackToFormal: false,
      sections,
      additionalContext,
      estimatedTokens: totalTokens,
      digest,
    },
    diagnostic: {
      sectionCount: sections.length,
      totalTokens,
      sectionTokens,
      memoryReferenceCount: renderedIds.size,
      digest,
      latencyMs: 0,
      errorCode: null,
    },
    audit: {
      selected: renderedMemory.map(({ fragment, text }) => privateAuditEntry(
        fragment,
        fragment.selectionReason,
        {
          ageDays: ageDays(fragment.provenance.occurred_at, now),
          renderedPreview: compact(text).slice(0, 180),
          renderedTokens: estimateTokens(text),
          truncated: !text.endsWith(fragment.content),
        },
      )),
      dropped: audit.dropped,
      overlaps: audit.overlaps,
      baseSectionsPreserved: baseSections.every((section) => (
        sections.find((candidate) => candidate.id === section.id)?.content === section.content
      )),
      memoryBudget,
      memoryTokens,
      memoryShareOfBudget: Number((memoryTokens / tokenBudget).toFixed(4)),
      memoryShareOfUsed: totalTokens ? Number((memoryTokens / totalTokens).toFixed(4)) : 0,
      fallbackToFormal: false,
    },
  };
}

function failureCode(error) {
  const message = String(error?.message ?? '').toLowerCase();
  if (message.includes('timeout') || error?.name === 'TimeoutError') return 'memory_timeout';
  return 'memory_unavailable';
}

export class ShadowContextCompositionRunner {
  constructor(client, {
    ttlMinutes = 30,
    maxEntries = 256,
    maxTokens = 2200,
    memoryMaxRatio = 0.5,
    maxMemoryReferences = 3,
    perMemoryMaxTokens = 55,
  } = {}) {
    this.client = client;
    this.ttlMs = Math.max(1, Number(ttlMinutes) || 30) * 60_000;
    this.maxEntries = Math.max(8, Number(maxEntries) || 256);
    this.maxTokens = maxTokens;
    this.memoryMaxRatio = memoryMaxRatio;
    this.maxMemoryReferences = maxMemoryReferences;
    this.perMemoryMaxTokens = perMemoryMaxTokens;
    this.deliveries = new Map();
  }

  async compose({ baseEnvelope, sessionId, now = new Date(), topicHint = '' }) {
    const started = performance.now();
    const timestamp = new Date(now).getTime();
    this.#prune(timestamp);
    const key = `context:${compact(sessionId || baseEnvelope.sessionId)}`;
    if (this.deliveries.has(key)) {
      return formalFallback(baseEnvelope, 'duplicate_session', Number((performance.now() - started).toFixed(1)));
    }
    this.deliveries.set(key, timestamp);
    try {
      if (explicitMemoryOptOut(topicHint)) {
        const result = composeShadowContextCandidate({
          baseEnvelope,
          continuityMaterial: { fragments: [], provenance: [] },
          recentMaterial: null,
          maxTokens: this.maxTokens,
          memoryMaxRatio: this.memoryMaxRatio,
          maxMemoryReferences: this.maxMemoryReferences,
          perMemoryMaxTokens: this.perMemoryMaxTokens,
          topicHint,
          now,
        });
        result.diagnostic.latencyMs = Number((performance.now() - started).toFixed(1));
        return result;
      }
      const continuityMaterial = await this.client.recentContinuityMaterial({ now });
      const handoffText = (baseEnvelope.sections ?? [])
        .find((section) => section.id === 'handoff_notes')?.content ?? '';
      const effectiveTopicHint = compact(topicHint) || compact(handoffText);
      const hasHandoff = Boolean(compact(handoffText));
      const needsRecentMaterial = Boolean(effectiveTopicHint)
        || hasHandoff
        || continuityMaterial.provenance.length < 2;
      const recentMaterial = needsRecentMaterial
        ? await this.client.recentMaterial({ query: effectiveTopicHint || undefined })
        : null;
      const result = composeShadowContextCandidate({
        baseEnvelope,
        continuityMaterial,
        recentMaterial,
        maxTokens: this.maxTokens,
        memoryMaxRatio: this.memoryMaxRatio,
        maxMemoryReferences: this.maxMemoryReferences,
        perMemoryMaxTokens: this.perMemoryMaxTokens,
        topicHint: effectiveTopicHint,
        now,
      });
      result.diagnostic.latencyMs = Number((performance.now() - started).toFixed(1));
      return result;
    } catch (error) {
      return formalFallback(baseEnvelope, failureCode(error), Number((performance.now() - started).toFixed(1)));
    }
  }

  #prune(now) {
    for (const [key, at] of this.deliveries) {
      if (now - at > this.ttlMs) this.deliveries.delete(key);
    }
    while (this.deliveries.size >= this.maxEntries) {
      this.deliveries.delete(this.deliveries.keys().next().value);
    }
  }
}
