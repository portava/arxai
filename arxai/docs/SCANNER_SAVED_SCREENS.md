# Scanner saved views, watchlist scope and exports

Date: 2026-10-26. This frontend slice is stacked on scanner integrity PR #79 (`e2772eff`). It does not change the scan engine, trading controls, server schema or watchlist write API.

## Existing controls and the gap

Symbol Explorer already owns canonical symbol selection, browser favorites and recent symbols. The scanner page owns the universe, and the scan response owns its timeframe. The account Watchlists page already provides private watchlists. The Opportunity Map had categories and refresh controls, but no reusable filter view, watchlist result scope, explicit sorting or export.

This slice reuses those ownership boundaries. A saved view does not launch a different universe scan, change the timeframe, update a watchlist or select a chart. Its watchlist scope is an intersection with the current scan's returned rows. Symbols outside that scan and skipped watchlist symbols are reported separately; the original scan coverage count is unchanged.

## Implemented behavior

- Filter returned rows by symbol/name, existing watchlist, readiness, direction, data availability and minimum edge heuristic. Sort within readiness groups by edge, entry quality or canonical symbol, with deterministic ties.
- Save, replace, open and delete up to 20 named views in this browser. Names and filters are validated and bounded. Only filters, watchlist ID and original context labels are stored; no market results or account/watchlist contents are saved. Views are not cloud synchronized or automatically applied on reload. Opening one under another universe/timeframe explains that the current scan remains selected.
- A deleted, loading or failed watchlist scope shows no rows until it can be checked. A failed read does not reuse cached membership. Resetting to all scanned symbols restores the original result scope.
- A filter cannot infer a hidden stale direction, readiness category or score. Expired rows remain context-only under the existing 30-second policy, including manual/one-minute refresh modes, cached response reads, restored saved views and selected-chart feed caps. Optional supplied row timestamps are checked independently; the current API does not supply them.
- Best-pick cards and comparison candidates must exist among the visible confirmed rows. Numeric comparisons also require the selected baseline to remain visible and confirmed; otherwise the whole comparison is withheld. Filtering never invents a replacement “best” candidate. Invalid metric fields are omitted from cards and CSV.
- An expandable explanation identifies edge and entry as heuristics and feed as data readiness. None is a win probability, measured alpha or a promised fill. The API has no per-factor score breakdown, so the UI does not manufacture one.
- Export exactly the currently matching rows, with another freshness check at the click boundary. The CSV separates original scan time, optional original row time and export time. Missing row timestamps stay blank. Limited rows retain their availability limitation and server live-data flag, with direction, category, reason and scores blank.
- CSV fields are quoted and embedded quotes escaped. Potential formula text, including leading invisible characters and full-width formula prefixes, receives a text prefix. This mitigation targets the generated file; it is not a guarantee about arbitrary spreadsheet applications or files subsequently edited and re-saved.

## Verification

- 264 scanner frontend regression tests pass, including 34 pure screen tests and 54 map render/interaction tests. The new cases exercise watchlist alias membership without fuzzy prefix expansion, missing/deleted/failed scopes, stable sorting, filter intersections, original timestamp identity, stale-value suppression, selected-chart caps, saved view limits and malformed data, storage refusal, cross-context loading, filter expiry/recovery, both-participant comparison caps and formula neutralization.
- Full workspace typecheck and the production dashboard build pass. The existing large-chunk warning remains.
- All 87 architectural guards pass. The new pure test file is included in the existing `test:scanner-truth` script.
- The isolated browser fixture exercises 1440px desktop and 390px mobile layouts, keyboard tab order, watchlist coverage, save/reload/load/delete, sorting, search, expiry and real browser CSV downloads. No horizontal mobile overflow or page errors were observed. Downloaded files were parsed independently: two filtered rows retain original scan time; six expired rows contain no hidden signal metrics.
- Fixture data is explicitly invented and no market provider, API server, database or broker is connected. This is not live/demo validation, account-to-account production testing, or a performance comparison with another product.

Browser harness: `scripts/scanner-qa/server.mjs` (`SCANNER_QA_PORT=4183`) and `scripts/scanner-qa/saved-screens-acceptance.js`. External evidence: `/Users/areyouok/arx-tier1-release/scanner-saved-screens-20261026/receipt.json`.

## Primary references and practical limits

TradingView documents saved screens, filtered CSV exports, configurable filters/sorting and selectable refresh intervals in its [screeners walkthrough](https://www.tradingview.com/support/solutions/43000718885-tradingview-screeners-walkthrough/). These informed the workflow additions; this implementation does not claim TradingView's market coverage, data entitlements, financial/technical filter catalogue, custom scripting, cloud synchronization or equal-data latency.

[OWASP CSV Injection](https://community.owasp.org/attacks/CSV_Injection) describes formula-leading text, separator/quote escape risks, full-width variants and spreadsheet re-save limitations. Those cases inform the export regression fixtures. The exported scores remain the ARX heuristics audited in `SCANNER_SIGNAL_INTEGRITY.md`; validation does not establish predictive or profitable trading performance.
