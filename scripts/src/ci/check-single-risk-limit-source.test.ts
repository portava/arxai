// Negative fixtures for check-single-risk-limit-source. Pure, no IO.
import assert from "node:assert/strict";
import { ALLOW, AUTHORITY, checkAuthorityShape, ruleOfMessage, scanFile, staleEntries } from "./check-single-risk-limit-source.js";

export {};

let n = 0;
const rules = (key: string, src: string) => scanFile(key, src).map(ruleOfMessage);
const fails = (rule: string, src: string, key = "routes/newSurface.ts") => {
  n++;
  assert.ok(rules(key, src).includes(rule as never), `expected [${rule}] in ${key}: ${src}\n got ${JSON.stringify(scanFile(key, src))}`);
};
const passes = (src: string, key = "routes/newSurface.ts") => {
  n++;
  assert.deepEqual(scanFile(key, src), [], `${key}: ${src}`);
};

// 1. Raw reads of the limit tables.
fails("table", `import { userRiskSettingsTable } from "@workspace/db"; const [s] = await db.select().from(userRiskSettingsTable).where(eq(userRiskSettingsTable.userId, 1)).limit(1);`);
fails("table", `const [l] = await db.select().from(userRiskLimitsTable).limit(1);`);
fails("table", `import { userRiskLimitsTable as url } from "@workspace/db"; const r = await db.select({ lot: url.maxLotSize }).from(url);`, "lib/x.ts");
fails("table", `const r = await db.select().from(schema.userRiskSettingsTable);`);
fails("table", `const r = await db.query.userRiskSettingsTable.findFirst();`);
fails("table", `const { userRiskSettingsTable: t } = await import("@workspace/db"); const r = await db.select().from(t);`);
// A governor file other than the reader must read through it too.
fails("table", `const [s] = await db.select().from(userRiskSettingsTable).limit(1);`, "lib/riskGovernor/newRule.ts");
// The reader itself may.
passes(`const [s] = await db.select().from(userRiskSettingsTable).limit(1);`, AUTHORITY);
// Type-only use is not a read.
passes(`type Row = typeof userRiskSettingsTable.$inferSelect; let r: Row | null = null;`);
// Importing alone is not a read.
passes(`import { userRiskSettingsTable } from "@workspace/db";`);

// 2. Writes (and their where clause) are one finding: write.
const w = rules("routes/w.ts", `await db.update(userRiskSettingsTable).set({ maxOpenTrades: 1 }).where(eq(userRiskSettingsTable.userId, 1)).returning();`);
n++; assert.deepEqual(w, ["write"], "a write's where clause is part of the write");
fails("write", `await db.insert(userRiskLimitsTable).values({ userId: 1 });`);
fails("write", `await tx.delete(userRiskSettingsTable).where(eq(userRiskSettingsTable.userId, 1));`);

// 3. Raw SQL.
fails("raw_sql", "await db.execute(sql`SELECT max_open_trades FROM user_risk_settings WHERE user_id = ${u}`);");
fails("raw_sql", "await pool.query('update user_risk_limits set max_lot_size = 1');");
// A source label is not SQL.
passes(`const source = "user_risk_settings.max_position_size";`);

// 4. Readers of the saved row outside the governor.
fails("raw_reader", `import { readTraderRiskSettings } from "../lib/riskGovernor/limitSettings.js"; const s = await readTraderRiskSettings(uid);`);
fails("raw_reader", `const s = await getOrCreateUserRiskSettings(uid);`);
fails("raw_reader", `const s = await getOrCreateRiskSettings(uid);`);
fails("raw_reader", `const rows = await rs.readOperatorRiskLimitsMany(ids);`, "lib/y.ts");
// Inside the governor the readers are the governor's own.
passes(`const s = await readTraderRiskSettings(uid);`, "lib/riskGovernor/riskProfile.ts");
// The limits in force are the governor's answer: not flagged.
passes(`import { loadEffectiveLimits } from "../lib/riskGovernor/enforce.js"; const L = await loadEffectiveLimits(uid); res.json({ maxLot: L.maxLotSize });`);
passes(`const { rows } = explainLimitLayers(await loadStoredLimitRows(uid));`);

// 5. Limit evaluation outside the governor.
fails("limit_eval", `if (lots > limits.maxLotSize) refuse();`);
fails("limit_eval", `if (openCount >= settings.maxOpenTrades) block();`);
fails("limit_eval", `if (loss >= (s.maxDailyLossPercent ?? 3)) block();`);
fails("limit_eval", `const hit = s!.maxConsecutiveLosses <= streak;`);
fails("limit_eval", `if (mins < cfg.cooldownAfterLossMinutes) wait();`);
fails("limit_eval", `if (r < (risk.minRewardRiskRatio as number)) warn();`);
fails("limit_eval", `if (x.maxWeeklyLossAmount < used) block();`);
fails("limit_eval", `if (open >= caps.maxOpenPositions) block();`);
fails("limit_eval", `if (vol > arming.maxLotConfirmed) block();`);
// Inside the governor, evaluation is the job.
passes(`if (lots > L.maxLotSize) return block();`, "lib/riskGovernor/preTrade.ts");
// Not a comparison, or not a limit name.
passes(`res.json({ maxLotSize: L.maxLotSize, ok: a > b, n: s.maxLotPerMarket > 1 ? 1 : 0 });`);
passes(`const cap = settings.maxOpenTrades; const same = settings.maxOpenTrades === 3;`);

// Allowlist mechanics.
const key = Object.keys(ALLOW)[0]!;
n++; assert.ok(ALLOW[key]!.why.length > 10, "every entry carries a reason");
for (const [k, e] of Object.entries(ALLOW)) { n++; assert.ok(e.rules.length > 0 && e.why.trim().length > 0, `${k}: rules + why`); }
// An allowlisted file that is gone, or no longer breaks its rule, is stale.
const stale = staleEntries((k) => (k === key ? `export const nothing = 1;` : null));
n++; assert.ok(stale.some((s) => s.startsWith(`${key}: allowlisted for`)), "rule no longer broken → stale");
n++; assert.ok(stale.some((s) => s.includes("no longer exists")), "missing file → stale");
// An allowlisted rule silences only that rule.
const orderGuard = "lib/adminTrading/orderGuard.ts";
n++; assert.deepEqual(rules(orderGuard, `const lim = await readOperatorRiskLimits(1); if (lot > lim.maxLotSize) refuse();`), []);
n++; assert.deepEqual(rules(orderGuard, `const [l] = await db.select().from(userRiskLimitsTable);`), ["table"]);

// Authority shape.
const goodAuth = `export async function readTraderRiskSettings(
export async function readTraderRiskSettingsMany(
export async function readOperatorRiskLimits(
export async function readOperatorRiskLimitsMany(
export async function loadStoredLimitRows(
export async function loadEffectiveLimits(
  return resolveEffectiveLimits(await loadStoredLimitRows(userId));`;
const files: Record<string, string> = {
  [AUTHORITY]: goodAuth,
  "lib/riskGovernor/enforce.ts": `import { loadEffectiveLimits } from "./limitSettings.js"; const limits = await loadEffectiveLimits(intent.userId);`,
  "lib/riskGovernor/preTrade.ts": `export function resolveEffectiveLimits(rows) {} checkRewardRiskFloor(D.minRewardRiskRatio, s, r, l, t); export function tradingDayStart(now) {}`,
  "lib/tradeAction/guards.ts": `const MAX_LOT_HARD_CAP = PLATFORM_RISK_CEILINGS.maxLotSize;`,
};
n++; assert.deepEqual(checkAuthorityShape((k) => files[k] ?? null), []);
n++; assert.ok(checkAuthorityShape((k) => ({ ...files, "lib/tradeAction/guards.ts": "const MAX_LOT_HARD_CAP = 5.0;" })[k] ?? null).length === 1, "own lot number → fails");
n++; assert.ok(checkAuthorityShape((k) => ({ ...files, [AUTHORITY]: goodAuth.replace("readOperatorRiskLimitsMany", "x") })[k] ?? null).length >= 1, "lost reader → fails");
n++; assert.ok(checkAuthorityShape((k) => ({ ...files, "lib/riskGovernor/enforce.ts": "const limits = resolveEffectiveLimits(rows);" })[k] ?? null).length >= 1, "governor not reading through the reader → fails");
n++; assert.ok(checkAuthorityShape(() => null).length === 1, "missing reader → fails");
// Owner decision 10: one R:R floor calculation, the floor in force.
const rrFiles: Record<string, string> = {
  ...files,
  "lib/riskGovernor/preTrade.ts": `export function resolveEffectiveLimits(rows) {} const rr = checkRewardRiskFloor(D.minRewardRiskRatio, side, ref, sl, tp); export function tradingDayStart(now) {}`,
  "lib/tradeAction/riskGovernorEnforcement.ts": `const rr = checkRewardRiskFloor(input.minRiskRewardRatio ?? null, side, entry, sl, tp);`,
  "routes/pendingOrderDraft.ts": `minRr = (await loadEffectiveLimits(userId)).discipline.minRewardRiskRatio;`,
};
n++; assert.deepEqual(checkAuthorityShape((k) => rrFiles[k] ?? null), []);
n++; assert.equal(checkAuthorityShape((k) => ({ ...rrFiles, "lib/tradeAction/riskGovernorEnforcement.ts": "if (v.riskReward < input.minRiskRewardRatio) refuse();" })[k] ?? null).length, 1, "own R:R formula in the ticket check → fails");
n++; assert.equal(checkAuthorityShape((k) => ({ ...rrFiles, "routes/pendingOrderDraft.ts": "const v = (s as any).minRiskRewardRatio;" })[k] ?? null).length, 1, "draft not reading the floor in force → fails");
n++; assert.equal(checkAuthorityShape((k) => ({ ...rrFiles, "lib/riskGovernor/preTrade.ts": "export function resolveEffectiveLimits(rows) {} if (rr < D.minRewardRiskRatio) soft(); export function tradingDayStart(now) {}" })[k] ?? null).length, 1, "rule 13 with its own formula → fails");
// Owner decision 9: the rolling-24h count is the named operational rate cap.
const goodGuard = `{ name: "operational_rate_cap", test: async () => count >= rateCap ? operationalRateCapRefusal(rateCap) : null } function operationalRateCapRefusal(c) { return \`OPERATIONAL_RATE_CAP_REACHED:\${c}\`; }`;
n++; assert.deepEqual(checkAuthorityShape((k) => ({ ...rrFiles, "lib/adminTrading/orderGuard.ts": goodGuard })[k] ?? null), []);
n++; assert.equal(checkAuthorityShape((k) => ({ ...rrFiles, "lib/adminTrading/orderGuard.ts": "if (count >= lim.maxTradesPerDay) return `MAX_TRADES_PER_DAY_REACHED:${n}`;" })[k] ?? null).length, 1, "rolling count named trades per day → fails");
n++; assert.equal(checkAuthorityShape((k) => ({ ...rrFiles, "lib/adminTrading/orderGuard.ts": goodGuard + " // TRADES_PER_DAY" })[k] ?? null).length, 1, "any TRADES_PER_DAY wording in the guard → fails");
n++; assert.equal(checkAuthorityShape((k) => ({ ...rrFiles, "lib/riskGovernor/preTrade.ts": "export function resolveEffectiveLimits(rows) {} checkRewardRiskFloor(D.minRewardRiskRatio, s, r, l, t);" })[k] ?? null).length, 1, "lost the governor's trading day → fails");

console.log(`check-single-risk-limit-source.test: ${n} assertions passed`);
