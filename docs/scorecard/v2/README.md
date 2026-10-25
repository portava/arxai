# ARX Tier 1 Scorecard v2

The scorecard for Tier 1. It replaces the original scorecard, which is
retired (see below). Authority: the owner's instruction of 2026-10-25,
recorded in [`OWNER_INSTRUCTION_2026-10-25.md`](OWNER_INSTRUCTION_2026-10-25.md).

## Regenerate

One command, from the repository root:

```sh
SCORECARD_DATABASE_URL="postgresql://postgres@localhost:5432/arx?host=/var/tmp" pnpm run scorecard
```

It runs `scripts/scorecard/measure.py`, `build_csv.py` and
`build_dashboard.py` and writes to `docs/scorecard/v2/latest/`:

| File | Content |
|---|---|
| `metrics.json` | Deterministic results: commit, rubric hash, each criterion's status and evidence, counts and verdicts. No timestamps or durations. |
| `metrics.csv` | One row per criterion, from `metrics.json`. |
| `measurement.json` | The run's non-deterministic facts: measurement time, durations, tool versions, command output tails, `git status` before and after. |
| `dashboard.html` | The readable dashboard. Open it from disk; it loads nothing external. |

**Dashboard path:** `docs/scorecard/v2/latest/dashboard.html` after a run.
The committed baseline is `docs/scorecard/v2/baseline/dashboard.html`.

`SCORECARD_DATABASE_URL` must point at a **local** database (host
`localhost`, `127.0.0.1`, `::1` or a Unix socket); anything else is refused
and the database-backed criteria become UNKNOWN. Without it the static
checks and typechecks still run. A full run takes about an hour (the
per-commit `ci` aggregate and the integration lane are the slow parts).

Other commands:

- `pnpm run scorecard:validate` checks the rubric's structure and that every
  cited source file and quote, and every check target, exists. It does not
  evaluate anything.
- `pnpm run scorecard:selftest` runs the tooling's self-tests (missing
  evidence, failed and timed-out commands, failure lines on exit 0, unsafe
  database URLs, deferral scope, integration parsing, determinism).
- `python3 scripts/scorecard/measure.py --skip-commands --out <dir>` runs the
  static checks only (command criteria are UNKNOWN). Useful while editing
  code; not a baseline.

## Baseline (2026-10-25)

Measured commit `51d231b0adeec61a5b77f2547e853b1ba9d732bb`: main
`67d8a6521b780ef7182a17d51bcf3c392b5a251e` plus the scorecard tooling only
(no application code changed). Rubric 2.0.1, local database, measured
2026-10-25 07:43 UTC. Files: `baseline/` (dashboard `baseline/dashboard.html`).

**TIER 1 NOT COMPLETE** · CODE NOT COMPLETE · NOT OPERATIONALLY READY

| Section | PASS | FAIL | UNKNOWN | DEFERRED |
|---|---|---|---|---|
| IMPL (33) | 22 | 9 | 1 | 1 |
| VER (20) | 13 | 7 | 0 | 0 |
| OPS (12) | 0 | 0 | 9 | 3 |

Unmet gates (26):

- IMPL FAIL: IMPL-PS-03 broker operator controls not enforced on the order
  path; IMPL-RG-04 permission verdict, trade-decision advisor and risk audit
  still on the saved limits; IMPL-RG-07 risk audit not scoped to the user;
  IMPL-PL-03 six per-user open-position readers filter in memory outside the
  read model; IMPL-PL-04 unified feed DEMO list from `mt5_state`; IMPL-TE-02
  manual close of a real-quote paper order priced with the mock price;
  IMPL-TE-05 My Trades DEMO open has no idempotency key; IMPL-BH-02
  `/intelligence/analyze` sizes from the platform balance; IMPL-BH-03
  multi-connection account figures use two different connections.
- IMPL UNKNOWN: IMPL-BH-07 owner confirmation of the 60 s heartbeat close
  policy.
- VER FAIL: VER-CI-01 the per-commit `ci` aggregate stops at `ci:guards`,
  which needs `DATABASE_URL` although the `ci` lane is documented as
  offline (the later `ci` steps were not reached); VER-INT-1 to VER-INT-6,
  the six tracked integration failures, all still fail. No other
  integration suite fails (VER-INT-00 PASS, 132 tests).
- OPS UNKNOWN: OPS-01 to OPS-09, no owner evidence recorded yet.

Approved deferrals in force: IMPL-PG-02, OPS-10, OPS-11, OPS-12.

### Candidates for the next rubric version (not scored in 2.0.1)

Found while preparing the baseline. They are not criteria yet; adding one
needs a new rubric version and a changelog entry.

- The Risk Governor reads `trades` for DEMO realized P/L and activity
  (`lib/riskGovernor/enforce.ts`), and nothing writes new `trades` rows since
  decision 14, so DEMO daily-loss and streak inputs are frozen history.
- The root `ci` aggregate is documented as needing no database, but its
  `ci:guards` step imports `@workspace/db` (scored today through VER-CI-01).

## The original scorecard is retired

The original scorecard (its `measure.py`, `build_csv.py`, rubric, metrics and
dashboard link) is **unavailable** and retired by the owner on 2026-10-25.
Its last reported result, **68.7%**, is kept as a historical figure only.
v2 uses different criteria and no percentage, so its results are **not
comparable** with 68.7%.

Do not ask the owner for the original scripts, metrics, rubric or dashboard
link. Use v2.

## Method

**Rubric.** [`rubric.json`](rubric.json) is the only source of criteria. Each
criterion has an id, a section, the requirement, at least one cited source
(a repository file and a quote that must appear in it), and a check. The
sources are the Tier 1 docs (`docs/TIER1_*.md`), the owner decisions
(`docs/TIER1_OWNER_DECISIONS_2026-10-25.md`), the owner runbook and the
owner's instruction. Unresolved requirements are criteria too, not only
implemented features.

**Sections.**

| Section | What it covers |
|---|---|
| IMPL: Architecture and code implementation | Owner decisions 1-19 and the documented Tier 1 requirements and findings, checked in the code. |
| VER: Verification and regression evidence | Typechecks, architecture guards, the per-commit `ci` aggregate, the owner's seven test categories, the integration lane and the six tracked integration failures. |
| OPS: Deployment and operational readiness | Production facts and owner actions. Never queried; UNKNOWN until the owner records evidence. |

**Statuses.**

| Status | Meaning |
|---|---|
| PASS | The check found the required behaviour or evidence on the measured commit. |
| FAIL | The check found the requirement unmet, or a deferral's scope violated. |
| UNKNOWN | No evidence: an owner fact not recorded, no local database, a command not run or timed out, or a target not found. Missing evidence is never PASS. |
| DEFERRED | An owner-approved deferral, with its justification and sources, whose scope check passes. If the scope check fails the criterion is FAIL. |

**Verdicts are completion gates, not a score.** A section is COMPLETE only
when every criterion in it is PASS or DEFERRED. The code verdict is IMPL and
VER together; the operational verdict is OPS. Tier 1 is complete only when
both are. There are no weights and no percentage: the documented
requirements do not justify weights. A TIER 1 NOT COMPLETE verdict lists
every unmet gate (each FAIL or UNKNOWN criterion).

**Guards are not completion.** Architecture guards count as regression
evidence (VER-GUARD-01). IMPL criteria check the specific behaviour in the
code, so a passing guard cannot make an architectural requirement PASS.

**Approved deferrals.** Three, each with a scope check:

- IMPL-PG-02: the two physical position tables stay behind one ledger
  (decision 12, option A). Deferred: a unified physical table and any
  migration toward it. Not deferred: both tables stay behind the ledger and
  no table or column is dropped. Read-model coverage of the remaining
  readers is not deferred (IMPL-PL-03, IMPL-PL-04).
- OPS-10 and OPS-11: the P0 inspection (D5, D6) and the trading week of
  demo-bridge evidence (D8). They gate a physical merge, so they are deferred
  only while no merge is started.
- OPS-12: My Trades LIVE opens, a future project the owner must authorize
  (decision 15). Deferred while the surface stays refused.

**The six tracked integration failures** (listed in the owner instruction
file) are each their own criterion (VER-INT-1 to VER-INT-6). VER-INT-00
fails if the integration lane fails anywhere else.

## Safety of a measurement

- **Read-only toward the repository.** The scripts write only the output
  directory. `measurement.json` records `git status` before and after, and
  `repository_changed_by_measurement` lists anything a measured command
  changed.
- **No production access.** `DATABASE_URL` and the `PG*` variables are
  removed from every command the scorecard runs. Database-backed checks get
  only the local `SCORECARD_DATABASE_URL`. The integration lane and the
  database tests write test rows to that local database, as they do in CI.
- **Owner facts only from `evidence.json`.** Nothing infers a production fact.

## Recording owner evidence

Production facts go in [`evidence.json`](evidence.json) under `facts`, one
entry per key listed in `_keys`:

```json
"prod_migrations_applied": {
  "status": "PASS",
  "evidence": "All eight files in lib/db/migrations applied on 2026-11-02; check:production-readiness migrationChecks all present",
  "recorded_by": "Portava",
  "recorded_on": "2026-11-02"
}
```

An entry without `status` (PASS or FAIL), `evidence` and `recorded_by`
counts as UNKNOWN. Only the owner records these facts.

## Changing the rubric

The rubric was committed before the first measurement. Do not change
criteria to improve a result. A change is allowed only to fix a check that
measures the wrong thing, or to add a requirement the owner decides; record
each change below with the reason, and bump `version`.

### Rubric changelog

- 2.0.0 (2026-10-25, `190db1c`): first version, committed before any
  measurement.
- 2.0.1 (2026-10-25): two checks measured the wrong thing. Both were found
  in a static-only dry run (`--skip-commands`) of 2.0.0, before the baseline;
  no requirement, criterion or status rule changed.
  - IMPL-PG-02 (deferral scope, "no table or column drops"): the regex also
    matched `DROP COLUMN` inside SQL comments, the documented rollback steps
    of `2026-10-24_learning_scopes.sql` and `2026-10-24_user_risk_profile.sql`.
    Neither migration executes a drop. The check now skips comment lines.
    Effect: 2.0.0 reported FAIL (scope violated); 2.0.1 reports DEFERRED.
  - IMPL-PL-03 (open-position readers): `routes/meLive.ts` passed because it
    imports the read model for another query, while it still reads every
    row for the user and filters in memory. Each file now must also have no
    whole-user ledger read. Effect: stricter; the criterion was and stays
    FAIL.

### Tooling changelog

- 2026-10-25: the first baseline attempt on rubric 2.0.1 ran while the local
  PostgreSQL server was down. Every database-backed test failed to connect
  and was reported FAIL. That run was discarded, not committed.
  `measure.py` now checks that the local database answers (`psql ... select
  1`) before any database-backed check; if it does not, those criteria are
  UNKNOWN ("local database is unreachable"). Rubric unchanged.
