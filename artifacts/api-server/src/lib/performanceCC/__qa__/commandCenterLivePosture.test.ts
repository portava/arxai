// The AI Performance Command Center payload returned only the constant
// liveTradingStatus "DISABLED" — for every account, including an armed
// LIVE_SHARED trader whose dashboard says "Live trading is active". The
// payload now carries the account's live posture from the same account-mode
// check as the dashboard (livePosture) and says what the legacy constant
// covers. Nothing is enabled and no gate reads either field.
//
// The real buildCommandCenter and the real precedence resolver run; the
// database handle returns an empty book and the account reads are stubbed.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/performanceCC/__qa__/commandCenterLivePosture.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const database = await import("@workspace/db");

const state = { armed: true, shellFails: false };

function chain(): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.orderBy = self; q.limit = self; q.groupBy = self; q.innerJoin = self; q.leftJoin = self;
  q.then = (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve([]).then(resolve, reject);
  return q;
}
mock.module("@workspace/db", {
  namedExports: { ...database, db: { select: () => chain() } },
});
mock.module("../../learning/scopedMemory.js", {
  namedExports: { listOwnEdges: async () => [], listOwnMistakes: async () => [] },
});
mock.module("../../readiness/traderReadiness.js", { namedExports: { evaluateReadiness: async () => { throw new Error("governor down (fixture)"); } } });
mock.module("../../../routes/meAccountShell.js", {
  namedExports: {
    computeAccountShell: async () => {
      if (state.shellFails) throw new Error("ECONNREFUSED (fixture)");
      return { tradingMode: "LIVE", tradingStatus: "ACTIVE", notes: { sharedMasterAccountAssigned: true, needsReviewItems: 0 } };
    },
  },
});
mock.module("../../live/liveArming.js", { namedExports: { getMyArming: async () => ({ isArmed: state.armed }) } });
mock.module("../../safety/platformSwitches.js", {
  namedExports: {
    readPlatformSwitches: async () => ({
      readable: true,
      liveBrokerExecution: { envEnabled: true, operatorArmed: true, enabled: true, armedAt: null, armedBy: null, armedBridgeId: null },
    }),
  },
});

const { buildCommandCenter } = await import("../commandCenter.js");

test("armed LIVE_SHARED: command center reports the account's live posture, not only DISABLED", async () => {
  state.armed = true; state.shellFails = false;
  const cc = (await buildCommandCenter(7)) as Record<string, unknown>;
  const lp = cc.livePosture as { state: string; currentAccountMode: string | null; plainEnglish: string } | undefined;
  assert.ok(lp, "livePosture present");
  assert.equal(lp.state, "LIVE_ARMED");
  assert.equal(lp.currentAccountMode, "LIVE_SHARED");
  assert.match(lp.plainEnglish, /Live trading is active on your shared-master allocation/);
  // The legacy constant stays, and says what it covers.
  assert.equal(cc.liveTradingStatus, "DISABLED");
  assert.match(String(cc.liveTradingStatusScope), /not your account's live-trading status/);
});

test("account mode unreadable: livePosture is UNKNOWN, not paper", async () => {
  state.shellFails = true;
  const cc = (await buildCommandCenter(7)) as Record<string, unknown>;
  const lp = cc.livePosture as { state: string; currentAccountMode: string | null; plainEnglish: string };
  assert.equal(lp.state, "UNKNOWN");
  assert.equal(lp.currentAccountMode, null);
  assert.match(lp.plainEnglish, /could not be read/);
});
