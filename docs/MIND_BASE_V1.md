# Mind Base v1

Mind Base v1 is the bounded ChatGPT continuity baseline. It contains only the
existing dynamic-state engine, the existing controlled conversation-event
lifecycle, short handoff notes, gated read-only Memory V1 context, and current
dream residue.

## Context contract

Formal `xinchao_context` order:

1. `dynamic_state`
2. active `handoff_notes`
3. gated `recent_continuity` and `recent_material`
4. `dream_residue`

Memory is read-only and may call only `surface`, `search`, `recall_timeline`,
and `fetch`. It never calls `remember` or `read_evidence`, and dreams never
write back. Memory uses a 120-token absolute cap and a 50% relative cap after
all live Xinchao sections are preserved. An unscoped session start defaults to
zero Memory. Failure returns the original Context Envelope.

`MEMORY_V1_CONTEXT_ENABLED=false` immediately rolls formal Context back to the
pre-Memory envelope without removing the Adapter or the Phase 2b shadow path.

## ChatGPT trigger policy

`CHATGPT_TRIGGER_POLICY_ENABLED=true` adds a narrow routing policy to the MCP
server instructions and tool descriptions. ChatGPT is asked to call Context
once before the first response in a new chat, or after a clearly long gap when
continuity is needed. It is asked to submit one Event only after a meaningful
interaction has completed with a clear result. Greetings, short confirmations,
ordinary follow-ups, work in progress, and per-turn bookkeeping do not trigger
an Event.

The default long gap is six hours and is configurable with
`CHATGPT_TRIGGER_CONTEXT_LONG_GAP_HOURS`. Setting the policy flag to `false`
and restarting only `xinchao-chatgpt` restores the original Mind Base v1 MCP
instructions. The policy does not let the MCP server force the ChatGPT client
to call a tool; it only makes model-side routing more explicit. Server-side
session delivery suppression, event idempotency, daily limits, and fixed drive
mappings remain authoritative.

## Interaction contract

`xinchao_event` accepts the existing allowlisted interaction types and an
opaque `event_id`. The server owns all drive mappings; callers cannot provide
drive values through the MCP tool. Duplicate event IDs have no second effect,
all changes are bounded, and no event writes long-term Memory.

Mind Base v1 adds no drive, state field, event type, appraisal, open loop,
resonance, visualization, Wake, Bark, Collar, Dashboard, Claude integration, or
upstream 2.6 behavior.
