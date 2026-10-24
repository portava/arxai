// Negative fixtures for check-single-safety-switch-source. Pure, no IO.
import assert from "node:assert/strict";
import { ALLOW, checkAuthorityShape, scanFile, staleEntries } from "./check-single-safety-switch-source.js";

export {};

const one = (key: string, src: string) => scanFile(key, src).length;

// 1. Switch columns through the table object.
assert.equal(one("routes/x.ts", `import { globalTradingSettingsTable } from "@workspace/db";
const r = await db.select({ on: globalTradingSettingsTable.emergencyKillSwitch }).from(globalTradingSettingsTable);`), 1);
assert.equal(one("routes/x.ts", `import { globalTradingSettingsTable as g } from "@workspace/db";
const r = await db.select({ m: g.platformMode }).from(g);`), 1, "import alias");
assert.equal(one("lib/a.ts", `const r = await db.select({ a: schema.globalTradingSettingsTable.liveBrokerExecutionArmed }).from(schema.globalTradingSettingsTable);`), 1, "namespace access");
// Non-switch columns are config, not switches.
assert.deepEqual(scanFile("routes/x.ts", `import { globalTradingSettingsTable } from "@workspace/db";
const r = await db.select({ m: globalTradingSettingsTable.accountRoutingMode }).from(globalTradingSettingsTable).limit(1);`), []);

// 2. Whole-row reads (select() with no column map, relational query).
assert.equal(one("lib/b.ts", `const [g] = await db.select().from(globalTradingSettingsTable).limit(1);`), 1);
assert.equal(one("lib/b.ts", `const [g] = await tx.select().from(globalTradingSettingsTable);`), 1);
assert.equal(one("lib/b.ts", `const g = await db.query.globalTradingSettingsTable.findFirst();`), 1);

// 3. Writes.
assert.equal(one("routes/y.ts", `await db.update(globalTradingSettingsTable).set({ accountRoutingMode: "X" });`), 1);

// 4. safety_core and 5. the arming row outside their owners.
assert.equal(one("routes/z.ts", `import { safetyCoreTable } from "@workspace/db"; const r = await db.select().from(safetyCoreTable);`), 1);
assert.deepEqual(scanFile("lib/safetyCore.ts", `const r = await db.select().from(safetyCoreTable);`), []);
assert.equal(one("routes/z.ts", `const a = await db.select().from(arxLiveArmingTable).where(eq(arxLiveArmingTable.userId, 1));`), 1);
assert.deepEqual(scanFile("lib/live/liveArming.ts", `const a = await db.select().from(arxLiveArmingTable);`), []);

// 6. The raw row loader and 7. the env helper.
assert.equal(one("routes/q.ts", `const row = await loadGlobalTradingSettingsRow();`), 1);
assert.equal(one("routes/q.ts", `const on = isLiveBrokerExecutionEnabledEnv();`), 1);
// Importing alone is not a read.
assert.deepEqual(scanFile("routes/q.ts", `import { isLiveBrokerExecutionEnabledEnv } from "@workspace/domain/safety-contracts/isLiveBrokerExecutionEnabled";`), []);

// 8. Raw SQL.
assert.equal(one("lib/c.ts", "await db.execute(sql`SELECT emergency_kill_switch FROM global_trading_settings`);"), 1);
assert.equal(one("lib/c.ts", "await pool.query('SELECT platform_mode, live_enabled FROM global_trading_settings LIMIT 1');"), 1);
assert.equal(one("lib/c.ts", "await pool.query('select * from safety_core');"), 1);
// Reason codes and comments are not SQL.
assert.deepEqual(scanFile("lib/c.ts", `const code = "KILL_SWITCH_ENGAGED"; // reads emergency_kill_switch elsewhere`), []);

// The authority itself is exempt.
assert.deepEqual(scanFile("lib/safety/platformSwitches.ts", `const r = await db.select().from(globalTradingSettingsTable);`), []);
assert.deepEqual(scanFile("lib/safety/tradingHalt.ts", `const a = await db.select({ on: arxLiveArmingTable.killSwitchEngaged }).from(arxLiveArmingTable);`), []);

// Allowlisted files may break only their listed rules.
assert.deepEqual(scanFile("routes/adminTrading.ts", `await db.update(globalTradingSettingsTable).set({ emergencyKillSwitch: true });`), []);
assert.equal(one("routes/adminTrading.ts", `const [g] = await db.select().from(globalTradingSettingsTable);`), 1, "adminTrading is not allowed whole-row reads");

// Stale allowlist: an entry whose file no longer breaks the rule (or is gone) is reported.
const stale = staleEntries((key) => (key === "routes/adminTrading.ts" ? `export const nothing = 1;` : null));
assert.ok(stale.some((s) => s.startsWith("routes/adminTrading.ts:") && s.includes(`"gts_write"`)));
assert.ok(stale.some((s) => s.includes("no longer exists")));
assert.ok(Object.keys(ALLOW).length > 0);

// Authority shape: losing the strict multi-row combine fails.
const goodSwitches = `export async function readPlatformSwitches(
export function switchesFromRows(
  const engagedRow = rows.find((r) => r.emergencyKillSwitch !== false);
function failClosed(`;
const goodHalt = `import { x } from "./platformSwitches.js";
export async function venueTradingVerdict(`;
const shape = (sw: string, halt: string) => checkAuthorityShape((k) => (k.endsWith("platformSwitches.ts") ? sw : halt));
assert.deepEqual(shape(goodSwitches, goodHalt), []);
assert.equal(shape(goodSwitches.replace("rows.find((r) => r.emergencyKillSwitch !== false)", "rows[0]"), goodHalt).length, 1);
assert.equal(shape(goodSwitches, goodHalt.replace("venueTradingVerdict", "other")).length, 1);

console.log("check-single-safety-switch-source fixtures: ok");
