# Task #491 — Clock-change hour that traded exactly half the time

**Question:** the learned session profile marks a weekly slot "expected" when it
traded in at least 50% of observed weeks. A daylight-saving transition that lands
exactly on the midpoint of the 8-week lookback puts a shifted boundary hour at
**exactly 50%** (e.g. 4/8 weeks). On a multi-slot timeframe (M30, where one hour
spans two slots) that hour's absence in the new season then registers as a 2-bar
"genuine gap" — a transient false `partial` until the transition ages out of the
window. How should a boundary hour sitting exactly at the 0.5 presence ratio be
classified?

## Decision — require a STRICT MAJORITY (implemented)

The presence test is changed from `count/observedWeeks >= EXPECTED_PRESENCE_RATIO`
to `count/observedWeeks > EXPECTED_PRESENCE_RATIO` (`EXPECTED_PRESENCE_RATIO`
stays `0.5`). A slot must trade in **more than half** the observed weeks to be
"expected"; a 50% tie is **demoted to market-closed**.

### Why this option over the alternatives

- **Tighten the ratio (chosen).** "Expected" means the market *normally* trades a
  slot. A slot that traded in exactly half the weeks is a tie, not "normally" —
  demoting it is the honest reading. It fails in the safe direction: we never
  assert that a coin-flip slot's absence is a data gap, so no false `partial`. It
  is one surgical comparison change, timeframe-agnostic (fixes M30, H1, and every
  other multi-slot timeframe at once), and it does not weaken genuine gap
  detection — a slot present in a real strict majority (e.g. 5/8 = 0.625) is still
  expected and its absence still flags.
- **Tolerate as an isolated closure regardless of slot count (rejected).** Would
  require a new "boundary hour" concept in the missing-bar walk and would broadly
  tolerate any sub-hour 2-slot hole on M30, masking genuine 1-hour data outages.
  Worse for honesty.
- **Accept the brief partial as honest (rejected).** Produces a user-visible false
  `partial` / `aiUsable=false` for up to a week, twice a year, when the data is
  not actually incomplete — the market boundary merely shifted. Not honest.

### Safety / scope

Telemetry-only change. The presence profile is never an execution gate and never
fabricates a bar. The only behavioral effect is on `missingCandleCount` (and the
downstream advisory `quality`/`aiUsable` verdict) for session instruments. No
existing fixture sits at exactly 0.5 (real session slots are ~1.0; weekend /
minority slots are ≤ 0.25), so the change is invisible to every prior case.

## Coverage added

`[F48]` in `artifacts/api-server/src/lib/data/chart/__qa__/candleFixtures.test.ts`:
an M30 profile derived from M15 over 8 weeks split evenly by a DST transition
(4 full + 4 early-close Fridays) → boundary slots trade 4/8 = 0.5 → **demoted**,
so the summer feed reads `missing=0` / `clean` / `aiUsable=true`. A contrast
profile (5 full Fridays → 5/8 = 0.625) keeps the boundary expected, so the same
feed correctly flags a genuine 2-bar gap — proving the demotion is scoped to the
tie, not a blanket relaxation.

## Verification

| Check | Command | Result |
|---|---|---|
| Lib typecheck | `pnpm run typecheck:libs` | GREEN |
| Chart-truth fixtures | `pnpm --filter @workspace/api-server run test:chart-truth-fixtures` | **48/48 PASS** (incl. new F48) |
| Session profile (DB-backed) | `pnpm --filter @workspace/api-server run test:session-profile` | 6/6 PASS |
| Session-aware chart feed | `pnpm --filter @workspace/api-server run test:session-aware-chart-feed` | 4/4 PASS |

## Files changed

- `artifacts/api-server/src/lib/data/chart/sessionProfile.ts` — `>=` → `>` in the
  expected-slot test; constant + module-header docs explain the strict-majority
  tie decision.
- `artifacts/api-server/src/lib/data/chart/__qa__/candleFixtures.test.ts` — added `[F48]`.
