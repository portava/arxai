# Cockpit and confirmed funds — 31 October 2026

Owner scope: continue launch-readiness while the owner is away, improve cockpit and real-time funds, submit an approved order promptly, and update funds promptly after confirmed fill/close. The owner selected **both** submission and funds updates. This authorizes development, not deployment or broker operations. The wider Smart Chart goal remains active.

## Saved changes

Base: PR103 development source `40286374d21f8d2173594dd7868cb94d7208d5b7`. Isolated branch `codex/cockpit-funds-latency-20261031`. Safety PR102 and self-trading PR100 are separate and must be reconciled before release.

- `4b40602f`: reject obsolete fallback responses and retired stream callbacks; cancel fallback on a replacement snapshot; bound reads to ten seconds and avoid stacking requests. A heartbeat cannot upgrade canonical balance freshness. Missing canonical funds retain last-known values as stale; a mode change cannot retain an old live block without new evidence. Refresh requests use a counter rather than millisecond timestamps.
- `9e013583`: initial, event-driven and periodic server reads use one serial scheduler. An event during a read earns one trailing read. Subscribe before the initial read and register disconnect handling before asynchronous setup. Preserve the 250 ms minimum start gap and three-second fallback; no parallel reads finishing out of order.
- `d245b285`: review correction keeps fallback requests alive while a replacement stream is only connecting, and prevents repeated stream errors restarting the same request. Actual snapshot arrival remains the recovery authority.

No money math, reservation policy, order dispatch gates, credentials, database contents or activation settings were changed. These changes have **not been installed in Replit**.

## Evidence on d245b285a3f74fefcad9f0f47c7f78a1f7326244

| Check | Result |
| --- | --- |
| Full frontend suite | 2,444 passed, 11 skipped, 0 failed; 170 files passed, one opt-in benchmark file skipped |
| Focused account hook (included above) | 22 passed |
| Server scheduler and extracted actual-route tests | 10 passed |
| Workspace library compilation | Pass |
| API and frontend typechecks | Pass |
| API and frontend production builds | Pass; existing warnings retained |
| Guards / bridge binding assertions | 87 / 7 passed |

This is not a complete root CI, database integration, browser paint, terminal or broker validation claim. The server route tests execute the actual route body with mocked data and transport seams. They do not prove authentication middleware or database correctness; those implementations were not changed. Scheduler fake-clock tests prove ordering/coalescing and minimum-gap behavior, not real-world network latency.

Failures retained: five initial transport regressions failed on the original hook; four freshness regressions failed before the canonical fix; four actual-route scheduling regressions failed on the prior route; two recovery regressions failed on the intermediate source and prompted `d245b285`. The first scheduler invocation lacked the local esbuild override and failed before tests; the configured run passed. An initial baseline route test awaited the old route during a simulated closed connection and had to be terminated; the corrected bounded baseline run completed with all four expected failures. The first frontend typecheck on the fresh worktree lacked generated domain declarations; building the existing dependency resolved it without source changes. All receipts, including failures, are retained.

## Refresh controls and evidence expiry — checked af002a34823fcd24f6ed1f2f56645a182ddbf470

- `c05b94b2`: auto-refresh Off now closes the shared account stream and cancels polling, retries and stale-heal work. Refresh while paused performs one bounded read; On reconnects. Controls across mounted readers share the preference. Removed the wrapper's independent five-second reload and 250 ms countdown. Refresh progress follows actual transport work; a heartbeat-only connection cannot hold the spinner forever. This controls **account data**, not all unrelated page queries.
- `7c5bcf87`: retained evidence expires without another message. One timer targets the next freshness boundary rather than rerendering the whole page every second. Heartbeats cannot renew data; monotonic elapsed time prevents backward clock changes rejuvenating it, while visibility restoration catches sleep. Positions and canonical funds age separately and never improve a server verdict. Missing or inconsistent canonical age evidence is unavailable. No financial amounts are changed. Paused/stale funds say **Last-known equity**, and missing trade counts say **—**, not zero.
- `af002a34`: account display bands are now shared by server and browser, with the same 5 s / 30 s / 120 s values. The architecture guard requires exactly those three constants in the pure shared module, forbids extra code/thresholds there and requires the server re-export. Execution/heartbeat policy is unchanged. Eight positive/negative fixtures check the new authority constraint. The checked-time display uses an absolute local time so a stopped clock cannot leave “just now” stuck on screen.

| Check on af002a34 | Result |
| --- | --- |
| Full frontend | 2,475 passed / 11 skipped / 0 failed; 172 files passed, one benchmark file skipped |
| Focused transport, presentation, aging and canonical panel tests (included above) | 71 passed |
| Server scheduler / extracted actual-route checks | 10 passed |
| Library compilation; API, frontend and scripts typechecks | Pass |
| API and frontend builds | Pass, existing warnings retained |
| Architecture guards / bridge bindings | 87 / 7 passed |
| Offline actual-app production browser | Desktop and 390 × 844 mobile account controls pass; actual paused-data expiry observed |

Browser fixture `488f3a7896ad1dbe` was built from clean `af002a34` and remained unchanged. One manual paused Refresh made exactly one account GET; closed streams could not change the figures; On reconnected one shared stream; final pause retained $1,456 and transitioned to Stale without another account request. Five **synthetic** streamed equity changes reached DOM in 3.4, 0.7, 0.7, 0.6 and 1.3 ms; delivery through two animation frames was 34.8, 32.5, 32.5, 32.8 and 31.2 ms. These are small-sample local event-to-render observations, **not hardware paint, broker latency, network acceptance or a competitiveness claim**. There is no pre-fix paired performance baseline for this batch.

Three automatic mutation attempts were intercepted and denied; no writes were forwarded. Other unfaked reads returned unavailable/503, generating expected console resource errors; there were no page exceptions. Screenshots were visually reviewed. Desktop capture caught existing hero/position entrance animation before content settled; mobile later shows the contents. This is account-control acceptance, not complete cockpit acceptance: unrelated cards still show reassuring empty-state language under unavailable fixture data and require an honesty review. Browser reload persistence and physical-device behavior are not accepted here; deterministic hook tests cover stored preference and visibility behavior.

Failures retained: six control regressions before implementation; six obsolete wrapper expectations after control ownership moved, replaced with real transport tests plus presentation-only tests; five new aging regressions before implementation. An initial aging run resolved workspace domain imports through another checkout and failed 11 tests; isolated local package links corrected that environment without modifying the other checkout. At `7c5bcf87`, frontend/build/typechecks passed but the architecture guard correctly rejected the moved constant authority (86/87). `af002a34` adds strict authority validation and passes all 87 guards. A guard-edit script was initially invoked from the wrong working directory and made no changes; rerunning from the repository root applied it. All intermediate receipts remain alongside final results. Full root CI and database integration were not run.

## Launch blockers and next work

1. Reconcile and selectively install the approved cockpit changes into Replit development without overwriting newer safety/backend work; none of this PR's changes is installed there yet. Repair and repeat the real first-navigation acceptance method (see Scanner outcome below).
2. Unify partial poll fields and canonical figures: `slot-summary` retains prior position details and some null fields; currency is still hardcoded on the canonical panel. A paused manual refresh is not proof of a complete positions refresh. Storage-denied preferences may revert on route remount. Audit the remaining cockpit cards' unavailable/empty-state language and animation delay.
3. Trace one-click submission through gates, EA pickup, result persistence and account refresh. Shipped v154 defaults `PollIntervalSeconds = 5`; synchronous heartbeat/snapshot HTTP calls precede polling. `OnTimer` uses `TimeCurrent()`, which is last quote time outside OnTick, so quote silence can stall cadence. This is a source-derived risk, not terminal evidence. Official references: [TimeCurrent](https://www.mql5.com/en/docs/dateandtime/timecurrent), [synchronous WebRequest](https://www.mql5.com/en/docs/network/webrequest), [millisecond timer and queued-event limits](https://www.mql5.com/en/docs/eventfunctions/eventsetmillisecondtimer). No EA edits or broker tests in this batch; blindly reducing an interval does not establish reliable fast execution.
4. Confirmed-result propagation is still process-local; three-second fallback remains. The current event bus wraps the entire emit in one try/catch: a throwing early listener can prevent later listeners receiving that event. Add a failing regression and isolate callbacks before changing this path. Verify notification coverage after authoritative writes; a received/ACK result is not permission to invent new available funds.
5. Reconcile PR102/PR100 and Truth work before any launch verdict. Native terminal and end-to-end broker performance remain unproven and unauthorized here.

Refresh/aging receipts: [manifest](validation/cockpit-refresh-controls-20261031/manifest.json), [browser result](validation/cockpit-refresh-controls-20261031/af002a34-browser-result.json), [mobile stale state](validation/cockpit-refresh-controls-20261031/cockpit-refresh-mobile.png). Raw logs: `/Users/areyouok/arx-tier1-release/cockpit-refresh-controls-20261031/`.

No launch-ready, TradingView/MT5 parity, guaranteed fill speed, or architecture completion claim. A queued command stays pending; available funds must never be released on a mere click or acknowledgement.

## Scanner work running separately

The navigation update finished at clean Replit development checkpoint **619f259db5f265a379190de42ff39fa5f876c768**. Actual checks passed (2,412 frontend tests/9 skips, typecheck/build, 87 guards/7 binding assertions). Immediate-first-click acceptance **did not pass**. The six original samples waited 27–55 seconds after reload and prefetched candles; desktop correction was blocked by onboarding, mobile correction missed its timing/paint criteria. All eight records and caveats remain. The agent is idle, not a running wait. See [final navigation outcome](SCANNER_FIRST_NAVIGATION_2026_10_31.md). Repair the measurement method before another claim or retry. These funds changes and the newer reader cache are not installed there.

Receipts: [manifest](validation/cockpit-funds-20261031/manifest.json). Original logs: `/Users/areyouok/arx-tier1-release/cockpit-funds-20261031/`.

## Viewer failure isolation — 31 October follow-up

Checked code `2749c015` fixes notification fan-out: EventEmitter stops dispatch on the first throwing subscriber, so a disconnected/broken viewer could prevent later viewers from refreshing until the three-second fallback. Dispatch now snapshots the account's listeners and isolates each synchronous failure. Account scope, subscription removal, listener order and subscription-change semantics are preserved; no balance, order or reservation calculations changed. The only current subscriber schedules work synchronously; this change does not make callbacks asynchronous or bound arbitrary callback CPU time.

The added regression failed before the fix (healthy listener was never called); two account-scope/removal/dispatch tests already passed. The expanded existing CI lane now passes **13/13** on `2749c015`. API typecheck/build and **87/87 guards** pass. Initial test execution lacked the local esbuild binary; initial guard execution lacked the required environment placeholder. Both environment failures are retained, then corrected using the existing binary and an unreachable offline database URL. No existing database was used. Earlier frontend/browser results remain tied to `af002a34`; they were not rerun or relabelled for this backend-only change. Full root CI/database integration not run.

Raw evidence and hashes: `docs/validation/cockpit-event-isolation-20261031/`. This remains process-local best-effort notification; three-second cross-process fallback and terminal pickup cadence are unchanged. No broker confirmation latency or instant execution claim. Chart's newer mobile layout lives separately on PR103 and is not integrated into this checked PR104 source. Not installed in Replit, merged to main or deployed.
