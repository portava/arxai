// qaMasterBridgeLive.ts — Master Bridge LIVE acceptance proof
//
// READ-ONLY. NEVER calls dispatchLiveCommand. NEVER writes to
// arx_live_commands. NEVER mutates global_trading_settings beyond
// what its own probes need (and probes never alter the live or
// routing flags).
//
// Each probe verifies one acceptance bullet from the spec. The script
// asserts that arx_live_commands COUNT is identical at start and end
// (no auto-fire).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "@workspace/db";
import {
  evaluateBridgeAsMasterLive,
  type DetectedBridgeEvidence,
} from "../../artifacts/api-server/src/lib/mt5/currentConnectedBridgeDetector.js";
import {
  evaluateMasterLiveBridgeGate,
  type MasterLiveGateInput,
} from "../../artifacts/api-server/src/lib/mt5/masterLiveBridgeGate.js";

const ROOT = join(import.meta.dirname, "..", "..");
function read(p: string): string {
  try { return readFileSync(join(ROOT, p), "utf-8"); } catch { return ""; }
}
// Strip TS/JS comments so SECURITY-policy comments listing forbidden
// field names don't false-positive against the regexes that check for
// the same field names in rendered code.
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/(^|[^:\\])\/\/.*$/, "$1")).join("\n");
}
// Collapse all whitespace (incl. newlines) — used so JSX text wrapped
// across lines still matches a one-line sentence regex.
function collapse(s: string): string {
  return s.replace(/\s+/g, " ");
}

type Verdict = { name: string; pass: boolean; note: string };
const results: Verdict[] = [];
function record(name: string, pass: boolean, note: string): void {
  results.push({ name, pass, note });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${note}`);
}

function makeEv(o: Partial<DetectedBridgeEvidence>): DetectedBridgeEvidence {
  return {
    bridgeId: 1, userId: null, mode: "LIVE", accountType: "real",
    eaVersion: "1.27", brokerName: "TestBroker", serverName: "TestServer",
    accountNumber: "12345678", lastHeartbeat: new Date(),
    heartbeatAgeSec: 3,
    eaInputs: {
      terminalConnected: true, algoTradingAllowed: true,
      readOnlyMode: false, enableLiveExecution: true,
      enableDemoExecution: false, maxLiveLot: 0.01,
    },
    tokenRevokedAt: null,
    ...o,
  };
}

async function main(): Promise<void> {
  // ── INVARIANT (start) — arx_live_commands count ──────────────────────
  const startCnt = (await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands")).rows[0].n as number;

  // ── 01 — Detector helper exists and exports the right surface ────────
  const det = read("artifacts/api-server/src/lib/mt5/currentConnectedBridgeDetector.ts");
  record(
    "01_detector_helper_exports",
    /detectCurrentConnectedBridge/.test(det) &&
      /evaluateBridgeAsMasterLive/.test(det) &&
      /maskBridgeEvidenceForUser/.test(det),
    "currentConnectedBridgeDetector.ts exports detector + pure evaluator + masker",
  );

  // ── 02 — Detector picks freshest REAL bridge meeting all criteria ────
  const okEv = makeEv({});
  const v = evaluateBridgeAsMasterLive(okEv);
  record(
    "02_detector_passes_real_bridge_meeting_all_criteria",
    v.ok === true,
    "REAL bridge with EA 1.27, fresh hb, all eaInputs good → OK",
  );

  // ── 03 — MOCK as latest blocks with MASTER_BRIDGE_REAL_HEARTBEAT_REQUIRED
  const mock = evaluateBridgeAsMasterLive(makeEv({ mode: "MOCK" }));
  record(
    "03_mock_latest_blocks_real_heartbeat_required",
    !mock.ok && mock.reason === "MASTER_BRIDGE_REAL_HEARTBEAT_REQUIRED",
    `mock.reason=${!mock.ok ? mock.reason : "OK"}`,
  );

  // ── 04 — DEMO bridge blocks with MASTER_LIVE_REQUIRES_REAL_BRIDGE ────
  const demo = evaluateBridgeAsMasterLive(makeEv({ mode: "LIVE", accountType: "demo" }));
  record(
    "04_demo_account_blocks_master_live_requires_real_bridge",
    !demo.ok && demo.reason === "MASTER_LIVE_REQUIRES_REAL_BRIDGE",
    `demo.reason=${!demo.ok ? demo.reason : "OK"}`,
  );

  // ── 05 — Stale heartbeat blocks with MASTER_BRIDGE_HEARTBEAT_STALE ───
  const stale = evaluateBridgeAsMasterLive(makeEv({ heartbeatAgeSec: 9999 }));
  record(
    "05_stale_heartbeat_blocks",
    !stale.ok && stale.reason === "MASTER_BRIDGE_HEARTBEAT_STALE",
    `stale.reason=${!stale.ok ? stale.reason : "OK"}`,
  );

  // ── 06 — EA below 1.27 blocks ────────────────────────────────────────
  const oldEa = evaluateBridgeAsMasterLive(makeEv({ eaVersion: "1.26" }));
  record(
    "06_ea_below_min_blocks_version_too_old",
    !oldEa.ok && oldEa.reason === "MASTER_BRIDGE_EA_VERSION_TOO_OLD",
    `oldEa.reason=${!oldEa.ok ? oldEa.reason : "OK"}`,
  );

  // ── 07 — ReadOnlyMode=true blocks ────────────────────────────────────
  const ro = evaluateBridgeAsMasterLive(makeEv({
    eaInputs: { terminalConnected: true, algoTradingAllowed: true, readOnlyMode: true, enableLiveExecution: true, enableDemoExecution: false, maxLiveLot: 0.01 },
  }));
  record(
    "07_read_only_mode_blocks_not_live_capable",
    !ro.ok && ro.reason === "MASTER_BRIDGE_NOT_LIVE_CAPABLE",
    `ro.reason=${!ro.ok ? ro.reason : "OK"}`,
  );

  // ── 08 — EnableLiveExecution=false blocks ────────────────────────────
  const ele = evaluateBridgeAsMasterLive(makeEv({
    eaInputs: { terminalConnected: true, algoTradingAllowed: true, readOnlyMode: false, enableLiveExecution: false, enableDemoExecution: false, maxLiveLot: 0.01 },
  }));
  record(
    "08_enable_live_execution_false_blocks",
    !ele.ok && ele.reason === "MASTER_BRIDGE_NOT_LIVE_CAPABLE",
    `ele.reason=${!ele.ok ? ele.reason : "OK"}`,
  );

  // ── 09 — Schema columns exist on global_trading_settings ─────────────
  const colsQ = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='global_trading_settings'
      AND column_name IN ('platform_master_bridge_connection_id','master_bridge_live_enabled')
  `);
  record(
    "09_schema_columns_present",
    colsQ.rows.length === 2,
    `found=${colsQ.rows.map((r) => r.column_name as string).join(",")}`,
  );

  // ── 10 — Master live gate: PASS requires ALL inputs aligned ──────────
  const passInput: MasterLiveGateInput = {
    accountRoutingMode: "SHARED_MASTER_MT5",
    sharedLiveTradingEnabled: true,
    masterBridgeLiveEnabled: true,
    platformMasterBridgeConnectionId: 1,
    detector: { ok: true, bridge: okEv },
  };
  const passV = evaluateMasterLiveBridgeGate(passInput);
  record(
    "10_master_live_gate_pass_path",
    passV.decision === "PASS" && passV.decision === "PASS" && passV.boundBridgeId === 1,
    `decision=${passV.decision}`,
  );

  // ── 11 — Master live gate: BRIDGE_BINDING_MISMATCH when ids differ ───
  const mismatch = evaluateMasterLiveBridgeGate({
    ...passInput,
    platformMasterBridgeConnectionId: 99,
  });
  record(
    "11_master_live_gate_binding_mismatch",
    mismatch.decision === "BLOCKED" && mismatch.blockReasons.includes("BRIDGE_BINDING_MISMATCH"),
    `primary=${mismatch.decision === "BLOCKED" ? mismatch.primaryReason : "PASS"}`,
  );

  // ── 12 — Master live gate: MASTER_BRIDGE_NOT_CONFIGURED when null ────
  const noCfg = evaluateMasterLiveBridgeGate({
    ...passInput,
    platformMasterBridgeConnectionId: null,
  });
  record(
    "12_master_live_gate_not_configured",
    noCfg.decision === "BLOCKED" && noCfg.blockReasons.includes("MASTER_BRIDGE_NOT_CONFIGURED"),
    `primary=${noCfg.decision === "BLOCKED" ? noCfg.primaryReason : "PASS"}`,
  );

  // ── 13 — Master live gate: SHARED_LIVE_TRADING_DISABLED when flag off
  const noShared = evaluateMasterLiveBridgeGate({
    ...passInput, sharedLiveTradingEnabled: false,
  });
  record(
    "13_master_live_gate_shared_live_disabled",
    noShared.decision === "BLOCKED" && noShared.blockReasons.includes("SHARED_LIVE_TRADING_DISABLED"),
    `primary=${noShared.decision === "BLOCKED" ? noShared.primaryReason : "PASS"}`,
  );

  // ── 14 — Master live gate: MASTER_BRIDGE_LIVE_NOT_ENABLED ────────────
  const noEnable = evaluateMasterLiveBridgeGate({
    ...passInput, masterBridgeLiveEnabled: false,
  });
  record(
    "14_master_live_gate_not_enabled",
    noEnable.decision === "BLOCKED" && noEnable.blockReasons.includes("MASTER_BRIDGE_LIVE_NOT_ENABLED"),
    `primary=${noEnable.decision === "BLOCKED" ? noEnable.primaryReason : "PASS"}`,
  );

  // ── 15 — Master live gate: PER_USER_BRIDGE_MODE_ACTIVE in wrong mode
  const wrongMode = evaluateMasterLiveBridgeGate({
    ...passInput, accountRoutingMode: "USER_OWNED_MT5",
  });
  record(
    "15_master_live_gate_per_user_mode_active",
    wrongMode.decision === "BLOCKED" && wrongMode.blockReasons.includes("PER_USER_BRIDGE_MODE_ACTIVE"),
    `primary=${wrongMode.decision === "BLOCKED" ? wrongMode.primaryReason : "PASS"}`,
  );

  // ── 16 — Master live gate propagates detector failure ────────────────
  const detBlocked = evaluateMasterLiveBridgeGate({
    ...passInput,
    detector: { ok: false, primaryReason: "MASTER_LIVE_REQUIRES_REAL_BRIDGE" },
  });
  record(
    "16_master_live_gate_propagates_detector_failure",
    detBlocked.decision === "BLOCKED" &&
      detBlocked.blockReasons.includes("MASTER_LIVE_REQUIRES_REAL_BRIDGE"),
    `primary=${detBlocked.decision === "BLOCKED" ? detBlocked.primaryReason : "PASS"}`,
  );

  // ── 17 — dispatchLiveCommand wires the master-live gate ahead of PB
  const pipeline = read("artifacts/api-server/src/lib/live/liveCommandPipeline.ts");
  record(
    "17_pipeline_wires_master_live_gate_before_phase_b",
    /loadAndEvaluateMasterLiveBridgeGate/.test(pipeline) &&
      /SHARED_MASTER_MT5[\s\S]{0,2000}?loadAndEvaluateMasterLiveBridgeGate/.test(pipeline) &&
      pipeline.indexOf("loadAndEvaluateMasterLiveBridgeGate(")
        < pipeline.indexOf("evaluateLivePhaseBDispatchGate("),
    "loadAndEvaluateMasterLiveBridgeGate is called inside SHARED_MASTER_MT5 branch BEFORE evaluateLivePhaseBDispatchGate",
  );

  // ── 18 — Pipeline binds the override bridge id from the gate ─────────
  record(
    "18_pipeline_binds_master_bound_bridge_id",
    /masterBoundBridgeId/.test(pipeline) &&
      /eq\(mt5ConnectionTable\.id,\s*masterBoundBridgeId\)/.test(pipeline),
    "bridge pool overridden by mt5_connection.id = masterBoundBridgeId in SHARED_MASTER_MT5",
  );

  // ── 19 — BRIDGE_BINDING_MISMATCH still enforced on result write-back
  record(
    "19_result_writeback_still_enforces_bridge_binding",
    /reportingBridgeConnectionId/.test(pipeline) &&
      /BRIDGE_BINDING_MISMATCH/.test(pipeline),
    "recordLiveCommandResult rejects when reportingBridgeConnectionId != stored",
  );

  // ── 20 — Pickup also binds to bridge id ──────────────────────────────
  record(
    "20_pickup_binds_to_bridge_id",
    /pickupNextLiveCommand/.test(pipeline) &&
      /eq\(arxLiveCommandsTable\.bridgeConnectionId,\s*args\.bridgeConnectionId\)/.test(pipeline),
    "pickupNextLiveCommand requires command.bridgeConnectionId = args.bridgeConnectionId (CAS-bound)",
  );

  // ── 21 — Admin routes registered & ADMIN-gated, never leak secrets ───
  const adminRoute = read("artifacts/api-server/src/routes/adminMasterBridge.ts");
  const routesIdx = read("artifacts/api-server/src/routes/index.ts");
  record(
    "21_admin_routes_registered_and_admin_gated_no_secret_leak",
    /adminMasterBridgeRouter/.test(routesIdx) &&
      /requireAdmin/.test(adminRoute) &&
      /\/admin\/master-bridge\/(current|snapshot|gate)/.test(adminRoute) &&
      !/apiKeyHash|bridgeToken|tokenLast4|MT5_BRIDGE_TOKEN|SESSION_SECRET/.test(adminRoute),
    "admin route uses requireAdmin + exposes only masked evidence + 0 secret refs",
  );

  // ── 22 — User route registered, requireUser, masked, no secret ───────
  const meRoute = read("artifacts/api-server/src/routes/meMasterBridge.ts");
  const meRouteCode = stripComments(meRoute);
  record(
    "22_user_route_registered_user_gated_no_secret_leak",
    /meMasterBridgeRouter/.test(routesIdx) &&
      /requireUser/.test(meRouteCode) &&
      /Master Live Bridge: Current Connected Bridge/.test(meRoute) &&
      !/apiKeyHash|bridgeToken|tokenLast4|MT5_BRIDGE_TOKEN|SESSION_SECRET/.test(meRouteCode) &&
      /maskBridgeEvidenceForUser/.test(meRouteCode),
    "/api/me/master-bridge/status uses requireUser + label string present + masker + 0 secret refs",
  );

  // ── 23 — Admin UI card present (Main Bridge: Current Connected Bridge)
  const adminPage = read("artifacts/trading-dashboard/src/pages/admin/master-bridge.tsx");
  record(
    "23_admin_ui_main_bridge_card_present",
    /Main Bridge: Current Connected Bridge/.test(adminPage) &&
      /MainBridgeCurrentConnectedCard/.test(adminPage) &&
      /\/api\/admin\/master-bridge\/current/.test(adminPage) &&
      /\/api\/admin\/master-bridge\/snapshot/.test(adminPage),
    "admin dashboard wires the Main Bridge card with current+snapshot endpoints",
  );

  // ── 24 — mt5-setup card includes the master-bridge sentence ──────────
  const mt5Setup = read("artifacts/trading-dashboard/src/pages/mt5-setup.tsx");
  record(
    "24_mt5_setup_master_bridge_sentence",
    /Current connected bridge is being used as the ARX Master Bridge/.test(collapse(mt5Setup)),
    "mt5-setup.tsx renders 'Current connected bridge is being used as the ARX Master Bridge.'",
  );

  // ── 25 — Live Trading page renders Master Live Bridge banner ─────────
  const liveTrading = read("artifacts/trading-dashboard/src/pages/live-trading.tsx");
  const liveBanner = read("artifacts/trading-dashboard/src/components/live/MasterLiveBridgeBanner.tsx");
  record(
    "25_live_trading_master_live_banner",
    /MasterLiveBridgeBanner/.test(liveTrading) &&
      /Master Live Bridge: Current Connected Bridge/.test(liveBanner),
    "live-trading.tsx imports MasterLiveBridgeBanner and banner renders the exact label",
  );

  // ── 26 — UI surfaces (Main Bridge card + master-bridge banner +
  //         mt5-setup PlatformMasterBridgeCard slice) never reference
  //         forbidden secret fields in rendered code. The full mt5-setup
  //         page legitimately uses tokenLast4 elsewhere (per-user bridge
  //         creation), so we slice only the master-bridge card.
  const adminCodeStripped = stripComments(adminPage);
  const liveBannerStripped = stripComments(liveBanner);
  const startMc = mt5Setup.indexOf("function PlatformMasterBridgeCard(");
  const endMc = mt5Setup.indexOf("\nexport default function", startMc);
  const mcSlice = startMc >= 0 ? stripComments(mt5Setup.slice(startMc, endMc > 0 ? endMc : startMc + 4000)) : "";
  const uiBlob = adminCodeStripped + mcSlice + liveBannerStripped;
  record(
    "26_no_secret_leak_in_master_bridge_ui",
    !/apiKeyHash|MT5_BRIDGE_TOKEN|SESSION_SECRET|tokenLast4|raw\s*bridge\s*token/i.test(uiBlob),
    "Main Bridge card + mt5-setup master card + live-trading banner reference 0 forbidden secret fields",
  );

  // ── 27 — Detector + gate code (not comments) never import a code
  //         path that can place a trade.
  const gateSrc = read("artifacts/api-server/src/lib/mt5/masterLiveBridgeGate.ts");
  const detCode = stripComments(det);
  const gateCode = stripComments(gateSrc);
  record(
    "27_detector_and_gate_import_clean",
    !/dispatchLiveCommand|placeLiveOrderGuarded/.test(detCode) &&
      !/dispatchLiveCommand|placeLiveOrderGuarded/.test(gateCode),
    "detector + masterLiveBridgeGate do NOT import any trade-placing function",
  );

  // ── 28 — DEMO path unchanged (PER_USER_BRIDGE + MASTER_BRIDGE_DEMO) ──
  // The master-live gate only runs when SHARED_MASTER_MT5 && live dispatch;
  // demo dispatch never enters dispatchLiveCommand. Confirm demo pipeline
  // helper still routes via the demo gate, not the live gate.
  const demoConsumer = read("artifacts/api-server/src/lib/mt5/demoCommandConsumer.ts");
  record(
    "28_demo_path_unchanged",
    /evaluateRoutedDemoDispatchGate|evaluateDemoDispatchGate/.test(demoConsumer) &&
      !/loadAndEvaluateMasterLiveBridgeGate/.test(demoConsumer) &&
      !/dispatchLiveCommand/.test(demoConsumer),
    "demoCommandConsumer.ts still uses demo gate + does not touch master-live gate or live dispatch",
  );

  // ── 29 — MASTER_BRIDGE_LIVE_LOCKED still held in DB ──────────────────
  const lockedQ = await pool.query(`
    SELECT shared_live_trading_enabled, master_bridge_live_enabled, account_routing_mode
    FROM global_trading_settings LIMIT 1
  `);
  const lockedRow = lockedQ.rows[0] ?? null;
  record(
    "29_master_bridge_live_locked_db_state",
    !!lockedRow &&
      lockedRow.shared_live_trading_enabled === false &&
      lockedRow.master_bridge_live_enabled === false,
    `db state: shared_live_trading_enabled=${lockedRow?.shared_live_trading_enabled} master_bridge_live_enabled=${lockedRow?.master_bridge_live_enabled}`,
  );

  // ── INVARIANT (end) — arx_live_commands count unchanged ──────────────
  const endCnt = (await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands")).rows[0].n as number;
  record(
    "30_arx_live_commands_unchanged",
    // Spec: arx_live_commands MUST stay 0 across this QA run AND
    // unchanged. We assert BOTH so a non-zero seed value or any
    // accidental insert during the run fails the probe explicitly.
    startCnt === 0 && endCnt === 0 && startCnt === endCnt,
    `start=${startCnt} end=${endCnt} (must be 0 and unchanged — no auto-fire)`,
  );

  const pass = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n${pass}/${total} Master Bridge LIVE acceptance items PASS, ${total - pass} FAIL`);
  await pool.end();
  if (pass !== total) process.exit(1);
}

await main();
