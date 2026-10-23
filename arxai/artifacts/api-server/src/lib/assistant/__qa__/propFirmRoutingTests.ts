// QA gate — Phase 27 (Prop Firm Mode + Challenge Rule Engine).
//
// Three suites, deterministic (no LLM key required):
//
//   Suite A — AI ROUTING (systemPrompt.ts)
//     For each of the 8 spec questions ("am I close to breaking a rule",
//     "how much daily loss left", "how close am I to the profit target",
//     "can I take this trade under my prop rules", "am I over-risking",
//     "what rule should I watch today", "did I violate any challenge
//     rules", "what would make this trade non-compliant"), assert the
//     routing block (a) mentions the phrase, (b) names getPropFirmModeStatus,
//     (c) does NOT route to any execution / order tool, and (d) enforces
//     the honesty rules (PROP_MODE_OFF stop, INSUFFICIENT_DATA stop, no
//     funded-account claim, no official-rule claim, paper-only language,
//     no execution).
//
//   Suite B — GOLDEN NOT_CONFIGURED
//     Calls getPropFirmModeStatus with a guaranteed-empty userId. Asserts
//     enabled:false, ruleStatus:"PROP_MODE_OFF", honest note, full safety
//     envelope, and ABSENCE of fabricated progress / rules / violations /
//     warnings on the empty branch.
//
//   Suite C — PROMPT / TOOL CONTRACT SYNC GUARD
//     Asserts populated source exposes every contract field the prompt
//     promises (ruleStatus, progress.dailyLossRemainingPct,
//     progress.profitTargetProgressPct, canTakeNewTrade,
//     canTakeNewTradeReasons, warnings, violations, etc.). If the tool
//     drops a contract field, this fails — so the prompt cannot drift.
//
// Run: pnpm --filter @workspace/api-server run qa:prop-firm-routing

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getPropFirmModeStatus, dispatchTool, TOOL_DEFINITIONS } from "../tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYSTEM_PROMPT_PATH = resolve(__dirname, "../systemPrompt.ts");
const TOOLS_PATH = resolve(__dirname, "../tools.ts");
const PROP_ROUTES_PATH = resolve(__dirname, "../../../routes/propChallenges.ts");
const systemPromptSrc = readFileSync(SYSTEM_PROMPT_PATH, "utf8");
const toolsSrc = readFileSync(TOOLS_PATH, "utf8");
const propRoutesSrc = readFileSync(PROP_ROUTES_PATH, "utf8");

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass += 1;
    process.stdout.write(`PASS  ${name}` + "\n");
  } else {
    fail += 1;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    process.stdout.write(`FAIL  ${name}${detail ? ` — ${detail}` : ""}` + "\n");
  }
}

// Extract the Phase 27 prop firm routing block. From the marker
// "Phase 27 routing" through the next top-level bullet starting "- For ".
function extractPropRoutingBlock(): string {
  const startMarker = "Phase 27 routing";
  const startIdx = systemPromptSrc.indexOf(startMarker);
  if (startIdx < 0) return "";
  // Find the next top-level bullet after this one.
  const tail = systemPromptSrc.slice(startIdx);
  const m = tail.search(/\n- For push notification/);
  return m > 0 ? tail.slice(0, m) : tail.slice(0, 4000);
}
const routingBlock = extractPropRoutingBlock();
const routingNorm = routingBlock.replace(/\s+/g, " ").toLowerCase();

// =====================================================================
// Suite A — AI ROUTING (35 checks)
// =====================================================================
process.stdout.write("\n=== Suite A — AI ROUTING ===\n");
check("A0  Phase 27 prop firm routing block present", routingBlock.length > 200,
  `block length: ${routingBlock.length}`);

const specQuestions: Array<[string, string]> = [
  ["A1", "am i close to breaking a rule"],
  ["A2", "how much daily loss"],
  ["A3", "how close am i to the profit target"],
  ["A4", "can i take this trade under my prop rules"],
  ["A5", "am i over-risking"],
  ["A6", "what rule should i watch today"],
  ["A7", "did i violate any challenge rules"],
  ["A8", "what would make this trade non-compliant"],
];
for (const [id, phrase] of specQuestions) {
  check(`${id}  prompt mentions: "${phrase}"`,
    routingNorm.includes(phrase),
    `not found in normalized routing block`);
}

check("A9  prompt names getPropFirmModeStatus",
  routingNorm.includes("getpropfirmmodestatus"),
  "tool name missing from routing block");

const forbiddenExecutionTools = [
  "placeLiveOrder", "placeMarketOrder", "submitPendingOrder",
  "queueMt5Command", "executeTrade", "modifyPosition",
  "closePosition", "cancelPendingOrder",
];
for (let i = 0; i < forbiddenExecutionTools.length; i++) {
  const tool = forbiddenExecutionTools[i]!;
  check(`A10.${i}  prompt does NOT route prop questions to ${tool}`,
    !routingNorm.includes(tool.toLowerCase()),
    `forbidden execution tool referenced inside prop routing`);
}

check("A11  prompt enforces PROP_MODE_OFF stop",
  routingNorm.includes("prop_mode_off") && routingNorm.includes("not configured yet"),
  "missing PROP_MODE_OFF + 'not configured yet' stop");

check("A12  prompt enforces INSUFFICIENT_DATA stop",
  routingNorm.includes("insufficient_data") && routingNorm.includes("no closed paper trades"),
  "missing INSUFFICIENT_DATA + 'no closed paper trades' stop");

check("A13  prompt forbids funded-account claim",
  /never\s+(guarantee|claim).*(funded|payout|real prop firm)/i.test(routingBlock),
  "missing funded/payout prohibition");

check("A14  prompt forbids unverified-official-rule claim",
  /not\s+claim.*official prop firm rules/i.test(routingBlock) ||
  /user-entered.*not.*official/i.test(routingBlock),
  "missing 'rules are user-entered, not official' clause");

check("A15  prompt requires paper-only language",
  routingNorm.includes("paper") && routingNorm.includes("simulator"),
  "missing paper/simulator honesty language");

check("A16  prompt forbids execution from prop routing",
  /cannot\s+(place|modify|cancel|close)/i.test(routingBlock),
  "missing 'CANNOT place/modify/cancel/close' clause");

check("A17  prompt marks canTakeNewTrade as advisory",
  routingNorm.includes("advisory"),
  "missing 'advisory only' qualifier on canTakeNewTrade");

check("A18  honesty trigger 'prop firm mode is on' still gated",
  /prop firm mode is on.*only if getPropFirmModeStatus enabled:true/i.test(systemPromptSrc),
  "Phase 22F honesty trigger removed or weakened");

// =====================================================================
// Suite B — GOLDEN NOT_CONFIGURED (15 checks)
// =====================================================================
process.stdout.write("\n=== Suite B — GOLDEN NOT_CONFIGURED ===\n");
const EMPTY_USER_ID = 2147483600;
const empty = await getPropFirmModeStatus(EMPTY_USER_ID);
const e = empty as Record<string, unknown>;

check("B0  empty user → enabled === false", e["enabled"] === false,
  `enabled = ${e["enabled"]}`);
check("B1  empty user → configured === false", e["configured"] === false,
  `configured = ${e["configured"]}`);
check("B2  empty user → status === NOT_CONFIGURED", e["status"] === "NOT_CONFIGURED",
  `status = ${e["status"]}`);
check("B3  empty user → ruleStatus === PROP_MODE_OFF",
  e["ruleStatus"] === "PROP_MODE_OFF",
  `ruleStatus = ${e["ruleStatus"]}`);
check("B4  empty user → honest note mentioning 'not configured'",
  typeof e["note"] === "string" && /not configured/i.test(e["note"] as string),
  `note = ${JSON.stringify(e["note"])}`);
check("B5  empty user → honestyDisclaimer mentions paper/simulator",
  typeof e["honestyDisclaimer"] === "string" &&
    /paper|simulator/i.test(e["honestyDisclaimer"] as string),
  `honestyDisclaimer = ${JSON.stringify(e["honestyDisclaimer"])}`);

// The safety envelope is applied at the DISPATCH boundary (derived per-user
// via deriveAssistantEnvelope), NOT embedded in the bare tool result. Route
// through dispatchTool and assert it is present + honest for a fail-closed
// empty user — never a hardcoded paper_only stub.
const dispatched = (await dispatchTool(
  "getPropFirmModeStatus", {}, EMPTY_USER_ID,
)) as Record<string, unknown>;
check("B6  dispatch boundary applies a derived safety envelope",
  typeof dispatched["safetyMode"] === "string" &&
    typeof dispatched["liveLocked"] === "boolean",
  `safetyMode = ${dispatched["safetyMode"]}`);
check("B7  empty/fail-closed user → liveLocked === true",
  dispatched["liveLocked"] === true, `liveLocked = ${dispatched["liveLocked"]}`);
check("B8  empty/fail-closed user → allowOrderExecution === false",
  dispatched["allowOrderExecution"] === false,
  `allowOrderExecution = ${dispatched["allowOrderExecution"]}`);
check("B10 perUserScoped === true", e["perUserScoped"] === true,
  `perUserScoped = ${e["perUserScoped"]}`);

// Forbidden fabrication keys on empty branch.
const forbiddenOnEmpty = ["progress", "rules", "violations", "warnings",
  "canTakeNewTrade", "canTakeNewTradeReasons", "challengeId",
  "challengeName", "failureReason"];
for (let i = 0; i < forbiddenOnEmpty.length; i++) {
  const k = forbiddenOnEmpty[i]!;
  check(`B11.${i}  empty branch has NO fabricated '${k}'`,
    !(k in e),
    `unexpected key '${k}' present on NOT_CONFIGURED branch`);
}

// =====================================================================
// Suite C — PROMPT / TOOL CONTRACT SYNC GUARD (~45 checks)
// =====================================================================
process.stdout.write("\n=== Suite C — PROMPT / TOOL CONTRACT SYNC ===\n");

// C1: tool in TOOL_DEFINITIONS
const toolDef = TOOL_DEFINITIONS.find((t) => t.name === "getPropFirmModeStatus");
check("C1  getPropFirmModeStatus is in TOOL_DEFINITIONS", Boolean(toolDef),
  "tool missing from registry — dispatcher unreachable");

// C2: tool description carries the per-user + paper-only + rule contract
const desc = (toolDef?.description ?? "").toLowerCase();
check("C2a  description says 'per-user'", desc.includes("per-user"),
  `desc = ${desc.slice(0, 200)}…`);
check("C2b  description says 'paper/simulator'",
  desc.includes("paper") && desc.includes("simulator"),
  `desc = ${desc.slice(0, 200)}…`);
check("C2c  description warns 'never a real funded account'",
  /never.*funded/i.test(toolDef?.description ?? ""),
  "missing funded-account disclaimer in description");
check("C2d  description says 'user-entered'",
  /user-entered/i.test(toolDef?.description ?? ""),
  "missing 'user-entered, not official' clause in description");

// C3: populated tool source emits every required contract field.
// We inspect the source (not runtime) because the populated branch needs
// an active challenge with paper orders — which can't be guaranteed in CI.
const populatedBranchStart = toolsSrc.indexOf("// Phase 27 — per-user paper-only progress evaluator");
const populatedBranchEnd = toolsSrc.indexOf("} catch {", populatedBranchStart);
const populatedSrc = populatedBranchStart > 0 && populatedBranchEnd > 0
  ? toolsSrc.slice(populatedBranchStart, populatedBranchEnd)
  : "";

const requiredFields = [
  // Top-level
  "enabled", "configured", "challengeId", "challengeName", "status",
  "ruleStatus", "failureReason", "startedAt", "rules", "progress",
  "warnings", "violations", "canTakeNewTrade", "canTakeNewTradeReasons",
  "hasSufficientData", "note", "honestyDisclaimer", "dataSource",
  "perUserScoped",
  // rules.*
  "startingBalance", "profitTargetPct", "maxDailyLossPct",
  "maxTotalDrawdownPct", "minTradingDays", "maxTradingDays",
  "consistencyRulePercent",
  // progress.*
  "currentBalance", "totalPnl", "totalPct", "profitTargetProgressPct",
  "profitTargetReached", "maxDrawdownPct", "dailyLossUsedPct",
  "dailyLossRemainingPct", "totalDrawdownRemainingPct", "daysWorked",
  "daysSinceStart", "openTradeCount", "closedTradeCount",
];
for (let i = 0; i < requiredFields.length; i++) {
  const f = requiredFields[i]!;
  check(`C3.${i}  populated source emits '${f}'`,
    populatedSrc.includes(f),
    `field '${f}' missing from populated branch source`);
}

// C4: routing prompt mentions all user-facing contract surfaces.
const promptSurfaces = [
  "ruleStatus", "warnings", "violations", "canTakeNewTrade",
  "dailyLossRemainingPct", "profitTargetProgressPct", "dailyLossUsedPct",
];
for (let i = 0; i < promptSurfaces.length; i++) {
  const s = promptSurfaces[i]!;
  check(`C4.${i}  prompt routes to '${s}'`,
    routingBlock.includes(s),
    `surface '${s}' not referenced in routing block`);
}

// C4b: prompt MUST NOT route UNAVAILABLE through the INSUFFICIENT_DATA stop.
check("C4.7  catch fallback uses distinct UNAVAILABLE status (not INSUFFICIENT_DATA)",
  /ruleStatus:\s*"UNAVAILABLE"\s+as\s+const/.test(toolsSrc) &&
    /status:\s*"UNAVAILABLE"/.test(toolsSrc),
  "catch branch must use UNAVAILABLE, not INSUFFICIENT_DATA");

// C4c: tool math must mirror evaluateChallenge's daily-loss denominator
// (DAY-START balance, not startingBalance) so AI numbers match UI.
check("C4.8  daily-loss denominator = day-start balance (matches route)",
  /dayPnl\s*<\s*0\s*&&\s*startBal\s*>\s*0\s*\?\s*Math\.abs\(dayPnl\)\s*\/\s*startBal/.test(toolsSrc),
  "daily-loss denominator drifted from evaluateChallenge's startBal");

// C4d: tool must evaluate consistency rule (mirrors route).
check("C4.9  tool evaluates consistency rule",
  /consistencyTopShare\s*>\s*ch\.consistencyRulePercent/.test(toolsSrc) &&
    /Single best day/.test(toolsSrc),
  "consistency rule not evaluated in tool");

// C4e: tool must emit overtrading warning (mirrors route).
check("C4.10 tool emits overtrading warning at >20/day",
  /Overtrading:.*trades on/.test(toolsSrc),
  "overtrading warning missing from tool");

// C5: the safety envelope is applied centrally at the dispatch boundary
// (derived per-user), NOT spread inline in each tool branch.
check("C5a  dispatch boundary derives the per-user envelope once",
  toolsSrc.includes("deriveAssistantEnvelope"),
  "dispatchTool no longer derives the per-user envelope");
check("C5b  dispatch boundary merges the derived envelope into object results",
  toolsSrc.includes("...assistantEnvelopeFields(env)"),
  "dispatchTool no longer merges the derived envelope");

// C6: per-user isolation defense-in-depth — tool MUST filter by userId
// AND join paperOrders by either the user's challenge.userId or the
// challenge's paperAccountId (which itself was created by this user).
check("C6a  tool filters propChallengesTable by userId",
  /propChallengesTable\.userId.*eq\(.*userId\)|eq\(propChallengesTable\.userId,\s*userId\)/.test(toolsSrc),
  "missing eq(propChallengesTable.userId, userId)");
check("C6b  tool defense-in-depth filters paperOrdersTable by userId",
  /paperOrdersTable\.userId/.test(toolsSrc) &&
    /ch\.userId/.test(toolsSrc),
  "missing per-user defense-in-depth on paper orders");

// C7: dispatcher reach + awareness rollup wiring.
check("C7a  dispatcher case for getPropFirmModeStatus exists",
  /case\s+"getPropFirmModeStatus"\s*:\s*return getPropFirmModeStatus\(userId\)/.test(toolsSrc),
  "dispatcher case missing");
check("C7b  awareness rollup calls getPropFirmModeStatus",
  /safe\("prop_firm",\s*\(\)\s*=>\s*getPropFirmModeStatus\(userId\)\)/.test(toolsSrc),
  "awareness rollup not wired");

// C8: route-side safety invariants (Build R) intact.
check("C8a  routes guard with requireUser",
  /router\.use\("\/prop-challenges",\s*requireUser\)/.test(propRoutesSrc),
  "requireUser middleware missing on /prop-challenges");
check("C8b  routes own challenge via ownChallenge(id, userId)",
  /ownChallenge\(id,\s*userId\)/.test(propRoutesSrc),
  "ownChallenge ownership check missing");
check("C8c  routes write PROP_CHALLENGE_* vault events",
  /PROP_CHALLENGE_CREATED|PROP_CHALLENGE_PASSED|PROP_CHALLENGE_FAILED/.test(propRoutesSrc),
  "audit trail not emitted");
check("C8d  routes carry SIMULATED disclaimer",
  /Practice\/training only.*simulated/i.test(propRoutesSrc),
  "SIMULATED disclaimer missing");
// Strip comments before checking for live-execution call sites (the safety
// comment header legitimately mentions "/execute-trade" and "mt5_*" to
// document what the file does NOT touch — those mentions are anti-claims,
// not call sites).
const propRoutesNoComments = propRoutesSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
check("C8e  routes never call live execution / mt5 commands (code, not comments)",
  !/execute-trade|queueMt5Command|placeLiveOrder/.test(propRoutesNoComments),
  "live execution surface referenced from prop routes (code, not comment)");

// =====================================================================
// Summary
// =====================================================================
process.stdout.write(`\n${pass + fail} checks · ${pass} PASS · ${fail} FAIL\n`);
if (fail > 0) {
  process.stdout.write("\nFailures:\n");
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
