// Simulator OMS — every order, fill, stop, target and close goes through the
// pre-trade Risk Governor for the user driving it, on a real database.
//
// Proves:
//   - the raw book mutators are no longer exported; only governed entry
//     points can change the book,
//   - an order without a stop is refused (RISK_REJECTED, rule named) and the
//     refusal is written to that user's user_risk_events trail,
//   - an allowed order is audited, re-checked at fill, and fills,
//   - an automated origin cannot widen a stop; a manual tighten is allowed,
//   - break-even is refused when it would widen the stop,
//   - closing is allowed and audited,
//   - the autopilot refuses to place anything without an accountable user.
//
// Run: pnpm --filter @workspace/api-server run test:oms-governance

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, userRiskEventsTable, usersTable } from "@workspace/db";
import * as oms from "../oms.js";
import { marketSimulator } from "../marketSimulator.js";

const EMAIL = "qa+oms-governance@arx.test";
let userId = 0;
const SYMBOL = "EURUSD";

async function deleteFixtures(): Promise<void> {
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, EMAIL));
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await db.delete(userRiskEventsTable).where(inArray(userRiskEventsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

async function events() {
  return db.select().from(userRiskEventsTable)
    .where(and(eq(userRiskEventsTable.userId, userId)))
    .orderBy(desc(userRiskEventsTable.id));
}

function price(): number {
  const q = marketSimulator.quote(SYMBOL);
  assert.ok(q, "simulator quotes EURUSD");
  return q.ask;
}

async function openGoverned(): Promise<oms.Position> {
  const p = price();
  const { order, governance } = await oms.placeOrder({
    environment: "PAPER", source: "MANUAL", symbol: SYMBOL, direction: "BUY", lotSize: 0.01,
    stopLoss: Number((p - 0.002).toFixed(5)), takeProfit: Number((p + 0.004).toFixed(5)),
  }, { userId });
  assert.equal(governance.allowed, true, governance.reason ?? "");
  const filled = await oms.fillOrder(order.orderId, { userId });
  assert.ok(filled.ok, filled.ok ? "" : filled.message);
  assert.ok(filled.value.position, filled.value.error);
  return filled.value.position!;
}

before(async () => {
  await deleteFixtures();
  const [u] = await db.insert(usersTable).values({ email: EMAIL, name: "QA OMS", role: "USER", isSystemUser: true })
    .returning({ id: usersTable.id });
  userId = u!.id;
});
beforeEach(async () => {
  await db.delete(userRiskEventsTable).where(eq(userRiskEventsTable.userId, userId));
});
after(deleteFixtures);

test("only governed entry points are exported; raw book mutators are private", () => {
  for (const raw of ["createOrder", "patchOrder", "cancelOrder", "submitToSimulator", "closePosition",
    "partialClose", "moveStop", "moveTakeProfit", "moveStopToBreakEven", "applyTrailingStop"]) {
    assert.equal((oms as Record<string, unknown>)[raw], undefined, `${raw} must not be exported`);
  }
  const routes = readFileSync(new URL("../../routes/oms.ts", import.meta.url), "utf8");
  for (const fn of ["placeOrder", "fillOrder", "amendOrder", "closeOmsPosition", "moveOmsStop", "moveOmsStopToBreakEven"]) {
    assert.match(routes, new RegExp(`\\b${fn}\\(`), `routes/oms.ts uses ${fn}`);
  }
});

test("an order without a stop is refused by the governor, named and audited", async () => {
  const { order, governance } = await oms.placeOrder({
    environment: "PAPER", source: "MANUAL", symbol: SYMBOL, direction: "BUY", lotSize: 0.01,
  }, { userId });
  assert.equal(governance.allowed, false);
  assert.ok(governance.blockedBy.length > 0);
  assert.equal(order.status, "RISK_REJECTED");
  const [ev] = await events();
  assert.equal(ev!.id, governance.auditEventId);
  assert.equal(ev!.decision, "block");
  const d = ev!.details as Record<string, unknown>;
  assert.equal(d["caller"], "simulator_oms");
  assert.equal((d["intent"] as { venue: string }).venue, "PAPER");
  const fill = await oms.fillOrder(order.orderId, { userId });
  assert.equal(fill.ok, false, "a refused order can never be filled");
});

test("an allowed order is audited at placement and again at fill, then fills", async () => {
  const pos = await openGoverned();
  assert.equal(pos.status, "OPEN");
  const evs = await events();
  const passes = evs.filter((e) => e.decision === "pass" && (e.details as Record<string, unknown>)["caller"] === "simulator_oms");
  assert.ok(passes.length >= 2, `placement and fill each audited (got ${passes.length})`);
  await oms.closeOmsPosition(pos.positionId, { userId });
});

test("an automated origin cannot widen a stop; a manual tighten is allowed", async () => {
  const pos = await openGoverned();
  const wider = Number((pos.stopLoss! - 0.003).toFixed(5));
  const auto = await oms.moveOmsStop(pos.positionId, wider, { userId, origin: "automation" });
  assert.equal(auto.ok, false);
  assert.equal(auto.ok ? null : auto.error, "risk_blocked");
  assert.equal(oms.getPosition(pos.positionId)!.stopLoss, pos.stopLoss, "the stop is unchanged after a refusal");
  const tighter = Number((pos.stopLoss! + 0.0005).toFixed(5));
  const manual = await oms.moveOmsStop(pos.positionId, tighter, { userId });
  assert.ok(manual.ok, manual.ok ? "" : manual.message);
  assert.equal(oms.getPosition(pos.positionId)!.stopLoss, tighter);
  await oms.closeOmsPosition(pos.positionId, { userId });
});

test("break-even is refused when the stop is already past entry", async () => {
  const pos = await openGoverned();
  // The trailing-stop tick can carry a stop past entry; stand that in directly.
  const live = oms.getPosition(pos.positionId)!;
  const past = Number((pos.entryPrice + 0.0003).toFixed(5));
  live.stopLoss = past;
  const be = await oms.moveOmsStopToBreakEven(pos.positionId, { userId });
  assert.equal(be.ok ? null : be.error, "would_widen");
  assert.equal(oms.getPosition(pos.positionId)!.stopLoss, past, "the stop is not pulled back to entry");
  await oms.closeOmsPosition(pos.positionId, { userId });
});

test("closing a position is allowed and audited as a close", async () => {
  const pos = await openGoverned();
  const r = await oms.closeOmsPosition(pos.positionId, { userId, origin: "automation" });
  assert.ok(r.ok, r.ok ? "" : r.message);
  assert.notEqual(oms.getPosition(pos.positionId)!.status, "OPEN");
  const [ev] = await events();
  assert.equal((ev!.details as { intent: { action: string } }).intent.action, "CLOSE");
  const again = await oms.closeOmsPosition(pos.positionId, { userId });
  assert.equal(again.ok ? null : again.error, "not_open");
});

test("the autopilot refuses to place an order without an accountable user", () => {
  const src = readFileSync(new URL("../autopilot.ts", import.meta.url), "utf8");
  assert.match(src, /NO_ACCOUNTABLE_OPERATOR/);
  assert.doesNotMatch(src, /\bcreateOrder\(|\bsubmitToSimulator\(/);
});

test("the paper trade journal is journal-only: one writer, no execution imports, labelled", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = new URL("../../", import.meta.url).pathname;
  const writers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== "__qa__" && name !== "node_modules") walk(full); continue; }
      if (!name.endsWith(".ts")) continue;
      if (/\b(insert|update|delete)\(paperTradesTable\)/.test(readFileSync(full, "utf8"))) writers.push(full.slice(root.length));
    }
  };
  walk(root);
  assert.deepEqual(writers, ["routes/mePaperTrades.ts"]);
  const src = readFileSync(new URL("../../routes/mePaperTrades.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from "\.\.\/lib\/(oms|paper\/|live\/|mt5\/|trading\/)/, "the journal imports no execution path");
  assert.match(src, /recordKind: "journal"/);
  assert.match(src, /executionCapable: false/);
});
