// QA gate — Phase 26 hardening (AI routing + golden empty-state +
// prompt/tool contract sync) for `getMyPerformanceSummary`.
//
// Three suites, run deterministically (no LLM key required):
//
//   Suite A — AI ROUTING
//     For each of the 8 spec questions ("how am I performing", "what
//     trades did I take today", "what was my biggest mistake", "best /
//     worst strategy", "which trade hurt me most", "am I overtrading",
//     "what should I review", "lessons from my closed trades"), assert
//     the routing block in systemPrompt.ts (a) mentions the phrase,
//     (b) names the read-only tool `getMyPerformanceSummary`, (c) does
//     NOT route to any execution / order-placement / MT5-command tool,
//     and (d) explicitly re-routes LIVE / OPEN questions away to
//     `getMyLiveOpenTrades` + `getTradeIntelligence` +
//     `getTradeMarketContext`.
//
//   Suite B — GOLDEN EMPTY-STATE
//     Calls getMyPerformanceSummary with a guaranteed-empty userId.
//     Asserts: isEmpty:true, honest emptyMessage, openTrades:0, full
//     safety envelope, and the absence of any fabricated win rate /
//     P&L / strategy / lesson field on the empty branch.
//
//   Suite C — PROMPT / TOOL CONTRACT SYNC GUARD
//     Asserts the populated payload shape exposes every contract field
//     the routing prompt promises (headline.totalClosed,
//     headline.winRate, headline.winRateNote, averages.profitFactor,
//     extremes.largestLoss, strategyRanking, bestStrategy,
//     worstStrategy, topMistakes, recentLessons, overtradingHint,
//     unrealizedPnlNote, dataSource, perUserScoped, safety envelope).
//     If the tool drops or renames a contract field, this fails — so
//     the prompt block cannot silently drift away from the tool.
//
// Run: pnpm --filter @workspace/api-server run qa:assistant-routing
// Exits non-zero on any failure.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getMyPerformanceSummary, dispatchTool } from "../tools.js";
import { TOOL_DEFINITIONS } from "../tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYSTEM_PROMPT_PATH = resolve(__dirname, "../systemPrompt.ts");
const TOOLS_PATH = resolve(__dirname, "../tools.ts");
const systemPromptSrc = readFileSync(SYSTEM_PROMPT_PATH, "utf8");
const toolsSrc = readFileSync(TOOLS_PATH, "utf8");

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass += 1;
    process.stdout.write(`PASS  ${name}` + "\n");
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    process.stdout.write(`FAIL  ${name}${detail ? ` — ${detail}` : ""}` + "\n");
  }
}

// ───────────────────────────────────────────────────────────────────────
// Suite A — AI ROUTING
// ───────────────────────────────────────────────────────────────────────
process.stdout.write("\n── Suite A — AI routing for personal-performance prompts ──" + "\n");

const ROUTING_BLOCK_START = "Phase 25/26 — PERSONAL TRADING PERFORMANCE routing";
const blockStartIdx = systemPromptSrc.indexOf(ROUTING_BLOCK_START);
check(
  "A0 routing block present in systemPrompt.ts",
  blockStartIdx >= 0,
  `expected marker "${ROUTING_BLOCK_START}"`,
);

// Extract the FULL routing block — from the Phase 25/26 marker until the
// next top-level routing bullet ("- For MT5 questions"). Then normalize
// whitespace so newline-wrapped phrases match cleanly.
const blockEndIdx = blockStartIdx >= 0
  ? systemPromptSrc.indexOf("- For MT5 questions", blockStartIdx)
  : -1;
const rawRoutingBlock = (blockStartIdx >= 0 && blockEndIdx > blockStartIdx)
  ? systemPromptSrc.slice(blockStartIdx, blockEndIdx)
  : "";
const routingBlock = rawRoutingBlock.replace(/\s+/g, " ");

const SPEC_QUESTIONS: ReadonlyArray<{ id: string; phrase: string }> = [
  { id: "A1", phrase: "how am I performing" },
  { id: "A2", phrase: "what trades did I take today" },
  { id: "A3", phrase: "biggest" }, // "biggest trading mistake" / "biggest loser"
  { id: "A4", phrase: "best / worst strategy" },
  { id: "A5", phrase: "which trade hurt me most" },
  { id: "A6", phrase: "am I overtrading" },
  { id: "A7", phrase: "what should I review" },
  { id: "A8", phrase: "lessons" }, // "lessons from my closed trades" / "recent trading lessons"
];
for (const q of SPEC_QUESTIONS) {
  check(
    `${q.id} routing block mentions "${q.phrase}"`,
    routingBlock.toLowerCase().includes(q.phrase.toLowerCase()),
  );
}

check(
  "A9 routing block names the read-only tool getMyPerformanceSummary",
  routingBlock.includes("getMyPerformanceSummary"),
);

// Hard rule: the routing block must NOT route any of these prompts to
// execution / placement / MT5-command tools.
const FORBIDDEN_EXECUTION_TOOLS = [
  "placeLiveOrder",
  "placeMarketOrder",
  "submitPendingOrder",
  "queueMt5Command",
  "executeTrade",
  "modifyPosition",
  "closePosition",
  "cancelPendingOrder",
];
for (const t of FORBIDDEN_EXECUTION_TOOLS) {
  check(
    `A10 routing block does NOT mention execution tool ${t}`,
    !routingBlock.includes(t),
    "performance routing must stay read-only",
  );
}

// LIVE/OPEN re-routing — questions about open positions must go to the
// live trio, NOT getMyPerformanceSummary.
check(
  "A11 routing block re-routes LIVE/OPEN questions to getMyLiveOpenTrades",
  routingBlock.includes("getMyLiveOpenTrades"),
);
check(
  "A12 routing block re-routes LIVE/OPEN questions to getTradeIntelligence",
  routingBlock.includes("getTradeIntelligence"),
);
check(
  "A13 routing block re-routes LIVE/OPEN questions to getTradeMarketContext",
  routingBlock.includes("getTradeMarketContext"),
);
check(
  "A14 routing block contains explicit \"DO NOT call getMyPerformanceSummary\" for live questions",
  /DO NOT call\s+getMyPerformanceSummary/i.test(routingBlock),
);

// Honesty hard rules.
check(
  "A15 routing block forbids fabricated trades / P&L / win rate / mistakes / strategies / lessons / market data / bridge status",
  /NEVER fabricate trades, P&L, win rate, mistakes, strategies, lessons, candles, news, TP, SL, market data, or bridge status/.test(routingBlock),
);

check(
  "A16 routing block forbids recomputing win rate from open trades",
  /winRate is ONLY from closed trades/i.test(routingBlock)
    && /NEVER mention any win rate that includes open trades, and NEVER recompute one yourself/i.test(routingBlock),
);

// ───────────────────────────────────────────────────────────────────────
// Suite B — GOLDEN EMPTY-STATE
// ───────────────────────────────────────────────────────────────────────
process.stdout.write("\n── Suite B — Golden empty-state for getMyPerformanceSummary ──" + "\n");

// userId in INT4 range but extremely unlikely to exist in dev DB.
// Selects only filter on userId so no FK is required.
const EMPTY_USER_ID = 2147483600;

let emptyResult: Awaited<ReturnType<typeof getMyPerformanceSummary>> | null = null;
try {
  emptyResult = await getMyPerformanceSummary(EMPTY_USER_ID, 30);
} catch (err) {
  check("B0 getMyPerformanceSummary(emptyUser) does not throw", false, String(err));
}

if (emptyResult) {
  check("B0 getMyPerformanceSummary(emptyUser) does not throw", true);
  check("B1 isEmpty === true", emptyResult.isEmpty === true);
  check(
    "B2 emptyMessage is an honest, non-empty string",
    typeof (emptyResult as { emptyMessage?: unknown }).emptyMessage === "string"
      && ((emptyResult as { emptyMessage: string }).emptyMessage).length > 0,
  );
  check(
    "B3 emptyMessage explains the user must place + journal a paper trade",
    /paper trade/i.test(String((emptyResult as { emptyMessage?: string }).emptyMessage ?? "")),
  );
  check("B4 openTrades present and 0", (emptyResult as { openTrades?: number }).openTrades === 0);
  check("B5 lookbackDays echoed", (emptyResult as { lookbackDays?: number }).lookbackDays === 30);
  // The safety envelope is now applied at the DISPATCH boundary (derived
  // per-user via deriveAssistantEnvelope), NOT embedded in the bare tool
  // result. Route through dispatchTool and assert it is present + honest for a
  // fail-closed empty user — never a hardcoded paper_only stub.
  const emptyDispatched = (await dispatchTool(
    "getMyPerformanceSummary",
    { lookbackDays: 30 },
    EMPTY_USER_ID,
  )) as Record<string, unknown>;
  check("B6 dispatch boundary applies a derived safety envelope",
    typeof emptyDispatched["safetyMode"] === "string"
      && typeof emptyDispatched["liveLocked"] === "boolean");
  check("B7 empty/fail-closed user → liveLocked === true",
    emptyDispatched["liveLocked"] === true);
  check("B8 empty/fail-closed user → allowOrderExecution === false",
    emptyDispatched["allowOrderExecution"] === false);

  // CRITICAL — empty branch must NOT fabricate any analytics field.
  const FORBIDDEN_KEYS_ON_EMPTY = [
    "headline", "averages", "extremes", "strategyRanking",
    "bestStrategy", "worstStrategy", "topMistakes", "recentLessons",
    "overtradingHint", "reviewSuggestion",
  ];
  for (const k of FORBIDDEN_KEYS_ON_EMPTY) {
    check(
      `B9 empty branch does NOT expose "${k}" (no fabricated analytics)`,
      !(k in (emptyResult as Record<string, unknown>)),
    );
  }
}

// Also verify the SYSTEM PROMPT enforces the empty-state behavior
// (independent of the tool — the LLM must obey it on isEmpty:true).
check(
  "B10 systemPrompt has empty-state hard rule for isEmpty:true",
  /If the tool returns isEmpty:true, your entire reply must be the honest empty message/.test(routingBlock),
);
check(
  "B11 systemPrompt forbids answering empty-state from generic trading knowledge",
  /Do NOT answer the question from generic trading knowledge/.test(routingBlock),
);

// ───────────────────────────────────────────────────────────────────────
// Suite C — PROMPT / TOOL CONTRACT SYNC GUARD
// ───────────────────────────────────────────────────────────────────────
process.stdout.write("\n── Suite C — Prompt/tool contract sync guard ──" + "\n");

// C1 — tool is registered in TOOL_DEFINITIONS (so dispatcher can find it).
const toolDef = TOOL_DEFINITIONS.find((t) => t.name === "getMyPerformanceSummary");
check("C1 getMyPerformanceSummary is in TOOL_DEFINITIONS registry", !!toolDef);

// C2 — tool description carries the per-user-scoped + honest-empty contract.
check(
  "C2 tool description carries per-user-scoped + honest-empty contract",
  !!toolDef
    && /Per-user-scoped/i.test(toolDef.description)
    && /isEmpty:true/i.test(toolDef.description)
    && /NEVER fabricates/i.test(toolDef.description)
    && /ONLY from closed trades/i.test(toolDef.description),
);

// C3 — every prompt-promised RESPONSE FORMAT field must exist in the
// populated tool payload. We assert by source-grep (tool source must
// emit each contract key) — this fires even if no DB user has data.
const REQUIRED_CONTRACT_KEYS = [
  "isEmpty",
  "headline",
  "totalClosed",
  "openTrades",
  "winRate",
  "winRateNote",
  "realizedPnl",
  "averages",
  "profitFactor",
  "profitFactorNote",
  "extremes",
  "largestWin",
  "largestLoss",
  "strategyRanking",
  "bestStrategy",
  "worstStrategy",
  "topMistakes",
  "recentLessons",
  "overtradingHint",
  "overtradingNote",
  "reviewSuggestion",
  "unrealizedPnlNote",
  "dataSource",
  "perUserScoped",
];

// Slice the function body for getMyPerformanceSummary out of tools.ts so
// our key-presence grep doesn't get false positives from other tools.
const fnStart = toolsSrc.indexOf("export async function getMyPerformanceSummary");
const fnEnd = toolsSrc.indexOf("// ── 9b.", fnStart >= 0 ? fnStart : 0);
const perfFnSrc = (fnStart >= 0 && fnEnd > fnStart) ? toolsSrc.slice(fnStart, fnEnd) : "";
check("C3a getMyPerformanceSummary function body locatable", perfFnSrc.length > 500);

for (const k of REQUIRED_CONTRACT_KEYS) {
  check(
    `C3 tool emits contract key "${k}"`,
    perfFnSrc.includes(k),
    "drift detected — prompt promises this field but tool no longer emits it",
  );
}

// C4 — prompt block must mention each user-facing contract surface so
// the LLM knows it exists and can render it. If a key is added to the
// tool later, the prompt must mention it too (or this test fires).
const PROMPT_REQUIRED_SURFACES = [
  "isEmpty",
  "headline",
  "winRate",
  "profitFactor",
  "bestStrategy",
  "worstStrategy",
  "largestLoss",
  "topMistakes",
  "recentLessons",
  "overtradingHint",
  "unrealizedPnlNote",
];
for (const s of PROMPT_REQUIRED_SURFACES) {
  check(
    `C4 routing prompt mentions contract surface "${s}"`,
    routingBlock.includes(s),
    "prompt drift — tool exposes this surface but prompt no longer routes / formats it",
  );
}

// C5/C6 — the safety envelope is applied centrally at the dispatch boundary
// (derived per-user), NOT spread inline per tool. dispatchTool must derive it
// once and merge it into every object result, so the contract holds for this
// tool without it embedding any envelope itself.
check(
  "C5 dispatch boundary derives the per-user envelope once",
  toolsSrc.includes("deriveAssistantEnvelope"),
);
check(
  "C6 dispatch boundary merges the derived envelope into object results",
  toolsSrc.includes("...assistantEnvelopeFields(env)"),
);

// C7 — per-user scoping at the query level (defense in depth — even if
// the registry / dispatcher were rewired, the SELECTs are bound to
// userId).
check(
  "C7 closed-trades query filters by userId AND status=closed",
  /paperTradesTable\.userId, userId[\s\S]{0,80}paperTradesTable\.status, "closed"/.test(perfFnSrc),
);
check(
  "C7 open-trades query filters by userId AND status=open",
  /paperTradesTable\.userId, userId[\s\S]{0,80}paperTradesTable\.status, "open"/.test(perfFnSrc),
);
check(
  "C7 journal query filters by userId",
  /tradeJournalTable\.userId, userId/.test(perfFnSrc),
);

// ───────────────────────────────────────────────────────────────────────
process.stdout.write(`\n${pass + fail} checks · ${pass} PASS · ${fail} FAIL` + "\n");
if (fail > 0) {
  process.stdout.write("\nFAILURES:" + "\n");
  for (const f of failures) process.stdout.write(`  - ${f}` + "\n");
  process.exit(1);
}
process.exit(0);
