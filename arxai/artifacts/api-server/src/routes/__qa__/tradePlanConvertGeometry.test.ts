// POST /trade-plans/:id/convert computed reward-to-risk with Math.abs for both
// distances and never read the plan's direction, so a READY BUY plan with the
// stop above entry and the target below it became a PENDING execution
// confirmation carrying rewardToRisk 2.0. Validation now refuses such a plan
// (checklist SL/TP/R:R FAIL); a READY row stored before that must not convert
// either, and a correctly sided plan still converts with the same R:R.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type Table } from "drizzle-orm";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let planRow: Record<string, unknown> = {};
const fake = createFakeDb({});
const db = {
  ...fake.db,
  select: (_cols?: unknown) => ({
    from: (table: Table) => {
      const rows = getTableName(table) === "trade_plans" ? [planRow] : [];
      const chain: Record<string, unknown> = {};
      const self: Record<string, unknown> = new Proxy(chain, {
        get(_t, prop) {
          if (prop === "then") return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(rows).then(ok, bad);
          return () => self;
        },
      });
      return self;
    },
  }),
  update: (_table: Table) => ({
    set: (v: Record<string, unknown>) => ({
      where: () => ({ returning: async () => [{ ...planRow, ...v }] }),
    }),
  }),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
};
mock.module("@workspace/db", { namedExports: { ...realDb, db } });
const router = (await import("../tradePlans.js")).default;

function plan(o: Record<string, unknown>): Record<string, unknown> {
  const now = new Date("2026-10-28T12:00:00.000Z");
  return {
    id: 5, userId: 7, symbol: "EURUSD", directionBias: "BUY", strategyId: null, marketCondition: "TRENDING",
    entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, lotSize: 0.1, riskAmount: 10, maxLossAllowed: 20,
    rewardToRiskTarget: null, confidenceLevel: 70, status: "READY", executionConfirmationId: null,
    aiSummary: null, checklistJson: null, notes: null, createdAt: now, updatedAt: now, ...o,
  };
}

async function convert(): Promise<{ status: number; body: Record<string, unknown> }> {
  let out = { status: 0, body: {} as Record<string, unknown> };
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/trade-plans/5/convert`, { method: "POST" });
    out = { status: r.status, body: await r.json() as Record<string, unknown> };
  });
  return out;
}

const confirmations = () => fake.inserts.filter((i) => i.table === "execution_confirmations");

test("a READY BUY with stop above and target below entry is not converted", async () => {
  planRow = plan({ stopLoss: 1.11, takeProfit: 1.08 });
  const before = confirmations().length;
  const { status, body } = await convert();
  assert.notEqual(status, 200, JSON.stringify(body));
  assert.match(String(body["error"]), /wrong side of entry/i);
  assert.equal(confirmations().length, before, "no execution confirmation is written");
});

test("a correctly sided READY plan converts with its directional R:R", async () => {
  planRow = plan({});
  const { status, body } = await convert();
  assert.equal(status, 200, JSON.stringify(body));
  const conf = confirmations().at(-1);
  assert.ok(conf, "a confirmation row was written");
  assert.ok(Math.abs(Number(conf!.values["rewardToRisk"]) - 2) < 1e-9);
});
