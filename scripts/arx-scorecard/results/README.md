# Latest Tier 1 measurement

**TIER 1 COMPLETE — READY FOR BROKER VALIDATION** under approved Option A.

- Architecture: **25/25 required gates PASS** across the five domains.
- Verification: **3/3 required gates PASS**.
- Operations: **5 UNKNOWN, 1 FAIL (not deployed)**.
- Physical position-table consolidation remains explicitly DEFERRED.

Measured implementation: `cc0f268d2eee439db382ce5c30b3d4becff82dc2`. The following report commit changes only
documentation and evidence; application and test source remain the measured tree.
This is not a claim of complete production readiness or a weighted percentage.
The old 68.7% score is not comparable with Scorecard v2.

[Offline dashboard](2026-10-26-cc0f268d/index.html) ·
[CSV](2026-10-26-cc0f268d/scorecard.csv) ·
[Metrics](2026-10-26-cc0f268d/metrics.json) ·
[Evidence and log digests](2026-10-26-cc0f268d/evidence.json) ·
[Architecture breakdown and responsibilities](../../../docs/ARCHITECTURE_MAP.md) ·
[Owner runbook](../../../docs/TIER1_OWNER_RUNBOOK.md)

## Fresh verification

The full configured CI aggregate passed all 308 sequential command steps,
including **87/87 guards**. Integration passed **132 entries** (121 spawned and
11 in-process) against a separate new local database. Full typechecking and both
production builds passed. Tests used isolated local databases, UTC and no
inherited provider, broker or email credentials.

A production-mode application smoke test served the actual built dashboard,
login/reset deep links and assets, retained anonymous API rejection and kept
unknown API/private/missing-asset paths out of HTML fallback. Its database was
read-only. The preflight command correctly refused incomplete controls with exit
2. Temporary harness invocation mistakes were corrected before this passing run;
no application behavior was changed to satisfy the smoke check.

Complete logs are retained as gzip files with stored and raw SHA-256 digests.
The scorecard reads explicit evidence; it does not run tests or inspect production.

## Development versus production

The user approved updates to ARX AI baseline import (@portavainc). This revision
was installed there while preserving its Replit configuration and existing work.
Development passed 73 focused regressions, 87 guards, API/dashboard typechecks
and both builds. These results are additional environment checks, not substitutes
for the local evidence above or production receipts.

The repaired adapter returned a current real EURUSD quote with bid/ask at
10:56 UTC on October 26. All three configured intraday-candle paths reported
restricted access. See [market-data readiness](../../../docs/TIER1_MARKET_DATA_READINESS.md).
No provider subscription was changed. No actual broker test, order, production
release or real email/alert send was performed. The prior request to locate the
original scorecard is retired permanently; use this repository-owned report.

## Reproduce

```sh
python3 scripts/arx-scorecard/measure.py --ref cc0f268d2eee439db382ce5c30b3d4becff82dc2 --evidence scripts/arx-scorecard/results/2026-10-26-cc0f268d/evidence.json --output /tmp/arx-scorecard/metrics.json
python3 scripts/arx-scorecard/build_csv.py /tmp/arx-scorecard/metrics.json --output-dir /tmp/arx-scorecard
```

The regenerated metrics match except for measurement time. A changed implementation
needs its own review and checks. Historical reports remain in adjacent folders.
