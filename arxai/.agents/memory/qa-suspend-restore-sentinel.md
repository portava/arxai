---
name: QA suspend→restore with sentinel for shared safety rows
description: Deterministic pattern for DB-backed QA suites blocked by pre-existing dev-DB safety/control rows (freezes, discrepancies)
---

# QA suspend→restore + sentinel pattern

Fundbook (and similar) DB-backed suites can go red purely from accumulated shared dev-DB state:
- ACTIVE `fund_control_freezes` rows (GLOBAL AUTO_CRITICAL scopes) throw `ACTION_FROZEN:*` on every issuance/withdrawal.
- OPEN/INVESTIGATING `fund_discrepancies` rows scoped to the seed pool flip `getValueStatusForUser` to UNDER_REVIEW, and the weekly honesty gate then withholds endValue (`changeVerifiable=false`).

**Pattern** (rows are safety evidence — NEVER delete):
1. Before the exercised section, capture EXACTLY the blocking pre-existing rows (id + original value), scoped as narrowly as possible (matching scopes / pool id, status filter).
2. Suspend (set `active=false` / `status='RESOLVED'`).
3. In `finally`, restore each row's exact original value.
4. **Sentinel-assert the restore landed** (re-select and assert count/status match) so a silent restore failure or prior killed run is loudly visible in suite output rather than leaving the dev DB quietly unprotected. Architect requires this — in-place mutation of shared safety rows without a sentinel is a conditional-fail.

**Why:** suites must be deterministic against a polluted shared dev DB, but a SIGKILL/OOM mid-run skips `finally`; the sentinel makes the altered posture detectable.

**How to apply:** any QA suite that trips over global freeze/review/lock rows. Rows created DURING the run must never be touched (only pre-captured ids). Also remember weekly-report freshness: broker mirror >60s = STALE, so long suites must re-touch the seeded bridge heartbeat immediately before each generate call.

Related: fund deposits now default to BALANCED (`DEFAULT_DEPOSIT_TARGET`); CASH_RESERVE deposits are refused with `DEPOSIT_TARGET_NOT_ELIGIBLE` under the June-19 Balanced-only investor rule — capital suites must seed/deposit into BALANCED.
