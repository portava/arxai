---
name: Weekly report change-verifiability gate
description: Fund Book weekly investor story must omit numeric week-over-week change when unverifiable
---

# Weekly report change-verifiability gate

A weekly investor "account story" must NEVER surface a numeric week-over-week
change (netChange / marketChange) when the underlying values are unverifiable.

The rule: a single `changeVerifiable` flag = `!UNDER_REVIEW && !(STALE|MISSING)`.
netChange/marketChange are null unless `hasBaseline && changeVerifiable`.

**Why:** architect rejected the first cut because under-review/stale weeks still
rendered numeric change figures — a fabrication risk. Honesty is inviolable for
investor-facing payloads (no guessed numbers, ever).

**How to apply:** the gate lives in BOTH places and they must stay in lockstep:
- builder (`weeklyReportMath.ts`) nulls the numbers + swaps to non-numeric
  headline/summary + emits a "withheld" disclosure;
- investor UI (`investor.tsx`) only renders the change cards when
  `changeVerifiable && baselineAvailable`, else a no-baseline or withheld block.
If you add another freshness/nav state that means "don't trust the number",
fold it into `changeVerifiable` — do not special-case the UI alone.
