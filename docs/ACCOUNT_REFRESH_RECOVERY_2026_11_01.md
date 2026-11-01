# Account-summary refresh recovery — 1 November 2026

Application commit: `6f8ded932bee7ca2df6d64e687fc36c5a7bad02e`, based on `8f15570286166b5ed8557d7ff1104ff9314e8a50`.

Development source only. This is a stuck-read correction, not proof of real-time MT5 equality or launch readiness.

## Problem and correction

An account-summary HTTP request had no completion deadline. A stalled header or body read could keep the canonical query fetching indefinitely. Later account-change hints correctly waited for that older read to settle, but it never settled: displayed funds could remain stale even while newer reports were available.

All six existing summary readers now use one bounded query function over the same generated GET endpoint and cache key: Shared Account, Cockpit, the admin shared bridge panel, Analytics, MT5 Bridge and Trade Command Room. The read bypasses HTTP caching and has a ten-second recovery deadline covering the full response/body operation. This deadline does not delay ordinary successful updates and is not a latency target. Timeout aborts the request and retires its result even if the transport ignores cancellation. Late completion cannot replace newer query data. Caller cancellation also retires the read and clears its timer/listener.

Automatic query retries are disabled for these reads so backoff does not monopolize the shared query. Existing change hints, polling, manual refresh and normal query lifecycle remain the recovery paths. Burst coalescing and the existing trailing refresh are preserved. No extra stream, new account source, monetary calculation or execution path was added. Amounts, currency, precision and observation timestamps pass through unchanged. Native money components already withhold their display when the summary reports an error; no zero or old stored broker figure is substituted.

## Validation

- Two pre-fix-equivalent regressions reproduce indefinite fetching with a stalled header and a stalled body. Their failures are retained. The fixture uses the original generated fetch without the new wrapper; it is not a full checkout test of the base commit.
- Nine loader tests cover both pre-hint and hint-started hung reads, queued-hint recovery, late responses, exact decimal/currency/zero preservation, caller cancellation, and original failures including a null rejection. Fake timers establish scheduling behavior, not wall-clock broker latency.
- The final focused lane passes 94 tests across five files, including existing stream and three monetary display suites. Counts overlap the full suite.
- Full dashboard suite on `6f8ded93`: **4,005 passed, 11 skipped, 0 failed**; 233 files passed, one skipped. Earlier full run (before two added cases and the Analytics key correction) passed 4,003 with 11 skipped; it is retained separately, not attributed to the final source.
- Dashboard typecheck passes on identical final application source. Its first run caught a missing explicit query key in Analytics; that wiring was corrected. Initial failure retained.
- Production build passes on the application commit. Existing chunk-size and sourcemap/module warnings remain in the log.
- Architecture guards: 85/87. The same 38 risky-wording and three internal-name findings remain. Failure blocks differ only in shifted Analytics line numbers and the added product source-file count; the exact diff is retained.
- Independent review found no scoped blocker and checked all six call sites, generated query override behavior, failure display wiring, both controller recovery paths and source hashes. The reviewer inspected logs; it did not independently rerun tests.

No browser acceptance, API/root CI, database integration or terminal/broker checks were performed in this frontend-only slice.

## Remaining monetary acceptance gaps

- Ten seconds is an active JavaScript transport-recovery deadline, not a guarantee during event-loop suspension or while a query is intentionally paused/offline before dispatch.
- This bounds the canonical shared summary, not every position, allocation, administrative or trade request. It does not establish correct account selection or money values in every ARX surface.
- The native producer currently samples on a one-second cadence. Other synchronous EA work and transmission can delay it. The notification bus remains process-local; three-second stream reconciliation and summary polling remain recovery paths.
- Native values are still labelled as reported observations with current state unverified. Terminal clock quality, producer continuity/ordering and account-to-screen latency require further evidence.
- Personal native account reporting, remaining allocation currency formatting, the account-shell zero-equity fallback, and all-surface reconciliation remain open. Allocation ledgers and paper P/L must not be presented as the whole MT5 account.
- Nothing was deployed or installed in Replit/MT5. No main merge, existing database operation, worker activation, broker order or live/demo test occurred. Earlier Smart Chart, Truth, self-trading and competitive gaps remain open.

Local receipts: `/Users/areyouok/arx-tier1-release/account-refresh-deadline-20261101/`.
Repository archive: `docs/validation/account-refresh-deadline-20261101/receipts.tar.gz`.
