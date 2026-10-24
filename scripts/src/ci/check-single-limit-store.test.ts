// Negative fixtures for check-single-limit-store. Pure, no IO.
import assert from "node:assert/strict";
import { STORE, scanFile } from "./check-single-limit-store.js";

export {};

const GOOD_STORE = "export const LEGACY_LIMIT_FIELDS = {};\nif (k in LEGACY_LIMIT_FIELDS) {}\nriskSettingsTable";
assert.deepEqual(scanFile(STORE, GOOD_STORE), []);
assert.equal(scanFile(STORE, "riskSettingsTable").length, 2, "a store without the split fails");

// Any other file touching risk_settings fails.
assert.equal(scanFile("routes/x.ts", "db.select().from(riskSettingsTable)").length, 1);
// The governor reading it, by table or raw SQL, fails with its own message.
assert.match(scanFile("lib/riskGovernor/enforce.ts", "riskSettingsTable")[0]!, /Risk Governor/);
assert.match(scanFile("lib/riskGovernor/enforce.ts", `sql\`select * from "risk_settings"\``)[0] ?? "", /Risk Governor/);
// user_risk_settings is fine everywhere.
assert.deepEqual(scanFile("lib/riskGovernor/enforce.ts", "userRiskSettingsTable"), []);

console.log("check-single-limit-store fixtures: ok");
