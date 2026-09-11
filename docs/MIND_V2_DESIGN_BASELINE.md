# Mind v2 DB-2026-08-09

Status: frozen.

Mind Base v1 remains the compatibility baseline. Mind v2 is additive and must
not reinterpret durable Memory truth, accept client-provided drive deltas, or
turn internal recall into a new external experience.

## Explicit design gates

The following gates are registered but are not implemented by the upstream
compatibility preflight:

1. **Controlled Appraisal input** — Appraisal cannot be implemented until
   there is a bounded semantic input channel for "how Shen Gui understands the
   event". The existing interaction type and session overlay do not carry that
   meaning, and the system must not invent it or promote it to Memory fact.
2. **Recall Delivery Receipt before Resonance** — Memory Resonance cannot be
   implemented until a formal, idempotent receipt proves that a selected
   Memory actually entered a delivered Context. Shadow reads, tests, prefetch,
   and unselected search results must never create Resonance.

## Upstream compatibility preflight scope

This preflight is limited to upstream 2.3.4 SERVICE_TOKEN startup validation,
one shared runtime version constant, and drive-count tests derived from
`DRIVE_KEYS.length`. It does not import upstream 2.5 recall behavior or any
Dashboard, Runtime Bridge, Bark, browser/CORS, Mind v2 state, Appraisal, Open
Loop, Recall Delivery Receipt, or Resonance implementation.
