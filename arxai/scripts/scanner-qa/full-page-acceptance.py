#!/usr/bin/env python3
"""Validate a saved intercepted-browser run and retain failed acceptance too."""
import argparse
import hashlib
import json
import math
import statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("log", type=Path)
parser.add_argument("--dist", type=Path, required=True)
parser.add_argument("--head", required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--completion", action="store_true")
args = parser.parse_args()


def percentiles(values):
    values = sorted(value for value in values if value is not None)
    if not values:
        return {"n": 0}
    return {"n": len(values), "medianMs": statistics.median(values),
            "p95Ms": values[math.ceil(len(values) * .95) - 1],
            "p99Ms": values[math.ceil(len(values) * .99) - 1]}


report = {}
acceptance = {"passed": False, "buildHead": args.head, "runs": [],
              "limitations": ["Two animation frames are a display opportunity, not hardware presentation or proof of60fps.",
                              "Eight warm samples per CPU condition; p99 is the sample maximum.",
                              "450ms synthetic source delay; no broker or production network, no financial validation.",
                              "Completion probe adds an observer; compare feedback with the unchanged feedback probe.",
                              "No equivalent-condition TradingView or MT5 latency measurement."]}
try:
    raw = args.log.read_text()
    report = json.loads(raw.split("### Result\n", 1)[1].split("\n### Ran", 1)[0])
    assets = list(args.dist.rglob("*.js"))
    assert assets, "No production assets"
    for asset in assets:
        data = asset.read_bytes()
        assert b"jsxDEV" not in data and b"react-stack-bottom-frame" not in data, "Development runtime present"
    acceptance["indexSha256"] = hashlib.sha256((args.dist / "index.html").read_bytes()).hexdigest()
    assert len(report["runs"]) == 2
    for run in report["runs"]:
        samples = run["coldSamples"] + run["warmSamples"] + run["rapidSamples"]
        assert len(samples) == 20 and run["allClicksTrusted"]
        assert all(sample["contextCorrectAtTwoFrames"] for sample in samples), "Wrong visible context"
        assert not run["pageErrors"] and not run["errorsInSections"], "Page error"
        assert (run["finalSymbol"], run["finalPanelSymbol"], run["finalTimeframe"]) == ("GBPUSD", "GBPUSD", "15m")
        refresh = run["manualRefreshRequests"]
        assert len(refresh) == 1 and "refresh=1" in refresh[0]["query"] and refresh[0]["ended"]
        cold_end = run["warmSamples"][0]["wallStart"]
        cold_reads = [item for item in run["initialRequests"] + run["requests"]
                      if item["started"] < cold_end and ("/chart/candles" in item["path"] or "/selected-market" in item["path"])]
        assert len(cold_reads) == 6 and all("timeframe=M15" in item["query"] for item in cold_reads)
        fields = ["contextCommitMs", "twoFrameMs"]
        if args.completion:
            # Intermediate cold timeframe clicks may be superseded. They must
            # not be counted as completed merely because a canvas exists.
            required = run["coldSamples"] + run["warmSamples"] + [run["rapidSamples"][4], run["rapidSamples"][-1]]
            assert all(sample.get("seriesAppliedMs") is not None and sample.get("seriesDisplayOpportunityMs") is not None for sample in required)
            assert all(sample.get("canvasReused") for sample in run["warmSamples"])
            for sample in samples:
                if sample.get("seriesAppliedMs") is not None:
                    context = sample["seriesContext"]
                    assert context[0] == sample["symbol"] and context[2] == "offline_fixture"
                    assert sample["seriesCount"] == 200
                    assert abs(sample["seriesLastClose"] - (1 + math.sin(199 / 17) * .003)) < 1e-10
            fields += ["seriesAppliedMs", "seriesDisplayOpportunityMs"]
        else:
            assert run["warmTwoFrameP95Ms"] < 100, "Local feedback p95 exceeds100ms"
        acceptance["runs"].append({"cpuRate": run["cpuRate"], "warm": {
            field: percentiles([sample.get(field) for sample in run["warmSamples"]]) for field in fields},
            "longTasks": len(run["longTasks"]), "maximumLongTaskMs": max((task["duration"] for task in run["longTasks"]), default=0)})
    acceptance["passed"] = True
except Exception as error:
    acceptance["failure"] = str(error)
finally:
    report["acceptance"] = acceptance
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(acceptance, indent=2))
raise SystemExit(0 if acceptance["passed"] else 1)
