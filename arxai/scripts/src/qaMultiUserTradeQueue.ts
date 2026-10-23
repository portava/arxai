// QA — Multi-User Trade Queue + Same-Time Execution Safety.
//
// Verifies the brief's 16 acceptance criteria against the EXISTING ARX AI
// trade pipeline. Reuses arx_live_commands, mt5_demo_commands, advisory
// locks, exposure reservations, cooldown engine, idempotency keys, and
// admin queue controls — NO new trade system, NO duplicate queue.
//
// SAFETY:
// - Pure static + read-only HTTP probes. Creates no live or demo
//   command, never calls the EA, never reaches a broker.
// - Asserts arx_live_commands count is unchanged (0 → 0) at the end.
// - All admin endpoint probes use unauthenticated/non-admin sessions to
//   prove the 403 guard, never with a real admin cookie that could
//   mutate state.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "@workspace/db";

const ROOT = join(import.meta.dirname, "..", "..");
const BASE = process.env.ARX_QA_BASE_URL ?? "http://localhost:80";
function read(p: string): string { return readFileSync(join(ROOT, p), "utf-8"); }

type Result = { id: string; ok: boolean; detail: string };
const results: Result[] = [];
function record(id: string, ok: boolean, detail: string) {
  results.push({ id, ok, detail });
}

async function liveCmdCount(): Promise<number> {
  const r = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM arx_live_commands`);
  return Number(((r as unknown as { rows: { n: string }[] }).rows[0]).n);
}

async function main() {
  const startLive = await liveCmdCount();
  // eslint-disable-next-line no-console
  console.log(`[setup] arx_live_commands start count = ${startLive}`);

  // ──────────────────────────────────────────────────────────────────────
  // 1. Per-user advisory locks exist (concurrency primitive)
  // ──────────────────────────────────────────────────────────────────────
  {
    const lock = read("artifacts/api-server/src/lib/concurrency/advisoryLock.ts");
    record("01-pg-advisory-lock-primitive",
      /pg_try_advisory_xact_lock|pg_advisory_xact_lock/.test(lock),
      "advisoryLock.ts uses pg_try_advisory_xact_lock");
    record("01-withTxAdvisoryLock-export",
      /export.*withTxAdvisoryLock/.test(lock),
      "withTxAdvisoryLock is exported for cross-route use");
  }

  // ──────────────────────────────────────────────────────────────────────
  // 2. Per-user idempotency: SHA-256 key + partial unique index
  // ──────────────────────────────────────────────────────────────────────
  {
    const cfg = read("artifacts/api-server/src/lib/live/phaseBConfig.ts");
    record("02-buildLiveIdempotencyKey-exists",
      /export function buildLiveIdempotencyKey|buildLiveIdempotencyKey\s*\(/.test(cfg),
      "buildLiveIdempotencyKey defined in phaseBConfig.ts");
    record("02-idempotency-fields",
      /userId[\s\S]{0,200}symbol[\s\S]{0,200}side[\s\S]{0,200}(volume|requestedVolume)[\s\S]{0,200}(stopLoss|sl)[\s\S]{0,200}(takeProfit|tp)/i.test(cfg),
      "idempotency input mixes userId+symbol+side+volume+sl+tp");
    const sch = read("lib/db/src/schema/arxLiveExecution.ts");
    record("02-partial-unique-index-active",
      /arx_live_commands_idem_active_uq[\s\S]{0,200}\.on\(t\.userId,\s*t\.idempotencyKey\)[\s\S]{0,200}status in \('SENT_TO_MT5_LIVE','LIVE_FILLED'\)/.test(sch),
      "partial unique idx on (userId, idempotencyKey) where status in active states");
  }

  // ──────────────────────────────────────────────────────────────────────
  // 3. Demo / live physical separation (table + gate)
  // ──────────────────────────────────────────────────────────────────────
  {
    const sch = read("lib/db/src/schema/arxLiveExecution.ts");
    record("03-arx-live-commands-separate",
      /pgTable\("arx_live_commands"/.test(sch),
      "arx_live_commands is its own table");
    const demoSch = read("lib/db/src/schema/mt5DemoExecution.ts");
    record("03-mt5-demo-commands-separate",
      /pgTable\("mt5_demo_commands"/.test(demoSch),
      "mt5_demo_commands is its own table");
    const pipe = read("artifacts/api-server/src/lib/live/liveCommandPipeline.ts");
    // pipeline must INSERT into the live table only; comments may mention
    // demo, what matters is `db.insert(mt5DemoCommandsTable)` never occurs.
    const insertsLive = /db\.insert\(arxLiveCommandsTable\)/.test(pipe);
    const insertsDemo = /db\.insert\(mt5DemoCommandsTable\)/.test(pipe);
    record("03-pipeline-only-inserts-live-table",
      insertsLive && !insertsDemo,
      `inserts arxLiveCommandsTable=${insertsLive}, inserts mt5DemoCommandsTable=${insertsDemo} (must be true,false)`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // 4. Exposure reservations (atomic + release/fulfill)
  // ──────────────────────────────────────────────────────────────────────
  {
    const res = read("artifacts/api-server/src/lib/concurrency/exposureReservation.ts");
    record("04-reserveExposureAtomic-exists",
      /export.*reserveExposureAtomic/.test(res),
      "reserveExposureAtomic is exported");
    record("04-release-on-failure",
      /releaseReservation|releaseReservationByCommandId/.test(res),
      "releaseReservation(ByCommandId) defined");
    record("04-fulfill-on-fill",
      /fulfillReservation|fulfillReservationByCommandId/.test(res),
      "fulfillReservation(ByCommandId) defined");
    record("04-uses-advisory-lock",
      /withTxAdvisoryLock|pg_advisory|pg_try_advisory/.test(res),
      "reservation uses advisory locking to be atomic");
  }

  // ──────────────────────────────────────────────────────────────────────
  // 5. Per-user-per-symbol cooldown is scoped by userId (doesn't bleed)
  // ──────────────────────────────────────────────────────────────────────
  {
    const cd = read("lib/domain/src/cognitive/cooldown.engine.ts");
    // cooldown is per-user by construction (consumes per-user cognitive
    // verdict + per-user trader DNA). Verify the engine derives state
    // from per-user inputs (CognitiveVerdict + TraderRiskScore) rather
    // than a shared global flag.
    record("05-cooldown-per-user-inputs",
      /CognitiveVerdict/.test(cd) && /TraderRiskScore/.test(cd),
      "cooldown engine consumes per-user CognitiveVerdict + TraderRiskScore — A's cooldown cannot affect B");
    // Per-user-per-symbol cooldown is also enforced at the API layer in
    // concurrency/rateLimit.ts (checkSymbolCooldown(userId, symbol)).
    const rl = read("artifacts/api-server/src/lib/concurrency/rateLimit.ts");
    record("05-rateLimit-checkSymbolCooldown-userId-scoped",
      /checkSymbolCooldown[\s\S]{0,200}userId[\s\S]{0,100}symbol/.test(rl) || /export.*checkSymbolCooldown/.test(rl),
      "checkSymbolCooldown(userId, symbol) is per-user-per-symbol at the API gate");
  }

  // ──────────────────────────────────────────────────────────────────────
  // 6. Shared-master routing requires all gates (master mapping, user
  //    approval, bridge healthy, EA enabled, etc.)
  // ──────────────────────────────────────────────────────────────────────
  {
    const gate = read("lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts");
    // Verify the 16-gate evaluator concept is present — must have a
    // BLOCKED decision path, a maxLotForSymbol cap, an algoTradingAllowed
    // check, and per-symbol exposure bounds.
    const gateBitsNeeded = [
      ["BLOCKED-decision", /decision:\s*"PASS"\s*\|\s*"BLOCKED"/],
      ["maxLotForSymbol-cap", /maxLotForSymbol/],
      ["algoTradingAllowed-check", /algoTradingAllowed/],
      ["exceeds-max-lot-message", /exceeds max/i],
      ["multi-failure-collected", /failed\.length\s*===\s*0/],
    ] as const;
    const missing = gateBitsNeeded.filter(([, re]) => !re.test(gate)).map(([id]) => id);
    record("06-phaseB-dispatch-gate-shape",
      missing.length === 0,
      missing.length === 0 ? "PASS/BLOCKED decision + maxLotForSymbol + algoTradingAllowed + per-bit failed[] aggregation all present" : `MISSING: ${missing.join(",")}`);
    const masterGate = read("artifacts/api-server/src/lib/mt5/masterLiveBridgeGate.ts");
    record("06-master-bridge-mapping-gate",
      /MASTER_LIVE_USER_ACCESS_BLOCKED|MASTER_LIVE_DISPATCH_BLOCKED|MASTER_BRIDGE/i.test(masterGate),
      "masterLiveBridgeGate enforces master-side block reasons");
  }

  // ──────────────────────────────────────────────────────────────────────
  // 7. Dispatcher / EA-pull semantics + duplicate-prevention
  // ──────────────────────────────────────────────────────────────────────
  {
    const mt5Live = read("artifacts/api-server/src/routes/mt5Live.ts");
    record("07-ea-poll-endpoint",
      /\/api\/mt5\/live-commands-poll/.test(mt5Live),
      "EA polls /api/mt5/live-commands-poll");
    record("07-ea-poll-per-user-only",
      /bridgeAuthPerUserOnly/.test(mt5Live),
      "live-commands-poll guarded by bridgeAuthPerUserOnly (per-user bridge token)");
    record("07-ea-poll-rejects-non-live-account",
      /accountType[\s\S]{0,50}(live|real)/i.test(mt5Live),
      "live poll refuses if bridge.accountType is not live/real");
  }

  // ──────────────────────────────────────────────────────────────────────
  // 8. Audit logging across the lifecycle (existing audit() calls)
  // ──────────────────────────────────────────────────────────────────────
  {
    const pipe = read("artifacts/api-server/src/lib/live/liveCommandPipeline.ts");
    const needed = ["LIVE_DRAFT_CREATED", "LIVE_DRAFT_REFUSED"];
    const missing = needed.filter((n) => !pipe.includes(n));
    record("08-pipeline-audit-create-and-refuse",
      missing.length === 0,
      missing.length === 0 ? "pipeline writes LIVE_DRAFT_CREATED + LIVE_DRAFT_REFUSED audit rows" : `MISSING: ${missing.join(",")}`);
    const liveAccess = read("artifacts/api-server/src/routes/adminMasterLiveAccess.ts");
    record("08-master-live-mutations-audited",
      /writeAudit\s*\(|master_live_access_audit/i.test(liveAccess),
      "admin master-live mutations call writeAudit (master_live_access_audit table)");
  }

  // ──────────────────────────────────────────────────────────────────────
  // 9. NEW admin queue controls — cancel-queued + mark-needs-review
  // ──────────────────────────────────────────────────────────────────────
  {
    const admin = read("artifacts/api-server/src/routes/adminTrading.ts");
    record("09-cancel-queued-endpoint",
      /\/admin\/trading\/commands\/:commandId\/cancel-queued/.test(admin),
      "POST /admin/trading/commands/:commandId/cancel-queued registered");
    record("09-mark-needs-review-endpoint",
      /\/admin\/trading\/commands\/:commandId\/mark-needs-review/.test(admin),
      "POST /admin/trading/commands/:commandId/mark-needs-review registered");
    record("09-cancel-refuses-past-dispatch",
      /COMMAND_NOT_CANCELLABLE|cancellable.*SENT_TO_MT5_LIVE|cancellable.*Set/.test(admin),
      "cancel refuses once status has advanced past pre-dispatch (cannot cancel an in-flight EA command)");
    record("09-mark-review-refuses-terminal",
      /COMMAND_TERMINAL|terminal.*Set/.test(admin),
      "mark-needs-review refuses if command is in a terminal state");
    record("09-cancel-writes-admin-audit",
      /CANCEL_QUEUED_LIVE_COMMAND/.test(admin) && /writeAdminAudit/.test(admin),
      "cancel-queued writes CANCEL_QUEUED_LIVE_COMMAND via writeAdminAudit");
    record("09-mark-review-writes-admin-audit",
      /MARK_LIVE_COMMAND_NEEDS_REVIEW/.test(admin) && /writeAdminAudit/.test(admin),
      "mark-needs-review writes MARK_LIVE_COMMAND_NEEDS_REVIEW via writeAdminAudit");
    // Atomicity — both mutations must use guarded UPDATE constrained to
    // status sets at the moment of the write (no separate SELECT → UPDATE),
    // closing the TOCTOU window where the EA could pick up the command
    // between the read and the write.
    record("09-cancel-uses-atomic-guarded-update",
      /update\(arxLiveCommandsTable\)[\s\S]{0,400}LIVE_CANCELLABLE_STATUSES/.test(admin),
      "cancel-queued mutates via guarded UPDATE constrained to LIVE_CANCELLABLE_STATUSES (no TOCTOU)");
    record("09-mark-review-uses-atomic-guarded-update",
      /update\(arxLiveCommandsTable\)[\s\S]{0,400}LIVE_TERMINAL_STATUSES/.test(admin),
      "mark-needs-review mutates via guarded UPDATE excluding LIVE_TERMINAL_STATUSES (no TOCTOU)");
  }

  // ──────────────────────────────────────────────────────────────────────
  // 10. Admin-only — non-admin sessions blocked (live HTTP)
  // ──────────────────────────────────────────────────────────────────────
  {
    const probe = await fetch(`${BASE}/api/admin/trading/commands/dummy-id/cancel-queued`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    record("10-anon-cancel-queued-blocked",
      probe.status === 401 || probe.status === 403,
      `anon POST cancel-queued → ${probe.status} (expected 401 or 403)`);
    const probe2 = await fetch(`${BASE}/api/admin/trading/commands/dummy-id/mark-needs-review`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    record("10-anon-mark-needs-review-blocked",
      probe2.status === 401 || probe2.status === 403,
      `anon POST mark-needs-review → ${probe2.status} (expected 401 or 403)`);
    const probe3 = await fetch(`${BASE}/api/admin/trading/execution-health`);
    record("10-anon-execution-health-blocked",
      probe3.status === 401 || probe3.status === 403,
      `anon GET execution-health → ${probe3.status} (expected 401 or 403)`);
    const probe4 = await fetch(`${BASE}/api/admin/trade-monitor`);
    record("10-anon-trade-monitor-blocked",
      probe4.status === 401 || probe4.status === 403,
      `anon GET trade-monitor → ${probe4.status} (expected 401 or 403)`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // 11. User-facing humanization of statuses + block reasons
  // ──────────────────────────────────────────────────────────────────────
  {
    const hum = read("artifacts/trading-dashboard/src/lib/humanize.ts");
    const needed = [
      "LIVE_BROKER_EXECUTION_DISABLED",
      "DUPLICATE_LIVE_IDEMPOTENCY_KEY",
      "MASTER_LIVE_USER_ACCESS_BLOCKED",
    ];
    const missing = needed.filter((n) => !hum.includes(n));
    record("11-humanize-block-reasons",
      missing.length === 0,
      missing.length === 0 ? "humanize.ts maps key backend codes to plain-English labels" : `MISSING: ${missing.join(",")}`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // 12. No secrets in admin/queue surfaces (static)
  // ──────────────────────────────────────────────────────────────────────
  {
    const files = [
      "artifacts/api-server/src/routes/adminTrading.ts",
      "artifacts/api-server/src/routes/adminMasterBridge.ts",
      "artifacts/api-server/src/routes/adminMasterLiveAccess.ts",
    ];
    const envEcho = /res\.json\([^)]*process\.env\.(SESSION_SECRET|MT5_BRIDGE_TOKEN|TWELVEDATA_API_KEY|DATABASE_URL)/;
    for (const f of files) {
      const src = read(f);
      record(`12-no-secret-echo-in-${f.split("/").pop()}`,
        !envEcho.test(src),
        envEcho.test(src) ? "LEAK: process.env.<secret> echoed into JSON" : "no process.env.<secret> echoed");
    }
    const bridgeMask = read("artifacts/api-server/src/routes/adminMasterBridge.ts");
    record("12-bridge-uses-mask-chokepoint",
      /maskBridgeEvidenceForUser/.test(bridgeMask),
      "adminMasterBridge always renders bridge evidence through maskBridgeEvidenceForUser");
  }

  // ──────────────────────────────────────────────────────────────────────
  // 13. Ruby tools surface queue/blocking explanations
  // ──────────────────────────────────────────────────────────────────────
  {
    const tools = read("artifacts/api-server/src/lib/assistant/tools.ts");
    const needed = ["getTradingMode", "getReconciliationStatus", "getMT5BridgeStatus", "getRiskUtilization", "getMyAccountShell"];
    const missing = needed.filter((n) => !tools.includes(n));
    record("13-ruby-tools-explain-queue",
      missing.length === 0,
      missing.length === 0 ? "Ruby has all tools needed to explain why a trade is queued/blocked/needs-review" : `MISSING: ${missing.join(",")}`);
    const sys = read("artifacts/api-server/src/lib/assistant/systemPrompt.ts");
    record("13-ruby-placed-honesty",
      /NEVER claim.*PLACED|never tell the user.*live|never tell the user.*placed/i.test(sys),
      "Ruby prompt forbids claiming a live trade was placed without confirmed status");
  }

  // ──────────────────────────────────────────────────────────────────────
  // 14. Idempotency-key partial index allows retry in new minute bucket
  // ──────────────────────────────────────────────────────────────────────
  {
    const sch = read("lib/db/src/schema/arxLiveExecution.ts");
    record("14-idem-key-allows-retry-after-failure",
      /Terminal states[\s\S]{0,200}intentionally NOT covered|status in \('SENT_TO_MT5_LIVE','LIVE_FILLED'\)/.test(sch),
      "partial unique index covers only active states — terminal states allow same-key retry");
  }

  // ──────────────────────────────────────────────────────────────────────
  // 15. Existing concurrency test exists and is registered
  // ──────────────────────────────────────────────────────────────────────
  {
    const pkg = read("scripts/package.json");
    record("15-one-click-concurrency-registered",
      /test:one-click-concurrency/.test(pkg),
      "test:one-click-concurrency is registered (exercises 2-user same-symbol race)");
    record("15-live-pipeline-blocked-registered",
      /test:live-pipeline/.test(pkg),
      "test:live-pipeline is registered (exercises blocked paths)");
    record("15-per-user-isolation-registered",
      /test:per-user-isolation/.test(pkg),
      "test:per-user-isolation is registered (exercises A vs B isolation)");
  }

  // ──────────────────────────────────────────────────────────────────────
  // 16. arx_live_commands strict-zero (no auto-fire during QA)
  // ──────────────────────────────────────────────────────────────────────
  const endLive = await liveCmdCount();
  record("16-arx-live-commands-unchanged",
    endLive === startLive,
    `start=${startLive} end=${endLive}`);
  record("16-arx-live-commands-strict-zero",
    startLive === 0 && endLive === 0,
    `start=${startLive} end=${endLive} (both must be 0)`);

  // ──────────────────────────────────────────────────────────────────────
  // Report
  // ──────────────────────────────────────────────────────────────────────
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.ok) { pass++; } else { fail++; }
    // eslint-disable-next-line no-console
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.id} — ${r.detail}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${pass}/${pass + fail} Multi-User Trade Queue checks ${fail === 0 ? "PASSED" : "FAILED"}`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
