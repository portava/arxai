# Tier 1 architecture completion work

Base: PR #66, `67d8a652`. This follow-up implements the owner command to finish
architecture responsibilities and replace the unavailable scorecard. See the
updated [architecture map](ARCHITECTURE_MAP.md) for each component's job, source,
consumers and boundaries; [Scorecard v2](../scripts/arx-scorecard/README.md) for the
completion gates. The latest generated results, not this historical narrative,
carry the measured commit and verdict.

## Changes

- **Platform Safety / Risk Governor:** broker execution and maintenance controls
  now become a new-risk halt inside `buildRiskContext`. Caller-supplied facts
  cannot override this read. Actual LIVE dispatch and DEMO consume already call
  this governor, so the readiness policy is now enforced. PAPER is exempt from
  broker controls. Closes/tightening retain their action-specific checks.
- **Broker Hub / close permission:** shared 15/60-second status labels remain.
  The named pure close predicate permits connected transports through the
  historical inclusive 120-second boundary; missing/revoked/disconnected/invalid
  timestamps never get grace. Status, action permission and actual transport
  readiness are separate facts.
- **Trade Engine retries:** Trade Action drafts have an optional user-scoped
  persistent key and immutable request hash. My Trades DEMO requires a key,
  handles concurrent inserts through a unique index, and relies on the existing
  conditional confirmation claim to prevent double dispatch. Conflicting input
  is refused, pending retries report in-progress, completed retries return the
  existing action. The dashboard retains the key across network retries.
- **Trade Engine closes:** the legacy DEMO mailbox transport moved out of the
  route into `tradeEngine/legacyDemoClose.ts`, reachable only through the
  pipeline. It repeats ownership, mode, demo-account and governor checks and
  serializes duplicate closes by user/connection/ticket. A legacy mirror with
  no account identity refuses if the owner has multiple registered connections. The strict mailbox
  writer guards moved with the implementation; the route no longer has a write
  exception. SIMULATED does not enter this broker transport.
- **Execution honesty:** exit reviews remain pending with no realized P/L or
  exit price until broker confirmation. Unsupported non-OPEN SIMULATED actions
  refuse explicitly instead of reporting a no-op as queued.
- **Paper pricing:** real-quote admission is shared by SIMULATED opens and
  manual closes of market-priced paper orders. BUY closes at real bid, SELL at
  real ask. Missing/stale/fallback/crossed/future quotes refuse. Conditional
  close updates prevent competing closes from overwriting a fill or emitting
  duplicate close events. Explicit simulator training orders retain their
  simulator model. Market-priced account valuations also require real quotes;
  the account API returns unavailable instead of a cached or mock valuation.
  All paper order close writers condition on OPEN so late settlements cannot
  overwrite a prior fill. The existing simplified paper P/L model remains a
  simulation, not broker contract-size/commission accounting.
- **Account facts:** JSON, SSE and investor account summaries use one deterministic
  per-user connection selection. Paper intelligence now requires authentication,
  reads the caller's account snapshot and requires fresh account facts. It no
  longer sizes advice from an unrelated platform balance.
- **Documentation / measurement:** the stale Build-B architecture map is replaced
  by the five-domain map. The v2 rubric was committed before measurement. Scripts
  produce JSON, CSV and an offline HTML dashboard without querying production.

## Deliberate boundaries

Internal venue-specific mechanics and additional stricter operational caps remain
inside the execution system. They do not replace the governor or permit a blocked
action. Guardian rule families retain distinct strategy logic under the registered
management authority; advisory rules cannot execute. The two physical position
stores remain behind the ledger under approved Option A. Manual journals and
legacy history are not automated paper accounting.

Deriv's supported read/execution capabilities remain as implemented; this work does
not invent unsupported broker operations. My Trades LIVE remains refused until
broker validation and separate owner authorization. Real market data and production
control configuration are deployment prerequisites, not assumptions made by tests.

## Verification notes

Baseline integration was run before application changes on a fresh local database.
The first run exposed a non-UTC database setting in addition to known failures;
the isolated database was corrected to UTC. No production timezone or data changed.

The broader UTC run reproduced the six reported pre-existing failures plus the
fundbook test's missing-seed prerequisite. All seven failure causes were faulty test
fixtures/contracts and are repaired without changing trading policy:

- `admin-unrestricted-risk`: a risk template lacked required `created_by`.
- `chart-decision-receipts`: negative synthetic users were rejected by the canonical
  position reader; fixtures now create real isolated positive user identities.
- `mode-scope`: the source assertion expected an inline role comparison although
  the route uses the canonical `operatorRoleFromSession` gate and denies non-admins.
- `one-click-concurrency`: reservations referenced nonexistent user id 1; the test
  now creates and cleans its own user before exercising the real foreign key.
- `fundbook-tier`: required boot-seeded pools; it now owns and cleans two isolated
  pools and NAV rows, preserving the same tier/rollback/isolation assertions.
- `ruby-draw-setup-route`: the app harness does not run the production agent
  seeder. An isolated RISK registry participant now drives the actual advisory
  and governance engines, then is cleaned up with cache invalidation.
- `scanner-no-feed-honesty`: assumed a configured external provider would attempt
  HTTP. The test now proves its network blocker with an explicit rejected probe;
  both real scanner assertions still require honest no-feed, non-tradeable rows.

All seven repaired entries passed individually. A subsequent empty-database run
also exposed an ownership-test baseline captured before the health reader seeded
its missing default row. That test now captures the baseline after the read and
before forbidden mutations, then proves they leave the state unchanged.

The broader CI sweep found two more obsolete test assumptions: chart parity
required an HTTP attempt despite unconfigured providers (now an explicit blocked
probe, with the actual parity assertions preserved), and the reservation lock
pin expected inline position SQL after its move into the ledger (now it pins the
ledger call, the same transaction client, owner scope and open-exposure filter).
No trading policy changed for these fixture repairs. Final aggregate results are
recorded in the exact-commit scorecard evidence.

Any remaining failures and final command results are recorded with the v2 evidence.
A baseline failure is not a passing test. Static guards cannot prove arbitrary
reflection/dynamically constructed access, and local tests cannot prove a live
broker or production configuration.

## Owner-only work

Follow [the updated runbook](TIER1_OWNER_RUNBOOK.md), including additive migration
9 before deployment. No production migrations, deployment, live arming, broker
orders, real-money trades, guessed owner assignments or column drops occurred.
