// Broker-statement reconciliation (#29/#30/#31) — pure comparison verdicts +
// source pins for the seams and the worker registration.
//
// The comparison half is DB-free (pure @workspace/accounting). The seam pins
// read the REAL source files: the fill/close hooks in liveCommandPipeline,
// the demo hook in guidedDispatchEntry, the worker registration in index.ts,
// and the append-only guard listing — so gutting any wiring turns a test red
// even without a database.

// The worker module imports @workspace/db, whose module init throws when
// DATABASE_URL is unset. This suite is DB-FREE (pure comparison + source
// pins); a dummy loopback URL that can never connect satisfies the init
// guard without granting any test a database.
process.env["DATABASE_URL"] ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Money } from "@workspace/money";
import {
  compareLedgerToBroker,
  DEFAULT_BROKER_SNAPSHOT_STALE_AFTER_MS,
} from "@workspace/accounting";

// Dynamic import AFTER the env shim above: static ESM imports hoist, and the
// worker module pulls @workspace/db whose init throws without DATABASE_URL.
const { economicReconciliationEnabled } = await import("../economicReconciliationWorker.js");

const usd = (v: string | number) => Money.of(v, "USD");

const BASE = {
  brokerSource: "BROKER_EVENT" as const,
  ledgerSource: "LOCAL_EXECUTION" as const,
  snapshotAgeMs: 60_000,
  staleAfterMs: DEFAULT_BROKER_SNAPSHOT_STALE_AFTER_MS,
};

describe("compareLedgerToBroker — honest verdicts", () => {
  it("no broker balance → UNKNOWN, never a synthesized comparison", () => {
    const r = compareLedgerToBroker({
      ...BASE, brokerBalance: null, ledgerCash: usd("10"), baseline: usd("0"),
    });
    assert.equal(r.verdict, "UNKNOWN");
    assert.equal(r.difference, null);
    assert.match(r.reason, /unavailable/);
  });

  it("a STALE broker figure → UNKNOWN (stale is reported stale, not compared as fresh)", () => {
    const r = compareLedgerToBroker({
      ...BASE, brokerBalance: usd("100"), ledgerCash: usd("10"),
      baseline: usd("90"), snapshotAgeMs: DEFAULT_BROKER_SNAPSHOT_STALE_AFTER_MS + 1,
    });
    assert.equal(r.verdict, "UNKNOWN");
    assert.match(r.reason, /stale/);
  });

  it("unknown freshness → UNKNOWN too", () => {
    const r = compareLedgerToBroker({
      ...BASE, brokerBalance: usd("100"), ledgerCash: usd("10"),
      baseline: usd("90"), snapshotAgeMs: null,
    });
    assert.equal(r.verdict, "UNKNOWN");
  });

  it("currency mismatch refuses to compare", () => {
    const r = compareLedgerToBroker({
      ...BASE, brokerBalance: Money.of("100", "EUR"), ledgerCash: usd("10"), baseline: null,
    });
    assert.equal(r.verdict, "UNKNOWN");
    assert.match(r.reason, /currency mismatch/);
  });

  it("first comparison ESTABLISHES a baseline — and says nothing was verified", () => {
    const r = compareLedgerToBroker({
      ...BASE, brokerBalance: usd("1000.00"), ledgerCash: usd("120.20"), baseline: null,
    });
    assert.equal(r.verdict, "BASELINE_ESTABLISHED");
    assert.equal(r.establishedBaseline?.equals(usd("879.80")), true);
    assert.match(r.reason, /nothing verified/);
  });

  it("broker == baseline + ledger → MATCHED with zero difference", () => {
    const r = compareLedgerToBroker({
      ...BASE, brokerBalance: usd("1000.00"), ledgerCash: usd("120.20"), baseline: usd("879.80"),
    });
    assert.equal(r.verdict, "MATCHED");
    assert.equal(r.difference?.isZero(), true);
  });

  it("drift → DISCREPANCY: difference named, higher source wins, SURFACED ONLY", () => {
    const r = compareLedgerToBroker({
      ...BASE, brokerBalance: usd("995.00"), ledgerCash: usd("120.20"), baseline: usd("879.80"),
    });
    assert.equal(r.verdict, "DISCREPANCY");
    assert.equal(r.difference?.equals(usd("-5.00")), true);
    // Contradiction fixture: the broker figure (BROKER_EVENT) outranks the
    // ledger sum (LOCAL_EXECUTION) — the higher source wins per #31.
    assert.equal(r.truthWinner, "BROKER_EVENT");
    assert.match(r.reason, /no auto-adjustment/i);
  });

  it("equal-rank contradiction has NO winner (fail-closed, journaled unresolved)", () => {
    const r = compareLedgerToBroker({
      ...BASE,
      brokerSource: "LOCAL_EXECUTION",
      brokerBalance: usd("995.00"), ledgerCash: usd("120.20"), baseline: usd("879.80"),
    });
    assert.equal(r.verdict, "DISCREPANCY");
    assert.equal(r.truthWinner, null);
    assert.match(r.reason, /UNRESOLVED/);
  });

  it("the comparison result carries NO adjustment/fix field — surfacing only, by construction", () => {
    const r = compareLedgerToBroker({
      ...BASE, brokerBalance: usd("995.00"), ledgerCash: usd("120.20"), baseline: usd("879.80"),
    });
    assert.deepEqual(Object.keys(r).sort(), [
      "difference", "establishedBaseline", "reason", "truthWinner", "verdict",
    ]);
  });
});

describe("worker enable polarity", () => {
  it("absent env = ENABLED; explicit off values disable", () => {
    assert.equal(economicReconciliationEnabled(undefined), true);
    assert.equal(economicReconciliationEnabled("1"), true);
    for (const off of ["0", "false", "off", "no", " FALSE "]) {
      assert.equal(economicReconciliationEnabled(off), false);
    }
  });
});

describe("seam + worker source pins (the wiring itself)", () => {
  const PIPELINE = readFileSync(
    new URL("../../live/liveCommandPipeline.ts", import.meta.url), "utf8");
  const GUIDED = readFileSync(
    new URL("../../phase6/guidedDispatchEntry.ts", import.meta.url), "utf8");
  const INDEX = readFileSync(
    new URL("../../../index.ts", import.meta.url), "utf8");
  const GUARD = readFileSync(
    new URL("../../../../../../scripts/src/ci/check-vault-mutations.ts", import.meta.url), "utf8");
  const SCHEMA_BARREL = readFileSync(
    new URL("../../../../../../lib/db/src/schema/index.ts", import.meta.url), "utf8");
  const PENDING_SQL = readFileSync(
    new URL("../../../../../../docs/migrations-pending/build-economic-truth.sql", import.meta.url), "utf8");

  it("recordLiveCommandResult posts the open-fill journal at the fill-confirmation seam", () => {
    assert.match(PIPELINE, /postLiveOpenFill\(/);
    assert.match(PIPELINE, /economicSeams\.js/);
  });

  it("the close-reconciliation seam posts the close journal", () => {
    assert.match(PIPELINE, /postLiveClose\(/);
  });

  it("guided demo settlement posts to the DEMO ledger partition", () => {
    assert.match(GUIDED, /postDemoStakeFill\(/);
    // and only after a venue-confirmed contract:
    assert.match(GUIDED, /outcome\.claimed && outcome\.ok && outcome\.venueContractRef/);
  });

  it("the reconciliation worker is registered at startup", () => {
    assert.match(INDEX, /startEconomicReconciliationWorker\(\)/);
  });

  it("both ledger tables are guarded append-only by check-vault-mutations", () => {
    assert.match(GUARD, /"economicPostingsTable"/);
    assert.match(GUARD, /"economicDiscrepanciesTable"/);
    assert.match(GUARD, /"economic_postings"/);
    assert.match(GUARD, /"economic_discrepancies"/);
  });

  it("schema is registered and the pending additive SQL exists", () => {
    assert.match(SCHEMA_BARREL, /economicPostings/);
    assert.match(PENDING_SQL, /CREATE TABLE IF NOT EXISTS economic_postings/);
    assert.match(PENDING_SQL, /CREATE TABLE IF NOT EXISTS economic_discrepancies/);
    assert.doesNotMatch(PENDING_SQL, /\bDROP\b|\bALTER TABLE [^;]*DROP\b/i);
  });

  it("the worker never touches a posting writer (surfacing only, no auto-adjustment)", () => {
    const WORKER = readFileSync(
      new URL("../economicReconciliationWorker.ts", import.meta.url), "utf8");
    assert.doesNotMatch(WORKER, /writeEconomicJournal/);
    assert.doesNotMatch(WORKER, /\.update\s*\(\s*economicPostingsTable/);
    assert.doesNotMatch(WORKER, /\.delete\s*\(\s*economicPostingsTable/);
    // and it consumes the truth-hierarchy-ranked comparison:
    assert.match(WORKER, /compareLedgerToBroker/);
  });
});
