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
//     --symbol EURUSD --lots 0.02 --confirm-demo-orders [--json out.json]

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
    lots: Number(val("--lots") ?? 0.02),
    venue: String(val("--venue") ?? "DEMO").toUpperCase(),
    confirmed: argv.includes("--confirm-demo-orders"),
    json: val("--json"),
  };
}

/** Why a run may not start, or null. Pure. */
export function refuseRun(a: RunArgs): string | null {
  if (a.venue !== "DEMO") return "This suite only runs against DEMO. LIVE validation is an owner-run micro-lot cycle (live micro-test scripts).";
  if (!Number.isInteger(a.userId) || a.userId <= 0) return "Name the demo user explicitly with --user-id <id>.";
  if (!(a.lots >= 0.02 && a.lots <= 0.1) || Math.abs(a.lots * 100 - Math.round(a.lots * 100)) > 1e-8) return "--lots must be 0.02–0.10 in 0.01 increments so a real partial close can be verified.";
  if (!a.confirmed) return "This places real orders on a DEMO broker account. Re-run with --confirm-demo-orders.";
  return null;
}

export interface DemoSnapshot {
  demo: boolean;
  snapshotAt: number | null;
  ambiguous: boolean;
  position: { status: string; lots: number; stop: number | null; at: number | null } | null;
}

/** A command acknowledgement alone is never position/snapshot evidence. */
export function demoSnapshotMatches(s: DemoSnapshot, expected: { after: number; positionAfter?: number; lots: number; stop: number | null; now: number }): boolean {
  const fresh = (at: number | null, after = expected.after) => at != null && Number.isFinite(at) && at >= after && at <= expected.now && expected.now - at < 60_000;
  if (!s.demo || s.ambiguous || !fresh(s.snapshotAt)) return false;
  if (expected.lots === 0) return s.position == null || s.position.status === "CLOSED" && fresh(s.position.at, expected.positionAfter);
  const p = s.position;
  return !!p && p.status === "OPEN" && fresh(p.at, expected.positionAfter) && Number.isFinite(p.lots) && Math.abs(p.lots - expected.lots) < 1e-6
    && (expected.stop == null || p.stop != null && Number.isFinite(p.stop) && Math.abs(p.stop - expected.stop) < 1e-6);
}

export function wideningWasBlocked(reason: string | null): boolean {
  return reason?.startsWith("RISK_GATE_FAILED:") === true
    && reason.slice("RISK_GATE_FAILED:".length).split(",").includes("stop_loss_required");
}

/** Known source incompatibilities, checked BEFORE this suite can open a position.
 * Passing this check is not certification; the normal gates and observed
 * broker snapshots still decide every scenario. Never infer support from a
 * higher version number across the separate EA protocol families.
 */
export function knownDemoBridgeIncompatibility(version: string | null | undefined): string | null {
  const v = version?.trim().replace(/^v/i, "");
  if (v && /^1\.(26|27|28|29)(\.0)?$/.test(v)) {
    return "This EA closes the entire position for CLOSE_POSITION, including partial-close requests. Keep it read-only; install and verify a DEMO bridge that respects the requested close volume before validation.";
  }
  if (v && /^1\.(30|40|50|51|52|54)(\.0)?$/.test(v)) {
    return "This EA source uses the generic command mailbox, not the DEMO validator mailbox. Verify DEMO protocol compatibility before validation.";
  }
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
  const refusal = refuseRun(a);
  if (refusal) throw new Error(refusal); // exported entry point enforces consent too
  const out: StepResult[] = [];
  const step = (id: string, ok: boolean, detail: string) => { out.push({ id, ok, detail }); return ok; };
  const { loadPlatformHalt } = await import("../lib/safety/tradingHalt.js");
  const { loadQuote } = await import("../lib/riskGovernor/enforce.js");
  const queue = await import("../lib/mt5/demoCommandQueue.js");
  const ops = await import("../lib/positions/governedOps.js");
  const guardian = await import("../lib/positionGuardian/reconcile.js");

  const { getUserConnection, listUserConnections } = await import("../lib/brokerHub/connections.js");
  const { readBrokerOperatorControls, brokerControlBlocks } = await import("../lib/safety/tradingHalt.js");
  const { evaluateRoutedDemoDispatchGate } = await import("../lib/mt5/masterBridgeRouting.js");
  const { demoPositionLedger, demoPositionColumns } = await import("../lib/positions/ledger.js");
  const { and, eq } = await import("drizzle-orm");
  // The legacy DEMO mirror has no account key. Refuse ambiguous ownership,
  // and never use the cross-venue ticket lookup (LIVE can reuse a DEMO ticket).
  const connections = await listUserConnections(a.userId);
  const connection = connections.length === 1 ? connections[0] : null;
  const bridgeOK = connection?.accountType === "demo" && connection.mode === "DEMO"
    && connection.status === "connected" && connection.hasBridgeToken
    && connection.tokenRevokedAt == null;
  const blocks = brokerControlBlocks(await readBrokerOperatorControls(), { venue: "DEMO", opensNewRisk: true });
  if (!bridgeOK || blocks.length) {
    step("preflight", false, !bridgeOK ? "Requires exactly one registered connection: connected, token-active and explicitly DEMO." : blocks.join(", "));
    return out;
  }
  const incompatible = knownDemoBridgeIncompatibility(connection!.eaVersion);
  if (incompatible) {
    step("preflight", false, incompatible);
    return out;
  }
  const route = await evaluateRoutedDemoDispatchGate({ userId: a.userId, userConfirmed: true, duplicateClear: true });
  if (route.routing.routedViaMaster || route.evidence.bridgeConnectionId !== connection!.id
    || !route.evidence.heartbeatFresh || !route.evidence.verifiedDemo || !route.eligibility.eligible) {
    step("preflight", false, "Validation requires a verified, fresh, user-owned DEMO route to the selected connection.");
    return out;
  }
  const readSnapshot = async (ticket: string): Promise<DemoSnapshot> => {
    const [bridge, rows] = await Promise.all([
      getUserConnection(a.userId, connection!.id),
      demoPositionLedger.read({ where: and(eq(demoPositionColumns.userId, a.userId), eq(demoPositionColumns.brokerPositionId, ticket)), limit: 2 }),
    ]);
    return {
      demo: bridge?.accountType === "demo" && bridge.mode === "DEMO" && bridge.status === "connected" && bridge.hasBridgeToken && bridge.tokenRevokedAt == null,
      snapshotAt: bridge?.lastPositionsSnapshotAt?.getTime() ?? null,
      ambiguous: rows.length > 1,
      position: rows[0] ? { status: rows[0].status, lots: rows[0].lotSize, stop: rows[0].stopLoss, at: rows[0].lastSyncedAt?.getTime() ?? null } : null,
    };
  };
  const waitSnapshot = async (ticket: string, after: number, lots: number, stop: number | null, positionAfter = after) => {
    const until = Date.now() + 60_000;
    do {
      const snapshot = await readSnapshot(ticket);
      if (demoSnapshotMatches(snapshot, { after, positionAfter, lots, stop, now: Date.now() })) return true;
      await new Promise(r => setTimeout(r, 1000));
    } while (Date.now() < until);
    return false;
  };
  const halt = await loadPlatformHalt();
  const quote = await loadQuote(a.userId, a.symbol);
  const ask = quote?.ask ?? quote?.bid ?? null;
  if (!step("preflight", !halt.engaged && ask != null,
    halt.engaged ? `halted: ${halt.reason}` : ask == null ? `no quote for ${a.symbol}` : `quote ${ask} (${quote!.source})`)) return out;

  const entryStarted = Date.now();
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

  const filledLots = filled?.fillVolume;
  if (filledLots == null || !Number.isFinite(filledLots) || Math.abs(filledLots - a.lots) > 1e-6 || filled?.bridgeConnectionId !== connection!.id) {
    step("guardian_verifies", false, "Entry fill volume or bridge identity does not match this DEMO validation run; inspect the ticket before continuing.");
    return out;
  }
  const entryObserved = await waitSnapshot(ticket!, Date.now(), filledLots, stop, entryStarted);
  const g = await guardian.reconcilePosition("DEMO", a.userId, ticket!, { trigger: "snapshot" });
  step("guardian_verifies", entryObserved && g?.assessment.action === "NONE", `${g?.assessment.action ?? "no assessment"}: ${g?.assessment.reason ?? ""}`);

  const pos = { venue: "DEMO" as const, ticket: ticket!, symbol: a.symbol, side: "BUY" as const, lots: filledLots };
  const modifyStarted = Date.now();
  const tighter = Number((ask! * 0.995).toFixed(5));
  const mod = await ops.submitGovernedModify(a.userId, pos, tighter, null, "BROKER_VALIDATION");
  const modDone = mod.commandId ? await waitForCommand(a.userId, mod.commandId) : null;
  const tightened = mod.ok && modDone?.status === "FILLED_DEMO" && await waitSnapshot(ticket!, Date.now(), filledLots, tighter, modifyStarted);
  step("tighten_stop", tightened, `${modDone?.status ?? mod.reason}; fresh snapshot matches=${tightened}`);

  const widenStarted = Date.now();
  const widen = await ops.submitGovernedModify(a.userId, pos, Number((ask! * 0.98).toFixed(5)), null, guardian.GUARDIAN_SOURCE);
  const widenBlocked = !widen.ok && wideningWasBlocked(widen.reason)
    && await waitSnapshot(ticket!, Date.now(), filledLots, tightened ? tighter : stop, widenStarted);
  step("automation_cannot_widen", widenBlocked, widen.ok ? "WIDENING WAS ACCEPTED" : `refused: ${widen.reason}; snapshot unchanged=${widenBlocked}`);

  const half = Math.floor(filledLots * 100 / 2) / 100;
  const partialStarted = Date.now();
  const pc = await ops.submitGovernedClose(a.userId, { ...pos, lots: half }, "BROKER_VALIDATION");
  const pcDone = pc.commandId ? await waitForCommand(a.userId, pc.commandId) : null;
  const remaining = Number((filledLots - half).toFixed(2));
  const partialObserved = pc.ok && pcDone?.status === "FILLED_DEMO"
    && await waitSnapshot(ticket!, Date.now(), remaining, tightened ? tighter : stop, partialStarted);
  const partialGuardian = partialObserved ? await guardian.reconcilePosition("DEMO", a.userId, ticket!, { trigger: "snapshot" }) : null;
  step("partial_close", partialObserved && partialGuardian?.assessment.action === "NONE",
    `${pcDone?.status ?? pc.reason}; ${remaining} lots remain in fresh snapshot=${partialObserved}; guardian=${partialGuardian?.assessment.action ?? "unverified"}`);

  // The entry command still contains the original volume. Read the actual
  // remainder; never submit that original volume after a partial close.
  const rest = await readSnapshot(ticket!);
  if (!rest.demo || rest.ambiguous || !rest.position || rest.position.status !== "OPEN" || !(rest.position.lots > 0)
    || !demoSnapshotMatches(rest, { after: partialStarted, lots: rest.position.lots, stop: null, now: Date.now() })) {
    step("full_close", false, "Fresh DEMO remainder unavailable; inspect and close the ticket through the governed close path.");
    return out;
  }
  const closeStarted = Date.now();
  const fc = await ops.submitGovernedClose(a.userId, { ...pos, lots: rest.position.lots }, "BROKER_VALIDATION");
  const fcDone = fc.commandId ? await waitForCommand(a.userId, fc.commandId) : null;
  const closed = fc.ok && fcDone?.status === "FILLED_DEMO" && await waitSnapshot(ticket!, Date.now(), 0, null, closeStarted);
  step("full_close", closed, `${fcDone?.status ?? fc.reason}; broker snapshot confirms closed=${closed}`);
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
