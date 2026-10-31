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
