---
name: Browser evidence accounting
description: Browser coverage accounting, observer/locator preflight and durable failure evidence.
---

Inspect an imported probe's internal viewport matrix before wrapping it. Run
each defined probe once unless repetition is deliberate, and distinguish
viewport-qualified coverage from repeated executions of the same whole probe.

**Why:** An upstream Scanner probe already visited desktop and mobile internally.
An outer repetition inflated a tester's claimed distinct coverage, and a summary
also retained a stale count after a corrected continuation.

**How to apply:** Audit raw assertion receipts and final corrected continuations,
not only prose summaries. Retain original failures and superseded reports;
publish unique coverage, repeated executions and incomplete checks separately.

Viewport evidence must record actual layout, stored preferences, selected
controls and scroll offset. Do not infer default state from a screenshot name.

**Why:** A multi-chart screenshot was misreported as a default single-chart
control-order failure. A targeted state-correct observation confirmed the
single-chart order while retaining the separate partial-visibility limitation.

**How to apply:** Preserve the original diagnosis and corrected receipts.
Distinguish geometric viewport intersection, unobscured visibility, whole-plot
fit and source-correct completion latency; none automatically proves the others.

Browser-exposed fixture readers are asynchronous, and assistant welcome cards
can disappear on the first send. Do not treat exposed readers as synchronous
arrays or identify a fresh reply by a stable count of all DOM children.

**Why:** Promise-array predicates and unstable welcome-card child indexing
repeatedly stopped browser probes before their intended acceptance cases.

**How to apply:** Await exposed readers inside browser predicates; synchronize
replies by stable message identity or role-qualified freshness, not a phrase
anywhere in old history. Preserve assertion counts separately from failed
steps and unstarted cases, and capture full error messages incrementally.

Preflight generated probes against the existing observer contract and rendered
markup. Compare numeric presentation semantically at its disclosed precision,
without weakening expected geometry, source or visibility requirements.

**Why:** Contract, locator-scope and formatting assumptions can stop acceptance
before the intended behavior is exercised. Capturing screenshots only after
success also leaves those failures without visual evidence.

**How to apply:** Inspect the actual reader/markup/formatter before a bounded
run. Persist source/runtime identity, stage, DOM, screenshots and network/error
records in failure cleanup as well as on success. Keep corrected programs and
attempts separate; an interrupted flow stays incomplete, not a feature pass.
