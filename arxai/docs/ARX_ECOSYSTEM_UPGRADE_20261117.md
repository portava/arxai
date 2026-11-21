# ARX ecosystem upgrade — 17 November 2026

Implemented on `codex/arx-investor-research-20261117`, based on local news commit
`95dc20b6`. Local implementation and verification; not merged or deployed.

## Audit and reuse

The current checkout already has a structural model, causal event labels,
chronological training/gates, immutable forecast receipts, a seasonal volatility
range, scanner outcome calibration, Eleanor claim verification, and the existing
18-gate execution path. These were reused. There is no new broker, risk settings
store, kill switch, or Python trading service.

The eleven trader skills were installed from `Jakeschincariol/trader-skill` at
`5189e79b9a480755a3733ac9713f5353981dbe18`; upstream offline tests: 175 passed.
Their workflows informed TypeScript integrations rather than executing their
file-based order proposals against ARX accounts.

## Capability coverage

| Skill / area | Delivered integration | Explicit boundary |
|---|---|---|
| News | Headline evidence normalization, deduplication, age/future checks, source links; removed keyword direction calls | Headlines are unverified leads; GDELT observation time is not publication time |
| Analyst | Authenticated SEC submissions/company-facts client; quarterly/annual revenue, gross/net/operating margins, EPS and matching-period revenue growth; Eleanor read tool | Requires real operator `SEC_USER_AGENT`; no invented Q4, TTM or live figures; SEC unavailable remains visible |
| Screener | Company research screen with explicit per-rule PASS/FAIL/UNKNOWN, period dates/type and source | Missing facts/unknown periods cannot pass; filter match is not a recommendation |
| Budget | Capped cent-based allocation, buffer, min/max proposal sizes, deterministic rounding | USD unlevered share values only; current holdings require rebalance mode |
| Rebalance | Drift-band preview, protected untracked holdings, sells before conditional buys, cumulative cash | Hypothetical fills; no live portfolio writes |
| Risk | Sequential basket validation for duplicates, shorts, concentration and cash limits | Supplied preview policy never changes or impersonates the Risk Governor |
| Copycat | 13F supplied-row grouping, weights, filing/report dates, primary-source link | Delayed disclosed sleeve, not current entire fund; options/unmapped symbols excluded |
| Pelosi / Congress | Imported transaction rows preserve owner, amount ranges, options and disclosure delay | User transcription; no automatic PDF extraction, inferred midpoint or legal-violation claim |
| Tax | FIFO/HIFO cost-basis sale preview, unknown inventory rejected | Arithmetic only; no jurisdiction-specific tax/wash-sale/harvesting recommendation |
| Alerts | Freshness-aware one-shot price-rule preview, one-shot dedup, conflicting quotes rejected; link to existing Alerts | Does not install a second background watcher or submit orders |
| Broker | Existing execution architecture retained; latest stop/pickup/cancel edits regression-tested against disposable PostgreSQL (6 passed) | Those pre-existing uncommitted edits are preserved separately; no broker orders or authority changes |

The `/investor-research` page is in navigation and the command palette. Seven
workspaces provide ordinary forms and CSV import/header downloads. Inputs are
in page memory only; authenticated calculation routes are stateless and isolated
between users. No external symbol data is silently interpreted as FX/CFD lots.

Core paths: `lib/domain/src/investor-research/`,
`artifacts/api-server/src/lib/research/secResearch.ts`,
`artifacts/api-server/src/routes/investorResearch.ts`,
`artifacts/trading-dashboard/src/pages/investor-research.tsx`.

## Forecast and truth repairs

* Historical company metrics could satisfy a current-price claim. Research
  evidence now retains its authority flag through nested records; it cannot
  substantiate a live quote, execution level, execution receipt, market state,
  or calibrated success probability. A calibration-shaped nested record cannot
  elevate it. Historical factual statements remain supported.
* `structural/volRange.ts` now refuses future-fitted profiles, incomplete or
  malformed candles, invalid factors, out-of-range horizons and nonfinite bands.
  Invalid data uses the existing fallback. Accepted production results retain
  parity with the pinned benchmark.
* An appended late grade previously could double-count one forecast in the
  performance summary. Horizon scores now select one observation.
* Forecast range coverage now counts completed, original, non-overlapping
  windows. Updates, unresolved grades, future outcomes and duplicates do not
  inflate it. The UI reports counts and nominal 50% coverage as descriptive
  history, not validated future probability. Receipt data is not rewritten.
* Scanner and Smart Chart truth-cap tests pass; imported financial research
  cannot upgrade their actionability. Directional-edge requirements remain.

External repositories were installed and actually used: `bashtage/arch`,
`Nixtla/statsforecast`, `online-ml/river`. See
`../scripts/research/forecast-lab/README.md` and the complete `results.json`.
On 3,633 real-data historical origins, GARCH was 3.68% worse on normalized interval
score; Conformal Naive was 0.54% worse and its uncertainty interval included zero.
Neither replaces ARX. This is reused historical evidence, not an independent
edge trial. The improvement is a reproducible candidate benchmark, drift
observations, stronger causal input boundaries and honest forecast scorekeeping.

## Verification

* New research domain, SEC adapter, authenticated HTTP and AI authority tests: 23 passed.
* Forecast integrity plus chart/scanner/component truth and claim checks: 118 passed.
* Full Eleanor grounding group: 190 passed.
* Targeted research, forecast panel and scanner/Eleanor UI tests: 28 passed.
* Full dashboard suite: 667 files passed, 1 skipped; 6,505 tests passed, 11 skipped.
* Existing structural volatility benchmark/parity: 7 passed.
* Existing stop/pickup/cancel PostgreSQL checks: 6 passed, isolated disposable DB.
* Repository guard suite: 87/87 passed; bridge-binding and scanner mutation fixtures passed.
* Domain declarations, API/dashboard/scripts TypeScript checks passed.
* API and dashboard production builds passed (existing bundle-size warnings remain).
* Actual chart browser acceptance: controls, mobile width, history anchoring,
  1,099 incremental updates, no page errors; synthetic isolated chart fixture.
* Actual research page browser: all seven tabs, desktop and 390px mobile, no
  horizontal overflow or page errors; browser form-to-domain calculation also
  produced five proposals and retained the $500 buffer from a $5,000 input,
  then cleared on input change. Isolated fixture, not production authentication.

The initial guard run needed a placeholder DATABASE_URL for module import; the
successful guard run used an unreachable localhost URL and no production DB.
The first UI assertion expected the old range wording; it was updated to assert
the more accurate nominal-coverage wording and passed. No failures are hidden as
successful production or broker testing.

## Configuration and remaining work

Set `SEC_USER_AGENT` to the operator's real name/contact email in the API process.
Without it, the adapter makes no SEC request and returns NOT_CONFIGURED. Live SEC
access was not verified; controlled response tests cover parsing/cache/failure.
No false operator identity was supplied. A full all-product runtime certification,
new prospective forecast dataset, production deployment, automated congressional
PDF extraction, and jurisdiction-specific tax engine are not completed by this
change. “Full potential” is an ongoing roadmap, not a measurable release claim.
