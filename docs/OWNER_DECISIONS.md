# Owner Decision Registry

Markdown mirror of the `owner_decisions` table (Blueprint Part II #54, Phase 0).

Discipline: APPEND-ONLY, forward-fix only. A ruling is never edited or deleted
here or in the database — a wrong ruling is corrected by appending a new ruling
that names the one it supersedes. Agents may surface decisions but not silently
replace them. The API surface is `GET/POST /api/admin/owner-decisions`
(ADMIN/OWNER only); this file is the human-readable mirror and must be updated
in the same change as any database append.

Each entry: number, date decided, decided by, title, the ruling itself, and
context. `Supersedes: —` means the ruling is original, not a correction.

---

## Ruling 1 — Stale-export overwrites are the top Phase 0 threat

- Decided: 2026-08-19
- Decided by: Owner
- Supersedes: —

Decision: Replit Agent merge tasks are RETIRED as an integration path. All
changes reach the authoritative repository through reviewed branches only.
A stale export re-applied over newer work is treated as the single most likely
way Phase 0 loses repository truth, and every workflow that could replay an old
tree wholesale is prohibited.

Context: The program's Phase 0 exit condition is "one authoritative repository."
Unreviewed bulk merges from workspace exports have previously overwritten newer
committed work.

## Ruling 2 — TypeScript, not Python, for the multi-broker spec

- Decided: 2026-08-19
- Decided by: Owner
- Supersedes: —

Decision: The multi-broker specification is implemented in TypeScript inside
this monorepo. No parallel Python implementation is started.

Context: One language keeps the risk kernel, adapters, schema and CI guards in
a single typechecked dependency graph; a second runtime would split truth.

## Ruling 3 — Integer-FK + publicId identity

- Decided: 2026-08-19
- Decided by: Owner
- Supersedes: —

Decision: Internal identity is the integer primary key used in foreign keys;
external/client-facing identity is a separate `publicId`. New tables follow
this dual-identity pattern; neither replaces the other.

Context: Integer FKs keep joins and referential integrity cheap; publicIds keep
enumeration and cross-tenant guessing out of client surfaces.

## Ruling 4 — Compose, don't duplicate

- Decided: 2026-08-19
- Decided by: Owner
- Supersedes: —

Decision: No 5th kill switch and no 6th limit store. New safety behavior is
composed from the existing kill-switch and limit primitives; building a
parallel store or switch because the existing one is inconvenient is refused.

Context: Duplicate safety stores drift, and drifted safety stores disagree at
exactly the moment they must not.

## Ruling 5 — Netting is demo/shadow-only

- Decided: 2026-08-19
- Decided by: Owner
- Supersedes: —

Decision: Netting behavior runs in demo and shadow environments only. Shared
live netting among assigned users remains prohibited unless true broker-native
subaccounts or equivalent isolation exist (Part V hold).

Context: Position ownership under netting with partial fills and conflicting
commands is unresolved research (Blueprint Part II #49), not a live capability.

## Ruling 6 — Emergency-close kill-switch exemption is pinned

- Decided: 2026-08-19
- Decided by: Owner
- Supersedes: —

Decision: The only kill-switch bypass is the emergency-CLOSE exemption, and it
is pinned to the single predicate `killSwitchCloseBypassApplies`
(`artifacts/api-server/src/lib/live/killSwitchBypass.ts`). No other code path
may decide that a command is exempt from the kill switch.

Context: A risk-reducing close must remain possible when the switch is thrown;
every other command class stays blocked. One predicate, one audit point.

## Ruling 7 — Fail closed on missing settings

- Decided: 2026-08-19
- Decided by: Owner
- Supersedes: —

Decision: When a safety-relevant setting, limit, or permission row is missing
or unreadable, the system refuses the action (WAIT / SUSPEND / UNKNOWN /
COMPLIANCE_HOLD are valid results). Defaults never silently grant authority.

Context: Honesty doctrine — refuse or return empty-with-reason; never fabricate
a permissive default.

## Ruling 8 — Part V holds adopted as standing rulings

- Decided: 2026-08-19
- Decided by: Owner
- Supersedes: —

Decision: The Blueprint Part V "Immediate decisions and holds" are adopted
verbatim as standing rulings:

- Real money remains OFF until evidence, demo execution, reconciliation,
  recovery and owner authorization gates pass.
- Broker-native market data is primary; no fabricated candles or guessed
  symbol identifiers.
- Self-Trading is the first complete product mode. Managed Allocation follows
  only after account isolation and compliance are proven.
- Outside-client discretionary management remains COMPLIANCE_HOLD pending
  jurisdiction-specific counsel and broker approval.
- The original trade-count and dollar targets remain objectives/capacity
  ideas, never quotas or evidence of available edge.

Context: Full text and the remaining holds are quoted in
`docs/CAPITAL_CONSTITUTION.md`; the delivery sequence is Blueprint Part V.

## Ruling 9 — Registration pepper burned and rotated

- Decided: 2026-08-19
- Decided by: Owner
- Supersedes: —

Decision: The registration-key pepper in circulation before 2026-08-19 is
treated as burned. It was rotated on 2026-08-19; keys minted under the old
pepper are invalid and the old value must never be reintroduced.

Context: The prior value had appeared in exported/committed material, so it is
assumed compromised regardless of actual exposure.

## Ruling 10 — Reconciliation-freshness gate staging (2026-08-20)
`ARX_REQUIRE_FRESH_RECONCILIATION` ships default-OFF: no scheduled reconciler
exists yet, and a default-ON gate with zero reconciliation runs would refuse
every live entry including the owner's controlled testing. The default flips to
ON in the same change that schedules `reconcileUnknownCommands` on Replit.

### Ruling 10a — blocker cleared, flip still owner-pressed (2026-08-23)
`startUnknownReconcilerWorker` now schedules `reconcileUnknownCommands` every
60s at server start (opt-out via `ARX_UNKNOWN_RECONCILER_ENABLED`), so Ruling
10's stated precondition is satisfied and LIVE_UNKNOWN commands are recoverable
rather than held indefinitely.

The gate nonetheless stays default-OFF pending one verification the code cannot
perform for itself: the reconciler has never run against the production
database. Before flipping, confirm on Replit that

  1. `reconciliation_runs` rows accumulate with `status = COMPLETED` (not
     RUNNING-and-abandoned, which the freshness predicate reads as stale), and
  2. a pass logs `unknown_reconciler_pass` without errors.

Then set `ARX_REQUIRE_FRESH_RECONCILIATION=true` and record the flip here. The
asymmetry is deliberate: a default-ON gate whose reconciler is silently failing
refuses EVERY live entry, so the failure mode of flipping early is worse than
the failure mode of flipping late.

## Ruling 11 — Master exposure cap 0-means-unlimited trap (2026-08-20)
`shared_master_accounts.max_total_exposure_lots = 0` (the column default) means
UNLIMITED today. Changing 0 to a hard zero-cap requires an explicit owner ruling
plus a migration adding an explicit unlimited marker; until then startup logs
`MASTER_EXPOSURE_CAP_ZERO_MEANS_UNLIMITED`.

## Ruling 12 — execution_events append-only is enforced in CI, not by REVOKE (2026-08-23)
The planned `REVOKE UPDATE, DELETE ON execution_events` was NOT run, and should
not be. The application connects as `postgres`, which is both the table owner
and a superuser — and **superusers bypass privilege checks entirely**. The
statement would succeed, alter the ACL, and enforce nothing: the result is an
audit trail asserting the ledger is append-only while it stays fully mutable.
False assurance is worse than none.

Enforcement instead lives where it can actually hold, and where it is checked on
every commit: `scripts/src/ci/check-vault-mutations.ts` now guards
`execution_events` and `owner_decisions` in BOTH forms — Drizzle symbol
(`.update(executionEventsTable)`) and raw parameterized SQL
(`update execution_events …`), the form these tables are actually written
through. Proven to fail red against all three violation shapes.

`reconciliation_runs` and `production_edges` are deliberately excluded: both
legitimately mutate (run finalization; rung advance / retirement).

To obtain real DB-layer enforcement later, the app must stop connecting as a
superuser: create a dedicated non-superuser role, grant it INSERT/SELECT on the
append-only tables and full rights elsewhere, then repoint `DATABASE_URL`. That
is an infrastructure change with a real risk of breaking unrelated writes, so it
is an owner decision, not a migration to slip in.

## Ruling 13 — bigint/string canonicalization collision: pinned, not fixed (2026-08-23)
`stableStringify` encodes a bigint as `"<digits>n"`, which is byte-identical to
what `JSON.stringify` produces for the STRING `"<digits>n"`. So `BigInt(1)` and
`"1n"` share a canonical form, and two structurally different payloads hash the
same. Narrow, but it is exactly the ambiguity the tamper-evident event chain
exists to prevent.

Verified NOT affected: `1n` vs `1`, `1n` vs `"1"`, `0n` vs `0`, `-5n` vs `-5`,
large bigints vs their lossy `number` counterparts, bigints nested in arrays and
objects, and nested Money values (amount and currency both distinguished).

NOT fixed in this change, deliberately. Any injective encoding alters bigint
output, which invalidates every stored hash containing one and forces a
re-verification of the event chain. That is a decision about existing evidence,
not a refactor. The parity suite pins the CURRENT behaviour so the collision
stays visible and a future fix must consciously break the pin.

Owner decision required: whether to re-encode (and re-verify stored chains) or
to constrain callers so a bigint and a string can never occupy the same field.

## Ruling 14 — replay determinism is NOT implemented (2026-08-23)
Recorded as a known evidence gap. Current decisions are re-runnable but NOT
replayable, and must not be described as replayable: re-running code proves
nothing unless the run is pinned to the same evidence and versions.

A legitimate replay envelope requires ALL of:
  1. an immutable input snapshot (not a hash alone — a hash can verify an input
     you still possess, but cannot reconstruct one you do not),
  2. code/build version,
  3. policy/model versions,
  4. canonicalization version,
  5. the clock / as-of value,
  6. the random seed where applicable,
  7. the original output hash.

Today NO decision row carries any of these, and `evaluateForReplay` exists only
in a comment in replaySim/engine.ts, whose own header states it deliberately
does not call the live orchestrator.

Deferred until after Deriv certification by owner direction. The live decision
schema is NOT to be touched this week.

## Ruling 15 — Deriv "new mode" PAT authorize is unproven and does not work (2026-08-23)
Two separate demo tokens both failed certification with `InvalidToken`. The
cause is NOT the tokens.

`DerivWsClient.detectMode()` selects "new" mode for an alphanumeric
`DERIV_APP_ID` plus a PAT. In that mode `resolveWsUrl()` cannot pass the
alphanumeric app id to the legacy WS handshake, so it connects with the public
bootstrap app id (`DERIV_WS_LEGACY_APP_ID`, default 1089) and then calls the
LEGACY `authorize` with the PAT — per its own comment, "authorize with the
PAT". That assumption was never exercised against the venue. A Deriv
Developers PAT is not a valid credential for legacy `authorize`, so every token
is rejected regardless of how it was created.

Observed config at the time: DERIV_API_MODE=new, alphanumeric DERIV_APP_ID,
68-char DERIV_API_TOKEN, DERIV_WS_URL=wss://ws.derivws.com/websockets/v3.
(A legacy API token is ~15 chars, `a1-` prefixed.)

CERTIFICATION PATH (legacy mode — the documented, working one, and the API our
wire layer targets: proposal / buy / sell / portfolio / contracts_for are all
v3 calls):
  - DERIV_APP_ID   = 1089            (numeric)
  - DERIV_API_TOKEN = a LEGACY API token created at app.deriv.com ->
                      Settings -> API token with the DEMO (VRTC...) account
                      selected, scopes: read + trade
  - DERIV_API_MODE = legacy          (or unset; auto picks legacy for a
                      numeric app id)

Owner decision required on the "new" mode path itself: either prove the correct
new-API endpoint and auth flow, or remove the mode so it cannot silently select
a route that always fails. It must not remain as an untested branch that
presents a credential problem when the defect is in the route selection.

NOTE: this was found only because the client now retains Deriv's error CODE
(commit b3e18cd). With the prose message alone it read as a bad token.

### Ruling 15a — EXECUTED: new mode kept, quarantined from legacy transport (2026-08-23)
Owner ruling: KEEP new mode. Alphanumeric App IDs and PATs are valid credentials
for Deriv's CURRENT API; the defect was architectural — new-generation
credentials must never enter the legacy WebSocket `authorize` flow. Deriv states
legacy App IDs do not work with the new APIs, so these are two API GENERATIONS,
not two credential formats for one handshake.

Implemented:
  1. Legacy path preserved untouched and remains the certification target.
  2. `DERIV_API_MODE=new` now fails CLOSED with `DERIV_NEW_API_NOT_IMPLEMENTED`
     BEFORE any socket is opened.
  3. The bootstrap-1089 substitution is REMOVED; new mode resolves no URL.
  4. The refusal is explicitly NOT a credential verdict.
  5. Regression tests pin that new credentials can never reach legacy
     `authorize` — including a second barrier at the call site — and are proven
     to fail red when the shim is restored.
  6. The real flow is left as a separate task and documented in-file:
     Bearer PAT + Deriv-App-ID -> REST account discovery -> account OTP ->
     authenticated new WebSocket.

Classification is deliberately unchanged: an alphanumeric app id + PAT is still
detected as "new". The credentials were always recognized correctly; only the
route they were sent down was wrong.

## Ruling 16 — the Deriv new-API transport is CERTIFIED read-only; order placement is NOT (2026-08-25)
A live read-only certification against Deriv passed **17/17 steps** on demo
account `…1092`: REST account discovery, deterministic demo selection, OTP,
authenticated WebSocket (no `authorize` sent), ping, server clock, 89 active
symbols, `contracts_for`, a priced `proposal` carrying a buyable id, `balance`,
`portfolio`, and the read-only gate refusing a buy.

**Resolved: multipliers ARE served on this surface.** The endpoints live under
`/trading/v1/options/` while ARX trades MULTUP/MULTDOWN, and this program
carried that as an open assumption from the first day of implementation,
explicitly refusing to treat "options is probably an umbrella name" as fact.
Step 9 settled it with evidence: `R_100` returned **65 contract types**
including multipliers. The transport is usable for ARX's actual strategy.

**What this ruling does NOT authorise.** Certifying the transport is not
certifying trading. `buy` and `sell` have mappers and normalizers but no
certified path, and the demo-trade certification (spec Phase 15) is
deliberately unbuilt. Building the thing that places an order is an owner
decision, not an implementation detail, and no run in this program has ever
placed one.

Standing holds that survive this ruling: no `DerivExecutionAdapter`, no live
dispatch through the new transport, and the 18-gate Phase B evaluator remains
the only path to a live order.

Evidence: `pnpm --filter @workspace/api-server run certify:deriv-new-api`,
2026-08-25 17:50 UTC, 17/17. Re-runnable; it places no trade by construction.

## Ruling 17 — one demo trade executed and reconciled; the P/L check was exercised only at ZERO (2026-08-25)
Contract `10545847099` was bought at 1, observed open (`settled=false`, spot
617.83), sold for 1, confirmed settled by the venue, and reconciled. One buy,
one sell, no position left open, every refusal intact.

**PROVEN by this run.** An order reaches the venue and returns a contract id;
that id is tracked from open through close; the sell targets that exact
contract; settlement is confirmed from the venue rather than inferred from the
sell reply; and the open-position alarm clears only on the venue's verdict.

**NOT proven by this run — read this before trusting reconciliation.** The P/L
was exactly **0**: proceeds 1 − cost 1 = 0, and Deriv reported 0. The
comparison therefore only ever evaluated `0 === 0`. A reconciliation that
always returned zero, or always agreed, would have produced byte-identical
output. The mismatch path is covered by unit tests (a fabricated 99 vs a
derived 0.25 fails, and a one-cent float case fails), but **no live run has yet
shown ARX detecting a real disagreement with Deriv's own arithmetic.**

That is a consequence of the instrument, not a defect: a multiplier held ~3
seconds on a quiet spot produces no measurable P/L at 2dp. Establishing it
requires a second deliberate run with a longer hold, which is a separate
owner decision and a separate order.

**Unexercised by any live run:** a rejected order, a partial fill, a requote
between quote and buy, and a hold long enough to move the P/L off zero.

**What this ruling does NOT authorise.** Buy/sell semantics are certified for
a single manual demo order. It does not authorise autonomous execution, live
money, a DerivExecutionAdapter, or dispatch through the 18-gate path. All
standing holds from Ruling 16 remain.

## Ruling 18 — reconciliation proven on a NON-ZERO P/L; keepalive and recovery added (2026-08-25)
Contract `10548672559`: bought at 1, held 60s, sold for 1.03, venue-confirmed
settled. Derived P/L `0.030000000000000027`, Deriv-reported `0.03`,
**agrees**, graded `evidence: non-zero`.

> **AMENDED same day.** This ruling originally reported "the spot moved 618.38
> → 618.80". **Withdraw that figure.** A later audit established that ARX was
> pairing the PROPOSAL's pre-trade quote with a POST-settlement streaming tick
> and presenting the delta as the trade's movement. Neither number was the
> venue's record for this contract, which publishes `entry_spot` and
> `exit_spot` in a reply ARX was already parsing and discarding.
>
> **The P/L evidence is unaffected and stands**: `derived = proceeds − cost`
> and Deriv's `profit` never involved those spot fields, so the non-zero
> reconciliation result is sound. What was wrong was a diagnostic line, not
> the arithmetic — but it was the line quoted as evidence, and it stated an
> economic fact about the trade that the venue never confirmed.
>
> Fixed: the venue's own `entry_spot`/`exit_spot` are now read, with NO
> fallback to the quote or the streaming tick — UNRESOLVED is the honest
> answer when Deriv is silent. The quote is still reported, labelled as a
> quote. This is the rule ARX's MT5 reconciler already enforced
> (`fillPrice: null`, "never fabricated onto the command"); the new Deriv path
> simply had not inherited it.

This closes the gap Ruling 17 left open. ARX's reconciliation arithmetic has
now been exercised against a real, non-zero venue-reported P/L rather than
`0 === 0`.

It also vindicated the cent-rounding fix in a way a test could not: the derived
value really did arrive as `0.030000000000000027`. Whole-cent comparison
handled it exactly.

**The incident that preceded it, recorded because the fix came from it.** A
first 60s attempt STRANDED an open position — contract `10547739159` — when the
socket idled out at exactly 60.0s. The harness had been sleeping silently
through the hold. The cause was mine: `--observe-seconds` was added and a 60s
hold recommended without considering socket idle timeout, which the 3s default
had never exposed.

The harness behaved correctly around the defect — it detected the drop, refused
to guess, reported the contract id, and exited non-zero — and the position was
recovered cleanly (profit 0.09, proceeds 1.09, venue-confirmed settled). But
correctly reporting a stranded position is not as good as not stranding one.

Now: the hold runs in 15s slices with a read-only `ping` between them; a
dropped socket triggers reconnect-with-fresh-OTP and proceeds to the close; and
`close:deriv-demo-position` recovers a position that is already stranded,
closing exactly the id an operator names and confirming settlement from the
venue. It never discovers positions on its own, so it cannot become a bulk
flattener.

**Still unexercised by any run:** a REJECTED order, a PARTIAL fill, and a
REQUOTE between quote and buy. Until those are covered, buy/sell is certified
for the HAPPY PATH only. All standing holds from Rulings 16 and 17 remain:
no autonomous execution, no live money, no `DerivExecutionAdapter`, no dispatch
through the 18-gate path.

---

## Ruling 19 — Phase 6 authorized, including the Deriv execution seam (2026-08-27)

The standing holds recorded at the end of Ruling 18 — "no `DerivExecutionAdapter`,
no dispatch through the 18-gate path" — are **explicitly lifted for guided and
demo execution**. Ruling 18's other holds are NOT lifted.

The owner's authorization, in their words: *"AUTHORIZE PHASE 6 — SELF-TRADING
GUIDED MODE, INCLUDING THE DERIV EXECUTION SEAM."* Authorized to build and wire:
Personal Trading Constitution; Approval Inbox with expiring tickets;
`DerivExecutionAdapter`; the existing 18-gate dispatch boundary; guided
confirm → execute; position/reconciliation integration; journal/debrief
integration.

**This authorization is for CONTROLLED GUIDED/DEMO EXECUTION.** It is expressly
NOT authorization for: autonomous trading without user approval; unattended
order dispatch; real-money/live-account execution; weakening any of the 18
gates; bypassing risk controls; silently retrying ambiguous orders; or
converting UNKNOWN into success/failure without venue evidence.

Demo orders are authorized only in the minimum number needed to certify Tier 1,
on a demo account, at the smallest practical stake, reconciling each before
placing another, and stopping entirely if any execution state becomes
UNKNOWN/UNRESOLVED.

Release tiers are explicit and server-authoritative: **Tier 0** dry run (all
gates and adapter mapping run; transport refuses before send), **Tier 1** demo
guided execution on an approved unexpired ticket, **Tier 2** demo supervised
continuous session. **Tier 3 (live guided) and Tier 4 (autonomous) must NOT be
enabled.** No code path may escalate a tier from the mere presence of an
environment variable.

Phase 5 remains certified and frozen. If Phase 6 integration exposes a Phase 5
defect the sequence is: reproduce, add a regression, fix minimally,
mutation-prove, and document why Phase 5 had to be reopened.

> **Why this entry exists.** An adversarial audit of the Phase 6 design flagged
> that `docs/PHASE6_GUIDED_EXECUTION_DESIGN.md` claimed owner authorization
> while this registry still ended at Ruling 18, whose closing line asserts the
> opposite. The authorization was genuine and given in session; the registry
> simply had not been updated. Recording it here closes that gap — a design
> document may not be the only place a lifted hold is written down.

---

## Review dates and the linkage guard (registry mechanics, not a ruling)

As of the governance-closure build (#54), every ruling carries a coded
**review date** and a coded **implementation linkage**:

- `owner_decisions.review_by_date` (nullable, additive; see
  `docs/migrations-pending/build-governance-closure.sql`) stores the review
  date for rulings appended through `POST /api/admin/owner-decisions`
  (optional `reviewByDate` field). Pre-existing rows are honestly null.
- `scripts/src/ci/check-owner-decision-linkage.ts` (`RULING_LINKAGE`) is the
  coded index for the rulings in THIS file: for each ruling it pins the exact
  heading, a review date, and the code anchors implementing it (or an explicit
  `noAnchorReason` for a process/absence ruling). The CI guard
  `owner-decision-linkage` fails the build when a ruling is appended without a
  linkage entry, an anchor file or pinned string disappears (the
  ruling-to-code linkage broke), a heading drifts, or a review date passes.

A review NEVER edits a ruling. Re-affirmation is an append (a new entry citing
the ruling) or a superseding ruling, plus moving the date in `RULING_LINKAGE`
in the same reviewed change. The guard turning red on an overdue date is the
intended forcing function, not an accident to be suppressed.
