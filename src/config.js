function bool(name, fallback = false) {
  const raw = process.env[name];
  return raw == null ? fallback : ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function number(name, fallback, min, max) {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric`);
  return Math.max(min, Math.min(max, parsed));
}

export function loadConfig() {
  const agentName = process.env.AGENT_NAME ?? 'AI 助手';
  const notificationRecipient = process.env.NOTIFICATION_RECIPIENT ?? '用户';
  return {
    identity: { agentName, notificationRecipient },
    port: number('PORT', 18110, 1, 65535),
    serviceToken: process.env.SERVICE_TOKEN ?? '',
    statePath: process.env.STATE_PATH ?? '/app/state/state.json',
    journalPath: process.env.TRANSITION_JOURNAL_PATH ?? '/app/state/transitions.jsonl',
    mindV2: {
      storeEnabled: bool('MIND_V2_STORE_ENABLED', false),
      statePath: process.env.MIND_V2_STATE_PATH ?? '/var/lib/xinchao-chatgpt/mind-v2-state.json',
      appraisalsEnabled: bool('MIND_V2_APPRAISALS_ENABLED', false),
      openLoopsEnabled: bool('MIND_V2_OPEN_LOOPS_ENABLED', false),
      resonanceEnabled: bool('MIND_V2_RESONANCE_ENABLED', false),
    },
    settleIntervalMinutes: number('SETTLE_INTERVAL_MINUTES', 15, 1, 1440),
    sleepAfterMinutes: number('SLEEP_AFTER_MINUTES', 90, 5, 10080),
    shadowMode: bool('SHADOW_MODE', true),
    model: {
      enabled: bool('MODEL_ENABLED', false),
      baseUrl: (process.env.MODEL_BASE_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, ''),
      apiKey: process.env.MODEL_API_KEY ?? '',
      name: process.env.MODEL_NAME ?? 'local-model',
      timeoutMs: number('MODEL_TIMEOUT_MS', 30000, 1000, 120000),
      maxInputChars: number('MODEL_MAX_INPUT_CHARS', 10000, 1000, 50000),
      maxOutputTokens: number('MODEL_MAX_OUTPUT_TOKENS', 650, 100, 4000),
      dreamPushPromptPath: process.env.DREAM_PUSH_PROMPT_PATH ?? '/app/configs/dream_push_prompt.md',
      agentName,
      notificationRecipient,
    },
    dreamMinIntervalHours: number('DREAM_MIN_INTERVAL_HOURS', 6, 1, 168),
    dreamMaxPerDay: number('DREAM_MAX_PER_DAY', 4, 1, 12),
    ombre: {
      url: process.env.OMBRE_MCP_URL ?? '',
      token: process.env.OMBRE_MCP_TOKEN ?? '',
      readEnabled: bool('OMBRE_READ_ENABLED', false),
      writeEnabled: bool('OMBRE_WRITE_ENABLED', false),
      breathMaxResults: number('OMBRE_BREATH_MAX_RESULTS', 3, 1, 10),
      breathMaxTokens: number('OMBRE_BREATH_MAX_TOKENS', 800, 200, 3000)
    },
    memoryV1: {
      enabled: bool('MEMORY_V1_ENABLED', false),
      shadowEnabled: bool('MEMORY_V1_SHADOW_ENABLED', false),
      url: process.env.MEMORY_V1_MCP_URL ?? '',
      token: process.env.MEMORY_V1_MCP_TOKEN ?? '',
      timeoutMs: number('MEMORY_V1_TIMEOUT_MS', 8000, 500, 30000),
      maxResults: number('MEMORY_V1_MAX_RESULTS', 6, 1, 12),
      maxTokens: number('MEMORY_V1_MAX_TOKENS', 900, 200, 3000),
      detailFetches: number('MEMORY_V1_DETAIL_FETCHES', 1, 0, 3),
      continuityDays: number('MEMORY_V1_CONTINUITY_DAYS', 30, 1, 365),
      dedupeTtlMinutes: number('MEMORY_V1_DEDUPE_TTL_MINUTES', 30, 1, 1440),
      shadowContextEnabled: bool('MEMORY_V1_SHADOW_CONTEXT_ENABLED', false),
      contextEnabled: bool('MEMORY_V1_CONTEXT_ENABLED', false),
      shadowContextMaxTokens: number('MEMORY_V1_SHADOW_CONTEXT_MAX_TOKENS', 2200, 200, 4000),
      shadowContextMemoryMaxTokens: number('MEMORY_V1_SHADOW_CONTEXT_MEMORY_MAX_TOKENS', 120, 40, 600),
      shadowContextMemoryMaxRatio: number('MEMORY_V1_SHADOW_CONTEXT_MEMORY_MAX_RATIO', 0.5, 0.05, 0.6),
      shadowContextMaxReferences: number('MEMORY_V1_SHADOW_CONTEXT_MAX_REFERENCES', 3, 1, 8),
      shadowContextPerMemoryMaxTokens: number('MEMORY_V1_SHADOW_CONTEXT_PER_MEMORY_MAX_TOKENS', 55, 40, 300),
    },
    context: {
      enabled: bool('CONTEXT_ENVELOPE_ENABLED', true),
      ombreEnabled: bool('CONTEXT_OMBRE_ENABLED', false),
      // This budget only carries short-lived state and recent continuity.
      // Stable identity/core instructions are loaded separately by the client
      // and must never be squeezed into this short-lived envelope.
      defaultMaxTokens: number('CONTEXT_DEFAULT_MAX_TOKENS', 2200, 200, 4000),
      ombreMaxTokens: number('CONTEXT_OMBRE_MAX_TOKENS', 1600, 200, 3000),
      ttlMinutes: number('CONTEXT_TTL_MINUTES', 15, 1, 180),
      handoffOnceHours: number('CONTEXT_HANDOFF_ONCE_HOURS', 12, 1, 168),
    },
    mcp: {
      enabled: bool('MCP_ENABLED', false),
      pathToken: process.env.MCP_PATH_TOKEN ?? '',
    },
    oauth: {
      enabled: bool('OAUTH_ENABLED', false),
      publicBaseUrl: (process.env.OAUTH_PUBLIC_BASE_URL ?? '').replace(/\/$/, ''),
      approvalToken: process.env.OAUTH_APPROVAL_TOKEN ?? '',
      statePath: process.env.OAUTH_STATE_PATH ?? '/app/state/oauth.json',
      accessTtlSeconds: number('OAUTH_ACCESS_TTL_SECONDS', 86400, 300, 2592000),
      refreshTtlSeconds: number('OAUTH_REFRESH_TTL_SECONDS', 31536000, 86400, 63072000),
    },
    interaction: {
      maxEffectsPerDay: number('INTERACTION_MAX_EFFECTS_PER_DAY', 24, 1, 96),
      timeZone: process.env.INTERACTION_TIME_ZONE ?? process.env.SETTLE_TIME_ZONE ?? 'Asia/Shanghai',
    },
    chatgptTrigger: {
      enabled: bool('CHATGPT_TRIGGER_POLICY_ENABLED', false),
      contextLongGapHours: number('CHATGPT_TRIGGER_CONTEXT_LONG_GAP_HOURS', 6, 1, 72),
    },
    heartbeat: {
      filePath: process.env.OMBRE_HEARTBEAT_FILE ?? '/memory-data/heartbeat.json',
      // Dream residue may be shared after a shorter quiet period. Autonomous
      // contact stays on the stricter, long-absence threshold below.
      dreamMinIdleHours: number('BARK_DREAM_MIN_CONTACT_IDLE_HOURS', 3, 1, 24),
      proactiveMinIdleHours: number('BARK_MIN_CONTACT_IDLE_HOURS', 12, 1, 720)
    },
    bark: {
      enabled: bool('BARK_ENABLED', false),
      key: process.env.BARK_KEY ?? '',
      server: (process.env.BARK_SERVER ?? 'https://api.day.app').replace(/\/$/, ''),
      title: process.env.BARK_TITLE ?? agentName,
      group: process.env.BARK_GROUP ?? 'xinchao',
      icon: process.env.BARK_ICON ?? '',
      sound: process.env.BARK_SOUND ?? 'silence',
      level: process.env.BARK_LEVEL ?? 'timeSensitive',
      minIntervalHours: number('BARK_MIN_INTERVAL_HOURS', 3, 1, 168),
      autonomousMinIntervalHours: number('BARK_AUTONOMOUS_MIN_INTERVAL_HOURS', 12, 1, 720),
      maxPerDay: number('BARK_MAX_PER_DAY', 6, 1, 24),
      minDrive: number('BARK_MIN_DRIVE', 0.42, 0.05, 1)
    },
    settle: {
      timeZone: process.env.SETTLE_TIME_ZONE ?? process.env.DAYTIME_TIME_ZONE ?? 'Asia/Shanghai',
      dawnFreezeStart: number('DAWN_FREEZE_START', 1, 0, 12),
      dawnFreezeEnd: number('DAWN_FREEZE_END', 8, 1, 12),
    },
    daytime: {
      enabled: bool('DAYTIME_EMERGENCE_ENABLED', false),
      timeZone: process.env.DAYTIME_TIME_ZONE ?? 'Asia/Shanghai',
      startHour: number('DAYTIME_START_HOUR', 8, 0, 23),
      endHour: number('DAYTIME_END_HOUR', 23, 1, 24),
      minIntervalHours: number('DAYTIME_MIN_INTERVAL_HOURS', 2, 0.25, 24),
      maxIntervalHours: number('DAYTIME_MAX_INTERVAL_HOURS', 3, 0.25, 24),
      maxPerDay: number('DAYTIME_MAX_PER_DAY', 7, 1, 24)
    }
  };
}

export function validateConfig(config) {
  const externalMemoryEnabled = Boolean(
    config.ombre.readEnabled
    || config.ombre.writeEnabled
    || config.context.ombreEnabled
  );
  if (externalMemoryEnabled) {
    if (!String(config.ombre.url || '').trim()) {
      throw new Error(
        'OMBRE_MCP_URL is required when external memory integration is enabled'
      );
    }
    if (!String(config.ombre.token || '').trim()) {
      throw new Error(
        'OMBRE_MCP_TOKEN is required when external memory integration is enabled'
      );
    }
  }
  if (config.memoryV1?.enabled && !String(config.memoryV1.url || '').trim()) {
    throw new Error('MEMORY_V1_MCP_URL is required when Memory V1 is enabled');
  }
  if (config.mindV2?.appraisalsEnabled && !config.mindV2?.storeEnabled) {
    throw new Error('MIND_V2_STORE_ENABLED is required when Appraisal is enabled');
  }
  if (config.mindV2?.openLoopsEnabled || config.mindV2?.resonanceEnabled) {
    throw new Error('Open Loop and Resonance are not implemented in this release');
  }
  return config;
}

export function validateServiceToken(value) {
  const token = String(value ?? '');
  if (!token) throw new Error('SERVICE_TOKEN is required');
  if (/^replace-with/i.test(token)) {
    throw new Error(
      'SERVICE_TOKEN is still the placeholder from .env.example — generate a real one: openssl rand -hex 32',
    );
  }
  if (token.length < 32) {
    throw new Error('SERVICE_TOKEN must be at least 32 characters — generate one: openssl rand -hex 32');
  }
  return token;
}
