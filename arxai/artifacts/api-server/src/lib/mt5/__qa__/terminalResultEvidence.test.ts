import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTerminalResultEvidence as normalize, terminalEvidenceConflicts, terminalResultKind, TERMINAL_ENTRY_COMMAND_TYPES, type TerminalResultEvidence } from "../terminalResultEvidence.js";

const entry = (over: Record<string, unknown> = {}) => ({ resultEvidenceVersion: 1, resultKind: "ENTRY", tradeCallSucceeded: true,
  mt5Retcode: 10009, resultDeal: "81", resultOrder: "82", requestedVolume: .2, resultVolume: .2, resultPrice: 1.1, ...over });

test("legacy reports are compatibility input, never versioned execution certification", () => {
  assert.equal(normalize({ status: "FILLED", filledLotSize: .2, fillPrice: 1.1 }, "OPEN_MARKET", .2), null);
  assert.equal(normalize(entry({ resultEvidenceVersion: undefined }), "OPEN_MARKET", .2)?.outcome, "LIVE_UNKNOWN");
});
test("all supported market entries require synchronous deal, order, price and requested volume evidence", () => {
  for (const action of TERMINAL_ENTRY_COMMAND_TYPES) {
    const out = normalize(entry(), action, .2)!;
    assert.equal(terminalResultKind(action), "ENTRY");
    assert.equal(out.outcome, "LIVE_FILLED"); assert.equal(out.brokerTicket, "82");
    assert.equal(out.executedVolume, .2); assert.equal(out.fillPrice, 1.1);
  }
  for (const action of ["PLACE_PENDING_ORDER", "REVERSE_POSITION", "CLOSE_ALL", "unknown"]) {
    assert.equal(normalize(entry(), action, .2)?.outcome, "LIVE_UNKNOWN");
  }
});
test("partial execution never masquerades as the requested full volume", () => {
  for (const over of [{ resultVolume: .1 }, { mt5Retcode: 10010, resultVolume: .1 }, { mt5Retcode: 10010 }]) {
    const out = normalize(entry(over), "OPEN_MARKET", .2)!;
    assert.equal(out.outcome, "LIVE_PARTIALLY_FILLED"); assert.equal(out.executedVolume, over.resultVolume ?? .2);
  }
});
test("missing, contradictory, nonfinite or malformed evidence withholds execution amounts", () => {
  for (const over of [{ resultEvidenceVersion: 2 }, { resultKind: "CLOSE" }, { tradeCallSucceeded: false }, { resultDeal: "0" },
    { resultDeal: "-1" }, { resultDeal: "18446744073709551616" }, { resultOrder: "0" }, { resultOrder: "1.2" },
    { resultPrice: 0 }, { resultPrice: Infinity }, { resultVolume: NaN }, { resultVolume: .3 }, { requestedVolume: .1 },
    { resultVolume: 0 }, { mt5Retcode: 10009.5 }, { mt5Retcode: "10009" }]) {
    const out = normalize(entry(over), "OPEN_MARKET", .2)!;
    assert.equal(out.outcome, "LIVE_UNKNOWN", JSON.stringify(over));
    assert.equal(out.executedVolume, null); assert.equal(out.fillPrice, null);
  }
});
test("accepted order is acknowledged without a fabricated fill; rejection needs zero execution evidence", () => {
  const ack = normalize(entry({ mt5Retcode: 10008, resultDeal: "0", resultVolume: 0 }), "OPEN_MARKET", .2)!;
  assert.equal(ack.outcome, "LIVE_ACKNOWLEDGED"); assert.equal(ack.executedVolume, null); assert.equal(ack.fillPrice, null);
  const rejection = entry({ mt5Retcode: 10006, tradeCallSucceeded: false, resultDeal: "0", resultVolume: 0 });
  assert.equal(normalize(rejection, "OPEN_MARKET", .2)?.outcome, "LIVE_REJECTED");
  assert.equal(normalize({ ...rejection, resultVolume: .1 }, "OPEN_MARKET", .2)?.outcome, "LIVE_UNKNOWN");
});
test("close and modify confirmations bind the actual position and never infer another ticket", () => {
  const close = entry({ resultKind: "CLOSE", positionTicket: "93", mt5PositionTicket: "93" });
  assert.equal(normalize(close, "CLOSE_POSITION", .2, "93")?.outcome, "LIVE_FILLED");
  for (const over of [{ positionTicket: "94" }, { mt5PositionTicket: "94" }, { positionTicket: "0", mt5PositionTicket: "0" }]) {
    assert.equal(normalize({ ...close, ...over }, "CLOSE_POSITION", .2, "93")?.outcome, "LIVE_UNKNOWN");
  }
  const modify = entry({ resultKind: "MODIFY", resultDeal: "0", resultVolume: 0, positionTicket: "93" });
  const out = normalize(modify, "MODIFY_POSITION", null, "93")!;
  assert.equal(out.outcome, "LIVE_FILLED"); assert.equal(out.executedVolume, null); assert.equal(out.fillPrice, null);
  assert.equal(normalize(modify, "MODIFY_POSITION", null, "94")?.outcome, "LIVE_UNKNOWN");
});
test("retained evidence is a primitive allowlist, not an arbitrary credential-bearing payload", () => {
  const out = normalize(entry({ apiKey: "fixture-secret", arbitrary: { token: "fixture" }, positionTicket: "x".repeat(100) }), "OPEN_MARKET", .2)!;
  assert.equal(Object.hasOwn(out.evidence, "apiKey"), false); assert.equal(Object.hasOwn(out.evidence, "arbitrary"), false);
  assert.equal(String(out.evidence.positionTicket).length, 80);
  assert.equal(out.evidence.volumeBasis, "SYNCHRONOUS_REQUEST_RESULT");
});
test("repeat delivery is identical evidence, never permission for a second execution", () => {
  const prior = normalize(entry(), "OPEN_MARKET", .2)!.evidence;
  assert.equal(terminalEvidenceConflicts(prior, { ...prior }), false);
  const contradictions: TerminalResultEvidence[] = [{ resultDeal: "99" }, { resultOrder: "99" }, { resultVolume: .1 }];
  for (const over of contradictions) assert.equal(terminalEvidenceConflicts(prior, { ...prior, ...over }), true);
  const accepted = { ...prior, resultDeal: "0", resultVolume: 0 };
  assert.equal(terminalEvidenceConflicts(accepted, prior), false);
  assert.equal(terminalEvidenceConflicts(accepted, { ...prior, resultOrder: "99" }), true);
});
