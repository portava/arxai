// GET /admin/handshake-monitor ran the investor-scoped handshakes with no
// investor context, so every layer was SKIPPED and the verdict read "Error"
// and was counted in summary.errors — though nothing errored. The real
// coordinator runs here with the layer adapters stubbed to PASS and the
// evidence log stubbed (no database, no broker, no network). A coordinator
// failure must still read ERROR.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { withRouter } from "./_fakeRouteDb.js";

mock.module("../../lib/handshake/layerAdapters.js", {
  namedExports: {
    LAYER_ADAPTERS: new Proxy({}, {
      get: () => async () => ({ status: "PASS", detail: "ok", ageMs: 1_000 }),
    }),
  },
});
const state = { logThrows: false };
mock.module("../../lib/handshake/handshakeLog.js", {
  namedExports: {
    // Throws synchronously when asked, so evaluate() itself fails (the
    // coordinator calls it un-awaited inside its try block).
    logHandshakeResult: (): Promise<void> => {
      if (state.logThrows) throw new Error("evaluation failure");
      return Promise.resolve();
    },
    logHandshakeResults: async () => undefined,
    getRecentHandshakeCheckins: async () => [],
  },
});
const router = (await import("../adminHandshakeMonitor.js")).default;
const { runHandshake } = await import("../../lib/handshake/coordinator.js");

type View = { type: string; overallStatus: string; checks: { status: string }[] };

async function monitor(): Promise<{ verdicts: View[]; summary: Record<string, number> }> {
  let out = { verdicts: [] as View[], summary: {} as Record<string, number> };
  await withRouter(router, { id: 1, role: "ADMIN" }, async (base) => {
    const r = await fetch(`${base}/admin/handshake-monitor`);
    assert.equal(r.status, 200);
    out = await r.json() as typeof out;
  });
  return out;
}

test("investor-scoped handshakes with no investor context are 'not checked', not errors", async () => {
  const { verdicts, summary } = await monitor();
  const investor = verdicts.filter((v) => v.checks.length > 0 && v.checks.every((c) => c.status === "SKIPPED"));
  assert.ok(investor.length > 0, "the admin view has investor-scoped handshakes with only SKIPPED layers");
  for (const v of investor) assert.equal(v.overallStatus, "NOT_CHECKED", v.type);
  assert.equal(summary["errors"], 0, "nothing errored");
  assert.equal(summary["notChecked"], investor.length);
  const counted = ["ready", "warnings", "waiting", "blocked", "errors", "notChecked"]
    .reduce((n, k) => n + (summary[k] ?? 0), 0);
  assert.equal(counted, summary["total"], "every verdict is counted exactly once");
});

test("a coordinator failure is still reported as ERROR", async () => {
  state.logThrows = true;
  try {
    const r = await runHandshake("MARKET_DATA", { force: true, context: { isAdmin: true } });
    assert.equal(r.overallStatus, "ERROR");
    assert.match(r.userFacingMessage, /unavailable/i);
  } finally {
    state.logThrows = false;
  }
});
