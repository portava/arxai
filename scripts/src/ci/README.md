# CI Guards (Build A — CI Hardening)

Automated invariant checks that protect the trading architecture from regressions.
Run via `pnpm run ci:guards` from the workspace root.

## Guards

| # | Guard | Severity | What it catches |
|---|---|---|---|
| 1 | `check-can-place-trades` | **Inviolable** | Any `canPlaceTrades: true` in server, domain, or OpenAPI spec |
| 2 | `check-vault-mutations` | **Inviolable** | `.update(...)` / `.delete(...)` on append-only vault tables (`audit_events`, `vault_events`, `state_transitions`, `safety_core`) |
| 3 | `check-no-console` | High | `console.*` in server runtime code (use `req.log` or singleton `logger`); `lib/db/src/seed/`, `tests/`, `scripts/` allowlisted |
| 4 | `check-route-collisions` | High | Two route files registering the same `(METHOD, path)` pair |
| 5 | `check-duplicate-tables` | High | Two schema files defining `pgTable("same_name", ...)` |
| 6 | `check-cross-artifact-imports` | High | `artifacts/<a>` importing from `artifacts/<b>` (must share via libs) |
| 7 | `check-domain-circular` | Medium | Cyclic relative imports inside `lib/domain/src` |
| 8 | `check-chart-truth-mock-leak` | High | Mock/simulated candle data reaching live chart routes; `sourceModeFromProvider` must classify all mock shims as `"mock"`; truth engine must set `mockDataDetected=true` → DEGRADED; chartDataService must map that to quality=`"invalid"` and aiUsable=false |
| 9 | `check-mode-scope-no-investor-snapshot` | **Inviolable** | The account-shell ↔ mode-resolver infinite async loop. Fails if `getUserModeScope` calls `computeAccountShell(` without `skipInvestorSnapshot: true`, if the resolver references `buildInvestorLiveBalanceSnapshot`, or if `computeAccountShell` stops gating its snapshot build behind `opts.skipInvestorSnapshot ? null : …` (or adds a second ungated build). Prevents silently re-introducing the hang of `/api/me/account`, the balance SSE stream, Ruby, and the risk engine. |
| 10 | `check-cooldown-advisory-lock` | High | The rate-limiter concurrency race. Fails if `consumeRateLimit()` in `artifacts/api-server/src/lib/security/cooldowns.ts` no longer takes a transaction-scoped `pg_advisory_xact_lock(hashtext("<action>:<scope>"))` (on `tx`, keyed by BOTH action+scope) **before** the `securityCooldownsTable` SELECT. Without it, two simultaneous FIRST hits on the same (action, scope) can both read "no row" and both pass — the unique index only blocks a duplicate ROW, not a duplicate ALLOW. Comment-stripped scan, no DB needed; runtime counterpart is `cooldownConcurrentFirstHit.test.ts`. |
| 11 | `check-admin-trading-no-live-bypass` | **Inviolable** | A non-Phase-B path delivering a LIVE order to the `mt5_commands` EA mailbox. Two guarded live pipelines both end at that mailbox — Phase B (`lib/live/liveCommandPipeline.ts`, post-18-gate, the contract) and adminTrading (`lib/adminTrading/`, whose `dispatchToBroker()` is locked at runtime only by the `bridge_token` gate while `MT5_BRIDGE_TOKEN` stays unset). Locks the static structure with 3 invariants: **(1)** the set of non-test files inserting into `mt5_commands` must equal a reason-documented allowlist (a NEW mailbox writer fails the build) — catches both `db.insert(mt5CommandsTable)` (incl. `as` aliases) and raw `insert into mt5_commands` SQL; **(2)** `placeOrder.ts` must run `runOrderGuards()` and reject anything not `"APPROVED"` BEFORE reaching `dispatchToBroker()`, and `orderGuard.ts` must keep the `BRIDGE_TOKEN_UNSET` bridge-token gate keyed on `MT5_BRIDGE_TOKEN`; **(3)** only `placeOrder.ts` may import `dispatchToBroker`; **(4)** per-writer DELIVERABLE-LIVE semantics — every allowlisted writer EXCEPT the two sanctioned LIVE pipelines (Phase B + the gated `brokerPlacement.ts`) must keep its documented non-LIVE shape: each `mt5_commands` insert `.values({…})` block carries no live-delivery token (`mode:"LIVE"` / `requiredAccountType:"live"`) and no `action:"OPEN"`, plus per-writer markers (forced `status='BLOCKED'`, `safetyMode:'paper_only'`, CLOSE-only, `DEMO_MARKET_ORDER`, `RECONNECT`, `FORBIDDEN_ACTIONS` enforcement) — so editing an allowlisted file into a deliverable LIVE path fails the build even without adding a new insert site; an unclassified non-LIVE writer also fails; **(5)** positive net — ANY file whose `mt5_commands` insert block carries a live-delivery token must be one of the two `LIVE_SEMANTICS_WRITER_ALLOWLIST` pipelines. Comment-stripped scan + balanced-brace `.values({…})` extraction, no DB. Out of scope (deferred to review): reflection/dynamic table identifiers, multi-hop re-export laundering, a mailbox write hidden in a third-file helper, and a raw `insert into mt5_commands` SQL whose VALUES list cannot be parsed (still caught as a writer by invariant 1). |

## Per-guard CLI

Each guard can be run individually:

```bash
pnpm --filter @workspace/scripts exec tsx src/ci/check-can-place-trades.ts
pnpm --filter @workspace/scripts exec tsx src/ci/check-vault-mutations.ts
# … etc
```

Exit code `0` on pass, `1` on any violation.

## DB-gated runtime counterparts

Some source-scan guards prove a primitive *exists in source* but cannot prove it
*behaves correctly at runtime*. Those guards have a behavioral counterpart that
runs against a live Postgres and is wired into the `ci` lane through a
self-gating runner that **default-skips when `DATABASE_URL` is unset**, so it
never breaks the no-DB `ci:guards` lane.

| Runner | Source-scan guard | Runtime test | What the runtime run proves |
|---|---|---|---|
| `run-cooldown-race-db.ts` (`test:cooldown-race-db`) | `check-cooldown-advisory-lock` | `artifacts/api-server/src/lib/security/__qa__/cooldownConcurrentFirstHit.test.ts` | The per-(action, scope) `pg_advisory_xact_lock` actually **serializes** N simultaneous first hits: exactly one ALLOW lands (no double-ALLOW), per-scope. Swapping the lock for a no-op makes it fail. |

The runner checks `process.env.DATABASE_URL` **before** importing anything that
pulls in `@workspace/db` (whose module init throws when the env is unset), prints
a `[SKIP]` line and exits `0` with no DB, and otherwise spawns the node:test file
and propagates its exit code.

## Adding a new guard

1. Create `scripts/src/ci/check-<name>.ts` exporting a `check<Name>(): CheckResult` function.
2. Add the import + entry to `scripts/src/ci/run-all.ts`.
3. Document it in this table.
4. Make the guard fail-closed by default (false positives are better than false negatives for safety invariants).

## Constitution alignment

These guards enforce the inviolable invariants from the **Final Strategic Lock**:

- `canPlaceTrades:false` advisory invariant
- Vault append-only at the application layer (DB-role enforcement is a separate Build C task)
- Zero `console.*` in server code (logging discipline)
- No duplicate subsystems (route + table collision detection)
- Leaf-package isolation (cross-artifact imports forbidden)
- Domain layer integrity (circular imports forbidden)
