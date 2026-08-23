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
