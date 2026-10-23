// CI guard — EA live-input telemetry (eaInputs) end-to-end behavior
//
// Proves the master-live bridge gate + admin diagnostic readout treat the
// EA-reported `eaInputs` block correctly:
//
//   1. eaInputs ALL good (terminalConnected/algoTradingAllowed=true,
//      readOnlyMode=false, enableLiveExecution=true) → bridge PASSes the
//      master-live capability gate.
//   2. A core eaInputs field MISSING (null) → bridge FAILS closed with
//      MASTER_BRIDGE_NOT_LIVE_CAPABLE. Missing is never defaulted to pass.
//   3. A core eaInputs field reported FALSE → bridge FAILS closed.
//   4. The admin diagnostic helper shows a MISSING field as "not reported"
//      (a distinct rawCode ending in _NOT_REPORTED), NOT as the
//      "disconnected"/"disabled" code reserved for a reported `false`.
//
// Pure logic — no DB, no network. Imports the real gate evaluator and the
// real diagnostic readout helper so this stays in lockstep with production.
import type { CheckResult } from "./_lib.js";
import {
  evaluateBridgeAsMasterLive,
  type DetectedBridgeEvidence,
} from "../../../artifacts/api-server/src/lib/mt5/currentConnectedBridgeDetector.js";
import { readEaBool } from "../../../artifacts/api-server/src/routes/adminLiveGatesDiagnostic.js";

type EaInputs = DetectedBridgeEvidence["eaInputs"];

function baseEvidence(eaInputs: EaInputs): DetectedBridgeEvidence {
  const now = Date.now();
  return {
    bridgeId: 1,
    userId: 4,
    mode: "LIVE",
    accountType: "live",
    eaVersion: "1.50",
    brokerName: "Deriv",
    serverName: "DerivSVG-Server",
    accountNumber: "62470041",
    lastHeartbeat: new Date(now - 3000),
    heartbeatAgeSec: 3,
    eaInputs,
    tokenRevokedAt: null,
  };
}

const ALL_GOOD: EaInputs = {
  terminalConnected: true,
  algoTradingAllowed: true,
  readOnlyMode: false,
  enableLiveExecution: true,
  enableDemoExecution: null,
  maxLiveLot: null,
};

export function checkEaInputsTelemetry(): CheckResult {
  const violations: string[] = [];

  // 1. All-good eaInputs → master-live capability gate PASSes.
  {
    const r = evaluateBridgeAsMasterLive(baseEvidence({ ...ALL_GOOD }));
    if (!r.ok) {
      violations.push(`all-good eaInputs should PASS the master-live gate, got block=${r.reason}`);
    }
  }

  // 2. Each core field MISSING (null) → FAIL closed with NOT_LIVE_CAPABLE.
  for (const field of ["terminalConnected", "algoTradingAllowed", "readOnlyMode", "enableLiveExecution"] as const) {
    const ea: EaInputs = { ...ALL_GOOD, [field]: null };
    const r = evaluateBridgeAsMasterLive(baseEvidence(ea));
    if (r.ok || r.reason !== "MASTER_BRIDGE_NOT_LIVE_CAPABLE") {
      violations.push(`missing ${field} should FAIL with MASTER_BRIDGE_NOT_LIVE_CAPABLE, got ${r.ok ? "PASS" : r.reason}`);
    }
  }

  // 3. Each core field reported in its BLOCKING value → FAIL closed.
  const blockingValues: Array<[keyof EaInputs, boolean]> = [
    ["terminalConnected", false],
    ["algoTradingAllowed", false],
    ["readOnlyMode", true],
    ["enableLiveExecution", false],
  ];
  for (const [field, badVal] of blockingValues) {
    const ea: EaInputs = { ...ALL_GOOD, [field]: badVal };
    const r = evaluateBridgeAsMasterLive(baseEvidence(ea));
    if (r.ok || r.reason !== "MASTER_BRIDGE_NOT_LIVE_CAPABLE") {
      violations.push(`${field}=${badVal} should FAIL with MASTER_BRIDGE_NOT_LIVE_CAPABLE, got ${r.ok ? "PASS" : r.reason}`);
    }
  }

  // 4. Diagnostic helper distinguishes "not reported" (null) from "false".
  const cfg = {
    passWhen: true as const,
    trueText: "connected",
    falseText: "disconnected",
    missingText: "Not reported by the EA — update the EA build.",
    trueCode: "TERMINAL_CONNECTED",
    falseCode: "TERMINAL_DISCONNECTED",
    missingCode: "TERMINAL_CONNECTED_NOT_REPORTED",
  };
  const missing = readEaBool(null, cfg);
  if (missing.status !== "fail") violations.push(`missing readEaBool status should be fail, got ${missing.status}`);
  if (missing.rawCode !== "TERMINAL_CONNECTED_NOT_REPORTED") {
    violations.push(`missing readEaBool rawCode should be the _NOT_REPORTED code, got ${missing.rawCode}`);
  }
  if (missing.rawCode === cfg.falseCode) {
    violations.push(`missing readEaBool must NOT collapse to the 'disconnected' code (${cfg.falseCode})`);
  }
  if (!/not reported/i.test(missing.detail)) {
    violations.push(`missing readEaBool detail should say "not reported", got "${missing.detail}"`);
  }
  const reportedFalse = readEaBool(false, cfg);
  if (reportedFalse.status !== "fail" || reportedFalse.rawCode !== "TERMINAL_DISCONNECTED") {
    violations.push(`reported-false readEaBool should be fail/TERMINAL_DISCONNECTED, got ${reportedFalse.status}/${reportedFalse.rawCode}`);
  }
  if (reportedFalse.rawCode === missing.rawCode) {
    violations.push(`reported-false and missing must produce distinct rawCodes`);
  }
  const reportedTrue = readEaBool(true, cfg);
  if (reportedTrue.status !== "pass" || reportedTrue.rawCode !== "TERMINAL_CONNECTED") {
    violations.push(`reported-true readEaBool should be pass/TERMINAL_CONNECTED, got ${reportedTrue.status}/${reportedTrue.rawCode}`);
  }
  // ReadOnlyMode passes when false (passWhen:false) — make sure that inverts.
  const roCfg = { ...cfg, passWhen: false as const };
  if (readEaBool(false, roCfg).status !== "pass") violations.push("readOnlyMode=false should PASS with passWhen:false");
  if (readEaBool(true, roCfg).status !== "fail") violations.push("readOnlyMode=true should FAIL with passWhen:false");

  return {
    name: "ea-inputs-telemetry",
    ok: violations.length === 0,
    violations,
    notes: violations.length === 0
      ? [
          "all-good eaInputs passes the master-live gate",
          "missing/false core fields fail closed (NOT_LIVE_CAPABLE)",
          "diagnostic shows missing as 'not reported', distinct from 'disconnected'",
        ]
      : [],
  };
}
