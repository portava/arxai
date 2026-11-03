# Audit gaps, round 2, 3 November 2026

Base: `codex/chart-anchor-drag-20261102` at `90ee2dde` (PR #105 merged).
Follow-up to `docs/AUDIT_FIXES_2026_11_03.md`. This round looked for further
gaps after the first fix set, mainly the H5 class: routes and services that
read platform-wide state or another user's data and present it as the
caller's own. Nothing here deploys, migrates a database, arms live trading or
talks to a broker. No schema change is needed.

## Fixed here

| Gap | Fix | Where |
|---|---|---|
| Simulator OMS orders, positions and P/L were listed for every user | Every list, detail, P/L and dashboard read is scoped to the caller's own orders (`ownerUserId`); a detail for another user's row is 404. PR #101 port | `lib/oms.ts`, `lib/omsScopedSummary.ts`, `routes/oms.ts` |
| CSV/JSON exports dumped the whole simulator book | Operators export the platform book, everyone else only their own; the response says its scope in headers and body. PR #101 port | `routes/exports.ts` |
| Trade health and scalp baskets read the platform `mt5_state` row for a DEMO user with no row of their own and said "no open positions" | Positions are marked not measured (`positionsMeasured: false`, plain note); the scalp journal is not finalized on an unread book. PR #101 port | `lib/brokerHub/mt5StateReader.ts`, `lib/tradeHealth/tradeHealthService.ts`, `lib/scalp/scalpManageService.ts`, `routes/meDemoPositions.ts` |
| App Doctor showed the platform EA heartbeat as the signed-in user's own | A signed-in caller gets their own connection's heartbeat (`heartbeatScope`); the platform probe is used only for anonymous callers; database reachability is a real probe. PR #101 port | `routes/appDoctor.ts` |
| Notification digest counted every user's notifications | `userDigest(userId, hours)` counts the caller's own. PR #101 port | `lib/notifications/service.ts`, `routes/notifications.ts` |
| Strategy Lab experiments were listed for everyone, and the owner could be set from the request body | Experiments require sign-in and are stored with the session user as owner (inside `settings`, no schema change); list, get, run and compare are the caller's own. PR #101 port | `lib/replaySim/strategyLab.ts`, `routes/strategyLab.ts` |
| Trade intelligence read the DEMO book only and reported the LIVE venue as scanned | The response names the venues scanned and the LIVE open count it did not scan. PR #101 port | `routes/meTradeIntelligence.ts` |
| Scanner alerts presented a platform-shared list as personal, and `count` was capped at the 100-row list | The payload says `scope: platform_shared`; expired alerts are dropped, superseded ones are marked stale, and the count is the true open count with a completeness flag. PR #101 port, alert hunks only | `lib/marketScanner.ts`, `routes/scanner.ts` |
| Forward-test results counted shadow decisions from before the test started or after it stopped | Results are the decisions inside the start/stop window; a duration outside 1 minute to 7 days is refused with 400 instead of a 500. PR #101 port, plus a fix for a same-millisecond race on Stop found by the suite | `lib/shadowMode.ts`, `routes/shadowMode.ts` |
| `/mt5/heartbeat/status` and `/mt5/bridge-diagnostics` showed the platform EA's remote IPs, broker account number and terminal user agent to any signed-in user | Those fields are operator-only (null for everyone else, with a `redactionNote`); booleans, counts and timestamps are unchanged. Same rule as `/mt5/bridge-ops-monitor` | `routes/mt5.ts` |
| `test:oms-governance` failed after PR #105 (paper entries now need a readable Safety Core state) | The test seeds the shared paper fixture | `lib/__qa__/omsGovernance.test.ts` |

## Still open (owner decision)

- Advisory "Build" routers (ecosystem, agents, validation, execution preview,
  replay, strategies, signals, onboarding, personal edge) are session-only
  with no per-user scoping. Most are read-only platform output; the owner
  should say which of them are meant to be personal.
- H4 price-source policy, H7 broker-time candle open times, default trading
  posture and per-user `mt5_state` rows, as listed in the first fix set.

## Evidence

- `pnpm --filter @workspace/api-server run test:audit-gaps-r2-20261103`
  (35 tests, wired into the root `ci` script) passes offline and on a
  disposable PostgreSQL.
- Root `pnpm run typecheck` exit 0; `ci:guards` 87/87.
- On a disposable PostgreSQL: `omsGovernance` 8/8, `mt5StateReader` 3/3,
  `legacyGatesActionAware` 3/3, `platformSwitches` 19/19.
- Offline: `shadowPersistenceWiring` 8/8, `tradeHealthReadinessContract`
  18/18, `scannerTruthCaps` 18/18, `mt5StateScope` 5/5, `sourceUnification`
  13/13, `simulatorSurfaceRbac` 72/72.
