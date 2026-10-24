import assert from "node:assert/strict";
import { checkSinglePositionGuardian, scanRuleModule, scanUnregistered } from "./check-single-position-guardian.js";
import type { GuardianRule } from "../../../artifacts/api-server/src/lib/positionGuardian/rules.js";

const acting: GuardianRule = {
  id: "mission-exit", label: "x", kind: "ACTING", modules: ["lib/x.ts"], actions: ["CLOSE"], route: "INSTANT_ROUTER",
};
const advisory: GuardianRule = { id: "trade-health", label: "x", kind: "ADVISORY", modules: ["lib/y.ts"], actions: [], route: null };

let n = 0;
const ruleFails = (rule: GuardianRule, src: string) => { n++; assert.ok(scanRuleModule(rule, "lib/x.ts", src).length > 0, src); };
const rulePasses = (rule: GuardianRule, src: string) => { n++; assert.deepEqual(scanRuleModule(rule, "lib/x.ts", src), [], src); };
const freeFails = (src: string, key = "lib/newEngine.ts") => { n++; assert.ok(scanUnregistered(key, src).length > 0, src); };
const freePasses = (src: string, key = "lib/newEngine.ts") => { n++; assert.deepEqual(scanUnregistered(key, src), [], src); };

// Rule modules never reach an execution path themselves.
ruleFails(acting, 'import { executeInstant } from "./live/instantTrade.js"; await executeInstant({ userId, intent });');
ruleFails(acting, "const executor = opts.executor ?? executeInstant; await executor({ userId, intent });");
ruleFails(acting, 'import { createActionDraft } from "../tradeAction/create.js";');
ruleFails(acting, 'const { confirmAction } = await import("../tradeAction/confirm.js");');
ruleFails(acting, 'const ops = await import("../positions/governedOps.js"); await ops.submitGovernedClose(u, p, "x");');
ruleFails(acting, 'import { createLiveOpsDraft } from "../live/liveCommandPipeline.js";');
ruleFails(acting, "await db.update(tradesTable).set({ stopLoss: 1 })");
ruleFails(acting, "await db.insert(mt5DemoCommandsTable).values(row)");
ruleFails(acting, 'await guardianInstantManage({ ruleId: "protective-close", userId, intent, position });');
ruleFails(advisory, 'import { guardianPaperManage } from "../positionGuardian/manage.js";');
rulePasses(acting, 'import { guardianInstantManage } from "./positionGuardian/manage.js"; await guardianInstantManage({ ruleId: "mission-exit", userId, intent, position, executor });');
rulePasses(acting, 'import { executeInstant, type InstantTradeIntent } from "./live/instantTrade.js"; const executor = opts.executor ?? executeInstant;');
rulePasses(acting, 'import type { GovernedPosition } from "../positions/governedOps.js";');
rulePasses(advisory, 'import { livePositionLedger } from "../positions/ledger.js"; await livePositionLedger.read({});');

// A new management engine must be registered.
freeFails('import { livePositionLedger } from "./positions/ledger.js"; await executeInstant({ userId, intent });');
freeFails('import { demoPositionLedger } from "../positions/ledger.js"; await createActionDraft({ userId });');
freeFails('import { livePositionLedger } from "./positions/ledger.js"; await db.update(tradesTable).set({ lot: 1 });');
freeFails('await applyPaperManagement(1, { kind: "MOVE_STOP", newStop: 1 })', "routes/paperTrades.ts");
ruleFails(acting, 'const { applyPaperManagement } = await import("../trades/paperBook.js");');
freeFails('import { guardianInstantManage } from "./positionGuardian/manage.js";');
freePasses('import { livePositionLedger } from "./positions/ledger.js"; await executeInstant({ userId, intent });', "lib/live/emergencyClose.ts");
freePasses('import { livePositionLedger } from "./positions/ledger.js"; await db.update(arxLiveCommandsTable).set({ status });');
freePasses("await executeInstant({ userId, intent }); // a trader's order entry, no position read");

// The real tree passes.
const real = checkSinglePositionGuardian();
assert.ok(real.ok, real.violations.join("\n"));
console.log(`single-position-guardian: ${n} boundary fixtures passed; repository clean`);
