// Mutation proofs for check-protective-action-path: the unmodified tree passes
// and every assertion fires when its source is weakened in the way it guards
// against. Pure, no IO beyond reading the real files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./_lib.js";
import {
  PROTECTIVE_FILES,
  checkProtectiveActionPath,
  scanProtectiveSources,
  type Sources,
} from "./check-protective-action-path.js";

const real: Sources = {};
for (const key of Object.values(PROTECTIVE_FILES)) real[key] = readFileSync(join(ROOT, key), "utf8");

let n = 0;
function mutate(file: string, from: string | RegExp, to: string, expect: RegExp) {
  n++;
  const before = real[file]!;
  const after = before.replace(from, to);
  assert.notEqual(after, before, `mutation did not apply to ${file}: ${from}`);
  const v = scanProtectiveSources({ ...real, [file]: after });
  assert.ok(v.some((x) => expect.test(x)), `expected ${expect} for ${file} mutation ${from}; got ${JSON.stringify(v)}`);
}

// Baseline: the real tree is clean, through both entry points.
n++;
assert.deepEqual(scanProtectiveSources(real), []);
n++;
const whole = checkProtectiveActionPath();
assert.equal(whole.ok, true, JSON.stringify(whole.violations));

// 1. Manager: the candidate is queued from the hold, after the hold is counted,
//    the hold block ends with continue, the drain runs after the loop, and the
//    ordinary 90 s rule keeps its default window.
mutate(PROTECTIVE_FILES.manager, "      queueProtectiveCandidate(protectiveCycle, {", "      enqueueSomewhere(protectiveCycle, {", /must queue the protective candidate/);
mutate(PROTECTIVE_FILES.manager, /result\.heldReasons\[observation\.reason\]/g, "result.heldCounts[observation.reason]", /must still count/);
mutate(PROTECTIVE_FILES.manager, "const observation = evaluatePositionObservation({\n      lastSyncedAt: pos.lastSyncedAt,", "const observation = evaluatePositionObservation({\n      maxAgeMs: 30 * 60_000,\n      lastSyncedAt: pos.lastSyncedAt,", /must not carry its own maxAgeMs/);
// The queue moved before the hold is counted.
n++;
{
  const src = real[PROTECTIVE_FILES.manager]!;
  const moved = src
    .replace("    if (!observation.ok) {\n      result.held++;", "    if (!observation.ok) {\n      queueProtectiveCandidate(protectiveCycle, null as never);\n      result.held++;")
    .replace("      queueProtectiveCandidate(protectiveCycle, {", "      enqueueSomewhere(protectiveCycle, {");
  assert.notEqual(moved, src);
  const v = scanProtectiveSources({ ...real, [PROTECTIVE_FILES.manager]: moved });
  assert.ok(v.some((x) => /after the hold is counted/.test(x)), JSON.stringify(v));
}
// Removing the continue that ends the hold branch (the refused observation
// would fall through to the ordinary decision); a later continue elsewhere in
// the loop no longer satisfies the guard.
mutate(PROTECTIVE_FILES.manager, "      result.protective.queued++;\n      continue;\n    }", "      result.protective.queued++;\n    }", /hold block must end with continue/);
// Calling the path inline again (a stuck position delays later exits).
mutate(PROTECTIVE_FILES.manager, "      result.protective.queued++;\n      continue;", "      result.protective.queued++;\n      await runProtectiveActionPath(null as never);\n      continue;", /must not call runProtectiveActionPath\( inline/);
// The standalone drain moved inside the loop, or dropped.
mutate(PROTECTIVE_FILES.manager, "    const drained = await drainProtectiveCycle(protectiveCycle);", "    const drained = { considered: 0, acted: 0, waitedMs: 0, held: {} };", /drainProtectiveCycle\( after the per-execution loop/);
mutate(PROTECTIVE_FILES.manager, "      result.protective.queued++;\n      continue;", "      result.protective.queued++;\n      await drainProtectiveCycle(protectiveCycle);\n      continue;", /drainProtectiveCycle\( after the per-execution loop/);

// 2. Path: import discipline, rule id and source order.
mutate(PROTECTIVE_FILES.path, 'import { livePositionLedger, type LivePositionRow } from "../positions/ledger.js";', 'import { livePositionLedger, livePositionWriter, type LivePositionRow } from "../positions/ledger.js";', /livePositionWriter/);
mutate(PROTECTIVE_FILES.path, 'import { logger } from "../logger.js";', 'import { logger } from "../logger.js";\nimport { createLiveOpsDraft } from "../live/liveCommandPipeline.js";', /liveCommandPipeline/);
mutate(PROTECTIVE_FILES.path, 'import { logger } from "../logger.js";', 'import { logger } from "../logger.js";\nimport { submitTrade } from "../tradeEngine/pipeline.js";', /tradeEngine/);
mutate(PROTECTIVE_FILES.path, 'import { logger } from "../logger.js";', 'import { logger } from "../logger.js";\nimport { sendManagementTarget } from "../mt5/managementTargetTransport.js";', /managementTargetTransport/);
mutate(PROTECTIVE_FILES.path, 'import { logger } from "../logger.js";', 'import { logger } from "../logger.js";\nimport { mt5CommandsTable } from "@workspace/db";', /mt5CommandsTable/);
mutate(PROTECTIVE_FILES.path, 'import { logger } from "../logger.js";', 'import { logger } from "../logger.js";\nimport http from "node:http";', /node:http/);
mutate(PROTECTIVE_FILES.path, 'import { logger } from "../logger.js";', 'import { logger } from "../logger.js";\nimport { executeInstant } from "../live/instantTrade.js";', /instantTrade/);
mutate(PROTECTIVE_FILES.path, 'import { logger } from "../logger.js";', 'import { logger } from "../logger.js";\nimport { arxLiveCommandsTable } from "@workspace/db";', /arxLiveCommandsTable/);
// A dynamic import( is scanned like a static one; a computed specifier is refused.
mutate(PROTECTIVE_FILES.path, "const startedAt = now();", 'const startedAt = now(); const pipeline = await import("../live/liveCommandPipeline.js");', /dynamically imports "\.\.\/live\/liveCommandPipeline\.js"/);
mutate(PROTECTIVE_FILES.path, "const startedAt = now();", "const startedAt = now(); await import(`../live/${'instantTrade'}.js`);", /computed specifier/);
mutate(PROTECTIVE_FILES.path, "const startedAt = now();", 'const startedAt = now(); const mod = "../live/instantTrade.js"; await import(mod);', /computed specifier/);
mutate(PROTECTIVE_FILES.path, "const startedAt = now();", 'const startedAt = now(); await fetch("https://example.invalid");', /fetch/);
mutate(PROTECTIVE_FILES.path, "reason: `${verdict.reason} (protective path:", 'ruleId: "mission-exit",\n      reason: `${verdict.reason} (protective path:', /acts under rule "mission-exit"/);
// Geometry proven after the claim (or not at all) is refused.
mutate(PROTECTIVE_FILES.path, "const geometry = evaluateProtectiveGeometry(facts, intent);\n    if (!geometry.ok) return hold(geometry.reason, geometry.detail);", "const geometry = { ok: true } as const;", /must evaluate evidence, verify identity, prove geometry/);
n++;
{
  const src = real[PROTECTIVE_FILES.path]!;
  const swapped = src
    .replace("const geometry = evaluateProtectiveGeometry(facts, intent);\n    if (!geometry.ok) return hold(geometry.reason, geometry.detail);", "")
    .replace("const claimMs = performance.now() - claimStart;", "const claimMs = performance.now() - claimStart;\n    const geometry = evaluateProtectiveGeometry(facts, intent);\n    if (!geometry.ok) return hold(geometry.reason, geometry.detail);");
  assert.notEqual(swapped, src);
  const v = scanProtectiveSources({ ...real, [PROTECTIVE_FILES.path]: swapped });
  assert.ok(v.some((x) => /order must be evidence/.test(x)), JSON.stringify(v));
}

// Every refusal keeps its exact shape: deleted or weakened refusals are caught.
mutate(PROTECTIVE_FILES.path, "    if (!identity.ok) return hold(identity.reason, identity.detail);\n", "", /identity \(verifyProtectivePosition\) result "identity" must be refused/);
mutate(PROTECTIVE_FILES.path, "if (!identity.ok) return hold(", "if (!identity.ok && false) return hold(", /identity \(verifyProtectivePosition\) result "identity" must be refused/);
mutate(PROTECTIVE_FILES.path, "if (!geometry.ok) return hold(", "if (!geometry.ok || geometry.reason === undefined) return hold(", /geometry \(evaluateProtectiveGeometry\) result "geometry" must be refused/);
mutate(PROTECTIVE_FILES.path, "    if (!v.ok) return hold(noEvidence(v.reason), noEvidenceDetail(v.detail));\n", "", /evidence \(evaluateProtectiveObservation\) result "v" must be refused/);
mutate(PROTECTIVE_FILES.path, "if (!v.ok) return hold(noEvidence", "if (!v.ok && v.ok) return hold(noEvidence", /evidence \(evaluateProtectiveObservation\) result "v" must be refused/);
// `if (v.ok || true) break;` in the wait loop only ends the wait early: the
// evidence refusal after the loop (pinned above) still holds a non-ok verdict,
// so that mutation cannot reach the claim and is not a guard violation.
n++;
{
  const src = real[PROTECTIVE_FILES.path]!;
  const early = src.replace("if (v.ok) break;", "if (v.ok || true) break;");
  assert.notEqual(early, src);
  assert.match(early, /if \(!v\.ok\) return hold\(noEvidence/);
  assert.deepEqual(scanProtectiveSources({ ...real, [PROTECTIVE_FILES.path]: early }), []);
}
mutate(PROTECTIVE_FILES.path, "    if (!bridgeCheck.ok)\n", "    if (!bridgeCheck.ok || true)\n", /bridge \(verifyProtectiveBridge\) result "bridgeCheck" must be refused/);
mutate(PROTECTIVE_FILES.path, "    if (!bridgeFinal.ok)\n      return hold(", "    if (!bridgeFinal.ok)\n      logger.warn(", /bridge \(verifyProtectiveBridge\) result "bridgeFinal" must be refused/);
// The final bridge re-verification removed (only the pre-wait check left).
mutate(PROTECTIVE_FILES.path, /    const bridgeFinal = verifyProtectiveBridge\(entry, e, conn, finalHeartbeat\);\n    if \(!bridgeFinal\.ok\)\n      return hold\([^\n]*\n/, "", /verified before the wait and again on the final connection record/);
// The drain stops running candidates through the path.
mutate(PROTECTIVE_FILES.path, "const r = await runProtectiveActionPath({ ...c.ctx, sharedDeadline: shared }, c.deps);", 'const r = { status: "NOT_PROTECTIVE" } as ProtectivePathResult;', /drainProtectiveCycle must run each queued candidate/);

// 3. Final-claim parity.
mutate(PROTECTIVE_FILES.target, ".pendingManagement?.protective;", ".pendingManagement?.commandId;", /must re-check a protective claim/);
mutate(PROTECTIVE_FILES.target, "if (!evidence.ok) refuse(evidence.reason);", "", /must refuse on failed evidence/);
mutate(PROTECTIVE_FILES.target, "if (!geometry.ok) refuse(geometry.reason);", "", /must refuse on failed evidence/);
mutate(PROTECTIVE_FILES.target, "const geometry = doesNotLoosenStop(", "const geometry = alwaysOk(", /doesNotLoosenStop/);
mutate(PROTECTIVE_FILES.target, "if (!ordered.ok) refuse(ordered.reason);", "", /refuse a ticket command in flight or after the evidence/);
mutate(PROTECTIVE_FILES.target, "if (!ordered.ok) refuse(ordered.reason);", "if (!ordered.ok && false) refuse(ordered.reason);", /refuse a ticket command in flight or after the evidence/);

// 4. Only the path constructs protective claims.
n++;
{
  const v = scanProtectiveSources({
    ...real,
    "artifacts/api-server/src/lib/selfTrade/someOtherModule.ts": 'const claimed = { ...memory, pendingManagement: { claimId, action, protective: { trigger: "EXIT_INVALIDATION" } } };',
  });
  assert.ok(v.some((x) => /constructs a protective claim/.test(x)), JSON.stringify(v));
}
n++;
assert.deepEqual(
  scanProtectiveSources({ ...real, "artifacts/api-server/src/lib/selfTrade/__qa__/fixture.test.ts": "pendingManagement: { protective: {} }" }).filter((x) => /constructs/.test(x)),
  [],
  "a QA fixture outside the runtime scan is not a constructor",
);

// 5. The 90 s window stays the only window.
mutate(PROTECTIVE_FILES.freshFacts, "export const POSITION_OBSERVATION_MAX_AGE_MS = 90_000;", "export const POSITION_OBSERVATION_MAX_AGE_MS = 120_000;", /must stay the existing 90_000/);
mutate(PROTECTIVE_FILES.freshFacts, "const maxAgeMs = input.maxAgeMs ?? POSITION_OBSERVATION_MAX_AGE_MS;\n  const row = input.row;", "const maxAgeMs = 30_000;\n  const row = input.row;", /literal window/);

// 6. Domain purity.
mutate(PROTECTIVE_FILES.domain, 'import type { PositionManagementVerdict } from "./positionManagement.js";', 'import type { PositionManagementVerdict } from "./positionManagement.js";\nimport { classifyHeartbeatAt } from "../broker-health/heartbeatPolicy.js";', /imports only from/);

// 7. Management never runs under an AACI pause.
mutate(PROTECTIVE_FILES.cycle, "if (!chain.shouldPauseManagement) {\n        const managed = await manageAgentPositions(bundle.agent, actorUserId, actorRole, {\n          protectiveCycle,\n        });", "const managed = await manageAgentPositions(bundle.agent, actorUserId, actorRole, {\n          protectiveCycle,\n        });\n      if (!chain.shouldPauseManagement) {", /outside the !chain.shouldPauseManagement block/);
mutate(PROTECTIVE_FILES.cycle, "if (!chain.shouldPauseManagement) {", "if (chain.shouldPauseManagement === false) {", /block is missing/);
// Each agent's manager drains (and waits) on its own again.
mutate(PROTECTIVE_FILES.cycle, "await manageAgentPositions(bundle.agent, actorUserId, actorRole, {\n          protectiveCycle,\n        });", "await manageAgentPositions(bundle.agent, actorUserId, actorRole);", /must receive the cycle's protectiveCycle/);
mutate(PROTECTIVE_FILES.cycle, "    const drained = await drainProtectiveCycle(protectiveCycle);", "    const drained = { considered: 0, acted: 0, bridges: 0, elapsedMs: 0, held: {} };", /drainProtectiveCycle\( must run exactly once, after the per-agent loop/);
mutate(PROTECTIVE_FILES.cycle, "      // 4. Post realized P/L", "      await drainProtectiveCycle(protectiveCycle);\n      // 4. Post realized P/L", /drainProtectiveCycle\( must run exactly once, after the per-agent loop/);

// 8. Registration parity: dropping either registration is a violation.
mutate(PROTECTIVE_FILES.rules, '      "lib/selfTrade/livePositionManager.ts",\n      "lib/selfTrade/protectiveActionPath.ts",\n', '      "lib/selfTrade/livePositionManager.ts",\n', /"self-trade-manage"\.modules must list/);
mutate(PROTECTIVE_FILES.rules, 'id: "self-trade-manage",', 'id: "self-trade-manage-v2",', /"self-trade-manage" rule is missing/);
mutate(PROTECTIVE_FILES.killSwitch, '  "lib/selfTrade/protectiveActionPath.ts": "MANAGEMENT",\n', "", /SELF_TRADE_PRODUCERS must classify/);
mutate(PROTECTIVE_FILES.killSwitch, '  "lib/selfTrade/protectiveActionPath.ts": "MANAGEMENT",', '  "lib/selfTrade/protectiveActionPath.ts": "PASS_THROUGH",', /SELF_TRADE_PRODUCERS must classify/);

// Missing files are violations, not silent passes.
n++;
assert.ok(scanProtectiveSources({ ...real, [PROTECTIVE_FILES.path]: undefined as never }).some((x) => /missing/.test(x)));

// eslint-disable-next-line no-console
console.log(`PASS protective-action-path mutation fixtures (${n} assertions)`);
