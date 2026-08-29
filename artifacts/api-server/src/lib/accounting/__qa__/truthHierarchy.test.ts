// Truth hierarchy contract (#31) — precedence + contradiction fixtures.
//
// The contract under test: broker statement > broker event > local execution
// record > derived analytics, deterministically; the higher source WINS and
// the contradiction is JOURNALED (returned for journaling — never swallowed);
// equally-ranked disagreement resolves to NOTHING (winner null), because a
// fabricated tie-break is false certainty.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TRUTH_SOURCES, truthRank, outranks, isTruthSource, resolveTruthConflict,
  type TruthClaim,
} from "@workspace/domain/safety-contracts/truthHierarchy";

describe("the precedence order is exactly the declared one", () => {
  it("BROKER_STATEMENT > BROKER_EVENT > LOCAL_EXECUTION > DERIVED", () => {
    assert.deepEqual([...TRUTH_SOURCES], [
      "BROKER_STATEMENT", "BROKER_EVENT", "LOCAL_EXECUTION", "DERIVED",
    ]);
    assert.ok(outranks("BROKER_STATEMENT", "BROKER_EVENT"));
    assert.ok(outranks("BROKER_EVENT", "LOCAL_EXECUTION"));
    assert.ok(outranks("LOCAL_EXECUTION", "DERIVED"));
    assert.ok(!outranks("DERIVED", "BROKER_STATEMENT"));
    assert.ok(!outranks("BROKER_EVENT", "BROKER_EVENT"));
  });

  it("an unrecognised source fails CLOSED below DERIVED — it can never outrank evidence", () => {
    assert.ok(truthRank("SOME_FUTURE_SOURCE") > truthRank("DERIVED"));
    assert.ok(!outranks("SOME_FUTURE_SOURCE", "DERIVED"));
    assert.equal(isTruthSource("SOME_FUTURE_SOURCE"), false);
    assert.equal(isTruthSource("BROKER_STATEMENT"), true);
  });
});

describe("contradiction fixtures — the higher source wins AND the contradiction is journaled", () => {
  const statement: TruthClaim = { source: "BROKER_STATEMENT", valueKey: "12020", detail: "statement net 120.20" };
  const localRecord: TruthClaim = { source: "LOCAL_EXECUTION", valueKey: "12345", detail: "local floatingPl 123.45" };
  const derived: TruthClaim = { source: "DERIVED", valueKey: "99999", detail: "analytics estimate" };

  it("broker statement beats a disagreeing local record; the loss is surfaced", () => {
    const r = resolveTruthConflict([localRecord, statement]);
    assert.equal(r.winner?.source, "BROKER_STATEMENT");
    assert.equal(r.contradictions.length, 1);
    assert.equal(r.contradictions[0]!.overruled.source, "LOCAL_EXECUTION");
    assert.equal(r.contradictions[0]!.unresolvable, false);
  });

  it("resolution is deterministic regardless of claim arrival order", () => {
    const a = resolveTruthConflict([derived, localRecord, statement]);
    const b = resolveTruthConflict([statement, derived, localRecord]);
    assert.equal(a.winner?.source, "BROKER_STATEMENT");
    assert.deepEqual(a.winner, b.winner);
    assert.equal(a.contradictions.length, b.contradictions.length);
  });

  it("agreement is not a contradiction", () => {
    const agreeingEvent: TruthClaim = { source: "BROKER_EVENT", valueKey: "12020" };
    const r = resolveTruthConflict([statement, agreeingEvent]);
    assert.equal(r.winner?.source, "BROKER_STATEMENT");
    assert.equal(r.contradictions.length, 0);
  });

  it("EQUALLY-ranked disagreement resolves to NOTHING — no fabricated tie-break", () => {
    const eventA: TruthClaim = { source: "BROKER_EVENT", valueKey: "100" };
    const eventB: TruthClaim = { source: "BROKER_EVENT", valueKey: "200" };
    const r = resolveTruthConflict([eventA, eventB]);
    assert.equal(r.winner, null);
    assert.equal(r.contradictions.length, 1);
    assert.equal(r.contradictions[0]!.unresolvable, true);
  });

  it("zero claims is honest nothing, not an error", () => {
    const r = resolveTruthConflict([]);
    assert.equal(r.winner, null);
    assert.deepEqual(r.contradictions, []);
  });

  it("every pairwise disagreement below the winner is journaled, not just the first", () => {
    const r = resolveTruthConflict([statement, localRecord, derived]);
    assert.equal(r.winner?.source, "BROKER_STATEMENT");
    const overruledSources = r.contradictions.map((c) => c.overruled.source).sort();
    assert.deepEqual(overruledSources, ["DERIVED", "LOCAL_EXECUTION"]);
  });
});
