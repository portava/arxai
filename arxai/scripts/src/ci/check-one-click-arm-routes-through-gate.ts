// CI guard — one-click-arm-routes-through-gate
//
// The `oneClickArmed` flag in instantTrade.ts is a NEW `OR` branch added
// alongside the legacy `liveOneClickEnabled` toggle (Task #353). It only
// removes the manual UI confirmation step — it must NEVER short-circuit the
// 16-gate Phase B evaluator. A future edit could accidentally use the armed
// flag to branch around dispatch and place a live order without the gates.
//
// This guard asserts at build time that:
//
//  1. Every reference to `oneClickArmed` in instantTrade.ts appears ONLY in
//     the combined open-action block condition
//     `!settings.liveOneClickEnabled && !settings.oneClickArmed`. The armed
//     flag is never used to early-return success or to branch around dispatch.
//  2. The armed flag never appears next to a successful `return { ok: true`
//     (it must not be a stand-alone "armed ⇒ proceed/skip" path).
//  3. The live OPEN path in instantTrade.ts dispatches through
//     `dispatchLiveCommand` (the only routine that runs the Phase B gates).
//  4. `dispatchLiveCommand` (in liveCommandPipeline.ts) calls
//     `evaluateLivePhaseBDispatchGate` and refuses on a non-PASS decision —
//     so the armed path inherits the full 16-gate evaluation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reportResult, type CheckResult } from "./_lib.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
function read(p: string): string {
  return readFileSync(join(ROOT, p), "utf-8");
}

export function checkOneClickArmRoutesThroughGate(): CheckResult {
  const violations: string[] = [];

  const instant = read("artifacts/api-server/src/lib/live/instantTrade.ts");
  const lines = instant.split("\n");

  // The ONLY sanctioned shape for the armed flag: it is a relaxation of the
  // open-action one-click block, AND-ed with the legacy toggle.
  const sanctioned = "!settings.liveOneClickEnabled && !settings.oneClickArmed";

  let sawSanctioned = false;
  lines.forEach((line, i) => {
    if (!line.includes("oneClickArmed")) return;
    if (line.includes(sanctioned)) {
      sawSanctioned = true;
      return;
    }
    // Any OTHER use of the armed flag is suspect — it could branch around the
    // gate. Comments are allowed (they document the behavior).
    const code = line.replace(/\/\/.*$/, "");
    if (!code.includes("oneClickArmed")) return;
    violations.push(
      `instantTrade.ts:${i + 1} — oneClickArmed used outside the sanctioned ` +
        `block condition (\`${sanctioned}\`): ${line.trim()}`,
    );
  });

  if (!sawSanctioned) {
    violations.push(
      "instantTrade.ts — expected the armed flag in the combined open-action " +
        `block condition (\`${sanctioned}\`); not found (was it removed or renamed?)`,
    );
  }

  // The armed flag must never sit next to a success return (armed ⇒ proceed).
  const armedSuccess = new RegExp(
    "oneClickArmed[\\s\\S]{0,160}return\\s*\\{\\s*ok:\\s*true|return\\s*\\{\\s*ok:\\s*true[\\s\\S]{0,160}oneClickArmed",
  );
  if (armedSuccess.test(instant)) {
    violations.push(
      "instantTrade.ts — oneClickArmed appears adjacent to a `return { ok: true }`; " +
        "the armed flag must never be a stand-alone success/skip path.",
    );
  }

  // The live OPEN path must dispatch through dispatchLiveCommand.
  if (!/dispatchLiveCommand\(/.test(instant)) {
    violations.push(
      "instantTrade.ts — must call dispatchLiveCommand() so every live OPEN " +
        "(armed or not) routes through the Phase B pipeline.",
    );
  }

  // dispatchLiveCommand itself must run the 16-gate evaluator and refuse on
  // a non-PASS decision.
  const pipeline = read("artifacts/api-server/src/lib/live/liveCommandPipeline.ts");
  if (!/evaluateLivePhaseBDispatchGate\(/.test(pipeline)) {
    violations.push(
      "liveCommandPipeline.ts — dispatchLiveCommand must call " +
        "evaluateLivePhaseBDispatchGate (the 16-gate evaluator).",
    );
  }
  if (!/phaseBGate\.decision\s*===\s*"BLOCKED"/.test(pipeline)) {
    violations.push(
      "liveCommandPipeline.ts — must refuse dispatch when " +
        'phaseBGate.decision === "BLOCKED" (no live order on a blocked gate result).',
    );
  }

  return {
    name: "one-click-arm-routes-through-gate",
    ok: violations.length === 0,
    violations,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkOneClickArmRoutesThroughGate();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
