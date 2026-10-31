---
name: Chart volume evidence
description: Explicit-zero advisories do not establish real traded-volume provenance.
---

Do not enable volume-dependent analytics merely because a zero-volume warning
is absent. Preserve the distinction between unknown, tick and real traded
volume before adding VWAP, footprint, volume profile or related studies.

**Why:** The accepted advisory correction distinguishes missing input from an
explicit zero internally, but it does not establish end-to-end volume provenance.
Treating that correction as sufficient evidence would make analytics misleading.

**How to apply:** Require source-specific provenance through the full contract
and consumer pipeline; keep unsupported analytics withheld in the meantime.
