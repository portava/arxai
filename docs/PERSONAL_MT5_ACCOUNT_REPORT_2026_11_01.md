# Personal MT5 monetary report — 1 November 2026

Application commit: `4d95fb3348bee9c51e7aaf7bdb13457178e7e227`, based on `d2520157`.

Development source only; not deployed, not release-green and not proof of immediate terminal-to-screen synchronization.

## Problem and repair

The MT5 Bridge page displayed legacy stored connection scalars without a matching account observation. Its shared-summary fallback also referenced top-level monetary fields that do not exist in that response. A current heartbeat could therefore coexist with old money and a made-up account-sync success message. Refresh failures could leave cached values visible as though current.

The existing authenticated status route now attaches the existing native account report for exactly the signed-in user's selected connection. A defensive owner check prevents a mismatched connection from being read. It never looks up the pinned master account, never changes allocation or execution gates, and never substitutes legacy stored scalars when the report is absent, rejected or unreadable.

The page reuses the existing NativeAccountReport component and shows the six native fields: balance, equity, account P/L, credit, used margin and free margin. Decimal text and terminal currency precision survive without a floating-point round trip. Zero equity remains zero; native profit is not inferred from equity minus balance. The report retains observation/receipt times, ages locally, explicitly marks current state unverified, and withholds figures after a failed request. Switching to a connection without a report clears the previous figures.

Personal funds and ARX recorded allocation remain separate. The page removes the invalid shared-money lookup, duplicate unqualified P/L tile, default-USD allocation formatting, and synthetic account/position-sync activity. Unknown position counts are not derived from the status route's placeholder empty list. The optional generated contract accepts the actual disconnected/stale response values and nullable account snapshot.

## Validation

Independent source review is clear and source hashes are retained. Focused results are eight new route/schema tests, 62 tests in the existing account-snapshot lane (including those eight), and 41 page/native-display tests. The latter includes nine new page cases and 32 existing report cases. These overlap broader checks and must not be summed as unique coverage. Both API/dashboard typechecks and builds pass on the application commit. Full dashboard on that exact commit: **4,082 passed, 11 skipped, zero failed**; 236 files passed and one skipped. Architecture guards: **85/87**, retaining the prior 38 wording and three internal-name findings. The source-bound helper checks also pass. Existing frontend chunk warnings and the synthetic DOM navigation warning remain in logs. No full root-CI/database lane or authenticated browser/terminal test was run for this slice.

The guard CLI first failed before scanning because its local IPC pipe was unavailable; an explicit Node loader rerun also initially failed to resolve the loader. Both failures are retained. The final direct guard execution passed 85 checks and reports the two existing failure groups; those failures are not relabeled green.

The route tests execute the real handler's extracted source with inert dependencies, including ordinary-user ownership, hostile connection identifiers, no connection, mismatched owner, rejected reports, stale/no heartbeat, failed reader and generated-schema preservation. The page tests render the real page and existing report component, including large exact decimals, negative P/L, zero equity, rejection, stale observation, refresh failure, heartbeat-only evidence and account changes. These are not live HTTP, database or terminal acceptance.

Initial failing tests are retained. Initial schema/typecheck failures resolved to an old checkout through shared dependency links; isolated dependency overlays and local declarations corrected the test environment without changing the base checkout or installing packages. Later logs are distinctly named rather than overwriting those failures.

## Remaining requirements

- Personal status still polls every five seconds, with no new event invalidation or full-response recovery deadline in this slice. This repair removes misleading money presentation; it does not make that path immediate.
- The native EA reports changes on a one-second capture cadence; synchronous terminal work and transport can add delay. No terminal-to-screen timing has been measured here.
- Process-local notification delivery, distributed continuity, competing producers, verified clock/ordering and complete monetary surface reconciliation remain open.
- Other consumers may still read legacy status scalars. The page still contains unrelated heartbeat-derived route/market/position readiness wording; this is not a complete Truth audit of that page.
- ARX allocations and paper/strategy P/L are different scopes from the entire MT5 account. Agreement must be checked for the same account, observation, currency, precision and field definition.
- No main merge, Replit update, deployment, existing database operation, worker activation or live/demo broker test occurred. TradingView/MT5 parity, architecture completion and universal accuracy are not claimed.

Raw validation: `/Users/areyouok/arx-tier1-release/personal-account-report-20261101/`. Repository manifest/archive: `docs/validation/personal-account-report-20261101/`. This branch is based on `d2520157`; the separately saved native-study renderer source `650c4728` is not included or jointly validated here. Preserve both when integrating the next development checkpoint.
