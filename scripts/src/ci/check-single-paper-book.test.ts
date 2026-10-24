import assert from "node:assert/strict";
import {
  LEGACY_BOOK, PAPER_JOURNAL, PAPER_VENUE, PIPELINE, checkBookShape, checkSinglePaperBook, scanFile,
} from "./check-single-paper-book.js";

let n = 0;
const fails = (source: string, key = "routes/newSurface.ts") => {
  n++;
  assert.ok(scanFile(key, source).length > 0, `expected a violation in ${key}: ${source}`);
};
const passes = (source: string, key = "routes/newSurface.ts") => {
  n++;
  assert.deepEqual(scanFile(key, source), [], `${key}: ${source}`);
};

// ── Writers outside the one owner of each table ──
fails('import { paperOrdersTable } from "@workspace/db"; await db.insert(paperOrdersTable).values(row)');
fails('import { paperOrdersTable as po } from "@workspace/db"; await db.update(po).set({ status: "CLOSED_TP" })');
fails('const { paperTradeEventsTable: ev } = await import("@workspace/db"); await db.insert(ev).values(row)');
fails('await tx.delete(schema["paperOrdersTable"])');
fails("await db.insert(schema.paperTradesTable).values(row)");
fails('await db.update(tradesTable).set({ status: "CANCELLED" })');
fails('await client.query("UPDATE trades SET status = $1 WHERE id = $2", ["CLOSED", 1])');
fails("await db.execute(sql`insert into paper_orders (symbol) values (${s})`)");
fails('await db.execute(sql`delete from "public"."paper_trade_events" where id = ${id}`)');
fails("await db.execute(sql`truncate table paper_trades`)");
// The pre-change writers (main @ 516f13e) now fail.
fails("await db.insert(paperOrdersTable).values(row)", "lib/paperExecution/paperExecutionService.ts");
fails("await db.update(paperOrdersTable).set({ status })", "lib/paperExecution/paperExecutionMonitor.ts");
fails("await db.insert(paperTradeEventsTable).values(row)", "lib/paperExecution/paperExecutionMonitor.ts");
fails("await db.insert(paperOrdersTable).values(row)", "routes/autoDebrief.ts");
fails("await db.insert(tradesTable).values(row)", "routes/trades.ts");
fails('await db.update(tradesTable).set({ status: "CANCELLED" })', "routes/bot.ts");
// Wrong book for the owner.
fails("await db.insert(tradesTable).values(row)", PAPER_VENUE);
fails("await db.insert(paperOrdersTable).values(row)", PAPER_JOURNAL);
fails("await db.insert(paperTradesTable).values(row)", LEGACY_BOOK);

// ── Book functions called from unlisted files ──
fails("await openPaperFill(args)");
fails("await venue.settlePaperOrder(a)", "lib/paperAutopilot/autopilotService.ts");
fails('await venue["voidPaperOrder"](id)');
fails("await openPaperOrder(a)", "routes/paperTrading.ts"); // the ticket goes through submitTrade
fails("await applyPaperManagement(1, step)", "routes/tradeManagement.ts");
fails("await recordLegacyExecuteTrade(row)", "routes/bot.ts");
fails("await cancelOpenLegacyTrades(u)", "routes/trades.ts");
// The journal never books.
fails('import { openPaperFill } from "../lib/tradeEngine/paperVenue.js";', PAPER_JOURNAL);
fails('const b = await import("../lib/trades/paperBook.js");', PAPER_JOURNAL);

// ── Allowed ──
passes("await db.insert(paperOrdersTable).values(row); await db.insert(paperTradeEventsTable).values(e)", PAPER_VENUE);
passes("await db.update(paperTradesTable).set({ status: 'closed' })", PAPER_JOURNAL);
passes("await db.update(tradesTable).set({ lot: 1 })", LEGACY_BOOK);
passes("await venue.openPaperOrder(a); await venue.closePaperOrder(b)", PIPELINE);
passes("await venue.openPaperFill(a); await venue.closePaperFill(b); await venue.settlePaperOrder(c); await venue.voidPaperOrder(d)", PIPELINE);
// Build EE and the QA fixture reach the venue's fills only through the pipeline.
fails("await openPaperFill(a)", "lib/paperExecution/paperExecutionService.ts");
fails("await voidPaperOrder(id)", "lib/paperExecution/paperExecutionService.ts");
fails("await closePaperFill(b)", "lib/paperExecution/paperExecutionMonitor.ts");
fails("await settlePaperOrder(a)", "lib/paperExecution/paperExecutionMonitor.ts");
fails("await openPaperFill(a)", "routes/autoDebrief.ts");
fails("await settlePaperOrder(b)", "routes/autoDebrief.ts");
passes('await fillPaperTrade({ mode: "PAPER", intent: "OPEN" }, a); await voidPaperTrade(id)', "lib/paperExecution/paperExecutionService.ts");
passes('await settlePaperTrade(a); await fillPaperTrade({ mode: "PAPER", intent: "CLOSE" }, b)', "lib/paperExecution/paperExecutionMonitor.ts");
passes('await fillPaperTrade({ mode: "PAPER", intent: "OPEN" }, a); await settlePaperTrade(b)', "routes/autoDebrief.ts");
passes("await applyPaperManagement(id, step)", "lib/positionGuardian/manage.ts");
passes("await recordLegacyExecuteTrade(row)", "routes/trades.ts");
passes("await cancelOpenLegacyTrades(userId)", "routes/bot.ts");
passes("db.select().from(paperOrdersTable).where(eq(paperOrdersTable.userId, u))");
passes('import type { PaperOrderRow } from "../lib/tradeEngine/paperVenue.js";', PAPER_JOURNAL);
passes("// await db.insert(paperOrdersTable)\n/* UPDATE trades SET x = 1 */");
passes('const label = "update trades list"; obj.constructor(); x.toString();');

// ── Structural proofs on the venue and the legacy book ──
const gov = (fn: string, action: string, body = "") => `export async function ${fn}(a) {
  ${body}const risk = await enforcePreTradeRisk({ userId: a.userId, venue: "PAPER", origin: "manual", action: "${action}" }, {});
  if (!risk.allowed) return null;
  await db.update(paperOrdersTable).set({ status: "X" }).where(eq(paperOrdersTable.id, a.id));
}`;
const settle = `export async function settlePaperOrder(a) {
  await db.update(paperOrdersTable).set({ status: a.status, closedAt: new Date(), exitPrice: a.x, profitLoss: a.p, updatedAt: new Date() }).where(eq(paperOrdersTable.id, a.id));
}
export async function voidPaperOrder(id) {
  await db.update(paperOrdersTable).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(paperOrdersTable.id, id)).catch(() => {});
}`;
const goodVenue = [gov("openPaperOrder", "OPEN"), gov("modifyPaperOrder", "MODIFY"), gov("closePaperOrder", "CLOSE"),
  gov("openPaperFill", "OPEN"), gov("closePaperFill", "CLOSE"), settle].join("\n");
const goodBook = "export async function applyPaperManagement(tradeId: number, step: PaperManagementStep): Promise<X> {}";
const shape = (venue: string, book = goodBook) => checkBookShape((k) => (k === PAPER_VENUE ? venue : k === LEGACY_BOOK ? book : null));
assert.deepEqual(shape(goodVenue), []);
assert.ok(shape(goodVenue.replace('action: "MODIFY"', 'action: "OPEN"')).some((v) => v.includes("modifyPaperOrder")), "wrong action fails");
assert.ok(shape(goodVenue.replace(/venue: "PAPER", origin: "manual", action: "CLOSE" \}, \{\}\);\n  if \(!risk.allowed\) return null;\n  await db.update\(paperOrdersTable\).set\(\{ status: "X" \}\).where\(eq\(paperOrdersTable.id, a.id\)\);\n\}\nexport async function openPaperFill/,
  'venue: "DEMO", origin: "manual", action: "CLOSE" }, {});\n  if (!risk.allowed) return null;\n  await db.update(paperOrdersTable).set({ status: "X" }).where(eq(paperOrdersTable.id, a.id));\n}\nexport async function openPaperFill'))
  .some((v) => v.includes("closePaperOrder")), "a non-PAPER venue fails");
assert.ok(shape(goodVenue.replace(gov("openPaperFill", "OPEN"),
  gov("openPaperFill", "OPEN", "await db.insert(paperOrdersTable).values(row);\n  ")))
  .some((v) => v.includes("before its Risk Governor")), "a write before the governor fails");
assert.ok(shape(goodVenue + "\nexport async function sneak(a) { await db.insert(paperOrdersTable).values(a); }")
  .some((v) => v.includes("sneak")), "an unlisted venue writer fails");
assert.ok(shape(goodVenue + "\nexport const sneak = async (a) => db.insert(paperOrdersTable).values(a);")
  .some((v) => v.includes("outside a named function")), "an arrow-function venue writer fails");
assert.ok(shape(goodVenue.replace("status: a.status, closedAt", "status: a.status, stopLoss: 1, closedAt"))
  .some((v) => v.includes("stopLoss")), "a settlement that moves the stop fails");
assert.ok(shape(goodVenue.replace(gov("closePaperFill", "CLOSE"), "export async function closePaperFill(a) {}"))
  .some((v) => v.includes("stale venue entry")), "a stale venue entry fails");
assert.ok(shape(goodVenue, "export async function applyPaperManagement(id: string) {}")
  .some((v) => v.includes("signature")), "the guardian's book signature is pinned");
assert.ok(shape(goodVenue, "").length === 1);
n += 10;

// The real tree is green.
const real = checkSinglePaperBook();
assert.ok(real.ok, real.violations.join("\n"));
n++;

console.log(`single-paper-book: ${n} fixtures passed`);
