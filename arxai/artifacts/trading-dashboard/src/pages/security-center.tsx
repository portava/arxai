import { useEffect, useState } from "react";

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
  /** The platform live-execution switch as read for this response (state ON / OFF / UNKNOWN). */
  livePosture?: { state?: string; plainEnglish?: string } | null;
  /** What the report's appMode / liveTradingStatus labels do and do not describe. */
  liveTradingStatusScope?: string;
}

export default function SecurityCenter() {
  const [data, setData] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/security/status")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as Status;
        if (!j?.status) throw new Error("the response had no security status");
        setData(j);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  if (err) return <div className="p-6 text-red-500" data-testid="security-center-load-error">The security status could not be loaded ({err}).</div>;
  if (!data) return <div className="p-6">Loading…</div>;
  const s = data.status;
  const isHealthy = s.criticalFindings.length === 0;

  return (
    <div className="p-6 space-y-6" data-testid="security-center">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Security Center</h1>
        <div className={`px-3 py-1 rounded text-sm font-mono ${isHealthy ? "bg-green-600 text-white" : "bg-red-600 text-white"}`}>
          {isHealthy ? "SECURE" : "ATTENTION"}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border rounded p-4">
          <h2 className="font-semibold mb-2">Mode & Live Trading</h2>
          {/* appMode / liveTradingStatus are fixed labels of the security
              module, never a reading of live-trading state. The live line is
              the platform switch as the server read it for this response. */}
          <div className="text-sm" data-testid="security-center-live-posture">
            Live trading (platform switch):{" "}
            {data.livePosture?.plainEnglish
              ? data.livePosture.plainEnglish
              : "not reported by this security report. Each account's status is on its Trading Permission card."}
          </div>
          <div className="text-xs text-gray-500 mt-2" data-testid="security-center-mode-labels">
            Security module labels: appMode <span className="font-mono">{s.appMode}</span>, liveTradingStatus{" "}
            <span className="font-mono">{s.liveTradingStatus}</span>. These are fixed labels of this security module, not whether
            live trading is on. This page cannot arm or change live trading.
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
        {s.criticalFindings.length === 0 ? <div className="text-sm text-green-600">None.</div> : (
          <ul className="text-sm list-disc ml-6">{s.criticalFindings.map((c) => <li key={c}>{c}</li>)}</ul>
        )}
      </div>
      <div className="border rounded p-4">
        <h2 className="font-semibold mb-2">Warnings ({s.warnings.length})</h2>
        {s.warnings.length === 0 ? <div className="text-sm text-gray-500">None.</div> : (
          <ul className="text-sm list-disc ml-6">{s.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        )}
      </div>
      <div className="border rounded p-4">
        <h2 className="font-semibold mb-2">Recommended Actions</h2>
        {s.recommendedActions.length === 0 ? <div className="text-sm text-gray-500">No actions.</div> : (
          <ul className="text-sm list-disc ml-6">{s.recommendedActions.map((r) => <li key={r}>{r}</li>)}</ul>
        )}
      </div>
      <div className="text-xs text-gray-500">Status ID: <span className="font-mono">{s.security_status_id}</span></div>
    </div>
  );
}
