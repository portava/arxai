// Every /api/help/* response carried appMode "PAPER_ONLY", liveTradingStatus
// "DISABLED" and canPlaceLiveTrade false as its only live-trading words, even
// when the platform's live-execution switch is on and LIVE_SHARED traders are
// armed. The constants stay (they describe the help service), and each
// response now says what they cover (liveTradingStatusScope) and carries the
// platform switch as read for the response (livePosture).
//
// Runs the REAL help router with the platform switch reader and the why-blocked
// explainer replaced by fixtures: no database, no broker, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/helpEnvelopeLivePosture.test.ts

import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const state = { readable: true, enabled: true };
mock.module("../../lib/safety/platformSwitches.js", {
  namedExports: {
    readPlatformSwitches: async () => ({
      readable: state.readable,
      liveBrokerExecution: {
        envEnabled: state.enabled, operatorArmed: state.enabled, enabled: state.enabled && state.readable,
        armedAt: null, armedBy: null, armedBridgeId: null,
      },
    }),
  },
});
mock.module("../../lib/onboarding/whyBlocked.js", {
  namedExports: {
    explainBlockedAction: async () => ({ explanation_id: "expl_1" }),
    explainTopic: async () => ({ help_id: "help_1" }),
  },
});

const { default: router } = await import("../help.js");

let server: Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { authUser: unknown }).authUser = { id: 5, role: "TRADER" }; next(); });
  app.use("/api", router);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await r.json()) as Record<string, unknown>;
}

test("live execution switched on: help responses say so beside their help-service constants", async () => {
  state.readable = true; state.enabled = true;
  for (const [method, path, body] of [
    ["GET", "/api/help/topics", undefined],
    ["GET", "/api/help/page?route=/charts", undefined],
    ["POST", "/api/help/why-blocked", { blockedAction: "ENABLE_LIVE_TRADING" }],
    ["POST", "/api/help/demo", {}],
  ] as const) {
    const r = await call(method, path, body);
    const lp = r["livePosture"] as { state: string; plainEnglish: string } | undefined;
    assert.ok(lp, `${path}: livePosture present`);
    assert.equal(lp.state, "ON", path);
    assert.match(lp.plainEnglish, /switched on for the platform/, path);
    assert.equal(r["liveTradingStatus"], "DISABLED", `${path}: the legacy constant stays`);
    assert.match(String(r["liveTradingStatusScope"]), /not whether live trading is on/, path);
  }
});

test("switch unreadable: livePosture is UNKNOWN, not OFF", async () => {
  state.readable = false; state.enabled = false;
  const r = await call("GET", "/api/help/topics");
  const lp = r["livePosture"] as { state: string; plainEnglish: string };
  assert.equal(lp.state, "UNKNOWN");
  assert.match(lp.plainEnglish, /could not be read/);
});

test("an error response carries the same scope statement", async () => {
  state.readable = true; state.enabled = false;
  const r = await call("GET", "/api/help/topic/no-such-topic");
  assert.equal(r["error"], "TOPIC_NOT_FOUND");
  assert.match(String(r["liveTradingStatusScope"]), /describe this help service/);
  assert.equal((r["livePosture"] as { state: string }).state, "OFF");
});
