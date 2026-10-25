# Latest Tier 1 measurement

**TIER 1 COMPLETE — READY FOR BROKER VALIDATION** under approved Option A.

- Architecture: **25/25 required gates PASS** across the five domains.
- Verification: **3/3 required gates PASS**.
- Operations: **6/6 UNKNOWN**. This is not a production-readiness claim.
- Physical position-table consolidation: explicitly DEFERRED.

Measured implementation commit: `afe680ee9f5fdcff184274218f18f4c6850e3318`. The report commit adds only these
artifacts; it does not change the measured application or tests. The rubric was
committed separately before measurement (`18a21ac2`). The historical 68.7% is not
comparable with v2; no new weighted percentage is invented.

[Open the offline dashboard](2026-10-25-afe680ee/index.html) ·
[CSV](2026-10-25-afe680ee/scorecard.csv) ·
[Metrics](2026-10-25-afe680ee/metrics.json) ·
[Review evidence and log digests](2026-10-25-afe680ee/evidence.json) ·
[Architecture map](../../../docs/ARCHITECTURE_MAP.md) ·
[Owner runbook](../../../docs/TIER1_OWNER_RUNBOOK.md)

## Executed verification

The full configured `pnpm run ci` aggregate passed all 301 sequential command
steps, including all **87 architecture guards** and the scorecard's eight
measurement-safeguard tests. `pnpm run ci:integration` passed all **132 entries**
(121 spawned plus 11 in-process) on a new empty local PostgreSQL database.
`pnpm run typecheck` passed libraries, API, dashboard and scripts.

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
python3 scripts/arx-scorecard/measure.py --ref afe680ee9f5fdcff184274218f18f4c6850e3318 --evidence scripts/arx-scorecard/results/2026-10-25-afe680ee/evidence.json --output /tmp/arx-tier1-scorecard/metrics.json
python3 scripts/arx-scorecard/build_csv.py /tmp/arx-tier1-scorecard/metrics.json --output-dir /tmp/arx-tier1-scorecard
```

Open `/tmp/arx-tier1-scorecard/index.html`. Regenerated metrics match except for
the isolated measurement timestamp. A different commit needs its own reviewed,
validated evidence; missing or stale evidence remains UNKNOWN. Do not ask for the
retired original scripts or dashboard.
