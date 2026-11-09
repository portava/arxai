// Structural checks that the Eleanor execution wiring (2026-11-04) is in place and
// honest: the sweeper is started, arming follows the sweeper flag, the route
// delegates to the shared evaluator, the tool list exposes the read-only
// watches tool and the prompt describes the direct-command path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("app starts the Eleanor watch sweeper", async () => {
  const app = await read("../../../app.ts");
  assert.match(app, /import \{ startEleanorWatchSweeper \} from "\.\/lib\/assistant\/eleanorWatchSweeper";/);
  // Started like the other autonomous workers: never in a preview-safe start.
  assert.match(app, /^if \(!isPreviewSafeStart\(\)\) startEleanorWatchSweeper\(\);/m);
});

test("the command route arms watches only when the sweeper is enabled, and delegates evaluation", async () => {
  const src = await read("../../../routes/meAssistant.ts");
  assert.match(src, /const WATCH_ARMING_ENABLED = isSweeperEnabled\(\);/);
  assert.match(src, /await evaluateEleanorWatchesForUser\(userId, \{ ip, ua, trigger: "route" \}\)/);
  assert.match(src, /router\.get\("\/me\/assistant\/watches"/);
  assert.match(src, /router\.post\("\/me\/assistant\/watches\/:id\/ack"/);
  assert.match(src, /MONITOR_ALERT_ACK_KEEP/);
  // No second execution path: the old in-route evaluator/ledger bodies are gone.
  assert.doesNotMatch(src, /async function recordAndExecuteEleanor/);
  assert.doesNotMatch(src, /async function currentPriceOf/);
  assert.match(src, /up to 3 times; answer "keep it" or "close it"/);
});

test("evaluator: feed-scoped, bound price, fire-time permission re-check, policy-driven monitor", async () => {
  const ev = await read("../eleanorWatchEvaluator.ts");
  assert.match(ev, /runWithFeedScope\(feedScopeForUser\(userId, lookupActiveBridge\)/);
  // Sweep 2026-11-04: an acting price comes only from the owner's own bridge.
  assert.match(ev, /ownBridgePriceOf\(w\.symbol, c\.bridge\)/);
  assert.doesNotMatch(ev, /currentPriceOf\(/, "no unpinned price may drive a watch");
  assert.match(ev, /basis: "CONFIRMED_OPEN"/);
  assert.doesNotMatch(ev, /basis: "UNCLOSED"/);
  assert.match(ev, /decideMonitorAction\(/);
  // Fire-time permission: one shared rule (also used at arm time) that adds
  // the pipeline's own open/close permissions.
  assert.match(ev, /eleanorWatchPermissionBlock\("MONITOR_TRADE", c\.settings\)/);
  assert.match(ev, /eleanorWatchPermissionBlock\(w\.kind, c\.settings\)/);
  const ex = await read("../eleanorWatchPermissions.ts");
  for (const code of ["ELEANOR_EXECUTION_NOT_AUTHORIZED", "ELEANOR_MONITOR_NOT_ENABLED", "ELEANOR_OPEN_COMMANDS_NOT_ENABLED", "ELEANOR_CLOSE_COMMANDS_NOT_ENABLED"]) assert.match(ex, new RegExp(code));
  assert.match(ev, /ELEANOR_MONITOR_EXECUTIVE_CLOSE/);
  assert.match(ev, /ELEANOR_MONITOR_REVERSAL_ALERT/);
  assert.match(ev, /claimFire\(w\.id\)/, "CAS single-fire");
  assert.match(ev, /recordAndExecuteEleanor\(/, "one ledger + dispatch path");
  assert.doesNotMatch(ev, /submitInstantTrade|placeOrder\(/, "no direct pipeline call from the evaluator");
});

test("tool list has the read-only watches tool and still no order tool; prompt names the direct-command path", async () => {
  const { TOOL_DEFINITIONS } = await import("../tools.js");
  const names: string[] = TOOL_DEFINITIONS.map((t) => t.name);
  assert.ok(names.includes("getMyWatches"));
  assert.ok(!names.includes("requestLiveOrder") && !names.includes("requestDemoOrder"));
  const { buildArxAssistantSystemPrompt } = await import("../systemPrompt.js");
  const p = buildArxAssistantSystemPrompt("Eleanor");
  assert.match(p, /HAVE NO ORDER-EXECUTION TOOL/);
  assert.match(p, /"monitor my EURUSD"/);
  assert.match(p, /alert up to 3 times on reversal evidence/);
  assert.match(p, /getMyWatches/);
});

test("sweep 2026-11-04: watch arming is live-only, permission-checked like the pipeline, confirmed before insert, and expires", async () => {
  const src = await read("../../../routes/meAssistant.ts");
  const armStart = src.indexOf("if (accountMode !== \"live\") {");
  const insertAt = src.indexOf("await db.insert(eleanorWatchInstructionsTable).values(");
  assert.ok(armStart > 0 && insertAt > armStart, "live-only refusal precedes the insert");
  assert.match(src, /Watches run on your live account only in this build; switch to live to arm one\./);
  const perm = src.indexOf("eleanorWatchPermissionBlock(parsed.kind, settings)");
  assert.ok(perm > armStart && perm < insertAt);
  const confirm = src.indexOf("settings?.eleanorRequireExtraConfirmation !== false && body.confirm !== true", armStart);
  assert.ok(confirm > armStart && confirm < insertAt, "extra confirmation is asked before the watch row exists");
  assert.match(src, /export const DEFAULT_WATCH_TTL_MINUTES = 24 \* 60;/);
  assert.match(src, /classification: "MISSING_VOLUME", message: `How much \$\{parsed\.symbol\} should I/);
  assert.match(src, /isCloseAlertAnswer\(text\)/);
  assert.match(src, /acknowledgeEleanorWatch\(userId, target\.id, "close"/);
  assert.match(src, /pickWatchesToCancel\(activeRows, scope/);
});
