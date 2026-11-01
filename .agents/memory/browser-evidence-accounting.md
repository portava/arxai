---
name: Browser evidence accounting
description: Avoid inflated coverage counts when adapting upstream multi-viewport browser probes.
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
