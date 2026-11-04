// THEME F (F-honest) — Profit Missions must present as planning/advisory.
//
// THE AUDIT'S CONCERN
//   The pursuit loop is inert end-to-end: missions are hardcoded
//   `executionMode: "paper"`, draft→fill linkage is never written, no scheduler
//   advances a mission, and mission risk reads global paper history. So the
//   product must NOT present itself as autonomously pursuing and achieving a
//   goal. F-build (making it real) is explicitly out of scope; F-honest — the
//   labelling — is therefore the ONLY thing standing between the user and a
//   false "give it a goal and it achieves it" impression.
//
// WHAT THE AUDIT FOUND WHEN CHECKED
//   The relabel is already in place, on both sides:
//     - Page subtitle: "Describe a goal and get an honest feasibility and
//       probability read. Planning and display only — no trades are placed
//       here."
//     - Risk certificate: "Read carefully. This is a goal, not a promise."
//     - Page header comment: PLANNING + DISPLAY ONLY / ADVISORY ONLY.
//     - Server: executionMode is hardcoded "paper", and the execute path
//       answers "the live broker is never contacted".
//     - CI: the mission-no-direct-execution guard already blocks a direct
//       dispatch path.
//   A sweep of every mission surface for autonomy claims ("will trade",
//   "automatically executes", "works toward", "on its own", "hands-free",
//   "pursues", "autonomous") found NOTHING.
//
// WHAT THIS SUITE ADDS
//   That honest copy was pinned by no test at all, so nothing stopped it being
//   softened back into a promise. This locks it. It asserts the DISCLAIMERS
//   are present and that no autonomy claim reappears — the cheapest possible
//   protection for the one thing keeping the feature honest while it is inert.

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

describe("F-honest — the planning-only disclaimer is present", () => {
  it("the page subtitle says planning and display only", () => {
    expect(rendered).toMatch(/Planning and display only/);
  });

  it("it states plainly that no trades are placed", () => {
    expect(rendered).toMatch(/no trades are placed here/i);
  });

  it("it frames the output as a feasibility/probability read", () => {
    expect(rendered).toMatch(/honest feasibility and probability read/i);
  });

  it("the risk certificate calls the target a goal, not a promise", () => {
    expect(rendered).toMatch(/This is a goal, not a promise/);
  });
});

describe("F-honest — no autonomy claim reappears", () => {
  const CLAIMS: Array<[string, RegExp]> = [
    ["will trade / will execute / will place", /will\s+(trade|execute|place|open)\b/i],
    ["automatically trades", /automatically\s+(trade|execute|place)/i],
    ["works toward / works for you", /works?\s+(toward|for you)\b/i],
    ["on its own", /on its own\b/i],
    ["hands-free", /hands[-\s]?free/i],
    ["pursues", /\bpursu(e|es|ing)\b/i],
    ["autonomous", /\bautonomous(ly)?\b/i],
    ["achieves it for you", /achiev\w*\s+(it|your goal)\b/i],
  ];

  for (const [label, rx] of CLAIMS) {
    it(`does not claim: ${label}`, () => {
      expect(rendered).not.toMatch(rx);
    });
  }
});

describe("F-honest — the backend matches the label", () => {
  const route = read(resolve(ROOT, "artifacts/api-server/src/routes/profitMissions.ts"));

  it("missions are created in paper execution mode", () => {
    expect(route).toMatch(/executionMode:\s*"paper"/);
  });

  it("the execute path says the live broker is never contacted", () => {
    expect(route).toMatch(/the live broker is never contacted/);
  });

  it("no live execution mode is assignable from the mission routes", () => {
    expect(route).not.toMatch(/executionMode:\s*"live"/);
  });
});

describe("F-honest — F-build was NOT attempted", () => {
  // Explicitly out of scope. Pinning its absence keeps the labelling honest:
  // if a driver ever appears, this fails and the copy must be revisited FIRST.
  it("no mission scheduler/worker was added", () => {
    const route = read(resolve(ROOT, "artifacts/api-server/src/routes/profitMissions.ts"));
    expect(route).not.toMatch(/setInterval\(/);
    expect(route).not.toMatch(/missionWorker|startMissionLoop/i);
  });
});
