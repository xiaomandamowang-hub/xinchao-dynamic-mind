# Memory V1 read-only adapter (Mind Phase 1)

This adapter is intentionally narrower than the legacy Ombre integration.

## Boundary

- `src/memory-client.js` exposes `recentContinuityMaterial`, `recentMaterial`,
  and `thoughtMaterial`.
- It can call only `surface`, `search`, `recall_timeline`, and `fetch`.
- Every material fragment carries the Memory ID, source type, Memory source,
  retrieval tool, time, and status as provenance.
- The adapter has no write method and receives no state store, drive engine, or
  transition mutator.
- Retrieved material is transient. Shadow diagnostics contain counts, latency,
  token estimates, and provenance only; they never contain query text, Memory
  text, or L0 evidence.

Generated thoughts, dreams, and inferences remain generated artifacts. They do
not become person facts and cannot be written to long-term Memory through this
adapter.

## Phase 1 flags

`MEMORY_V1_ENABLED=false` is the master off switch.

`MEMORY_V1_SHADOW_ENABLED=false` enables diagnostic reads only when the master
switch is also enabled. Shadow material is discarded and does not alter the
Context Envelope response, dynamic state, drives, fatigue, sleep behavior, or
thought-pool behavior.

The first deployment must keep both flags false. After baseline verification,
only the ChatGPT instance may set both flags true for shadow observation. The
Claude instance remains unchanged.
