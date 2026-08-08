# Mind Phase 2: Context Shadow Composition

The Shadow Context Candidate is built beside the formal Context Envelope and is
never returned to the caller. The formal `xinchao_context` response and its
delivery lifecycle remain unchanged.

## Section order

1. `dynamic_state`
2. active `handoff_notes`
3. `recent_continuity`
4. `recent_material` when a topic hint, handoff, or continuity gap justifies it
5. `dream_residue`

Formal Xinchao sections are budgeted first and copied without modification.
Memory can use only the remaining budget. Its share is capped relative to the
live Context already present, and each Candidate also has deterministic limits
for total Memory references and tokens per Memory. This prevents a small live
Context from being overwhelmed merely because the configured global budget is
large.

## Memory policy

- Only active and contested records may enter the Candidate.
- Pending, superseded, historical, unknown-status, stale non-stable records,
  repeated IDs, near-duplicates, and memories duplicating a fresher handoff are
  excluded with an auditable reason.
- A selected record that supersedes another selected record replaces it.
- Contested records retain their status in provenance and are never presented
  as settled facts.
- No write-capable Memory tool exists in this path.

Runtime logs contain only section counts, token counts, Memory-reference count,
digest, latency, and an error code. Memory IDs and safe summaries are written
only by the explicit private evaluation command to a mode-0600 report.
