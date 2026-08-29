// ── DEFECT 3 — mission-driver orders must NOT be self-exempt from #20/#23 ────
//
// The bug: `liveCommandPipeline.createLiveDraft` classified a draft as the
// SELF_TRADE_AGENT actor only when a `selfTradeAgentId` was present, and the
// mission intent carries none. A DRIVER-PLACED live order — unattended, no
// human press anywhere in the chain — was therefore stamped "USER" and the two
// autonomy gates stood down: #20 STRATEGY_NOT_LIVE_PROMOTED and #23
// EDGE_CAPACITY_EXCEEDED both exempt human actors by design, so an autonomous
// entry was being admitted on the HUMAN exemption while
// livePhaseBDispatchGate's own contract said autonomous entries require a
// promoted edge.
//
// What is pinned here:
//   1. The pure origin classifier: driver origin → SYSTEM, agent id →
//      SELF_TRADE_AGENT, nothing → USER. Tighten-only (never SYSTEM → USER).
//   2. `edgePromotionRequiredForActor` binds SYSTEM, so a driver-placed entry
//      is REQUIRED to carry a promoted edge, and #20/#23 then REFUSE without
//      promotion / without a capacity estimate.
//   3. A user-PRESSED mission trade is unaffected: USER actor, both gates
//      exempt, dispatch unchanged.
//   4. The provenance chain is actually wired end to end — driver →
//      dispatchApprovedDraft → instant-trade intent → createLiveDraft →
//      actor_type — so the classification cannot be silently dropped in the
//      middle by a future edit.
//
// Offline/pure: no DB, no network. Source pins read the files as text (the
// live wiring cannot be exercised without a database, so it is pinned
// structurally in the same spirit as the repo's other chain guards).
//
// Run: pnpm --filter @workspace/api-server run test:mission-autonomy-gates
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, rel), "utf8");

const {
  classifyDraftActorType,
  isAutonomouslyOriginated,
  isLiveAutonomousOrigin,
  LIVE_AUTONOMOUS_ORIGINS,
  AUTONOMOUS_ENTRY_REFUSAL_NOTE,
} = await import("@workspace/domain/safety-contracts/autonomyProvenance");
const { evaluateEdgePromotionGate, evaluateEdgeCapacityGate } =
  await import("@workspace/domain/safety-contracts/foundationGates");
const { edgePromotionRequiredForActor } = await import("../live/foundationGateInputs.js");
const { buildMissionEntryIntent } = await import("../missionExecution.js");

// ── 1. The pure origin classifier ───────────────────────────────────────────

test("driver-originated draft classifies as SYSTEM (autonomous), not USER", () => {
  assert.equal(classifyDraftActorType({ autonomousOrigin: "MISSION_DRIVER" }), "SYSTEM");
  assert.equal(isAutonomouslyOriginated({ autonomousOrigin: "MISSION_DRIVER" }), true);
});

test("a user-pressed mission trade stays a human actor", () => {
  assert.equal(classifyDraftActorType({}), "USER");
  assert.equal(classifyDraftActorType({ autonomousOrigin: null }), "USER");
  assert.equal(isAutonomouslyOriginated({}), false);
});

test("a self-trade agent id still classifies as SELF_TRADE_AGENT (unchanged)", () => {
  assert.equal(classifyDraftActorType({ selfTradeAgentId: 7 }), "SELF_TRADE_AGENT");
  // Both classes are autonomous, so precedence cannot loosen anything.
  assert.equal(
    isAutonomouslyOriginated({ selfTradeAgentId: 7, autonomousOrigin: "MISSION_DRIVER" }),
    true,
  );
});

test("an UNREADABLE origin literal FAILS CLOSED to SYSTEM — never to the human exemption", () => {
  // Review fix: the classifier used to downgrade an origin literal it did not
  // recognise to "USER", i.e. to the actor that is EXEMPT from #20/#23. An
  // autonomy claim that cannot be read is unreadable safety state, and
  // CLAUDE.md §1 says fail closed on that — so it resolves to the gate-BOUND
  // actor. Recognition still matters for audit labelling, not for the verdict.
  assert.equal(isLiveAutonomousOrigin("SOMETHING_ELSE"), false);
  assert.equal(classifyDraftActorType({ autonomousOrigin: "SOMETHING_ELSE" }), "SYSTEM");
  assert.equal(isAutonomouslyOriginated({ autonomousOrigin: "SOMETHING_ELSE" }), true);
  assert.equal(
    edgePromotionRequiredForActor(classifyDraftActorType({ autonomousOrigin: "SOMETHING_ELSE" })),
    true,
    "an unreadable claim must still BIND the autonomy gates",
  );
  // Absence is absence: no claim was made, so the human default stands.
  assert.equal(classifyDraftActorType({ autonomousOrigin: "" }), "USER");
  assert.equal(classifyDraftActorType({ autonomousOrigin: "   " }), "USER");
  assert.equal(classifyDraftActorType({ autonomousOrigin: null }), "USER");
  for (const origin of LIVE_AUTONOMOUS_ORIGINS) {
    assert.equal(classifyDraftActorType({ autonomousOrigin: origin }), "SYSTEM", origin);
  }
});

// ── 2. #20 / #23 BIND on a driver-placed entry ──────────────────────────────

test("edgePromotionRequiredForActor binds the SYSTEM actor the driver now produces", () => {
  const actor = classifyDraftActorType({ autonomousOrigin: "MISSION_DRIVER" });
  assert.equal(edgePromotionRequiredForActor(actor), true);
  assert.equal(edgePromotionRequiredForActor("USER"), false);
});

test("#20 REFUSES a driver-placed entry with no promoted edge", () => {
  const required = edgePromotionRequiredForActor(
    classifyDraftActorType({ autonomousOrigin: "MISSION_DRIVER" }),
  );
  const verdict = evaluateEdgePromotionGate(true, {
    required,
    edgeRefPresent: false,
    edgeStatus: null,
    edgeLiveAllowed: false,
    edgeEvidenceValid: false,
  });
  assert.equal(verdict.passed, false);
  assert.match(String(verdict.detail), /Autonomous entry/i);
});

test("#23 REFUSES a driver-placed entry with no recorded capacity estimate", () => {
  const required = edgePromotionRequiredForActor(
    classifyDraftActorType({ autonomousOrigin: "MISSION_DRIVER" }),
  );
  const verdict = evaluateEdgeCapacityGate(true, {
    required,
    edgeRefPresent: false,
    capacityStatus: null,
    capacityDeployableUsd: null,
    capacityCapOverrideUsd: null,
    deployedUsd: null,
    candidateUsd: 1_000,
  });
  assert.equal(verdict.passed, false);
});

test("the SAME setup pressed by a human is exempt from #20 and #23 (unchanged)", () => {
  const required = edgePromotionRequiredForActor(classifyDraftActorType({}));
  assert.equal(required, false);
  assert.equal(
    evaluateEdgePromotionGate(true, {
      required,
      edgeRefPresent: false,
      edgeStatus: null,
      edgeLiveAllowed: false,
      edgeEvidenceValid: false,
    }).passed,
    true,
  );
  assert.equal(
    evaluateEdgeCapacityGate(true, {
      // A human manual click with NO edge reference has no edge to govern.
      required: required || false,
      edgeRefPresent: false,
      capacityStatus: null,
      capacityDeployableUsd: null,
      capacityCapOverrideUsd: null,
      deployedUsd: null,
      candidateUsd: 1_000,
    }).passed,
    true,
  );
});

test("the refusal reason is documented in owner-readable terms", () => {
  assert.match(AUTONOMOUS_ENTRY_REFUSAL_NOTE, /no human press/i);
  assert.match(AUTONOMOUS_ENTRY_REFUSAL_NOTE, /STRATEGY_NOT_LIVE_PROMOTED/);
  assert.match(AUTONOMOUS_ENTRY_REFUSAL_NOTE, /EDGE_CAPACITY_EXCEEDED/);
});

// ── 3. The provenance chain is wired end to end ─────────────────────────────

test("SOURCE PIN: the mission driver stamps driverOriginated on its own dispatch", () => {
  const src = read("../missionDriver.ts");
  assert.match(src, /driverOriginated:\s*true/, "driver must declare its unattended origin");
});

test("the mission ENTRY intent itself carries the driver's origin (behavioural, not a text match)", () => {
  // Review fix: this hop used to be pinned by `assert.match(src,
  // /autonomousOrigin,/)`, which an UNRELATED journal-metadata line in the same
  // file satisfied — deleting the property from the intent left the suite green
  // on a compiling tree and restored the whole original defect. The intent is
  // now built by a pure exported function, so the property is asserted by
  // CALLING it: remove it and this goes red.
  const driverIntent = buildMissionEntryIntent({
    missionId: 5,
    direction: "BUY",
    symbol: "EURUSD",
    lot: 0.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    driverOriginated: true,
  });
  assert.equal(driverIntent.autonomousOrigin, "MISSION_DRIVER");
  // …and the origin on THAT object is what makes the gates bind.
  const actor = classifyDraftActorType({ autonomousOrigin: driverIntent.autonomousOrigin });
  assert.equal(actor, "SYSTEM");
  assert.equal(edgePromotionRequiredForActor(actor), true);
  assert.equal(
    evaluateEdgePromotionGate(true, {
      required: edgePromotionRequiredForActor(actor),
      edgeRefPresent: false,
      edgeStatus: null,
      edgeLiveAllowed: false,
      edgeEvidenceValid: false,
    }).passed,
    false,
    "a driver entry built by the real builder must REFUSE without a promoted edge",
  );
});

test("a user-pressed mission trade builds an intent with NO origin (unchanged human path)", () => {
  const pressed = buildMissionEntryIntent({
    missionId: 5,
    direction: "SELL",
    symbol: "EURUSD",
    lot: 0.1,
    stopLoss: 1.12,
    takeProfit: 1.09,
  });
  assert.equal(pressed.autonomousOrigin, null);
  const actor = classifyDraftActorType({ autonomousOrigin: pressed.autonomousOrigin });
  assert.equal(actor, "USER");
  assert.equal(edgePromotionRequiredForActor(actor), false);
});

test("SOURCE PIN: the dispatcher feeds its OWN driverOriginated flag into that builder", () => {
  const src = read("../missionExecution.ts");
  // The one hop the unit test above cannot see: the real dispatcher calling the
  // builder with the flag it was handed (rather than dropping it on the floor).
  assert.match(
    src,
    /buildMissionEntryIntent\(\{[\s\S]{0,400}?driverOriginated:\s*args\.driverOriginated/,
    "dispatchApprovedDraft must pass its driverOriginated flag into the intent builder",
  );
  assert.match(src, /args\.driverOriginated\s*===\s*true\s*\?\s*"MISSION_DRIVER"/);
});

test("SOURCE PIN: instantTrade forwards the origin into createLiveDraft", () => {
  const src = read("../live/instantTrade.ts");
  assert.match(src, /autonomousOrigin:\s*intent\.autonomousOrigin\s*\?\?\s*null/);
});

test("SOURCE PIN: createLiveDraft classifies actor_type from the origin, not from an agent id alone", () => {
  const src = read("../live/liveCommandPipeline.ts");
  assert.match(src, /classifyDraftActorType\(\{/, "the pipeline must use the shared classifier");
  assert.match(src, /autonomousOrigin:\s*input\.autonomousOrigin/);
  // The defective ternary must be gone: it is exactly what exempted the driver.
  assert.equal(
    /input\.selfTradeAgentId\s*!=\s*null\s*\?\s*"SELF_TRADE_AGENT"\s*:\s*"USER"/.test(src),
    false,
    "the agent-id-only actorType ternary must not return",
  );
});

test("SOURCE PIN: the gate contract header states the driver case explicitly", () => {
  const src = readFileSync(
    path.join(here, "../../../../../lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts"),
    "utf8",
  );
  assert.match(src, /mission driver/i);
  assert.match(src, /SELF_TRADE_AGENT or SYSTEM/);
});

// ── 4. An unattended EXIT is recorded as the machine action it is ────────────
//
// Review fix: `createLiveOpsDraft` hard-coded `actorType: "USER"` for every
// CLOSE / MODIFY, so the driver's protective exits were stamped as commands the
// owner pressed. That is not a gate hole (#20/#23 exempt close/modify by
// design) but it is an audit lie, and at the management-authority arbiter it
// made a machine exit contend with a real owner command at EQUAL rank instead
// of losing to it.

test("the ops-draft classifier maps a driver exit to SYSTEM and a human exit to USER", () => {
  assert.equal(classifyDraftActorType({ autonomousOrigin: "MISSION_DRIVER" }), "SYSTEM");
  assert.equal(classifyDraftActorType({ autonomousOrigin: null }), "USER");
});

test("a driver exit ranks BELOW a genuine owner command, not beside it", async () => {
  const { claimSourceFromActorType, arbitrateManagementAuthority } =
    await import("@workspace/domain/live-position");
  assert.equal(claimSourceFromActorType("SYSTEM"), "AUTOMATED_STRATEGY");
  assert.equal(claimSourceFromActorType("USER"), "USER_COMMAND");

  // Same instant, same non-risk-reducing kind (a target adjustment): the owner
  // must win. Under the old "USER" stamp both claims were USER_COMMAND and the
  // winner was decided by arrival order instead.
  const at = "2026-08-29T12:00:00.000Z";
  const decision = arbitrateManagementAuthority(
    {
      commandId: "lvcmd_driver",
      source: claimSourceFromActorType("SYSTEM"),
      actorUserId: 11,
      isRiskReducing: false,
      claimedAt: at,
    },
    {
      commandId: "lvcmd_owner",
      source: claimSourceFromActorType("USER"),
      actorUserId: 11,
      isRiskReducing: false,
      claimedAt: at,
    },
    11,
  );
  assert.equal(decision.winner, "B");
  assert.equal(decision.rule, "HUMAN_DOMINANCE");
});

test("SOURCE PIN: createLiveOpsDraft classifies the actor instead of hard-coding USER", () => {
  const src = read("../live/liveCommandPipeline.ts");
  assert.equal(
    /actorType:\s*"USER",/.test(src),
    false,
    "no live command may hard-code a human actor for an ops draft",
  );
  assert.match(src, /opsActorType[\s\S]{0,200}?classifyDraftActorType\(\{/);
  assert.match(src, /actorType:\s*opsIntegrity\.actorType/);
});

test("SOURCE PIN: the driver declares its origin on the EXIT tick too", () => {
  const driver = read("../missionDriver.ts");
  // Scoped to the EXIT call: the ENTRY dispatch in the same file also declares
  // the flag, and a pin that either line satisfies would not notice the exit
  // losing its origin — the precise failure mode this review is fixing.
  assert.match(
    driver,
    /exitManager\(\s*\{[\s\S]{0,800}?driverOriginated:\s*true/,
    "the driver's EXIT tick must declare its unattended origin",
  );
  const exitMgr = read("../missionExitManager.ts");
  // The exit intents must carry the origin through to the ops draft.
  assert.match(exitMgr, /args\.driverOriginated\s*===\s*true\s*\?\s*"MISSION_DRIVER"/);
  const instant = read("../live/instantTrade.ts");
  assert.match(instant, /autonomousOrigin:\s*intent\.autonomousOrigin\s*\?\?\s*null/);
  assert.match(instant, /autonomousOrigin:\s*args\.autonomousOrigin\s*\?\?\s*null/);
});
