# Account update recovery — 1 November 2026

Status: development fix validated; **not deployed and not release-green**. Instant MT5-to-ARX monetary agreement remains unproven.

Application change: `c4e1580348f609dc034f8261015f7dc4ac3440c7`. Final tested source, including the test-boundary correction: `e1658891468f1f76c709afe8a556f80c8bc33712`.

## Problem and resulting behavior

The existing account stream's three-second fallback checked access to the shared account but sent a refresh hint only when the connection binding changed or a local event arrived. A write handled by a different API process, or another missed notification, could therefore go unnoticed by this stream. The cards' independent polling remained a fallback; balances were not necessarily stuck forever.

Each existing periodic request now schedules an authorized canonical-summary reread, even without a local event. It reuses the existing stream, scope checks and serialized scheduler. Requests arriving during an awaited check earn one trailing reconciliation, including when the earlier check fails. Stop, revoked access and failed authorization cannot emit account hints.

The hint contains only `shared_account_changed`; it supplies no amount, account identifier or observation time. The existing client refresh coordinator updates the shared summary query. Six displayed native fields—balance, equity, account profit, credit, used margin and free margin—remain one reported snapshot at the terminal's currency precision. A heartbeat or refresh hint never manufactures a new financial observation or marks unverified values current.

## Validation

Two new assertions failed against the original coordinator: no hint on a periodic same-account request, and a lost trailing reconciliation during an older scope check. Both pass after the fix.

On `e1658891`:

- Account stream, authorization, scheduler, producer and route checks: **40 pass, 0 fail/skip**. These use offline transport/data seams, not a database or broker.
- Frontend account hook, native monetary component and both existing account-card suites: **157 pass, 0 fail/skip across five files**. The added rendering check uses the real client hook/query cache and two native-report components with a synthetic canonical HTTP response. Server timer-to-hint behavior is checked separately through the extracted actual route. This is not a full network or broker acceptance test.
- API typecheck and API build: pass. The initial typecheck failed because this worktree lacked built shared-library declarations; the declaration build and rerun passed.
- Architecture guards: **85/87**; the exact same 43 failure/header lines as the previous market-identity checkpoint (38 risky-wording findings, three internal UI names). The initial extra cross-artifact test-import failure was fixed by separating server and client test boundaries, without changing a guard.
- Independent review cleared both the application change and the final test-only follow-up.

Raw failures, final logs, comparison and review are retained in `/Users/areyouok/arx-tier1-release/account-reconciliation-20261101/`. A hashed receipt archive accompanies this report under `docs/validation/account-reconciliation-20261101/`.

## Limits and next work

This is periodic missed-event recovery, **not distributed push**. Three seconds is the existing timer cadence, not a bound on delivery: authorization, pending queries, network, event-loop delays and suspended tabs can add delay. It adds canonical-summary requests for active viewers in addition to existing polling; production capacity and latency have not been measured.

Native account-report clock quality, producer continuity, real database concurrency, remaining personal-account views and margin-level coverage remain open as recorded in `NATIVE_ACCOUNT_REPORTING_2026_11_01.md`. MT5 capture defaults to one second, which is not instantaneous end-to-end delivery. Broker-confirmed account profit must remain separate from ARX allocation P/L and estimates.

No deployment, Replit update/restart, existing database mutation, trading/worker activation, live/demo broker test or main merge occurred. The unfinished captured-chart-input changes remain preserved in the separate chart worktree. No architecture completion or TradingView/MT5 parity is claimed.
