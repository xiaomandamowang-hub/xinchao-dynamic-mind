# Mind v2 Recall Delivery Receipt

This slice records only the fact that a gated Memory reference was actually
delivered in a successful production MCP `xinchao_context` response. It does
not implement Resonance, drive changes, Thought bias, or Context projection for
Appraisal/Open Loop.

## Commit boundary

Context composition creates an in-memory draft from the final rendered Memory
set. The draft is not part of the returned envelope. It is committed only from
the HTTP response `finish` event for an MCP `xinchao_context` call.

No receipt is created for:

- Shadow composition or read-only observation;
- REST inspect/smoke, search, prefetch, benchmark, or SQLite rebuild;
- a Memory candidate removed by status, relevance, dedupe, or token gating;
- Memory fallback when no Memory section is promoted;
- a failed Context build or a response that closes before `finish`;
- dream, thought, Appraisal, Open Loop, or any internal operation.

## Stored schema

The independent Mind v2 Store gains `recallDeliveryReceipts` and
`idempotency.recallDeliveries`. Each receipt stores:

- `deliveryId`
- `memoryId`
- `memoryStatusAtDelivery`
- `contextDeliveryId`
- `sessionFingerprint`
- `contextDigest`
- `deliveredAt`
- `sourceOperation` (`mcp:xinchao_context`)

It never stores Memory title, summary, content, query, chat text, or evidence.
Runtime logs contain only receipt/duplicate counts, revision, status, digest,
and bounded error codes; Memory IDs are never logged.

Active Memory requires `review_state=confirmed`. A contested Memory may record
its contested delivery status when the existing formal gate admits it. Pending,
superseded, historical, filtered, and unrendered results never create receipts.
The receipt does not alter Memory status or truth.

## Idempotency and isolation

The stable identity is `SHA-256(memory_id + NUL + context_delivery_id)`. The
hash is kept in `idempotency.recallDeliveries`; the same Memory can be recorded
only once per Context delivery. A Context is deduplicated before the Store
operation. One atomic Store update writes all new receipts and increments the
Mind v2 revision once.

Receipt persistence never touches Base `state.json`, drives, thoughtPool,
dreams, Appraisal, Open Loop, Resonance, or the Memory service/Git repository.
The feature flag is `MIND_V2_RECALL_DELIVERY_RECEIPTS_ENABLED` and requires the
Mind v2 Store. Disabling the flag is the first rollback step; old receipts stay
in the isolated Store and are inert.
