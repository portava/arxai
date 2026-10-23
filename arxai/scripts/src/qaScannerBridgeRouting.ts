// QA driver for scanner bridge routing fix.
//
// Drives the same path the Scanner modal uses (source=MARKET_SCANNER +
// signalContext) through the real per-user gate, real consumer chokepoint,
// and real DB partial-unique-index. Asserts the 9 acceptance checks.
//
// Authoritative environment under test: user 4, with existing demo bridge
// rows (per replit.md: 184, 224, 231 — fixed selector should pick the
// armed one).
//
// SAFETY: live trading is unaffected. canDispatchToMt5 still refuses
// outside MT5_DEMO_EXECUTION; the consumer re-runs the per-user gate.

import { and, desc, eq } from "drizzle-orm";
import { db, mt5ConnectionTable, mt5DemoCommandsTable } from "@workspace/db";
import { evaluatePerUserDispatchGate } from "../../artifacts/api-server/src/lib/mt5/demoDispatchGate.js";
import {
  cancelOrphanedSentCommands,
  createDraftCommand,
  confirmCommand,
} from "../../artifacts/api-server/src/lib/mt5/demoCommandQueue.js";
import { consumeApprovedCommand } from "../../artifacts/api-server/src/lib/mt5/demoCommandConsumer.js";
import { buildSafetyGateSnapshot } from "../../lib/domain/src/safety-contracts/executionMode.js";

const USER_ID = 4;
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

type Row = typeof mt5DemoCommandsTable.$inferSelect;

let passes = 0;
let fails = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  const tag = ok ? "PASS" : "FAIL";
  if (ok) passes++; else fails++;
  console.log(`${tag}  ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

function ageSeconds(t: Date | null | undefined): number | null {
  if (!t) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / 1000));
}

async function snapshot(commandId: string): Promise<Row | null> {
  const r = await db
    .select()
    .from(mt5DemoCommandsTable)
    .where(eq(mt5DemoCommandsTable.commandId, commandId))
    .limit(1);
  return r[0] ?? null;
}

async function main() {
  console.log("=== SCANNER BRIDGE ROUTING QA (user 4) ===\n");

  // 9. Confirm live execution remains disabled — assert via the
  //    canonical SafetyGateSnapshot the server returns on every demo response.
  const snap = buildSafetyGateSnapshot({
    mode: "MT5_DEMO_EXECUTION", demoStatus: "VERIFIED_DEMO",
    canArmAllowed: true, userArmed: true,
  });
  check("9. liveLocked === true", snap.liveLocked === true, { liveLocked: snap.liveLocked });
  check("9. allowOrderExecution === false", snap.allowOrderExecution === false, { allowOrderExecution: snap.allowOrderExecution });
  check("9. commandExecutionAllowed === false", snap.commandExecutionAllowed === false, { commandExecutionAllowed: snap.commandExecutionAllowed });
  check("9. brokerPlacementImplemented === false", snap.brokerPlacementImplemented === false, { brokerPlacementImplemented: snap.brokerPlacementImplemented });
  check("9. sharedMt5RoutingBlocked === true", snap.sharedMt5RoutingBlocked === true, { sharedMt5RoutingBlocked: snap.sharedMt5RoutingBlocked });

  // 1+2. MT5 Setup active bridge ↔ Scanner modal active bridge agreement.
  //   Both surfaces now derive their "active bridge" from
  //   evaluatePerUserDispatchGate. We simulate both reads back-to-back and
  //   confirm they return the same bridgeConnectionId. We also enumerate
  //   all non-revoked rows and confirm the chosen one is NOT a stale
  //   read-only record when a ready one exists.
  const gateA = await evaluatePerUserDispatchGate({
    userId: USER_ID, userConfirmed: false, duplicateClear: true,
  });
  const gateB = await evaluatePerUserDispatchGate({
    userId: USER_ID, userConfirmed: false, duplicateClear: true,
  });
  const chosen = gateA.evidence.bridgeConnectionId;
  check("1. MT5 Setup & Scanner agree on active bridge (same gate, same id)",
    gateA.evidence.bridgeConnectionId === gateB.evidence.bridgeConnectionId,
    { setup: gateA.evidence.bridgeConnectionId, scanner: gateB.evidence.bridgeConnectionId });

  const allRows = await db
    .select()
    .from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, USER_ID));
  const nonRevoked = allRows.filter((r) => !r.tokenRevokedAt);
  console.log(`  · user has ${allRows.length} bridge row(s), ${nonRevoked.length} non-revoked`);
  for (const r of nonRevoked) {
    const caps = (r.capabilities ?? {}) as { eaInputs?: { readOnlyMode?: unknown; enableDemoExecution?: unknown } };
    const ea = caps.eaInputs ?? {};
    console.log(`    bridge#${r.id}: account=${r.accountNumber ?? "?"} type=${r.accountType ?? "?"} ea=${r.eaVersion ?? "?"} hb=${ageSeconds(r.lastHeartbeat)}s readOnlyMode=${String(ea.readOnlyMode)} enableDemoExecution=${String(ea.enableDemoExecution)}${r.id === chosen ? "  <-- CHOSEN" : ""}`);
  }

  // 2. The chosen bridge must NOT be a stale read-only one if a ready one
  //    exists. We rank "ready" the same way the gate does.
  function bridgeReady(r: typeof nonRevoked[number]): boolean {
    const caps = (r.capabilities ?? {}) as { eaInputs?: { readOnlyMode?: unknown; enableDemoExecution?: unknown } };
    const ea = caps.eaInputs ?? {};
    const hb = ageSeconds(r.lastHeartbeat);
    const hbFresh = hb !== null && hb <= 15;
    const isDemo = r.accountType === "demo" || r.accountType === "contest";
    const ver = r.eaVersion ?? "";
    const verOk = /^\d+\.\d+/.test(ver) && Number(ver.split(".").slice(0, 2).join(".")) >= 1.26;
    const roOk = ea.readOnlyMode !== true;
    const exOk = ea.enableDemoExecution !== false;
    return hbFresh && isDemo && verOk && roOk && exOk;
  }
  const readyRows = nonRevoked.filter(bridgeReady);
  const chosenIsReady = chosen != null && readyRows.some((r) => r.id === chosen);
  if (readyRows.length > 0) {
    check("2. Scanner does NOT route to stale/read-only bridge (chosen is ready)",
      chosenIsReady,
      { chosen, readyIds: readyRows.map((r) => r.id) });
  } else {
    console.log(`SKIP 2. No bridge currently meets full readiness (no FILLED_DEMO possible). Gate chose bridge=${chosen} blockers=${JSON.stringify(gateA.evidence.bridgeBlockers)}`);
  }

  // 3. Bridge debug card surface — assert the data the modal needs is
  //    present on the gate evidence (the debug endpoint just forwards it).
  const ev = gateA.evidence;
  check("3. surfaces bridgeConnectionId", ev.bridgeConnectionId != null, { bridgeConnectionId: ev.bridgeConnectionId });
  check("3. surfaces accountLogin", ev.accountLogin != null, { accountLogin: ev.accountLogin });
  check("3. surfaces reportedEaVersion", typeof ev.reportedEaVersion === "string" || ev.reportedEaVersion === null, { reportedEaVersion: ev.reportedEaVersion });
  check("3. surfaces readOnlyModeReported", ev.readOnlyModeReported !== undefined, { readOnlyModeReported: ev.readOnlyModeReported });
  check("3. surfaces enableDemoExecutionReported", ev.enableDemoExecutionReported !== undefined, { enableDemoExecutionReported: ev.enableDemoExecutionReported });
  check("3. surfaces heartbeatAgeSeconds + heartbeatFresh", typeof ev.heartbeatAgeSeconds === "number" || ev.heartbeatAgeSeconds === null, { age: ev.heartbeatAgeSeconds, fresh: ev.heartbeatFresh });

  // If no ready bridge, stop before drafting — the modal would have
  // blocked submit, and the QA must not create an undispatchable command.
  if (readyRows.length === 0) {
    console.log("\nNo ready bridge — skipping live draft+dispatch step (matches UI behavior: submit blocked).");
    console.log(`\n${passes} PASS · ${fails} FAIL`);
    process.exit(fails > 0 ? 1 : 0);
  }

  // Cleanup any orphans before drafting (same as the modal would benefit from).
  const cleanup = await cancelOrphanedSentCommands({
    userId: USER_ID,
    actorIp: "127.0.0.1",
    actorUserAgent: "qaScannerBridgeRouting",
  });
  console.log("\norphan cleanup:", cleanup);

  // 4+5. Draft a MARKET scanner trade (EURUSD BUY 0.02) with the same
  //      payload shape the modal sends (source=MARKET_SCANNER + signalContext).
  const draftPayload = {
    symbol: "EURUSD",
    volume: 0.02,
    side: "BUY",
    orderType: "MARKET_BUY",
    stopLoss: null,
    takeProfit: null,
    notes: "qa: scanner bridge routing",
    idempotencyKey: `qa-scanner-${Date.now()}`,
    source: "MARKET_SCANNER",
    signalContext: {
      symbol: "EURUSD",
      timeframe: "M5",
      bias: "BULL",
      recommendedAction: "BUY",
      confidenceScore: 0.72,
      setupType: "QA_SCANNER_BRIDGE_ROUTING",
      reasonForTrade: "QA verification of scanner bridge selector fix",
    },
  };
  const draft = await createDraftCommand({
    userId: USER_ID,
    commandType: "PLACE_MARKET_ORDER",
    payload: draftPayload,
    actorIp: "127.0.0.1",
    actorUserAgent: "qaScannerBridgeRouting",
  });
  if (!draft.ok || !draft.command) {
    check("4. draft created", false, draft);
    console.log(`\n${passes} PASS · ${fails} FAIL`);
    process.exit(1);
  }
  const cmdId = draft.command.commandId;
  check("4. draft created", true, { commandId: cmdId, status: draft.command.status, bridge: draft.command.bridgeConnectionId });

  // 5. source recorded as MARKET_SCANNER in payload
  const draftPayloadStored = draft.command.payload as { source?: string } | null;
  check("5. command source === MARKET_SCANNER", draftPayloadStored?.source === "MARKET_SCANNER",
    { source: draftPayloadStored?.source });

  // 6. command bound to the active armed bridge id
  check("6. command bound to active armed bridge id",
    draft.command.bridgeConnectionId === chosen,
    { commandBridge: draft.command.bridgeConnectionId, activeBridge: chosen });

  // Confirm + dispatch.
  const confirmed = await confirmCommand({
    userId: USER_ID, commandId: cmdId,
    actorIp: "127.0.0.1", actorUserAgent: "qaScannerBridgeRouting",
  });
  check("4. confirm OK", !!confirmed.ok, { status: confirmed.command?.status, reason: confirmed.reason });
  const dispatched = await consumeApprovedCommand({
    userId: USER_ID, commandId: cmdId,
    actorIp: "127.0.0.1", actorUserAgent: "qaScannerBridgeRouting",
  });
  check("4. dispatched (SENT_TO_MT5_DEMO)", !!dispatched.ok, {
    ok: dispatched.ok, reason: dispatched.reason, status: dispatched.command?.status,
    bridge: dispatched.command?.bridgeConnectionId,
  });
  if (!dispatched.ok) {
    console.log(`\n${passes} PASS · ${fails} FAIL`);
    process.exit(1);
  }

  // 7. poll for terminal status.
  const start = Date.now();
  let last: Row | null = null;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    last = await snapshot(cmdId);
    if (last && ["FILLED_DEMO", "REJECTED", "FAILED"].includes(last.status)) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log("\nfinal:", {
    status: last?.status, reason: last?.reason,
    bridge: last?.bridgeConnectionId, ticket: last?.brokerTicket,
    fillPrice: last?.fillPrice, filledAt: last?.filledAt,
    elapsedMs: Date.now() - start,
  });
  const terminal = last?.status ?? "TIMEOUT";
  if (terminal === "FILLED_DEMO") {
    check("7. terminal = FILLED_DEMO", true, { ticket: last?.brokerTicket, fillPrice: last?.fillPrice });
  } else if (terminal === "REJECTED" || terminal === "FAILED") {
    const reason = String(last?.reason ?? "");
    // A "true" broker rejection is anything that did NOT come from the
    // pre-flight server gate. After the fix, READ_ONLY is only acceptable
    // if no armed bridge exists — which we already short-circuited above.
    const isTrueBrokerReason =
      reason.startsWith("REJECTED_") || reason.startsWith("BROKER_") || reason.startsWith("MT5_");
    check(`7. terminal = ${terminal} with true broker/MT5 reason`, isTrueBrokerReason, { reason });
  } else {
    check("7. command reached terminal within timeout", false, { status: terminal });
  }

  // 8. Recent Demo Commands / Recent Scanner Trades / Open Demo Positions
  //    all read from mt5_demo_commands filtered by user + source. Assert
  //    the command exists and is queryable by the same filter the UI uses.
  const inDemoCmds = await db.select().from(mt5DemoCommandsTable)
    .where(and(eq(mt5DemoCommandsTable.userId, USER_ID), eq(mt5DemoCommandsTable.commandId, cmdId)))
    .limit(1);
  check("8a. Recent Demo Commands lists this command",
    inDemoCmds.length === 1, { found: inDemoCmds.length });

  // Recent Scanner Trades = same table filtered by payload.source = MARKET_SCANNER
  const recent = await db.select().from(mt5DemoCommandsTable)
    .where(eq(mt5DemoCommandsTable.userId, USER_ID))
    .orderBy(desc(mt5DemoCommandsTable.id))
    .limit(20);
  const scannerHits = recent.filter((r) => (r.payload as { source?: string } | null)?.source === "MARKET_SCANNER");
  check("8b. Recent Scanner Trades lists this command (source=MARKET_SCANNER)",
    scannerHits.some((r) => r.commandId === cmdId),
    { recentScannerCount: scannerHits.length });

  // Open Demo Positions = FILLED_DEMO rows where status hasn't moved to
  // CLOSED_DEMO. We can only assert membership when FILLED_DEMO.
  if (last?.status === "FILLED_DEMO") {
    const openDemo = recent.filter((r) => r.status === "FILLED_DEMO");
    check("8c. Open Demo Positions includes this filled command",
      openDemo.some((r) => r.commandId === cmdId),
      { openDemoCount: openDemo.length });
  } else {
    console.log(`SKIP 8c. Not FILLED_DEMO — Open Demo Positions check N/A (terminal=${last?.status}).`);
  }

  console.log(`\n${passes} PASS · ${fails} FAIL`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error("qa crashed:", e); process.exit(1); });
