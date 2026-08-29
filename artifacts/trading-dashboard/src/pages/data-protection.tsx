import { useEffect, useState } from "react";

// RANK 78 — this page presented three fabrications as evidence.
//
//   1. "Account Masking Demo" rendered two HARDCODED literal pairs
//      (1234567890 → ****7890, sk_live_ABCDEFGHIJK → sk_****REDACTED) as if
//      they were computed output. Nothing was masked; the "after" strings were
//      typed by hand. An operator reading this page to verify redaction was
//      shown a picture of redaction working, not redaction working.
//   2. "Broker connector is hard-locked to READ_ONLY" — a static assertion, and
//      a false one on a build whose live pipeline dispatches real orders.
//   3. "Create redacted export" POSTed a hardcoded fake payload
//      (`api_key: "demo_will_be_redacted"`, `account_id: "1234567890"`) with an
//      `x-security-role: OWNER` header the client invented, and never checked
//      `r.ok`. It implied the redaction pipeline had been exercised against
//      real data when it had been fed a prop.
//
// What survives is the one thing here that was always real: the server-side
// redaction self-test (/api/security/redaction-test), whose OUTPUT now drives
// the masking card instead of the hardcoded literals. The static broker claim
// is gone. The fake-payload export button is gone; the export history it
// listed is kept, read-only, because that list is real.

interface RedactionCase { input?: string; output?: string; label?: string; [k: string]: unknown }
interface RedactionResult { cases?: RedactionCase[]; [k: string]: unknown }

export default function DataProtection() {
  const [redaction, setRedaction] = useState<RedactionResult | null>(null);
  const [redactionError, setRedactionError] = useState<string | null>(null);
  const [exports, setExports] = useState<unknown[] | null>(null);
  const [exportsError, setExportsError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/security/redaction-test", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setRedaction((await r.json()) as RedactionResult);
      } catch (e) {
        // An unreadable self-test is UNKNOWN. It must never render as a
        // reassuring "redaction is working" state — that was this page's whole
        // defect.
        setRedactionError(e instanceof Error ? e.message : "request failed");
      }
      try {
        const r = await fetch("/api/security/data-protection/exports?limit=10", { credentials: "include" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { exports?: unknown[] };
        setExports(Array.isArray(j.exports) ? j.exports : []);
      } catch (e) {
        setExportsError(e instanceof Error ? e.message : "request failed");
      }
    })();
  }, []);

  // Masking pairs come from the self-test's own cases when it reports them.
  // No hand-written "after" strings.
  const cases = Array.isArray(redaction?.cases) ? redaction!.cases! : [];

  return (
    <div className="space-y-6" data-testid="data-protection">
      <h1 className="text-2xl font-bold">Data Protection</h1>
      <p className="text-sm text-txt-secondary">
        Everything below is produced by the server&apos;s redaction self-test at request time. This
        page contains no illustrative or example values.
      </p>

      <div className="border rounded p-4">
        <h2 className="font-semibold mb-2">Redaction self-test</h2>
        {redactionError ? (
          <div className="text-sm text-warning" data-testid="redaction-unavailable">
            The redaction self-test could not be run ({redactionError}). This page is not asserting
            that redaction is working — it could not check.
          </div>
        ) : redaction ? (
          <pre className="text-xs overflow-auto">{JSON.stringify(redaction, null, 2)}</pre>
        ) : (
          <div className="text-sm text-txt-muted">Running…</div>
        )}
      </div>

      <div className="border rounded p-4">
        <h2 className="font-semibold mb-2">What the self-test actually masked</h2>
        {cases.length > 0 ? (
          <div className="space-y-1" data-testid="masking-cases">
            {cases.map((c, i) => (
              <div key={i} className="text-sm">
                <span className="font-mono">{String(c.input ?? "")}</span>
                {" → "}
                <span className="font-mono text-success">{String(c.output ?? "")}</span>
                {c.label ? <span className="text-xs text-txt-muted"> ({String(c.label)})</span> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-txt-muted" data-testid="masking-no-cases">
            The self-test did not return per-case input/output pairs, so none are shown. The card
            above is the full result. (This panel previously displayed two hardcoded example pairs
            as if they had been computed.)
          </div>
        )}
      </div>

      <div className="border rounded p-4">
        <h2 className="font-semibold mb-2">Exports (redacted)</h2>
        <p className="text-xs text-txt-muted mb-2">
          Export history recorded by the server. The button that used to sit here submitted a
          hardcoded fake payload and never checked whether the request succeeded, so it could not
          tell you anything true about the redaction pipeline; it has been removed.
        </p>
        {exportsError ? (
          <div className="text-sm text-warning" data-testid="exports-unavailable">
            Export history could not be read ({exportsError}). This is not a statement that no
            exports exist.
          </div>
        ) : exports === null ? (
          <div className="text-sm text-txt-muted">Loading…</div>
        ) : exports.length === 0 ? (
          <div className="text-sm text-txt-muted" data-testid="exports-empty">No exports recorded.</div>
        ) : (
          <div className="mt-1 text-xs space-y-1">
            {exports.map((e) => {
              const ex = e as { exportId: string; createdAt: string; status: string; redacted: boolean };
              return (
                <div key={ex.exportId} className="font-mono">
                  {ex.exportId} · {ex.status} · redacted={String(ex.redacted)} ·{" "}
                  {new Date(ex.createdAt).toLocaleString()}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
