// Task 497 — Ruby derived safety-envelope honesty + confirmation choreography.
//
// Proves Ruby REPORTS the user's real, per-user safety state (derived from
// getEnvelope via deriveAssistantEnvelope) — honest BOTH ways: open when the
// live path is open, locked with the REAL top blocker when it is locked —
// and that NO envelope value (not even a fully live-unlocked one) can open a
// Ruby dispatch path. Ruby stays a read-only actor: every requestLiveOrder is
// blocked at the AI action boundary BEFORE any gate or confirmation runs.
// Deriving the envelope changes only what Ruby *says*, never what it is
// *allowed to do*.
//
// Deterministic + DB-free for the reporting assertions: dispatchTool accepts an
// explicit envelope param, so deriveAssistantEnvelope (the only DB read on the
// reporting path) is short-circuited. requestLiveOrder touches the DB only for
// a swallowed audit insert, so its REJECTED verdict is deterministic.
//
// Run: pnpm --filter @workspace/scripts run test:ruby-safety-envelope

import { dispatchTool } from "../../artifacts/api-server/src/lib/assistant/tools.js";
import {
  buildPaperSafetyStatus,
  FAIL_CLOSED_ENVELOPE,
  type SafetyEnvelope,
} from "../../artifacts/api-server/src/lib/assistant/derivedEnvelope.js";
import { liveConfirmationGate } from "../../artifacts/api-server/src/lib/adminTrading/orderGuard.js";
import { evaluateAiActionBoundary } from "@workspace/domain/security";
import { db } from "@workspace/db";
import { tradeActionRequestsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass += 1;
    process.stdout.write(`PASS  ${name}\n`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    process.stdout.write(`FAIL  ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

const PLACEMENT_LITERAL = "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED";
const UID = 2147483097; // synthetic id — never a real user

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

// Crafted envelopes — DB-free. Spread the fail-closed default then override the
// fields each scenario needs, so the shapes stay valid as SafetyEnvelope grows.
const liveUnlockedEnv: SafetyEnvelope = {
  ...FAIL_CLOSED_ENVELOPE,
  tradingMode: "LIVE",
  globalLiveEnabled: true,
  userLiveApproved: true,
  emergencyKillSwitch: false,
  accountType: "live",
  allowOrderExecution: true,
  liveLocked: false,
  readOnlyMode: false,
  bannerLabel: "Live Trading Active",
  bannerReason: "Live trading active for your approved account.",
  safetyMode: "live",
};

const lockedDemoEnv: SafetyEnvelope = {
  ...FAIL_CLOSED_ENVELOPE,
  tradingMode: "DEMO",
  globalLiveEnabled: true,
  userLiveApproved: false,
  emergencyKillSwitch: false,
  accountType: "demo",
  allowOrderExecution: false,
  liveLocked: true,
  readOnlyMode: false,
  bannerLabel: "Demo Trading Active",
  bannerReason: "Live trading is not approved for your account yet.",
  safetyMode: "demo",
};

// ── Suite A — getTradingMode reports the DERIVED state, honest both ways ──────
process.stdout.write("\n── Suite A — getTradingMode derived honesty ──\n");
{
  const r = rec(await dispatchTool("getTradingMode", {}, UID, undefined, liveUnlockedEnv));
  check("A1 live-unlocked → top-level liveLocked === false", r["liveLocked"] === false, `liveLocked=${r["liveLocked"]}`);
  check("A2 live-unlocked → safetyMode === 'live' (NOT hardcoded paper_only)", r["safetyMode"] === "live", `safetyMode=${r["safetyMode"]}`);
  check("A3 live-unlocked → allowOrderExecution === true", r["allowOrderExecution"] === true, `allowOrderExecution=${r["allowOrderExecution"]}`);
  const nested = rec(r["envelope"]);
  check("A4 live-unlocked → nested envelope.liveLocked === false", nested["liveLocked"] === false, `envelope.liveLocked=${nested["liveLocked"]}`);
}
{
  const r = rec(await dispatchTool("getTradingMode", {}, UID, undefined, lockedDemoEnv));
  check("A5 locked-demo → top-level liveLocked === true", r["liveLocked"] === true, `liveLocked=${r["liveLocked"]}`);
  check("A6 locked-demo → safetyMode === 'demo' (NOT hardcoded paper_only)", r["safetyMode"] === "demo", `safetyMode=${r["safetyMode"]}`);
  check("A7 locked-demo → allowOrderExecution === false", r["allowOrderExecution"] === false, `allowOrderExecution=${r["allowOrderExecution"]}`);
}

// ── Suite B — getPaperSafetyStatus reports the real reason, honest both ways ──
process.stdout.write("\n── Suite B — getPaperSafetyStatus derived honesty ──\n");
{
  const r = rec(await dispatchTool("getPaperSafetyStatus", {}, UID, undefined, liveUnlockedEnv));
  check("B1 live-unlocked → reason advertises live availability", typeof r["reason"] === "string" && /available/i.test(r["reason"] as string), `reason=${JSON.stringify(r["reason"])}`);
  check("B2 live-unlocked → reason does NOT cite the legacy placement literal", typeof r["reason"] === "string" && !(r["reason"] as string).includes(PLACEMENT_LITERAL));
  check("B3 live-unlocked → overrideRequires === null", r["overrideRequires"] === null, `overrideRequires=${JSON.stringify(r["overrideRequires"])}`);
  check("B4 live-unlocked → liveLocked === false", r["liveLocked"] === false);
}
{
  const r = rec(await dispatchTool("getPaperSafetyStatus", {}, UID, undefined, lockedDemoEnv));
  check("B5 locked-demo → reason === the real top blocker (bannerReason)", r["reason"] === lockedDemoEnv.bannerReason, `reason=${JSON.stringify(r["reason"])}`);
  check("B6 locked-demo → reason does NOT cite the legacy placement literal", typeof r["reason"] === "string" && !(r["reason"] as string).includes(PLACEMENT_LITERAL));
  check("B7 locked-demo → overrideRequires is a non-empty string", typeof r["overrideRequires"] === "string" && (r["overrideRequires"] as string).length > 0);
  check("B8 locked-demo → liveLocked === true", r["liveLocked"] === true);
}

// ── Suite C — pure buildPaperSafetyStatus (DB-free, both ways + fail-closed) ──
process.stdout.write("\n── Suite C — buildPaperSafetyStatus pure derivation ──\n");
{
  const open = buildPaperSafetyStatus(liveUnlockedEnv);
  check("C1 open → overrideRequires === null", open.overrideRequires === null);
  check("C2 open → reason mentions availability + confirmation", /available/i.test(open.reason) && /confirmation/i.test(open.reason));
  check("C3 open → reason has no placement literal", !open.reason.includes(PLACEMENT_LITERAL));

  const locked = buildPaperSafetyStatus(lockedDemoEnv);
  check("C4 locked → reason === bannerReason", locked.reason === lockedDemoEnv.bannerReason);
  check("C5 locked → overrideRequires is a non-empty string", typeof locked.overrideRequires === "string" && locked.overrideRequires.length > 0);
  check("C6 locked → reason has no placement literal", !locked.reason.includes(PLACEMENT_LITERAL));

  const failClosed = buildPaperSafetyStatus(FAIL_CLOSED_ENVELOPE);
  check("C7 fail-closed → liveLocked === true AND overrideRequires non-null", failClosed.liveLocked === true && failClosed.overrideRequires !== null);
  check("C8 fail-closed → allowOrderExecution === false", failClosed.allowOrderExecution === false);
}

// ── Suite D — choreography: NO envelope opens a Ruby dispatch path ────────────
// Even with a fully live-unlocked envelope, Ruby's requestLiveOrder is blocked
// at the AI action boundary (read-only actor) BEFORE any gate or confirmation —
// regardless of confirmedByUser.
process.stdout.write("\n── Suite D — confirmation choreography preserved ──\n");
for (const confirmed of [false, true]) {
  const r = rec(
    await dispatchTool(
      "requestLiveOrder",
      { symbol: "EURUSD", side: "BUY", lotSize: 0.01, confirmedByUser: confirmed },
      UID,
      undefined,
      liveUnlockedEnv,
    ),
  );
  const inner = rec(r["result"]);
  check(`D1 requestLiveOrder(confirmedByUser=${confirmed}) → status REJECTED (never queued)`, inner["status"] === "REJECTED", `status=${inner["status"]}`);
  check(`D2 requestLiveOrder(confirmedByUser=${confirmed}) → blocked at AI boundary`, typeof inner["reason"] === "string" && (inner["reason"] as string).startsWith("AI_DIRECT_EXECUTION_BLOCKED"), `reason=${inner["reason"]}`);
}

// Defense-in-depth: the boundary evaluator denies Ruby LIVE even on the fully
// "approved-route" path — a read-only actor is unconditionally blocked.
{
  const b = evaluateAiActionBoundary({
    actorKind: "ruby",
    action: "LIVE_TRADE_EXECUTION",
    intentCreated: true,
    permissionChecked: true,
    handshakePassed: true,
    auditWritten: true,
    viaApprovedRoute: true,
  });
  check("D3 evaluateAiActionBoundary(ruby, LIVE) → allowed === false", b.allowed === false, `allowed=${b.allowed}`);
}

// D4 — even on a fully live-unlocked envelope, the ONLY trade-touching thing
// Ruby can produce is a SUGGEST-ONLY draft (status 'ai_suggested'). It is never
// confirmed, queued, or dispatched by the assistant; execution still requires
// the user's explicit confirmation from the Action Center. This proves the
// confirmation choreography step 7/8 is intact: a derived "live available"
// state does NOT let Ruby skip the human gesture.
{
  const r = rec(
    await dispatchTool(
      "createTradeActionDraft",
      { actionType: "OPEN", requestedMode: "LIVE", symbol: "EURUSD", side: "BUY", lotSize: 0.01 },
      UID,
      undefined,
      liveUnlockedEnv,
    ),
  );
  const action = rec(r["action"]);
  check("D4a createTradeActionDraft(LIVE, live-unlocked env) → ok === true", r["ok"] === true, `ok=${r["ok"]} err=${r["error"]}`);
  check("D4b draft status === 'ai_suggested' (suggest-only, NOT confirmed/queued/dispatched)", action["status"] === "ai_suggested", `status=${action["status"]}`);
  // Cleanup — trade_action_requests is a transient working table; remove the row.
  const draftId = Number(action["id"]);
  if (Number.isInteger(draftId) && draftId > 0) {
    try { await db.delete(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.id, draftId)); } catch { /* best-effort */ }
  }
}

// D5 — the live-confirmation gate (gate #7) is a pure, behavior-identical
// helper extracted from the order-guard chain. A LIVE order WITHOUT user
// confirmation is rejected with the exact literal; WITH confirmation it passes
// the gate; SIMULATED/DEMO never require the gesture. This is the manual /
// confirm-choreography gate (SAFETY_NOTES §6) the Ruby path never reaches —
// asserted here directly so the choreography invariant is locked at build time.
{
  check("D5a liveConfirmationGate(LIVE, confirmedByUser=false) === 'LIVE_CONFIRMATION_REQUIRED'", liveConfirmationGate("LIVE", false) === "LIVE_CONFIRMATION_REQUIRED");
  check("D5b liveConfirmationGate(LIVE, confirmedByUser=true) === null", liveConfirmationGate("LIVE", true) === null);
  check("D5c liveConfirmationGate(DEMO, confirmedByUser=false) === null", liveConfirmationGate("DEMO", false) === null);
  check("D5d liveConfirmationGate(SIMULATED, confirmedByUser=false) === null", liveConfirmationGate("SIMULATED", false) === null);
}

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail > 0) {
  process.stdout.write("\nFAILURES:\n");
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
// Importing tools.ts boots the market simulator + a DB pool, which keep the
// event loop alive; exit explicitly so the test process terminates (matches
// the routing QA tests' pattern).
process.exit(0);
