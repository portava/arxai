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

test("an unrecognised origin literal is treated as ABSENT — no autonomy is invented", () => {
  assert.equal(isLiveAutonomousOrigin("SOMETHING_ELSE"), false);
  assert.equal(classifyDraftActorType({ autonomousOrigin: "SOMETHING_ELSE" }), "USER");
  assert.equal(classifyDraftActorType({ autonomousOrigin: "" }), "USER");
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

test("SOURCE PIN: missionExecution maps driverOriginated → MISSION_DRIVER on the intent", () => {
  const src = read("../missionExecution.ts");
  assert.match(src, /args\.driverOriginated\s*===\s*true\s*\?\s*"MISSION_DRIVER"/);
  assert.match(src, /autonomousOrigin,/, "the intent must carry the origin");
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
