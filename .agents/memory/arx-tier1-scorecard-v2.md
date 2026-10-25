---
name: ARX Tier 1 Scorecard v2
description: Tier 1 is measured with the in-repo Scorecard v2; the original scorecard is retired and must never be requested again.
---

# ARX Tier 1 Scorecard v2

- The original scorecard (measure.py, build_csv.py, rubric, metrics, dashboard
  link) is **retired as unavailable** (owner, 2026-10-25). Never ask the owner
  for it. Its 68.7% is historical only and not comparable with v2.
- Everything is in `docs/scorecard/v2/README.md`: rubric `rubric.json`,
  scripts `scripts/scorecard/`, owner facts `evidence.json`.
- Regenerate: `SCORECARD_DATABASE_URL="postgresql://postgres@localhost:5432/arx?host=/var/tmp" pnpm run scorecard`
  → `docs/scorecard/v2/latest/dashboard.html`. Baseline: `docs/scorecard/v2/baseline/`.
- Statuses PASS/FAIL/UNKNOWN/DEFERRED, completion gates, no weights. Do not
  change criteria to improve a result; fixes go in the README changelog with a
  version bump.
- Production facts are UNKNOWN until the owner records them in evidence.json.
  Never query production to fill them.
