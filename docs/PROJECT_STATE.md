# Project State

**Generated:** 2026-08-27, from a direct audit of the repository, git history,
running code, tests and the live database. Where documentation and code
disagreed, code won and the divergence is recorded.

---

## 1. Identity and position

| Fact | Value | Source |
|---|---|---|
| Product | ARX AI — Analyze. Risk. eXecute. | `replit.md` |
| Repository | `github.com/portava/arxai` (remote `origin`) | `git remote -v` |
| Current branch | `phase6/guided-mode` | `git rev-parse --abbrev-ref HEAD` |
| **Current HEAD** | **`ee641c5cdea7982ef1535e9579234f0772a12793`** | `git rev-parse HEAD` |
| HEAD subject | `Phase 6: a 401 must never look like an empty inbox` | `git log -1` |
| Ahead of `main` | 37 commits | `git rev-list --count main..HEAD` |
| Behind `main` | 0 commits | `git rev-list --count HEAD..main` |
| Pushed | Yes — `origin/phase6/guided-mode` is at the same SHA | `git ls-remote --heads origin` |

Additional remotes exist (`gitsafe-backup`, and ~15 ephemeral `subrepl-*` Replit
SSH remotes). Only `origin` is the authoritative publish target.

### Uncommitted working tree at audit time
```
 M pnpm-lock.yaml                              (+99 / −1207 lines)
?? CLAUDE.md                                   (written by this task)
?? docs/PROJECT_STATE.md                       (written by this task)
?? docs/DECISIONS.md                           (written by this task)
?? docs/HANDOFF.md                             (written by this task)
?? docs/CERTIFICATIONS.md                      (written by this task)
?? artifacts/api-server/deriv-evidence.json    (pre-existing, see §7)
```
The `pnpm-lock.yaml` deletion of 1207 lines was **not** produced by this task and
its provenance is **UNKNOWN**. Do not commit it without establishing why it
shrank.

---

## 2. Architecture

### Monorepo shape
```
artifacts/
├── api-server/         Express 5 backend        (port 8080, /api/*)
├── trading-dashboard/  React 19 + Vite frontend (port 24210)
└── mockup-sandbox/     Component preview, dev only

lib/
├── api-spec/           OpenAPI 3 contract (source of truth) + Orval config
├── api-zod/            Generated Zod schemas        (autogen — do not edit)
├── api-client-react/   Generated React-Query hooks  (autogen — do not edit)
├── db/                 Drizzle schema + repositories + client
├── domain/             Pure business logic, incl. safety-contracts/
├── discovery/ features/ markets/ money/ risk/ validation/
└── integrations*/      Anthropic / OpenAI integration packages

scripts/src/ci/         Invariant guards (run-all.ts) — 65 guards
mt5-bridge/, mt5-ea/    MQL5 Expert Advisor source (in-project tops at v1.54)
.agents/memory/         297 topic memory files + MEMORY.md index
```

Stack: pnpm workspaces, Node 24, TypeScript 5.9, Express 5, React 19 + Vite +
Tailwind + shadcn/ui, PostgreSQL + Drizzle ORM, Zod (`zod/v4`), Orval codegen,
esbuild.

### Execution architecture — two sanctioned dispatch paths

This is the single most important architectural fact and it is **not** what the
Phase 6 design document proposed.

**Path A — MT5 / Phase B live pipeline.**
`artifacts/api-server/src/lib/live/liveCommandPipeline.ts` →
`dispatchLiveCommand` → ~25 sequential blocking checks, of which the 23-gate
evaluator (`lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts`) is one
checkpoint, running late (≈line 3345 of 4861) → `selectExecutionAdapter(EXECUTION_ADAPTERS, row.executionVenue)`
at `liveCommandPipeline.ts:3676` → `mt5ExecutionAdapter`.

`EXECUTION_ADAPTERS` (`liveCommandPipeline.ts:4320`) maps `MT5_EA_BRIDGE` to the
real adapter and **`DERIV_DEMO` to a `deliver()` that throws**
`DERIV_DEMO_ADAPTER_NOT_WIRED`. A Deriv command reaching this pipeline fails
closed: no adapter, no frame, no order. That is deliberate — the Deriv adapter
needs per-request dependencies (resolved tier, proven-demo assertion, durable
intent writer) and cannot be a module constant without reading ambient state.

**Path B — Phase 6 guided execution (Deriv demo).**
`artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts` is the **single
guided composition point**. It calls `adapter.deliver(...)` directly at
`guidedDispatchEntry.ts:737`, backed by `guidedBuy`
(`lib/deriv/execution/derivGuidedBuy.ts`) over the Phase 5 certified new-API
transport.

Both files are explicitly allowlisted in
`scripts/src/ci/check-phase6-execution-safety.ts` (rule R1) as the only files
permitted to invoke a venue adapter's `deliver()`.

> **Divergence from design, recorded honestly.**
> `docs/PHASE6_GUIDED_EXECUTION_DESIGN.md` (Finding 2a) argued that "the Deriv
> path must enter through `dispatchLiveCommand` itself, not call the evaluator
> directly. Anything else would be bypassing the boundary while appearing to
> honour it." **That is not how it landed.** The guided path is a parallel
> composition point with its own wall set, not an entry into `dispatchLiveCommand`.
> Whether the guided walls are equivalent to the ~20 pre-gates the MT5 path runs
> is **not established by any artifact in this repository** and is the single
> largest open architectural question. See §6.

### The guided path's own walls (verified in code)

| Wall | Where |
|---|---|
| Execution tier resolution (whitelist of exact literals) | `executionTier.ts`, read only by `guidedDispatchEntry.ts` |
| Deriv dependency resolver — 12 named refusals | `phase6/derivDependencyResolver.ts` |
| Kill switch, fail-closed, **three** switches consulted | `guidedDispatchEntry.ts:172` `liveKillSwitchEngaged` |
| Gate 18 risk disclosure, real acceptances-table read | `guidedDispatchEntry.ts:~194`, enforced pre-claim |
| Approval ticket CAS claim against the DB clock | `approvalTicketsRepo` + `guidedExecutionService.ts` |
| Per-user advisory lock serialising dispatch | `lib/concurrency/advisoryLock.ts`, namespace `GUIDED_DISPATCH` |
| Constitution re-evaluated at dispatch | `tradingConstitution.ts` |
| Unresolved-intent wall | `derivOrderIntentsRepo.hasUnresolvedIntent` |
| Observed-state loader derived from the guided ledger | `guidedDispatchEntry.ts` (live loader, commit `bb3a72b`) |

The kill-switch read consults **three** stores and fails closed on every one:
per-user `arx_live_arming.killSwitchEngaged === true` blocks; global
`globalTradingSettings.emergencyKillSwitch !== false` blocks (absent/null counts
as ENGAGED); `safetyCore.killSwitchEngaged === true` blocks; any read failure
counts as ENGAGED. The guided path is deliberately **stricter than MT5** here —
the MT5 pipeline does not read the Phase 1 safety-core switch.

### Deriv transport (Phase 5, certified and frozen)
```
artifacts/api-server/src/lib/deriv/newApi/
  restClient.ts  accounts.ts  otp.ts  transport.ts  wire.ts
  orderIntent.ts errors.ts    certify.ts demoTradeCertify.ts
  evidenceCapture.ts liveEvidence.ts evidenceToFixture.ts
```
Flow: Bearer PAT + `Deriv-App-ID` → REST account discovery → deterministic demo
selection → account OTP → authenticated new WebSocket (no legacy `authorize`
frame is ever sent). Legacy-mode credentials can never reach the new path and
vice versa (Owner Ruling 15a).

### Phase 6 persistence
`lib/db/src/schema/phase6GuidedExecution.ts` defines four tables:
`trading_constitutions`, `approval_tickets`, `deriv_order_intents`,
`guided_attempt_events`. Repositories:
`lib/db/src/repositories/{tradingConstitutionRepo,approvalTicketsRepo,derivOrderIntentsRepo,guidedAttemptEventsRepo}.ts`.

### Phase 6 HTTP surface
`artifacts/api-server/src/routes/meApprovalInbox.ts` (registered at
`routes/index.ts:307`):
```
GET  /me/approval-tickets
GET  /me/approval-tickets/:ticketId
POST /me/approval-tickets                      (propose)
POST /me/approval-tickets/:ticketId/approve
POST /me/approval-tickets/:ticketId/reject
POST /me/approval-tickets/:ticketId/dispatch
POST /me/trading-constitution
GET  /me/trading-constitution
```
`artifacts/api-server/src/routes/meGuidedPositions.ts` (registered at
`routes/index.ts:309`):
```
GET /me/guided-positions
GET /me/guided-journal
GET /me/guided-journal/:intentId
GET /me/guided-debrief/:intentId
```
All are `requireUser`-guarded.

### Phase 6 UI
`artifacts/trading-dashboard/src/pages/approval-inbox.tsx`, with a sidebar entry
in the Primary group (`AppLayout.tsx`) and a command-palette entry
(`CommandPalette.tsx`), both added in commit `15b4edf`. The page distinguishes
unauthenticated / load-error / confirmed-empty states (commit `ee641c5`).

### Background workers
`artifacts/api-server/src/index.ts` starts:
- `startUnknownReconcilerWorker()` (line 141) — `reconcileUnknownCommands` every
  60s, opt-out via `ARX_UNKNOWN_RECONCILER_ENABLED`.
- `startGuidedSweeperWorker()` (line 148) — Phase 6 TTL sweeper.

---

## 3. Current phase and status

**Phase 6 — Self-Trading Guided Mode.** Authorized by the owner on 2026-08-27
for **controlled guided/demo execution only** (Owner Ruling 19).

Release tiers, server-authoritative:
- **Tier 0** — dry run: all gates and adapter mapping run; the transport refuses
  before any frame is sent.
- **Tier 1** — demo guided execution on an approved, unexpired ticket.
- **Tier 2** — demo supervised continuous session.
- **Tier 3 (live guided) and Tier 4 (autonomous) must NOT be enabled.**

**Status: Tier 0 certified at the product-path level; Tier 1 built and armed but
NOT executed. Zero demo orders have ever been placed through the guided path.**

Evidence for "zero orders": `deriv_order_intents` has 0 rows and
`guided_attempt_events` has 0 rows in the live database.

### Verification run at HEAD (2026-08-27, this workspace)

| Check | Command | Result |
|---|---|---|
| Full typecheck | `pnpm run typecheck` | **exit 0 — green** |
| Invariant guards | `pnpm run ci:guards` | **65/65 passed in 7.02s** |
| Phase 6 node suites (11) | `test:phase6-*` | **209 tests, 208 pass, 1 fail** |
| Approval Inbox UI honesty | `test:approval-inbox-honesty` | **15/15 pass** |
| `arx_live_commands` row count | SQL | **0** (launch invariant holds) |

Per-suite Phase 6 counts: constitution 23, approval 28, indeterminate 13,
deriv-adapter 20, ttl 9, venue-routing 16, tier0-e2e 14, deriv-deps 20,
lineage-sweeper 19, **tier0-product 33 (32 pass / 1 fail)**, surfaces 14.

---

## 4. Implemented systems

### Certified and committed (Phase 6)
| Component | Location |
|---|---|
| Venue gate parity contract + Deriv demo map (23/23 dispositions) | `lib/domain/src/safety-contracts/{venueGateParity,derivDemoGateParity}.ts` |
| Personal Trading Constitution | `lib/domain/src/safety-contracts/tradingConstitution.ts` |
| Approval ticket lifecycle + material-terms binding | `lib/domain/src/safety-contracts/approvalTicket.ts` |
| Execution tier resolver | `lib/domain/src/safety-contracts/executionTier.ts` |
| Execution venue contract | `lib/domain/src/safety-contracts/executionVenue.ts` |
| TTL sweep policy | `lib/domain/src/safety-contracts/guidedTtlPolicy.ts` |
| Indeterminate delivery outcome (third seam outcome → `LIVE_UNKNOWN`) | `lib/live/executionAdapter.ts` + pipeline branch |
| DerivExecutionAdapter | `lib/deriv/execution/derivExecutionAdapter.ts` |
| Guided buy over the certified transport | `lib/deriv/execution/derivGuidedBuy.ts` |
| Guided dispatch composition point | `lib/phase6/guidedDispatchEntry.ts` |
| Guided execution service | `lib/phase6/guidedExecutionService.ts` |
| Deriv dependency resolver | `lib/phase6/derivDependencyResolver.ts` |
| Forensic lineage ledger | `lib/phase6/guidedLineage.ts` |
| Autonomous TTL sweeper worker | `lib/phase6/guidedSweeperWorker.ts` |
| Persistence: 4 tables + 4 repositories | `lib/db/src/schema/phase6GuidedExecution.ts` |
| Approval Inbox routes, UI, nav, command palette | `routes/meApprovalInbox.ts`, `pages/approval-inbox.tsx` |
| Position centre / journal / debrief routes | `routes/meGuidedPositions.ts` |
| Tier 1 certification harness + seeder | `src/scripts/tier1DemoCertify.ts`, `src/scripts/tier1SeedCertificationTicket.ts` |
| Phase 6 execution-safety CI guard (R1/R2/R3) | `scripts/src/ci/check-phase6-execution-safety.ts` |

### Pre-existing platform (unchanged by Phase 6)
- Phase B live broker execution, default-deny, 23 gates, MT5 EA bridge (per-user
  tokens only, SHA-256 hashes stored).
- Ruby AI assistant as a permission-bounded executor with **no second execution
  path** — every authorised action routes through the same instant-trade router
  → live pipeline → 23-gate dispatch. `AI_AUTO` defined but not enabled.
- Scanner, chart intelligence, market/news/economic-calendar providers with
  real-or-empty honesty.
- Unknown-command reconciler worker (60s cadence).
- Fundbook, missions, agent ecosystem, admin cockpit, investor surfaces.
- `docs/ARCHITECTURE_MAP.md` remains the structural map, with its own
  correction preamble; its headline status claims below that preamble are
  historical.

---

## 5. Active work

**Tier 1 demo certification — one Deriv demo order, end to end through the
guided product path.** Everything is built and the environment is armed. It has
never been run.

The harness:
```bash
pnpm --filter @workspace/api-server run certify:tier1-demo -- \
  --account=<loginid> --user=<id> --i-authorize-one-demo-order
```
It runs all pre-flight checks, refuses on any failure **without placing an
order**, and with no arguments fails all of them. It does not place the order
itself: it clears pre-flight and hands over to the guided product path
(propose → approve in the inbox → dispatch), so what is certified is the path a
user actually takes.

Certification ticket parameters (`docs/PHASE6_TIER1_PREFLIGHT.md`): $1 stake,
multiplier 100, `R_100`, stop attached (the Constitution requires one). One
order, fully reconciled before any consideration of a second.

**Stop condition:** if any execution state becomes UNKNOWN or UNRESOLVED, stop
placing orders, do not retry, and resolve through the certified Phase 5
reconciliation model.

---

## 6. Known blockers

### B1 — The global emergency kill switch is ENGAGED (hard blocker)
```sql
select emergency_kill_switch from global_trading_settings limit 1;  -- t
select kill_switch_engaged   from safety_core             limit 1;  -- f
select * from arx_live_arming where user_id = 7;                    -- (no row)
```
`liveKillSwitchEngaged` blocks when `emergencyKillSwitch !== false`. While this
row reads `true`, **every guided dispatch refuses `KILL_SWITCH_ENGAGED` and no
Tier 1 order can be placed.** Whether this is a deliberate hold or leftover
state is **UNKNOWN** — it requires an owner answer, not an agent's assumption.
Do not clear it without one.

### B2 — `tier0ProductCertificate.test.ts` fails 1/33 at HEAD (reproducible here)
```
✖ with NO observed state wired, the product still refuses — never trades blind
  AssertionError: the refusal does not state that nothing was sent:
    DERIV_DEPS_REFUSED:KILL_SWITCH_ENGAGED: the per-user kill switch is engaged
  expected: /nothing was sent|could not establish dispatch preconditions/
  at src/lib/phase6/__qa__/tier0ProductCertificate.test.ts:391
```
**Diagnosis (evidence-based, not speculative).** The test overrides most
dependencies but leaves `resolveDerivDependencies` live, so it reads the real
database. Because B1 holds, the kill-switch wall refuses **before** the
unreadable-observed-state wall the assertion targets. The two assertions that
matter for safety still pass — `outcome.ok === false` and
`outcome.indeterminate === false`; only the refusal *message* differs.

So: **the safety behaviour holds; the certificate is not hermetic.** It couples
a Tier 0 product claim to mutable database state, which means the suite's result
is not reproducible across environments. That is a defect in the certificate,
and it must be fixed before the suite can be cited as evidence again.
See `docs/CERTIFICATIONS.md` §"Contested".

### B3 — Phase 6 routes are absent from the OpenAPI contract
```bash
grep -cE '/me/approval-tickets|/me/guided-' lib/api-spec/openapi.yaml   # 0
```
`lib/api-spec/openapi.yaml` is declared the source of truth, but none of the
twelve Phase 6 endpoints appear in it. Consequently there are no generated Zod
schemas and no generated React-Query hooks for them, and the frontend reaches
them outside the generated client. This is a contract gap, not a runtime bug.

### B4 — The gate-parity map has no runtime consumer
`DERIV_DEMO_GATE_PARITY` and `assertVenueGateParity` are referenced **only**
inside `lib/domain/src/safety-contracts/` (and the compiled `dist/`). Nothing in
`artifacts/api-server` evaluates the parity map at dispatch time.

The map is therefore a **compile-time totality contract plus a tested pure
function** — real, but not a runtime gate. The design document's promise that
"the venue evaluator refuses to dispatch if any of the 23 keys has no
disposition" is enforced by TypeScript's exhaustive `Record` type and by tests,
**not by a check executed on the dispatch path.** Adding a twenty-fourth gate would
fail the build, which is the intended protection; it would not fail a dispatch.

### B5 — Guided-path equivalence to the MT5 pre-gates is unestablished
Because Path B does not enter `dispatchLiveCommand` (§2), the ~20 pre-gates
that path runs — risk locks, price collars, exposure reservation, allocation
gate, double-send CAS — are **not** run by the guided path. The guided path has
its own walls (§2), several of them stricter. No artifact in this repository
maps one set onto the other. **UNKNOWN whether coverage is equivalent.**

### B6 — Owner decisions outstanding
- Ruling 10a — `ARX_REQUIRE_FRESH_RECONCILIATION` stays default-OFF until an
  operator confirms on Replit that `reconciliation_runs` rows accumulate with
  `status = COMPLETED` and a pass logs `unknown_reconciler_pass` cleanly.
- Ruling 11 — `shared_master_accounts.max_total_exposure_lots = 0` still means
  UNLIMITED.
- Ruling 13 — `stableStringify` bigint/string canonical collision is **pinned,
  not fixed**. Owner must choose: re-encode (invalidating stored hashes) or
  constrain callers.
- Ruling 14 — replay determinism is **not implemented**. Decisions are
  re-runnable, not replayable. Deferred until after Deriv certification.
- Ruling 15 — the "new mode" route-selection defect is executed as 15a
  (quarantined), but the question of proving or removing the mode remains
  formally open.

### B7 — Unexercised Deriv failure modes
No live run has ever exercised: a **rejected** order, a **partial** fill, or a
**requote** between quote and buy. Buy/sell is certified for the happy path only
(Rulings 17, 18).

### B8 — Stale documentation that will mislead the next reader
| Document | Stale claim | Reality at HEAD |
|---|---|---|
| `docs/PHASE6_TIER1_PREFLIGHT.md` | "Schema still to apply — `phase6-additive-schema-2.sql`" | All four Phase 6 tables exist in the database |
| `docs/PHASE6_GUIDED_EXECUTION_DESIGN.md` §"NOT yet built" | Venue-aware dispatch, venue column, repositories, routes, UI, sweeper worker all missing | All present; the doc predates commits 19–25 |
| `docs/LAUNCH_CANDIDATE.md` | guards "56/56", elsewhere "21/21" | 65/65 |
| `docs/KNOWN_ISSUES.md` | `TS6059` rootDir cascade in `@workspace/scripts` blocks `pnpm run typecheck` | `pnpm run typecheck` exits 0 |
| `docs/ARCHITECTURE_MAP.md` | 23 tables / 24 pages / paper-only framing | Superseded; the file's own preamble says so |

---

## 7. Environment (this Replit workspace)

Configuration **names and non-secret values only**. No secret value appears in
this document.

| Variable | Value | Effect |
|---|---|---|
| `ARX_EXECUTION_TIER` | `TIER_1_DEMO_GUIDED` | **Tier 1 is armed.** Only the exact literal resolves; anything else falls back to `TIER_0_DRY_RUN` |
| `ARX_LIVE_BROKER_EXECUTION_ENABLED` | `true` | Phase B gate #1 of 23 only; bypasses nothing |
| `ARX_DERIV_OWNER_USER_ID` | `1` | — |
| `DERIV_ENABLED` | `True` | — |
| `DERIV_API_MODE` | `new` | New-generation API path (Ruling 15a) |
| `DERIV_WS_URL` | `wss://ws.derivws.com/websockets/v3` | — |
| `DERIV_APP_ID`, `DERIV_API_TOKEN`, `DERIV_ACCOUNT_ID` | set (values not recorded) | new-generation credential shape |
| `DATABASE_URL`, `SESSION_SECRET` | set (values not recorded) | — |

### Live database state (audit-time snapshot)
| Table | Rows |
|---|---|
| `trading_constitutions` | 1 |
| `approval_tickets` | 3 — 1 `PENDING`, 1 `EXPIRED`, 1 `CANCELLED` |
| `deriv_order_intents` | 0 |
| `guided_attempt_events` | 0 |
| `arx_live_commands` | 0 |

Unresolved Deriv intents (the Tier 1 pre-flight requirement) — **0**, which
satisfies the pre-flight check:
```sql
select count(*) from deriv_order_intents
 where resolved_at is null and write_disposition in ('WRITTEN','UNRECORDED');
```

### `artifacts/api-server/deriv-evidence.json` (untracked)
A read-only evidence capture from **2026-08-26T08:24:07Z**, tier `READ_ONLY`,
`accountType: demo`, 8 probes. It records credential **shapes** only
(`appIdShape: "alphanumeric"`, `mode: "new"`, `tokenLength: 68`) and a 4-character
account suffix. It contains **no credential values**. It is untracked and not
covered by `.gitignore`; whether it should be committed is **UNKNOWN**.

### Replit workflows (`.replit`)
The `Project` run button executes five parallel validation workflows:
`safety-integration` (`ARX_REQUIRE_INTEGRATION_DB=true pnpm run ci:integration`),
`typecheck` (`pnpm run typecheck:ci`), `ci-guards`, `targeted-tests`, `full-ci`.

---

## 8. Next work

In order.

1. **Get an owner answer on the global emergency kill switch (B1).** Nothing
   downstream can proceed while it reads `true`, and an agent must not clear it.
2. **Fix the Tier 0 product certificate's hermeticity (B2).** Stub the Deriv
   dependency resolver in the observed-state test so the assertion reaches the
   wall it targets, and add a separate test that asserts the kill-switch wall
   refuses first. Mutation-prove both.
3. **Run the Tier 1 demo certification** once 1 and 2 are clear, with the
   explicit `--i-authorize-one-demo-order` consent flag, one order only, fully
   reconciled before any second is considered.
4. **Close the OpenAPI gap (B3)** — add the twelve Phase 6 paths to
   `lib/api-spec/openapi.yaml`, regenerate, and move the frontend onto the
   generated client.
5. **Resolve B5 explicitly**: either write and test a mapping from the MT5
   pre-gates onto the guided walls, or route the guided path through
   `dispatchLiveCommand` as the design document intended. This is an
   architecture decision, so it is an owner decision.
6. **Decide whether the parity map should become a runtime check (B4)**, or
   document clearly that it is a compile-time contract so no future reader
   mistakes it for a dispatch-time gate.
7. **Refresh the stale documents listed in B8** so they stop contradicting the
   code.
8. **Then** the remaining owner decisions in B6 (Rulings 10a, 13, 14, 15).

Not next, and not without a new owner ruling: Tier 2 continuous sessions, Tier 3
live guided, Tier 4 autonomous, real money, Managed Allocation.
