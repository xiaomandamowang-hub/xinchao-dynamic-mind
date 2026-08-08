import { estimateTokens, trimToTokenBudget } from './context-envelope.js';

const READ_TOOLS = new Set(['surface', 'search', 'recall_timeline', 'fetch']);

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseMcpBody(text) {
  const body = String(text ?? '').trim();
  if (!body) return null;
  const events = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  return JSON.parse(events.at(-1) ?? body);
}

function structuredContent(response) {
  return response?.result?.structuredContent
    ?? response?.structuredContent
    ?? response?.result?.content?.find?.((part) => part.type === 'json')?.json
    ?? {};
}

function provenanceFor(item, tool) {
  return {
    memory_id: compact(item?.id),
    source_type: compact(item?.type || 'unknown'),
    memory_source: compact(item?.source || 'unknown'),
    retrieval_tool: tool,
    occurred_at: item?.occurred_at ?? null,
    status: item?.status ?? null,
  };
}

function fragmentFor(item, tool, detail = false) {
  const provenance = provenanceFor(item, tool);
  if (!provenance.memory_id) return null;
  const title = compact(item?.title || 'Memory');
  const content = compact(detail ? (item?.content || item?.summary) : (item?.summary || item?.content));
  if (!content) return null;
  const marker = `[memory_id=${provenance.memory_id} source_type=${provenance.source_type} via=${tool}]`;
  return {
    text: `${marker} ${title}: ${content}`,
    provenance,
  };
}

function materialResult(kind, fragments, maxTokens) {
  const unique = [];
  const seen = new Set();
  for (const fragment of fragments.filter(Boolean)) {
    if (seen.has(fragment.provenance.memory_id)) continue;
    seen.add(fragment.provenance.memory_id);
    unique.push(fragment);
  }

  const selected = [];
  let remaining = Math.max(1, Number(maxTokens) || 1);
  let truncated = false;
  for (const fragment of unique) {
    const separatorCost = selected.length ? 1 : 0;
    if (remaining <= separatorCost) {
      truncated = true;
      break;
    }
    const available = remaining - separatorCost;
    const fitted = trimToTokenBudget(fragment.text, available);
    if (!fitted) {
      truncated = true;
      break;
    }
    selected.push({ ...fragment, text: fitted });
    const used = estimateTokens(fitted) + separatorCost;
    remaining -= used;
    if (fitted !== fragment.text) {
      truncated = true;
      break;
    }
  }

  const text = selected.map((fragment) => fragment.text).join('\n');
  return {
    kind,
    text,
    fragments: selected,
    provenance: selected.map((fragment) => fragment.provenance),
    estimatedTokens: estimateTokens(text),
    truncated: truncated || selected.length < unique.length,
    degraded: false,
    readOnly: true,
  };
}

function errorCode(error) {
  const message = String(error?.message ?? 'unknown').toLowerCase();
  if (message.includes('timeout') || error?.name === 'TimeoutError') return 'timeout';
  if (message.includes('http')) return 'http_error';
  if (message.includes('json')) return 'invalid_response';
  return 'unavailable';
}

function tokenLimit(requested, configured) {
  const configLimit = Math.max(1, Number(configured) || 1);
  const requestLimit = Math.max(1, Number(requested) || configLimit);
  return Math.min(configLimit, requestLimit);
}

export class MemoryV1Client {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.sessionId = null;
    this.initialized = false;
    this.initializePromise = null;
    this.nextId = 1;
  }

  async post(payload, expectBody = true) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Memory-Caller': 'xinchao-dynamic-mind',
    };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const response = await this.fetchImpl(this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!response.ok) throw new Error(`Memory V1 MCP HTTP ${response.status}`);
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
    if (!expectBody) return null;
    return parseMcpBody(await response.text());
  }

  async initialize() {
    if (this.initialized) return;
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await this.post({
          jsonrpc: '2.0',
          id: this.nextId++,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'xinchao-memory-v1-adapter', version: '1.0.0' },
          },
        });
        if (this.sessionId) {
          await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
        }
        this.initialized = true;
      })().finally(() => { this.initializePromise = null; });
    }
    return this.initializePromise;
  }

  async call(name, args = {}) {
    if (!READ_TOOLS.has(name)) throw new Error(`Memory V1 tool is not allowed: ${name}`);
    await this.initialize();
    try {
      return await this.post({
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      });
    } catch (error) {
      if (!this.sessionId || !/HTTP (400|404)/.test(String(error.message))) throw error;
      this.sessionId = null;
      this.initialized = false;
      await this.initialize();
      return this.post({
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      });
    }
  }

  async recentContinuityMaterial({ now = new Date(), maxTokens = this.config.maxTokens } = {}) {
    const to = new Date(now);
    const from = new Date(to.getTime() - this.config.continuityDays * 86_400_000);
    const [surfaceResponse, timelineResponse] = await Promise.all([
      this.call('surface'),
      this.call('recall_timeline', {
        from: from.toISOString(),
        to: to.toISOString(),
        limit: this.config.maxResults,
      }),
    ]);
    const surfaceItems = structuredContent(surfaceResponse).items ?? [];
    const timelineItems = structuredContent(timelineResponse).items ?? [];
    return materialResult('recent_continuity', [
      ...timelineItems.slice().reverse().map((item) => fragmentFor(item, 'recall_timeline')),
      ...surfaceItems.map((item) => fragmentFor(item, 'surface')),
    ], tokenLimit(maxTokens, this.config.maxTokens));
  }

  async recentMaterial({ maxTokens = this.config.maxTokens } = {}) {
    return this.#searchMaterial({
      kind: 'recent_material',
      query: '近期重要记忆、关系变化、共同事件、仍在进行的项目与未完成事项',
      maxTokens,
    });
  }

  async thoughtMaterial({ maxTokens = this.config.maxTokens } = {}) {
    return this.#searchMaterial({
      kind: 'thought_material',
      query: '最近共同经历、说过的话、仍在意的具体事项与关系连续性',
      maxTokens,
    });
  }

  async #searchMaterial({ kind, query, maxTokens }) {
    const searchResponse = await this.call('search', { query, limit: this.config.maxResults });
    const items = structuredContent(searchResponse).items ?? [];
    const detailIds = items
      .map((item) => compact(item.id))
      .filter(Boolean)
      .slice(0, this.config.detailFetches);
    const details = await Promise.all(detailIds.map(async (id) => {
      const response = await this.call('fetch', { id });
      return structuredContent(response).memory ?? null;
    }));
    return materialResult(kind, [
      ...details.map((item) => fragmentFor(item, 'fetch', true)),
      ...items.map((item) => fragmentFor(item, 'search')),
    ], tokenLimit(maxTokens, this.config.maxTokens));
  }
}

export class MemoryV1ShadowObserver {
  constructor(client, { ttlMinutes = 30, maxEntries = 256 } = {}) {
    this.client = client;
    this.ttlMs = Math.max(1, Number(ttlMinutes) || 30) * 60_000;
    this.maxEntries = Math.max(8, Number(maxEntries) || 256);
    this.deliveries = new Map();
  }

  async observe(kind, { dedupeKey = '', now = new Date(), maxTokens } = {}) {
    const at = new Date(now).getTime();
    this.#prune(at);
    const key = compact(dedupeKey) ? `${kind}:${compact(dedupeKey)}` : '';
    if (key && this.deliveries.has(key)) {
      return { kind, status: 'duplicate', readOnly: true };
    }
    if (key) this.deliveries.set(key, at);
    const started = performance.now();
    try {
      const material = await this.client[kind]({ now, maxTokens });
      return {
        kind,
        status: 'ok',
        readOnly: true,
        latencyMs: Number((performance.now() - started).toFixed(1)),
        resultCount: material.provenance.length,
        estimatedTokens: material.estimatedTokens,
        truncated: material.truncated,
        provenance: material.provenance,
      };
    } catch (error) {
      return {
        kind,
        status: 'degraded',
        readOnly: true,
        latencyMs: Number((performance.now() - started).toFixed(1)),
        resultCount: 0,
        estimatedTokens: 0,
        provenance: [],
        errorCode: errorCode(error),
      };
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
