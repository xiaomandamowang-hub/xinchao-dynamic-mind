# Mind v2 Appraisal lifecycle

This slice closes the controlled semantic-input gate from DB-2026-08-09.
It implements Appraisal only. Open Loop, Recall Delivery Receipt, Resonance,
thought bias, Memory writeback, and Context projection remain absent.

## Boundary

- `xinchao_event` records that a real interaction happened.
- `xinchao_appraisal` records how Shen Gui currently interprets that event.
- Appraisal is subjective, revisable state. It is never durable Memory truth.
- No Appraisal operation accepts drive deltas, raw chat, or caller-selected TTL.
- Dream, thought, heartbeat, shadow, test, and Memory recall paths cannot create
  a valid Appraisal source receipt.

After a real MCP or HTTP conversation event has successfully updated Base v1,
the service records only its event fingerprint, source kind, processed time,
and Base revision under `idempotency.sourceEventReceipts`. Appraisal creation,
revision, and release require that receipt. Existing ambiguous Base history is
not backfilled because heartbeat and real events were not previously
distinguishable in every case.

## Stored version

Each Appraisal version contains:

- a generated Appraisal ID, `subjectKey`, and monotonic subject version;
- `interpretation`, bounded scalar evaluation fields, optional bounded
  `relationalMeaning`, and a controlled persistence class;
- source-event and operation fingerprints;
- status and lifecycle timestamps;
- `supersedes` and `supersededBy` links.

Revision creates a new version and marks the previous active version
`revised`. Release marks the current version `released`. Expiry marks it
`expired` at the deterministic expiry boundary. History is retained.
Reactivation after release or expiry requires a new real event and a new
operation, and continues the same version chain.

## Fixed timing

| Class | Review | Expiry |
| --- | ---: | ---: |
| `fleeting` | 6 hours | 24 hours |
| `situational` | 24 hours | 72 hours |
| `significant` | 48 hours | 168 hours |

Review due is a read-only projection. It does not automatically rewrite the
meaning. Expiry is settled during the bounded runtime cycle and before new
Appraisal operations. Repeated settlement at the same time is deterministic.

## Privacy and rollback

Runtime logs contain only status, counts, revision, action, digest, and error
codes. They never contain `interpretation` or `relationalMeaning`. The formal
Context Envelope does not read Appraisal in this slice.

Disable `MIND_V2_APPRAISALS_ENABLED` and restart only `xinchao-chatgpt` to
remove the tool and stop Appraisal source receipts and settlement. The Mind v2
file remains intact and Base v1, Memory, and Claude require no rollback.
