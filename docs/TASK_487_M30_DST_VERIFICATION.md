# Task #487 — M30 weekend-gap fix: spec-conformance verification

**Goal:** verify the M30 weekend-gap fix (Task #485, extending Task #483's
session-aware candle completeness to M30) matches the SPEC's *required approach* —
a **LEARNED weekly presence profile**, NOT a hardcoded Fri→Sun window — not merely
that tests pass. Run the standard verification list, a spec-conformance audit, fix
any violation, and capture live before/after reads.

## Verdict

**CONFORMANT (after one remediation).** The M30 completeness logic is driven
entirely by a learned weekly presence profile; there is no hardcoded day-of-week /
weekend-window logic in any calc file. The single gap found was **missing test
coverage** (no DST-transition fixture existed; M30 was not explicitly covered for
the DST + insufficient-history behaviors). That gap is now closed with two new
deterministic fixtures.

## Spec-conformance audit

1. **No hardcoded weekend window.** `grep` for `Fri|Sun|21:00|22:00|dayOfWeek|
   getDay|weekend` across the calc files (`candleNormalization.ts`,
   `sessionProfile.ts`, `candleTruthEngine.ts`, `chartDataService.ts`,
   `timeframes.ts`, `rubyChartContext.ts`) returns **0 matches in any decision
   path**. Hardcoded clock times appear only as descriptive metadata in
   `symbolProfile.ts`, never in the missing-bar calc.

2. **Missing-bar logic is profile-driven.** `candleNormalization.ts` decides every
   expected/absent slot purely via `isSlotExpected(sessionProfile, slotOpen)`.
   `expectedSlots` is learned: a slot is expected iff it traded in
   `count / observedWeeks >= EXPECTED_PRESENCE_RATIO (0.5)` over an 8-week
   lookback, requiring `MIN_WEEKS_FOR_PROFILE (3)`; otherwise the profile is
   `sufficientHistory=false` and fails honest (null / not-applied).

3. **M30 is derived, not hardcoded.** `broker_candles` stores M1/M5/M15/H1/H4/D1
   only — there is **no** M30. `PROFILE_SOURCE_TIMEFRAME={M30:"M15"}` makes
   `getSessionProfile` read the finer **M15** bar opens and bucket them at the M30
   interval via the pure `buildWeeklyPresenceProfile`. The profile is cached per
   `(symbol|timeframe)` with a 30-min TTL + day key, and fails honest (null) on a
   non-derivable timeframe or DB error.

4. **DST-transition coverage — GAP FOUND, NOW FIXED.** The spec requires a
   DST-transition fixture (boundary moves an hour mid-history → no false gaps),
   covering M30. **None existed.** Added **[F45]**: builds a learned M30 profile
   (derived from M15) straddling a DST shift — 1 full-Friday "winter" week + 3
   early-close "summer" weeks. The shifted boundary slots appear in 1/4 = 0.25 of
   weeks → below 0.5 → **demoted to market-closed**, so the identical summer feed
   shows `missingCandleCount=0` / `clean` / `aiUsable=true`. The fixture also
   **contrasts** a naive single-season profile (4 full-Friday weeks) that wrongly
   keeps the boundary expected → the same feed false-flags a 2-bar gap
   (`missing=2` / `partial`). This is exactly the false DST gap the learned
   approach avoids.

5. **Insufficient-history coverage for M30 — NOW EXPLICIT.** Added **[F46]**: an
   M30 profile derived from only 1 week of M15 → `sufficientHistory=false` →
   `sessionProfileApplied=false`, `missingCandleCount=0`,
   `qualityReason="insufficient_history_for_session_profile"` (never asserts
   missing bars on untrustworthy history). Mirrors F40 on the derived M30 path.

6. **24/7 synthetics unchanged.** F39 locks that without a session profile the
   naive grid still counts a single hole as missing — Deriv synthetics keep the
   strict 24/7 grid.

## Standard verification list

| Check | Command | Result |
|---|---|---|
| Lib typecheck | `pnpm run typecheck:libs` | GREEN |
| API-server typecheck | `pnpm --filter @workspace/api-server run typecheck` | GREEN |
| Invariant guards | `pnpm run ci:guards` | 41/41 PASS |
| Chart-truth fixtures | `pnpm --filter @workspace/api-server run test:chart-truth-fixtures` | **46/46 PASS** (incl. new F45 DST, F46 M30 insufficient) |
| Session profile (DB-backed) | `pnpm --filter @workspace/api-server run test:session-profile` | 6/6 PASS |

Note: root `pnpm run typecheck` OOMs in this environment, so it is split into
`typecheck:libs` + the per-package filter (both green). The full `pnpm run ci`
mega-suite exceeds a single command budget; the session-relevant slices above were
run individually.

## Live reads (EURUSD, this environment, weekday 2026-06-11)

Read via `GET /api/chart/candles` (temp per-user session minted and deleted after).

| Timeframe | count | source | quality | aiUsable | missing |
|---|---|---|---|---|---|
| M30 | 300 | mt5_broker | clean | true | 0 |
| H1  | 300 | mt5_broker | clean | true | 0 |
| H4  | 300 | mt5_broker | clean | true | 0 |
| D1  | 200 | mt5_broker | clean | true | 0 |

Ruby read (`POST /api/me/assistant/read-chart`, EURUSD H1): **basis=VERIFIED**,
not gated, chartTruthScore 96.09 — full directional read allowed.

**Before/after.** A live "before" (pre-#485) is not reproducible here: #485 is
merged and the live broker feed is fresh on a weekday, so M30 reads `clean`. The
controlled before/after is locked deterministically by the fixtures: the **after**
(learned profile) keeps a weekend/DST-spanning M30 feed `clean` (F43, F45-learned),
while the **before/naive** behavior — a single-season or non-session grid — flags a
false gap (`partial`, F45-naive contrast; F39 naive synthetic). M30 now reads
identically to H1/H4/D1 across the weekend/DST boundary.

## Remediation made

- Added `[F45]` (DST-transition on derived M30, learned-vs-naive contrast) and
  `[F46]` (M30 derived-from-thin-M15 insufficient-history) to
  `artifacts/api-server/src/lib/data/chart/__qa__/candleFixtures.test.ts`.
- No production code changed — the M30 completeness logic was already conformant.
