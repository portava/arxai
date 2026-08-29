// HONEST COPY — the claims an adversarial audit found materially false, pinned
// so they cannot silently regress.
//
// WHY THIS SUITE EXISTS
//   An audit found five families of false statement across comments, product
//   copy and labels. Each was independently re-verified against the code before
//   being corrected. The corrections are prose, so nothing but a test like this
//   stops them drifting back — a comment that lies costs nothing to write and
//   the next reader has no way to know.
//
//   This is a sibling of `profit-missions.honest-labelling.test.ts`, which pins
//   the gated-autonomy framing. This file pins the narrower, sharper claims:
//   what paper/demo actually do, what the gate count is, which actors each
//   foundation gate binds, and which level labels have behaviour behind them.
//
// THE FIVE TRUTHS PINNED HERE (all verified at HEAD on fix/honest-copy)
//   1. Paper/demo do NOT run the live gate chain. `dispatchApprovedDraft` calls
//      `executor` (→ executeInstant → the 23-gate Phase B evaluator) ONLY when
//      executionMode === "live". Paper/demo call the simulated recorder and
//      return. The mission-layer gates (probation, mission gate, Phase 7, the
//      single-flight claim) DO run for every mode — the false part was implying
//      the 23 gates did too.
//   2. The evaluator has 23 gates, not 18.
//   3. Gate #20 binds SELF_TRADE_AGENT / SYSTEM actors only. Mission-driver
//      orders are stamped USER, so #20 does not bind them today.
//   4. A paper/demo draft can never produce a result: its `sim:` command id
//      never matches an `arx_live_positions` row, and the only producer of a
//      mission draft close is the live fill/close path.
//   5. Automation level 3 has no demo broker behind it, and self-trade L4 has
//      no behaviour distinct from L3.
//
// INTEGRATOR NOTE: the sibling branch `fix/demo-ladder` may give paper/demo a
// real execution leg. If it does, truths 1, 4 and 5 change and this suite must
// be updated in the SAME merge — do not delete an assertion to make a merge go
// green.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const ROOT = resolve(SRC, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

/** Collapse newlines/indentation so a claim can be pinned across wrapped JSX. */
function flat(src: string): string {
  return src.replace(/\s+/g, " ");
}

/**
 * Flatten a COMMENT block: strip the leading `//` / `*` markers first, so a
 * sentence that wraps across comment lines reads as one sentence. Without this
 * every pinned claim would have to be kept on a single physical line, which is
 * exactly the pressure that produces terse, misleading comments.
 */
function prose(src: string): string {
  return flat(
    src
      .split("\n")
      .map((l) => l.replace(/^\s*(?:\/\/+|\*)\s?/, ""))
      .join("\n"),
  );
}

/** Source with comment lines removed — for "this claim must not be made" checks. */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const pageSrc = read("artifacts/trading-dashboard/src/pages/profit-missions.tsx");

/** Page source minus comment lines — product claims must be in RENDERED copy. */
const renderedFlat = flat(
  pageSrc
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n"),
);

const execution = read("artifacts/api-server/src/lib/missionExecution.ts");
const modeService = read("artifacts/api-server/src/lib/missionExecutionModeService.ts");
const driver = read("artifacts/api-server/src/lib/missionDriver.ts");
const bootIndex = read("artifacts/api-server/src/index.ts");
const gateContract = read("lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts");
const automation = read("lib/domain/src/profit-mission/missionAutomation.ts");
const selfTradePermission = read("lib/domain/src/self-trade/executionPermission.ts");
const positionManagement = read("lib/domain/src/self-trade/positionManagement.ts");
const foundationInputs = read("artifacts/api-server/src/lib/live/foundationGateInputs.ts");

// ── 1. The behaviour the copy describes is still the behaviour ───────────────
//
// These assert the CODE, so that if `fix/demo-ladder` changes it, this suite
// goes red and forces the copy to be revisited rather than quietly going stale.

describe("honest copy — the underlying behaviour these claims describe", () => {
  it("only a LIVE mission calls the live executor; paper/demo call the recorder", () => {
    const f = flat(execution);
    expect(f).toMatch(/executionMode === "live" \? await executor\(/);
    expect(f).toMatch(/: await simulatedExecutor\(/);
  });

  it("the simulated recorder returns a sim: command id and contacts nothing", () => {
    expect(execution).toMatch(/const commandId = `sim:\$\{args\.executionMode\}/);
    // It must not reach the live router or any broker/command primitive.
    const body = execution.slice(
      execution.indexOf("export const recordSimulatedMissionDispatch"),
      execution.indexOf("export interface DispatchApprovedDraftArgs"),
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/\bexecuteInstant\b/);
    expect(body).not.toMatch(/arxLiveCommandsTable|arxLivePositionsTable/);
  });

  it("gate #20 is demanded only of SELF_TRADE_AGENT / SYSTEM actors", () => {
    expect(flat(foundationInputs)).toMatch(
      /export function edgePromotionRequiredForActor\(actorType: string \| null\): boolean \{ return actorType === "SELF_TRADE_AGENT" \|\| actorType === "SYSTEM"; \}/,
    );
  });
});

// ── 2. Gate count: 23, pinned to the contract's own key union ────────────────

describe("honest copy — the gate count is 23 and is pinned to the code", () => {
  it("the contract's key union declares exactly 23 gates plus the sentinel", () => {
    const union = gateContract.slice(
      gateContract.indexOf("export type LivePhaseBGateKey"),
      gateContract.indexOf("export interface LivePhaseBGateInput"),
    );
    expect(union.length).toBeGreaterThan(0);
    const keys = [...union.matchAll(/\|\s*"([A-Z_]+)"/g)].map((m) => m[1]);
    // The trailing sentinel is a block REASON, not an evaluated gate.
    expect(keys).toContain("BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED");
    const gates = keys.filter((k) => k !== "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED");
    expect(gates).toHaveLength(23);
  });

  it("the contract header states 23, not a stale count", () => {
    expect(gateContract).toMatch(/23-gate evaluator/);
    expect(gateContract).toMatch(/pushes exactly 23 entries/);
  });

  const STALE = /18[- ]gates?\b/;
  const SWEPT: Array<[string, string]> = [
    ["missionExecution.ts", execution],
    ["missionExecutionModeService.ts", modeService],
    ["missionDriver.ts", driver],
    ["api-server/src/index.ts", bootIndex],
    ["missionPromotionService.ts", read("artifacts/api-server/src/lib/missionPromotionService.ts")],
    ["liveArming.ts", read("artifacts/api-server/src/lib/live/liveArming.ts")],
    ["livePhaseBDispatchGate.ts", gateContract],
    ["missionAutomation.ts", automation],
    ["profit-missions.tsx", pageSrc],
    ["openapi.yaml", read("lib/api-spec/openapi.yaml")],
  ];

  for (const [name, src] of SWEPT) {
    it(`no stale "18-gate"/"18 gates" survives in ${name}`, () => {
      // The gate contract is allowed to NAME the stale counts when explaining
      // that they are stale; nothing else may state one as fact.
      const lines = src.split("\n").filter((l) => STALE.test(l));
      const offending = lines.filter((l) => !/stale|superseded|previously/i.test(l));
      expect(offending).toEqual([]);
    });
  }
});

// ── 3. Comments: the paper/demo conflation must not come back ────────────────

describe("honest copy — comments state which chain each mode runs", () => {
  const CONFLATION = /paper\/demo run the SAME gate chain|runs the SAME gate chain/i;

  const COMMENTED: Array<[string, string]> = [
    ["missionExecution.ts", execution],
    ["missionExecutionModeService.ts", modeService],
    ["api-server/src/index.ts", bootIndex],
    ["missionDriver.ts", driver],
  ];

  for (const [name, src] of COMMENTED) {
    it(`${name} does not claim paper/demo run the SAME gate chain`, () => {
      expect(src).not.toMatch(CONFLATION);
    });
  }

  it("missionExecution names the mission-layer chain vs the live-only chain", () => {
    const p = prose(execution);
    expect(p).toMatch(/BOTH modes run the MISSION-LAYER chain/);
    expect(p).toMatch(/ONLY `live` then calls `executor`/);
    expect(p).toMatch(/NONE of those run for paper\/demo/);
  });

  it("missionExecution states the no-result consequence at the recorder seam", () => {
    expect(prose(execution)).toMatch(
      /produces NO realised result, NO protective-exit management and NO progress toward its target, and cannot complete/,
    );
  });

  it("the mode service and boot comment both say the 23 gates are not evaluated for paper/demo", () => {
    expect(prose(modeService)).toMatch(/the 23 gates are NOT evaluated for it/);
    expect(prose(bootIndex)).toMatch(/the 23 gates are not evaluated for it/);
  });
});

// ── 4. The gate contract states real actor coverage, not intent ──────────────

describe("honest copy — the foundation gates' actor coverage is stated exactly", () => {
  it("the header carries an ACTOR COVERAGE block", () => {
    expect(gateContract).toMatch(/ACTOR COVERAGE of the FOUNDATION gates/);
  });

  it("#20 is described as binding SELF_TRADE_AGENT / SYSTEM, not 'autonomous entries'", () => {
    const f = flat(gateContract);
    expect(f).toMatch(/#20 STRATEGY_NOT_LIVE_PROMOTED — binds only entries whose recorded/);
    expect(f).toMatch(/SELF_TRADE_AGENT or SYSTEM/);
  });

  it("the mission-driver coverage gap in #20 is named, not implied", () => {
    const f = flat(gateContract);
    expect(f).toMatch(/KNOWN GAP/);
    expect(f).toMatch(/Profit-Mission driver/);
    expect(f).toMatch(/stamped USER/);
  });

  it("#19/#21 are stated as binding every entry regardless of actor", () => {
    const f = flat(gateContract);
    expect(f).toMatch(/#19 PROVENANCE_UNPROVEN\s+— binds EVERY live entry/);
    expect(f).toMatch(/#21 CAPITAL_TIER_EXCEEDED\s+— binds EVERY live entry/);
  });
});

// ── 5. Product copy: the page says what paper/demo do, in rendered copy ──────

describe("honest copy — the page states the paper/demo truth to the user", () => {
  it("it says the 23-gate check runs on live dispatch only", () => {
    expect(renderedFlat).toMatch(/23-gate safety check runs on live dispatch only/i);
  });

  it("it says no broker is contacted — not even a demo one", () => {
    expect(renderedFlat).toMatch(/reaches no broker, not even a demo one/i);
    expect(renderedFlat).toMatch(/there is no demo broker behind them/i);
  });

  it("it says a paper/demo mission cannot produce a result or complete", () => {
    expect(renderedFlat).toMatch(/cannot produce a result and cannot complete its target/i);
    expect(renderedFlat).toMatch(
      /mission cannot progress toward its target or complete on it/i,
    );
  });

  it("it says protective exits cannot apply to a demo/paper dispatch", () => {
    expect(renderedFlat).toMatch(/never opens a position, so there is nothing for the exit manager to find/i);
  });

  it("the ladder copy states the real road — levels are earned on live results", () => {
    expect(renderedFlat).toMatch(
      /Automation levels are earned from real closed results on a live mission/i,
    );
    expect(renderedFlat).toMatch(/cannot build the track record the promotion gates ask for/i);
  });

  it("realised figures are labelled live-only rather than reading as a full total", () => {
    expect(renderedFlat).toMatch(/count realised closed live trades only/i);
    expect(renderedFlat).toMatch(/Read these as a live-only total, not as the mission's full activity/i);
  });

  it("the page never implies demo/paper are gate-checked", () => {
    // The pinned original line is allowed to stand; what must never appear is a
    // claim that the gates apply to the simulated modes.
    expect(renderedFlat).not.toMatch(/demo and paper[^.]{0,60}(gate-checked|pass the 23)/i);
  });
});

// ── 6. Level labels describe behaviour that exists ──────────────────────────

describe("honest copy — automation level labels match the code", () => {
  // "must not say" checks run against the label/description SOURCE only: the
  // corrected comments quote the old wording to explain why it was wrong, and
  // that quotation is the point — it must not be mistaken for a regression.
  it("level 3 no longer claims it auto-executes on a DEMO account", () => {
    expect(codeOnly(automation)).not.toMatch(/Auto-executes on a DEMO account only/);
  });

  it("level 3 says it records intent and that demo execution is not yet available", () => {
    const f = flat(automation);
    expect(f).toMatch(/Demo auto \(records intent only\)/);
    expect(f).toMatch(/No broker account is contacted — not a live one and not a demo one/);
    expect(f).toMatch(/Auto-execution against a real demo account is NOT YET AVAILABLE/);
  });

  it("level 4 no longer promises micro-size caps it does not apply", () => {
    expect(codeOnly(automation)).not.toMatch(/Supervised micro-size live execution with tight caps/);
    // NB: the description is a concatenation of string literals, so pin a
    // fragment that lives inside ONE literal rather than across the `+`.
    expect(flat(automation)).toMatch(/size-limited by the level itself/);
  });

  it("the dashboard label maps mirror the corrected level 3/4 labels", () => {
    for (const rel of [
      "artifacts/trading-dashboard/src/pages/profit-missions.tsx",
      "artifacts/trading-dashboard/src/components/missions/MissionPerformanceView.tsx",
    ]) {
      const src = read(rel);
      expect(src, rel).toMatch(/3: "Demo auto \(records intent only\)"/);
      expect(src, rel).not.toMatch(/4: "Micro live"/);
    }
  });
});

describe("honest copy — self-trade L4 is not labelled as authority it does not have", () => {
  it("executionPermission states L2/L3/L4 share one EXECUTE verdict", () => {
    const f = flat(selfTradePermission);
    expect(f).toMatch(/L2, L3 and L4 are NOT distinguished here/);
    expect(f).toMatch(/L4 has NO behaviour distinct from L3 anywhere/);
  });

  it("positionManagement no longer claims an unimplemented L4 'extend'", () => {
    expect(positionManagement).not.toMatch(/L3 manage; L4 also extend \(handled by caller\)/);
    expect(flat(positionManagement)).toMatch(/no caller implements an L4 "extend" behaviour/);
  });

  it("positionManagement really does not read autonomyLevel (so the note stays true)", () => {
    const body = positionManagement.slice(positionManagement.indexOf("export function"));
    expect(body).not.toMatch(/autonomyLevel/);
  });

  it("the self-trade admin surface tells the operator L4 adds nothing", () => {
    const admin = read("artifacts/trading-dashboard/src/pages/admin/self-trade-ai.tsx");
    expect(flat(admin)).toMatch(/L4 currently behaves exactly as L3/);
    expect(admin).toMatch(/4: "Same as L3 \(no added authority implemented\)"/);
  });
});
