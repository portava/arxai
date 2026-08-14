---
name: Fail-soft readiness must degrade to NOT-ready
description: A caught error in a readiness/handshake pre-check must never collapse into an empty-results-means-ready state.
---

When a readiness/pre-check aggregator (handshake coordinator, governor, gate
sweep) is wrapped in `.catch(() => [])` and a downstream mapper computes
`ready = (blocked.length === 0 && degraded.length === 0)`, an *error* silently
becomes **ready:true** — fabricated readiness with zero evidence.

**Rule:** distinguish a genuine empty result from a failure. On failure return a
sentinel (`null`), and have the mapper translate `null` → `ready:false` +
explicit degraded marker (e.g. `HANDSHAKE_UNAVAILABLE`) + an honest note. Empty
*successful* results may still legitimately be ready.

**Why:** ARX honesty contract — never show "all layers ready" / actionable state
when the underlying data is unavailable. Caught in code review on the Self-Trade
AI decision brain (`mapHandshakes([])` returned `ready:true`).

**How to apply:** audit every `Promise.all` of `.catch(() => <empty>)` feeding a
"ready/healthy/clean" verdict. The empty-collection fallback and the
all-clear computation are the same value — that's the bug. Use `null` for "could
not evaluate" and branch on it before the all-clear math.
