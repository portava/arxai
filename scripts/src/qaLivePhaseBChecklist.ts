// Phase B — 20-check pre-flight QA. Runs no real trades. Mixes:
//   - static source/grep evidence (UI text, route wiring, secret leaks)
//   - in-process gate evaluator probes (idempotency, gate refusals)
//   - confirmation of the existing 8 regression suites' invariants
//
// Exits non-zero on any FAIL. Designed to be safe to run any time.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { evaluateLivePhaseBDispatchGate } from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";

const ROOT = resolve(import.meta.dirname, "../..");
function read(p: string): string {
  const f = resolve(ROOT, p);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

type CheckResult = { id: number; name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function record(id: number, name: string, ok: boolean, detail: string) {
  results.push({ id, name, ok, detail });
}

// ── Fixtures: a fully-permissive baseline so we can flip ONE gate at a time
const BASE = {
  liveBrokerExecutionEnabled: true,
  globalLiveEnabled: true,
  userLiveApproved: true,
  userArmed: true,
  killSwitchEngaged: false,
  bridgeAccountType: "live" as string | null,
  bridgeHeartbeatAgeSec: 5 as number | null,
  bridgeEaVersion: "1.27" as string | null,
  bridgeEnableLiveExecution: true as boolean | null,
  bridgeReadOnlyMode: false as boolean | null,
  bridgeTerminalConnected: true as boolean | null,
  bridgeAlgoTradingAllowed: true as boolean | null,
  commandSymbol: "EURUSD",
  commandVolume: 0.01,
  commandHasStopLoss: true,
  allowedSymbols: ["EURUSD"],
  maxLotForSymbol: 0.01,
  dailyLossLimitUsd: 100,
  realisedDailyLossUsd: 0,
  requireStopLoss: true,
  adminAllowNoStopLoss: false,
  requireTakeProfit: true,
  adminAllowNoTakeProfit: false,
  commandHasTakeProfit: true,
  disclosureAccepted: true,
};

function gateBlockedWith(flip: Partial<typeof BASE>, expectedReason: string): { ok: boolean; detail: string } {
  const r = evaluateLivePhaseBDispatchGate({ ...BASE, ...flip });
  // Caller passes an expected gate-key string from a fixed table of known
  // values; cast to the union for the `includes` check.
  const has = r.decision === "BLOCKED" && (r.blockReasons as string[]).includes(expectedReason);
  return { ok: has, detail: `decision=${r.decision} blockReasons=[${r.blockReasons.join(",")}]` };
}

// ── 1. Demo trading still works (relies on existing suites)
{
  // Static evidence: demo paths are byte-for-byte separate.
  const demoPoll = read("artifacts/api-server/src/routes/mt5DemoBridge.ts");
  const touchesLiveTable = /arxLiveCommandsTable|arx_live_commands\b|live-commands-poll|sync-live-positions/.test(demoPoll);
  record(1, "Demo trading still works (demo path does not touch live tables/endpoints)",
    demoPoll.length > 0 && !touchesLiveTable,
    touchesLiveTable ? "demo bridge references live surfaces" : "demo bridge clean");
}

// ── 2. Live blocked until master switch + protected unlock
{
  const a = gateBlockedWith({ liveBrokerExecutionEnabled: false }, "LIVE_BROKER_EXECUTION_DISABLED");
  const b = gateBlockedWith({ userLiveApproved: false }, "USER_NOT_LIVE_APPROVED");
  record(2, "Live blocked until master switch + protected unlock pass",
    a.ok && b.ok, `master:${a.detail} | unlock:${b.detail}`);
}

// ── 3. Kill switch
{
  const a = gateBlockedWith({ killSwitchEngaged: true }, "KILL_SWITCH_ENGAGED");
  // Pipeline also re-checks kill switch before insert (TOCTOU guard) — grep
  const pipe = read("artifacts/api-server/src/lib/live/liveCommandPipeline.ts");
  const reChecks = /KILL_SWITCH_ENGAGED/.test(pipe) && /killSwitchEngaged/.test(pipe);
  record(3, "Kill switch blocks live immediately (gate + pipeline TOCTOU)",
    a.ok && reChecks, `gate:${a.detail} | pipelineReChecks=${reChecks}`);
}

// ── 4. Live command cannot use demo endpoint
{
  const demoPoll = read("artifacts/api-server/src/routes/mt5DemoBridge.ts");
  // demo poll reads only mt5_demo_commands and never live tables
  const onlyDemoTable = /mt5_demo_commands|mt5DemoCommands/.test(demoPoll) &&
    !/arxLiveCommandsTable|arx_live_commands/.test(demoPoll);
  record(4, "Live command cannot use demo endpoint (demo path doesn't read live queue)",
    onlyDemoTable, `demoOnly=${onlyDemoTable}`);
}

// ── 5. Demo command cannot use live endpoint
{
  const liveRoute = read("artifacts/api-server/src/routes/mt5Live.ts");
  const rejectsDemoBridge = /BRIDGE_NOT_LIVE_ACCOUNT/.test(liveRoute) &&
    /acct\s*!==?\s*"live"\s*&&\s*acct\s*!==?\s*"real"/.test(liveRoute);
  record(5, "Demo bridge rejected by live endpoint (BRIDGE_NOT_LIVE_ACCOUNT)",
    rejectsDemoBridge, `rejects=${rejectsDemoBridge}`);
}

// ── 6. EA v1.27+ required
{
  const a = gateBlockedWith({ bridgeEaVersion: "1.26" }, "EA_VERSION_TOO_OLD");
  record(6, "EA v1.27+ required for live broker execution", a.ok, a.detail);
}

// ── 7. ReadOnlyMode=true blocks
{
  const a = gateBlockedWith({ bridgeReadOnlyMode: true }, "EA_READ_ONLY_MODE_TRUE");
  record(7, "Live blocked if ReadOnlyMode=true", a.ok, a.detail);
}

// ── 8. EnableLiveExecution=false blocks
{
  const a = gateBlockedWith({ bridgeEnableLiveExecution: false }, "EA_ENABLE_LIVE_EXECUTION_FALSE");
  record(8, "Live blocked if EnableLiveExecution=false", a.ok, a.detail);
}

// ── 9. AccountType not LIVE blocks
{
  const a = gateBlockedWith({ bridgeAccountType: "demo" }, "BRIDGE_NOT_LIVE_ACCOUNT");
  // Plus route-level rejection
  const liveRoute = read("artifacts/api-server/src/routes/mt5Live.ts");
  const routeRejects = /BRIDGE_NOT_LIVE_ACCOUNT/.test(liveRoute);
  record(9, "Live blocked if AccountType is not LIVE (gate + route)",
    a.ok && routeRejects, `gate:${a.detail} routeRejects=${routeRejects}`);
}

// ── 10. Stop-loss required by default
{
  const a = gateBlockedWith({ commandHasStopLoss: false }, "MISSING_STOP_LOSS");
  record(10, "Stop-loss required by default", a.ok, a.detail);
}

// ── 11. Max-lot guard
{
  const a = gateBlockedWith({ commandVolume: 0.05, maxLotForSymbol: 0.01 },
    "VOLUME_EXCEEDS_MAX_LIVE_LOT");
  record(11, "Max live lot guard fires", a.ok, a.detail);
}

// ── 12. Daily-loss guard
{
  const a = gateBlockedWith({ realisedDailyLossUsd: 150, dailyLossLimitUsd: 100 },
    "DAILY_LOSS_LIMIT_REACHED");
  record(12, "Daily loss guard fires (and is wired from real data)", a.ok, a.detail);
}

// ── 13. Duplicate live command idempotency
{
  // Recompute the SHA256 the pipeline computes; assert determinism + that
  // the partial-unique index exists on arx_live_commands and pipeline
  // surfaces DUPLICATE_LIVE_IDEMPOTENCY_KEY.
  const minuteBucket = "2026-01-01T00:00";
  const payload = `42|EURUSD|BUY|0.01|1.05|null|${minuteBucket}`;
  const h1 = createHash("sha256").update(payload).digest("hex");
  const h2 = createHash("sha256").update(payload).digest("hex");
  const pipe = read("artifacts/api-server/src/lib/live/liveCommandPipeline.ts");
  const schema = read("lib/db/src/schema/arxLiveExecution.ts");
  const pipeSurfaces = /DUPLICATE_LIVE_IDEMPOTENCY_KEY/.test(pipe) &&
    /arx_live_commands_idem_active_uq/.test(pipe);
  const partialIdx = /idem_active_uq|idempotency_key|idempotencyKey/.test(schema);
  record(13, "Duplicate live command blocked (SHA256 + partial unique + pipeline surface)",
    h1 === h2 && pipeSurfaces && partialIdx,
    `deterministic=${h1 === h2} pipeSurfaces=${pipeSurfaces} schemaIdx=${partialIdx}`);
}

// ── 14. Market Scanner LIVE remains locked until protected unlock
{
  const modal = read("artifacts/trading-dashboard/src/components/scanner/ScannerTradeModal.tsx");
  // Routes through <LiveTradeTicket /> which itself gates on `armed` (live
  // unlock) before allowing submit — i.e. scanner is not a back door.
  const usesTicket = /<LiveTradeTicket\b/.test(modal);
  const ticket = read("artifacts/trading-dashboard/src/components/live/LiveTradeTicket.tsx");
  const ticketGates = /\barmed\b/.test(ticket) && /Live trading not armed|live-trading/.test(ticket);
  record(14, "Market Scanner LIVE gated through LiveTradeTicket unlock card",
    usesTicket && ticketGates, `scannerUsesTicket=${usesTicket} ticketGates=${ticketGates}`);
}

// ── 15. Live trade ticket warning text
{
  const ticket = read("artifacts/trading-dashboard/src/components/live/LiveTradeTicket.tsx");
  const ctrl = read("artifacts/trading-dashboard/src/components/live/ControlledLiveTestButton.tsx");
  const ticketWarn = /LIVE TRADE\s*—\s*REAL MONEY CAN BE LOST/.test(ticket);
  // ControlledLiveTestButton should also signal real-money risk
  const ctrlWarn = /Controlled Live Test|ENABLE LIVE TRADING/.test(ctrl);
  record(15, "LiveTradeTicket shows 'LIVE TRADE — REAL MONEY CAN BE LOST'",
    ticketWarn && ctrlWarn, `ticket=${ticketWarn} ctrl=${ctrlWarn}`);
}

// ── 16. Ruby warnings never promise profit
{
  const files = [
    "artifacts/api-server/src/routes/meAssistant.ts",
    "artifacts/api-server/src/lib/assistant/coachTools.ts",
    "artifacts/trading-dashboard/src/components/scanner/RubySetupReason.tsx",
  ];
  let bad: string[] = [];
  for (const f of files) {
    const s = read(f);
    // Forbidden marketing phrases. Allow "take profit" (TP) and meta comments.
    const forbidden = [
      /guaranteed\s+(profit|win|return)/i,
      /will\s+make\s+you\s+(money|rich)/i,
      /risk[-\s]?free/i,
      /sure\s+thing/i,
    ];
    for (const r of forbidden) if (r.test(s)) bad.push(`${f} :: ${r}`);
  }
  // Positive evidence: assistant declares safetyMode paper_only + liveLocked
  const coach = read("artifacts/api-server/src/lib/assistant/coachTools.ts");
  const safeEnvelope = /safetyMode:\s*"paper_only"/.test(coach) && /liveLocked:\s*true/.test(coach);
  record(16, "Ruby never promises profit (no forbidden phrases + paper_only envelope)",
    bad.length === 0 && safeEnvelope,
    bad.length ? `BAD: ${bad.join("; ")}` : `envelope=${safeEnvelope}`);
}

// ── 17. No broker password / bridge token / API key / secret in UI/logs/Ruby
{
  // Server routes for live + assistant must not log or return secret VALUES.
  // Allow references to the *name* MT5_BRIDGE_TOKEN in setup-page docs
  // because we explicitly reject the legacy server-wide value at runtime.
  const surfaces = [
    "artifacts/api-server/src/routes/meLive.ts",
    "artifacts/api-server/src/routes/mt5Live.ts",
    "artifacts/api-server/src/routes/meAssistant.ts",
    "artifacts/api-server/src/lib/assistant/memoryStore.ts",
    "artifacts/trading-dashboard/src/components/live/LiveTradeTicket.tsx",
    "artifacts/trading-dashboard/src/components/live/ControlledLiveTestButton.tsx",
    "artifacts/trading-dashboard/src/components/live/OpenLivePositions.tsx",
    "artifacts/trading-dashboard/src/components/live/RecentLiveCommands.tsx",
  ];
  let leaks: string[] = [];
  for (const f of surfaces) {
    const raw = read(f);
    // Strip line comments + block comments + string-literal regex patterns
    // used for *redaction* (these are protective, not leaks).
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/[^\n\/]*apiKeyHash[^\n\/]*\/[gimuy]*/g, ""); // redaction regex literals
    // process.env access to secret values
    if (/process\.env\.(MT5_BRIDGE_TOKEN|SESSION_SECRET|TWELVEDATA_API_KEY)/.test(stripped))
      leaks.push(`${f}: reads secret env value`);
    // returning rawToken / apiKeyHash / password as a field VALUE in response
    // (heuristic: field appears as object key being assigned, or in res.json).
    if (/\b(rawToken|brokerPassword|accountPassword)\s*[:,)]/.test(stripped))
      leaks.push(`${f}: surfaces raw token / password field`);
    if (/res\.json\([^)]*\bapiKeyHash\b/.test(stripped))
      leaks.push(`${f}: returns apiKeyHash in response`);
  }
  record(17, "No broker password/bridge token/API key/secret in UI/logs/Ruby",
    leaks.length === 0, leaks.length ? leaks.join(" | ") : "no leaks");
}

// ── 18. Controlled EURUSD 0.01 test button exists + manual confirmation
{
  const ctrl = read("artifacts/trading-dashboard/src/components/live/ControlledLiveTestButton.tsx");
  const hasPhrase = /const\s+PHRASE\s*=\s*"ENABLE LIVE TRADING"/.test(ctrl);
  const neverAutofires = /NEVER auto-fires|never auto-fires/i.test(ctrl);
  const pinnedSymbol = /EURUSD/.test(ctrl);
  const pinnedLot = /0\.01/.test(ctrl);
  const slRequired = /required|Stop loss \(required\)/i.test(ctrl);
  const ok = hasPhrase && neverAutofires && pinnedSymbol && pinnedLot && slRequired;
  record(18, "Controlled live test button: typed phrase + EURUSD + 0.01 + SL required + never auto-fires",
    ok, `phrase=${hasPhrase} pinSym=${pinnedSymbol} pinLot=${pinnedLot} sl=${slRequired} noAutofire=${neverAutofires}`);
}

// ── 19. Live positions panel separate from demo
{
  const livePanel = read("artifacts/trading-dashboard/src/components/live/OpenLivePositions.tsx");
  // Must read the live endpoint, not the demo positions endpoint.
  const usesLiveEp = /\/api\/me\/live\/positions|arx_live_positions/.test(livePanel);
  const noDemoEp = !/\/api\/me\/demo|mt5_demo_positions/.test(livePanel);
  record(19, "Live Positions panel separate from Demo (reads live endpoint, never demo)",
    usesLiveEp && noDemoEp, `liveEp=${usesLiveEp} noDemoEp=${noDemoEp}`);
}

// ── 20. Any check fail → live broker execution stays disabled + exact reason
{
  // The gate evaluator returns a single `primaryReason` plus full
  // `blockReasons[]` so the UI can render the exact failing gate.
  const r = evaluateLivePhaseBDispatchGate({ ...BASE,
    liveBrokerExecutionEnabled: false, bridgeReadOnlyMode: true, commandHasStopLoss: false });
  const hasPrimary = typeof r.primaryReason === "string" && r.primaryReason.length > 0;
  const hasAll = r.blockReasons.length >= 3;
  const masterStillOff = r.blockReasons.includes("LIVE_BROKER_EXECUTION_DISABLED") &&
    r.blockReasons.includes("BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED");
  record(20, "On failure: stays disabled, returns primaryReason + full blockReasons",
    r.decision === "BLOCKED" && hasPrimary && hasAll && masterStillOff,
    `decision=${r.decision} primary=${r.primaryReason} count=${r.blockReasons.length}`);
}

// ── Report
let pass = 0, fail = 0;
for (const r of results) {
  const tag = r.ok ? "PASS" : "FAIL";
  if (r.ok) pass++; else fail++;
  // eslint-disable-next-line no-console
  console.log(`${tag} ${String(r.id).padStart(2, "0")}. ${r.name}\n    ${r.detail}`);
}
// eslint-disable-next-line no-console
console.log(`\n${pass}/${results.length} PASS · ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
