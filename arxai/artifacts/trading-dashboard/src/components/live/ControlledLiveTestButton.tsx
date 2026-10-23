// Live Test Cycle Panel — OWNER-only single-shot verification.
//
// REPLACES the previous ControlledLiveTestButton. Keeps the export
// name `ControlledLiveTestButton` so existing imports still resolve.
//
// SAFETY:
// - Never auto-fires. A single "Confirm Live Test Cycle" click starts the
//   cycle directly — there is NO second confirmation modal and NO ack
//   checkbox. There is NO typed-phrase requirement. Preview remains an
//   OPTIONAL dry-run helper, never a required pre-step.
// - Symbol pinned to EURUSD, volume pinned to 0.01 lot — server-side.
// - Every safety check (EA EnableLiveExecution, AlgoTrading, broker
//   connection, heartbeat, master bridge, kill switch, owner approval,
//   16-gate evaluator, etc.) still runs SERVER-SIDE on /start; blockers
//   surface in the result/cycle panel. When inputs are incomplete the
//   Confirm button is disabled with the exact reason shown beneath it.
// - Single-flight: the server refuses /start while a non-terminal
//   cycle exists; the UI shows the existing cycle's status instead of
//   another input form.
// - The status panel polls /current at 1.5s while a non-terminal
//   cycle is open, and stops when the cycle reaches a terminal state.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useTradingMode } from "../../hooks/useTradingMode";
import { useAssistantName } from "@/lib/assistant-name";
import { eaTooOldForCloseFill } from "@workspace/domain/safety-contracts/eaCloseFill";

type CycleStatus =
  | "PENDING_PRECHECK" | "DRY_RUN_BLOCKED"
  | "OPEN_DISPATCHED" | "OPEN_REJECTED"
  | "OPEN_FILLED" | "CLOSE_DISPATCHED"
  | "CLOSE_FAILED_MANUAL_REQUIRED" | "COMPLETED";

const TERMINAL: ReadonlyArray<CycleStatus> = [
  "DRY_RUN_BLOCKED", "OPEN_REJECTED", "CLOSE_FAILED_MANUAL_REQUIRED", "COMPLETED",
];

interface CycleRow {
  cycleId: string;
  status: CycleStatus;
  symbol: string;
  side: "BUY" | "SELL";
  requestedVolume: number;
  stopLoss: number;
  takeProfit: number | null;
  openCommandId: string | null;
  openBrokerTicket: string | null;
  openFillPrice: number | null;
  openRejectionReason: string | null;
  closeCommandId: string | null;
  closeFillPrice: number | null;
  closeRejectionReason: string | null;
  realizedPlUsd: number | null;
  pnlStatus: "PENDING" | "COMPUTED" | "UNKNOWN" | null;
  dataQualityFlag: string | null;
  reportedEaVersion: string | null;
  preflightStartedAt: string | null;
  openQueuedAt: string | null;
  eaPickedOpenAt: string | null;
  brokerOpenAt: string | null;
  positionDetectedAt: string | null;
  closeQueuedAt: string | null;
  eaPickedCloseAt: string | null;
  brokerCloseAt: string | null;
  positionRemovedAt: string | null;
  completedAt: string | null;
  blockGate: string | null;
  blockReason: string | null;
  manualResolveNote: string | null;
}

interface PrecheckItem { key: string; ok: boolean; detail: string; }
interface PreviewResp {
  ok: boolean;
  masterSwitchEnabled: boolean;
  precheck: PrecheckItem[];
  preflight: { ok: boolean; reason?: string; detail?: string };
  cycleInProgress: CycleRow | null;
  note?: string;
}

function ms(a: string | null, b: string | null): string {
  if (!a || !b) return "—";
  const d = new Date(b).getTime() - new Date(a).getTime();
  if (!Number.isFinite(d)) return "—";
  return `${d}ms`;
}

function fmtTs(t: string | null): string {
  if (!t) return "—";
  try { return new Date(t).toLocaleTimeString(); } catch { return t; }
}

export function ControlledLiveTestButton() {
  const { name } = useAssistantName();
  const mode = useTradingMode();
  const showAdminDiagnostics = mode.shouldShowAdminDiagnostics === true;
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [busy, setBusy] = useState<"" | "preview" | "start" | "resolve">("");
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [cycle, setCycle] = useState<CycleRow | null>(null);
  const [resolveNote, setResolveNote] = useState("");

  const isTerminal = cycle ? TERMINAL.includes(cycle.status) : true;
  const slNum = Number(stopLoss);
  const tpNum = takeProfit ? Number(takeProfit) : null;
  const slOk = stopLoss.length > 0 && Number.isFinite(slNum) && slNum > 0;
  const tpOk = takeProfit.length === 0 || (Number.isFinite(tpNum!) && tpNum! > 0);
  const inputsOk = slOk && tpOk;
  const canPreview = inputsOk && !busy && (!cycle || isTerminal);
  // Single Confirm — no Preview-first requirement, no modal, no ack. Every
  // safety check still runs server-side on /start. Confirm is enabled when
  // inputs are valid; the exact disabled reason is shown beneath it.
  const confirmDisabledReason = (() => {
    if (cycle && !isTerminal) return "A live test cycle is already in progress.";
    if (!slOk) return "Enter a stop loss greater than 0 to confirm.";
    if (!tpOk) return "Take profit must be greater than 0 when set.";
    return null;
  })();
  const canConfirm = confirmDisabledReason == null && !busy;

  const refreshCycle = useCallback(async () => {
    try {
      const r = await fetch("/api/me/live/test-cycle/current");
      if (r.status === 403) return; // not OWNER
      if (!r.ok) return;
      const j = await r.json() as { cycle: CycleRow | null };
      setCycle(j.cycle ?? null);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void refreshCycle(); }, [refreshCycle]);

  // Poll while a non-terminal cycle is open and the tab is visible.
  useEffect(() => {
    if (!cycle || TERMINAL.includes(cycle.status)) return;
    const tick = () => { if (!document.hidden) void refreshCycle(); };
    const id = window.setInterval(tick, 1500);
    return () => window.clearInterval(id);
  }, [cycle, refreshCycle]);

  async function runPreview() {
    setBusy("preview"); setErr(null); setPreview(null);
    try {
      const r = await fetch("/api/me/live/test-cycle/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side, stopLoss: slNum, takeProfit: tpNum }),
      });
      const j = await r.json() as PreviewResp;
      setPreview(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(""); }
  }

  async function confirmStart() {
    if (!canConfirm) return;
    setBusy("start"); setErr(null);
    try {
      const r = await fetch("/api/me/live/test-cycle/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side, stopLoss: slNum, takeProfit: tpNum, acknowledged: true }),
      });
      const j = await r.json() as { ok: boolean; cycle?: CycleRow; reason?: string; detail?: string };
      if (j.cycle) setCycle(j.cycle);
      if (!j.ok) setErr(`${j.reason ?? "ERROR"}${j.detail ? `: ${j.detail}` : ""}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(""); void refreshCycle(); }
  }

  async function resolveCycle() {
    if (!cycle) return;
    if (!resolveNote.trim()) { setErr("Resolution note required"); return; }
    setBusy("resolve"); setErr(null);
    try {
      const r = await fetch(`/api/me/live/test-cycle/${cycle.cycleId}/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: resolveNote }),
      });
      const j = await r.json() as { ok: boolean; cycle?: CycleRow; reason?: string };
      if (j.cycle) setCycle(j.cycle);
      if (!j.ok) setErr(j.reason ?? "RESOLVE_FAILED");
      setResolveNote("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(""); }
  }

  const stageRows = useMemo(() => {
    if (!cycle) return [];
    return [
      ["1. Preflight started",     cycle.preflightStartedAt,    null],
      ["2. Open queued",           cycle.openQueuedAt,          cycle.preflightStartedAt],
      ["3. EA picked open",        cycle.eaPickedOpenAt,        cycle.openQueuedAt],
      ["4. Broker open result",    cycle.brokerOpenAt,          cycle.eaPickedOpenAt],
      ["5. Position detected",     cycle.positionDetectedAt,    cycle.brokerOpenAt],
      ["6. Close queued",          cycle.closeQueuedAt,         cycle.positionDetectedAt],
      ["7. EA picked close",       cycle.eaPickedCloseAt,       cycle.closeQueuedAt],
      ["8. Broker close result",   cycle.brokerCloseAt,         cycle.eaPickedCloseAt],
      ["9. Position removed",      cycle.positionRemovedAt,     cycle.brokerCloseAt],
      ["10. Cycle completed",      cycle.completedAt,           cycle.preflightStartedAt],
    ] as Array<[string, string | null, string | null]>;
  }, [cycle]);

  const openLatency = cycle ? ms(cycle.preflightStartedAt, cycle.brokerOpenAt) : "—";
  const closeLatency = cycle ? ms(cycle.closeQueuedAt, cycle.brokerCloseAt) : "—";
  const totalLatency = cycle ? ms(cycle.preflightStartedAt, cycle.completedAt) : "—";

  return (
    <div className="rounded-lg border border-red-500/40 bg-red-950/20 p-4 space-y-4">
      <header>
        <div className="text-sm font-semibold text-red-300">
          Automated Live Verification Cycle — OWNER only, EURUSD 0.01 lot
        </div>
        <div className="text-xs text-zinc-400">
          A one-time, automated OPEN+CLOSE verification: opens a real 0.01
          EURUSD market order through the Live Shared bridge, waits for the
          broker fill, then automatically queues a close on the same ticket.
          Single-flight applies to <em>this automated tool only</em> — no
          second cycle while one is open. Symbol &amp; lot are server-pinned.
        </div>
        <div className="mt-1.5 text-[11px] text-zinc-500">
          This cycle is just a verification check. Owner/admin manual live
          testing is ongoing and has <strong>no per-trade limit</strong> —
          place additional live trades any time from the scanner, chart, Trade
          page, or {name} entry.
        </div>
      </header>

      {(!cycle || isTerminal) && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-zinc-300">
              Side
              <select className="mt-1 w-full rounded bg-zinc-900 border border-zinc-700 px-2 py-1 text-sm"
                value={side} onChange={(e) => setSide(e.target.value === "SELL" ? "SELL" : "BUY")}>
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </select>
            </label>
            <label className="text-xs text-zinc-300">
              Stop loss (required)
              <input type="number" step="0.00001" value={stopLoss}
                onChange={(e) => setStopLoss(e.target.value)}
                className="mt-1 w-full rounded bg-zinc-900 border border-zinc-700 px-2 py-1 text-sm"
                placeholder="e.g. 1.05000" />
            </label>
            <label className="text-xs text-zinc-300 col-span-2">
              Take profit (optional unless your access profile requires it)
              <input type="number" step="0.00001" value={takeProfit}
                onChange={(e) => setTakeProfit(e.target.value)}
                className="mt-1 w-full rounded bg-zinc-900 border border-zinc-700 px-2 py-1 text-sm" />
            </label>
          </div>

          <div className="flex gap-2">
            <button type="button" onClick={runPreview} disabled={!canPreview}
              data-testid="ltc-btn-preview"
              className={`flex-1 rounded px-3 py-2 text-sm font-semibold ${
                canPreview ? "bg-zinc-700 hover:bg-zinc-600 text-white" : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
              }`}>
              {busy === "preview" ? "Previewing…" : "Preview (optional dry-run)"}
            </button>
            <button type="button" onClick={confirmStart} disabled={!canConfirm}
              data-testid="ltc-btn-confirm"
              className={`flex-1 rounded px-3 py-2 text-sm font-semibold ${
                canConfirm ? "bg-red-600 hover:bg-red-500 text-white" : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
              }`}
              title={confirmDisabledReason ?? "Confirm and start the live test cycle"}>
              {busy === "start" ? "Sending live order…" : `Confirm Live Test Cycle (${side})`}
            </button>
          </div>

          {confirmDisabledReason && (
            <div className="text-[11px] text-amber-300" data-testid="ltc-confirm-disabled-reason">
              {confirmDisabledReason}
            </div>
          )}

          {canConfirm && (
            <div className="text-[11px] text-zinc-500">
              One click confirms and opens a real 0.01 EURUSD live test trade. Preview is
              an optional dry-run — every safety gate still runs server-side on Confirm.
            </div>
          )}

          {preview && (
            <div className="rounded bg-zinc-900 border border-zinc-700 p-3 text-xs text-zinc-200 space-y-2">
              <div className="font-semibold">
                Preview:{" "}
                <span className={preview.ok ? "text-green-400" : "text-amber-400"}>
                  {preview.ok ? "READY" : "BLOCKED"}
                </span>
                <span className="ml-2 text-zinc-500">
                  master switch: <code>{String(preview.masterSwitchEnabled)}</code>
                </span>
              </div>
              <ul className="space-y-0.5">
                {preview.precheck.map((c) => (
                  <li key={c.key} className="font-mono">
                    <span className={c.ok ? "text-green-400" : "text-red-400"}>{c.ok ? "✓" : "✗"}</span>{" "}
                    <span className="text-zinc-300">{c.key}</span>
                    <span className="text-zinc-500"> — {c.detail}</span>
                  </li>
                ))}
                <li className="font-mono">
                  <span className={preview.preflight.ok ? "text-green-400" : "text-red-400"}>
                    {preview.preflight.ok ? "✓" : "✗"}
                  </span>{" "}
                  <span className="text-zinc-300">preflight</span>
                  {!preview.preflight.ok && (
                    <span className="text-zinc-500"> — {preview.preflight.reason}{preview.preflight.detail ? `: ${preview.preflight.detail}` : ""}</span>
                  )}
                </li>
              </ul>
              {preview.note && <div className="text-zinc-500 italic">{preview.note}</div>}
            </div>
          )}
        </>
      )}

      {err && <div className="text-xs text-red-400">Error: {err}</div>}

      {cycle && (
        <section className="rounded bg-zinc-900 border border-zinc-700 p-3 text-xs text-zinc-200 space-y-2">
          <div className="flex items-center justify-between">
            <div className="font-semibold">
              Cycle <code className="text-zinc-400">{cycle.cycleId}</code>
              <span className="ml-2">
                Status:{" "}
                <span className={
                  cycle.status === "COMPLETED" ? "text-green-400"
                  : cycle.status === "CLOSE_FAILED_MANUAL_REQUIRED" ? "text-red-400"
                  : cycle.status.endsWith("REJECTED") || cycle.status === "DRY_RUN_BLOCKED" ? "text-amber-400"
                  : "text-blue-400"
                }>
                  {cycle.status}
                </span>
              </span>
            </div>
            <div className="text-zinc-500">
              {cycle.side} {cycle.symbol} {cycle.requestedVolume} SL={cycle.stopLoss}{cycle.takeProfit != null ? ` TP=${cycle.takeProfit}` : ""}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <div>Open command: <code>{cycle.openCommandId ?? "—"}</code></div>
            <div>Close command: <code>{cycle.closeCommandId ?? "—"}</code></div>
            <div>MT5 ticket: <code>{cycle.openBrokerTicket ?? "—"}</code></div>
            <div>
              Realized P/L (USD):{" "}
              {cycle.pnlStatus === "COMPUTED" && typeof cycle.realizedPlUsd === "number" ? (
                <code>{cycle.realizedPlUsd.toFixed(2)}</code>
              ) : (
                <code className="text-zinc-400">unavailable</code>
              )}
            </div>
            <div>Open fill: <code>{cycle.openFillPrice ?? "—"}</code></div>
            <div>Close fill: <code>{cycle.closeFillPrice ?? "—"}</code></div>
          </div>

          {cycle.status === "COMPLETED" && cycle.pnlStatus && cycle.pnlStatus !== "COMPUTED" && (
            <div className="rounded border border-amber-500/40 bg-amber-950/20 p-2 text-amber-200">
              Trade opened and closed successfully. P/L unavailable because the
              close fill price was not returned.
              {eaTooOldForCloseFill(cycle.reportedEaVersion) && (
                <div
                  className="mt-1.5 text-[11px] text-amber-100"
                  data-testid={`cycle-ea-upgrade-hint-${cycle.cycleId}`}
                >
                  EA version too old to report close fill — upgrade to v1.28.{" "}
                  <Link
                    href="/mt5-setup#ea-v128-install"
                    className="underline underline-offset-2 hover:text-white"
                  >
                    See the v1.28 install steps on the MT5 Setup page
                  </Link>
                  .
                  {cycle.reportedEaVersion && (
                    <span className="ml-1 text-amber-300/70 font-mono">
                      (reported v{cycle.reportedEaVersion})
                    </span>
                  )}
                </div>
              )}
              {showAdminDiagnostics && cycle.dataQualityFlag && (
                <div className="mt-1 text-[11px] text-amber-300/80 font-mono">
                  dataQualityFlag=<code>{cycle.dataQualityFlag}</code>{" · "}
                  pnlStatus=<code>{cycle.pnlStatus}</code>{" · "}
                  reportedEaVersion=<code>{cycle.reportedEaVersion ?? "null"}</code>
                </div>
              )}
            </div>
          )}

          <div>
            <div className="font-semibold text-zinc-300">Latency stages</div>
            <table className="w-full font-mono text-[11px] mt-1">
              <thead className="text-zinc-500">
                <tr><th className="text-left">Stage</th><th className="text-left">When</th><th className="text-right">Δ prev</th></tr>
              </thead>
              <tbody>
                {stageRows.map(([label, when, prev]) => (
                  <tr key={label} className="border-t border-zinc-800/60">
                    <td className="py-0.5">{label}</td>
                    <td className="py-0.5 text-zinc-400">{fmtTs(when)}</td>
                    <td className="py-0.5 text-right text-zinc-400">{ms(prev, when)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-zinc-500 mt-1">
              Open latency: <code className="text-zinc-300">{openLatency}</code>{" · "}
              Close latency: <code className="text-zinc-300">{closeLatency}</code>{" · "}
              Total: <code className="text-zinc-300">{totalLatency}</code>
            </div>
          </div>

          {cycle.openRejectionReason && (
            <div className="text-red-400">Open rejection: <code>{cycle.openRejectionReason}</code></div>
          )}
          {cycle.closeRejectionReason && (
            <div className="text-red-400">Close rejection: <code>{cycle.closeRejectionReason}</code></div>
          )}
          {cycle.blockReason && (
            <div className="text-amber-400">Blocked: <code>{cycle.blockGate ?? "?"}</code> — {cycle.blockReason}</div>
          )}
          {cycle.manualResolveNote && (
            <div className="text-zinc-400">Manual resolve note: {cycle.manualResolveNote}</div>
          )}

          {cycle.status === "CLOSE_FAILED_MANUAL_REQUIRED" && !cycle.manualResolveNote && (
            <div className="space-y-1 border-t border-zinc-800 pt-2">
              <div className="text-red-400 font-semibold">Manual close required at broker.</div>
              <input type="text" value={resolveNote} onChange={(e) => setResolveNote(e.target.value)}
                className="w-full rounded bg-zinc-900 border border-zinc-700 px-2 py-1 text-xs"
                placeholder="Resolution note (e.g. closed manually at MT5 terminal, ticket=…)" />
              <button type="button" onClick={resolveCycle} disabled={busy !== "" || !resolveNote.trim()}
                className="rounded px-3 py-1 text-xs bg-amber-700 hover:bg-amber-600 text-white disabled:opacity-50">
                {busy === "resolve" ? "Resolving…" : "Mark resolved"}
              </button>
            </div>
          )}
        </section>
      )}

    </div>
  );
}

export default ControlledLiveTestButton;
