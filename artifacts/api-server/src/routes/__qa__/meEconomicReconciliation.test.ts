// The economic-reconciliation read must never turn "we have not checked" or
// "we could not check" into a clean bill of health.
//
// The worker journals a CRITICAL DISCREPANCY verdict — "your ledger disagrees
// with the broker balance" — that reached a table and a log line and no human.
// This route is the human end of it, so the mapping from verdict to displayed
// state is safety-relevant copy, not decoration.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "../meEconomicReconciliation.ts"), "utf8");
const routesIndex = readFileSync(path.join(here, "../index.ts"), "utf8");

const { basisStateForVerdict, basisHeadline } = await import("../meEconomicReconciliation.js");

test("MATCHED is the ONLY verdict that reports agreement", () => {
  assert.equal(basisStateForVerdict("MATCHED"), "RECONCILED");
  for (const v of ["DISCREPANCY", "UNKNOWN", "BASELINE_ESTABLISHED", "ERROR", "SKIPPED"]) {
    assert.notEqual(basisStateForVerdict(v), "RECONCILED", `${v} must never be reported as reconciled`);
  }
});

test("a DISCREPANCY is reported as DISPUTED, never softened", () => {
  assert.equal(basisStateForVerdict("DISCREPANCY"), "DISPUTED");
  const headline = basisHeadline("DISPUTED");
  assert.match(headline, /DISAGREES/);
  assert.match(headline, /not broker-reconciled/);
});

test("no verdict at all is NEVER_RUN and says so — not silence, not agreement", () => {
  assert.equal(basisStateForVerdict(null), "NEVER_RUN");
  assert.equal(basisStateForVerdict(undefined), "NEVER_RUN");
  const headline = basisHeadline("NEVER_RUN");
  assert.match(headline, /No ledger-vs-broker reconciliation has run/);
  assert.doesNotMatch(headline, /matched/i);
});

test("an unrecognised verdict degrades to UNVERIFIED, never promoted", () => {
  // A renamed or newly added verdict must not silently become a claim of
  // agreement. This is the mutation that matters: default → RECONCILED.
  assert.equal(basisStateForVerdict("SOME_FUTURE_VERDICT"), "UNVERIFIED");
  assert.match(basisHeadline("UNVERIFIED"), /unverified against the broker/);
});

test("BASELINE_ESTABLISHED is not agreement", () => {
  // The worker's own contract: the first comparison establishes a baseline and
  // says so — it does not claim MATCHED.
  assert.equal(basisStateForVerdict("BASELINE_ESTABLISHED"), "UNVERIFIED");
});

test("the read is per-user scoped and cannot read another account's ledger", () => {
  assert.match(src, /eq\(economicDiscrepanciesTable\.userId,\s*req\.authUser!\.id\)/);
  assert.ok(!/req\.query\[?["']userId/.test(src), "no caller-supplied userId may reach this query");
});

test("an unreadable ledger answers a typed 503, never an empty 200", () => {
  assert.match(src, /status\(503\)[\s\S]*DISCREPANCY_LEDGER_UNREADABLE/);
});

test("the route holds no correction seam — surfacing only", () => {
  for (const forbidden of ["db.insert", "db.update", "db.delete", "economicPostingsTable"]) {
    assert.ok(!src.includes(forbidden), `${forbidden} must not appear in a read-only reconciliation surface`);
  }
});

test("the router is actually mounted", () => {
  assert.match(routesIndex, /meEconomicReconciliationRouter/);
  assert.match(routesIndex, /router\.use\(meEconomicReconciliationRouter\)/);
});
