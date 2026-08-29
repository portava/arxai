// Admin → Edge capacity (foundation gate #23).
//
// POST /api/admin/learning/edges/:id/capacity shipped with no UI, so the
// ruin/capacity-simulator verdict and the USD deployable ceiling that gate #23
// requires could only be pressed with curl — and gate #23 refuses every
// capacity-governed LIVE entry until they are recorded.
//
// HONESTY (inviolable):
//   * The simulator inputs are the operator's declared assumptions. This page
//     labels them as assumptions and never pre-fills a plausible-looking
//     number: an empty field stays empty and the press stays disabled.
//   * A pressed USD ceiling is honoured ONLY behind an ESTIMATED verdict; the
//     server decides that and its note is shown unchanged.
//   * This page writes capacity_* columns only. It cannot promote an edge.

import { useCallback, useEffect, useState } from "react";
import { Gauge } from "lucide-react";
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

/** Numeric field with no default. Returns undefined for blank so a blank field
 *  can never be sent to the simulator as a confident zero. */
function num(v: string): number | undefined {
  const t = v.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export default function AdminEdgeCapacityPage() {
  const [edges, setEdges] = useState<Json | null>(null);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);

  const [edgeId, setEdgeId] = useState("");
  const [winRate, setWinRate] = useState("");
  const [avgWinR, setAvgWinR] = useState("");
  const [avgLossR, setAvgLossR] = useState("");
  const [maxDeployedUsd, setMaxDeployedUsd] = useState("");
  const [overrideUsd, setOverrideUsd] = useState("");

  const load = useCallback(async () => {
    setErr("");
    const r = await call("/api/admin/learning/edges");
    if (!r.ok) {
      setEdges(null);
      setErr(`Edge library unavailable (${r.status}): ${String(r.body.message ?? r.body.error ?? "")}`);
      return;
    }
    setEdges(r.body);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const ready =
    num(edgeId) !== undefined &&
    num(winRate) !== undefined &&
    num(avgWinR) !== undefined &&
    num(avgLossR) !== undefined;

  async function press() {
    setBusy(true);
    setResult(null);
    const payload: Json = {
      simulator: {
        winRate01: num(winRate),
        avgWinR: num(avgWinR),
        avgLossR: num(avgLossR),
      },
    };
    const ceiling = num(maxDeployedUsd);
    if (ceiling !== undefined) payload.maxDeployedUsd = ceiling;
    const override = num(overrideUsd);
    if (override !== undefined) payload.deployCapOverrideUsd = override;

    const r = await call(`/api/admin/learning/edges/${num(edgeId)}/capacity`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setResult({ httpStatus: r.status, ...r.body });
    if (r.ok) await load();
    setBusy(false);
  }

  return (
    <AdminDiagnosticsGate
      pageTitle="Edge capacity"
      pageDescription="Ruin/capacity simulator verdict and the USD deployable ceiling (gate #23)"
      userSafeMessage="This is an operator capacity panel. Your account does not require any action here."
    >
      <div className="mx-auto w-full max-w-[1100px] space-y-4" data-testid="page-admin-edge-capacity">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
            <Gauge className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Edge capacity</h1>
            <p className="text-sm text-muted-foreground">
              Gate #23 admits nothing on an edge until a capacity verdict AND a pressed USD ceiling exist. This page
              writes only the capacity columns — it cannot promote an edge or set liveAllowed.
            </p>
          </div>
        </div>

        <Card>
          <CardHeader><CardTitle className="text-base">Edge library</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {err && <p className="text-danger" data-testid="edge-library-error">{err}</p>}
            {edges == null && !err && <p className="text-muted-foreground">Loading…</p>}
            {edges != null && <Raw value={edges.edges} testid="edge-library" />}
            <Button size="sm" variant="outline" onClick={() => void load()} data-testid="button-edges-reload">Reload</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Record a capacity estimate</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              These are <strong>your declared assumptions</strong>, not measurements ARX made. The simulator runs on
              exactly what you type; nothing is filled in for you.
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="space-y-1">
                <span className="text-muted-foreground">Edge id</span>
                <Input value={edgeId} onChange={(e) => setEdgeId(e.target.value)} inputMode="numeric" data-testid="input-capacity-edge-id" />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Assumed win rate (0–1)</span>
                <Input value={winRate} onChange={(e) => setWinRate(e.target.value)} inputMode="decimal" data-testid="input-capacity-winrate" />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Assumed average win (R)</span>
                <Input value={avgWinR} onChange={(e) => setAvgWinR(e.target.value)} inputMode="decimal" data-testid="input-capacity-avgwin" />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Assumed average loss (R, negative)</span>
                <Input value={avgLossR} onChange={(e) => setAvgLossR(e.target.value)} inputMode="decimal" data-testid="input-capacity-avgloss" />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">USD deployable ceiling (optional)</span>
                <Input value={maxDeployedUsd} onChange={(e) => setMaxDeployedUsd(e.target.value)} inputMode="decimal" data-testid="input-capacity-ceiling" />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Tighten-only override USD (optional)</span>
                <Input value={overrideUsd} onChange={(e) => setOverrideUsd(e.target.value)} inputMode="decimal" data-testid="input-capacity-override" />
              </label>
            </div>
            <Button size="sm" disabled={busy || !ready} onClick={() => void press()} data-testid="button-capacity-press">
              Run simulator and record
            </Button>
            <p className="text-xs text-muted-foreground">
              Without a pressed USD ceiling, an ESTIMATED verdict still admits nothing — an estimate alone is not
              permission.
            </p>
            <Raw value={result ?? undefined} testid="capacity-result" />
          </CardContent>
        </Card>
      </div>
    </AdminDiagnosticsGate>
  );
}
