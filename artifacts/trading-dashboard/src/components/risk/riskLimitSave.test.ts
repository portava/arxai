// RANK 16 — raising a risk limit said "Saved ✓" and was not saved.
//
// THE DEFECT
//   PATCH /api/risk/settings applies TIGHTENINGS immediately and queues
//   LOOSENINGS behind a 24-hour waiting period that must then be confirmed
//   again. The response says which happened, per field:
//       { appliedNow: [...], pendingIncreases: [...], increaseDelayMs, queueFailure }
//   A repo-wide grep across the dashboard for any of those four names returned
//   ZERO hits. Both UIs discarded the response and toasted "Saved ✓" /
//   "Risk parameters updated" unconditionally, and settings.tsx used an
//   uncontrolled `defaultValue` so the number the user typed stayed on screen.
//
//   A user raising Max Daily Loss % therefore saw green confirmation and
//   believed the looser limit was in force. It was not — and since no screen in
//   the app read /risk/pending-increases, it never would be. When `queueFailure`
//   was set the increase had been dropped entirely and the UI still said Saved.
//
// WHY THESE ASSERTIONS
//   The classifier is the whole fix in one pure function, so it is tested
//   directly against each branch of the server contract — including the two
//   that must never render as success (queued, dropped). The repo rule this
//   restores is "AUTO authority may only REDUCE": a queued increase is not an
//   applied increase and no surface may draw it as one.

import { describe, it, expect } from "vitest";
import { classifyRiskSave, saveHeadline, nothingApplied } from "./riskLimitSave";

const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

describe("a tightening applies immediately", () => {
  it("is reported as applied", () => {
    const out = classifyRiskSave(["maxDailyLossPct"], { appliedNow: ["maxDailyLossPct"] });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("applied");
    expect(saveHeadline(out)).toEqual({ title: "Applied", tone: "ok" });
    expect(nothingApplied(out)).toBe(false);
  });
});

describe("a loosening is NEVER reported as saved", () => {
  const res = {
    appliedNow: [],
    increaseDelayMs: 24 * HOUR,
    pendingIncreases: [
      { id: 7, field: "maxDailyLossPct", currentValue: 2, targetValue: 5, effectiveAt: inHours(24), status: "PENDING" },
    ],
  };

  it("is reported as queued, not applied", () => {
    const out = classifyRiskSave(["maxDailyLossPct"], res);
    expect(out[0].kind).toBe("queued");
    expect(nothingApplied(out)).toBe(true);
  });

  it("says the old, tighter limit is still what is in force", () => {
    const out = classifyRiskSave(["maxDailyLossPct"], res);
    expect(out[0].message).toMatch(/does NOT apply yet/);
    expect(out[0].message).toMatch(/previous, tighter limit stays in force/);
  });

  it("names when it becomes confirmable", () => {
    const out = classifyRiskSave(["maxDailyLossPct"], res);
    expect(out[0].message).toMatch(/Confirmable in 24h/);
    expect(out[0].effectiveAt).toBe(res.pendingIncreases[0].effectiveAt);
  });

  it("the headline never reads as plain success", () => {
    const head = saveHeadline(classifyRiskSave(["maxDailyLossPct"], res));
    expect(head.tone).toBe("warn");
    expect(head.title).toMatch(/not in force yet/i);
  });
});

describe("a dropped increase is an error, not a save", () => {
  const res = {
    appliedNow: [],
    pendingIncreases: [],
    queueFailure:
      "RISK_PENDING_STORE_UNAVAILABLE: the requested increase(s) were NOT queued and will NOT apply — increases fail closed. Reductions in this request were applied.",
  };

  it("is reported as dropped and repeats the server's reason", () => {
    const out = classifyRiskSave(["riskPerTradePct"], res);
    expect(out[0].kind).toBe("dropped");
    expect(out[0].message).toMatch(/NOT saved/);
    expect(out[0].message).toMatch(/RISK_PENDING_STORE_UNAVAILABLE/);
  });

  it("the headline is an error", () => {
    expect(saveHeadline(classifyRiskSave(["riskPerTradePct"], res))).toEqual({
      title: "Not saved — the change was dropped",
      tone: "error",
    });
  });
});

describe("a mixed save reports both halves", () => {
  it("does not let the applied half mask the queued half", () => {
    const out = classifyRiskSave(["maxLotSize", "maxDailyLossPct"], {
      appliedNow: ["maxLotSize"],
      pendingIncreases: [
        { id: 9, field: "maxDailyLossPct", currentValue: 2, targetValue: 5, effectiveAt: inHours(24), status: "PENDING" },
      ],
    });
    expect(out.find((o) => o.field === "maxLotSize")!.kind).toBe("applied");
    expect(out.find((o) => o.field === "maxDailyLossPct")!.kind).toBe("queued");
    const head = saveHeadline(out);
    expect(head.tone).toBe("warn");
    expect(head.title).toBe("1 applied, 1 queued for confirmation");
  });
});

describe("a field the server did not mention is not claimed as saved", () => {
  it("reports it as unchanged rather than applied", () => {
    const out = classifyRiskSave(["minConfidenceScore"], { appliedNow: [], pendingIncreases: [] });
    expect(out[0].kind).toBe("unchanged");
    expect(out[0].message).toMatch(/No change/);
    expect(nothingApplied(out)).toBe(true);
  });

  it("an empty response cannot produce a success headline for a real field", () => {
    const head = saveHeadline(classifyRiskSave(["maxOpenTrades"], {}));
    expect(head.title).toBe("No change");
  });
});

describe("the server contract these outcomes are read from is real", () => {
  // Non-vacuous: if routes/risk.ts stopped returning these fields the
  // classifier would silently report "unchanged" for everything.
  it("PATCH /risk/settings returns appliedNow, pendingIncreases and queueFailure", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolve(HERE, "../../../../..", "artifacts/api-server/src/routes/risk.ts"),
      "utf8",
    );
    expect(src).toMatch(/router\.patch\("\/risk\/settings",\s*requireUser/);
    expect(src).toMatch(/appliedNow: Object\.keys\(plan\.applyNow\)/);
    expect(src).toMatch(/pendingIncreases: queued/);
    expect(src).toMatch(/queueFailure/);
    // …and the lifecycle the panel drives.
    expect(src).toMatch(/router\.get\("\/risk\/pending-increases",\s*requireUser/);
    expect(src).toMatch(/router\.post\("\/risk\/pending-increases\/:id\/confirm",\s*requireUser/);
    expect(src).toMatch(/router\.post\("\/risk\/pending-increases\/:id\/cancel",\s*requireUser/);
  });

  it("the dashboard now actually reads those fields", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const root = resolve(HERE, "../../../../..");
    const editor = readFileSync(resolve(root, "artifacts/trading-dashboard/src/components/risk/RiskLimitsEditor.tsx"), "utf8");
    const page = readFileSync(resolve(root, "artifacts/trading-dashboard/src/pages/risk-settings.tsx"), "utf8");
    const panel = readFileSync(resolve(root, "artifacts/trading-dashboard/src/components/risk/PendingIncreasesPanel.tsx"), "utf8");
    for (const [name, src] of [["RiskLimitsEditor", editor], ["risk-settings", page]] as const) {
      expect(src, `${name} must classify the save response`).toMatch(/classifyRiskSave/);
    }
    expect(panel).toMatch(/\/api\/risk\/pending-increases/);
    // The editor's inputs are controlled off the server value, so a queued or
    // refused increase visibly snaps back.
    expect(editor).toMatch(/value=\{draft\[key\] \?\? \(serverValue \?\? ""\)\}/);
    expect(editor).not.toMatch(/defaultValue=\{riskSettings/);
  });
});
