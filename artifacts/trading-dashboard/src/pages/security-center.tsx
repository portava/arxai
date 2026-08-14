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
}

export default function SecurityCenter() {
  const [data, setData] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/security/status").then((r) => r.json()).then(setData).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div className="p-6 text-red-500">Error: {err}</div>;
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
          <div className="text-sm">App mode: <span className="font-mono">{s.appMode}</span></div>
          <div className="text-sm">Live trading: <span className="font-mono text-red-600">{s.liveTradingStatus}</span></div>
          <div className="text-xs text-gray-500 mt-2">No live trading controls are exposed in the UI.</div>
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
