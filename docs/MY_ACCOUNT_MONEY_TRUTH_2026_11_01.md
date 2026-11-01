# My Account monetary display — 1 November 2026

Application source: `c003bcb07fa260072def41a71fee80030ce6656b` (based on `56d1b42c`).

Development source only. This change does not establish real-time MT5 equality or make the application release-ready.

My Account previously showed the canonical allocation panel withholding equity while an adjacent card displayed an unrelated account-shell calculation as “My Equity.” The shell calculates allocated principal plus a stored virtual P/L amount; its personal-account open P/L comes from paper trades. Neither supplies a complete native broker account report.

The page now keeps the existing canonical allocation panel and removes the duplicate shell balance, equity and margin tiles. Assigned allocation, sleeve settings and recorded headroom are labelled as stored allocation settings. Missing assigned allocation no longer borrows a calculated balance. Recorded results distinguish shared allocation P/L from paper open P/L, including in Personal MT5 mode. Finite recorded amounts retain their numeric precision without an invented dollar currency; absent/nonfinite amounts stay unavailable. Personal/demo views explicitly state that broker account amounts are unavailable in this view.

The existing personal Bridge V2 status endpoint exposes redacted status, not a monetary report. No speculative endpoint, master-account fetch, source selector or new money calculation was added. Existing authorization, risk limits, bridge-preference controls, one-click controls and execution gates are unchanged.

## Validation

Work started from `56d1b42c`. The actual-page regression suite failed 9 cases before the change, with 2 existing-behavior cases passing. After the change, all 11 passed. The page plus existing canonical allocation/native report component suites passed 61 tests across 3 files. Tests use offline hook/query doubles and real rendering of the canonical allocation component; no account or broker was contacted.

The first dashboard typecheck failed because this isolated worktree lacked the generated domain fixture declaration, with two consequential implicit-any errors in an unchanged benchmark. Local `tsc -b lib/domain` generated declarations; the unchanged dashboard typecheck command then passed. Initial failure and successful rerun are retained under `/Users/areyouok/arx-tier1-release/my-account-money-truth-20261101/`. Root independently reviewed the page diff against the account-shell branches and found no scoped blocker. The dashboard production build passed on the same frozen source (existing chunk-size warning retained). The full frontend suite, full root CI and browser acceptance were not run in this slice.

Separately, existing native account refresh/render tests passed 49/49 and the actual stream route scheduling harness passed 13/13 on base `56d1b42c`. These suites overlap the 61-test lane and must not be summed as unique coverage. They use isolated transport/persistence seams, not a real terminal-to-screen measurement.

Architecture guards: 85/87 passed; both failure blocks are byte-identical to the prior draft-binding baseline (38 risky-wording and 3 internal-name findings). Two preliminary invocations failed due to missing dependency links before the guards ran; logs are retained.

## Remaining limits

- Personal native account reporting and account-to-screen latency remain open; this correction does not implement them.
- The canonical allocation component and risk settings retain existing currency formatting. This slice does not establish currency or monetary agreement across all ARX surfaces.
- Backend account-shell `equity || balance` and paper-derived personal exposure remain unchanged. The repaired page no longer uses that shell equity as an account figure. Other consumers need separate review.
- Recorded performance totals have no completeness or currency proof here. Their explicit qualification is preserved; they are not presented as native account profit.
- No deployment, main merge, migration, database operation, terminal/broker test, worker activation or trade occurred.

## Immediate-update acceptance still required

For the same selected broker account and report, each money surface must preserve native currency/precision, balance, equity, account profit, credit and margins. Broker account profit must not be reconstructed from equity minus balance or a subset of positions. Changes by another trader, deposits, withdrawals, closures and mark-to-market updates must enter the same reporting path. Newer rejected or unverified evidence must not promote older amounts to current.

Existing development code captures native account values on a one-second schedule, marks all account trade transactions dirty, publishes a hint after receipt persistence, and rereads the canonical report for mounted owner money views. The notification bus is process-local; three-second stream reconciliation and five-second summary polling are recovery paths, not instantaneous cross-process delivery. Existing synchronous terminal work can delay capture/transmission. Clock quality and producer continuity remain unverified. No latency maximum, broker equality or real-time completion is claimed.
