# Audit fixes, 3 November 2026

Base: Codex chart chain `fe4ccf4c2` (`codex/chart-anchor-drag-20261102`).
Source: the end-to-end architecture audit of that head (Claude Doc "ARX
end-to-end architecture audit (3 Nov 2026)"). This branch fixes the code-level
findings that need no owner decision and ports the matching fixes from PR #100,
PR #101 and PR #102 onto the newest code. Nothing here deploys, migrates a
database, arms live trading or talks to a broker.

## Fixed here

| Finding | Fix | Where |
|---|---|---|
| C1 EA command expiry compared broker server time with the server's UTC epoch, so a non-UTC broker rejected every command as EXPIRED | Expiry age is now `TimeGMT() - createdAtEpoch` (TimeCurrent only if TimeGMT is 0). Heartbeat also sends `eaTimeGmt` (epoch ms) and `brokerTime` so the server's clock-drift check has inputs | `attached_assets/ARX_AI_Universal_Agent_v154_*.mq5`, `mt5-bridge/ARX_AI_Universal_Agent_v150.mq5` |
| C2 tick quotes were stamped with broker time as if UTC | PR #100 tick store ported: a quote is stamped at the EA's UTC clock when the tick was first seen; the broker clock and its offset are kept as diagnostics (`brokerClockMs`, `brokerClockOffsetMs`); no server-clock fallback | `lib/bridgeV2/ingest.ts`, `lib/data/providers/mt5Provider.ts`, `lib/data/types.ts` |
| C3 paper venue booked without a Safety Core check | PR #102 port: the Risk Governor refuses PAPER OPEN unless one readable Safety Core row allows booking (mode PAPER_TRADING or LIVE_TRADING, trading state, kill switch off); the venue rechecks immediately before the insert. AI-originated OPEN entries are held with `AI_ENTRY_POLICY_PENDING` until the owner approves a confidence policy; a paper fill carrying a decision id keeps its AI origin | `lib/safety/entryPolicy.ts`, `lib/safety/platformSwitches.ts` (`readPaperEntryPosture`), `lib/riskGovernor/enforce.ts`, `lib/tradeEngine/paperVenue.ts` |
| H1 `/mt5/state` returned the platform row to any signed-in user | PR #101 port: sign-in required; operators get the platform row marked `scope: platform`; everyone else gets their own connection, their shared-master bridge status, or `none`, with positions marked not read | `routes/mt5.ts`, `routes/mt5SharedBridgeStatus.ts`, `lib/api-spec/openapi.yaml`, dashboard `pages/live-trades.tsx` |
| H2 audit routes open to every role | `requireOperator` on `/audit/*` (PR #102 port) | `routes/audit.ts` |
| H3 paper permission counted every user's risk locks | Locks are loaded for the caller (plus legacy unowned rows); `/risk-locks` requires sign-in and new locks carry the owner | `routes/permission.ts` |
| H6 `mt5_state` rows had no owner | The heartbeat attributes a new or still-unowned platform row to the authenticated bridge user. The platform read (lowest id) is unchanged; a second EA still overwrites the row (see below) | `routes/mt5.ts` |
| Guards: 38 risky-wording hits and 3 raw JSON panels | Chart preview copy says "cleared" instead of "withdrawn"; trading-school and prop copy avoid "deposit" / "guaranteed profit"; admin Fund Control components are allowlisted for money-handling words like the admin investors page; diagnostic panels render key/value lists | dashboard, `scripts/src/ci/check-risky-wording-frontend.ts` |
| Runbook listed nine migrations; the directory has eleven | Files 10 and 11 added to the table | `docs/TIER1_OWNER_RUNBOOK.md` |

## Not fixed here (owner decision or separate work)

- H4 three "current price" sources (chart and decision engine via the market
  data router; Risk Governor via never-written symbol specs then the assistant
  provider; venues via `marketDataService`). Needs the owner's price-source
  policy.
- H5 legacy "Build" routers without user scoping.
- H7 EA candle open times are broker time stored as UTC. The tick store now
  measures the broker offset per bridge, which is the input a candle correction
  needs, but correcting stored candle times changes the chart's clock-basis
  evidence contract and should follow the owner's broker-clock policy.
- Default posture (trading on by default) and the external intraday feed
  entitlement.
- Full per-user `mt5_state` rows (needs a product decision on the platform
  singleton's consumers).

## Evidence

- New tests: `test:audit-fixes-20261103` (entry policy, tick time base,
  `/mt5/state` scoping), wired into root `ci`.
- Ported test fixtures seed an executable Safety Core posture
  (`lib/safety/__qa__/paperModeFixture.ts`).
- The EA sources were edited by hand and have not been recompiled in this
  environment; recompile under MetaEditor before any terminal test.
