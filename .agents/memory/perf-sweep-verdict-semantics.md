---
name: Perf sweep verdict semantics
description: How qaPerfBackendSweep.ts must judge multi-sample probes so it cannot silently mask intermittent failures.
---

A perf sweep that runs N samples per probe must FAIL the probe if ANY sample fails — never average out errors behind a median latency check.

**Why:** Earlier sweep logic counted a probe PASS as long as `okSamples.length > 0` and median latency was in budget. A probe that returned `200,500,500,500,500` (1/5 success) would still print PASS and hide a real backend regression. Code review caught this exact pattern.

**How to apply:**
- Compute and print the full status distribution per probe (e.g. `200x5` or `200x4,500x1`), never just the first sample's status.
- Verdict ladder:
  - `okSamples.length === 0` → `FAIL(<dist>)`
  - `okSamples.length < r.samples.length` → `FAIL_MIXED(<dist>)` (never silently mask)
  - `median > budget` → `OVER`
  - else → `PASS`
- Optional-not-mounted is only honoured when the probe is marked optional AND every sample returned the SAME 401/403/404 (uniform absence, not flaky).
- Counts in the SUMMARY line must add up to total probes; mixed verdicts go in the fail bucket.
