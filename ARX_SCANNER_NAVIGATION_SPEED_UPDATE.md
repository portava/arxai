# Scanner navigation-speed update — development only

## Saved source provenance

- Starting clean workspace checkpoint:
  `e62483f047687956386ede7872538463dcbee4dd`.
- Workspace branch: `codex/pr103-smart-chart-development-20261031`.
- Additional recovery reference:
  `codex/backup-before-scanner-navigation-20261031`.
- Prior chart source remains
  `9d3b3ea8214c25294ca851ab9a0e6c54272b4f07`.
- Imported navigation commits only:
  - `df4e0161e3de580bc5550c23cbbda7f1c6db0b8b`
  - `a6147137c9da303c33422d8895a42475889f6b8d`
- PR103 branch/pull head observed through read-only Git remote lookup:
  `6f0702951424dec48e90caa443fe4b6e1bde33f4`.
  This newer complete head was **not** imported.
- Source parent for the two-commit patch:
  `38d23d84eb246e0b34fd90f4b110e84c287af846`.
- The exact resulting workspace commit containing this report is supplied in
  the delivery response and retained import receipt.

All 13 touched upstream paths matched their pre-patch source blobs in the
workspace, including the absent new files. There were no overlapping local
edits. Only those two commits' resulting paths were imported; no branch reset,
full PR update, main change, merge or push was performed. The earlier recovery
reference and completed chart import were preserved.

## Change

The Scanner module is prepared at idle when access allows. Actual navigation
intent can prefetch the same selected-symbol/interval candle query, using the
existing transport, cache key, cancellation and freshness budget. Preparation
does not mount Scanner or start analysis, positions, streams or orders.

A warmed Scanner renders synchronously. A cold visit uses a local route-loading
shell instead of leaving the entire router suspended after the module is ready.
That shell is **not** evidence of correct candles or completed analysis.

Desktop sidebar, command-palette and mobile navigation use the same warmup.
Permissions, source evidence, freshness checks and trading gates were not relaxed.
No dependency versions, auth hooks, API/job settings, credentials or database
schema were changed.

## Final combined-source validation

| Check | Actual result |
| --- | --- |
| Complete frontend suite | **169 files passed; 2,412 tests passed, 9 skipped, 0 failed** |
| Root library/API/frontend/scripts typecheck | **Passed**, exit 0 |
| Frontend production build | **Passed**, exit 0; large-chunk warning retained |
| CI guards | **87/87 passed** |
| Master live-bridge binding syntax fixtures | **7 assertions passed** |

These are this combined workspace's actual counts, not a transcription of the
upstream-reported 2,417 passes. No assertions or skips were changed to match an
expected number. The entire frontend suite ran against the final combined source.

Checks used the prior credential-free offline subprocess harness with external
network blocked and an unusable fixture DB target. No existing database was
queried/migrated or used as a test fixture. No broker live/demo tests or orders
were run. Build/typecheck/guard jobs all finished before browser measurement.
Only the development frontend workflow was restarted; API/jobs were untouched.

## Real preview measurement

The measurement brief and sanitized raw results are retained in:

`generated-artifacts/arx-scanner-navigation-validation/`

The target is the actual shared Replit development preview, which serves Vite
development modules, not the separately validated production build.

The controlled upstream offline 460.1ms to 129.9ms median and 34.7–37.6ms chart
container observations are **not measurements of this preview**. There is no
measured pre-change preview baseline from which to claim a percentage reduction.
An empty canvas, spinner or route shell is not a successful timing result.

### Result: warm navigation observed; immediate-first-click acceptance incomplete

Six initial first-navigation samples were retained. They are **not valid
immediate-after-reload/cold-click acceptance**: onboarding/tool orchestration left
26.6–54.9 seconds between navigation-ready and click. Idle module preparation
therefore had ample time. The following are real *warm first-navigation*
observations, not a claim that the owner's five-second path has been fixed.

All times below are milliseconds except the reload-to-click column:

| Sample | Reload → click (s) | Click → heading | Click → controls | OHLC/canvas candidate | Analysis-content visible | Candle GET duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Desktop D1 | 55.504 | 272.6 | 272.7 | 717.9 | 718.0 | 319 |
| Desktop D2 | 27.230 | 287.2 | 287.3 | 799.4 | 799.5 | 400 |
| Desktop D3 | 29.860 | 283.3 | 283.4 | 698.8 | 698.9 | 324 |
| Mobile M1 | 33.639 | 275.7 | 275.8 | 782.8 | 783.0 | 357 |
| Mobile M2 | 38.286 | 267.0 | 267.0 | 672.5 | 672.5 | 325 |
| Mobile M3 | 31.171 | 251.6 | 251.7 | 703.1 | 703.2 | 336 |

These row names M1/M2/M3 identify **mobile samples, not chart intervals**.
Every sample used V75/M15. All six real candle GETs returned 200.
Desktop controls median: **283.4ms**; mobile: **267.0ms** (3 observations each).
OHLC/canvas-candidate medians: **717.9ms desktop**, **703.1ms mobile**.
They are not verified first-correct-paint medians or a sub-100ms target pass.

#### Readiness definitions and failures

- Heading/controls and OHLC/canvas times are passive DOM-observation marks.
  Canvas existence and OHLC content alone are not proof of painted, fresh,
  correct candles.
- The analysis-content predicate was a visible `smart-chart-reader`, “Closed
  candles only,” a confirmed/developing pattern button and a visible explanation
  longer than 80 characters. Its timestamp records displayed chart-reader
  content, **not completion of every server/AI analysis request**, and does not
  prove candle paint or fresh/live trust at that instant.
- Later screenshots/pixel observations showed populated V75/M15 candles and
  original public Deriv feed/OHLC evidence. Some initial views were
  Historical-only before later Live-confirmed observations. The exact first
  *fresh, correct candle paint* timestamp remains **unverified**.
- Scroll was delayed about 9.66–11.62 seconds after click in the initial pass;
  pixel verification happened at 24.817–36.371 seconds. These are delayed
  observation bounds, not rendering latency. D1 and M3 pixel checks exceeded
  the 30-second budget and remain recorded as late.
- The original D1 CSV says its visual screenshot was outside budget, while
  the tester's prose says every screenshot was within budget. Timestamp proof
  did not resolve that discrepancy. Both raw claims were preserved; **this
  report does not certify D1's screenshot as within-budget**.

#### Bounded correction attempts: 0 valid of 2

After identifying the late-click bias, one additional sample per viewport was
attempted, using a fresh normal QA session and one batched interaction sequence.
The original six rows were not overwritten or selectively removed.

| Attempt | Actual result |
| --- | --- |
| Desktop | Full reload confirmed; Welcome overlay blocked usable Scanner navigation. The runner probed before Close mounted. No Scanner click/candle GET; **invalid**, not proof of an app latency |
| Mobile | Reload-to-click **8,197ms**; usable-nav-ready-to-click **676.5ms**, above the requested 500ms measurement criterion. Batched chart-scroll observation failed before marks were saved; **invalid** |

The mobile correction still obtained real V75/M15 GETs (200; 331, 340, 380, 327,
378 and 325ms). Its page remained open during cleanup, causing automatic polls
at +30.544s, +45.952s, +61.286s and +76.669s after click. Those were late and were
not counted as timed acceptance observations. No timed pixel verification was
captured. Its screenshot showed Historical/read-limited while the later DOM
snapshot showed Live-confirmed: partial snapshots are not a valid first-paint
measurement. No additional retries were performed.

Therefore the importer/code checks passed, but **the immediate-after-reload
performance acceptance did not pass**. No instant-loading, exact first-candle
timing, or sub-100ms completed-candle claim is made.

### Actual request/module evidence

- In the six warm samples, candle requests began 0.63–0.70s before click and
  completed 0.27–0.38s before click. This supports navigation-intent prefetch
  operating; it does not prove a cold-click data-latency target.
- Scanner-related module reads were already complete before those delayed
  clicks. The correction contexts retained 608/609 module-graph request entries
  (374 distinct paths each), but neither produced a valid cold-click paint
  measurement. A cold-module critical-path duration is not established.
- For example, real `/api/market-heat` reads in D1/D2 took **12,272ms/9,614ms**.
  These are long API reads, not proven causes of chart arrival: chart-reader
  content was observed earlier. The provider versus server-internal contribution
  was not isolated. Long-lived account SSE durations are not treated as blocking
  request latency.
- Candle Resource Timing entries were unavailable; request/response events
  supplied candle timings. Some resource paths were recorded as invalid URLs;
  request-event paths remain available. No attribution is invented from those
  invalid resource entries.
- No explicit cache flags were changed. Browser request routing was used, so
  normal HTTP-cache behavior is not independently certified; Vite/server/provider
  caches were not cleared. There is no controlled before/after preview baseline.

### Write blocking, authentication and cleanup

Before every measured context's first navigation, an all-origin route allowed
only GET/HEAD/OPTIONS and locally returned **451** for mutations. The initial six
samples blocked **22** attempts; correction mobile blocked **5** more, including
late alert polls. These included activity-ping, chart-ai-alert scan and scalp
focus. They were **not forwarded**, and no analysis/trading action was clicked.

Only each QA session's normal exact-origin logout was subsequently allowed.
Logout returned 200 and identity returned expected 401; contexts were closed and
temporary private session material removed. A Vite “Object is disposed” overlay
was observed after the initial logout; authentication revocation was independently
confirmed. Its cause/baseline was not established or silently fixed.

All raw samples, late observations, errors, network summaries and screenshot
references remain in the ignored evidence directory, including
`correction-samples.json` and `correction-methodology.md`. No further browser
actions were performed after those two invalid correction attempts.

## Preserved prior limitations

The historical chart acceptance report remains:
`ARX_PR103_SMART_CHART_DEVELOPMENT.md`.

- M2 previously remained loading/no-data; availability was not established.
- Zoom/pan controls were exercised, but real-browser range change was inconclusive.
- Minor mobile assistant overlap at the Study-panel edge was observed.
- Onboarding hydration warnings and unidentified `/live-manual` resource 404s
  were observed.
- The previous browser acceptance pass allowed an existing automatic alert-scan
  POST that can persist user chart-alert state/notifications. Its actual DB
  effects were not queried or undone; zero ordinary application writes from
  that earlier pass remain uncertified.

New measurements must block all non-GET/HEAD/OPTIONS requests before any page
navigation, separately record the attempts, and never reinterpret the historical
unblocked POST as blocked retroactively.

## Scope boundary

No publishing/republishing, GitHub merge/push, production change, database/schema
migration, credential change, worker/trading enablement, emails, broker testing
or orders were performed. Normal QA login/logout bookkeeping is distinguished
from blocked automatic browser mutations. Browser-local preference setup does
not change server/account preferences.
