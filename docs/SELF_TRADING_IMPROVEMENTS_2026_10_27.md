# Self-trading improvements — 27 October 2026

Integration branch `claude/self-trading-improvements`, cut from PR #99 head `5767ec5`. Five independent slices were built on their own branches and merged here. Trading, workers and settlement stay disabled. No broker, demo or network order test ran, no existing database was touched and no migration was added. The MT5 terminal result-evidence work (EA result reporting, float4 entry-volume transport, mailbox/EA delivery) is owned by `codex/terminal-result-evidence` and is not changed here.

This is offline evidence only. It does not establish real execution correctness, broker behaviour or profitability. The self-trading verdict remains NOT COMPLETE.

## Slices

| Slice | Detail doc | What changed |
| --- | --- | --- |
| Position sizing | [SELF_TRADING_POSITION_SIZING_2026_10_27.md](SELF_TRADING_POSITION_SIZING_2026_10_27.md) | Lot sizer works in integer steps (non-decimal steps no longer round up past the budget or off-grid); minimum lot above the cap refuses; non-finite inputs refuse; multipliers can only reduce size; the executor refuses a minimum lot that would exceed the reduced risk budget (previously sent, e.g. 10× on XAUUSD); quota pressure fails safe on unknown daily P/L. |
| Emergency stops | [SELF_TRADING_EMERGENCY_STOPS_2026_10_27.md](SELF_TRADING_EMERGENCY_STOPS_2026_10_27.md) | One scope matcher (case/whitespace-insensitive, uninterpretable engaged rows block); kill switches re-checked under entry-authority locks at draft, confirmation and final claim, serialized with toggles; executor and decision engine fail closed on read errors and release the slot; static coverage guard. |
| Fresh facts | [SELF_TRADING_FRESH_FACTS_2026_10_27.md](SELF_TRADING_FRESH_FACTS_2026_10_27.md) | Autonomous entries re-check broker quote age, future dating, spread and price against the locked decision at the final claim; automatic management holds on stale, future-dated, malformed or superseded position snapshots and re-checks at its final claim. |
| Duplicate prevention and recovery | [SELF_TRADING_DUPLICATE_RECOVERY_AUDIT_2026_10_27.md](SELF_TRADING_DUPLICATE_RECOVERY_AUDIT_2026_10_27.md) | `cancelLiveCommand` and the shared-route force-block are compare-and-set; TTL expiry and enqueue failure cancel never-served mailbox mirrors in the same transaction and otherwise leave the command for reconciliation. |
| Competitive scorecard | [SELF_TRADING_COMPETITIVE_SCORECARD_2026_10_27.md](SELF_TRADING_COMPETITIVE_SCORECARD_2026_10_27.md) (+ `.json`) | 42 cited rows vs MT5, TradingView, QuantConnect LEAN, NinjaTrader, cTrader, IBKR and Freqtrade: 2 ahead (narrow), 15 parity claimed but unverified, 19 behind, 6 not measured. No aggregate score. |
| Broker quote supply (follow-up to fresh facts) | [SELF_TRADING_BROKER_QUOTE_SUPPLY_2026_10_27.md](SELF_TRADING_BROKER_QUOTE_SUPPLY_2026_10_27.md) | Verified per EA whether the entry claim's quote and point are supplied: v1.31 (shipped kit) streams no quotes, v1.52/v1.54 stream the `CandleSymbols` set only with `brokerTimeEpochMs` = trade-server clock (not UTC). Server fixes: stored quotes are stamped from the EA's UTC envelope clock with the broker offset kept as a diagnostic; the observer reads under the broker-resolved symbol; the quote store is partitioned by bridge and the claim reads only the dispatch bridge's partition; a missing quote names the EA's quote supply in the persisted refusal detail. Review fixes: the store stamps a tick at its first sight in the bridge's partition (the EA re-posts its last tick every sweep) and the claim refuses a tick no earlier post bounds, so a frozen closed-market quote can no longer pass; the broker spec is read under the dispatch bridge's owner (shared-master followers); the EA-version note states it is the heartbeat's last report. Fail-closed outcomes unchanged. |

## Combined validation of the merged branch

Node 24.22.1, pnpm 10.28.0, `DATABASE_URL=postgres://nobody@127.0.0.1:1/none` for offline suites, disposable PostgreSQL 16 clusters run as an unprivileged user.

| Suite | Base `5767ec5` | Merged |
| --- | --- | --- |
| test:self-trade-kill-switch-scope (new) | — | 19/19 |
| test:self-trade-kill-switch-coverage (new guard) | — | pass, 34 assertions |
| test:lot-sizer-invariants (new) | — | 36/36 |
| test:entry-sizer-risk-budget (new) | — | 7/7 |
| test:self-trade-fresh-facts (new) | — | 58/58; 105/105 after the broker-quote-supply slice; 135/135 after its review fixes |
| test:self-trade-duplicate-recovery-postgres (new) | — | 15/15 |
| test:self-trade-entry-postgres | 73/73 | 105 pass, 1 opt-in benchmark skipped; 108 pass, 1 skipped after the broker-quote-supply review fixes |
| test:self-trade-lifecycle | 44/44 | 52/52 |
| test:self-trade-management-postgres | 103 pass, 1 fail, 3 skip | 106 pass, 1 fail, 3 skip |
| test:self-trade-accounting-postgres | 34 pass, 3 skip | 34 pass, 3 skip |
| self-trade-execution-domain / safety-audit / objective-sizing | 37 / 61 / 105 | unchanged |
| emergency-kill-switch-gate / entry-sizer-quote-fx / risk-pre-gates | 9 / 12 / 17 | unchanged |
| unknown-reconciler / wave5-seam / execution-epistemology / pre-gate-wave4 | 33 / 25 / 35 / 40 | unchanged |
| one-click-gates / close-only-gate / ack-partial-fill | 28 / 9 / 12 | unchanged |
| ci:guards | 87/87 | 88/88 |
| pnpm run typecheck | — | pass with `NODE_OPTIONS=--max-old-space-size=8192` (the scripts package exhausts the default 4 GB heap in this container) |

The one management failure, "actual concurrent cold-map manual polls complete with a one-connection pool", is an 8 s child-process timeout that also fails at the base commit on this shared, loaded host. The full root `ci` aggregate, `ci:integration`, browser checks and builds were not run on this branch.

## Behaviour changes to know about

- Agent entries whose broker minimum lot exceeds the risk budget are now refused (`MIN_LOT_EXCEEDS_RISK_BUDGET`) instead of sent over budget.
- Agent entries now need a fresh in-memory broker quote and broker symbol point from the dispatch bridge. Verified: the shipped v1.31 kit pushes no quotes, so agent entries on it always refuse (the refusal says so); v1.52/v1.54 push quotes only for their `CandleSymbols` input and supply `point` only after symbol sync, so an operator must configure both. `brokerTimeEpochMs` is not UTC; the server now stamps quotes from the EA's UTC envelope clock of the post in which the tick was first seen (the EA re-posts its last tick every sweep), and the claim refuses a tick that no earlier post from the bridge bounds — so the first tick after a server restart, and a frozen closed-market quote however often it is re-posted, refuse `ENTRY_FRESH_QUOTE_STALE`. In `SHARED_MASTER_MT5` mode the broker spec is read under the master (the dispatch bridge's owner), so followers' entries can measure spread once the master has run symbol sync.
- Stale position snapshots now hold automatic protective management (EXIT / stop moves) as well as non-protective actions. Manual commands and broker-side stops are unaffected. Whether protective actions deserve an exception is an owner decision.
- A cancel that loses a race returns `LIVE_CANCEL_RACE_LOST` (HTTP 409); an ambiguous enqueue failure leaves the command SENT with `BRIDGE_ENQUEUE_OUTCOME_UNKNOWN`; the sweep defers an expiry it cannot safely neutralise.

## Highest-impact remaining gaps

1. Truthful terminal fill results (scorecard EXQ-4) — in progress on `codex/terminal-result-evidence`, not integrated.
2. No DEMO/paper forward-test path for agents (SIM-1): `agentExecutor` always submits `accountMode: "live"`.
3. Bridge handoffs are not durable: no claim-to-mailbox outbox, RAM-only EA duplicate memory, no durable terminal result queue. Mailbox/poll dual-delivery exclusion and the v1.54 broker-clock expiry bug are being fixed by the MT5 thread.
4. Position identity is user + ticket; entries are not pinned to an account/session.
5. Loss limits: `maxWeeklyLossUsd` is stored but unchecked; the daily cap blocks entries but does not count open risk or close positions; the agent daily cap only halves size.
6. No repair workflow for reservations or management claims orphaned by a crash; ledger exactly-once relies on locking, not a unique index.
7. Already-delivered commands cannot be halted server-side; a pickup-time stop check would need an owner decision.
