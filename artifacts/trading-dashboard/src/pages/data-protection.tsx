import { useEffect, useState } from "react";

export default function DataProtection() {
  const [redaction, setRedaction] = useState<unknown>(null);
  const [exports, setExports] = useState<unknown[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/security/redaction-test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then((r) => r.json()).then(setRedaction);
    fetch("/api/security/data-protection/exports?limit=10").then((r) => r.json()).then((j) => setExports(j.exports));
  }, []);

  const runExport = async () => {
    setBusy(true);
    const r = await fetch("/api/security/export-data", { method: "POST", headers: { "content-type": "application/json", "x-security-role": "OWNER" },
      body: JSON.stringify({ source: "data-protection-panel", api_key: "demo_will_be_redacted", account_id: "1234567890" }) });
    await r.json();
    const list = await fetch("/api/security/data-protection/exports?limit=10").then((x) => x.json());
    setExports(list.exports);
    setBusy(false);
  };

  return (
    <div className="space-y-6" data-testid="data-protection">
      <h1 className="text-2xl font-bold">Data Protection</h1>

      <div className="border rounded p-4">
        <h2 className="font-semibold mb-2">Redaction Self-Test</h2>
        <pre className="text-xs overflow-auto">{redaction ? JSON.stringify(redaction, null, 2) : "Loading…"}</pre>
      </div>

      <div className="border rounded p-4">
        <h2 className="font-semibold mb-2">Account Masking Demo</h2>
        <div className="text-sm">Account ID <span className="font-mono">1234567890</span> → masked as <span className="font-mono text-success">****7890</span></div>
        <div className="text-sm">Token <span className="font-mono">sk_live_ABCDEFGHIJK</span> → <span className="font-mono text-success">sk_****REDACTED</span></div>
      </div>

      <div className="border rounded p-4">
        <h2 className="font-semibold mb-2">Demo Data Separation</h2>
        <div className="text-sm">Replay & demo trades are isolated from live_positions table. Broker connector is hard-locked to READ_ONLY.</div>
      </div>

      <div className="border rounded p-4">
        <h2 className="font-semibold mb-2">Exports (redacted)</h2>
        <button onClick={runExport} disabled={busy} className="px-3 py-1 bg-primary text-white rounded text-sm disabled:opacity-50" data-testid="run-export">
          {busy ? "Working…" : "Create redacted export"}
        </button>
        <div className="mt-3 text-xs space-y-1">
          {exports.map((e) => {
            const ex = e as { exportId: string; createdAt: string; status: string; redacted: boolean };
            return <div key={ex.exportId} className="font-mono">{ex.exportId} · {ex.status} · redacted={String(ex.redacted)} · {new Date(ex.createdAt).toLocaleString()}</div>;
          })}
        </div>
      </div>
    </div>
  );
}
