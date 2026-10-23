// Live-Position Truth contract (Phase 1) — advisory-tool refusal lock (DB-backed).
//
// The pure suite (positionTruthContract.test.ts) proves the resolver/adapter
// verdict. THIS suite proves the verdict is actually ENFORCED at every Ruby
// advisory tool that returns directional / hold-close / decision guidance: a row
// the broker never verified must yield the withheld payload, never advice. It
// guards specifically against the bypass class where a tool resolves a
// user-owned row directly (resolveUserTrade) and answers without consulting the
// truth gate.
//
// It seeds REAL rows under a single throwaway user and invokes the real tool
// functions, so it lives in the integration lane (imports @workspace/db). The
// withheld branch returns before any market-data / orchestrator call, so the
// assertions are deterministic (no external feed dependency). Cleans up every
// seeded row in reverse FK order in `after`.
//
// SAFETY: read-only advisory tools only. No live trade, no broker call, no gate
// is exercised or weakened.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "@workspace/db";
import {
  usersTable,
  mt5ConnectionTable,
  livePositionsTable,
} from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import {
  getTradeIntelligenceTool,
  prepareCloseReviewTool,
  getExitPlanTool,
  getTradeMarketContextTool,
  getTradeDecisionTool,
} from "../../assistant/tools.js";

const stamp = Date.now();
let userId = 0;
let connId = 0;
let unsyncedKey = "";
let verifiedKey = "";

before(async () => {
  const [u] = await db.insert(usersTable).values({
    email: `truthgate-${stamp}@arx.test`, name: "TruthGate QA", role: "user",
    passwordHash: "x", emailVerified: true,
  } as never).returning();
  userId = (u as { id: number }).id;

  // A non-demo connection with a fresh positions snapshot makes the verified
  // row resolve as snapshot-reliable (so it classifies as verified_live_position
  // rather than being downgraded for an unreliable snapshot).
  const [c] = await db.insert(mt5ConnectionTable).values({
    userId, connectionName: "TruthGate live", accountNumber: "9900001",
    brokerName: "TestBroker", accountType: "live", status: "connected",
    lastPositionsSnapshotAt: new Date(),
  } as never).returning();
  connId = (c as { id: number }).id;

  const now = new Date();
  // Unsynced row — no broker ticket → unsynced_unknown → advice withheld.
  const [unsynced] = await db.insert(livePositionsTable).values({
    userId, brokerPositionId: null, symbol: "EURUSD", direction: "BUY",
    lotSize: 0.1, entryPrice: 1.085, currentPrice: 1.086,
    stopLoss: 1.08, takeProfit: 1.10, unrealizedProfitLoss: 1,
    status: "OPEN", openedAt: now, lastSyncedAt: now,
  } as never).returning();
  unsyncedKey = `lp_${(unsynced as { id: number }).id}`;

  // Verified row — broker ticket + fresh full fields → verified_live_position.
  const [verified] = await db.insert(livePositionsTable).values({
    userId, brokerPositionId: "123456789", symbol: "EURUSD", direction: "BUY",
    lotSize: 0.1, entryPrice: 1.085, currentPrice: 1.086,
    stopLoss: 1.08, takeProfit: 1.10, unrealizedProfitLoss: 11,
    status: "OPEN", openedAt: now, lastSyncedAt: now,
  } as never).returning();
  verifiedKey = `lp_${(verified as { id: number }).id}`;
});

after(async () => {
  if (userId > 0) {
    await db.delete(livePositionsTable).where(eq(livePositionsTable.userId, userId));
    if (connId > 0) await db.delete(mt5ConnectionTable).where(inArray(mt5ConnectionTable.id, [connId]));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  }
});

// Every advisory tool that takes a tradeKey and returns directional / decision /
// exit / close-review / market-context guidance MUST refuse an unverified row.
const advisoryTools: ReadonlyArray<readonly [string, (u: number, k: string) => Promise<unknown>]> = [
  ["getTradeIntelligenceTool", getTradeIntelligenceTool],
  ["prepareCloseReviewTool", prepareCloseReviewTool],
  ["getExitPlanTool", getExitPlanTool],
  ["getTradeMarketContextTool", getTradeMarketContextTool],
  ["getTradeDecisionTool", getTradeDecisionTool],
];

for (const [name, fn] of advisoryTools) {
  test(`${name} — withholds advice on an unsynced (not broker-verified) row`, async () => {
    const r = (await fn(userId, unsyncedKey)) as Record<string, unknown>;
    assert.equal(r["ok"], false, `${name} must not return ok:true for an unverified row`);
    assert.equal(r["reason"], "POSITION_NOT_VERIFIED",
      `${name} must withhold with POSITION_NOT_VERIFIED (got ${JSON.stringify(r["reason"])})`);
    assert.equal(r["adviceAllowed"], false, `${name} must report adviceAllowed:false`);
  });
}

// Block-only proof: the gate must NOT over-block. A genuinely verified live row
// still gets real advice (no POSITION_NOT_VERIFIED), so this is purely a
// withholding contract, never a blanket refusal.
test("verified row is NOT withheld — block-only, never over-blocks", async () => {
  const r = (await getTradeIntelligenceTool(userId, verifiedKey)) as Record<string, unknown>;
  assert.notEqual(r["reason"], "POSITION_NOT_VERIFIED",
    "a verified live position must still receive advice (block-only contract)");
});

// Cross-user isolation: another user's id can never resolve this row to advice.
test("foreign user cannot get advice on this row (not-found, never leaked)", async () => {
  const foreign = userId - 1; // a different, non-owning id
  const r = (await getTradeDecisionTool(foreign, verifiedKey)) as Record<string, unknown>;
  assert.equal(r["ok"], false, "foreign user must not receive a successful decision");
});
