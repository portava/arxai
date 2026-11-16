import { test } from "node:test";
import assert from "node:assert/strict";
import { projectNativeAccountReport as project, nativeAccountBinding, isExactNativeAccountReplay } from "../nativeAccountReport.js";
import { NOW, connection, payload, receipt } from "./nativeAccountReport.fixture.js";

test("an accepted own-account observation remains reported, never current verified money", () => {
  for (const age of [0, 86_400_000, 365 * 86_400_000]) {
    const out = project(connection, receipt(), NOW + age);
    assert.equal(out.status, "reported"); assert.equal(out.currentVerified, false);
    assert.equal(out.reason, "CLOCK_AND_CONTINUITY_UNVERIFIED"); assert.equal(out.observationAgeMs, 1000 + age);
    assert.equal(out.observedAt, new Date(NOW - 1000).toISOString());
  }
});
test("missing scope and another user's or bridge's receipt withhold all amounts", () => {
  for (const c of [null, { ...connection, id: 0 }, { ...connection, userId: null }]) assert.equal(project(c, receipt(), NOW).status, "unavailable");
  for (const over of [{ userId: 999 }, { bridgeConnectionId: 999 }, { messageType: "TICK" }]) {
    const out = project(connection, receipt(over), NOW);
    assert.equal(out.reason, "ACCOUNT_SCOPE_MISMATCH"); assert.equal(out.amounts, null); assert.equal(out.currentVerified, false);
  }
  assert.equal(project(connection, null, NOW).reason, "NO_ACCOUNT_REPORT");
});
test("native binding tolerates login leading zeros but not another account or server era", () => {
  assert.equal(nativeAccountBinding("12345", "Fixture-Demo"), nativeAccountBinding("00012345", "Fixture-Demo"));
  for (const over of [{ accountNumber: "12346" }, { serverName: "Fixture-Live" }, { accountNumber: "" }, { serverName: "" }]) {
    assert.equal(project({ ...connection, ...over }, receipt(), NOW).reason, "ACCOUNT_BINDING_MISMATCH");
  }
  for (const login of ["0", "-1", "1.5", "1e2", "1".repeat(65)]) assert.equal(nativeAccountBinding(login, "Fixture-Demo"), null);
});
test("rejected, replayed, unsupported or unordered receipts never revive prior money", () => {
  for (const [over, reason] of [
    [{ accepted: false }, "ACCOUNT_REPORT_REJECTED"], [{ duplicateDropped: true }, "ACCOUNT_REPORT_REJECTED"],
    [{ sequenceVerdict: "DUPLICATE" }, "ACCOUNT_SEQUENCE_UNVERIFIED"], [{ sequence: -1 }, "ACCOUNT_SEQUENCE_UNVERIFIED"],
    [{ sequence: 2147483648 }, "ACCOUNT_SEQUENCE_UNVERIFIED"], [{ protocolVersion: 3 }, "ACCOUNT_PROTOCOL_UNSUPPORTED"],
    [{ streamKey: "ACCOUNT" }, "UNEXPECTED_ACCOUNT_STREAM"], [{ payload: { balance: 20, equity: 30, currency: "USD" } }, "LEGACY_ACCOUNT_REPORT_UNVERIFIED"],
  ] as const) {
    const out = project(connection, receipt(over), NOW); assert.equal(out.reason, reason); assert.equal(out.amounts, null);
  }
});
test("future or impossible observation/receipt ordering and disconnected terminal are withheld", () => {
  for (const over of [{ serverReceivedAtEpochMs: NOW + 1 }, { serverReceivedAtEpochMs: NaN }]) assert.equal(project(connection, receipt(over), NOW).reason, "RECEIPT_TIME_INVALID");
  for (const over of [{ observedAtEpochMs: NOW }, { observedAtEpochMs: NOW - 200 }, { observedAtEpochMs: 9e15 }]) {
    assert.equal(project(connection, receipt({ payload: { ...payload(), ...over } }), NOW).status, "unavailable");
  }
  for (const eaCreatedAtEpochMs of [undefined, NOW + 1, NOW - 2000]) assert.equal(project(connection, receipt({ eaCreatedAtEpochMs }), NOW).reason, "CAPTURE_TIME_INVALID");
  assert.equal(project(connection, receipt({ payload: { ...payload(), terminalConnected: false } }), NOW).reason, "TERMINAL_DISCONNECTED");
});
test("replay identity includes the owner, bridge, sequence, producer and exact payload", () => {
  const stored = receipt();
  assert.equal(isExactNativeAccountReplay(stored, receipt({ payload: Object.fromEntries(Object.entries(payload()).reverse()) })), true);
  for (const over of [{ userId: 999 }, { bridgeConnectionId: 999 }, { sequence: 9 }, { idempotencyKey: "other" }, { eaVersion: "other" },
    { payload: { ...payload(), producerInstanceId: "b".repeat(32) } }, { payload: { ...payload(), profit: "-8.75" } }]) {
    assert.equal(isExactNativeAccountReplay(stored, receipt(over)), false);
  }
  assert.equal(isExactNativeAccountReplay(receipt({ accepted: false }), stored), false);
  assert.equal(isExactNativeAccountReplay(receipt({ duplicateDropped: true }), stored), false);
});
