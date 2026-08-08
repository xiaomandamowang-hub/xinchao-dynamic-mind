import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildContextEnvelope } from '../src/context-envelope.js';
import { recordHandoffNote } from '../src/handoff-notes.js';
import { MemoryV1Client } from '../src/memory-client.js';
import { ShadowContextCompositionRunner } from '../src/shadow-context-composer.js';

const config = loadConfig();
if (!config.memoryV1.url) throw new Error('MEMORY_V1_MCP_URL is required');
const outputPath = resolve(process.env.SHADOW_CONTEXT_REPORT_PATH ?? '/var/lib/xinchao-chatgpt/reports/mind-phase2-shadow-context.json');
const markdownPath = outputPath.replace(/\.json$/i, '.md');
const state = JSON.parse(await readFile(config.statePath, 'utf8'));
const now = new Date();
const client = new MemoryV1Client(config.memoryV1);

const scenarios = [
  {
    id: 'ordinary-chat',
    label: '普通闲聊',
    topicHint: '今天随便聊聊日常心情，没有需要继续的项目',
    clearHandoff: true,
  },
  {
    id: 'project-continuity',
    label: '连续项目讨论',
    topicHint: '继续讨论 Memory V1、Ombre Brain 和心潮 Context Adapter 项目',
    handoff: '正在继续 Memory V1 与心潮只读 Context Adapter 的阶段工作。',
  },
  {
    id: 'cross-day',
    label: '跨窗口或跨日继续话题',
    topicHint: '继续昨天没有完成的记忆系统与部署验证',
    handoff: '跨日继续昨天未完成的记忆系统部署验证。',
  },
  {
    id: 'relationship-preference',
    label: '关系与稳定偏好',
    topicHint: '沟通方式、称呼、边界、关系连续性和稳定偏好',
    clearHandoff: true,
  },
  {
    id: 'multi-memory',
    label: '多条相关长期记忆',
    topicHint: '分别回顾记忆仓库与心潮项目，以及长期陪伴关系与沟通边界',
    clearHandoff: true,
  },
  {
    id: 'handoff-memory-overlap',
    label: 'handoff 与长期 Memory 同时存在',
    topicHint: 'Memory V1 心潮只读 Adapter 与 Shadow Context',
    handoff: 'Memory V1 心潮只读 Adapter 已完成，当前验证 Shadow Context Composition。',
  },
  {
    id: 'dream-residue',
    label: '有 dream residue 的场景',
    topicHint: '最近共同经历、关系连续性和仍在意的事情',
    clearHandoff: true,
  },
  {
    id: 'no-related-memory',
    label: '没有相关长期记忆',
    topicHint: '南极深海火山玻璃收藏计划与陌生卫星编号',
    clearHandoff: true,
  },
  {
    id: 'memory-unavailable',
    label: 'Memory MCP 故障',
    topicHint: '故障降级验证',
    clearHandoff: true,
    failMemory: true,
  },
];

function scenarioState(definition) {
  let copy = structuredClone(state);
  if (definition.clearHandoff) copy.handoffNotes = [];
  if (definition.handoff) {
    copy = recordHandoffNote(copy, {
      sessionId: `eval-${definition.id}`,
      eventId: `eval-${definition.id}`,
      note: definition.handoff,
      ttlHours: 24,
      now,
    }).state;
  }
  return copy;
}

function reportScenario(definition, formal, result) {
  const formalTokens = Object.fromEntries(formal.sections.map((section) => [section.id, section.estimatedTokens]));
  const shadowTokens = result.diagnostic.sectionTokens;
  return {
    id: definition.id,
    label: definition.label,
    safeTopicHint: definition.topicHint,
    formal: {
      sections: formal.sections.map((section) => section.id),
      totalTokens: formal.estimatedTokens,
      sectionTokens: formalTokens,
      digest: formal.digest,
    },
    shadow: {
      sections: result.candidate.sections.map((section) => section.id),
      totalTokens: result.diagnostic.totalTokens,
      sectionTokens: shadowTokens,
      sectionShares: Object.fromEntries(Object.entries(shadowTokens).map(([key, value]) => [
        key,
        result.diagnostic.totalTokens ? Number((value / result.diagnostic.totalTokens).toFixed(4)) : 0,
      ])),
      memoryReferenceCount: result.diagnostic.memoryReferenceCount,
      digest: result.diagnostic.digest,
      latencyMs: result.diagnostic.latencyMs,
      errorCode: result.diagnostic.errorCode,
      fallbackToFormal: result.candidate.fallbackToFormal,
    },
    quality: result.audit,
  };
}

const results = [];
for (const definition of scenarios) {
  const current = scenarioState(definition);
  const formal = buildContextEnvelope({
    state: current,
    sessionId: `eval-${definition.id}`,
    mode: 'session_start',
    maxTokens: config.context.defaultMaxTokens,
    now,
    force: true,
  });
  const scenarioClient = definition.failMemory
    ? { recentContinuityMaterial: async () => { throw new Error('simulated unavailable'); } }
    : client;
  const runner = new ShadowContextCompositionRunner(scenarioClient, {
    ttlMinutes: config.memoryV1.dedupeTtlMinutes,
    maxTokens: config.memoryV1.shadowContextMaxTokens,
    memoryMaxRatio: config.memoryV1.shadowContextMemoryMaxRatio,
    maxMemoryReferences: config.memoryV1.shadowContextMaxReferences,
    perMemoryMaxTokens: config.memoryV1.shadowContextPerMemoryMaxTokens,
  });
  const result = await runner.compose({
    baseEnvelope: formal,
    sessionId: `eval-${definition.id}`,
    topicHint: definition.topicHint,
    now,
  });
  results.push(reportScenario(definition, formal, result));
}

const duplicateFormal = buildContextEnvelope({
  state: scenarioState({ clearHandoff: true }),
  sessionId: 'eval-duplicate-session',
  mode: 'session_start',
  maxTokens: config.context.defaultMaxTokens,
  now,
  force: true,
});
let duplicateReads = 0;
const duplicateClient = {
  recentContinuityMaterial: async (options) => {
    duplicateReads += 1;
    return client.recentContinuityMaterial(options);
  },
  recentMaterial: (options) => client.recentMaterial(options),
};
const duplicateRunner = new ShadowContextCompositionRunner(duplicateClient, {
  ttlMinutes: config.memoryV1.dedupeTtlMinutes,
  maxTokens: config.memoryV1.shadowContextMaxTokens,
  memoryMaxRatio: config.memoryV1.shadowContextMemoryMaxRatio,
  maxMemoryReferences: config.memoryV1.shadowContextMaxReferences,
  perMemoryMaxTokens: config.memoryV1.shadowContextPerMemoryMaxTokens,
});
await duplicateRunner.compose({ baseEnvelope: duplicateFormal, sessionId: 'eval-duplicate-session', now });
const duplicateResult = await duplicateRunner.compose({ baseEnvelope: duplicateFormal, sessionId: 'eval-duplicate-session', now });

const report = {
  generatedAt: now.toISOString(),
  system: 'xinchao-dynamic-mind',
  phase: 'Mind Phase 2 - Context Shadow Composition',
  runtimeDiagnosticsContainBodies: false,
  formalContextChanged: false,
  scenarios: results,
  duplicateSession: {
    memoryReads: duplicateReads,
    secondCallErrorCode: duplicateResult.diagnostic.errorCode,
  },
};

function bullet(items, empty = '无') {
  return items.length ? items.map((item) => `  - ${item}`).join('\n') : `  - ${empty}`;
}

const markdown = [
  '# Mind Phase 2 private Shadow Context quality report',
  '',
  `Generated: ${report.generatedAt}`,
  '',
  ...results.flatMap((item) => [
    `## ${item.label} (${item.id})`,
    '',
    `- Formal sections: ${item.formal.sections.join(' -> ')}`,
    `- Shadow sections: ${item.shadow.sections.join(' -> ')}`,
    `- Tokens: formal ${item.formal.totalTokens}, shadow ${item.shadow.totalTokens}`,
    `- Memory references: ${item.shadow.memoryReferenceCount}`,
    `- Fallback: ${item.shadow.fallbackToFormal ? 'yes' : 'no'}`,
    `- Error: ${item.shadow.errorCode ?? 'none'}`,
    '',
    'Selected Memory:',
    bullet(item.quality.selected.map((entry) => (
      `${entry.memoryId} | ${entry.reason} | tokens=${entry.renderedTokens} | truncated=${entry.truncated} | ${entry.renderedPreview}`
    ))),
    '',
    'Dropped Memory:',
    bullet(item.quality.dropped.map((entry) => (
      `${entry.memoryId || 'unknown'} | ${entry.reason} | ${entry.safeSummary || ''}`
    ))),
    '',
    'Potential overlaps/conflicts:',
    bullet(item.quality.overlaps.map((entry) => (
      `${entry.memoryId} vs ${entry.sectionId} | similarity=${entry.similarity} | conflict=${entry.potentialConflict}`
    ))),
    '',
  ]),
  '## Duplicate-session probe',
  '',
  `- Memory reads: ${report.duplicateSession.memoryReads}`,
  `- Second call: ${report.duplicateSession.secondCallErrorCode}`,
  '',
].join('\n');

await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await writeFile(markdownPath, markdown, { mode: 0o600 });
await chmod(outputPath, 0o600);
await chmod(markdownPath, 0o600);

console.log(JSON.stringify({
  ok: true,
  reportPath: outputPath,
  markdownPath,
  scenarioCount: results.length,
  totals: results.map((item) => ({
    id: item.id,
    formalTokens: item.formal.totalTokens,
    shadowTokens: item.shadow.totalTokens,
    memoryReferences: item.shadow.memoryReferenceCount,
    fallback: item.shadow.fallbackToFormal,
    errorCode: item.shadow.errorCode,
  })),
  duplicateSession: report.duplicateSession,
}));
