# Handoff

**As of:** 2026-08-27
**Branch:** `phase6/guided-mode`
**HEAD:** `ee641c5cdea7982ef1535e9579234f0772a12793` — *"Phase 6: a 401 must never
look like an empty inbox"*
**Position:** 37 commits ahead of `main`, 0 behind. Pushed —
`origin/phase6/guided-mode` is at the same SHA.

Read `CLAUDE.md` first, then `docs/PROJECT_STATE.md` for the full picture. This
file is the short version.

---

## Where the project is

**Phase 6 — Self-Trading Guided Mode**, authorized 2026-08-27 for controlled
guided/demo execution only (Owner Ruling 19).

Tier 0 (dry run) is certified at the product-path level. Tier 1 (one approved
demo order through the guided product path) is **fully built and the environment
is armed — but it has never been run.**

**Zero demo orders have ever been placed through the guided path.** Evidence:
`deriv_order_intents` = 0 rows, `guided_attempt_events` = 0 rows.

---

## Last completed work

The final stretch (commits `64bc6a3` → `ee641c5`) was an audit-and-repair run,
not new feature work. In order:

| Commit | What it closed |
|---|---|
| `64bc6a3` | **Audit round 1 — the success path was broken four ways.** Every real ticket id tripped the secret heuristic (`GET /me/approval-tickets` 500'd, so the owner could never have *seen* a ticket); the EXECUTED audit row hard-coded `venueContractRef: null`; **nothing ever settled** a dispatched ticket; a throw after possible transmission became a bare 500 inviting retry. |
| `169a7ca` | **Audit round 2 — ten CRITICALs, four root causes.** A claim-race loser settled the winner's ticket; honest text tripped the secret scan so UNKNOWN vanished from the ledger and `--verify` read it as "nothing was dispatched"; a crash between frame and reply left no footprint; gate 5 (kill switch) was hard-stubbed disengaged while the parity map claimed it enforced; gate 18 was never consulted. 19/19 mutations killed. |
| `7efd63c` | **HIGH findings.** One bad venue string could 500 the inbox permanently; the R1 guard's regex could not see `adapter.deliver(`; a **third** kill switch existed that the guided path never read. |
| `bb3a72b` | **The live observed-state loader.** The production route passed no loader and the default was deliberately-unusable `NaN`, so every real dispatch refused `CONSTITUTION_MALFORMED` — the certification could never have completed. |
| `fb05a57` | Four confirmed findings: proposal-phase refusals wrongly read as INDETERMINATE and froze the user's whole guided surface; late venue replies discarded; the resolver's unresolved-intent check was wired `async () => false`; per-user dispatch serialization added (pg advisory xact lock). |
| `ec76aa4` | The completeness critic's findings, including one against the author's own lock: a completed dispatch could be reported as "nothing was sent" if the lock's COMMIT failed after the venue round-trip. Rule established: **a captured outcome always wins**. |
| `15b4edf` | The Approval Inbox had **no navigation entry** — reachable only by typing the URL. Sidebar + command palette added. |
| `ee641c5` | A 401 rendered identically to "no trades are waiting for your decision". Explicit unauthenticated / load-error / confirmed-empty states. |

---

## What changed, structurally

- A **second sanctioned dispatch composition point** now exists:
  `artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts`, alongside
  `lib/live/liveCommandPipeline.ts`. Both are allowlisted in
  `scripts/src/ci/check-phase6-execution-safety.ts` (R1).
- The execution seam gained a **third outcome** (indeterminate → `LIVE_UNKNOWN`,
  reservation **held**), leaving MT5 byte-equivalent.
- Four Phase 6 tables + four repositories; twelve HTTP endpoints; the Approval
  Inbox UI; a TTL sweeper worker started at server boot.
- `arx_live_commands` gained an `execution_venue` column;
  `EXECUTION_ADAPTERS.DERIV_DEMO` deliberately throws, so the MT5 pipeline fails
  closed on a Deriv command.

---

## What is green (verified at HEAD, this workspace, 2026-08-27)

| Check | Command | Result |
|---|---|---|
| Full typecheck | `pnpm run typecheck` | **exit 0** |
| Invariant guards | `pnpm run ci:guards` | **65/65 in 7.02s** |
| Approval Inbox UI honesty | `pnpm --filter @workspace/trading-dashboard run test:approval-inbox-honesty` | **15/15** |
| Phase 6 node suites | 11 `test:phase6-*` scripts | **209 tests — 208 pass, 1 fail** |
| Launch invariant | `select count(*) from arx_live_commands` | **0** |
| Tier 1 pre-flight: no unresolved intent | `deriv_order_intents` unresolved | **0** ✅ |
| Phase 6 schema applied | all four tables present in the database | ✅ |

`pnpm run ci` (the full several-hundred-suite gate) was **not** run in this
session — it was out of scope for a documentation task and takes far too long.
Its status at HEAD is **UNKNOWN**.

---

## What is blocked

### 1. The global emergency kill switch is ENGAGED — hard blocker
```sql
select emergency_kill_switch from global_trading_settings limit 1;  -- t
```
`liveKillSwitchEngaged` blocks when this is anything other than `false`. While
it reads `true`, **every guided dispatch refuses `KILL_SWITCH_ENGAGED`** and no
Tier 1 order can be placed. Whether this is a deliberate hold or leftover state
is **UNKNOWN**; no ruling in the repository addresses it. **Do not clear it.**

### 2. `tier0ProductCertificate.test.ts` fails 1 of 33
```
✖ with NO observed state wired, the product still refuses — never trades blind
  actual:   DERIV_DEPS_REFUSED:KILL_SWITCH_ENGAGED: the per-user kill switch is engaged
  expected: /nothing was sent|could not establish dispatch preconditions/
  tier0ProductCertificate.test.ts:391
```
The test leaves `resolveDerivDependencies` live, so it reads the real database;
because of blocker 1 the kill-switch wall refuses **before** the wall the
assertion targets. The safety assertions still pass (`ok === false`,
`indeterminate === false`) — only the refusal message differs.

**The safety behaviour holds. The certificate is not hermetic**, and until that
is fixed the suite cannot be cited as reproducible evidence.

### 3. Contract gap — Phase 6 endpoints are absent from OpenAPI
```bash
grep -cE '/me/approval-tickets|/me/guided-' lib/api-spec/openapi.yaml   # 0
```
No generated Zod schemas, no generated React-Query hooks; the frontend reaches
these routes outside the generated client.

### 4. Unestablished equivalence
The guided path does not enter `dispatchLiveCommand`, so it does not run the
~20 MT5 pre-gates (risk locks, price collars, exposure reservation, allocation
gate, double-send CAS). It has its own walls, several stricter. **No artifact
maps one set onto the other. UNKNOWN whether coverage is equivalent.**

### 5. `DERIV_DEMO_GATE_PARITY` has no runtime consumer
It is a compile-time totality contract plus a tested pure function — not a
dispatch-time gate. Real protection (adding a 19th gate fails the build), but
not what the design prose implies.

---

## Owner actions required

Nothing below can be decided by an agent.

1. **Rule on the global emergency kill switch** — deliberate hold, or clear it?
   Everything downstream waits on this. (`docs/DECISIONS.md` O6.)
2. **Authorize the Tier 1 demo order**, when ready, via the explicit consent flag
   `--i-authorize-one-demo-order`. One order, smallest practical stake, fully
   reconciled before any second is considered.
3. **Decide the architecture question in blocker 4**: map the MT5 pre-gates onto
   the guided walls and test the mapping, or route the guided path through
   `dispatchLiveCommand` as the design document intended.
4. **Ruling 10a follow-through** — verify on Replit that `reconciliation_runs`
   rows accumulate with `status = COMPLETED` and a pass logs
   `unknown_reconciler_pass` cleanly, then decide whether to flip
   `ARX_REQUIRE_FRESH_RECONCILIATION` to `true`.
5. **Ruling 13** — re-encode bigints (invalidating stored hashes) or constrain
   callers.
6. **Ruling 15 / O2** — prove the new-mode route or remove it.
7. **Decide the fate of the uncommitted `pnpm-lock.yaml` change** (+99 / −1207
   lines). Its provenance is **UNKNOWN**; it was not produced by this task.

---

## Next recommended task

**Fix the hermeticity of `tier0ProductCertificate.test.ts` (blocker 2).**

It is the only failing check, it is self-contained, it does not require an owner
decision, and it does not touch application behaviour:

1. Stub `resolveDerivDependencies` in the *"with NO observed state wired"* test
   so the assertion reaches the unreadable-observed-state wall it targets.
2. Add a **separate** test asserting that the kill-switch wall refuses first
   when engaged — that ordering is real safety behaviour and deserves its own
   coverage rather than being an accident of database state.
3. Mutation-prove both: remove the behaviour, confirm the test fails red,
   against a **compiling** tree.
4. Re-run `pnpm run ci:guards` (expect 65/65) and `pnpm run typecheck`.

After that, and only after the owner answers action 1, the Tier 1 certification
run becomes the next task.

---

## Do-not-touch boundaries

**Frozen — reopening requires a recorded owner ruling:**
- **Phase 5** (`artifacts/api-server/src/lib/deriv/newApi/**`) is certified and
  frozen. If Phase 6 exposes a Phase 5 defect: reproduce → add a regression →
  fix minimally → mutation-prove → document why it had to be reopened.
- **The live decision schema** — untouched pending replay determinism
  (Ruling 14).

**Never weaken, and never edit to make something pass:**
- `lib/domain/src/safety-contracts/**`, especially
  `livePhaseBDispatchGate.ts` (the 18 gates), `executionTier.ts`,
  `venueGateParity.ts`, `derivDemoGateParity.ts`.
- `artifacts/api-server/src/lib/live/liveCommandPipeline.ts` and the MT5 dispatch
  path — the Phase 6 requirement is **byte-equivalent MT5 behaviour**.
- The kill switches. **No 5th kill switch, no 6th limit store** (Ruling 4). The
  only bypass is `killSwitchCloseBypassApplies` (Ruling 6).
- `scripts/src/ci/**` guards — extend them, never relax them. In particular
  `check-phase6-execution-safety.ts` (R1 adapter allowlist, R2 tier-env reader,
  R3 approval owner scoping) and `check-vault-mutations.ts`.

**Append-only — never edit or delete an existing entry:**
- `docs/OWNER_DECISIONS.md`, `docs/CAPITAL_CONSTITUTION.md` (headings pinned by
  a CI guard), and the ledgers `audit_events`, `vault_events`,
  `state_transitions`, `execution_events`, `owner_decisions`.

**Generated — never hand-edit:**
- `lib/api-zod/src/generated/**`, `lib/api-client-react/src/generated/**`.
  Change `lib/api-spec/openapi.yaml` and run the codegen.

**Database:**
- No destructive migrations. Additive only. Schema reaches the database by
  owner-run `drizzle-kit push` or an additive SQL file — there is no migration
  system, so adding a table to `lib/db/src/schema/` creates nothing until
  someone applies it.

**Environment:**
- Do not flip `ARX_EXECUTION_TIER` beyond `TIER_1_DEMO_GUIDED`. Tiers 3 and 4
  must not be enabled (Ruling 19). No code path may escalate a tier from the
  mere presence of an environment variable.
- Do not clear the global emergency kill switch without an owner ruling.
