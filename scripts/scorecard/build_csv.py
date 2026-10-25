#!/usr/bin/env python3
"""ARX Tier 1 Scorecard v2: write metrics.csv from metrics.json.

Usage: python3 scripts/scorecard/build_csv.py [--dir docs/scorecard/v2/latest]

One row per criterion, in rubric order. Deterministic: the CSV is derived
only from metrics.json, which holds no timestamps.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
COLUMNS = ["commit", "section", "id", "status", "title", "detail", "sources", "deferral_scope", "evidence"]


def rows(metrics: dict) -> list[dict]:
    out = []
    for c in metrics["criteria"]:
        out.append({
            "commit": metrics["commit"],
            "section": c["section"],
            "id": c["id"],
            "status": c["status"],
            "title": c["title"],
            "detail": c["detail"],
            "sources": "; ".join(s["file"] for s in c["sources"]),
            "deferral_scope": (c.get("deferral") or {}).get("scope", ""),
            "evidence": " | ".join(c["evidence"]),
        })
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dir", default="docs/scorecard/v2/latest")
    args = ap.parse_args(argv)
    d = (REPO / args.dir) if not Path(args.dir).is_absolute() else Path(args.dir)
    metrics = json.loads((d / "metrics.json").read_text())
    with open(d / "metrics.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows(metrics))
    print(f"wrote {d / 'metrics.csv'} ({len(metrics['criteria'])} rows)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
