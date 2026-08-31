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
//   4. A paper/demo draft never produces a BROKER-RECONCILED result: its `sim:`
//      command id never matches an `arx_live_positions` row, and the only
//      producer of a `pnl`/`closedAt` close is the live fill/close path. It DOES
//      produce a SIMULATED result in the separate `sim_*` family — see below.
//   5. Automation level 3 has no demo broker behind it, and self-trade L4 has
//      no behaviour distinct from L3.
//
// UPDATED for the wired fill simulator (`missionSimulatedFills.ts`). The sibling
// work anticipated in the original INTEGRATOR NOTE landed: paper/demo now get a
// real simulated execution leg — fills priced from real quotes, closed against
// later real quotes, SIMULATED P/L that moves currentValue, completes missions
// and feeds the demo_performance promotion gate. Truths 1 and 5's "no gates" and
// "no demo broker" halves are unchanged and still pinned; the "produces nothing"
// half of truths 4 and 5 was FALSE against this code and has been replaced by
// assertions that the copy states the simulated basis and never blends it with
// broker money. Do not restore the old denial to make a merge go green.

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
    // fix/demo-ladder made the simulated seam lazily resolved so the fill
    // simulator can be swapped in tests; the branch shape is unchanged.
    expect(f).toMatch(/: await \(await resolveSimulatedExecutor\(\)\)\(/);
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

  // A COUNT of 18 gates, in every phrasing this repo has actually used.
  //
  // WHY A FAMILY AND NOT ONE REGEX: the first version of this suite pinned only
  // /18[- ]gates?\b/. That literal misses every phrasing with a word between
  // the numeral and "gates" — and liveArming.ts said "the 18 dispatch gates",
  // so the suite reported that file CLEAN while the stale count sat in it. A
  // guard that cannot fail on the file it names is worse than no guard: it
  // manufactures assurance. Each pattern below is proved to bite by the
  // self-test underneath, which is the real defence — extend BOTH together.
  //
  // These match a TOTAL, never a gate INDEX: "Gate 18", "gate #18" and
  // "#18 DISCLOSURE_NOT_ACCEPTED" name the disclosure gate and are legitimate.
  const STALE_PATTERNS: Array<[string, RegExp]> = [
    ["N-gate(s)", /\b18[-\s](?:dispatch\s+|Phase\s+B\s+|execution\s+|live\s+)?gates?\b/i],
    ["all 18", /\ball\s+18\b/i],
    ["of 18 / of the 18", /\bof\s+(?:the\s+)?18\b/i],
    ["18/18 truth table or dispositions", /\b18\/18\b/],
    ["18 must PASS", /\b18\s+must\s+PASS\b/i],
    ["18 total", /\b18\s+total\b/i],
    ["nineteenth gate", /\bnineteenth\s+gate\b/i],
  ];

  // The guard must be able to FAIL. If a phrasing stops matching, this goes red
  // before any file check can report a false CLEAN.
  it("the stale-count patterns actually match every phrasing the repo has used", () => {
    const knownBad = [
      "This never bypasses any of the 18 dispatch gates —", // liveArming.ts:451
      "evaluates all 18 Phase B gates, and only THEN writes",
      "the 18-gate Phase B evaluator remains the only path",
      "ALL 18 must PASS",
      "that satisfies gate #1 of 18",
      "its 18/18 truth table still holds",
      "## Current safety gates (Phase B, 18 total)",
      "adding a nineteenth gate to the live",
      "All 18 Phase B dispatch gates still apply on every order.",
      "Venue gate parity, 18/18 dispositions",
    ];
    const missed = knownBad.filter((s) => !STALE_PATTERNS.some(([, re]) => re.test(s)));
    expect(missed).toEqual([]);
  });

  // ...and must NOT fire on a legitimate gate INDEX or an unrelated 18.
  it("the stale-count patterns do not fire on a gate index or an unrelated 18", () => {
    const knownGood = [
      "// ── GATE 18, before anything can claim the ticket ───────",
      "#18 `DISCLOSURE_NOT_ACCEPTED`, and the five FOUNDATION",
      "per-user access gate and Phase B gate #18 honor either acceptance OR waiver.",
      "assignedAllocation: 181.58,",
      'check("A18  honesty trigger \'prop firm mode is on\' still gated",',
      "gateVerdicts: { g1: \"PASS\", g18: \"PASS\" },",
    ];
    const falsePositives = knownGood.filter((s) => STALE_PATTERNS.some(([, re]) => re.test(s)));
    expect(falsePositives).toEqual([]);
  });

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
    // Added after the first sweep reported CLEAN on files it had not corrected.
    ["liveCommandCas.ts", read("artifacts/api-server/src/lib/live/liveCommandCas.ts")],
    ["liveCommandPipeline.ts", read("artifacts/api-server/src/lib/live/liveCommandPipeline.ts")],
    [
      "unifiedLiveReadinessDecision.ts",
      read("artifacts/api-server/src/lib/live/unifiedLiveReadinessDecision.ts"),
    ],
    [
      "approvedTraderLiveState.ts",
      read("artifacts/api-server/src/lib/live/approvedTraderLiveState.ts"),
    ],
    ["meApprovalInbox.ts", read("artifacts/api-server/src/routes/meApprovalInbox.ts")],
    ["adminMasterLiveAccess.ts", read("artifacts/api-server/src/routes/adminMasterLiveAccess.ts")],
    [
      "MasterLiveUserAccessTable.tsx",
      read("artifacts/trading-dashboard/src/components/admin/MasterLiveUserAccessTable.tsx"),
    ],
    ["recoveryProbation.ts", read("artifacts/api-server/src/lib/recoveryProbation.ts")],
    ["check-live-dispatch-cas.ts", read("scripts/src/ci/check-live-dispatch-cas.ts")],
    ["missionExecutionRoute.test.ts", read("artifacts/api-server/src/routes/__qa__/missionExecutionRoute.test.ts")],
  ];

  for (const [name, src] of SWEPT) {
    it(`no stale 18-gate count survives in ${name}`, () => {
      // A line may NAME a stale count when it is explaining that the count is
      // stale, historical, or how the current 23 were composed ("the original
      // 18 + #19..#23"). Nothing else may state one as fact.
      const offending = src
        .split("\n")
        .filter((l) => STALE_PATTERNS.some(([, re]) => re.test(l)))
        .filter((l) => !/stale|superseded|previously|original|at the time|audit time|was 18|Editorial note/i.test(l));
      expect(offending).toEqual([]);
    });
  }
});

// ── 2b. Dated records are corrected by annotation, never by rewriting ────────
//
// The first sweep blind-replaced "18-gate" -> "23-gate" inside verbatim archives
// (docs/history/, attached_assets/, docs/prodready-20260819/) and inside dated
// owner Rulings 16-19 — including inside a QUOTED hold. That makes a
// point-in-time record assert something that was not true when it was written,
// which is the exact failure mode this branch exists to remove. Dated text keeps
// its numeral; an editorial note carries the current count.

describe("honest copy — dated records keep their numerals and gain a marker", () => {
  const ownerDecisions = read("docs/OWNER_DECISIONS.md");
  const decisions = read("docs/DECISIONS.md");

  it("the owner rulings still read as written and carry an editorial marker", () => {
    expect(ownerDecisions).toMatch(/the 18-gate Phase B evaluator remains/);
    expect(ownerDecisions).toMatch(/no dispatch through the 18-gate path/);
    expect(flat(ownerDecisions)).toMatch(
      /Editorial note \(added 2026-08-29, not part of the ruling\)[\s\S]{0,240}?The count is now \*\*23\*\*/,
    );
  });

  it("DECISIONS.md keeps Ruling 19's quoted hold intact and dates its correction", () => {
    expect(decisions).toMatch(/no dispatch through the 18-gate path" recorded at/);
    expect(decisions).toMatch(/the gate count is 23 \(was 18 when this ruling was first/);
  });
});

// ── 3. Comments: the paper/demo conflation must not come back ────────────────

describe("honest copy — comments state which chain each mode runs", () => {
  // The conflation is "a non-live mission runs the same gates as a live one".
  // The first version pinned only the exact phrase "runs the SAME gate chain",
  // so the variant "runs the same gates" survived — in a TEST TITLE, in a file
  // the same commit had edited. Match the claim, not one spelling of it.
  //
  // Two traps this has to survive, both of which bit the first version:
  //   * the sentence WRAPS across comment lines, so "runs the" and "SAME gate
  //     chain" sit on different physical lines with a `//` between them. Every
  //     check below therefore runs against prose(), never the raw source.
  //   * the emphatic capital "SAME gate chain" is itself the tell. Honest
  //     phrasing names WHICH chain ("the MISSION-LAYER chain"), so an
  //     unqualified "SAME gate chain" in these files is always the conflation.
  const CONFLATION_PATTERNS: RegExp[] = [
    /SAME gate chain/,
    /\bruns? the same gates\b/i,
    /(?:paper|demo|non-live)[^.]{0,80}?\bruns? the same gate(?: chain|s)\b/i,
  ];
  const conflates = (s: string) => CONFLATION_PATTERNS.some((re) => re.test(prose(s)));

  const COMMENTED: Array<[string, string]> = [
    ["missionExecution.ts", execution],
    ["missionExecutionModeService.ts", modeService],
    ["api-server/src/index.ts", bootIndex],
    ["missionDriver.ts", driver],
    // Added after the conflation was found surviving here — including as a test
    // NAME, which is copy a reader trusts more than a comment, not less.
    [
      "missionExecutionRoute.test.ts",
      read("artifacts/api-server/src/routes/__qa__/missionExecutionRoute.test.ts"),
    ],
    ["routes/profitMissions.ts", read("artifacts/api-server/src/routes/profitMissions.ts")],
  ];

  for (const [name, src] of COMMENTED) {
    it(`${name} does not claim paper/demo run the SAME gate chain`, () => {
      expect(conflates(src), `${name} conflates the mode chains`).toBe(false);
    });
  }

  // The guard must be able to FAIL on the exact strings that slipped past the
  // first version, INCLUDING the ones that only exist as wrapped fragments.
  it("the conflation pattern actually matches the variants that slipped through", () => {
    const knownBad = [
      "//        SAME gate chain and dispatches onto the SIMULATED recorder seam",
      "// (59) DEMO / PAPER missions never touch the live broker: the SAME gate chain",
      'test("59: demo/paper dispatch runs the same gates but never touches the live broker"',
      "a non-live mission runs the SAME gate chain",
      "paper/demo run the SAME gate chain",
      // the wrap that defeated the line-based version
      "//   (59) DEMO/PAPER never touches the live broker — a non-live mission runs the\n//        SAME gate chain and dispatches onto the SIMULATED recorder seam",
    ];
    const missed = knownBad.filter((s) => !conflates(s));
    expect(missed).toEqual([]);
  });

  it("the conflation pattern does not fire on the corrected, qualified phrasing", () => {
    const knownGood = [
      "// runs the MISSION-LAYER gates (probation, mission gate, Phase 7, single-flight)",
      "// BOTH modes run the MISSION-LAYER chain; ONLY `live` then calls `executor`",
      "the 23 gates are NOT evaluated for it",
    ];
    const falsePositives = knownGood.filter((s) => conflates(s));
    expect(falsePositives).toEqual([]);
  });

  it("missionExecution names the mission-layer chain vs the live-only chain", () => {
    const p = prose(execution);
    expect(p).toMatch(/a non-live mission runs the MISSION-LAYER chain/);
    expect(p).toMatch(/ONLY `live` then reaches the live command pipeline/);
    expect(p).toMatch(/NONE of those run for paper\/demo/);
  });

  // A comment that names a function is only useful if a reader can grep it. The
  // first draft of this comment named `recordMissionDraftClose`, which exists
  // nowhere in the repo — an invented identifier, in the file whose purpose is
  // deleting invented claims. Pin the real symbols to their real home.
  it("the no-result explanation names functions that actually exist", () => {
    const exitManager = read("artifacts/api-server/src/lib/missionExitManager.ts");
    const pipeline = read("artifacts/api-server/src/lib/live/liveCommandPipeline.ts");

    expect(execution).not.toMatch(/recordMissionDraftClose/);

    for (const fn of ["recordMissionTradeClose", "recordMissionTradeCloseByBrokerTicket"]) {
      expect(execution, `comment must name ${fn}`).toMatch(new RegExp(`\\b${fn}\\b`));
      expect(exitManager, `${fn} must be exported where the comment says`).toMatch(
        new RegExp(`export async function ${fn}\\b`),
      );
    }
    // ...and the live fill/close path really is the caller the comment claims.
    expect(pipeline).toMatch(/recordMissionTradeCloseByBrokerTicket/);
  });

  it("missionExecution states the consequence at the simulated seam, on BOTH books", () => {
    // The seam no longer only records intent: `simulateMissionFill` is the
    // default, so the comment must say what stays NULL (the broker columns) AND
    // what is produced (the sim_* series) — the old "no result at all" wording
    // became false the moment the simulator was wired.
    const p = prose(execution);
    expect(p).toMatch(
      /produces NO broker-reconciled result and NO live protective-exit management/,
    );
    expect(p).toMatch(/columns `pnl` \/ `closedAt` stay NULL forever/);
    expect(p).toMatch(/SIMULATED fill priced from a real router quote/);
    expect(p).toMatch(/never summed with the broker series/);
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

  it("#20's coverage of driver-placed entries is stated as CLOSED, not as a gap", () => {
    // fix/gate-binding closed the hole this used to pin open: a driver-placed
    // entry is now classified SYSTEM by autonomyProvenance and IS bound by #20.
    // The contract must describe the closure and the consequence, and must no
    // longer carry the old KNOWN GAP text.
    const f = flat(gateContract);
    expect(f).not.toMatch(/KNOWN GAP/);
    expect(f).toMatch(/Profit-Mission driver/);
    expect(f).toMatch(/stamped SYSTEM and IS bound\s+by #20/);
    expect(f).toMatch(/tighten-only/);
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

  it("it says a paper/demo mission DOES produce simulated fills and P/L, on a simulated basis", () => {
    // These replace the pre-simulator claims ("produces no fill, no profit or
    // loss", "cannot progress or complete", "a record of intent, not a
    // simulated account"). The fill simulator falsified every one of them:
    // simulateMissionFill prices an entry from the real quote, the exit sweep
    // closes it against later real quotes, and missionExitManager moves
    // currentValue and completes the mission on a SIMULATED basis. The page must
    // now say so — and must NOT carry the old denial back.
    expect(renderedFlat).toMatch(/prices a SIMULATED fill from the real live quote/i);
    expect(renderedFlat).toMatch(
      /moves this mission's value, progress and completion on a SIMULATED basis/i,
    );
    expect(renderedFlat).toMatch(/never added to broker-reconciled money/i);
    expect(renderedFlat).not.toMatch(/cannot produce a result and cannot complete its target/i);
    expect(renderedFlat).not.toMatch(/produces no fill, no profit or loss/i);
    expect(renderedFlat).not.toMatch(/a record of intent, not a simulated account/i);
  });

  it("it says the live exit manager does not manage a simulated position, and names what does", () => {
    expect(renderedFlat).toMatch(/opens a SIMULATED position only, so this exit manager finds nothing/i);
    expect(renderedFlat).toMatch(/simulated exit sweep, against later real quotes/i);
    expect(renderedFlat).not.toMatch(/never opens a position/i);
  });

  it("the ladder copy states the real road — simulated evidence earns level 3, never live", () => {
    expect(renderedFlat).toMatch(/build a track record of SIMULATED closed results/i);
    expect(renderedFlat).toMatch(/the demo-performance promotion gate reads/i);
    expect(renderedFlat).toMatch(/capped at level 3/i);
    expect(renderedFlat).not.toMatch(/because paper and demo produce no realised trades/i);
  });

  it("realised figures name which books they came from, and never blend them", () => {
    // fix/demo-ladder gave paper/demo real (simulated) outcomes, so "live-only"
    // stopped being true. The figure must now state its basis on both sides and
    // say the two are never added together.
    expect(renderedFlat).toMatch(/broker-confirmed closed trades only/i);
    expect(renderedFlat).toMatch(/simulated fills, priced from real\s+quotes/i);
    expect(renderedFlat).toMatch(/never added together/i);
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

  it("level 3 says it produces SIMULATED fills and that demo execution is not yet available", () => {
    const f = flat(automation);
    expect(f).toMatch(/Demo auto \(simulated fills\)/);
    expect(f).toMatch(/No broker account is contacted — not a live one and not a demo one/);
    expect(f).toMatch(
      /Auto-execution against a real demo broker account is NOT YET AVAILABLE/,
    );
    // ...and it must not go back to claiming the level produces nothing.
    expect(codeOnly(automation)).not.toMatch(/records intent only/);
    expect(codeOnly(automation)).not.toMatch(/no profit, loss or result is produced/);
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
      expect(src, rel).toMatch(/3: "Demo auto \(simulated fills\)"/);
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
