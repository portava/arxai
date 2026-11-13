import { test } from "node:test";
import assert from "node:assert/strict";
import { projectNativeAccountReport, projectLegacyAccountMoney } from "../nativeAccountReport.js";
import { NOW, connection, payload, receipt } from "./nativeAccountReport.fixture.js";

test("native profit is the exact reported decimal, never equity minus balance or an inferred zero", () => {
  for (const profit of ["-8.76", "0.00", "12.34", "9007199254740993.12"]) {
    const r = receipt({ payload: { ...payload(), profit } });
    const out = projectNativeAccountReport(connection, r, NOW);
    assert.equal(out.status, "reported"); assert.equal(out.amounts?.profit, profit); assert.equal(typeof out.amounts?.profit, "string");
    assert.equal(out.amounts?.balance, "9007199254740993.12"); assert.equal(out.currency, "USD"); assert.equal(out.currentVerified, false);
    assert.deepEqual(projectLegacyAccountMoney(connection, r, NOW), { accountBalance: null, accountEquity: null, accountCurrency: null, lastAccountSnapshotAt: null });
  }
});
test("missing or invalid native profit withholds money rather than manufacturing a profitable account", () => {
  for (const profit of [undefined, null, 12.34, "1e5", "+1.00", "01.00", "1.0", "-0.00", "NaN", "Infinity"]) {
    const out = projectNativeAccountReport(connection, receipt({ payload: { ...payload(), profit } }), NOW);
    assert.equal(out.status, "unavailable", String(profit)); assert.equal(out.amounts, null); assert.equal(out.currentVerified, false);
  }
});
test("currency precision is retained without binary rounding and rejects contradictory fractional digits", () => {
  for (const [currencyDigits, value] of [[0, "12"], [3, "12.345"], [16, "12.1234567890123456"]] as const) {
    const amounts = Object.fromEntries(["balance", "equity", "profit", "credit", "margin", "freeMargin"].map(k => [k, value]));
    const report = { ...payload(), ...amounts, currencyDigits };
    assert.equal(projectNativeAccountReport(connection, receipt({ payload: report }), NOW).amounts?.profit, value);
    assert.equal(projectNativeAccountReport(connection, receipt({ payload: { ...report, profit: "12.34" } }), NOW).status, "unavailable");
  }
});
