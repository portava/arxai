# Smart Chart round-3 browser acceptance — 28 October 2026

Application/check source: **`c9402b5b611058740a49849ecfae598ded03095a`** on unmerged `claude/pr99-round3` base `0b519bd8ec5a655f9b134005e546e38e14e64b97`. This continuation does not integrate that upstream branch into PR 99, PR 100 or main. Documentation appended after this application commit does not change the tested source.

**Focused checks pass; competitive and release acceptance remain incomplete.** No broker, account connection, existing database, worker or trading operation was used. The automatic reader withholds its narrative in this fixture because usable source evidence is absent; this run is not a reader-truth certification.

## Change

Heikin Ashi's averaged candles, the baseline's first-loaded-close reference and hollow-candle colour/fill rules now have visible explanations beside the style controls, including on mobile. Each chart's selector references its own explanation for assistive technology. Standard candles do not acquire an unnecessary note.

An independent review caught an omitted first-bar hollow-colour exception, an insufficient OHLC test witness and a daily-zone check that observed controls only. All were corrected. The new browser check now requires complete O/H/L/C values and inspects actual daily UTC and intraday New York legend timestamps.

## Evidence tied to source

| Check | Result |
| --- | --- |
| Existing base `0b519bd8` | 436 focused tests; seven-style development workbench passes. These are baseline receipts, not candidate results. |
| Candidate `c9402b5b` | 437 tests across 15 files, no failures/skips; dashboard typecheck passes after workspace declarations build. |
| Repository guards | 87/87; separate bridge-binding syntax fixture 7 assertions passes. |
| Production dashboard build | Pass with `PORT=4180 BASE_PATH=/ NODE_ENV=production` and `--configLoader runner`; verified current explanation text in this checkout's built output. Existing large-chunk warnings remain. |
| Production fixture | Build `7168a27029cc5359`: minified production React/chart libraries, clean `c9402b5b`, no changes during build. Development-marker checks pass. |
| Seven-style production browser workbench | Pass: canonical OHLC / separately labelled HA OHLC, five studies, drawings, undo/redo, templates, reload/instrument/timeframe persistence, PNG export, two-chart independence, pane cleanup and mobile touch placement. Zero page exceptions. |
| New style/time-zone browser check, development and production | Pass: visible/associated style explanations; unchanged OHLC through Tokyo/New York/London/UTC; go-to instant preserved; DST gap rejected; D1 inspector stays midnight UTC; M15 returns to New York labels; canvas retained; preferences survive reload; no horizontal mobile overflow. Zero page exceptions or external HTTP requests. |

Machine-readable results, raw focused-test/guard logs and production-build identity are under [validation/chart-round3-20261028](validation/chart-round3-20261028/receipt.json). Full local logs and screenshots, including failed setup attempts, are retained at `/Users/areyouok/arx-tier1-release/chart-round3-acceptance-20261028/`.

Initial attempts requiring local listening/IPC were denied before checks, then passed with authorized local access. The first dashboard-only typecheck lacked generated workspace declarations; the prerequisite library build resolved it. The initial dashboard build lacked required environment settings; the configured build passed. None is silently counted as a passing attempt.

## What this does not prove

These are isolated synthetic browser fixtures, not the authenticated Scanner/Smart Chart application, production quotes or a competitor workload. `selectOption` is functional automation, not trusted click timing. Adapter ingestion timings in workbench output are synchronous processing only; they are not completed-frame latency. No new speed, 100 ms interaction, sustained 60 fps or TradingView/MT5 parity claim follows.

At 390×844 the page has no horizontal overflow, but the controls still push the chart below the first screen. Mobile usability remains an explicit gap. Existing replay/timeframe latency failures, held performance experiments, session/countdown, broader intervals, drawing/study catalogs, custom scripting, volume semantics, alert delivery, cloud workspaces and matched competitor performance remain open. No combined PR 99/100/101/102 release matrix was run.

The official references were rechecked on 28 October: [TradingView Heikin Ashi](https://www.tradingview.com/support/solutions/43000619436-understanding-heikin-ashi-charts/), [TradingView baseline](https://www.tradingview.com/support/solutions/43000690232-baseline-charts-explained/) and [MT5 chart configuration](https://www.metatrader5.com/en/terminal/help/charts_analysis/charts). ARX's baseline is the first loaded close; it does not reproduce TradingView's viewport-height baseline. Documentation comparison is separate from browser/performance evidence.

Next: improve mobile access to the chart, validate exact-source integrated-page completion witnesses, and rerun controlled latency measurements before accepting any performance change. Preserve the owner's full analysis/pattern requirements and all unresolved comparison rows.
