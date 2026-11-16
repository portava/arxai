// getUserModeScope() falls back to PAPER when any of its reads fails (account
// shell, arming, platform switch, approved-trader state). That is the safe
// row filter, but the fallback was indistinguishable from a real PAPER
// account: modeScopeEnvelope() returned currentAccountMode "PAPER" with
// modeScopeApplied true, so a surface that echoes it labelled an unreadable
// (possibly LIVE_SHARED) account PAPER. The scope now says whether the mode
// was read (modeResolved) and, when it was not, a plain-English note that the
// rows are filtered as PAPER because the mode could not be read. The row
// filter itself is unchanged (still PAPER).
//
// Runs the REAL resolver and envelope with their reads replaced by fixtures:
// no database, no broker, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/modeScope/__qa__/modeScopeReadFailure.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const state = { shellThrows: false };
mock.module("../../../routes/meAccountShell.js", {
  namedExports: {
    computeAccountShell: async () => {
      if (state.shellThrows) throw new Error("connect ECONNREFUSED 127.0.0.1:1");
      return { tradingMode: "DEMO", tradingStatus: "ACTIVE", notes: { sharedMasterAccountAssigned: false, needsReviewItems: 0 } };
    },
  },
});
mock.module("../../live/liveArming.js", { namedExports: { getMyArming: async () => null } });
mock.module("../../safety/platformSwitches.js", {
  namedExports: {
    readPlatformSwitches: async () => ({
      readable: true,
      liveBrokerExecution: { envEnabled: false, operatorArmed: false, enabled: false, armedAt: null, armedBy: null, armedBridgeId: null },
    }),
  },
});
mock.module("../../live/approvedTraderLiveState.js", {
  namedExports: { buildApprovedTraderLiveState: async () => ({ approvedTraderBridgeAssigned: false }) },
});

const { getUserModeScope, modeScopeEnvelope } = await import("../getUserModeScope.js");

test("a failed read keeps the PAPER row filter but does not claim the account is PAPER", async () => {
  state.shellThrows = true;
  const scope = await getUserModeScope(7);
  assert.equal(scope.primaryDataDomain, "paper", "row filter unchanged: safest scope");
  assert.equal(scope.currentAccountMode, "PAPER", "row filter unchanged");
  assert.equal(scope.modeResolved, false);
  assert.match(String(scope.modeNote), /could not be read/);

  const env = modeScopeEnvelope(scope);
  assert.equal(env.modeResolved, false);
  assert.match(String(env.modeScopeNote), /trading mode could not be read \(tried \d\d:\d\d UTC\)/);
  assert.match(String(env.modeScopeNote), /filtered as PAPER/);
  assert.match(String(env.modeScopeNote), /may not be in PAPER mode/);
});

test("a read that succeeds reports the mode as resolved, with no note", async () => {
  state.shellThrows = false;
  const scope = await getUserModeScope(7);
  assert.equal(scope.currentAccountMode, "DEMO", "the mode actually read");
  assert.equal(scope.modeResolved, true);
  assert.equal(scope.modeNote, null);
  const env = modeScopeEnvelope(scope);
  assert.equal(env.modeResolved, true);
  assert.equal(env.modeScopeNote, null);
});
