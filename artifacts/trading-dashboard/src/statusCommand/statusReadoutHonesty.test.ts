// STATUS-READOUT HONESTY — pins for the "ARX Status C" truth-system batch.
//
// Each pin guards a fixed dead-gauge / confident-unknown defect on a status
// or health readout. Source pins (not render tests) on purpose: every one of
// these lies was in the SOURCE shape — a fallback constant, a swallowed
// error, a hard-coded literal — so the pin fails the moment the constant
// quietly returns, regardless of runtime wiring.
//
//   1. Topbar rendered "Mode: Mock" / "MT5: OFF" when the status query had
//      failed or never loaded — unknown shown as a confident mock claim.
//   2. SafetyHeader's green "Live Chart" pill lit on window.TradingView
//      existing — script presence, not a live feed.
//   3. useRuntimeContext kept the last successful health/bridge snapshot
//      forever with no staleness signal when refreshes started failing.
//   4. System Health page rendered failed probe counts as 0 and a failed
//      redaction probe as "Working: true".
//   5. Release Notes' "Known issues" was fed a hard-coded [] while real open
//      P0s lived in the feedback table.
//   6. Admin Security Status described a superseded x-security-role auth
//      model as static prose and lit "Session: OK" on any truthy JSON.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

function code(rel: string): string {
  // Strip comments so honesty notes describing the OLD defect don't false-positive.
  return readFileSync(resolve(SRC, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("Topbar renders unknown, not Mock/OFF, when MT5 status is unavailable", () => {
  const src = code("components/layout/Topbar.tsx");
  it("has an UNKNOWN mode meta and no MOCK fallback", () => {
    expect(src).toMatch(/UNKNOWN: \{/);
    expect(src).not.toMatch(/\|\| MODE_META\.MOCK/);
  });
  it("the MT5 pill and detail rows carry a distinct unknown state", () => {
    expect(src).toMatch(/p\.mt5 == null \? "\?"/);
    expect(src).toMatch(/unknown — status unavailable/);
    expect(src).not.toMatch(/p\.mt5\?\.connected \? "ON" : "OFF"/);
  });
});

describe("SafetyHeader does not sell script presence as a live feed", () => {
  const src = code("components/ss/SafetyHeader.tsx");
  it("the TradingView-presence pill says library-loaded, not Live Chart", () => {
    expect(src).toMatch(/Chart Library Loaded/);
    expect(src).not.toMatch(/> Live Chart\b/);
    // And it must not render in the success (green) tone.
    expect(src).not.toMatch(/bg-success[^\n]*\n[^\n]*Chart Library Loaded/);
  });
});

describe("useRuntimeContext labels a frozen snapshot as stale", () => {
  const src = code("assistant/useRuntimeContext.ts");
  it("tracks last full success and flips runtimeDataStale after ~2 intervals", () => {
    expect(src).toMatch(/lastFullSuccessRef/);
    expect(src).toMatch(/REFRESH_MS \* 2/);
    expect(src).toMatch(/runtimeDataStale/);
  });
  it("the Status Command Center surfaces the stale flag", () => {
    const page = code("pages/status-command-center.tsx");
    expect(page).toMatch(/ctx\.runtimeDataStale/);
    expect(page).toMatch(/scc-runtime-stale/);
  });
});

describe("System Health page renders failed probes as unavailable, never 0/true", () => {
  const src = code("pages/system-health.tsx");
  it("critical unread and leak counts have a null branch", () => {
    expect(src).toMatch(/latestNotificationCriticalCount: number \| null/);
    expect(src).toMatch(/latestNotificationCriticalCount \?\?/);
    expect(src).toMatch(/redactionWorking === null/);
  });
});

describe("WorkflowHealthCard distinguishes failed bridge aggregate from zero bridges", () => {
  const src = code("components/admin/WorkflowHealthCard.tsx");
  it("renders an unavailable state when bridge.ok is false", () => {
    expect(src).toMatch(/bridge\.ok === false/);
    expect(src).toMatch(/counts are unknown, not zero/);
  });
});

describe("Release Notes known issues are real, with an unavailable state", () => {
  const src = code("pages/release-notes.tsx");
  it("knownIssues is nullable and null renders as unavailable", () => {
    expect(src).toMatch(/knownIssues: string\[\] \| null/);
    expect(src).toMatch(/items === null/);
  });
});

describe("Admin Security Status probes facts instead of asserting prose", () => {
  const src = code("pages/admin-security-status.tsx");
  it("no longer claims mutations require the x-security-role header", () => {
    expect(src).not.toMatch(/require[^\n]*x-security-role/);
    expect(src).toMatch(/NOT honored/);
  });
  it("probes the anonymous gate with credentials omitted and keeps a failed probe unverified", () => {
    expect(src).toMatch(/credentials: "omit"/);
    expect(src).toMatch(/UNVERIFIED/);
  });
  it("the Session pill requires a role-shaped ok response, not any truthy JSON", () => {
    expect(src).toMatch(/typeof obj\.role === "string"/);
    expect(src).not.toMatch(/\.then\(setS\)/);
  });
});
