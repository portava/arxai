# Admin account money consistency — 1 November 2026

Status: offline development fix validated, not deployed. Instant MT5-to-ARX equality and launch readiness remain unproven.

Application commit: `2f727dbef2b323217ce1fc614c40cbbee2572e8e`, based on `660394f66084aeeb8fb7d43745fe14ed81b11e0b`.

## What changed

The admin Shared Bridge Pool card displayed older pool scalars as MT5 balance/equity, assumed USD and two decimals, substituted zero for missing margins, and displayed heartbeat-derived FRESH beside money. It could disagree with the cockpit's native report.

The card now uses the existing canonical shared-account query and NativeAccountReport component, gated by explicit masterAccess. Native balance, equity, account P/L, credit and margins preserve the terminal's currency and decimal text. Missing/rejected reports and failed refreshes cannot fall back to old pool money. Observation age advances through the existing component; a heartbeat cannot renew it. Current state remains explicitly unverified.

The separate allocation projection retains its existing controls, mutation paths and execution rules. Stored allocation values are labelled as records with unverified currency/freshness, not broker funds. Missing/nonfinite values remain unknown; zero is displayed only when actually supplied. Failed or rejected pool reads cannot retain reassuring cached figures. The HTTP reader now checks status before accepting JSON. No claim is made that independent native and allocation reads capture the same instant or account binding.

This is a display consistency change, not a change to MT5 reporting cadence, order dispatch, settlement, cross-process transport, or confidence policy. The native section shares the existing cache and change-hint refresh path; its existing three-second polling fallback is not an end-to-end delivery guarantee.

## Evidence

- Corrected baseline fixture: eight failures and two passes on baseline application plus a test-only export. The initial ten failures were caused by an overly broad query mock; that failed run is retained, not counted as product defects.
- Initial focused five-file check: 111 passed. Six further missing/nonfinite/zero/rejected-pool cases were then added.
- Final full dashboard suite on the committed source: 3,877 passed, zero failed, 11 skipped. All 16 new regression cases included.
- Dashboard typecheck and production build passed; shared declaration build passed. Existing large-bundle warning remains.
- Guards: 85/87, with the exact same failure blocks as the prior FVG validation (38 risky-wording and three internal-name findings). No guard weakened.
- Independent review pinned the application hash to the exact commit and found no scoped blocker. Existing Recompute dialog wording still says it re-reads an MT5 snapshot; this is a recorded copy limitation because the action recomputes stored inputs, not a fresh terminal observation.

Logs, failures, review and manifest: `docs/validation/admin-account-report-20261101/receipts.tar.gz`, independently read back and SHA-256 checked. Raw files: `/Users/areyouok/arx-tier1-release/admin-account-report-20261101/`.

No browser acceptance, broker/terminal execution, latency measurement, database-backed integration or full root CI was run in this slice. The tests use synthetic reports and mocked reads; they do not prove present production correctness.

## Still required

1. Resolve the separate My Account page contradiction: its shell-derived equity can appear beside canonical allocation equity that is correctly withheld. Personal MT5 P/L also requires tracing away from paper-trade data. Audit: `/Users/areyouok/arx-tier1-release/account-native-report-audit-20261101/remaining-monetary-ui-audit.txt`.
2. Extend native scoped reports to remaining appropriate monetary surfaces, including margin-level units, without exposing master money to ordinary users or treating allocation accounting as broker funds.
3. Complete report ordering/producer continuity/clock verification and disposable-database concurrency checks. Preserve explicit uncertainty until proven.
4. Implement and validate distributed update delivery; current process-local hints plus periodic recovery are insufficient to claim immediate cross-server updates. Measure capture, receipt, persistence, push and rendered-update timing, retaining tails and outliers.
5. Validate the exact combined source and obtain separately authorized runtime acceptance before claiming real-time MT5 agreement. No Replit update, deployment, existing database change, main merge, trading, worker activation or broker test occurred.

The unfinished Scanner draft-binding changes remain preserved in their original worktree and are not included in this commit. All Smart Chart, Truth, self-trading, Profit Mission and TradingView/MT5 comparison gaps remain open as previously recorded.
