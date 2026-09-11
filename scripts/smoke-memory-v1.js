import { MemoryV1Client } from '../src/memory-client.js';

const url = String(process.env.MEMORY_V1_MCP_URL ?? '').trim();
if (!url) throw new Error('MEMORY_V1_MCP_URL is required');

const client = new MemoryV1Client({
  url,
  token: process.env.MEMORY_V1_MCP_TOKEN ?? '',
  timeoutMs: 8000,
  maxResults: 6,
  maxTokens: 900,
  detailFetches: 1,
  continuityDays: 30,
});

const checks = [
  ['recentContinuityMaterial', () => client.recentContinuityMaterial()],
  ['recentMaterial', () => client.recentMaterial()],
  ['thoughtMaterial', () => client.thoughtMaterial()],
];

const results = [];
for (const [name, run] of checks) {
  const started = performance.now();
  const material = await run();
  results.push({
    name,
    ok: true,
    latencyMs: Number((performance.now() - started).toFixed(1)),
    resultCount: material.provenance.length,
    estimatedTokens: material.estimatedTokens,
    truncated: material.truncated,
    provenanceComplete: material.provenance.every((item) => (
      item.memory_id && item.source_type && item.retrieval_tool
    )),
    tools: [...new Set(material.provenance.map((item) => item.retrieval_tool))],
  });
}

console.log(JSON.stringify({ ok: results.every((item) => item.ok), results }));
