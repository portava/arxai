// Admin → Engine drivers.
//
// Three boot workers run continuously and write tables no route and no page
// read: the intelligence-ROI ledger (#58), champion-vs-challenger pairing
// (#15) and the meta-strategy controller (#16), which AUTOMATICALLY REDUCES a
// strategy's authority. An operator could not see that authority had been
// reduced, or why. Recovery probation (#34) has the same problem, plus an
// owner press with no button.
//
// This page binds the four endpoints that already exist. It adds no backend.
//
// HONESTY (inviolable):
//   * Each panel reports its own read failure. A missing engine-driver table
//     answers 503 with the exact remedy and that text is shown unchanged —
//     never rendered as "no data yet".
//   * The probation advance is the only widening control here and it widens by
//     exactly one stage, confirm + reason required, decided by the server.

import { useCallback, useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";

type Json = Record<string, unknown>;

async function call(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Json }> {
  const r = await fetch(path, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await r.json().catch(() => ({}))) as Json;
  return { ok: r.ok, status: r.status, body };
}

function Raw({ value, testid }: { value: unknown; testid?: string }) {
  if (value === undefined) return null;
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-snug" data-testid={testid}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** A read-only driver panel. Reports its own failure rather than deferring to
 *  a page-level error that would hide which driver is unreadable. */
function ReadPanel({ title, blurb, path, testid, pick }: {
  title: string; blurb: string; path: string; testid: string;
  pick: (body: Json) => unknown;
}) {
  const [body, setBody] = useState<Json | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setErr("");
    const r = await call(path);
    if (!r.ok) {
      setBody(null);
      setErr(`Read failed (${r.status}): ${String(r.body.error ?? "")}${r.body.detail ? ` — ${String(r.body.detail)}` : ""}`);
      return;
    }
    setBody(r.body);
  }, [path]);
  useEffect(() => { void load(); }, [load]);

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">{blurb}</p>
        {err && <p className="text-danger" data-testid={`${testid}-error`}>{err}</p>}
        {body == null && !err && <p className="text-muted-foreground">Loading…</p>}
        {body != null && <Raw value={pick(body)} testid={testid} />}
        <Button size="sm" variant="outline" onClick={() => void load()} data-testid={`${testid}-reload`}>Reload</Button>
      </CardContent>
    </Card>
  );
}

function RecoveryProbationPanel() {
  const [body, setBody] = useState<Json | null>(null);
  const [err, setErr] = useState("");
  const [reason, setReason] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [result, setResult] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr("");
    const r = await call("/api/admin/recovery-probation");
    if (!r.ok) {
      setBody(null);
      setErr(`Read failed (${r.status}): ${String(r.body.error ?? "")}${r.body.detail ? ` — ${String(r.body.detail)}` : ""}`);
      return;
    }
    setBody(r.body);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function advance() {
    setBusy(true);
    setResult(null);
    const r = await call("/api/admin/recovery-probation/advance", {
      method: "POST",
      body: JSON.stringify({ confirm: true, reason: reason.trim() }),
    });
    setResult({ httpStatus: r.status, ...r.body });
    await load();
    setBusy(false);
  }

  const armed = confirmText === "ADVANCE" && reason.trim().length > 0;

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Recovery probation (#34) — OWNER PRESS</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Automatic transitions only ever tighten. Every step back toward authority is one press, and it widens by
          exactly one stage.
        </p>
        {err && <p className="text-danger" data-testid="probation-error">{err}</p>}
        {body != null && <Raw value={{ active: body.active, probation: body.probation, ladder: body.ladder }} testid="probation-state" />}
        <label className="block space-y-1">
          <span className="text-muted-foreground">Reason (required — written to the admin audit log)</span>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="input-probation-reason" />
        </label>
        <label className="block space-y-1">
          <span className="text-muted-foreground">Type ADVANCE to arm the press</span>
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} data-testid="input-probation-confirm" />
        </label>
        <Button size="sm" disabled={busy || !armed} onClick={() => void advance()} data-testid="button-probation-advance">
          Advance one stage
        </Button>
        <Raw value={result ?? undefined} testid="probation-result" />
      </CardContent>
    </Card>
  );
}

export default function AdminEngineDriversPage() {
  return (
    <AdminDiagnosticsGate
      pageTitle="Engine drivers"
      pageDescription="Intelligence ROI, champion vs challenger, meta-strategy posture and recovery probation"
      userSafeMessage="This is an operator diagnostics panel. Your account does not require any action here."
    >
      <div className="mx-auto w-full max-w-[1100px] space-y-4" data-testid="page-admin-engine-drivers">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
            <Cpu className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Engine drivers</h1>
            <p className="text-sm text-muted-foreground">
              What the always-on evidence workers have actually recorded. These workers can reduce a strategy's
              authority on their own; this page is where that becomes visible.
            </p>
          </div>
        </div>

        <ReadPanel
          title="Intelligence ROI (#58) — advisory only"
          blurb="Per-component ROI ledger and the complexity governor's advisory verdict. Advisory: it gates nothing."
          path="/api/admin/intelligence-roi"
          testid="intelligence-roi"
          pick={(b) => ({ advisoryOnly: b.advisoryOnly, latestPass: b.latestPass, records: b.records, note: b.note })}
        />

        <ReadPanel
          title="Champion vs challenger (#15) — evidence only"
          blurb="Paired outcomes between the live champion's closed decisions and challenger strategies run in shadow."
          path="/api/admin/champion-challenger"
          testid="champion-challenger"
          pick={(b) => ({ evidenceOnly: b.evidenceOnly, summaryByStrategy: b.summaryByStrategy, pairs: b.pairs, note: b.note })}
        />

        <ReadPanel
          title="Meta-strategy posture (#16)"
          blurb="appliedState only ever moves toward LESS authority automatically. A recommendedState with more authority waits for the owner-gated promotion machinery."
          path="/api/admin/meta-strategy"
          testid="meta-strategy"
          pick={(b) => ({ states: b.states, note: b.note })}
        />

        <RecoveryProbationPanel />
      </div>
    </AdminDiagnosticsGate>
  );
}
