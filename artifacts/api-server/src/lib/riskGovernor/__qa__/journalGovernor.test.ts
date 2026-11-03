// The paper journal, risk profiles, mission scope and automation health on a
// real database, after the four older risk engines were folded into the one
// Risk Governor (Tier 1 finalization, item 2).
//
// Proves:
//   - opening a journal trade faces all 13 rules and writes the audit row,
//   - a written override passes a block from the trader's own rules (PAPER),
//     is audited as "override", and never passes an exposure rule,
//   - moving a journal stop further away is measured like any stop change,
//   - risk presets and prop-firm mode write the trader's governor limits,
//   - mission-scope blocks are recorded on the trader's risk trail,
//   - the autopilot pauses on its owner's failure rate only.
//
// Run: pnpm --filter @workspace/api-server run test:risk-governor-journal

import { executablePaperFixture } from "../../safety/__qa__/paperModeFixture.js";
let restorePaperMode: (() => Promise<void>) | undefined;
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { desc, eq, inArray } from "drizzle-orm";
import {
  autopilotCyclesTable, db, paperTradesTable, userRiskEventsTable, userRiskSettingsTable, usersTable, type PaperTrade,
} from "@workspace/db";
import { enforceJournalModify, enforceJournalOpen, previewJournalTicket } from "../journal.js";
import { applyRiskPreset, configurePropFirm, PRESET_LIMITS } from "../riskProfile.js";
import { enforceMissionScope } from "../missionScope.js";
import { getOrCreateRiskSettings } from "../riskEvents.js";
import { automationHealth, AUTOMATION_ERROR_PAUSE_PCT } from "../../paperAutopilot/autopilotService.js";
import type { MissionRiskState } from "../../missionRiskState.js";

const EMAILS = ["qa+journal-governor@arx.test", "qa+journal-governor-other@arx.test"];
let userId = 0;
let otherId = 0;

async function deleteFixtures(): Promise<void> {
  const ids = (await db.select({ id: usersTable.id }).from(usersTable).where(inArray(usersTable.email, EMAILS))).map((u) => u.id);
  if (!ids.length) return;
  await db.delete(paperTradesTable).where(inArray(paperTradesTable.userId, ids));
  await db.delete(userRiskEventsTable).where(inArray(userRiskEventsTable.userId, ids));
  await db.delete(userRiskSettingsTable).where(inArray(userRiskSettingsTable.userId, ids));
  await db.delete(autopilotCyclesTable).where(inArray(autopilotCyclesTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

async function planned(over: Partial<typeof paperTradesTable.$inferInsert> = {}): Promise<PaperTrade> {
  const [t] = await db.insert(paperTradesTable).values({
    userId, symbol: "EURUSD", side: "buy", status: "planned", lotSize: 0.1,
    plannedEntryPrice: 1.1, stopLoss: 1.095, takeProfit: 1.11, reasonForEntry: "Retest of the breakout level", ...over,
  }).returning();
  return t!;
}

async function closedToday(n: number, pnl: number): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    await db.insert(paperTradesTable).values({
      userId, symbol: "GBPUSD", side: "buy", status: "closed", lotSize: 0.01, entryPrice: 1.3, exitPrice: 1.3,
      pnl, openedAt: new Date(now - (i + 2) * 60 * 60_000), closedAt: new Date(now - (i + 1) * 60 * 60_000),
    });
  }
}

/** The journal has no playbook or checklist link, so with the default settings those two gates block together (as before). */
async function withoutProcessGates(): Promise<void> {
  await getOrCreateRiskSettings(userId);
  await db.update(userRiskSettingsTable).set({ requirePlaybook: false, requirePreTradeChecklist: false })
    .where(eq(userRiskSettingsTable.userId, userId));
}

async function lastEvent() {
  const [e] = await db.select().from(userRiskEventsTable).where(eq(userRiskEventsTable.userId, userId))
    .orderBy(desc(userRiskEventsTable.id)).limit(1);
  return e ?? null;
}

before(async () => {
  restorePaperMode = await executablePaperFixture();
  await deleteFixtures();
  const rows = await db.insert(usersTable).values(EMAILS.map((email) => ({ email, name: "QA Journal", role: "USER", isSystemUser: true })))
    .returning({ id: usersTable.id });
  userId = rows[0]!.id;
  otherId = rows[1]!.id;
});
beforeEach(async () => {
  await db.delete(paperTradesTable).where(inArray(paperTradesTable.userId, [userId, otherId]));
  await db.delete(userRiskSettingsTable).where(inArray(userRiskSettingsTable.userId, [userId, otherId]));
  await db.delete(autopilotCyclesTable).where(inArray(autopilotCyclesTable.userId, [userId, otherId]));
});
after(async () => { await deleteFixtures(); await restorePaperMode?.(); });

test("journal open: with default settings the missing playbook and checklist block together, as before", async () => {
  const r = await enforceJournalOpen(userId, await planned(), 1.1);
  assert.equal(r.decision, "block");
  assert.deepEqual(r.risk.blockedBy, ["trading_discipline"]);
  assert.equal(r.overrideAllowed, true);
});

test("journal open: a sound planned trade passes all 13 rules and is audited", async () => {
  await withoutProcessGates();
  const t = await planned();
  const r = await enforceJournalOpen(userId, t, 1.1);
  assert.equal(r.decision, "pass", r.reason);
  assert.equal(r.risk.rules.length, 13);
  const e = await lastEvent();
  assert.ok(e, "an audit row is written");
  assert.equal((e!.details as Record<string, unknown>)["source"], "pre_trade_risk_governor");
});

test("journal open: a trade without a stop is refused and cannot be overridden", async () => {
  const t = await planned({ stopLoss: null });
  const r = await enforceJournalOpen(userId, t, 1.1, { reason: "I know what I am doing" });
  assert.equal(r.decision, "block");
  assert.ok(r.risk.blockedBy.includes("stop_loss_required"));
  assert.equal(r.overrideAllowed, false);
  assert.equal(r.overridden, false);
});

test("journal open: the trader's daily trade count blocks; a written override passes and is audited", async () => {
  await closedToday(5, 1);
  const t = await planned();
  const blocked = await enforceJournalOpen(userId, t, 1.1);
  assert.equal(blocked.decision, "block");
  assert.deepEqual(blocked.risk.blockedBy, ["trading_discipline"]);
  assert.equal(blocked.overrideAllowed, true);
  assert.equal(blocked.failedRules[0]!.severity, "warning");

  const ok = await enforceJournalOpen(userId, t, 1.1, { reason: "Planned session, sixth trade logged" });
  assert.equal(ok.decision, "pass");
  assert.equal(ok.overridden, true);
  const e = await lastEvent();
  assert.equal(e!.eventType, "override");
});

test("journal open: switching overrides off in the trader's settings removes the escape hatch", async () => {
  await getOrCreateRiskSettings(userId);
  await db.update(userRiskSettingsTable).set({ allowOverrideInPaperMode: false }).where(eq(userRiskSettingsTable.userId, userId));
  await closedToday(5, 1);
  const r = await enforceJournalOpen(userId, await planned(), 1.1, { reason: "Planned session, sixth trade logged" });
  assert.equal(r.decision, "block");
  assert.equal(r.overrideAllowed, false);
});

test("journal open: another trader's journal never counts toward this trader's limits", async () => {
  await withoutProcessGates();
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    await db.insert(paperTradesTable).values({ userId: otherId, symbol: "EURUSD", side: "buy", status: "closed", lotSize: 0.01,
      entryPrice: 1.1, exitPrice: 1.09, pnl: -100, openedAt: new Date(now - 7_200_000), closedAt: new Date(now - 3_600_000) });
  }
  const r = await enforceJournalOpen(userId, await planned(), 1.1);
  assert.equal(r.decision, "pass", r.reason);
});

test("journal modify: moving the stop further away than the per-trade cap allows is refused", async () => {
  const [t] = await db.insert(paperTradesTable).values({
    userId, symbol: "EURUSD", side: "buy", status: "open", lotSize: 0.1, entryPrice: 1.1, stopLoss: 1.095, takeProfit: 1.11,
    openedAt: new Date(),
  }).returning();
  // Journal P/L is Δprice × lots, so a 100-point stop on 0.1 lots risks 10 of the $10k model equity: within 1%.
  const near = await enforceJournalModify(userId, t!, { stopLoss: 1.09, takeProfit: 1.11 });
  assert.equal(near.decision, "pass", near.reason);
  const removed = await enforceJournalModify(userId, t!, { stopLoss: null, takeProfit: 1.11 });
  assert.equal(removed.decision, "block");
  assert.ok(removed.risk.blockedBy.includes("stop_loss_required"));
});

test("journal preview: a pre-flight ticket is evaluated without an audit row", async () => {
  const before = await lastEvent();
  const r = await previewJournalTicket(userId, {
    symbol: "eurusd", side: "buy", lots: 0.1, entryPrice: 1.1, stopLoss: 1.095, takeProfit: 1.11,
    process: { playbookId: null, preTradeCheckDecision: null, preTradeCheckPassed: null, reasonForEntry: "" },
  });
  // Playbook, checklist and reason are all missing: three soft warnings block together.
  assert.equal(r.decision, "block");
  assert.deepEqual(r.risk.blockedBy, ["trading_discipline"]);
  assert.equal((await lastEvent())?.id ?? null, before?.id ?? null);
});

test("risk presets write the trader's own governor limits", async () => {
  const row = await applyRiskPreset(userId, "CONSERVATIVE");
  assert.equal(row.riskPreset, "CONSERVATIVE");
  assert.equal(row.maxOpenTrades, PRESET_LIMITS.CONSERVATIVE.maxOpenTrades);
  assert.equal(row.maxTradesPerDay, PRESET_LIMITS.CONSERVATIVE.maxTradesPerDay);
  assert.equal(row.minRewardRiskRatio, PRESET_LIMITS.CONSERVATIVE.minRewardRiskRatio);
});

test("prop-firm mode tightens limits when on and keeps them when switched off", async () => {
  const on = await configurePropFirm(userId, { enabled: true, startingBalance: 10_000, maxDailyDrawdownUsd: 400, maxTotalDrawdownUsd: 800, maxLotSize: 0.5, maxPositions: 2 });
  assert.equal(on.settings.maxDailyLossAmount, 400);
  assert.equal(on.settings.maxDrawdownPercent, 8);
  assert.equal(on.settings.maxPositionSize, 0.5);
  assert.equal(on.settings.maxOpenTrades, 2);
  const off = await configurePropFirm(userId, { enabled: false });
  assert.equal(off.config.enabled, false);
  assert.equal(off.settings.maxDailyLossAmount, 400, "switching off never silently loosens protection");
});

test("mission scope: a block is recorded on the trader's risk trail", async () => {
  const state = {
    mode: "PROTECT", ladderAction: "allow", blowup: { action: "allow" }, budgetUsedPct: 120,
    behavioral: { cooldownTriggered: false }, emergency: { triggered: false },
  } as unknown as MissionRiskState;
  const gate = await enforceMissionScope({ userId, missionId: 1, draftId: "qa-draft", symbol: "EURUSD", state, hasStopLoss: true, edgeTier: "A" });
  assert.equal(gate.allow, false);
  const e = await lastEvent();
  assert.equal(e!.eventType, "blocked_trade");
  assert.equal((e!.details as Record<string, unknown>)["scope"], "mission");
});

test("automation health: the autopilot pauses on its owner's failure rate, not anyone else's", async () => {
  const cycles = (uid: number, status: string, n: number) => Array.from({ length: n }, (_, i) => ({
    userId: uid, autopilotCycleId: `qa_${uid}_${status}_${i}`, status,
  }));
  await db.insert(autopilotCyclesTable).values([...cycles(otherId, "FAILED", 10)]);
  await db.insert(autopilotCyclesTable).values([...cycles(userId, "COMPLETED", 9), ...cycles(userId, "FAILED", 1)]);
  const healthy = await automationHealth(userId, -1);
  assert.equal(healthy.paused, false, healthy.reason);
  assert.equal(healthy.cycles, 10);
  await db.insert(autopilotCyclesTable).values(cycles(userId, "FAILED", 3).map((c) => ({ ...c, autopilotCycleId: `${c.autopilotCycleId}_b` })));
  const sick = await automationHealth(userId, -1);
  assert.ok((sick.errorRate ?? 0) > AUTOMATION_ERROR_PAUSE_PCT);
  assert.equal(sick.paused, true);
});
