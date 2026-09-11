# Mind v2 Store + migration

This slice implements only the additive persistence boundary frozen by
DB-2026-08-09. It does not implement Appraisal, Open Loop, Recall Delivery
Receipt, Resonance, thought bias, or any connection back to durable Memory.

## State boundary

The ChatGPT instance may create an independent file at:

`/var/lib/xinchao-chatgpt/mind-v2-state.json`

Schema 1 contains only an empty foundation:

- `schemaVersion: 1`
- `revision` and `lastSettledAt`
- empty `appraisals`, `openLoops`, `resonance`, and `idempotency` structures

The existing Base v1 `state.json` is never migrated or rewritten by this
store. Claude does not load this module in its deployed instance.

## Feature flags

`MIND_V2_STORE_ENABLED` defaults to `false`. The Appraisal, Open Loop, and
Resonance flags also default to `false` and are configuration placeholders
only; this slice does not read them outside configuration.

When the store flag is false, startup performs no Mind v2 I/O and creates no
file. When true, a missing file is atomically initialized. A corrupt file,
invalid shape, parse error, or schema newer than 1 produces a sanitized
`mind_v2_store_status` diagnostic and omits Mind v2 while Base v1 continues.
The bad file is preserved for recovery and is never silently overwritten.

Writes use a mode-0600 temporary file, file fsync, atomic replace, permission
enforcement, and directory fsync. Deleting the independent file is the empty
rebuild path; the next enabled startup recreates schema 1 without reading or
changing Base v1 state.

## Rollback

Disable `MIND_V2_STORE_ENABLED` and restart only `xinchao-chatgpt`. The
independent file may remain on disk because the disabled release neither reads
nor writes it. Code rollback does not require rolling back Base state, Memory,
Claude, or any neighboring service.
