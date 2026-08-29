# Decisions

**Confirmed rulings and standing holds only.** Every entry below is transcribed
from an explicit, dated ruling recorded in the repository. Nothing here is
inferred, reconstructed, or extrapolated from code. Where a decision is required
but has not been made, it appears under **Open — owner decision required**, not
as a decision.

**Authority.** The append-only registry `docs/OWNER_DECISIONS.md` (mirroring the
`owner_decisions` table) is authoritative. This file is a curated index of it
plus the constitutional articles. If the two disagree, `OWNER_DECISIONS.md`
wins. `docs/CAPITAL_CONSTITUTION.md` outranks both for the articles it states.

**Discipline.** Append-only, forward-fix only. A ruling is never edited or
deleted; a wrong ruling is corrected by appending a new ruling that names the
one it supersedes. Agents may surface decisions but may not silently replace
them. Any database append must update the markdown mirror in the same change.

---

## Constitutional articles (standing, above ordinary configuration)

Source: `docs/CAPITAL_CONSTITUTION.md`. Pinned by
`scripts/src/ci/check-capital-constitution.ts` — a silent edit fails the build.
Amending requires (1) an owner ruling appended to the registry **and** (2) the
pinned heading list updated in the same reviewed change.

| # | Article | Rule |
|---|---|---|
| I | The Central Rule | More intelligence does not automatically earn more authority. Every added component must improve measured decisions, remain reproducible, preserve deterministic risk, and be removable without endangering positions or economic truth. |
| II | Authority Hierarchy | Deterministic risk rules > AI reasoning > strategy > execution. Capital exposure is never controlled by model confidence. |
| III | Refusal Is a Valid Result | `WAIT`, `SUSPEND`, `UNKNOWN`, `COMPLIANCE_HOLD` are correct outputs. Never fabricate data, defaults, or authority. |
| IV | Authority Is Earned by Evidence | Capability is promoted only to the maximum authority its evidence supports, expires unless evidence stays current, and **green CI alone never grants live authority**. |
| V | Truth Is Append-Only | Decision, trade, audit and ruling ledgers are append-only. Corrections are forward-fixes that name what they supersede. |
| VI | Owner Authority | Expanding owner limits, enabling real money, or weakening any article requires the owner's explicit governance procedure. |
| VII | Immediate Decisions and Holds | Quoted verbatim from Blueprint Part V — see "Standing holds" below. |
| VIII | Amendment Procedure | An amendment is valid only with an owner ruling **and** the updated pinned heading list. Removing an article is a constitutional event, never a cleanup. |

---

## Owner rulings

Numbered as in `docs/OWNER_DECISIONS.md`. Rulings 1–9 were decided 2026-08-19;
dates for later rulings are given inline. `Supersedes: —` throughout unless
stated.

### Governance and process

**Ruling 1 — Stale-export overwrites are the top Phase 0 threat.**
Replit Agent merge tasks are RETIRED as an integration path. All changes reach
the authoritative repository through reviewed branches only. Every workflow that
could replay an old tree wholesale is prohibited.

**Ruling 2 — TypeScript, not Python, for the multi-broker spec.**
Implemented in TypeScript inside this monorepo. No parallel Python
implementation is started.

**Ruling 3 — Integer-FK + `publicId` identity.**
Internal identity is the integer primary key used in foreign keys; external /
client-facing identity is a separate `publicId`. New tables follow the dual
pattern; neither replaces the other.

**Ruling 9 — Registration pepper burned and rotated (2026-08-19).**
The pepper in circulation before 2026-08-19 is treated as burned. Keys minted
under it are invalid and the old value must never be reintroduced.

### Safety architecture

**Ruling 4 — Compose, don't duplicate.**
**No 5th kill switch and no 6th limit store.** New safety behaviour is composed
from existing kill-switch and limit primitives.

**Ruling 6 — Emergency-close kill-switch exemption is pinned.**
The only kill-switch bypass is the emergency-CLOSE exemption, pinned to the
single predicate `killSwitchCloseBypassApplies`
(`artifacts/api-server/src/lib/live/killSwitchBypass.ts`). No other code path may
decide a command is exempt.

**Ruling 7 — Fail closed on missing settings.**
When a safety-relevant setting, limit or permission row is missing or
unreadable, the system refuses. Defaults never silently grant authority.

**Ruling 12 — `execution_events` append-only is enforced in CI, not by REVOKE
(2026-08-23).**
The planned `REVOKE UPDATE, DELETE` was **not** run and should not be: the app
connects as `postgres`, a superuser, and superusers bypass privilege checks
entirely. The statement would alter the ACL and enforce nothing — false
assurance is worse than none. Enforcement lives in
`scripts/src/ci/check-vault-mutations.ts`, guarding `execution_events` and
`owner_decisions` in both Drizzle-symbol and raw-SQL forms.
`reconciliation_runs` and `production_edges` are deliberately excluded (both
legitimately mutate). Real DB-layer enforcement would require the app to stop
connecting as a superuser — an infrastructure change, and itself an owner
decision.

**Ruling 5 — Netting is demo/shadow-only.**
Netting runs in demo and shadow environments only. Shared live netting among
assigned users remains prohibited unless true broker-native subaccounts or
equivalent isolation exist.

**Ruling 11 — Master exposure cap 0-means-unlimited trap (2026-08-20).**
`shared_master_accounts.max_total_exposure_lots = 0` (the column default) means
**UNLIMITED** today. Changing it to a hard zero-cap requires an explicit owner
ruling plus a migration adding an explicit unlimited marker. Until then startup
logs `MASTER_EXPOSURE_CAP_ZERO_MEANS_UNLIMITED`.

### Reconciliation and evidence

**Ruling 10 / 10a — Reconciliation-freshness gate staging (2026-08-20 /
2026-08-23).**
`ARX_REQUIRE_FRESH_RECONCILIATION` ships **default-OFF**. 10a records that the
original blocker is cleared — `startUnknownReconcilerWorker` now schedules
`reconcileUnknownCommands` every 60s at server start (opt-out via
`ARX_UNKNOWN_RECONCILER_ENABLED`) — **but the gate stays OFF** pending one
verification the code cannot perform for itself: the reconciler has never run
against the production database. Before flipping, confirm on Replit that (1)
`reconciliation_runs` rows accumulate with `status = COMPLETED`, and (2) a pass
logs `unknown_reconciler_pass` without errors. Then set
`ARX_REQUIRE_FRESH_RECONCILIATION=true` and record the flip. The asymmetry is
deliberate: a default-ON gate whose reconciler is silently failing refuses every
live entry.

**Ruling 13 — bigint/string canonicalization collision: pinned, not fixed
(2026-08-23).**
`stableStringify` encodes a bigint as `"<digits>n"`, byte-identical to
`JSON.stringify` of the string `"<digits>n"`. `BigInt(1)` and `"1n"` therefore
share a canonical form. **Not fixed, deliberately**: any injective encoding
alters bigint output, invalidating every stored hash containing one. The parity
suite pins current behaviour so a future fix must consciously break the pin.
Verified *not* affected: `1n` vs `1`, `1n` vs `"1"`, `0n` vs `0`, `-5n` vs `-5`,
large bigints vs lossy numbers, and nesting in arrays, objects and Money values.

**Ruling 14 — replay determinism is NOT implemented (2026-08-23).**
Recorded as a known evidence gap. Current decisions are **re-runnable but not
replayable**, and must not be described as replayable. A legitimate replay
envelope requires all of: an immutable input snapshot (not a hash alone),
code/build version, policy/model versions, canonicalization version, the
clock/as-of value, the random seed where applicable, and the original output
hash. No decision row carries any of these. Deferred until after Deriv
certification by owner direction; **the live decision schema is not to be
touched**.

### Deriv

**Ruling 15 — Deriv "new mode" PAT authorize is unproven and does not work
(2026-08-23).**
Two demo tokens failed certification with `InvalidToken`; the cause was **not**
the tokens. `detectMode()` selected "new" mode for an alphanumeric app id + PAT,
then `resolveWsUrl()` connected with the public bootstrap app id and called the
**legacy** `authorize` with the PAT. A Deriv Developers PAT is not a valid
credential for legacy `authorize`, so every token was rejected regardless of how
it was created. The documented legacy certification path is recorded in the
registry.

**Ruling 15a — EXECUTED: new mode kept, quarantined from legacy transport
(2026-08-23).** *Supersedes the remedial half of Ruling 15.*
Owner ruling: **KEEP** new mode. Alphanumeric App IDs and PATs are valid
credentials for Deriv's current API; the defect was architectural — these are
two API **generations**, not two credential formats for one handshake.
Implemented: legacy path preserved untouched as the certification target;
`DERIV_API_MODE=new` fails **closed** with `DERIV_NEW_API_NOT_IMPLEMENTED`
before any socket opens; the bootstrap-1089 substitution removed; the refusal is
explicitly **not** a credential verdict; regression tests pin that new
credentials can never reach legacy `authorize`, with a second barrier at the
call site. Classification is deliberately unchanged — the credentials were
always recognised correctly; only the route was wrong.

**Ruling 16 — the Deriv new-API transport is CERTIFIED read-only; order
placement is NOT (2026-08-25).**
A live read-only certification passed **17/17 steps** on a demo account: REST
account discovery, deterministic demo selection, OTP, authenticated WebSocket
(no `authorize` sent), ping, server clock, 89 active symbols, `contracts_for`, a
priced `proposal` carrying a buyable id, `balance`, `portfolio`, and the
read-only gate refusing a buy. **Resolved: multipliers ARE served on this
surface** — `R_100` returned 65 contract types including multipliers, settling an
assumption the program had refused to treat as fact. Certifying the transport is
**not** certifying trading.

**Ruling 17 — one demo trade executed and reconciled; the P/L check was
exercised only at ZERO (2026-08-25).**
One contract bought at 1, observed open, sold for 1, venue-confirmed settled,
reconciled. **Proven**: an order reaches the venue and returns a contract id;
that id is tracked open→close; the sell targets that exact contract; settlement
is confirmed **by the venue**, not inferred from the sell reply. **Not proven**:
the P/L was exactly 0, so the comparison only ever evaluated `0 === 0`. A
reconciliation that always returned zero would have produced byte-identical
output.

**Ruling 18 — reconciliation proven on a NON-ZERO P/L; keepalive and recovery
added (2026-08-25).**
A second contract, held 60s, sold for 1.03, venue-confirmed settled. Derived P/L
`0.030000000000000027` vs Deriv-reported `0.03` — **agrees**, graded
`evidence: non-zero`. This closes the gap Ruling 17 left open, and vindicated
the cent-rounding fix in a way a test could not.
**Amended the same day**: the ruling's original spot-movement figure
(618.38 → 618.80) is **withdrawn** — ARX had paired the proposal's pre-trade
quote with a post-settlement streaming tick. The P/L evidence is unaffected and
stands. Fixed: the venue's own `entry_spot`/`exit_spot` are read with **no**
fallback; `UNRESOLVED` is the honest answer when Deriv is silent.
Also recorded: a first 60s attempt **stranded** an open position when the socket
idled out at exactly 60.0s. The harness detected the drop, refused to guess,
reported the contract id and exited non-zero, and the position was recovered
cleanly. Now the hold runs in 15s slices with a read-only `ping` between them,
a dropped socket triggers reconnect-with-fresh-OTP, and
`close:deriv-demo-position` recovers a stranded position by explicit id only —
it never discovers positions on its own, so it cannot become a bulk flattener.

### Phase 6

**Ruling 19 — Phase 6 authorized, including the Deriv execution seam
(2026-08-27).** *Lifts, for guided and demo execution only, the standing holds
"no `DerivExecutionAdapter`, no dispatch through the 18-gate path" recorded at
the end of Ruling 18. Ruling 18's other holds are NOT lifted.*

> *Editorial note (added 2026-08-29, not part of the ruling): "18-gate" is left
> as written — it was the count when Rulings 16–19 were made. The count is now
> **23** (same evaluator, foundation gates #19–#23 added since); see "Finding of
> fact" below. Only the count changed, never the hold.*

Owner's words: *"AUTHORIZE PHASE 6 — SELF-TRADING GUIDED MODE, INCLUDING THE
DERIV EXECUTION SEAM."*

**Authorized to build and wire:** Personal Trading Constitution; Approval Inbox
with expiring tickets; `DerivExecutionAdapter`; the existing 18-gate dispatch
boundary; guided confirm → execute; position/reconciliation integration;
journal/debrief integration.

**This authorization is for CONTROLLED GUIDED/DEMO EXECUTION.** It is expressly
**NOT** authorization for: autonomous trading without user approval; unattended
order dispatch; real-money/live-account execution; weakening any of the 18
gates; bypassing risk controls; silently retrying ambiguous orders; or
converting UNKNOWN into success/failure without venue evidence.

**Demo orders** are authorized only in the minimum number needed to certify
Tier 1, on a demo account, at the smallest practical stake, reconciling each
before placing another, and **stopping entirely if any execution state becomes
UNKNOWN/UNRESOLVED**.

**Release tiers, explicit and server-authoritative:** Tier 0 dry run; Tier 1
demo guided execution on an approved unexpired ticket; Tier 2 demo supervised
continuous session. **Tier 3 (live guided) and Tier 4 (autonomous) must NOT be
enabled.** No code path may escalate a tier from the mere presence of an
environment variable.

**Phase 5 remains certified and frozen.** If Phase 6 integration exposes a
Phase 5 defect the sequence is: reproduce, add a regression, fix minimally,
mutation-prove, and document why Phase 5 had to be reopened.

### Design decisions recorded in `docs/PHASE6_GUIDED_EXECUTION_DESIGN.md`

Authored under Ruling 19, dated 2026-08-27.

**Decision 1 — widen the execution seam with a third outcome, without touching
MT5.** `ExecutionAdapter.deliver()` was binary (resolve or reject). For MT5 that
is correct — a failed local INSERT into the `mt5_commands` mailbox is provably
pre-transmission. For Deriv it is catastrophically wrong: `wireWritten: true`
followed by no reply would be marked `LIVE_FAILED`, releasing the exposure
reservation for a position that may be open. A third outcome now maps to
`LIVE_UNKNOWN`, **holds** the exposure reservation, and hands the command to the
existing unknown reconciler. `Mt5EaBridgeAdapter` never produces it, so the MT5
path keeps byte-equivalent behaviour.

**Decision 2 — venue gate parity, fail-closed on any unmapped gate.** Each of
the 18 gates gets an explicit audited disposition for the Deriv demo venue:
`EQUIVALENT`, `STRICTER`, or `NOT_APPLICABLE` **with a recorded reason**. No
gate may be silently dropped. Gate 6 **inverts and tightens** for the demo tier
— the account must be demonstrably DEMO, via Phase 5's certified allow-list
(`/trading/v1/options/ws/(demo|virtual)`), an allow-list rather than a
deny-list, so an unrecognised account shape is refused rather than admitted.
The seven EA gates are `NOT_APPLICABLE` only in the sense that no EA exists;
their intent is carried by Deriv-native equivalents.
*Implementation note, verified at HEAD: this is enforced as a compile-time
totality contract and by tests, not by a check executed on the dispatch path.
See `docs/PROJECT_STATE.md` B4.*

**Finding of fact — the gate count is 23 (was 18 when this ruling was first
written).** The repository contradicts itself in prose: "15-gate", "16-gate" and
"18-gate" have all appeared at different times, and stale counts outnumber the
correct one. Only the code settles it: `evaluateLivePhaseBDispatchGate` pushes
exactly **23** entries into `gates[]` — the original 16 base gates, #17
`MISSING_TAKE_PROFIT`, #18 `DISCLOSURE_NOT_ACCEPTED`, and the five FOUNDATION
gates #19–#23 (`PROVENANCE_UNPROVEN`, `STRATEGY_NOT_LIVE_PROMOTED`,
`CAPITAL_TIER_EXCEEDED`, `TENANT_CONTEXT_VIOLATION`, `EDGE_CAPACITY_EXCEEDED`).
Every prose mention of 15, 16 or 18 is stale. Note that a repo-wide "16-gate"
family of stale comments is still outstanding and NOT corrected by the sweep
that produced this entry — see the honest-copy note in
`lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts`.
`BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` is a sentinel appended for audit greps,
not a gate.

---

## Standing holds (currently in force)

Quoted from Capital Constitution Article VII / Blueprint Part V, adopted
verbatim as standing rulings by **Ruling 8**:

- **Real money remains OFF** until evidence, demo execution, reconciliation,
  recovery and owner authorization gates pass.
- MT5 requires a terminal-side EA or another certified connector when the broker
  exposes no suitable direct API.
- **Broker-native market data is primary**; no fabricated candles or guessed
  symbol identifiers.
- **Self-Trading is the first complete product mode.** Managed Allocation
  follows only after account isolation and compliance are proven.
- **Shared live netting among assigned users remains prohibited** unless true
  broker-native subaccounts or equivalent isolation exist.
- **Outside-client discretionary management remains COMPLIANCE_HOLD** pending
  jurisdiction-specific counsel and broker approval.
- The original trade-count and dollar targets remain objectives/capacity ideas,
  **never quotas** or evidence of available edge.

Additional holds in force:

- **Tier 3 (live guided) and Tier 4 (autonomous) must not be enabled** (Ruling 19).
- **Phase 5 is certified and frozen** (Ruling 19).
- **`ARX_REQUIRE_FRESH_RECONCILIATION` stays default-OFF** until an operator
  verifies the reconciler against the production database (Ruling 10a).
- **Buy/sell is certified for the happy path only.** A rejected order, a partial
  fill and a requote between quote and buy remain unexercised by any live run
  (Ruling 18).
- **The live decision schema is not to be touched** pending replay determinism
  (Ruling 14).

---

## Open — owner decision required

These are recorded as *needing* a decision. **No decision has been made.**

| # | Question | Source |
|---|---|---|
| O1 | Whether to re-encode `stableStringify` bigints (invalidating stored hashes and forcing re-verification of the event chain) or to constrain callers so a bigint and a string can never occupy the same field. | Ruling 13 |
| O2 | Whether to prove the correct new-API endpoint and auth flow for the "new" mode, or remove the mode. Partially addressed by 15a's quarantine; the underlying question is left formally open by Ruling 15. | Rulings 15, 15a |
| O3 | Whether `max_total_exposure_lots = 0` should become a hard zero-cap (requires a ruling **and** a migration adding an explicit unlimited marker). | Ruling 11 |
| O4 | Whether to create a dedicated non-superuser database role so append-only enforcement can live at the DB layer. Named an owner decision, not a migration to slip in. | Ruling 12 |
| O5 | Whether a second deliberate Deriv run with a longer hold is authorized, to exercise a rejected order / partial fill / requote. | Rulings 17, 18 |
| O6 | Whether the `global_trading_settings.emergency_kill_switch = true` currently in the database is a deliberate hold or leftover state. **No ruling in the repository addresses it.** | Audit finding, `docs/PROJECT_STATE.md` B1 |

---

## Not decisions

Recorded so that no future reader mistakes them for rulings:

- The guided path's divergence from the design document — calling
  `adapter.deliver()` from `guidedDispatchEntry.ts` rather than entering
  `dispatchLiveCommand` — is an **implementation outcome**, not a recorded
  decision. No ruling authorizes or forbids it.
  See `docs/PROJECT_STATE.md` §2 and B5.
- The absence of the Phase 6 endpoints from `lib/api-spec/openapi.yaml` is a
  **gap**, not a decision to bypass the contract.
- Nothing in this repository authorizes clearing the global emergency kill
  switch.
