// Structural checks that the Ruby execution wiring (2026-11-04) is in place and
// honest: the sweeper is started, arming follows the sweeper flag, the route
// delegates to the shared evaluator, the tool list exposes the read-only
// watches tool and the prompt describes the direct-command path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("app starts the Ruby watch sweeper", async () => {
  const app = await read("../../../app.ts");
  assert.match(app, /import \{ startRubyWatchSweeper \} from "\.\/lib\/assistant\/rubyWatchSweeper";/);
  assert.match(app, /^startRubyWatchSweeper\(\);/m);
});

test("the command route arms watches only when the sweeper is enabled, and delegates evaluation", async () => {
  const src = await read("../../../routes/meAssistant.ts");
  assert.match(src, /const WATCH_ARMING_ENABLED = isSweeperEnabled\(\);/);
  assert.match(src, /await evaluateRubyWatchesForUser\(userId, \{ ip, ua, trigger: "route" \}\)/);
  assert.match(src, /router\.get\("\/me\/assistant\/watches"/);
  assert.match(src, /router\.post\("\/me\/assistant\/watches\/:id\/ack"/);
  assert.match(src, /MONITOR_ALERT_ACK_KEEP/);
  // No second execution path: the old in-route evaluator/ledger bodies are gone.
  assert.doesNotMatch(src, /async function recordAndExecuteRuby/);
  assert.doesNotMatch(src, /async function currentPriceOf/);
  assert.match(src, /up to 3 times; answer "keep it" or "close it"/);
});

test("evaluator: feed-scoped, bound price, fire-time permission re-check, policy-driven monitor", async () => {
  const ev = await read("../rubyWatchEvaluator.ts");
  assert.match(ev, /runWithFeedScope\(feedScopeForUser\(userId, lookupActiveBridge\)/);
  assert.match(ev, /currentPriceOf\(w\.symbol\)/);
  assert.match(ev, /decideMonitorAction\(/);
  assert.match(ev, /RUBY_EXECUTION_NOT_AUTHORIZED/);
  assert.match(ev, /RUBY_MONITOR_NOT_ENABLED/);
  assert.match(ev, /RUBY_MONITOR_EXECUTIVE_CLOSE/);
  assert.match(ev, /RUBY_MONITOR_REVERSAL_ALERT/);
  assert.match(ev, /claimFire\(w\.id\)/, "CAS single-fire");
  assert.match(ev, /recordAndExecuteRuby\(/, "one ledger + dispatch path");
  assert.doesNotMatch(ev, /submitInstantTrade|placeOrder\(/, "no direct pipeline call from the evaluator");
});

test("tool list has the read-only watches tool and still no order tool; prompt names the direct-command path", async () => {
  const { TOOL_DEFINITIONS } = await import("../tools.js");
  const names: string[] = TOOL_DEFINITIONS.map((t) => t.name);
  assert.ok(names.includes("getMyRubyWatches"));
  assert.ok(!names.includes("requestLiveOrder") && !names.includes("requestDemoOrder"));
  const { buildArxAssistantSystemPrompt } = await import("../systemPrompt.js");
  const p = buildArxAssistantSystemPrompt("Ruby");
  assert.match(p, /HAVE NO ORDER-EXECUTION TOOL/);
  assert.match(p, /"monitor my EURUSD"/);
  assert.match(p, /alert up to 3 times on reversal evidence/);
  assert.match(p, /getMyRubyWatches/);
});
