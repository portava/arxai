// The trader-readiness evaluation (served as `governor` by /api/risk-governor/*,
// the cockpit, coach and why-blocked) returned mode "PAPER_ONLY" and
// liveTradingStatus "DISABLED" as its only live-trading words, for every
// account, including an armed LIVE_SHARED trader. The constants stay (they are
// stored on every evaluation row), and the evaluation now says what they
// cover (liveTradingStatusScope).
//
// The real evaluateReadiness runs with the database unreachable: every read
// fails and is reported as a missing data source. Nothing is persisted
// (persist: false). No broker, no network.
//
// Run: node --import tsx --test --test-force-exit \
//        src/lib/readiness/__qa__/governorLiveStatusScope.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

const { evaluateReadiness, GOVERNOR_LIVE_STATUS_SCOPE } = await import("../traderReadiness.js");
const quiet = { info() {}, warn() {}, error() {} };

test("the evaluation says its PAPER_ONLY / DISABLED labels are not live-trading status", async () => {
  const e = await evaluateReadiness({ persist: false, userId: 7, log: quiet as never });
  assert.equal(e.mode, "PAPER_ONLY", "the stored label is unchanged");
  assert.equal(e.liveTradingStatus, "DISABLED", "the stored label is unchanged");
  assert.equal(e.liveTradingStatusScope, GOVERNOR_LIVE_STATUS_SCOPE);
  assert.match(e.liveTradingStatusScope, /not whether live trading is on/);
  assert.match(e.liveTradingStatusScope, /Trading Permission card/);
});
