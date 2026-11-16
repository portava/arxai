// /api/readiness/* answered every call with appMode "PAPER_ONLY",
// liveTradingStatus "DISABLED" and canProceedToLiveTrading false as the only
// live-trading words — also while the platform's live broker execution
// switch is on and LIVE_SHARED traders are armed. Those constants describe
// the paper-stack gate and stay; each response now also says what they cover
// and carries the platform switch as read for that response (livePosture,
// from readPlatformSwitches). Unreadable → UNKNOWN.
//
// The real router runs, called in-process (no server, no network); the gate,
// checklist, permission and switch reads are stubbed.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/readinessLivePosture.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const state = { readable: true, enabled: true };

mock.module("../../lib/readiness/gate.js", {
  namedExports: {
    runReadinessGate: async () => ({ overallStatus: "PASS" }),
    getGateStatus: async () => ({ currentStatus: "PASS", readinessScore: 92, readinessGrade: "A", criticalFailureCount: 0 }),
    getRecentReports: async () => [],
    getReportById: async () => null,
  },
});
mock.module("../../lib/readiness/checklist.js", { namedExports: { buildChecklist: async () => ({ items: [] }) } });
mock.module("../../lib/security/permissions.js", { namedExports: { checkPermission: async () => ({ allowed: true }) } });
mock.module("../../lib/security/middleware.js", { namedExports: { readRoleFromRequest: () => "OWNER" } });
mock.module("../../lib/security/events.js", { namedExports: { recordSecurityEvent: async () => undefined } });
mock.module("../../lib/safety/platformSwitches.js", {
  namedExports: {
    readPlatformSwitches: async () => ({
      readable: state.readable,
      liveBrokerExecution: { envEnabled: state.enabled, operatorArmed: state.enabled, enabled: state.enabled && state.readable, armedAt: null, armedBy: null, armedBridgeId: null },
    }),
  },
});

const { default: router } = await import("../readiness.js");

async function call(method: string, url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return await new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(c: number) { status = c; return res; },
      json(b: Record<string, unknown>) { resolve({ status, body: b }); return res; },
      setHeader() {}, getHeader() { return undefined; },
    };
    const req = { method, url, originalUrl: url, path: url, headers: {}, query: {}, params: {}, body: {} };
    (router as unknown as { handle: (q: unknown, s: unknown, n: (e?: unknown) => void) => void })
      .handle(req, res, (e?: unknown) => reject(e ?? new Error(`no route for ${method} ${url}`)));
  });
}

test("live execution on: readiness status says what its constants cover and reports the switch", async () => {
  state.readable = true; state.enabled = true;
  const { body } = await call("GET", "/readiness/status");
  assert.equal(body.liveTradingStatus, "DISABLED");
  assert.match(String(body.liveTradingStatusScope), /not whether live trading is on/);
  const lp = body.livePosture as { state: string; plainEnglish: string } | undefined;
  assert.ok(lp, "livePosture present");
  assert.equal(lp.state, "ON");
  assert.match(lp.plainEnglish, /switched on for the platform/);
});

test("switch unreadable: livePosture is UNKNOWN on every readiness response", async () => {
  state.readable = false; state.enabled = false;
  for (const [m, u] of [["GET", "/readiness/checklist"], ["GET", "/readiness/integration/hh"], ["POST", "/readiness/demo"]] as const) {
    const { body } = await call(m, u);
    const lp = body.livePosture as { state: string } | undefined;
    assert.equal(lp?.state, "UNKNOWN", u);
  }
});
