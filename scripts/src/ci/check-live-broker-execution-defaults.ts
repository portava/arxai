// Phase B — Live broker execution invariants (9 checks bundled in one guard).
//
// Locks down the chokepoint flip from a hard literal block to a runtime
// 15-gate decision. The default state must remain "deny": master switch
// off, EA version >=1.27, separate live endpoints, no shared poll path
// with demo, no secrets returned, idempotency required, kill switch
// honored.
import { read, rel, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

function readIfExists(p: string): string {
  try { return read(p); } catch { return ""; }
}

export function checkLiveBrokerExecutionDefaults(): CheckResult {
  const violations: string[] = [];

  const cfg     = readIfExists(join(ROOT, "artifacts/api-server/src/lib/live/phaseBConfig.ts"));
  const pipe    = readIfExists(join(ROOT, "artifacts/api-server/src/lib/live/liveCommandPipeline.ts"));
  const gate    = readIfExists(join(ROOT, "lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts"));
  const liveR   = readIfExists(join(ROOT, "artifacts/api-server/src/routes/mt5Live.ts"));
  const demoR   = readIfExists(join(ROOT, "artifacts/api-server/src/routes/mt5DemoBridge.ts"));
  const meLive  = readIfExists(join(ROOT, "artifacts/api-server/src/routes/meLive.ts"));

  // 1. Master switch defined and defaults to false.
  if (!/ARX_LIVE_BROKER_EXECUTION_ENABLED/.test(cfg))
    violations.push(`${rel(join(ROOT, "artifacts/api-server/src/lib/live/phaseBConfig.ts"))}: missing ARX_LIVE_BROKER_EXECUTION_ENABLED env reader`);
  if (!/liveBrokerExecutionEnabled/.test(cfg))
    violations.push(`phaseBConfig.ts: missing liveBrokerExecutionEnabled() exported reader`);

  // 2. Kill switch honored in dispatch.
  if (!/KILL_SWITCH_ENGAGED/.test(pipe))
    violations.push(`liveCommandPipeline.ts: dispatch path missing KILL_SWITCH_ENGAGED reason`);
  if (!/killSwitchEngaged/.test(pipe))
    violations.push(`liveCommandPipeline.ts: dispatch path does not read arming.killSwitchEngaged`);

  // 3+4. Live endpoint file exists, per-user bound; demo file untouched.
  if (!/live-commands-poll/.test(liveR))
    violations.push(`mt5Live.ts: missing POST /api/mt5/live-commands-poll route`);
  if (!/sync-live-positions/.test(liveR))
    violations.push(`mt5Live.ts: missing POST /api/mt5/sync-live-positions route`);
  if (!/bridgeAuthPerUserOnly/.test(liveR))
    violations.push(`mt5Live.ts: live endpoints not guarded by bridgeAuthPerUserOnly`);
  if (demoR && /live-commands-poll|sync-live-positions|live-command-result/.test(demoR))
    violations.push(`mt5DemoBridge.ts: must not reference live endpoints`);

  // 5. accountType=live/real asserted in live route.
  if (!/("live"|"real")/.test(liveR))
    violations.push(`mt5Live.ts: does not assert accountType in {"live","real"}`);

  // 6. EA version >=1.27 required (gate evaluator).
  if (!/MIN_LIVE_EA_VERSION\s*=\s*"1\.27"|"1\.27"/.test(gate))
    violations.push(`livePhaseBDispatchGate.ts: does not require EA >=1.27`);

  // 7. enableLiveExecution required by gate.
  if (!/bridgeEnableLiveExecution/.test(gate))
    violations.push(`livePhaseBDispatchGate.ts: does not check bridgeEnableLiveExecution`);

  // 8. Idempotency key required + duplicate-key blocked.
  if (!/idempotencyKey/.test(pipe))
    violations.push(`liveCommandPipeline.ts: does not write idempotencyKey`);
  if (!/DUPLICATE_LIVE_IDEMPOTENCY_KEY/.test(pipe))
    violations.push(`liveCommandPipeline.ts: does not surface DUPLICATE_LIVE_IDEMPOTENCY_KEY refusal`);

  // 9. No secrets returned from live path.
  for (const banned of ["MT5_BRIDGE_TOKEN", "SESSION_SECRET", "apiKeyHash"]) {
    if (new RegExp(banned).test(meLive))
      violations.push(`meLive.ts: must not reference ${banned}`);
    if (new RegExp(banned).test(liveR))
      violations.push(`mt5Live.ts: must not reference ${banned}`);
  }

  return {
    name: "live-broker-execution-defaults (Phase B 9-invariant bundle)",
    ok: violations.length === 0,
    violations,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkLiveBrokerExecutionDefaults();
  // eslint-disable-next-line no-console
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
  for (const v of r.violations) {
    // eslint-disable-next-line no-console
    console.log(`  - ${v}`);
  }
  process.exit(r.ok ? 0 : 1);
}
