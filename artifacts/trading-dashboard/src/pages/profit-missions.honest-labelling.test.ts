// THEME F (F-build) — Profit Missions are now GATED autonomy; the label must
// say exactly that, no more and no less.
//
// HISTORY
//   The original F-honest suite pinned the "planning and display only — no
//   trades are placed here" copy and DELIBERATELY pinned the ABSENCE of a
//   mission scheduler, so that the first F-build commit would fail it and force
//   this copy to be revisited BEFORE the driver landed. That is exactly what
//   happened: F-build was un-deferred and the driver now exists. This suite is
//   its successor.
//
// WHAT IS TRUE NOW (and what this suite pins)
//   - Missions CAN place trades, but ONLY through the gated path: draft →
//     approval → dispatchApprovedDraft → executeInstant (source "mission") →
//     18-gate live dispatch. Paper/demo run the SAME gate chain against a
//     simulated recorder that never contacts a broker and never fabricates a
//     fill.
//   - The default automation level (2) waits for the USER's approval on every
//     trade. Auto levels (3–6) must be earned via the promotion gates,
//     explicitly enabled for live, and are re-checked at every dispatch.
//   - The copy must state that per-level truth, keep the "goal, not a promise"
//     certificate line, and must never drift back into an unconditional
//     promise ("hands-free", "guaranteed", "achieves it for you").
//   - The backend matches the label: missions are still CREATED in paper mode;
//     the routes file never assigns executionMode "live" directly (the gated
//     lifecycle service owns that); the driver dispatches only via the
//     sanctioned execution hook; the simulated (non-live) leg states plainly
//     that the live broker is never contacted.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const ROOT = resolve(SRC, "../../..");

function read(abs: string): string {
  return readFileSync(abs, "utf8");
}

const page = read(resolve(SRC, "pages/profit-missions.tsx"));
/** Page source minus comment lines — claims must be in RENDERED copy. */
const rendered = page
  .split("\n")
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join("\n");

describe("F-build honest — the gated-autonomy truth is stated in rendered copy", () => {
  it("it frames the output as a feasibility/probability read", () => {
    expect(rendered).toMatch(/honest feasibility and probability read/i);
  });

  it("it states that trades go only through the gated approval path", () => {
    expect(rendered).toMatch(/gated approval path/i);
  });

  it("it states the default-level truth: every trade waits for the user's approval", () => {
    expect(rendered).toMatch(/waits for your approval on every trade/i);
  });

  it("it states the auto-level truth: earned, explicitly enabled, re-checked per dispatch", () => {
    expect(rendered).toMatch(/earned, explicitly enabled, and re-checked/i);
  });

  it("it states that a blocked gate holds the mission", () => {
    expect(rendered).toMatch(/blocked gate holds the mission/i);
  });

  it("the risk certificate calls the target a goal, not a promise", () => {
    expect(rendered).toMatch(/This is a goal, not a promise/);
  });
});

describe("F-build honest — no unconditional promise reappears", () => {
  // Gated-autonomy claims are allowed ONLY alongside the gating truth pinned
  // above. These phrasings are unconditional promises and stay banned outright.
  const CLAIMS: Array<[string, RegExp]> = [
    ["hands-free", /hands[-\s]?free/i],
    ["guaranteed profit / profits", /guaranteed\s+profits?\b/i],
    ["achieves it for you", /achiev\w*\s+(it|your goal)\s+for you\b/i],
    ["profit is assured / certain", /\b(assured|certain)\s+profits?\b/i],
    ["can't lose / risk-free", /\b(can't|cannot)\s+lose\b|\brisk[-\s]?free\b/i],
    ["set and forget", /set[-\s]and[-\s]forget/i],
  ];

  for (const [label, rx] of CLAIMS) {
    it(`does not claim: ${label}`, () => {
      expect(rendered).not.toMatch(rx);
    });
  }

  it("keeps the not-guaranteed disclaimer", () => {
    expect(rendered).toMatch(/not guaranteed/i);
  });
});

describe("F-build honest — the backend matches the label", () => {
  const route = read(resolve(ROOT, "artifacts/api-server/src/routes/profitMissions.ts"));
  const execution = read(resolve(ROOT, "artifacts/api-server/src/lib/missionExecution.ts"));
  const modeService = read(
    resolve(ROOT, "artifacts/api-server/src/lib/missionExecutionModeService.ts"),
  );

  it("missions are still created in paper execution mode", () => {
    expect(route).toMatch(/executionMode:\s*"paper"/);
  });

  it("no live execution mode is assignable from the mission routes directly", () => {
    expect(route).not.toMatch(/executionMode:\s*"live"/);
  });

  it("the gated lifecycle service owns the live step and requires the certificate + live gates + explicit confirm", () => {
    expect(modeService).toMatch(/CERTIFICATE_NOT_ACCEPTED/);
    expect(modeService).toMatch(/LIVE_GATES_DISABLED/);
    expect(modeService).toMatch(/EXPLICIT_CONFIRM_REQUIRED/);
    expect(modeService).toMatch(/resolveLiveBrokerExecutionEnabledAsync/);
  });

  it("the simulated (non-live) leg states the live broker is never contacted and fabricates nothing", () => {
    expect(execution).toMatch(/the live broker is never contacted/);
    expect(execution).toMatch(/no fill or profit is simulated/);
  });
});

/** Strip comment lines so prose that NAMES a banned seam never trips a scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");
}

describe("F-build honest — the driver exists and uses ONLY the sanctioned seams", () => {
  const driver = stripComments(
    read(resolve(ROOT, "artifacts/api-server/src/lib/missionDriver.ts")),
  );
  const index = read(resolve(ROOT, "artifacts/api-server/src/index.ts"));
  const route = read(resolve(ROOT, "artifacts/api-server/src/routes/profitMissions.ts"));

  it("the driver worker exists and is registered at startup", () => {
    expect(driver).toMatch(/export function startMissionDriverWorker/);
    expect(index).toMatch(/startMissionDriverWorker\(\)/);
  });

  it("the driver dispatches ONLY via the gated execution hook — never below it", () => {
    expect(driver).toMatch(/dispatchApprovedDraft/);
    expect(driver).toMatch(/manageMissionTradeExit/);
    // Nothing below the sanctioned hooks: no direct router, pipeline, broker
    // command table, or order-send primitive.
    expect(driver).not.toMatch(/\bexecuteInstant\b/);
    expect(driver).not.toMatch(/liveCommandPipeline/);
    expect(driver).not.toMatch(/\b(?:mt5CommandsTable|mt5DemoCommandsTable|arxLiveCommandsTable)\b/);
    expect(driver).not.toMatch(/\b(?:placeLiveOrderGuarded|orderSend|placeOrder)\s*\(/);
  });

  it("auto-approval re-checks the ladder + promotion gates at act time", () => {
    expect(driver).toMatch(/planMissionTick/);
    expect(driver).toMatch(/resolveMissionPromotionStatus/);
  });

  it("the routes file still hosts no scheduler of its own", () => {
    expect(route).not.toMatch(/setInterval\(/);
  });
});
