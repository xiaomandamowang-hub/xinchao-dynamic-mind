# Mind v2 Memory Resonance shadow

This slice adds a private, persisted shadow state derived only from committed
formal Recall Delivery Receipts. Resonance is not included in
`xinchao_context`, does not affect Thought selection or drives, and cannot
create Appraisal, Open Loop, or Memory records.

## Source and timing boundary

The only legal source is a receipt already present in
`recallDeliveryReceipts`. Receipt persistence after an MCP Context response
never invokes Resonance directly. A later MCP request or Mind settle consumes
new receipts. Therefore a receipt and its Resonance can never affect the same
Context delivery.

Shadow composition, REST inspect, test/prefetch/search, dream, thought, Memory
fallback, and an uncommitted receipt cannot create Resonance. Version 1
activates only receipts whose delivery status is `active`; those receipts were
already restricted to confirmed Memory by the Receipt layer. A `contested`
receipt remains durable delivery evidence but is consumed without activation.

## Frozen parameters and formula

- base intensity: `0.18`
- half-life: `45 minutes`
- hard TTL from the latest legal recall: `6 hours`
- per-Memory cap: `0.25`
- global effective intensity cap: `0.45`

The deterministic formula is:

```text
effective = min(
  0.25,
  0.18 * exp(-ln(2) * age_minutes / 45) / sqrt(1 + repeat_count)
)
```

Global overflow is proportionally scaled to `0.45`. A later legal receipt for
the same Memory settles the old value, increments `repeatCount`, refreshes the
recall timestamp and TTL, and replaces the effective value with the formula's
new bounded value. Old and new intensity are never added.

## Persisted state

Each active `resonance` item stores:

- `memoryId`
- `sourceReceiptId`
- `firstRecalledAt`
- `lastRecalledAt`
- `repeatCount`
- `baseIntensity`
- `effectiveIntensity`
- `halfLifeMinutes`
- `expiresAt`
- `sessionFingerprint`
- `contextDigest`

Expired entries are removed rather than retained as unbounded history.
`idempotency.resonanceReceiptCursor` is the durable high-water mark.
`idempotency.resonanceReceipts` keeps at most 256 recent hashed receipt
identities for audit/idempotency; pruning it cannot cause re-consumption because
the append-only cursor remains authoritative.

Runtime diagnostics contain only counts, min/max/global intensity, revision,
digest, trigger, status, and bounded error codes. Memory IDs, receipt IDs,
Memory text, query text, and private Appraisal/Open Loop content are forbidden.

## Rollback

`MIND_V2_RESONANCE_ENABLED=false` disables initialization and settlement. The
stored shadow state remains inert and is ignored by Context and Base v1. Code
rollback does not require a Memory, Claude, or Base state rollback.
