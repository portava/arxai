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

## Launch blockers and next work

1. Audit `useLiveBridgeRefreshState`: its extra five-second reload can reset the transport's backoff or interrupt slow reads, while its auto-refresh OFF control does not stop the underlying shared SSE stream. Implement honest shared transport control and test recovery without request starvation.
2. Verify clock-based aging on stalled streams; distinguish connection status from data freshness. Audit missing counts rendered as zero, currency labeling and previous values surviving null fields. Do not fabricate new funds or timestamps.
3. Measure actual cockpit input feedback and confirmed-update paint in a production browser fixture, then validate the authorized development integration. No broker test is authorized.
4. Trace all one-click surfaces through submission, gated dispatch, terminal pickup and confirmation. Shipped v154 defaults `PollIntervalSeconds = 5`; heartbeat and snapshot HTTP work precedes command polling. Actual terminal configuration is unverified. A faster browser alone cannot remove this pickup delay.
5. The account-change bus is process-local. Confirmed-result notification coverage and multiple API process propagation still need inspection. The three-second fallback remains.
6. Reconcile PR102/PR100 and Truth work before any launch verdict. Never import the entire older chart-base backend over newer Replit development work.

No launch-ready, TradingView/MT5 parity, guaranteed fill speed, or architecture completion claim. A queued command stays pending; available funds must never be released on a mere click or acknowledgement.

## Scanner work running separately

The navigation update finished at clean Replit development checkpoint **619f259db5f265a379190de42ff39fa5f876c768**. Actual checks passed (2,412 frontend tests/9 skips, typecheck/build, 87 guards/7 binding assertions). Immediate-first-click acceptance **did not pass**. The six original samples waited 27–55 seconds after reload and prefetched candles; desktop correction was blocked by onboarding, mobile correction missed its timing/paint criteria. All eight records and caveats remain. The agent is idle, not a running wait. See [final navigation outcome](SCANNER_FIRST_NAVIGATION_2026_10_31.md). Repair the measurement method before another claim or retry. These funds changes and the newer reader cache are not installed there.

Receipts: [manifest](validation/cockpit-funds-20261031/manifest.json). Original logs: `/Users/areyouok/arx-tier1-release/cockpit-funds-20261031/`.
