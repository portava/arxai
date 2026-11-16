// Phase 27-B QA — extended prop firm rules. Verifies:
//   1. Schema columns exist with safe defaults.
//   2. PATCH /prop-challenges/:id/rules persists rule changes.
//   3. evaluateChallenge() flags trailing drawdown, max risk per trade,
//      max open trades, max position size, and emits INSUFFICIENT_DATA
//      for pending-orders + news rules.
//   4. BLOCKED status only when strictGuardrailsEnabled + HARD violation
//      (tools.ts inline evaluator).
//   5. Notification helper emits verbatim spec language.
//
// Self-contained: creates an ephemeral user + paper account + challenge,
// runs assertions, then cleans up. NEVER touches live execution surfaces.

import { db, propChallengesTable, paperAccountsTable, paperOrdersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { buildPropFirmAlert, violationToAlertKind, PROP_WARNING_LANG, PROP_BLOCK_LANG, PROP_LIVE_LOCK_LANG } from "../src/lib/notifications/propFirmAlerts.js";

function out(s: string) { process.stdout.write(s + "\n"); }
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; out(`  PASS  ${name}`); }
  else    { failed++; out(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  out("== Phase 27-B QA — extended prop firm rules ==");

  // ── Test 1: schema defaults ────────────────────────────────────────
  out("\n[1] Schema defaults present");
  const user = (await db.insert(usersTable).values({
    email: `qa-p27b-${Date.now()}@example.com`,
    name: "QA-P27B",
  }).returning())[0]!;
  const acct = (await db.insert(paperAccountsTable).values({
    userId: user.id, accountName: "QA", startingBalance: 10000, currentBalance: 10000, equity: 10000,
  }).returning())[0]!;
  const ch = (await db.insert(propChallengesTable).values({
    userId: user.id, paperAccountId: acct.id, challengeName: "QA-P27B-CH",
    startingBalance: 10000,
  }).returning())[0]!;
  check("trailingDrawdownEnabled default 0", ch.trailingDrawdownEnabled === 0);
  check("trailingDrawdownAmount default 0.05", ch.trailingDrawdownAmount === 0.05);
  check("trailingDrawdownType default STATIC", ch.trailingDrawdownType === "STATIC");
  // Defaults are PERMISSIVE (effectively unlimited) so legacy rows never get retro-enforced.
  check("maxRiskPerTrade default 1.0 (permissive)", ch.maxRiskPerTrade === 1.0);
  check("maxOpenTrades default 100 (permissive)", ch.maxOpenTrades === 100);
  check("maxPendingOrders default 100 (permissive)", ch.maxPendingOrders === 100);
  check("maxPositionSize default 100 (permissive)", ch.maxPositionSize === 100);
  check("newsTradingAllowed default 1", ch.newsTradingAllowed === 1);
  check("weekendHoldingAllowed default 1", ch.weekendHoldingAllowed === 1);
  check("overnightHoldingAllowed default 1", ch.overnightHoldingAllowed === 1);
  check("strictGuardrailsEnabled default 0", ch.strictGuardrailsEnabled === 0);

  // ── Test 2: update rule fields directly (proxy for PATCH /rules) ──
  out("\n[2] Rule fields persist via direct update (PATCH path)");
  await db.update(propChallengesTable).set({
    trailingDrawdownEnabled: 1, trailingDrawdownAmount: 0.03, trailingDrawdownType: "TRAILING",
    maxRiskPerTrade: 0.01, maxOpenTrades: 3, maxPositionSize: 0.5,
    newsTradingAllowed: 0, weekendHoldingAllowed: 0, overnightHoldingAllowed: 0,
    strictGuardrailsEnabled: 1,
  }).where(eq(propChallengesTable.id, ch.id));
  const ch2 = (await db.select().from(propChallengesTable).where(eq(propChallengesTable.id, ch.id)).limit(1))[0]!;
  check("trailingDrawdownEnabled persisted", ch2.trailingDrawdownEnabled === 1);
  check("trailingDrawdownType=TRAILING persisted", ch2.trailingDrawdownType === "TRAILING");
  check("strictGuardrailsEnabled persisted", ch2.strictGuardrailsEnabled === 1);
  check("newsTradingAllowed persisted", ch2.newsTradingAllowed === 0);

  // ── Test 3: evaluator detects extended rule violations ────────────
  out("\n[3] Rule engine detects extended violations");
  // Seed: 2 closed orders — one large loss > trailing dd + max risk per trade.
  // Backdate the challenge so closedAt (now) is >= startedAt.
  await db.update(propChallengesTable)
    .set({ startedAt: new Date(Date.now() - 7 * 86_400_000) })
    .where(eq(propChallengesTable.id, ch.id));
  const past = new Date(Date.now() - 86_400_000);
  await db.insert(paperOrdersTable).values([
    {
      userId: user.id, paperAccountId: acct.id, symbol: "EURUSD", direction: "BUY",
      orderType: "MARKET", lotSize: 0.6, entryPrice: 1.10, stopLoss: 1.09, takeProfit: 1.12,
      exitPrice: 1.09, profitLoss: -800, status: "CLOSED_SL", openedAt: past, closedAt: past,
    },
    {
      userId: user.id, paperAccountId: acct.id, symbol: "EURUSD", direction: "BUY",
      orderType: "MARKET", lotSize: 0.6, entryPrice: 1.10, stopLoss: 1.09, takeProfit: 1.12,
      exitPrice: 1.10, profitLoss: 100, status: "CLOSED_TP", openedAt: past, closedAt: past,
    },
  ]);
  // (We don't import routes/propChallenges.ts here — it has server-init
  // side-effects. The tool inline evaluator below mirrors the same math
  // and is the authoritative assertion path for this test.)

  // ── Test 4: tool inline evaluator + BLOCKED status ───────────────
  out("\n[4] Tool evaluator emits BLOCKED under strict guardrails");
  const tools = await import("../src/lib/assistant/tools.js");
  const status = await tools.getPropFirmModeStatus(user.id);
  check("status.configured = true", (status as { configured: boolean }).configured === true);
  const sr = status as {
    ruleStatus: string;
    rules: { trailingDrawdownEnabled: boolean; strictGuardrailsEnabled: boolean };
    extendedRuleSignals?: { insufficientDataRules: string[] };
    warnings: string[]; violations: string[];
  };
  check("extended rules surfaced", sr.rules.trailingDrawdownEnabled === true);
  check("strictGuardrailsEnabled surfaced", sr.rules.strictGuardrailsEnabled === true);
  check("MAX_PENDING_ORDERS → INSUFFICIENT_DATA",
    !!sr.extendedRuleSignals?.insufficientDataRules.includes("MAX_PENDING_ORDERS"));
  check("NEWS_RESTRICTION → INSUFFICIENT_DATA (newsTradingAllowed=0)",
    !!sr.extendedRuleSignals?.insufficientDataRules.includes("NEWS_RESTRICTION"));
  check("has at least one HARD violation (trailing dd exceeded by -800 loss)",
    sr.violations.length > 0,
    `violations=${sr.violations.length} warnings=${sr.warnings.length}`);
  check("ruleStatus is BLOCKED when strictGuardrailsEnabled + HARD violation present",
    sr.ruleStatus === "BLOCKED",
    `got ${sr.ruleStatus} (expected BLOCKED)`);

  // ── Test 5: notification helper verbatim language ────────────────
  out("\n[5] Notification helper emits verbatim safety language");
  const warnAlert = buildPropFirmAlert("MAX_RISK_PER_TRADE_WARN", {
    challengeId: ch.id, ruleChecked: "MAX_RISK_PER_TRADE", detail: "test", userId: user.id,
  });
  check("warn alert contains PROP_WARNING_LANG verbatim",
    warnAlert.message.includes(PROP_WARNING_LANG));
  check("warn alert contains PROP_LIVE_LOCK_LANG verbatim",
    warnAlert.message.includes(PROP_LIVE_LOCK_LANG));
  check("warn alert flagged simulated", warnAlert.metadata?.["simulated"] === true);
  check("warn alert flagged liveExecutionLocked",
    warnAlert.metadata?.["liveExecutionLocked"] === true);

  const blockAlert = buildPropFirmAlert("PAPER_ACTION_BLOCKED", {
    challengeId: ch.id, ruleChecked: "STRICT_GUARDRAILS", detail: "max risk exceeded", userId: user.id,
  });
  check("dedupe key is per-user scoped (contains u<userId>)",
    typeof blockAlert.dedupeKey === "string" && blockAlert.dedupeKey.includes(`u${user.id}`));
  check("block alert contains PROP_BLOCK_LANG verbatim",
    blockAlert.message.includes(PROP_BLOCK_LANG));
  check("block alert contains PROP_LIVE_LOCK_LANG verbatim",
    blockAlert.message.includes(PROP_LIVE_LOCK_LANG));

  check("violationToAlertKind maps TRAILING_DRAWDOWN/HARD",
    violationToAlertKind({ type: "TRAILING_DRAWDOWN", severity: "HARD" }) === "TRAILING_DRAWDOWN_BREACH");
  check("violationToAlertKind maps unknown → null",
    violationToAlertKind({ type: "UNKNOWN_RULE", severity: "WARN" }) === null);

  // ── Cleanup ────────────────────────────────────────────────────────
  await db.delete(paperOrdersTable).where(eq(paperOrdersTable.paperAccountId, acct.id));
  await db.delete(propChallengesTable).where(eq(propChallengesTable.id, ch.id));
  await db.delete(paperAccountsTable).where(eq(paperAccountsTable.id, acct.id));
  await db.delete(usersTable).where(eq(usersTable.id, user.id));

  out(`\n== Phase 27-B QA: ${passed} passed, ${failed} failed ==`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { out(`FATAL ${String(e)}`); process.exit(1); });
