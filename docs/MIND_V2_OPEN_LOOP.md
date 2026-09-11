# Mind v2 Open Loop lifecycle

This slice implements Open Loop storage and lifecycle only. Recall Delivery
Receipt, Resonance, thought bias, Memory writeback, and formal Context
projection remain absent.

## Boundary

- Appraisal is how Shen Gui currently understands a real event.
- Open Loop is a bounded unresolved relationship matter, task, or shared plan
  caused by a landed real interaction.
- Memory remains the durable account of what happened.
- Open Loop is neither objective truth nor a permanent attachment.

`xinchao_open_loop` accepts `open`, `resolve`, and `release`. Every operation
requires an idempotent operation ID, a stable loop key, and a source event that
already has a real MCP/API conversation-event receipt. Dream, thought,
heartbeat, shadow, test, Memory recall, and Resonance paths cannot establish a
valid receipt.

`resolve` means a later real event supports objective completion. `release`
means Shen Gui deliberately stops carrying the matter and does not assert that
it completed. Expiry means the loop no longer remains current. Closed loops
never reactivate automatically; reopening the same key creates a new version
and requires a real event later than the prior closure.

## Stored fields and projection

Stored versions retain the bounded summary and expectation, source-event
provenance, optional related Memory IDs, priority, status, lifecycle times,
closure reason, and monotonically increasing version. Runtime logs and the MCP
diagnostic projection omit summary, expectation, related Memory IDs, and chat
content. The formal Context Envelope does not read Open Loop in this slice.

## Time policy

- Without an explicit due date, every kind expires after at most 30 days.
- `relationship` never accepts a due date.
- `task` and `shared_plan` may use a complete UTC ISO due date.
- A due date must be in the future and no more than 365 days away.
- Callers cannot submit a free TTL or extend a loop through recall.

## Rollback

Disable `MIND_V2_OPEN_LOOPS_ENABLED` and restart only `xinchao-chatgpt`. The
stored history remains intact. Base v1, Appraisal, Memory, and Claude do not
require rollback.

## Connection-layer observation

The current ChatGPT conversation had not yet refreshed the
`xinchao_appraisal` tool schema when this slice began. The deployed server MCP
already exposed and tested that tool, so this is recorded as a connector/cache
observation only. This slice does not repair the connection layer or roll back
Appraisal.
