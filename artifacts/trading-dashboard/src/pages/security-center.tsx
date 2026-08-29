import { useEffect, useState } from "react";
import { useTradingMode } from "@/hooks/useTradingMode";

interface Status {
  status: {
    security_status_id: string;
    appMode: string;
    liveTradingStatus: string;
    authStatus: Record<string, boolean>;
    permissionStatus: Record<string, unknown>;
    dataProtectionStatus: Record<string, unknown>;
    securityFlags: string[];
    warnings: string[];
    criticalFindings: string[];
    recommendedActions: string[];
  };
  settings: Record<string, unknown>;
}

export default function SecurityCenter() {
  const mode = useTradingMode();
  const [data, setData] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/security/status").then((r) => r.json()).then(setData).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div className="text-danger">Error: {err}</div>;
  if (!data) return <div>Loading…</div>;
  const s = data.status;
  const isHealthy = s.criticalFindings.length === 0;

  return (
    <div className="space-y-6" data-testid="security-center">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Security Center</h1>
        <div className={`px-3 py-1 rounded text-sm font-mono ${isHealthy ? "bg-success text-white" : "bg-danger text-white"}`}>
          {isHealthy ? "SECURE" : "ATTENTION"}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border rounded p-4">
          <h2 className="font-semibold mb-2">Mode & Live Trading</h2>
          {/* RANK 78 — this card asserted "No live trading controls are exposed
              in the UI." App.tsx routes /live-trading-control, /live-trading,
              /live-manual, /live-trades, /admin/trading-control,
              /admin/master-bridge, /admin/live-shared/activation and
              /admin/one-click-controls, eight of which the Admin Hub's Live
              Controls tab links directly. An operator opening the Security
              Center to assess posture was told the opposite of what the app one
              click away offers.

              REVIEW PASS — the first fix ADDED the honest block below but left
              the two fabricated headline rows in place:

                App mode:     {s.appMode}            -> always "PAPER_ONLY"
                Live trading: {s.liveTradingStatus}  -> always "DISABLED"

              Both come from api-server/src/lib/security/service.ts, which
              returns those two strings as literals with no read behind them, so
              the operator saw a red "DISABLED" as the headline and the true
              per-account mode underneath it, contradicting each other. The two
              rows are GONE. This page does not own service.ts, so it cannot
              make those fields true; it can only stop presenting them as fact.
              What it renders instead is the mode this account is ACTUALLY in,
              read from the same source every other page uses
              (/api/me/account-mode via useTradingMode). */}
          <div className="text-xs" data-testid="security-center-live-posture">
            {mode.envelope ? (
              <>
                <div className="text-txt-secondary">Your account: <span className="font-mono">{mode.cleanModeLabel}</span></div>
                <div className="text-txt-muted">{mode.cleanUserMessage}</div>
                {mode.cleanBlockedReason && <div className="text-warning">{mode.cleanBlockedReason}</div>}
              </>
            ) : (
              <div className="text-warning">
                Your live-trading posture could not be read. Treat it as unknown — this page is not
                asserting that live trading is off.
              </div>
            )}
            <div className="text-txt-muted mt-1">
              Live execution is default-deny, not absent: operator arming, per-user approval, your own
              arming record and all 23 Phase B gates must pass for any order to dispatch.
            </div>
            <div className="text-txt-muted mt-1 italic">
              This card no longer shows the <span className="font-mono">appMode</span> /{" "}
              <span className="font-mono">liveTradingStatus</span> fields of{" "}
              <span className="font-mono">/api/security/status</span>. That endpoint returns them as
              fixed strings (<span className="font-mono">PAPER_ONLY</span> /{" "}
              <span className="font-mono">DISABLED</span>) with no read behind them, so they describe
              no account and contradict the posture above.
            </div>
          </div>
        </div>
        <div className="border rounded p-4">
          <h2 className="font-semibold mb-2">Auth Status</h2>
          <pre className="text-xs">{JSON.stringify(s.authStatus, null, 2)}</pre>
        </div>
        <div className="border rounded p-4">
          <h2 className="font-semibold mb-2">Permission Status</h2>
          <pre className="text-xs">{JSON.stringify(s.permissionStatus, null, 2)}</pre>
        </div>
        <div className="border rounded p-4">
          <h2 className="font-semibold mb-2">Data Protection</h2>
          <pre className="text-xs">{JSON.stringify(s.dataProtectionStatus, null, 2)}</pre>
        </div>
      </div>
      <div className="border rounded p-4">
        <h2 className="font-semibold mb-2">Critical Findings ({s.criticalFindings.length})</h2>
        {s.criticalFindings.length === 0 ? <div className="text-sm text-success">None.</div> : (
          <ul className="text-sm list-disc ml-6">{s.criticalFindings.map((c) => <li key={c}>{c}</li>)}</ul>
        )}
      </div>
      <div className="border rounded p-4">
        <h2 className="font-semibold mb-2">Warnings ({s.warnings.length})</h2>
        {s.warnings.length === 0 ? <div className="text-sm text-txt-muted">None.</div> : (
          <ul className="text-sm list-disc ml-6">{s.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        )}
      </div>
      <div className="border rounded p-4">
        <h2 className="font-semibold mb-2">Recommended Actions</h2>
        {s.recommendedActions.length === 0 ? <div className="text-sm text-txt-muted">No actions.</div> : (
          <ul className="text-sm list-disc ml-6">{s.recommendedActions.map((r) => <li key={r}>{r}</li>)}</ul>
        )}
      </div>
      <div className="text-xs text-txt-muted">Status ID: <span className="font-mono">{s.security_status_id}</span></div>
    </div>
  );
}
