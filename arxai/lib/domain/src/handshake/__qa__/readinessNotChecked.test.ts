// Handshake readiness: nothing evaluated is "not checked", not "Error".
//
// deriveReadinessStatus returned ERROR whenever no check was evaluable — a
// scaffold handshake with no layers, or an investor-scoped handshake in the
// admin view where every layer is SKIPPED ("no investor context"). The monitor
// showed an "Error" badge and counted them under "N errors" though nothing
// errored.
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateHandshake,
  buildHandshakeCopy,
  deriveReadinessStatus,
  summarizeFreshness,
  HANDSHAKE_READINESS_STATUSES,
  type HandshakeLayerCheck,
} from "../index.js";

const at = "2026-10-28T12:00:00.000Z";
const derive = (checks: HandshakeLayerCheck[]) =>
  deriveReadinessStatus(checks, aggregateHandshake(checks), summarizeFreshness(checks, at));

test("no checks (not wired) → NOT_CHECKED, not ERROR", () => {
  assert.equal(derive([]), "NOT_CHECKED");
});

test("every layer SKIPPED (no investor context) → NOT_CHECKED, not ERROR", () => {
  assert.equal(derive([
    { layer: "INVESTOR_FUND_BOOK", status: "SKIPPED", required: true, detail: "no investor context", ageMs: null },
    { layer: "MARKET_DATA", status: "SKIPPED", required: false, detail: "no investor context", ageMs: null },
  ]), "NOT_CHECKED");
});

test("NOT_CHECKED is a declared readiness status with plain copy", () => {
  assert.ok((HANDSHAKE_READINESS_STATUSES as readonly string[]).includes("NOT_CHECKED"));
  const copy = buildHandshakeCopy("INVESTOR_VALUE", "NOT_CHECKED");
  assert.match(copy.userFacingMessage, /not checked/i);
  assert.doesNotMatch(copy.userFacingMessage, /unavailable|error/i);
});

test("evaluated checks are unchanged", () => {
  assert.equal(derive([{ layer: "MARKET_DATA", status: "PASS", required: true, detail: "ok", ageMs: 1000 }]), "READY");
  assert.equal(derive([{ layer: "MARKET_DATA", status: "FAIL", required: true, detail: "down", ageMs: null }]), "BLOCKED");
});
