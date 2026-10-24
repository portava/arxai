import assert from "node:assert/strict";
import {
  MAILBOX_EXCEPTION, PAPER_VENUE, PIPELINE, checkPipelineShape, checkTradeEngineSinglePipeline, scanFile,
} from "./check-trade-engine-single-pipeline.js";

let n = 0;
const fails = (source: string, key = "routes/newSurface.ts") => {
  n++;
  assert.ok(scanFile(key, source).length > 0, `expected a violation in ${key}: ${source}`);
};
const passes = (source: string, key = "routes/newSurface.ts") => {
  n++;
  assert.deepEqual(scanFile(key, source), [], `${key}: ${source}`);
};

// Venue entry points outside the pipeline.
fails('import { createDraftCommand } from "../lib/mt5/demoCommandQueue.js"; await createDraftCommand(args)');
fails('const q = await import("../lib/mt5/demoCommandQueue.js"); await q.dispatchApprovedCommand(a)');
fails('import { createLiveDraft as draft } from "../lib/live/liveCommandPipeline.js"; await draft(x)');
fails('await pipe["dispatchLiveCommand"]({ userId, commandId })');
fails("await ops.submitGovernedClose(userId, pos, 'PAGE')");
fails("await venue.openPaperOrder(args)");
fails("await executeInstant({ userId, intent })");
fails("await createLiveOpsDraft(x)", "routes/meDemoCommands.ts"); // a DEMO producer is not a LIVE producer
fails("await submitGovernedModify(u, p, 1, 2, 'X')", "lib/positionGuardian/assess.ts");
// Paper / legacy trade books.
fails('import { paperOrdersTable } from "@workspace/db"; await db.insert(paperOrdersTable).values(row)');
fails('import { paperOrdersTable as po } from "@workspace/db"; await db.update(po).set({ stopLoss: 1 })');
fails('const { tradesTable: t } = await import("@workspace/db"); await db.insert(t).values(row)');
fails("await db.delete(schema.paperTradesTable)");
fails('await db.update(schema["tradesTable"]).set({ status: "CLOSED" })');
fails('await client.query("UPDATE trades SET status = $1 WHERE id = $2", ["CLOSED", 1])');
fails('await db.execute(sql`insert into paper_orders (symbol) values (${s})`)');
fails("await db.insert(tradesTable).values(row)", "lib/paperExecution/paperExecutionService.ts"); // wrong book
fails("await db.insert(paperOrdersTable).values(row)", "routes/paperTrading.ts"); // moved into the PAPER venue
// Command tables.
fails("await db.insert(mt5CommandsTable).values({ action: 'OPEN' })");
fails("await db.insert(mt5DemoCommandsTable).values(row)", "routes/meDemoCommands.ts");
fails("await db.insert(arxLiveCommandsTable).values(row)", "lib/live/instantTrade.ts");

// Allowed.
passes("await submitTrade({ mode: 'DEMO', intent: 'OPEN' })");
passes("await queue.createDraftCommand(a); await queue.confirmCommand(b)", PIPELINE);
passes("await openPaperOrder(a)", PIPELINE);
passes("await createDraftCommand(a)", "routes/meDemoCommands.ts");
passes("await createLiveOpsDraft(x)", "routes/meTrades.ts");
passes("await submitGovernedModify(u, p, 1, 2, 'X')", "lib/positionGuardian/manage.ts");
fails("await submitGovernedModify(u, p, 1, 2, 'X')", "lib/positionGuardian/reconcile.ts"); // corrections go through the exit door
passes("await executeInstant(args)", "lib/selfTrade/agentExecutor.ts");
passes("await db.insert(paperOrdersTable).values(row)", PAPER_VENUE);
passes("await db.update(tradesTable).set({ status: 'CANCELLED' })", "routes/bot.ts");
passes("await db.update(tradesTable).set({ lot: 1 })", "lib/trades/paperBook.ts");
fails("await db.update(tradesTable).set({ stopLoss: 1 })", "routes/tradeManagement.ts"); // management goes through the Position Guardian
passes("await db.insert(mt5CommandsTable).values({ action: 'CLOSE' })", MAILBOX_EXCEPTION);
passes("await db.insert(mt5CommandsTable).values({ action: 'RECONNECT' })", "routes/brokerHealth.ts");
passes("db.select().from(paperOrdersTable).where(eq(paperOrdersTable.userId, u))");
passes("// await createDraftCommand(x)\n/* db.insert(paperOrdersTable) */");
passes('const label = "update trades list"; const note = "createLiveDraft";');

// Structural proofs.
const shape = (files: Record<string, string>) => checkPipelineShape((k) => files[k] ?? null);
const goodPipe = `export async function submitTrade(r) {}
  "LIVE" "DEMO" "PAPER" createDraftCommand( createLiveDraft( confirmLiveCommand( dispatchLiveCommand(
  submitGovernedClose( submitGovernedModify( openPaperOrder( modifyPaperOrder( closePaperOrder(`;
const goodPaper = ["OPEN", "MODIFY", "CLOSE"].map((a) =>
  `enforcePreTradeRisk({ userId, venue: "PAPER", origin: "manual", action: "${a}" })`).join("\n");
const goodMe = `enforcePreTradeRisk({ userId, venue: "DEMO", origin: "manual", action: "CLOSE" });
  await db.insert(mt5CommandsTable).values({ action: "CLOSE", payload: { a: 1 } }).returning();`;
assert.deepEqual(shape({ [PIPELINE]: goodPipe, [PAPER_VENUE]: goodPaper, [MAILBOX_EXCEPTION]: goodMe }), []);
assert.ok(shape({ [PAPER_VENUE]: goodPaper }).some((v) => v.includes("missing")), "a missing pipeline fails");
assert.ok(shape({ [PIPELINE]: goodPipe.replace('"PAPER"', ""), [PAPER_VENUE]: goodPaper }).some((v) => v.includes("PAPER")));
assert.ok(shape({ [PIPELINE]: goodPipe + "\nawait db.insert(paperOrdersTable)", [PAPER_VENUE]: goodPaper })
  .some((v) => v.includes("must not write")), "the pipeline may not write tables");
assert.ok(shape({ [PIPELINE]: goodPipe, [PAPER_VENUE]: goodPaper.replace(/action: "MODIFY"/, 'action: "X"') })
  .some((v) => v.includes("MODIFY")), "an ungoverned paper modify fails");
assert.ok(shape({ [PIPELINE]: goodPipe, [PAPER_VENUE]: goodPaper, [MAILBOX_EXCEPTION]: goodMe.replace('action: "CLOSE", payload', 'action: "OPEN", payload') })
  .some((v) => v.includes("mailbox exception")), "the mailbox exception is CLOSE only");
assert.ok(shape({ [PIPELINE]: goodPipe, [PAPER_VENUE]: goodPaper,
  [MAILBOX_EXCEPTION]: goodMe + '\nawait db.insert(mt5CommandsTable).values({ action: "CLOSE" }).returning();' })
  .some((v) => v.includes("ONE")), "a second mailbox insert fails");
n += 7;

// The real tree is green.
const real = checkTradeEngineSinglePipeline();
assert.ok(real.ok, real.violations.join("\n"));
n++;

console.log(`trade-engine-single-pipeline: ${n} fixtures passed`);
