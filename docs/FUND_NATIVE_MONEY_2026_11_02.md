# Fund Control native money alignment — 2 November 2026

Verdict: scoped offline validation passes apart from two unchanged repository guards. ARX is not release-green; all-engine accuracy and instantaneous MT5 equality remain unproven.

Application commit: `79b2776c2e07147122fbb63c79c06fa1572faec4`, branch `codex/fund-native-money-20261102`, parent `5bfcb75215ecd27dd8ace5e5c35c141a6eac9e2e`. Subsequent documentation checkpoint does not change application code.

## Problem and final behavior

Fund Control used legacy connection balance/equity, a stored position-profit subtotal as account profit, heartbeat freshness and an assumed dollar currency. Those could disagree with the native whole-account report shown elsewhere.

The authenticated admin broker-mirror GET now attaches the canonical native account report after unique connection-ID and owner matching. Unavailable, ambiguous, rejected or failed reads do not fall back to legacy amounts. The GET no longer calls the fund-book pool seeding helper. Existing internal ledger, NAV and execution arithmetic is unchanged.

Overview and Broker Mirrors use the shared native-account component for balance, equity, account profit, credit, used margin and free margin. Exact decimal strings and reported currencies are preserved. Unsupported mixed-account equity/profit totals are withheld. Recorded position profit is not promoted to whole-account profit and has no invented currency.

The identity-scoped client reader uses no-store requests, a ten-second body deadline, five-second visible polling, focus/reconnect checks, and pause/manual refresh. Identity failure, role loss, malformed responses and failed reads hide cached monetary rows. Shared unavailable-reason rendering now rejects inherited object keys safely.

Telemetry freshness and account-money freshness remain separate. Native reports explicitly retain `currentVerified:false`; displaying a report does not prove it matches the terminal now.

## Validation on the exact application commit

| Check | Result |
| --- | --- |
| Full dashboard tests | 4,711 pass / 0 fail / 12 skipped |
| Native-account backend lane | 130 pass / 0 fail / 0 skipped |
| Library, dashboard and API typechecks | Pass |
| Dashboard and API production builds | Pass |
| Repository guards | 85/87; same 43 failure/diagnostic lines as baseline after source-location normalization |
| Browser functional checks | 18/18 on fixture b974da26d71ad836, actual dashboard entry and production runtime |
| Independent source review | Clear within display scope; all18 final reviewed file hashes match frozen commit |

Browser coverage includes exact large decimals/currency, native profit rather than position subtotal, rejected reports despite fresh heartbeat, failed-read hiding, recovery, pause, manual refresh while paused and mobile strings. External/broker requests were blocked; no terminal or broker was used. The isolated Vite fixture is not the deployable dashboard bundle. Screenshots were visually inspected. Very large amounts wrap across lines on mobile; full responsive-layout acceptance remains open.

Regression evidence retained: eight initial display failures, three inherited-reason failures, backend before/after tests, initial generated-type failures and their corrections. Two browser harness failures (duplicate fixture variable; missing await for the request recorder) are retained alongside the successful run. No application change was needed for those fixture corrections. Checks chained after the guard failure did not run. No claim of full release CI is made.

## Open accuracy and launch gaps

- All-account change push is not implemented; visible polling can lag by five seconds plus transport/source delay. This is not immediate reflection of other traders' changes.
- Native clock mapping, report ordering, producer continuity and current-state verification remain open. Per-account reads are not atomic across accounts.
- Server database waits remain unbounded. Client timeout does not cancel server work.
- Other admin cockpit/allocation and pool-ledger monetary consumers need separate authority/currency audits. Internal ledger calculations were deliberately not changed by this presentation fix.
- Scanner reverse still needs terminal-confirmed close before opposite entry. An acknowledgment is not a fill and must not release exposure or funds.
- Slow-CPU chart navigation remains above the100ms target; competitor parity and broader chart/AI/Truth coverage are unproven.
- Chart narrative/status consistency, shared source/account/symbol/timeframe/version identity, stale/unknown behavior and all remaining engines need evidence-bound validation. Agreement alone is not proof.

No main merge, Replit sync, publication, deployment, existing-database change, worker enablement, live/demo test, order, funds movement or email occurred.

## Evidence

`docs/validation/fund-native-money-20261102/receipts.tar.gz` contains raw tests, independent review, exact build/browser receipts, screenshots and failed runs. `manifest.json` binds each file and archive hash. Local raw evidence: `/Users/areyouok/arx-tier1-release/fund-native-money-20261102`.
