// Broker validation suite (Tier 1 finalization, item 11).
//
// Status: CODE COMPLETE — EXTERNAL BROKER VALIDATION REQUIRED.
//
// Every scenario below is proven in CI against the governed pipeline with a
// simulated broker (the `offlineProof` test scripts). What CI cannot prove is
// that a real broker bridge behaves the same way. This runner drives the same
// scenarios against a real DEMO bridge, through the same code the app uses:
//   entry      → demoCommandQueue draft → confirm → dispatch (Risk Governor)
//   protection → Position Guardian reconcilePosition on the broker snapshot
//   edits      → lib/positions/governedOps (submitGovernedModify / Close)
// and records what the broker answered.
//
// It never touches LIVE (no real money): --venue LIVE is refused. It places
// demo orders only with --confirm-demo-orders, for one explicitly named user.
//
// Usage:
//   pnpm --filter @workspace/api-server run validate:broker               # print the plan
//   pnpm --filter @workspace/api-server run validate:broker -- --run --user-id <id> \
//     --symbol EURUSD --lots 0.01 --confirm-demo-orders [--json out.json]

import { pool } from "@workspace/db";

export interface Scenario {
  id: string;
  title: string;
  expect: string;
  /** CI test script(s) proving the logic with a simulated broker. */
  offlineProof: string[];
  /** Run against the real demo bridge by --run. */
  external: boolean;
}

export const SCENARIOS: Scenario[] = [
  { id: "preflight", title: "Bridge connected, trader armed, no halt", expect: "routed gate ready; platform emergency stop released", offlineProof: ["test:production-readiness-check"], external: true },
  { id: "entry_fill", title: "Market entry with a stop through the Risk Governor", expect: "FILLED_DEMO with a broker ticket; risk verdict recorded", offlineProof: ["test:risk-governor-pipelines"], external: true },
  { id: "guardian_verifies", title: "Position Guardian verifies the broker stop", expect: "guardian verdict PROTECTED (stop on the broker matches the governed stop)", offlineProof: ["test:position-guardian-reconcile"], external: true },
  { id: "tighten_stop", title: "Trader tightens the stop through the governed queue", expect: "MODIFY_SLTP filled; next snapshot shows the new stop", offlineProof: ["test:risk-governor-pipelines"], external: true },
  { id: "automation_cannot_widen", title: "Automation trying to widen the stop is refused", expect: "Risk Governor blocks; broker stop unchanged", offlineProof: ["test:position-guardian-reconcile", "test:risk-governor-pipelines"], external: true },
  { id: "partial_close", title: "Partial close keeps the remainder guarded", expect: "CLOSE_POSITION filled for half; remainder still open and guarded", offlineProof: ["test:position-guardian-reconcile"], external: true },
  { id: "full_close", title: "Full close", expect: "CLOSE_POSITION filled; position gone from the next snapshot", offlineProof: ["test:position-guardian-reconcile"], external: true },
  { id: "foreign_position", title: "A position opened outside ARX cannot be edited through ARX", expect: "409 NOT_AN_ARX_GOVERNED_POSITION", offlineProof: ["test:risk-governor-pipelines"], external: false },
  { id: "stale_data", title: "Stale or missing broker data", expect: "exposure-increasing orders rejected; closes and tightening still allowed", offlineProof: ["test:risk-governor-pipelines"], external: false },
  { id: "emergency_stop", title: "Platform emergency stop engaged", expect: "new DEMO/LIVE risk refused; closes allowed; only owner/operator can engage or release", offlineProof: ["test:risk-governor-pipelines", "test:single-role-model"], external: false },
  { id: "reconnect", title: "Bridge reconnect after a gap", expect: "every governed position re-checked once and audited", offlineProof: ["test:position-guardian-reconcile"], external: false },
  { id: "live_micro", title: "LIVE micro-lot cycle", expect: "owner-run only, with the existing live micro-test scripts; not run by this suite", offlineProof: ["test:risk-governor-pipelines"], external: false },
];

export interface StepResult { id: string; ok: boolean; detail: string }

export interface RunArgs { userId: number; symbol: string; lots: number; venue: string; confirmed: boolean }

export function parseArgs(argv: string[]): RunArgs & { run: boolean; json: string | null } {
  const val = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] ?? null : null);
  return {
    run: argv.includes("--run"),
    userId: Number(val("--user-id") ?? NaN),
    symbol: String(val("--symbol") ?? "EURUSD").toUpperCase(),
    lots: Number(val("--lots") ?? 0.01),
    venue: String(val("--venue") ?? "DEMO").toUpperCase(),
    confirmed: argv.includes("--confirm-demo-orders"),
    json: val("--json"),
  };
}

/** Why a run may not start, or null. Pure. */
export function refuseRun(a: RunArgs): string | null {
  if (a.venue !== "DEMO") return "This suite only runs against DEMO. LIVE validation is an owner-run micro-lot cycle (live micro-test scripts).";
  if (!Number.isInteger(a.userId) || a.userId <= 0) return "Name the demo user explicitly with --user-id <id>.";
  if (!(a.lots > 0 && a.lots <= 0.1)) return "--lots must be between 0 and 0.1 for validation.";
  if (!a.confirmed) return "This places real orders on a DEMO broker account. Re-run with --confirm-demo-orders.";
  return null;
}

const TERMINAL = new Set(["FILLED_DEMO", "REJECTED", "BLOCKED", "FAILED", "CANCELLED", "EXPIRED"]);

async function waitForCommand(userId: number, commandId: string, timeoutMs = 60_000) {
  const { getUserCommand } = await import("../lib/mt5/demoCommandQueue.js");
  const until = Date.now() + timeoutMs;
  for (;;) {
    const c = await getUserCommand(userId, commandId);
    if (c && TERMINAL.has(c.status)) return c;
    if (Date.now() > until) return c;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function runExternal(a: RunArgs): Promise<StepResult[]> {
  const out: StepResult[] = [];
  const step = (id: string, ok: boolean, detail: string) => { out.push({ id, ok, detail }); return ok; };
  const { loadPlatformHalt } = await import("../lib/safety/tradingHalt.js");
  const { loadQuote } = await import("../lib/riskGovernor/enforce.js");
  const queue = await import("../lib/mt5/demoCommandQueue.js");
  const ops = await import("../lib/positions/governedOps.js");
  const guardian = await import("../lib/positionGuardian/reconcile.js");

  const halt = await loadPlatformHalt();
  const quote = await loadQuote(a.userId, a.symbol);
  const ask = quote?.ask ?? quote?.bid ?? null;
  if (!step("preflight", !halt.engaged && ask != null,
    halt.engaged ? `halted: ${halt.reason}` : ask == null ? `no quote for ${a.symbol}` : `quote ${ask} (${quote!.source})`)) return out;

  const stop = Number((ask! * 0.99).toFixed(5));
  const draft = await queue.createDraftCommand({ userId: a.userId, commandType: "PLACE_MARKET_ORDER",
    payload: { symbol: a.symbol, side: "BUY", lotSize: a.lots, stopLoss: stop, takeProfit: null, sourcePage: "BROKER_VALIDATION" } });
  if (!draft.ok || !draft.command) { step("entry_fill", false, `draft refused: ${draft.reason}`); return out; }
  const conf = await queue.confirmCommand({ userId: a.userId, commandId: draft.command.commandId });
  if (!conf.ok) { step("entry_fill", false, `confirm refused: ${conf.reason}`); return out; }
  if (conf.command?.status !== "SENT_TO_MT5_DEMO") await queue.dispatchApprovedCommand({ userId: a.userId, commandId: draft.command.commandId });
  const filled = await waitForCommand(a.userId, draft.command.commandId);
  const ticket = filled?.brokerTicket ?? null;
  if (!step("entry_fill", filled?.status === "FILLED_DEMO" && !!ticket, `${filled?.status ?? "no answer"} ticket=${ticket ?? "-"} ${filled?.reason ?? ""}`.trim())) return out;

  await new Promise((r) => setTimeout(r, 5000)); // one bridge snapshot
  const g = await guardian.reconcilePosition("DEMO", a.userId, ticket!, { trigger: "snapshot" });
  step("guardian_verifies", g?.assessment.action === "NONE", `${g?.assessment.action ?? "no assessment"}: ${g?.assessment.reason ?? ""}`);

  const pos = await ops.findGovernedPosition(a.userId, ticket!);
  if (!pos) { step("tighten_stop", false, "governed position not found"); return out; }
  const tighter = Number((ask! * 0.995).toFixed(5));
  const mod = await ops.submitGovernedModify(a.userId, pos, tighter, null, "BROKER_VALIDATION");
  const modDone = mod.commandId ? await waitForCommand(a.userId, mod.commandId) : null;
  step("tighten_stop", mod.ok && modDone?.status === "FILLED_DEMO", `${modDone?.status ?? mod.reason}`);

  const widen = await ops.submitGovernedModify(a.userId, pos, Number((ask! * 0.98).toFixed(5)), null, guardian.GUARDIAN_SOURCE);
  step("automation_cannot_widen", !widen.ok, widen.ok ? "WIDENING WAS ACCEPTED" : `refused: ${widen.reason}`);

  const half = Number((a.lots / 2).toFixed(2));
  if (half >= 0.01) {
    const pc = await ops.submitGovernedClose(a.userId, { ...pos, lots: half }, "BROKER_VALIDATION");
    const pcDone = pc.commandId ? await waitForCommand(a.userId, pc.commandId) : null;
    step("partial_close", pc.ok && pcDone?.status === "FILLED_DEMO", `${pcDone?.status ?? pc.reason} (${half} of ${a.lots})`);
  } else step("partial_close", true, `skipped: ${a.lots} lots cannot be halved (use --lots 0.02)`);

  const rest = await ops.findGovernedPosition(a.userId, ticket!);
  const fc = await ops.submitGovernedClose(a.userId, rest ?? pos, "BROKER_VALIDATION");
  const fcDone = fc.commandId ? await waitForCommand(a.userId, fc.commandId) : null;
  step("full_close", fc.ok && fcDone?.status === "FILLED_DEMO", `${fcDone?.status ?? fc.reason}`);
  return out;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (!a.run) {
    process.stdout.write("Broker validation suite — CODE COMPLETE — EXTERNAL BROKER VALIDATION REQUIRED\n\n");
    for (const s of SCENARIOS) process.stdout.write(`  ${s.external ? "[demo]" : "[ci]  "} ${s.id}: ${s.title}\n         expect: ${s.expect}\n         CI proof: ${s.offlineProof.join(", ")}\n`);
    process.stdout.write("\nRun the [demo] scenarios: --run --user-id <id> --symbol EURUSD --lots 0.02 --confirm-demo-orders\n");
    return;
  }
  const refused = refuseRun(a);
  if (refused) { process.stderr.write(`${refused}\n`); process.exitCode = 2; return; }
  const results = await runExternal(a);
  for (const r of results) process.stdout.write(`  ${r.ok ? "PASS" : "FAIL"} ${r.id}: ${r.detail}\n`);
  const ran = new Set(results.map((r) => r.id));
  for (const s of SCENARIOS.filter((x) => x.external && !ran.has(x.id))) process.stdout.write(`  NOT RUN ${s.id}\n`);
  if (a.json) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(a.json, JSON.stringify({ at: new Date().toISOString(), args: { ...a, confirmed: true }, results }, null, 2));
  }
  process.exitCode = results.every((r) => r.ok) && results.length === SCENARIOS.filter((s) => s.external).length ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().finally(() => pool.end());
}
