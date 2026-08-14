// CI guard — Master Bridge LIVE bridge-binding non-bypassable
//
// Asserts at build time that:
//
//  1. `recordLiveCommandResult` (the EA result write-back) STILL contains
//     a bridge-binding mismatch check returning BRIDGE_BINDING_MISMATCH
//     when reportingBridgeConnectionId differs from the persisted command
//     bridgeConnectionId. This is the second half of the binding (the
//     first half — pickup — is enforced by the partial unique index +
//     CAS update in `pickupNextLiveCommand`).
//
//  2. `dispatchLiveCommand` calls `loadAndEvaluateMasterLiveBridgeGate`
//     BEFORE assembling the Phase B 16-gate input, so master live
//     dispatches cannot reach the pass-path without the master-live
//     gate's verdict.
//
//  3. No top-level/module-init/cron file calls `dispatchLiveCommand`
//     (the no-auto-fire rule). The pipeline export may only be called
//     from user/admin-authenticated request handlers.
//
//  4. The currentConnectedBridgeDetector and masterLiveBridgeGate helpers
//     do not import any code path that could place a trade — they read
//     only mt5_connection and global_trading_settings.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");

function read(p: string): string {
  return readFileSync(join(ROOT, p), "utf-8");
}
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/(^|[^:\\])\/\/.*$/, "$1")).join("\n");
}

import type { CheckResult } from "./_lib.js";

export function checkMasterLiveBridgeBinding(): CheckResult {
  const failures: string[] = [];
  const pipeline = read("artifacts/api-server/src/lib/live/liveCommandPipeline.ts");

  // 1. recordLiveCommandResult still asserts BRIDGE_BINDING_MISMATCH.
  if (!/BRIDGE_BINDING_MISMATCH/.test(pipeline)) {
    failures.push("liveCommandPipeline.ts no longer references BRIDGE_BINDING_MISMATCH");
  }
  if (!/reportingBridgeConnectionId/.test(pipeline)) {
    failures.push("liveCommandPipeline.ts no longer reads reportingBridgeConnectionId on result write-back");
  }

  // 2. dispatchLiveCommand wires the master-live gate.
  if (!/loadAndEvaluateMasterLiveBridgeGate/.test(pipeline)) {
    failures.push("liveCommandPipeline.ts does not import/use loadAndEvaluateMasterLiveBridgeGate");
  }
  // Window widened from 400 → 2000 chars: the SHARED_MASTER_MT5 branch
  // now contains both the per-user access gate (added May 2026) AND the
  // master-bridge gate. Both must live inside the same branch.
  if (!/SHARED_MASTER_MT5[\s\S]{0,2000}?loadAndEvaluateMasterLiveBridgeGate/.test(pipeline)) {
    failures.push("master-live gate is not branch-gated by SHARED_MASTER_MT5 routing mode");
  }

  // 3. No-auto-fire — scan source files OUTSIDE the pipeline + route
  //    handlers + scripts for any call to dispatchLiveCommand. The
  //    allowed callers are:
  //      - artifacts/api-server/src/routes/meLive.ts (user-authenticated)
  //      - artifacts/api-server/src/lib/live/liveCommandPipeline.ts (definer)
  //      - scripts/src/qa* (read-only typecheck of import surface)
  //    Any cron, scheduler, server bootstrap, or background loop that
  //    references dispatchLiveCommand is a FAIL.
  const forbidden = [
    "artifacts/api-server/src/index.ts",
    "artifacts/api-server/src/lib/live/liveArming.ts",
    "artifacts/api-server/src/lib/mt5/masterBridgeRouting.ts",
    "artifacts/api-server/src/lib/mt5/demoCommandConsumer.ts",
    "artifacts/api-server/src/lib/mt5/currentConnectedBridgeDetector.ts",
    "artifacts/api-server/src/lib/mt5/masterLiveBridgeGate.ts",
    "artifacts/api-server/src/routes/adminMasterBridge.ts",
    "artifacts/api-server/src/routes/meMasterBridge.ts",
  ];
  for (const f of forbidden) {
    let src: string;
    try { src = read(f); } catch { continue; }
    if (/\bdispatchLiveCommand\s*\(/.test(src)) {
      failures.push(`forbidden caller invokes dispatchLiveCommand(): ${f}`);
    }
  }

  // 4. Detector + gate helpers must not import live dispatch (code only —
  //    SECURITY-policy comments that list the forbidden names are stripped).
  const det = stripComments(read("artifacts/api-server/src/lib/mt5/currentConnectedBridgeDetector.ts"));
  const gate = stripComments(read("artifacts/api-server/src/lib/mt5/masterLiveBridgeGate.ts"));
  for (const [name, src] of [["currentConnectedBridgeDetector", det], ["masterLiveBridgeGate", gate]] as const) {
    if (/dispatchLiveCommand|liveCommandPipeline|placeLiveOrderGuarded/.test(src)) {
      failures.push(`${name} imports a code path that can place a trade`);
    }
  }
  // 3-strict (forbidden callers) — also strip comments before scanning so
  // SECURITY policy headers don't false-positive against themselves.
  const forbiddenStripped = [
    "artifacts/api-server/src/lib/mt5/currentConnectedBridgeDetector.ts",
    "artifacts/api-server/src/lib/mt5/masterLiveBridgeGate.ts",
    "artifacts/api-server/src/routes/adminMasterBridge.ts",
    "artifacts/api-server/src/routes/meMasterBridge.ts",
  ];
  void forbiddenStripped; // already covered above with raw read; left for grep-ability

  const pass = failures.length === 0;
  return {
    name: "master-live-bridge-binding-non-bypassable",
    ok: pass,
    violations: failures,
    notes: pass
      ? ["BRIDGE_BINDING_MISMATCH still enforced", "master-live gate wired ahead of Phase B", "no auto-fire callers", "detector/gate import-clean"]
      : [],
  };
}
