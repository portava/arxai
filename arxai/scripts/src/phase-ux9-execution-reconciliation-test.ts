export {};
// Phase UX9 — MT5 Execution Reconciliation & Trade Lifecycle Sync (20 scenarios).
// Black-box static + HTTP suite. Verifies the new schema columns, reconciler
// library, /api/mt5/execution-result route, stuck-command watchdog, AI tools,
// systemPrompt section, UI surfaces (modal + row + admin card), and safety
// invariants (no auto-open/close, no guard bypass, no fake fills, no secret
// leaks, idempotency, bridge-token gate).

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __d = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__d, "..", "..");
function repo(p: string): string { return resolve(REPO_ROOT, p); }
function readRepo(p: string): string {
  const full = repo(p);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

const BASE = process.env["BASE"] ?? "http://localhost:80";
type R = { name: string; pass: boolean; note?: string };
const results: R[] = [];
function record(name: string, pass: boolean, note?: string) {
  results.push({ name, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "✓" : "✗"} ${name}${note ? "  — " + note : ""}`);
}

async function http(path: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  try {
    const r = await fetch(`${BASE}${path}`, init);
    const body = await r.text();
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: (e as Error).message };
  }
}

(async () => {
  // ── Load relevant source files once ─────────────────────────────────────
  const schema       = readRepo("lib/db/src/schema/tradeActionRequests.ts") + "\n"
                     + readRepo("lib/db/src/schema/mt5Commands.ts") + "\n"
                     + readRepo("lib/db/src/schema/adminTrading.ts");
  const reconciler   = readRepo("artifacts/api-server/src/lib/mt5/executionReconciler.ts");
  const watchdog     = readRepo("artifacts/api-server/src/lib/mt5/stuckCommandWatchdog.ts");
  const mt5Routes    = readRepo("artifacts/api-server/src/routes/mt5.ts");
  const indexBoot    = readRepo("artifacts/api-server/src/index.ts");
  const tools        = readRepo("artifacts/api-server/src/lib/assistant/tools.ts");
  const systemPrompt = readRepo("artifacts/api-server/src/lib/assistant/systemPrompt.ts");
  const modal        = readRepo("artifacts/trading-dashboard/src/components/action-center/TradeActionReviewModal.tsx");
  const actionCenter = readRepo("artifacts/trading-dashboard/src/pages/action-center.tsx");
  const adminTrading = readRepo("artifacts/api-server/src/routes/adminTrading.ts");
  const adminPage    = readRepo("artifacts/trading-dashboard/src/pages/admin/trading-control.tsx");

  // ── 1. Schema: trade_action_requests has new execution columns ──────────
  {
    const cols = ["mt5OrderTicket", "mt5PositionTicket", "fillPrice", "slippage", "filledLotSize", "brokerMessage", "errorCode", "executedAt", "staleAt"];
    const missing = cols.filter((c) => !schema.includes(c));
    record("1. trade_action_requests has all UX9 execution columns", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : undefined);
  }

  // ── 2. Schema: mt5_commands has new execution mirror columns ────────────
  {
    const cols = ["fillPrice", "slippage", "brokerMessage", "filledLotSize", "staleAt"];
    const missing = cols.filter((c) => !schema.includes(c));
    record("2. mt5_commands has UX9 mirror columns", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : undefined);
  }

  // ── 3. Reconciler library exists and exports reconcileExecutionResult ───
  record("3. executionReconciler.ts exports reconcileExecutionResult",
    reconciler.includes("export") && reconciler.includes("reconcileExecutionResult"));

  // ── 4. Reconciler is idempotent on terminal commands ────────────────────
  record("4. Reconciler implements idempotency on terminal commands",
    /idempot|duplicate|already.*terminal|isTerminal|TERMINAL_STATUSES|TERMINAL_/i.test(reconciler));

  // ── 5. Reconciler updates live_positions (OPEN upsert / CLOSE / MODIFY) ─
  {
    const hasOpen = /livePositionsTable[\s\S]{0,400}OPEN/.test(reconciler);
    const hasClose = /CLOSED/.test(reconciler);
    const hasModify = /stopLoss|takeProfit/.test(reconciler);
    record("5. Reconciler covers OPEN/CLOSE/MODIFY in live_positions",
      hasOpen && hasClose && hasModify);
  }

  // ── 6. Reconciler updates shared_trade_attribution ──────────────────────
  record("6. Reconciler updates shared_trade_attribution",
    /sharedTradeAttribution/i.test(reconciler));

  // ── 7. Reconciler writes a timeline event ───────────────────────────────
  record("7. Reconciler writes trade_decision_timeline event",
    /timeline|appendTimeline|tradeDecisionTimeline|addTimelineEvent|recordTimeline/i.test(reconciler));

  // ── 8. Reconciler writes a notification ─────────────────────────────────
  record("8. Reconciler writes a notification",
    /notification|notify|notificationsTable|recordNotification/i.test(reconciler));

  // ── 9. Reconciler exposes brokerRejectionHint helper ────────────────────
  record("9. Reconciler exports brokerRejectionHint helper",
    /export\s+function\s+brokerRejectionHint|export\s+const\s+brokerRejectionHint/.test(reconciler));

  // ── 10. POST /api/mt5/execution-result route exists with bridge auth ────
  {
    const hasRoute = /\/mt5\/execution-result|execution-result/i.test(mt5Routes);
    const hasAuth = /bridgeAuthPerUserOnly|bridgeAuth/.test(mt5Routes);
    record("10. POST /api/mt5/execution-result is registered with bridge auth", hasRoute && hasAuth);
  }

  // ── 11. Stuck-command watchdog file exists and is wired into boot ───────
  {
    const hasSweep = /sweepStuckCommands|stuckCommandWatchdog|WATCHDOG_STALE/.test(watchdog);
    const wired = /startStuckCommandWatchdog|stuckCommandWatchdog|sweepStuckCommands/.test(indexBoot);
    record("11. Stuck-command watchdog defined and wired in index.ts", hasSweep && wired);
  }

  // ── 12. Watchdog uses 5-minute stale threshold ──────────────────────────
  record("12. Watchdog uses ~5min stale threshold",
    /5\s*\*\s*60\s*\*\s*1000|300\s*\*\s*1000|FIVE_MIN|STALE_MS|300_000/.test(watchdog));

  // ── 13. AI tools: all 4 UX9 tools registered ────────────────────────────
  {
    const t = ["getActionExecutionResult", "explainBrokerRejection", "getRecentExecutionResults", "getStuckCommandsForUser"];
    const missing = t.filter((n) => !tools.includes(n));
    record("13. All 4 UX9 AI tools present in tools.ts", missing.length === 0, missing.join(", ") || undefined);
  }

  // ── 14. systemPrompt updated with UX9 section ───────────────────────────
  record("14. systemPrompt has UX9 execution-awareness section",
    /UX9|getActionExecutionResult|fillPrice|explainBrokerRejection/.test(systemPrompt));

  // ── 15. Action Center modal surfaces all execution fields ───────────────
  {
    const fields = ["mt5OrderTicket", "mt5PositionTicket", "fillPrice", "slippage", "filledLotSize", "executedAt", "brokerMessage", "errorCode"];
    const missing = fields.filter((f) => !modal.includes(f));
    const hasRejectBadge = /Rejected by broker/.test(modal);
    const hasTimeoutBadge = /Action timed out|timed out/i.test(modal);
    record("15. Modal surfaces all UX9 execution fields + rejection/timeout badge",
      missing.length === 0 && hasRejectBadge && hasTimeoutBadge,
      missing.length ? `missing fields: ${missing.join(", ")}` : undefined);
  }

  // ── 16. Action Center row shows ticket + fill + slippage + broker line ──
  {
    const hasTicket = /mt5PositionTicket/.test(actionCenter);
    const hasFill = /fillPrice/.test(actionCenter);
    const hasBroker = /Broker:|rejectionReason/.test(actionCenter);
    record("16. Action Center row shows ticket + fill + broker rejection one-liner",
      hasTicket && hasFill && hasBroker);
  }

  // ── 17. Admin Execution Health card present ─────────────────────────────
  {
    const hasBackend = /\/admin\/trading\/execution-health/.test(adminTrading);
    const hasMetrics = /rejectionRate|stuck|sampleSize/.test(adminTrading);
    const hasCard = /Execution Health|card-execution-health/.test(adminPage);
    record("17. Admin Execution Health endpoint + card", hasBackend && hasMetrics && hasCard);
  }

  // ── 18. Bridge gate: /api/mt5/execution-result requires bridge token ────
  {
    const r = await http("/api/mt5/execution-result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: 1, status: "executed" }),
    });
    const blocked = r.status === 401 || r.status === 403 || r.status === 503;
    record("18. Bridge endpoint rejects unauthenticated requests", blocked, `status=${r.status}`);
  }

  // ── 19. Reconciler does NOT call any "place trade" / "open position"
  //       routine — it only mirrors what the broker already did.
  {
    const banned = ["createTradeCommand", "queueTradeOpen", "placeOrder", "createOrder", "runStrategyScan", "execute("];
    const triggers = banned.filter((b) => reconciler.includes(b));
    record("19. Reconciler never auto-opens or auto-closes trades", triggers.length === 0,
      triggers.length ? `forbidden symbols found: ${triggers.join(", ")}` : undefined);
  }

  // ── 20. No secret leaks anywhere in UX9 surface (excluding comments) ────
  {
    const stripComments = (s: string): string => s
      .split("\n").filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln)).join("\n");
    const bundle = stripComments(reconciler) + stripComments(watchdog)
                 + stripComments(tools) + stripComments(adminTrading)
                 + stripComments(adminPage);
    // Flag real reads of secrets (env access / object field returned), not
    // documentation strings.
    const leaks = /process\.env\[?["']?(MT5_BRIDGE_TOKEN|SESSION_SECRET)|apiKeyHash\s*:|tokenHash\s*:|\.apiKeyHash|\.tokenHash/.test(bundle);
    record("20. No bridge tokens, session secrets, or apiKeyHash leaked in UX9 code", !leaks);
  }

  // ── 21–30. Seeded multi-user fixture suite (real DB) ────────────────────
  // Delegated to artifacts/api-server/src/scripts/phase-ux9-multi-user-seed-test.ts
  // which has clean relative access to the reconciler, watchdog, and
  // placeLiveOrderGuarded. Spawned as a subprocess so this runner stays the
  // single entry point for `pnpm run test:ux9`.
  {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("pnpm",
      ["--filter", "@workspace/api-server", "exec", "tsx",
       "src/scripts/phase-ux9-multi-user-seed-test.ts"],
      { stdio: "inherit", cwd: REPO_ROOT, encoding: "utf8" });
    record("21–30. Seeded multi-user fixture suite (collision, idempotency, foreign-AR rejection, per-user watchdog, no auto-open, broker-verbatim, no secrets, PAPER_ONLY lock, placeLiveOrderGuarded gate, composite unique index)",
      r.status === 0,
      r.status === 0 ? undefined : `child exit=${r.status}`);
  }

  // ── summary ─────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  // eslint-disable-next-line no-console
  console.log(`\nPhase UX9: ${passed}/${results.length} scenarios passed${failed ? `, ${failed} FAILED` : ""}`);
  process.exit(failed === 0 ? 0 : 1);
})();
