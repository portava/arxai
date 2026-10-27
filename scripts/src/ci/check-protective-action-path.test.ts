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

// 1. Manager: the path is invoked from the hold, after the hold is counted, and
//    the ordinary 90 s rule keeps its default window.
mutate(PROTECTIVE_FILES.manager, /\n\s*try \{\n\s*const protective = await runProtectiveActionPath\(/, "\n      try {\n        const protective = await runProtectivePath(", /must invoke runProtectiveActionPath/);
mutate(PROTECTIVE_FILES.manager, /result\.heldReasons\[observation\.reason\]/g, "result.heldCounts[observation.reason]", /must still count/);
mutate(PROTECTIVE_FILES.manager, "const observation = evaluatePositionObservation({\n      lastSyncedAt: pos.lastSyncedAt,", "const observation = evaluatePositionObservation({\n      maxAgeMs: 30 * 60_000,\n      lastSyncedAt: pos.lastSyncedAt,", /must not carry its own maxAgeMs/);
// The call moved before the hold is counted (acting on the refused observation).
n++;
{
  const src = real[PROTECTIVE_FILES.manager]!;
  const moved = src
    .replace("    if (!observation.ok) {\n      result.held++;", "    if (!observation.ok) {\n      await runProtectiveActionPath(null as never);\n      result.held++;")
    .replace(/\n\s*const protective = await runProtectiveActionPath\(/, "\n        const protective = await runProtectivePath(");
  assert.notEqual(moved, src);
  const v = scanProtectiveSources({ ...real, [PROTECTIVE_FILES.manager]: moved });
  assert.ok(v.some((x) => /after the hold is counted/.test(x)), JSON.stringify(v));
}

// 2. Path: import discipline, rule id and source order.
mutate(PROTECTIVE_FILES.path, 'import { livePositionLedger, type LivePositionRow } from "../positions/ledger.js";', 'import { livePositionLedger, livePositionWriter, type LivePositionRow } from "../positions/ledger.js";', /livePositionWriter/);
mutate(PROTECTIVE_FILES.path, 'import { logger } from "../logger.js";', 'import { logger } from "../logger.js";\nimport { createLiveOpsDraft } from "../live/liveCommandPipeline.js";', /liveCommandPipeline/);
mutate(PROTECTIVE_FILES.path, 'import { logger } from "../logger.js";', 'import { logger } from "../logger.js";\nimport { submitTrade } from "../tradeEngine/pipeline.js";', /tradeEngine/);
mutate(PROTECTIVE_FILES.path, 'import { logger } from "../logger.js";', 'import { logger } from "../logger.js";\nimport { sendManagementTarget } from "../mt5/managementTargetTransport.js";', /managementTargetTransport/);
mutate(PROTECTIVE_FILES.path, 'import { logger } from "../logger.js";', 'import { logger } from "../logger.js";\nimport { mt5CommandsTable } from "@workspace/db";', /mt5CommandsTable/);
mutate(PROTECTIVE_FILES.path, 'import { logger } from "../logger.js";', 'import { logger } from "../logger.js";\nimport http from "node:http";', /node:http/);
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

// 3. Final-claim parity.
mutate(PROTECTIVE_FILES.target, ".pendingManagement?.protective;", ".pendingManagement?.commandId;", /must re-check a protective claim/);
mutate(PROTECTIVE_FILES.target, "if (!evidence.ok) refuse(evidence.reason);", "", /must refuse on failed evidence/);
mutate(PROTECTIVE_FILES.target, "if (!geometry.ok) refuse(geometry.reason);", "", /must refuse on failed evidence/);
mutate(PROTECTIVE_FILES.target, "const geometry = doesNotLoosenStop(", "const geometry = alwaysOk(", /doesNotLoosenStop/);

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
mutate(PROTECTIVE_FILES.cycle, "if (!chain.shouldPauseManagement) {\n        const managed = await manageAgentPositions(bundle.agent, actorUserId, actorRole);", "const managed = await manageAgentPositions(bundle.agent, actorUserId, actorRole);\n      if (!chain.shouldPauseManagement) {", /outside the !chain.shouldPauseManagement block/);
mutate(PROTECTIVE_FILES.cycle, "if (!chain.shouldPauseManagement) {", "if (chain.shouldPauseManagement === false) {", /block is missing/);

// Missing files are violations, not silent passes.
n++;
assert.ok(scanProtectiveSources({ ...real, [PROTECTIVE_FILES.path]: undefined as never }).some((x) => /missing/.test(x)));

// eslint-disable-next-line no-console
console.log(`PASS protective-action-path mutation fixtures (${n} assertions)`);
