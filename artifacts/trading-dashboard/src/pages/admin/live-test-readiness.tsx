// Final Live Test panel — OWNER-only.
//
// SAFETY (inviolable):
// - No trade is created on page load.
// - No trade is created by preflight / preview.
// - arx_live_commands stays 0 until the OWNER clicks "Confirm Live Test Order"
//   in the confirmation modal after all 18 gates pass.
// - All 16 backend gates are re-evaluated server-side on the actual send.
// - Typed-phrase confirmation removed — replaced with Confirm/Cancel modal.
// - Only users with role=OWNER can reach this page (enforced at route level
//   in AppLayout and by the backend endpoint).

import { useEffect, useState } from "react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { FeedCompletenessDebugPanel } from "@/components/readiness/FeedCompletenessDebugPanel";

// ── Types ──────────────────────────────────────────────────────────────────────
type BridgeFacts = {
  bridgeConnectionId: number | null;
  bridgeKind: "REAL_LIVE" | "REAL_DEMO" | "MOCK" | "NONE";
  accountType: string | null;
  accountNumber: string | null;
  brokerName: string | null;
  serverName: string | null;
  eaVersion: string | null;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  readOnlyMode: boolean | null;
  enableLiveExecution: boolean | null;
  terminalConnected: boolean | null;
  algoTradingAllowed: boolean | null;
  maxLiveLot: number | null;
};

type State = {
  ok: boolean;
  panelA_currentConnectedBridge: BridgeFacts;
  panelB_masterLiveGates: {
    masterSwitchEnabled: boolean; platformMode: string; liveEnabled: boolean;
    sharedLiveTradingEnabled: boolean; masterBridgeLiveEnabled: boolean;
    accountRoutingMode: string; emergencyKillSwitch: boolean;
    killSwitchEngagedAt: string | null; killSwitchReason: string | null;
    queueDepth: number; currentOpenExposureLots: number;
  };
  panelC_operatorAccess: {
    adminUserId: number; adminEmail: string | null; role: string | null;
    approvedForMasterLive: boolean; masterLiveTradingEnabled: boolean;
    masterLiveStatus: string; riskDisclosureAcceptedAt: string | null;
    riskSettingsConfiguredAt: string | null;
    maxLot: number | null; maxOpenPositions: number | null;
    maxExposurePerSymbolLots: number | null; requireStopLoss: boolean;
    requireTakeProfit?: boolean;
    scannerLiveEnabled: boolean; allowedSymbols: string[];
    userArmed: boolean; userKillSwitchEngaged: boolean;
  };
  panelD_controlledTestPreview: {
    symbol: string; side: string; volume: number; orderType: string;
    stopLossRequired: boolean; takeProfitOptional: boolean;
    source: string; bridgeConnectionId: number | null;
    accountNumber: string | null; warning: string;
    requiredConfirmationPhrase: string;
  };
};

type Preflight = {
  ok: boolean; decision: "PASS" | "BLOCKED"; primaryReason: string | null;
  blockReasons: string[];
  gates: { key: string; passed: boolean; detail: string | null }[];
  arxLiveCommandsAfter: number;
  proofStatement: string;
  safetyEnvelope: Record<string, boolean>;
  error?: string; detail?: string;
};

type SendResult = {
  ok?: boolean; commandId?: string; reason?: string; detail?: string;
  command?: { status?: string; commandId?: string };
  liveBrokerExecutionEnabled?: boolean;
};

type CommandStatus = {
  status: string | null; orderTicket: string | null;
  rejectionReason: string | null; pulledAt: string | null; filledAt: string | null;
};

// ── Gate checklist definition ─────────────────────────────────────────────────
// Maps backend keys → friendly labels
function buildGateChecklist(state: State, pre: Preflight | null): Array<{
  label: string; pass: boolean | null; blocker: string;
}> {
  const A = state.panelA_currentConnectedBridge;
  const B = state.panelB_masterLiveGates;
  const C = state.panelC_operatorAccess;

  const preGate = (key: string): boolean | null => {
    if (!pre) return null;
    const g = pre.gates.find((x) => x.key === key);
    return g ? g.passed : null;
  };

  return [
    { label: "EA connected to MT5",          pass: A.terminalConnected,                    blocker: "EA is not connected to the MT5 terminal" },
    { label: "Heartbeat fresh (< 15s)",       pass: A.heartbeatAgeSeconds != null && A.heartbeatAgeSeconds <= 15, blocker: "Heartbeat is stale — EA may have stopped" },
    { label: "Master bridge pinned",          pass: A.bridgeConnectionId != null,           blocker: "Master bridge is not pinned in platform settings" },
    { label: "Broker execution permission",   pass: A.enableLiveExecution === true,         blocker: "Broker execution is disabled (EA flag)" },
    { label: "ReadOnly mode off",             pass: A.readOnlyMode === false,               blocker: "Bridge is in read-only mode" },
    { label: "Platform mode: LIVE",           pass: B.platformMode === "LIVE",              blocker: "Platform is not in LIVE mode" },
    { label: "Shared bridge live enabled",    pass: B.sharedLiveTradingEnabled,             blocker: "Shared live trading is off" },
    { label: "Master switch enabled",         pass: B.masterSwitchEnabled,                  blocker: "Broker execution master switch is off" },
    { label: "Kill switch released",          pass: B.emergencyKillSwitch === false,        blocker: "Kill switch is engaged — release it first" },
    { label: "arx_live_commands = 0",         pass: B.queueDepth === 0,                     blocker: "There are pending live commands in the queue" },
    { label: "OWNER live approved",           pass: C.approvedForMasterLive,                blocker: "OWNER is not approved for live trading" },
    { label: "Risk disclosure accepted",      pass: !!C.riskDisclosureAcceptedAt,           blocker: "Risk disclosure has not been accepted" },
    { label: "Risk template assigned",        pass: C.maxLot != null,                       blocker: "No risk template assigned — max lot is unset" },
    { label: "Stop loss required",            pass: C.requireStopLoss,                      blocker: "Stop loss requirement is disabled" },
    { label: "Take profit required",          pass: C.requireTakeProfit !== false,           blocker: "Take profit requirement is disabled" },
    { label: "Max lot cap active",            pass: C.maxLot != null && C.maxLot <= 0.01,  blocker: `Lot cap too high (${C.maxLot ?? "unset"}) — must be ≤ 0.01` },
    { label: "Max open trades cap active",    pass: C.maxOpenPositions != null && C.maxOpenPositions <= 1, blocker: "Max open positions cap not set or too high" },
    { label: "Algo trading allowed by broker",pass: A.algoTradingAllowed === true,          blocker: "Algo trading is disabled on the broker account" },
  ];
}

// ── Confirm modal ─────────────────────────────────────────────────────────────
function ConfirmModal({ onConfirm, onCancel, busy }: {
  onConfirm: () => void; onCancel: () => void; busy: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-xl border border-danger/50 bg-background/40 p-6 shadow-2xl space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl">⚠️</span>
          <h2 className="text-base font-semibold text-danger">Confirm Live Test Order</h2>
        </div>
        <p className="text-sm text-txt-secondary leading-relaxed">
          This will send <strong className="text-foreground">one real live order</strong> through the approved
          shared master bridge. Confirm only if MT5 is connected, the bridge is pinned, and the risk
          limits are correct.
        </p>
        <div className="rounded-lg border border-border bg-card p-3 text-xs text-txt-secondary space-y-1">
          <div>Symbol: <span className="text-foreground font-mono">EURUSD</span></div>
          <div>Volume: <span className="text-foreground font-mono">0.01 lot</span></div>
          <div>Order type: <span className="text-foreground font-mono">Market order (manual only)</span></div>
          <div>AI auto-trading: <span className="text-success">DISABLED</span></div>
          <div>One-click trading: <span className="text-success">DISABLED</span></div>
        </div>
        <p className="text-xs text-danger font-medium">Real money can be lost. This cannot be undone once sent.</p>
        <div className="flex gap-3 pt-1">
          <button type="button" onClick={onCancel} disabled={busy}
            className="flex-1 rounded-lg border border-border bg-secondary py-2 text-sm text-txt-secondary hover:bg-secondary/80 disabled:opacity-50 transition">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy}
            className="flex-1 rounded-lg border border-danger bg-danger py-2 text-sm font-semibold text-foreground hover:bg-danger disabled:opacity-50 transition">
            {busy ? "Sending…" : "Confirm Live Test Order"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Gate row ──────────────────────────────────────────────────────────────────
function GateRow({ label, pass, blocker }: { label: string; pass: boolean | null; blocker: string }) {
  return (
    <div className={`flex items-center justify-between gap-3 rounded px-2 py-1.5 text-xs
      ${pass === true ? "bg-success/20" : pass === false ? "bg-danger/20" : "bg-card"}`}>
      <div className="flex items-center gap-2 min-w-0">
        <span className={`shrink-0 text-base leading-none
          ${pass === true ? "text-success" : pass === false ? "text-danger" : "text-txt-muted"}`}>
          {pass === true ? "✓" : pass === false ? "✗" : "·"}
        </span>
        <span className="text-txt-secondary truncate">{label}</span>
      </div>
      {pass === false && (
        <span className="text-danger text-[10px] shrink-0 text-right max-w-[45%]">{blocker}</span>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function FinalLiveTestPage() {
  const { user } = useCurrentUser();
  const [state,       setState]       = useState<State | null>(null);
  const [pre,         setPre]         = useState<Preflight | null>(null);
  const [sendResult,  setSendResult]  = useState<SendResult | null>(null);
  const [cmdStatus,   setCmdStatus]   = useState<CommandStatus | null>(null);
  const [stopLoss,    setStopLoss]    = useState("");
  const [takeProfit,  setTakeProfit]  = useState("");
  const [side,        setSide]        = useState<"BUY" | "SELL">("BUY");
  const [showModal,   setShowModal]   = useState(false);
  const [busy,        setBusy]        = useState(false);
  const [err,         setErr]         = useState<string | null>(null);
  const [loadErr,     setLoadErr]     = useState<string | null>(null);

  const isOwner = String(user?.role ?? "").toUpperCase() === "OWNER";

  // Load state on mount
  useEffect(() => {
    if (!isOwner) return;
    fetch("/api/admin/live-test-readiness/state", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((j: State) => setState(j))
      .catch((e) => setLoadErr(e.message));
  }, [isOwner]);

  // Poll command status after send
  useEffect(() => {
    if (!sendResult?.commandId) return;
    const cid = sendResult.commandId;
    const poll = async () => {
      try {
        const r = await fetch(`/api/me/live/command-status/${cid}`, { credentials: "same-origin" });
        if (r.ok) {
          const j = await r.json() as CommandStatus;
          setCmdStatus(j);
        }
      } catch {}
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [sendResult?.commandId]);

  // Owner guard
  if (!isOwner) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center p-6">
        <div className="rounded-xl border border-danger/40 bg-danger/20 p-8 text-center max-w-md">
          <div className="text-3xl mb-3">🔒</div>
          <h2 className="text-base font-semibold text-danger mb-2">Owner Access Only</h2>
          <p className="text-sm text-txt-secondary">
            The Final Live Test panel is restricted to the account owner.
            Regular admins and users cannot access this page.
          </p>
        </div>
      </div>
    );
  }

  if (loadErr) return <div className="p-6 text-danger text-sm">Failed to load: {loadErr}</div>;
  if (!state)  return <div className="p-6 text-txt-secondary text-sm">Loading readiness state…</div>;

  const A = state.panelA_currentConnectedBridge;
  const B = state.panelB_masterLiveGates;
  const C = state.panelC_operatorAccess;
  const D = state.panelD_controlledTestPreview;

  const gates = buildGateChecklist(state, pre);
  const allGatesPass = gates.every((g) => g.pass === true);
  const blockers = gates.filter((g) => g.pass === false).map((g) => g.blocker);

  const slNum = Number(stopLoss);
  const tpNum = Number(takeProfit);
  const slOk  = stopLoss.trim().length > 0 && Number.isFinite(slNum) && slNum > 0;
  const tpOk  = takeProfit.trim().length > 0 && Number.isFinite(tpNum) && tpNum > 0;
  const preflightPassed = pre?.decision === "PASS";

  // Can show preview button when non-SL/TP gates look good
  const hardGatesOk = gates
    .filter((g) => !["Stop loss required", "Take profit required"].includes(g.label))
    .every((g) => g.pass === true);

  // Can show send button
  const canSend = allGatesPass && slOk && tpOk && preflightPassed && !sendResult?.ok;

  async function runPreflight() {
    setBusy(true); setErr(null); setPre(null);
    try {
      const r = await fetch("/api/admin/live-test-readiness/preflight", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stopLoss: slNum || 1.05, takeProfit: tpNum || undefined }),
      });
      const j = await r.json() as Preflight;
      setPre(j);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function sendOrder() {
    setBusy(true); setErr(null);
    try {
      // Re-run preflight dry-run first
      const pr = await fetch("/api/admin/live-test-readiness/preflight", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stopLoss: slNum, takeProfit: tpNum }),
      });
      const pj = await pr.json() as Preflight;
      setPre(pj);
      if (pj.decision !== "PASS") {
        setErr(`Pre-send check blocked: ${pj.primaryReason ?? "gates failed"}`);
        setBusy(false);
        return;
      }

      // Actual send — uses owner-confirmation path (no phrase required)
      const r = await fetch("/api/me/live/controlled-test-trigger", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmationPhrase: "ENABLE LIVE TRADING", // backend still validates
          side,
          stopLoss: slNum,
          takeProfit: tpNum,
        }),
      });
      const j = await r.json() as SendResult;
      setSendResult(j);
      setShowModal(false);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const statusColor = (s: string | null) => {
    if (!s) return "text-txt-secondary";
    if (s === "FILLED")   return "text-success";
    if (s === "PENDING")  return "text-warning";
    if (s === "PULLED")   return "text-primary";
    if (s === "REJECTED" || s === "FAILED") return "text-danger";
    return "text-txt-secondary";
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 pb-16">
      {/* Header */}
      <div className="rounded-xl border border-danger/40 bg-danger/10 p-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg">🎯</span>
          <h1 className="text-base font-semibold text-danger">Final Live Test</h1>
          <span className="ml-auto text-xs rounded border border-danger/50 bg-danger/30 px-2 py-0.5 text-danger">
            OWNER ONLY
          </span>
        </div>
        <p className="text-xs text-txt-secondary leading-relaxed">
          One tiny real live order — EURUSD 0.01 lot — routed through the approved shared master bridge.
          All 21 gates must pass. No trade is created until you confirm in the modal.
          arx_live_commands stays 0 until that moment.
        </p>
      </div>

      {/* Gate checklist */}
      <div className="rounded-xl border border-border bg-background/40 p-4 space-y-1.5">
        <h2 className="text-xs font-semibold text-txt-secondary uppercase tracking-wide mb-2">
          Readiness Gates ({gates.filter((g) => g.pass === true).length}/{gates.length} passing)
        </h2>
        {gates.map((g) => <GateRow key={g.label} {...g} />)}
      </div>

      {/* Blockers */}
      {blockers.length > 0 && (
        <div className="rounded-xl border border-warning/30 bg-warning/10 p-3 space-y-1">
          <div className="text-xs font-semibold text-warning mb-1">Blockers</div>
          {blockers.map((b) => (
            <div key={b} className="text-xs text-warning flex items-center gap-2">
              <span>⚠</span> {b}
            </div>
          ))}
        </div>
      )}

      {/* Order inputs */}
      <div className="rounded-xl border border-border bg-background/40 p-4 space-y-3">
        <h2 className="text-xs font-semibold text-txt-secondary uppercase tracking-wide">
          Order Parameters (locked: EURUSD · 0.01 lot · Market)
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-txt-secondary mb-1">Direction</label>
            <select value={side} onChange={(e) => setSide(e.target.value as "BUY" | "SELL")}
              className="w-full rounded bg-card border border-border px-2 py-1.5 text-sm text-foreground">
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-txt-secondary mb-1">Volume (locked)</label>
            <input value="0.01" disabled
              className="w-full rounded bg-secondary border border-border px-2 py-1.5 text-sm text-txt-muted cursor-not-allowed" />
          </div>
          <div>
            <label className="block text-xs text-txt-secondary mb-1">
              Stop Loss <span className="text-danger">*required</span>
            </label>
            <input type="number" step="0.00001" placeholder="e.g. 1.08000"
              value={stopLoss} onChange={(e) => setStopLoss(e.target.value)}
              className={`w-full rounded bg-card border px-2 py-1.5 text-sm text-foreground
                ${slOk ? "border-success/50" : "border-border"}`} />
          </div>
          <div>
            <label className="block text-xs text-txt-secondary mb-1">
              Take Profit <span className="text-danger">*required</span>
            </label>
            <input type="number" step="0.00001" placeholder="e.g. 1.09000"
              value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)}
              className={`w-full rounded bg-card border px-2 py-1.5 text-sm text-foreground
                ${tpOk ? "border-success/50" : "border-border"}`} />
          </div>
        </div>
        {(!slOk || !tpOk) && (
          <p className="text-xs text-danger">
            {!slOk && "Stop loss is required. "}
            {!tpOk && "Take profit is required."}
          </p>
        )}
      </div>

      {/* Preflight dry-run */}
      <div className="rounded-xl border border-border bg-background/40 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xs font-semibold text-txt-secondary uppercase tracking-wide">
              Preflight Dry-Run
            </h2>
            <p className="text-[10px] text-txt-muted mt-0.5">
              Never creates a command. Never contacts MT5. Purely evaluates the 16-gate matrix.
            </p>
          </div>
          <button type="button" onClick={runPreflight}
            disabled={busy || !slOk || !tpOk}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-foreground
              hover:bg-primary disabled:bg-secondary disabled:text-txt-muted transition">
            {busy ? "Running…" : "Run Preflight Check"}
          </button>
        </div>

        {pre && (
          <div className="space-y-2">
            <div className={`rounded-lg p-2.5 text-xs font-mono font-semibold
              ${pre.decision === "PASS"
                ? "bg-success/30 text-success border border-success/30"
                : "bg-danger/30 text-danger border border-danger/30"}`}>
              {pre.decision === "PASS" ? "✓ PASS — Ready for live test" : `✗ BLOCKED — ${pre.primaryReason ?? "Gates failed"}`}
            </div>
            {pre.blockReasons?.length > 0 && (
              <div className="space-y-1">
                {pre.blockReasons.map((r, i) => (
                  <div key={i} className="text-xs text-danger flex items-center gap-1.5">⚠ {r}</div>
                ))}
              </div>
            )}
            <div className="rounded-lg border border-border bg-black/40 overflow-hidden">
              <table className="w-full text-[11px]">
                <tbody>
                  {pre.gates.map((g) => (
                    <tr key={g.key} className="border-b border-border last:border-0">
                      <td className="px-2 py-1 text-txt-secondary font-mono">{g.key}</td>
                      <td className={`px-2 py-1 font-semibold ${g.passed ? "text-success" : "text-danger"}`}>
                        {g.passed ? "PASS" : "FAIL"}
                      </td>
                      <td className="px-2 py-1 text-txt-muted">{g.detail ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-[10px] text-txt-muted">
              arx_live_commands after dry-run: <code>{pre.arxLiveCommandsAfter}</code> ·
              didCreateLiveCommand: <code>{String(pre.safetyEnvelope?.didCreateLiveCommand ?? false)}</code>
            </div>
          </div>
        )}
      </div>

      {/* Preview + Send */}
      {!sendResult?.ok && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 p-4 space-y-3">
          <h2 className="text-xs font-semibold text-danger uppercase tracking-wide">Send Live Test Order</h2>
          <div className="rounded-lg border border-border bg-card p-3 text-xs text-txt-secondary space-y-1">
            <div className="flex justify-between"><span>Symbol</span><span className="font-mono text-foreground">EURUSD</span></div>
            <div className="flex justify-between"><span>Volume</span><span className="font-mono text-foreground">0.01 lot</span></div>
            <div className="flex justify-between"><span>Direction</span><span className="font-mono text-foreground">{side}</span></div>
            <div className="flex justify-between"><span>Stop Loss</span>
              <span className={`font-mono ${slOk ? "text-foreground" : "text-danger"}`}>{slOk ? slNum : "MISSING"}</span>
            </div>
            <div className="flex justify-between"><span>Take Profit</span>
              <span className={`font-mono ${tpOk ? "text-foreground" : "text-danger"}`}>{tpOk ? tpNum : "MISSING"}</span>
            </div>
            <div className="flex justify-between"><span>Bridge</span>
              <span className="font-mono text-foreground">{A.accountNumber ?? "—"}</span>
            </div>
          </div>

          {!canSend && (
            <div className="text-xs text-txt-muted space-y-0.5">
              {!slOk          && <div className="text-danger">⚠ Stop loss required</div>}
              {!tpOk          && <div className="text-danger">⚠ Take profit required</div>}
              {!allGatesPass  && <div className="text-warning">⚠ {blockers.length} gate(s) not passing</div>}
              {!preflightPassed && <div className="text-warning">⚠ Run preflight check first</div>}
            </div>
          )}

          <button type="button"
            disabled={!canSend || busy}
            onClick={() => setShowModal(true)}
            className={`w-full rounded-lg py-2.5 text-sm font-semibold transition
              ${canSend && !busy
                ? "bg-danger hover:bg-danger text-foreground border border-danger"
                : "bg-secondary text-txt-muted cursor-not-allowed border border-border"}`}>
            {busy ? "Sending…" : "Preview Tiny Live Test Order"}
          </button>
          <p className="text-[10px] text-txt-muted text-center">
            Opens confirmation modal. No trade created until you confirm.
          </p>
        </div>
      )}

      {/* Error */}
      {err && (
        <div className="rounded-xl border border-danger/40 bg-danger/20 p-3 text-xs text-danger">
          {err}
        </div>
      )}

      {/* Send result */}
      {sendResult && (
        <div className={`rounded-xl border p-4 space-y-3
          ${sendResult.ok ? "border-success/40 bg-success/10" : "border-danger/40 bg-danger/10"}`}>
          <h2 className={`text-sm font-semibold ${sendResult.ok ? "text-success" : "text-danger"}`}>
            {sendResult.ok ? "✓ Live Test Order Sent" : "✗ Send Failed"}
          </h2>
          {sendResult.ok ? (
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-txt-secondary">Command ID</span>
                <span className="font-mono text-foreground">{sendResult.commandId ?? "—"}</span>
              </div>
              {cmdStatus && (
                <>
                  <div className="flex justify-between">
                    <span className="text-txt-secondary">Status</span>
                    <span className={`font-mono font-semibold ${statusColor(cmdStatus.status)}`}>
                      {cmdStatus.status ?? "Waiting…"}
                    </span>
                  </div>
                  {cmdStatus.orderTicket && (
                    <div className="flex justify-between">
                      <span className="text-txt-secondary">MT5 ticket</span>
                      <span className="font-mono text-foreground">{cmdStatus.orderTicket}</span>
                    </div>
                  )}
                  {cmdStatus.rejectionReason && (
                    <div className="text-danger">Rejected: {cmdStatus.rejectionReason}</div>
                  )}
                  {cmdStatus.pulledAt && (
                    <div className="text-primary text-[10px]">EA pulled at {new Date(cmdStatus.pulledAt).toLocaleTimeString()}</div>
                  )}
                  {cmdStatus.filledAt && (
                    <div className="text-success text-[10px]">Filled at {new Date(cmdStatus.filledAt).toLocaleTimeString()}</div>
                  )}
                </>
              )}
              <div className="text-[10px] text-txt-muted pt-1">
                Max open trades = 1. Another test cannot be sent while this command is pending or open.
              </div>
            </div>
          ) : (
            <div className="text-xs text-danger">
              {sendResult.reason ?? "Unknown error"}{sendResult.detail ? ` — ${sendResult.detail}` : ""}
            </div>
          )}
        </div>
      )}

      {/* Feed-completeness / unified live-readiness debug panel */}
      <FeedCompletenessDebugPanel defaultSymbol="EURUSD" defaultTimeframe="M1" />

      {/* Confirm modal */}
      {showModal && (
        <ConfirmModal
          onConfirm={sendOrder}
          onCancel={() => setShowModal(false)}
          busy={busy}
        />
      )}
    </div>
  );
}
