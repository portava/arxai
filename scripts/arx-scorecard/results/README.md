# Latest Tier 1 measurement

**TIER 1 COMPLETE — READY FOR BROKER VALIDATION** under approved Option A.

- Architecture: **25/25 required gates PASS** across the five domains.
- Verification: **3/3 required gates PASS**.
- Operations: **5 UNKNOWN, 1 FAIL (not deployed)**. This is not a production-readiness claim.
- Physical position-table consolidation: explicitly DEFERRED.

Measured implementation commit: `482acbc3f1b36a87f203bdcfb29382ffa3681f5a`. The report commit adds only these
artifacts and read-only environment observations; it does not change the measured application or tests. The rubric was
committed separately before measurement (`18a21ac2`). The historical 68.7% is not
comparable with v2; no new weighted percentage is invented.

[Open the offline dashboard](2026-10-25-482acbc3/index.html) ·
[CSV](2026-10-25-482acbc3/scorecard.csv) ·
[Metrics](2026-10-25-482acbc3/metrics.json) ·
[Review evidence and log digests](2026-10-25-482acbc3/evidence.json) ·
[Read-only Replit findings](2026-10-25-482acbc3/environment-observation.json) ·
[Architecture map](../../../docs/ARCHITECTURE_MAP.md) ·
[Owner runbook](../../../docs/TIER1_OWNER_RUNBOOK.md)

## Executed verification

The operational-readiness follow-up fixes false positives in switch inventory,
broker controls, schema reporting and DEMO lifecycle evidence. The owner
confirmed ARX has not been deployed; deployment is therefore an explicit unmet
gate, not an inferred pass.

The full configured `pnpm run ci` aggregate passed all 301 sequential command
steps, including all **87 architecture guards** and the scorecard's eight
measurement-safeguard tests. `pnpm run ci:integration` passed all **132 entries**
(121 spawned plus 11 in-process) on a new empty local PostgreSQL database.
`pnpm run typecheck` passed libraries, API, dashboard and scripts.

An additional CLI check ran with PostgreSQL writes disabled. It produced valid
JSON and the expected strict exit 2 for incomplete local controls; that expected
refusal is not represented as production readiness.

Complete output logs are stored as gzip files under the report's `logs/` folder.
The evidence records commands, exit codes, durations and digests. The standalone
measure tool reads these files; it does not execute them or access a database.

The full CI lane required its existing runtime prerequisites: a database URL,
a loopback API with invite-only registration, and matching Mac native test
binaries. Initial runs without those prerequisites failed and are not represented
as passing checks. Source/test fixture corrections are explained in
[the completion report](../../../docs/TIER1_COMPLETION.md). All final evidence
above was rerun against the measured commit after the corrections.

No GitHub Actions workflow or commit-status check was reported for the PR during
validation; these are executed local release-gate results, not fabricated GitHub
check runs. No production migrations, deployment, live arming, broker orders,
legacy owner assignments or column drops were performed.

## Reproduce the recorded report

From the repository root (Python 3, no external packages):

```sh
python3 scripts/arx-scorecard/measure.py --ref 482acbc3f1b36a87f203bdcfb29382ffa3681f5a --evidence scripts/arx-scorecard/results/2026-10-25-482acbc3/evidence.json --output /tmp/arx-tier1-scorecard/metrics.json
python3 scripts/arx-scorecard/build_csv.py /tmp/arx-tier1-scorecard/metrics.json --output-dir /tmp/arx-tier1-scorecard
```

Open `/tmp/arx-tier1-scorecard/index.html`. Regenerated metrics match except for
the isolated measurement timestamp. A different commit needs its own reviewed,
validated evidence; missing or stale evidence remains UNKNOWN. Do not ask for the
retired original scripts or dashboard.

## Replit import is behind GitHub

The desktop workspace **ARX AI baseline import** at `@portavainc` is a nested
import based on `d1081071`, with 16 modified imported files plus workspace
adapters/additions. Its clean checkpoint is `72c52811`. It has no v2 rubric or
Tier 1 SQL migration files. There are 599 upstream changed paths from that base
to the tested revision. This is separate from the older `arxai` app exposed by
the connector. The owner confirmed ARX has not been deployed.

Before deployment, update the correct development import using a checkpointed
three-way merge, preserving Replit's sign-out fix, adapters, dependency changes
and added files. Review overlapping edits and run its own release checks. Never
overwrite the nested source wholesale or push the outer checkpoint repository
as GitHub main. Replit remains read-only under the owner's current instruction.
