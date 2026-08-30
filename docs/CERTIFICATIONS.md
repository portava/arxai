# Certifications

**What this file is.** A register of components whose behaviour is backed by
evidence that actually exists in this repository, with the evidence named so a
reader can re-run it. Certification is not "it works" — it is **"here is the
artifact that would fail if it stopped working."**

**Verified:** 2026-08-27 against HEAD `ee641c5cdea7982ef1535e9579234f0772a12793`.

**Standing rule** (Capital Constitution Article IV): authority is earned by
evidence, expires unless the evidence remains current, and **green CI alone
never grants live authority.**

---

## Evidence grades used below

| Grade | Meaning |
|---|---|
| **A — Live venue evidence** | A run against the real venue produced a recorded result. Cited to the owner ruling that records it. |
| **B — Deterministic test + CI guard + mutation proof** | A test asserts it, a guard prevents a second implementation elsewhere, and the behaviour was shown to fail red when removed. |
| **C — Deterministic test only** | A test asserts it. No guard, or no mutation proof recorded. |
| **D — Compile-time contract** | Enforced by the type system and/or a pinned list. Real, but not evaluated at runtime. |
| **Contested** | Something in the certification does not hold today. Stated, never quietly downgraded. |

### A standing caveat on mutation evidence

Mutation results in this repository are recorded in **commit messages only**
(e.g. `ec76aa4`: "Both mutations killed against a compiling tree";
`169a7ca`: "19/19 killed"). **No mutation report artifact is stored in the
repository**, so those counts cannot be independently re-derived from the tree
today. They are recorded below as *self-reported at commit time*, which is what
the evidence supports — not as re-verified facts.

One committed mutation harness does exist:
`scripts/src/gateMutationTest.ts` — six surgical mutations against
`liveCommandPipeline.ts` plus one against `check-vault-mutations.ts`, each
required to make its guarding test exit non-zero, with worktree-dirty refusal
and hash-verified restoration. **It is not wired into any npm script, the `ci`
lane, or `.replit`** (`grep -rn gateMutationTest` finds no runner). Wiring it is
straightforward and would upgrade several rows below from C to B.

---

## Platform-wide checks (re-run in this audit)

| Check | Command | Result at HEAD |
|---|---|---|
| Invariant guards | `pnpm run ci:guards` | **65/65 passed, 7.02s** |
| Full workspace typecheck | `pnpm run typecheck` | **exit 0** |
| Launch invariant | `select count(*) from arx_live_commands` | **0** |

`pnpm run ci` — the full named-suite gate, several hundred suites — was **not**
run in this session. Its status at HEAD is **UNKNOWN**.

---

## Certified — Grade A (live venue evidence)

### Deriv new-API transport, read-only
- **Ruling:** Owner Ruling 16, 2026-08-25.
- **Evidence:** `pnpm --filter @workspace/api-server run certify:deriv-new-api`,
  2026-08-25 17:50 UTC — **17/17 steps** on a demo account. REST account
  discovery, deterministic demo selection, OTP, authenticated WebSocket (no
  `authorize` frame sent), ping, server clock, 89 active symbols,
  `contracts_for`, a priced `proposal` carrying a buyable id, `balance`,
  `portfolio`, and the read-only gate refusing a buy.
- **Also settled by this run:** multipliers **are** served on the
  `/trading/v1/options/` surface — `R_100` returned 65 contract types including
  multipliers. The program had carried this as an explicitly open assumption
  rather than treating "options is probably an umbrella name" as fact.
- **Re-runnable:** yes; it places no trade by construction.
- **Explicitly NOT certified by it:** trading. `buy` and `sell` have mappers and
  normalizers; certifying the transport is not certifying order placement.
- **Code:** `artifacts/api-server/src/lib/deriv/newApi/{restClient,accounts,otp,transport,wire}.ts`

### Deriv demo buy → open → sell → venue-confirmed settlement
- **Ruling:** Owner Ruling 17, 2026-08-25. Contract `10545847099`.
- **Proven:** an order reaches the venue and returns a contract id; that id is
  tracked open through close; the sell targets that exact contract; settlement is
  confirmed **by the venue**, not inferred from the sell reply; the open-position
  alarm clears only on the venue's verdict.
- **NOT proven by that run, stated by the ruling itself:** the P/L was exactly
  **0**, so the reconciliation comparison only ever evaluated `0 === 0`. A
  reconciliation that always returned zero would have produced byte-identical
  output.

### Deriv P/L reconciliation on a non-zero result
- **Ruling:** Owner Ruling 18, 2026-08-25. Contract `10548672559`.
- **Evidence:** bought at 1, held 60s, sold for 1.03, venue-confirmed settled.
  Derived P/L `0.030000000000000027` vs Deriv-reported `0.03` — **agrees**,
  graded `evidence: non-zero`. Whole-cent comparison handled the float exactly.
- **Amendment, recorded because it matters:** the ruling's original
  spot-movement figure was **withdrawn** — ARX had paired the proposal's
  pre-trade quote with a post-settlement streaming tick and presented the delta
  as the trade's movement. The **P/L evidence is unaffected and stands**;
  `derived = proceeds − cost` never involved those spot fields. Fixed: the
  venue's own `entry_spot`/`exit_spot` are read with **no** fallback to the quote
  or the tick — `UNRESOLVED` is the honest answer when Deriv is silent.
- **Also certified by this ruling:** keepalive (15s hold slices with a read-only
  `ping`), reconnect-with-fresh-OTP on a dropped socket, and
  `close:deriv-demo-position` recovering a stranded position by **explicit id
  only** — it never discovers positions on its own, so it cannot become a bulk
  flattener.

> **Boundary on all three.** Buy/sell is certified for the **happy path only**.
> A **rejected** order, a **partial** fill, and a **requote** between quote and
> buy remain unexercised by any live run (Ruling 18).

### Deriv account is DEMO — read-only evidence capture
- **Artifact:** `artifacts/api-server/deriv-evidence.json` (untracked),
  captured 2026-08-26T08:24:07Z, tier `READ_ONLY`, `accountType: demo`, 8 probes.
- Records credential **shapes** only (`appIdShape: "alphanumeric"`,
  `mode: "new"`, `tokenLength: 68`) plus a 4-character account suffix. **No
  credential values.**
- **Caveat:** untracked and not covered by `.gitignore`. Whether it should be
  committed is **UNKNOWN**.

---

## Certified — Grade B (test + guard + mutation proof recorded)

### Only two files may invoke a venue adapter's `deliver()`
- **Guard:** `scripts/src/ci/check-phase6-execution-safety.ts`, rule **R1**.
- **Allowlist:** `lib/live/liveCommandPipeline.ts` (MT5 dispatch) and
  `lib/phase6/guidedDispatchEntry.ts` (the one guided composition point).
  Adapter class definitions are excluded — defining `deliver()` is not a call
  site.
- **Mutation proof:** commit `7efd63c` records that the guard's regex previously
  required at least one character before `adapter`, so the most natural receiver
  name — `adapter.deliver(` — was **invisible**, including at the guided
  composition point's own call site. Widened, and proven by injecting a
  bare-adapter route call and watching the guard fail.
- **Singularity of the guided composition point** is separately asserted by the
  Tier 0 product certificate ("there is exactly ONE composition point for a
  guided dispatch" — passing).

### Only one file may read `ARX_EXECUTION_TIER`; only one may interpret it
- **Guard:** same file, rule **R2**. Env reader:
  `lib/phase6/guidedDispatchEntry.ts`. Interpreter:
  `lib/domain/src/safety-contracts/executionTier.ts`.
- **Behaviour:** `resolveExecutionTier` whitelists **exact literals**. Absent,
  empty, `"1"`, `"true"`, wrong case and near-misses all resolve to
  `TIER_0_DRY_RUN`. Presence is never consulted, only value — which is exactly
  the escalation Ruling 19 forbids.
- **Test:** `tier0ProductCertificate.test.ts` — *"no tier value reachable through
  the environment produces a wire write"* — **passing**.

### Approval tickets are owner-scoped
- **Guard:** same file, rule **R3** — any handler touching `approvalTicketsRepo`
  must resolve an authenticated user.
- **Test:** *"a connection owned by ANOTHER user never reaches the venue"* —
  **passing**. Ownership is checked at both hops: connection→user and
  account→connection.

### The kill switch is consulted for real, and fails closed
- **Root cause it closed:** commit `169a7ca` — gate 5 was **hard-stubbed to
  disengaged** in the live wiring while the parity map declared it enforced. The
  parity claim was true on paper and false in the wiring.
- **Behaviour** (`guidedDispatchEntry.ts:172` `liveKillSwitchEngaged`): three
  stores consulted — per-user `arx_live_arming.killSwitchEngaged === true`
  blocks; global `globalTradingSettings.emergencyKillSwitch !== false` blocks
  (absent/null counts as ENGAGED); `safetyCore.killSwitchEngaged === true`
  blocks. **Any read failure counts as ENGAGED.**
- The third (Phase 1 safety-core) switch was added in `7efd63c` because an
  operator engaging it believes *all* order flow halts. The guided path is
  deliberately **stricter than MT5** here.
- **Test:** *"the LIVE kill-switch wiring consults the real switch and fails
  CLOSED"* — **passing**.
- **Live confirmation, unintended but real:** the switch is currently engaged in
  this database and the guided path does refuse. See **Contested** below.

### Gate 18 (risk disclosure) is enforced, and a waiver is never the user's consent
- **Root cause:** `169a7ca` — the parity map declared it EQUIVALENT while nothing
  on the guided path read the acceptances table.
- **Behaviour:** enforced at proposal **and** pre-claim at dispatch, using the
  same query the MT5 pipeline uses; the operator waiver is reported
  **separately** so it can never be presented as the user's own consent.
- **Tests:** *"GATE 18: no disclosure and no waiver refuses BEFORE the claim"*
  and *"GATE 18: an operator waiver permits dispatch but is not the user's
  consent"* — both **passing**.

### A claim-race loser settles nothing
- **Root cause:** `169a7ca` — introduced by the author's own settlement fix one
  commit earlier. Settlement ran on every outcome and CAS'd from `DISPATCHING`,
  which is the state the **winner** put the ticket in. On a double-click, the
  loser's "definite refusal" settlement would mark the winner's in-flight ticket
  `REJECTED` ("no order exists") while the winner's frame was at the venue.
- **Fix:** outcomes carry `claimed: true` only when *this* request won the CAS,
  and the gate sits at the **call site**, outside the injectable function —
  because an override replaces the function whole, gate included.
- **Tests (3, all passing):** *"A CLAIM-LOSER'S OUTCOME SETTLES NOTHING"*,
  *"a LOST claim reaches no settlement at all — even a spy's"*, *"the SUCCESS
  outcome carries claimed:true, or nothing would ever settle"*.
- **Mutation:** the re-arming mutation is recorded as killed (`169a7ca`,
  self-reported).

### A captured outcome always wins
- **Root cause:** `ec76aa4` — if a dispatch completed (venue confirmed,
  settlement committed on the normal pool) and the serialization lock's COMMIT
  then failed, the naive catch reported `acquired: false` and the route said
  *nothing was sent* about a real executed order.
- **Rule:** the lock is serialization only; its plumbing failing **after** the
  work ran does not un-happen the work's committed writes.
- **Tests (3, all passing):** *"A CAPTURED OUTCOME WINS when the lock's COMMIT
  fails after the work ran"*, *"a lock failure BEFORE the work ran refuses"*,
  *"a lost lock without running the work refuses"*.
- **Mutation:** both mutations recorded killed against a **compiling** tree —
  the commit explicitly notes the first "kill" was against a tree broken by the
  author's own botched slice, and that a killed mutation on a non-compiling tree
  proves nothing, so it was re-run after repair.

### The crash window between frame and reply has no gap
- **Root cause:** `169a7ca` — `persistIntent` wrote `NOT_ATTEMPTED` and the
  disposition changed only after the adapter returned. Kill the process
  mid-flight and `hasUnresolvedIntent` saw nothing: **the one order that must
  block the next one did not.**
- **Fix:** the intent row is **born `UNRECORDED`** (attempted, cannot tell) in
  the same insert. A later *proven* non-transmission still resolves it, so the
  footprint cannot lock a user out over an order that provably does not exist.
- **Test:** *"the intent row is born UNRECORDED — the crash window has no gap"*
  — **passing**.

### The live observed-state loader
- **Root cause:** `bb3a72b` — the production route passed **no** observed-state
  loader and the default was deliberately-unusable `NaN` fields, so **every real
  dispatch refused `CONSTITUTION_MALFORMED`**. Fail-closed, but the wall was
  load-bearing against its own missing wiring: the certification could never have
  completed.
- **Conservative in every reading, with one exception stated loudly:**
  "realised loss" counts every `EXECUTED`/`UNRESOLVED`/`DISPATCHING` ticket's
  full **stake** until settlement P/L is reconciled back, so `maxDailyLossUsd`
  behaves as max-staked-per-day; open positions count unresolved intents;
  trades-today counts `DISPATCHING` and `UNRESOLVED`; a read failure throws and
  the pre-transmission wrapper turns that into a definite refusal.
  **The exception:** `consecutiveLosses` is `0` until P/L reconciliation lands —
  the one field where the conservative direction is permissive, so the
  loss-streak cooldown gate is **INERT** for now and the daily-stake ceiling is
  what bounds damage meanwhile.
- **Scope, deliberate:** derived from the **guided** ledger only
  (`approval_tickets` + `deriv_order_intents`). MT5 activity answers to its own
  pipeline's gates; folding it in would double-count it against two policies.
- **Mutation:** replacing the loader with permissive zeros is recorded killed.

### Indeterminate delivery never becomes a false negative
- **Design:** `docs/PHASE6_GUIDED_EXECUTION_DESIGN.md` Decision 1. A third
  delivery outcome maps to `LIVE_UNKNOWN`, **holds** the exposure reservation,
  and hands the command to the existing unknown reconciler.
- **MT5 unchanged:** `Mt5EaBridgeAdapter` never produces the third outcome,
  because a local INSERT into the `mt5_commands` mailbox genuinely cannot be
  indeterminate.
- **Tests:** `test:phase6-indeterminate` — **13/13 pass**, including *"the
  indeterminate branch records LIVE_UNKNOWN, never LIVE_FAILED"* and
  *"routeDeliveryFailure sends everything else to DEFINITE_FAILURE"*.

### `execution_events` / `owner_decisions` append-only enforcement
- **Ruling 12** — enforced in CI, deliberately **not** by `REVOKE` (the app
  connects as a superuser; superusers bypass privilege checks, so the statement
  would alter the ACL and enforce nothing).
- **Guard:** `scripts/src/ci/check-vault-mutations.ts`, covering both the
  Drizzle symbol form (`.update(executionEventsTable)`) and the raw
  parameterized SQL form (`update execution_events …`) — the form these tables
  are actually written through.
- **Mutation proof:** the ruling records it "proven to fail red against all three
  violation shapes", and `scripts/src/gateMutationTest.ts` carries a case
  against this guard.
- **Deliberate exclusions:** `reconciliation_runs` and `production_edges` both
  legitimately mutate.

### Capital Constitution cannot be silently edited
- **Guard:** `scripts/src/ci/check-capital-constitution.ts` — pins all **8**
  article headings plus the central-rule sentence. Guard output at HEAD:
  *"8 pinned article heading(s) + central-rule sentence verified"*. **Passing.**

---

### Black-box feature parity — backtest = shadow = live, byte for byte (D2)
*(added 2026-08-29, branch `build/blackbox-parity`)*
- **Claim:** the ONE feature path (`computeFeatures` in `lib/features` behind
  the `buildFeatureSnapshot` adapter) produces **byte-identical** snapshots —
  and identical event-chain row hashes — whether driven by backtest replay of
  a recorded event window, the shadow-mode call-site idiom, or the live
  scanner call-site idiom, including under different representations of the
  same content (shuffled/reversed order, volume present/absent). The path
  reads **no wall clock** and has **no second implementation** anywhere in the
  repo.
- **Test:** `test:blackbox-parity`
  (`artifacts/api-server/src/lib/features/__qa__/blackboxParity.test.ts`, 11
  tests, wired at the end of the root `ci` chain) over the recorded golden
  window `goldenWindow.fixture.ts` (61 M1 EURUSD `CANDLE_CLOSE` events; golden
  anchors `GOLDEN_HEAD_HASH`, `GOLDEN_SNAPSHOT_DATA_HASH`,
  `GOLDEN_SNAPSHOT_ROW_HASH`). Negative test: a flipped byte in the fixture
  fails chain-verify as `CHECKSUM_MISMATCH` at the tampered row, and shifts
  the feature bytes.
- **Guard-equivalent:** the lane's repo-wide source scan asserts exactly one
  definition each of `computeFeatures`, `ewmaSigma`, `synthSigma1min`,
  `candlePointInTimeReader`, `buildFeatureSnapshot`, and one `FEATURE_SET_ID`
  assignment — a unit test cannot see a second implementation that does not
  import the first; this scan can. Clock discipline is double-locked: a
  wall-clock token pin over the path sources **plus** a poisoned-clock run
  (global `Date.now`/`new Date()`/`performance.now`/`Math.random` throw) that
  must still land on the golden anchors.
- **Mutation proof** (all killed against a compiling tree, this session):
  (A) `EWMA_LAMBDA` 0.94→0.95 — 3 tests red (golden anchors + byte equality);
  (B) reader's sort removed — parity red (representation dependence caught);
  (C) `computedAt` switched to `new Date().toISOString()` — 3 tests red
  (source pin, poisoned clock, byte equality);
  (D) a second `computeFeatures` definition added — one-implementation scan
  red.
- **Scope honesty:** this certifies the FEATURE path's byte equality. It does
  **not** overturn Ruling 14 — full decision replay determinism remains NOT
  implemented; decisions are re-runnable, not replayable.

## Certified — Grade C (deterministic tests, no mutation artifact stored)

All counts below were re-run in this audit at HEAD.

| Component | Suite | Result |
|---|---|---|
| Personal Trading Constitution | `test:phase6-constitution` | **23/23** |
| Approval ticket lifecycle + terms binding | `test:phase6-approval` | **28/28** |
| Indeterminate delivery outcome | `test:phase6-indeterminate` | **13/13** |
| `DerivExecutionAdapter` | `test:phase6-deriv-adapter` | **20/20** |
| TTL sweep policy | `test:phase6-ttl` | **9/9** |
| Venue routing | `test:phase6-venue-routing` | **16/16** |
| Tier 0 end-to-end | `test:phase6-tier0-e2e` | **14/14** |
| Deriv dependency resolver | `test:phase6-deriv-deps` | **20/20** |
| Forensic lineage + sweeper | `test:phase6-lineage-sweeper` | **19/19** |
| Guided HTTP surfaces | `test:phase6-surfaces` | **14/14** |
| Approval Inbox UI honesty | `test:approval-inbox-honesty` (vitest) | **15/15** |

**Phase 6 node-test total: 209 tests, 208 pass, 1 fail** (the failure is in
`test:phase6-tier0-product`, below).

### Notable Grade-C behaviours worth naming

- **`DERIV_DEMO` cannot be dispatched by the MT5 pipeline.**
  `EXECUTION_ADAPTERS.DERIV_DEMO.deliver()` throws
  `DERIV_DEMO_ADAPTER_NOT_WIRED` by design — the Deriv adapter needs per-request
  dependencies and cannot be a module constant without reading ambient state.
  *No adapter, no frame, no order.* Also:
  *"UnroutableVenueError is recognised structurally, not by instanceof"* —
  passing.
- **DEMO must be proven by venue evidence.** `resolveDerivDependencies` requires
  a `DemoEvidenceSource` of `VENUE_ACCOUNT_ATTRIBUTE` or `VENUE_ACCOUNT_LIST`.
  `INFERRED_FROM_NAMING` is **refused**. Token naming, env naming, a UI label
  and the adapter's URL allow-list are all insufficient by construction. Tests
  *"DEMO inferred from naming never reaches the venue, even at TIER 1"* and
  *"a venue-classified LIVE account never reaches the venue"* — both passing.
- **A provably-untransmitted frame has its own code.** `DERIV_NOT_TRANSMITTED`,
  because it previously borrowed the `DERIV_VENUE_REJECTED` message prefix and
  settlement's adjudication regex classified it `SYSTEM_GATE` — *a venue decision
  the venue never saw* (`ec76aa4`).
- **No-order-possible is definite.** A proposal is a quote request and cannot
  create a contract, yet proposal-phase refusals previously carried the
  replied/no-contract shape the adapter maps to INDETERMINATE — freezing a
  user's entire guided surface over an order that provably could not exist.
  `GuidedBuyOutcome` now carries `orderPossible`, defaulting **true** (the
  conservative direction) when absent (`fb05a57`).
- **Late venue replies are drained.** Venue evidence dominates local inference:
  a late receipt upgrades UNKNOWN to a confirmed contract id; a late venue error
  code is adjudication — a clean no-trade (`fb05a57`).
- **One bad string cannot permanently 500 the inbox.** Reads screen each
  free-text field individually and withhold just the offending one, stating so;
  writes still refuse outright (`7efd63c`).
- **Secret-leak screening does not eat honest text.** `looksLikeSecret` checks
  named secrets first, then strips own-id and `UPPER_SNAKE` code shapes before
  the opaque-token scan. A genuine token in a sentence still refuses. The
  exemption is deliberately narrow: the entire value must be prefixes plus one
  strict 8-4-4-4-12 UUID, so a PAT cannot match and a token smuggled beside a
  UUID still fails the full-string anchor (`64bc6a3`, `169a7ca`).
- **The UI never renders "Not sent." on uncertainty.** An unparseable dispatch
  response or a fetch that dies mid-flight renders as **UNKNOWN with do-not-retry
  copy**, and `act()`'s catch may not contain a rethrow — a rethrow keeps the
  handler text present but unreachable, *the bug wearing the fix's clothes*
  (`169a7ca`).
- **A 401 is not an empty inbox.** Explicit unauthenticated / load-error /
  confirmed-ready states; "no trades waiting" renders only after a
  confirmed-ready load (`ee641c5`). 15/15 in the honesty suite.

---

## Certified — Grade D (compile-time contract, not a runtime gate)

### Venue gate parity, 23/23 dispositions
- **Artifacts:** `lib/domain/src/safety-contracts/venueGateParity.ts` and
  `derivDemoGateParity.ts`. `VenueGateParityMap` is a
  `Record<LivePhaseBGateOnlyKey, VenueGateDisposition>`, so **every one of the
  23 gate keys must carry a disposition or the build fails.** A `NOT_APPLICABLE`
  requires a written reason.
- **What this genuinely guarantees:** adding a twenty-fourth gate to the live path
  breaks compilation until someone maps it. Weakening by silent omission is
  structurally impossible.
- **What it does NOT guarantee — read this before citing it as a gate.**
  `DERIV_DEMO_GATE_PARITY` and `assertVenueGateParity` are referenced **only**
  inside `lib/domain/src/safety-contracts/` and the compiled `dist/`.
  ```bash
  grep -rn 'DERIV_DEMO_GATE_PARITY\|assertVenueGateParity' --include=*.ts lib artifacts scripts
  ```
  Nothing in `artifacts/api-server` evaluates the parity map at dispatch time.
  The design document's phrasing — *"the venue evaluator refuses to dispatch if
  any of the 23 keys has no disposition"* — describes a **build-time** refusal,
  not a dispatch-time one.

### The gate count is 23
- Settled by code, not prose: `evaluateLivePhaseBDispatchGate` pushes exactly 23
  entries into `gates[]`
  (`lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts:126-231`).
  `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` (`:236-240`) is a sentinel appended
  for audit greps, **not a gate**.
- Repo-wide prose still says "16-gate" 416 times against 200 for "23-gate", and
  the docstring directly above `dispatchLiveCommand` itself says "15-gate". **All
  stale.** Trust the code.

---

## Contested — does not hold today

### Tier 0 product certificate: 32 of 33 passing
```
✖ with NO observed state wired, the product still refuses — never trades blind
  actual:   DERIV_DEPS_REFUSED:KILL_SWITCH_ENGAGED: the per-user kill switch is engaged
  expected: /nothing was sent|could not establish dispatch preconditions/
  artifacts/api-server/src/lib/phase6/__qa__/tier0ProductCertificate.test.ts:391
```

**What is fine.** The two assertions that carry the safety meaning both pass:
`outcome.ok === false` and `outcome.indeterminate === false`. The product
refused, and it did not report a pre-transmission refusal as possibly-sent. It
did not trade blind.

**What is wrong.** The test overrides most dependencies but leaves
`resolveDerivDependencies` live, so it reads the real database. Because the
global emergency kill switch is engaged in this database
(`global_trading_settings.emergency_kill_switch = t`), the kill-switch wall
refuses **before** the unreadable-observed-state wall the assertion targets.

**Why it matters.** A Tier 0 *product certificate* whose result depends on
mutable database state is not reproducible across environments, which is
precisely what a certificate must be. This is a defect in the evidence, not in
the product. **Until it is fixed, this suite may not be cited as reproducible
evidence for the observed-state wall.**

**Fix:** stub the resolver in that test so it reaches its intended wall, and add
a separate test asserting the kill-switch wall refuses first when engaged — that
ordering is real safety behaviour and deserves its own coverage rather than
being an accident of database state. Mutation-prove both.

Everything else in the suite passes, including *"THE WALLS ARE REACHED, not
merely bypassed by an earlier failure"*, *"TIER 0 PRODUCT: the assembled path
writes ZERO venue frames"*, *"the route never exposes a credential handle or
token"*, *"a TIER 0 attempt produces a complete, honest lineage"*, and *"with NO
transport override, the LIVE path runs and still fabricates nothing"*.

---

## Explicitly NOT certified

Named so no reader assumes otherwise.

| Claim | Status |
|---|---|
| **Tier 1 demo guided execution end to end** | **NOT certified.** Zero demo orders have ever been placed through the guided path (`deriv_order_intents` = 0, `guided_attempt_events` = 0). The harness exists and the environment is armed; it has never been run. |
| Tier 2 (supervised continuous session) | Not built, not authorized to enable. |
| Tier 3 (live guided), Tier 4 (autonomous) | **Must not be enabled** (Ruling 19). |
| Real-money execution | Standing hold. Real money remains OFF (Constitution Article VII). |
| Deriv rejected order / partial fill / requote | **Unexercised by any live run** (Ruling 18). |
| Guided-path parity with the MT5 pre-gates | **UNKNOWN.** The guided path does not enter `dispatchLiveCommand`, so it does not run the ~20 MT5 pre-gates (risk locks, price collars, exposure reservation, allocation gate, double-send CAS). It has its own walls, several stricter. No artifact maps one set onto the other. |
| Replay determinism | **NOT implemented** (Ruling 14). Decisions are re-runnable, **not** replayable, and must not be described as replayable. |
| `stableStringify` bigint/string injectivity | **Known collision, pinned not fixed** (Ruling 13). `BigInt(1)` and `"1n"` share a canonical form. The parity suite pins current behaviour so a future fix must consciously break the pin. |
| Reconciler verified against the production database | **Not done.** Ruling 10a's precondition for flipping `ARX_REQUIRE_FRESH_RECONCILIATION`. |
| Phase 6 endpoints in the API contract | **Absent.** `grep -cE '/me/approval-tickets\|/me/guided-' lib/api-spec/openapi.yaml` → **0**. No generated Zod schemas or React-Query hooks exist for them. |
| `pnpm run ci` (full named-suite gate) at HEAD | **UNKNOWN** — not run in this session. |
| Mutation counts quoted in commit messages | **Self-reported at commit time.** No mutation report artifact is stored; not independently re-derivable today. |

---

## Certification expiry

Article IV: authority "expires unless the evidence remains current."

- Grade A rows rest on runs dated **2026-08-25** and **2026-08-26** against a
  live venue. They are re-runnable and place no trade by construction
  (`certify:deriv-new-api`, `diagnose:deriv-new-api`). Re-run them before citing
  them as current for a Tier 1 attempt.
- Grade B and C rows were re-run **2026-08-27** at HEAD and are current as of
  this file's header.
- Any change to `lib/domain/src/safety-contracts/**`,
  `lib/live/liveCommandPipeline.ts`, or `lib/phase6/**` invalidates the
  corresponding rows until the suites and guards are re-run.

### Coded review periods (#56, governance-closure build)

The expiry rule above is now CODED, not just written:
`lib/domain/src/safety-contracts/certificationExpiry.ts` carries a register of
broker / model / recovery certifications with `certifiedAtIso` + a 90-day
review period, and three enforcement seams consult it at act time:

- **BROKER** — `dispatchGuidedTicket` refuses a venue-permitting (TIER_1/2)
  dispatch with `BROKER_CERTIFICATION_LAPSED` while any broker certification
  is past review. TIER_0 dry-run keeps working (it is the reduction floor and
  what the recertification harness itself needs).
- **MODEL** — `evaluatePromotion` refuses every promotion rung while a model
  certification is lapsed (earned rungs are kept; nothing new climbs).
- **RECOVERY** — the kill-switch cold-posture release adds a violation while a
  recovery certification is lapsed (the switch stays engaged).

Lapse can only REDUCE authority. Recertification = re-run the evidence named
in the register's `evidenceRef`, update `certifiedAtIso` in a reviewed change,
and record the run in this file. Drill fixtures:
`artifacts/api-server/src/lib/phase6/__qa__/certificationExpiry.test.ts`
(`test:certification-expiry`).

---

## REGISTRATION_KEY_PEPPER — the press machinery (2026-08-29, branch `hold/pepper-runbook`)

Runbook: `docs/REGISTRATION_KEY_PEPPER_RUNBOOK.md`. The secret itself is **not
set** — that press is the owner's, and nothing here performs it.

| Claim | Grade | Evidence |
|---|---|---|
| The boot checklist reports an absent pepper as **required**-missing, with a reason, whenever the shield is ON or the env is production | **B** | `test:registration-key-pepper-press` (7 assertions). Mutation: reverting `REGISTRATION_KEY_PEPPER` to `always(false)` in `envChecklist.ts` turns **4** tests red. |
| Shield ON + pepper absent raises a distinct `registrationShieldBlocked`, a `logger.error` at boot, and a CRITICAL `REGISTRATION_SHIELD_BLOCKED` launch blocker | **C** | same suite; the log and blocker are asserted at source level, not by capturing a boot. |
| `acceptInviteTx` honours `REGISTRATION_KEY_PEPPER_PREVIOUS`, so a rotation window is redeemable end to end | **B** | same suite, 5 assertions over a transaction stand-in. Mutation: `…HashCandidates(code).slice(0, 1)` inside `acceptInviteTx` turns the previous-pepper test red and nothing else. |
| Validation and acceptance cannot drift apart again | **C** | source-level assertion that both go through `registrationKeyPepperedHashCandidates` and that `acceptInviteTx` contains no inline `pc.pepper` hash. |
| The pre-flight's at-risk count is accurate | **C** | `test:registration-key-pepper-preflight` — 14 assertions over fixtures, including a totals-reconcile check. Pure function, no DB. |
| No checklist item, log, response or script emits the pepper value or its length | **C** | same suites: serialized-checklist scan plus a comment-stripped source scan over 8 files for log/response/template interpolation shapes. |
| The pepper is provisioned AND generation and validation agree on it | **NOT VERIFIED** | requires the owner's press. `verify:registration-key-pepper` is built and typechecks, but has **never been executed** — this sandbox blocks `listen(2)` and has no Postgres. It is unrun, not passing. |

**Contested / honest gaps.**
- The end-to-end verification lane (`verify:registration-key-pepper`) and the
  pre-flight CLI (`preflight:registration-key-pepper`) were **not executed**
  anywhere. Only their pure logic is covered by tests. First real run must be
  on Replit.
- `expiringKeysAdminRoute.test.ts` could not run here (needs a listener and a
  live Postgres); it was not evaluated against this change.
