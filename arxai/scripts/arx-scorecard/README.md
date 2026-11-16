# ARX Tier 1 Scorecard v2

The original scripts, rubric, metrics and dashboard are unavailable. They are no
longer dependencies. The reported historical 68.7% is not comparable with v2.

The source-backed rubric was committed before measurement. Each of the five
architecture domains has five gates: authority, source, callers, contract and
proof. Verification and operations are separate sections. No weighted percentage
or guard-count conversion is used. Approved physical-table consolidation is a
future phase; the current logical-ledger requirement remains mandatory.

## Regenerate

From the repository root:

```sh
python3 scripts/arx-scorecard/measure.py --ref HEAD --output /tmp/arx-scorecard/metrics.json
python3 scripts/arx-scorecard/build_csv.py /tmp/arx-scorecard/metrics.json --output-dir /tmp/arx-scorecard
```

Open `/tmp/arx-scorecard/index.html`. It needs no server or external dashboard.
With no evidence file, the required gates are UNKNOWN, never silently PASS.
For the recorded baseline use the measured commit and evidence path recorded in
`results/README.md`. The generated `scorecard.csv` is suitable for export.

## Evidence contract

`--evidence evidence.json` accepts an explicit review record:

```json
{
  "commit": "full measured commit SHA",
  "checks": {
    "domain-tests": {
      "command": "the actual command run",
      "exit_code": 0,
      "log": "logs/domain-tests.log",
      "sha256": "SHA-256 of the complete log file"
    }
  },
  "criteria": {
    "trade-engine.proof": {
      "status": "PASS",
      "review": "Specific evidence and limitations from source review.",
      "checks": ["domain-tests"]
    }
  }
}
```

Logs are relative to the evidence file's folder; paths outside it are rejected.
Complete logs may be gzip-compressed; the digest then covers the stored gzip file.
Review evidence must name the exact measured commit. A changed commit, missing
log, invalid digest, missing source document or absent required check makes the
criterion UNKNOWN. A failed linked check overrides a claimed PASS. DEFERRED is
only available for non-required criteria already justified in the rubric.

A human/agent review is an attestation, not a mathematical proof. The tool
validates evidence consistency; it does not manufacture architectural judgment
from file existence. Evidence must explain exceptions and known failures.

Measurement only reads committed Git objects and explicit local evidence. It
never runs tests, connects to a database, applies a migration, or queries
production. Measurement time is isolated under `measurement`; the remaining
result is deterministic for the same commit, rubric and evidence.

Test the measurement safeguards:

```sh
python3 -m unittest discover -s scripts/arx-scorecard -p 'test_*.py'
```

## Validation prerequisites

The full `pnpm run ci` aggregate currently needs a configured `DATABASE_URL`, plus
an API at `BASE_URL` with `ARX_BETA_INVITE_REQUIRED=true` for its security regression
suite. It is not a genuinely database-free aggregate despite older comments.
Use an isolated local test database and a loopback API, never production. The
integration lane self-boots its HTTP tests and needs only its own PostgreSQL
schema/database (UTC). Keep the two lanes on separate databases when concurrent.

On macOS the workspace's Linux-oriented dependency overrides exclude native test
binaries. The recorded run supplied matching temporary binaries (esbuild 0.27.3,
Rollup 4.59.0, Tailwind oxide 4.2.1, Lightning CSS 1.31.1) without changing the
workspace overrides or lockfile. Python 3's standard library is sufficient for
this scorecard; the Replit workspace already includes Python 3.11.

For a handoff, start with `results/README.md` and reproduce its measured report.
When implementation changes, collect new evidence and rescore. Do not request the
retired original scripts or dashboard, and do not carry a PASS onto a new commit
without reviewing and validating it.
