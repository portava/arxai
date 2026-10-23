// Admin — Live Gates Diagnostic
//
// GET /api/admin/live-gates/diagnostic
//
// One-stop, gate-by-gate, plain-English readout of the live execution
// pipeline state. Each entry is { id, label, status: pass|fail|info,
// detail, rawCode }. Sorted in the order an operator should read them.
//
// SECURITY:
//   - requireAdmin (ADMIN or OWNER session). Anonymous or regular user
//     requests get 403.
//   - NEVER returns raw bridge tokens, key hashes, credential hashes,
//     server secrets, the legacy server-wide bridge env value, or full
//     broker account numbers. Account number is masked to the last 4
//     digits; broker name and server name ARE returned (admins need
//     them to identify the bridge), but only to admin sessions.
//   - No write side-effects. Pure read.
import express, { type IRouter, Router, type Request, type Response } from "express";
import { db, globalTradingSettingsTable, userOneClickSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  derivePlatformBridgeMode,
} from "@workspace/domain/safety-contracts";
import { detectCurrentConnectedBridge } from "../lib/mt5/currentConnectedBridgeDetector.js";
import { liveBrokerExecutionEnabled } from "../lib/live/phaseBConfig.js";
import { loadAndEvaluateMasterLiveBridgeGate } from "../lib/mt5/masterLiveBridgeGate.js";

const router: IRouter = Router();
router.use(express.json());

function requireAdmin(req: Request, res: Response): boolean {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return false;
  }
  const role = sess.role ?? null;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return false;
  }
  return true;
}

type GateStatus = "pass" | "fail" | "info";
interface GateRow {
  id: string;
  label: string;
  status: GateStatus;
  detail: string;
  rawCode?: string;
}

function maskAccount(n: string | null): string {
  if (!n) return "—";
  const s = String(n);
  if (s.length <= 4) return `••••${s}`;
  return `••••${s.slice(-4)}`;
}

export interface EaBoolReadout {
  status: GateStatus;
  detail: string;
  rawCode: string;
}

/**
 * Pure helper that maps a reported EA boolean to a diagnostic readout while
 * keeping THREE distinct states apart:
 *   - `null`/`undefined` → "not reported" (the EA build does not emit this
 *     field yet). This is NOT the same as the field being reported `false`,
 *     and NOT the same as the bridge being disconnected.
 *   - `false`           → reported off (a real, actionable operator state).
 *   - `true`            → reported on.
 * `passWhen` is the value that counts as a PASS (e.g. ReadOnlyMode passes when
 * `false`, terminalConnected passes when `true`). Missing always fails closed.
 * Exported for the CI guard test.
 */
export function readEaBool(
  value: boolean | null | undefined,
  cfg: {
    passWhen: boolean;
    trueText: string;
    falseText: string;
    missingText: string;
    trueCode: string;
    falseCode: string;
    missingCode: string;
  },
): EaBoolReadout {
  if (value === null || value === undefined) {
    return { status: "fail", detail: cfg.missingText, rawCode: cfg.missingCode };
  }
  const isPass = value === cfg.passWhen;
  return {
    status: isPass ? "pass" : "fail",
    detail: value ? cfg.trueText : cfg.falseText,
    rawCode: value ? cfg.trueCode : cfg.falseCode,
  };
}

function fmtReported(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return "not reported";
  return v ? "yes" : "no";
}

function fmtArm(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return "?";
  return v ? "on" : "off";
}

router.get("/admin/live-gates/diagnostic", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const settingsRows = await db.select().from(globalTradingSettingsTable).limit(1);
  const s = settingsRows[0];
  const switchOn = liveBrokerExecutionEnabled();
  const platform = derivePlatformBridgeMode({
    platformMode: s?.platformMode,
    accountRoutingMode: s?.accountRoutingMode,
    masterBridgeLiveEnabled: !!s?.masterBridgeLiveEnabled,
    sharedLiveTradingEnabled: !!s?.sharedLiveTradingEnabled,
    liveBrokerExecutionEnabled: switchOn,
  });

  const detector = await detectCurrentConnectedBridge();
  const masterGate = await loadAndEvaluateMasterLiveBridgeGate();

  // ARX Single Confirm is a per-user app setting. Read THIS admin's own row
  // so the diagnostic clearly separates it from the (unreadable) MT5 terminal
  // one-click checkbox below.
  const adminUserId = (req as Request & { authUser?: { id: number } }).authUser?.id ?? 0;
  const ocRows = adminUserId
    ? await db.select().from(userOneClickSettingsTable)
        .where(eq(userOneClickSettingsTable.userId, adminUserId)).limit(1)
    : [];
  const arxSingleConfirmLiveOn = !!ocRows[0]?.liveOneClickEnabled;

  const rows: GateRow[] = [];

  rows.push({
    id: "platform_bridge_mode",
    label: "Platform bridge mode",
    status: "info",
    detail: platform.headline,
    rawCode: platform.mode,
  });

  // ── One-click disambiguation (two DISTINCT concepts) ─────────────────
  // (1) MT5 terminal "One Click Trading" (Options → Trade) is a terminal-side
  //     UI convenience setting. MQL5 does NOT expose it to EAs, so the bridge
  //     genuinely cannot read it. ARX never gates live dispatch on it.
  rows.push({
    id: "mt5_terminal_one_click",
    label: "MT5 terminal One-Click Trading",
    status: "info",
    detail:
      "Not readable by ARX. This is an MT5 terminal UI setting (Options → Trade → One Click Trading) and is not exposed to EAs via MQL5. ARX neither reads it nor blocks live trading on it.",
    rawCode: "MT5_ONE_CLICK_NOT_READABLE_BY_BRIDGE",
  });
  // (2) ARX "Single Confirm" (a.k.a. one-click live) is the APP-side, per-user
  //     setting in MT5 Setup → One-Click Trade. THIS is what makes chart
  //     BUY/SELL skip the manual confirm step. When OFF, the open is refused
  //     with LIVE_ONE_CLICK_DISABLED — but every safety gate still runs.
  rows.push({
    id: "arx_single_confirm_live",
    label: "ARX Single Confirm — live (this admin)",
    status: arxSingleConfirmLiveOn ? "pass" : "info",
    detail: arxSingleConfirmLiveOn
      ? "ON for your account — chart/instant BUY/SELL will use a single Confirm (all 16 live gates still run)."
      : "OFF for your account — chart/instant live opens return LIVE_ONE_CLICK_DISABLED. Enable it in MT5 Setup → One-Click Trade (typed confirmation). This is unrelated to the MT5 terminal one-click checkbox above.",
    rawCode: arxSingleConfirmLiveOn ? "ARX_SINGLE_CONFIRM_LIVE_ON" : "ARX_SINGLE_CONFIRM_LIVE_OFF",
  });

  rows.push({
    id: "server_master_switch",
    label: "Server master switch (ARX_LIVE_BROKER_EXECUTION_ENABLED)",
    status: switchOn ? "pass" : "fail",
    detail: switchOn
      ? "Server master switch is ON. The 16-gate evaluator is allowed to consider PASSing."
      : "Server master switch is OFF. Every live dispatch is refused with BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED.",
    rawCode: switchOn ? "LIVE_BROKER_EXECUTION_ENABLED" : "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
  });

  rows.push({
    id: "kill_switch",
    label: "Operator kill switch",
    status: s?.killSwitchEngagedAt ? "fail" : "pass",
    detail: s?.killSwitchEngagedAt
      ? `Kill switch engaged at ${new Date(s.killSwitchEngagedAt).toISOString()}${s.killSwitchReason ? ` — ${s.killSwitchReason}` : ""}.`
      : "Kill switch is not engaged.",
    rawCode: s?.killSwitchEngagedAt ? "KILL_SWITCH_ENGAGED" : "KILL_SWITCH_CLEAR",
  });

  rows.push({
    id: "trading_mode",
    label: "Global trading mode",
    status: (s?.platformMode ?? "OFF").toUpperCase() === "LIVE" ? "pass" : "info",
    detail: `Currently ${(s?.platformMode ?? "OFF").toUpperCase()}.`,
    rawCode: s?.platformMode ?? "OFF",
  });

  rows.push({
    id: "account_routing_mode",
    label: "Account routing mode",
    status: "info",
    detail: (s?.accountRoutingMode ?? "USER_OWNED_MT5") === "SHARED_MASTER_MT5"
      ? "Shared master MT5 bridge (admin operator-funded pilot)."
      : "Each user runs their own MT5 bridge.",
    rawCode: s?.accountRoutingMode ?? "USER_OWNED_MT5",
  });

  rows.push({
    id: "shared_live_trading_enabled",
    label: "shared_live_trading_enabled",
    status: s?.sharedLiveTradingEnabled ? "pass" : "fail",
    detail: s?.sharedLiveTradingEnabled
      ? "Shared live trading is enabled."
      : "Shared live trading is disabled — master bridge stays read-only.",
    rawCode: s?.sharedLiveTradingEnabled ? "SHARED_LIVE_ON" : "SHARED_LIVE_TRADING_DISABLED",
  });

  rows.push({
    id: "master_bridge_live_enabled",
    label: "master_bridge_live_enabled",
    status: s?.masterBridgeLiveEnabled ? "pass" : "fail",
    detail: s?.masterBridgeLiveEnabled
      ? "Master bridge is allowed to execute live (subject to all other gates)."
      : "Master bridge is read-only (admin has not enabled live execution).",
    rawCode: s?.masterBridgeLiveEnabled ? "MASTER_BRIDGE_LIVE_ON" : "MASTER_BRIDGE_LIVE_NOT_ENABLED",
  });

  rows.push({
    id: "master_bridge_binding",
    label: "Master bridge binding",
    status: masterGate.decision === "PASS" ? "pass" : "fail",
    detail: masterGate.decision === "PASS"
      ? `Bound to bridge id ${masterGate.boundBridgeId}.`
      : `Bridge gate refusing: ${masterGate.primaryReason}.`,
    rawCode: masterGate.decision === "PASS" ? "MASTER_BRIDGE_BOUND" : masterGate.primaryReason,
  });

  // EA evidence — only render when detector saw a bridge. Mask account.
  const ev = detector.ok ? detector.bridge : detector.latestHint;
  if (ev) {
    rows.push({
      id: "ea_version",
      label: "EA version",
      status: ev.eaVersion ? "info" : "fail",
      detail: ev.eaVersion ? `EA reports v${ev.eaVersion}.` : "EA has not reported a version yet.",
      rawCode: ev.eaVersion ?? "EA_VERSION_UNKNOWN",
    });
    // Mirror the real dispatch gate #6 (livePhaseBDispatchGate): the bridge
    // accountType is normalised case-insensitively and live/real both pass.
    // The EA reports lowercase "live"/"real" (from ACCOUNT_TRADE_MODE), so a
    // case-sensitive check here would falsely show FAIL while the real gate
    // PASSes. Keep this readout in lockstep with the gate it reports on.
    const acctNorm = (ev.accountType ?? "").trim().toLowerCase();
    const acctIsLive = acctNorm === "live" || acctNorm === "real";
    rows.push({
      id: "ea_account_type",
      label: "Account type",
      status: acctIsLive ? "pass" : "fail",
      detail: acctIsLive
        ? `Reported as ${ev.accountType} — recognised as a LIVE/REAL account.`
        : `Reported as ${ev.accountType ?? "?"}. Live dispatch requires a LIVE/REAL account.`,
      rawCode: ev.accountType,
    });
    rows.push({
      id: "ea_heartbeat",
      label: "EA heartbeat age",
      status: ev.heartbeatAgeSec != null && ev.heartbeatAgeSec <= 15 ? "pass" : "fail",
      detail: ev.heartbeatAgeSec == null
        ? "No heartbeat received yet."
        : `Last heartbeat ${ev.heartbeatAgeSec}s ago (must be ≤15s for live).`,
      rawCode: ev.heartbeatAgeSec != null && ev.heartbeatAgeSec <= 15 ? "EA_HEARTBEAT_FRESH" : "MASTER_BRIDGE_HEARTBEAT_STALE",
    });
    const readOnlyRead = readEaBool(ev.eaInputs.readOnlyMode, {
      passWhen: false,
      trueText: "EA is in ReadOnlyMode — operator must set ReadOnlyMode=false in MT5 EA inputs.",
      falseText: "EA reports ReadOnlyMode=false.",
      missingText: "Not reported by the EA (different from ReadOnlyMode=true). Update to an EA build that emits eaInputs.readOnlyMode.",
      trueCode: "REJECTED_READ_ONLY_MODE_ACTIVE",
      falseCode: "EA_READ_ONLY_OFF",
      missingCode: "EA_READ_ONLY_NOT_REPORTED",
    });
    rows.push({
      id: "ea_read_only",
      label: "EA input: ReadOnlyMode",
      status: readOnlyRead.status,
      detail: readOnlyRead.detail,
      rawCode: readOnlyRead.rawCode,
    });
    const enableLiveRead = readEaBool(ev.eaInputs.enableLiveExecution, {
      passWhen: true,
      trueText: "EA reports EnableLiveExecution=true (ARM #2 / AllowOrderExecution).",
      falseText: "EA input EnableLiveExecution is false — operator must enable ARM #2 (AllowOrderExecution) in MT5.",
      missingText: "Not reported by the EA (different from EnableLiveExecution=false). Update to an EA build that emits eaInputs.enableLiveExecution.",
      trueCode: "EA_LIVE_ENABLED",
      falseCode: "EA_LIVE_DISABLED",
      missingCode: "EA_LIVE_NOT_REPORTED",
    });
    rows.push({
      id: "ea_enable_live_execution",
      label: "EA input: EnableLiveExecution",
      status: enableLiveRead.status,
      detail: enableLiveRead.detail,
      rawCode: enableLiveRead.rawCode,
    });
    const terminalRead = readEaBool(ev.eaInputs.terminalConnected, {
      passWhen: true,
      trueText: "MT5 terminal reports connected to broker.",
      falseText: "MT5 terminal is NOT connected to broker (terminal offline / logged out).",
      missingText: "Not reported by the EA (different from terminal disconnected). Update to an EA build that emits eaInputs.terminalConnected.",
      trueCode: "TERMINAL_CONNECTED",
      falseCode: "TERMINAL_DISCONNECTED",
      missingCode: "TERMINAL_CONNECTED_NOT_REPORTED",
    });
    rows.push({
      id: "ea_terminal_connected",
      label: "EA input: terminalConnected",
      status: terminalRead.status,
      detail: terminalRead.detail,
      rawCode: terminalRead.rawCode,
    });
    const algoBreakdown = `terminalTradeAllowed=${fmtReported(ev.eaInputs.terminalTradeAllowed)}, mqlTradeAllowed=${fmtReported(ev.eaInputs.mqlTradeAllowed)}, accountTradeAllowed=${fmtReported(ev.eaInputs.accountTradeAllowed)}, expertTradeAllowed=${fmtReported(ev.eaInputs.expertTradeAllowed)}`;
    const algoRead = readEaBool(ev.eaInputs.algoTradingAllowed, {
      passWhen: true,
      trueText: `Algorithmic trading is allowed in MT5 (${algoBreakdown}).`,
      falseText: `Algorithmic trading is disabled in MT5 — operator must enable it (${algoBreakdown}).`,
      missingText: `Not reported by the EA (different from algo trading disabled). Update to an EA build that emits eaInputs.algoTradingAllowed (${algoBreakdown}).`,
      trueCode: "ALGO_TRADING_ALLOWED",
      falseCode: "ALGO_TRADING_DISABLED",
      missingCode: "ALGO_TRADING_NOT_REPORTED",
    });
    rows.push({
      id: "ea_algo_trading_allowed",
      label: "EA input: algoTradingAllowed",
      status: algoRead.status,
      detail: algoRead.detail,
      rawCode: algoRead.rawCode,
    });
    rows.push({
      id: "ea_arm_switches",
      label: "EA ARM switches",
      status: "info",
      detail: `#1 ReadOnly=${fmtArm(ev.eaInputs.arm1)}, #2 OrderSend=${fmtArm(ev.eaInputs.arm2OrderSend)}, #3 Pending=${fmtArm(ev.eaInputs.arm3)}, #4 ProtectionModify=${fmtArm(ev.eaInputs.arm4)}, #5 PositionClose=${fmtArm(ev.eaInputs.arm5)}, #6 PendingCancel=${fmtArm(ev.eaInputs.arm6)}, #7 PendingModify=${fmtArm(ev.eaInputs.arm7)}, #8 EmergencyClose=${fmtArm(ev.eaInputs.arm8)}.`,
      rawCode: "EA_ARM_SWITCHES",
    });
    rows.push({
      id: "ea_max_live_lot",
      label: "EA input: MaxLiveLot",
      status: "info",
      detail: ev.eaInputs.maxLiveLot != null ? `MaxLiveLot=${ev.eaInputs.maxLiveLot}.` : "MaxLiveLot not reported.",
      rawCode: ev.eaInputs.maxLiveLot != null ? `MAX_LIVE_LOT_${ev.eaInputs.maxLiveLot}` : "MAX_LIVE_LOT_UNSET",
    });
    rows.push({
      id: "broker_account",
      label: "Broker account",
      status: "info",
      detail: `Broker=${ev.brokerName ?? "—"}, server=${ev.serverName ?? "—"}, account=${maskAccount(ev.accountNumber)}.`,
      rawCode: `BROKER_ID_${ev.bridgeId}`,
    });
  } else {
    rows.push({
      id: "ea_present",
      label: "EA bridge presence",
      status: "fail",
      detail: "No connected bridge detected.",
      rawCode: detector.ok ? "EA_PRESENT" : detector.primaryReason,
    });
  }

  rows.push({
    id: "broker_placement_layer",
    label: "Broker placement layer",
    status: switchOn ? "pass" : "fail",
    detail: switchOn
      ? "Phase B broker dispatch layer is wired and the master switch is ON."
      : "Phase B broker dispatch layer is wired but the master switch is OFF. No real money can leave.",
    rawCode: switchOn ? "BROKER_PLACEMENT_LAYER_ACTIVE" : "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
  });

  return res.json({
    ok: true,
    platformBridgeMode: platform.mode,
    platformHeadline: platform.headline,
    nextPlatformStep: platform.nextPlatformStep,
    gates: rows,
  });
});

export default router;
