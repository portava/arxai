import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GitMerge, Lock, AlertTriangle } from "lucide-react";

type Recon = {
  brokerConnected: boolean;
  // null = never read. NOT "zero".
  brokerOrders: number | null;
  brokerPositions: number | null;
  mismatches: number | null;
  comparisonPerformed: boolean;
  comparisonUnavailableReason: string;
  localOrders: number;
  localPositions: number;
  localLiveIntents: number;
  localSourceNote: string;
  syncStatus: string;
  notice: string;
};

type PageState =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string }
  | { kind: "ok"; recon: Recon };

// The previous normaliser coerced ANY response — including a 403 error body —
// into all-zeros, so a non-admin saw "Mismatches: 0" instead of an access
// message, and a failed read was indistinguishable from a clean reconciliation.
// Counts that were never read stay null here and render as "—".
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function count(v: unknown): number | null {
  if (Array.isArray(v)) return v.length;
  return num(v);
}
function normaliseRecon(raw: unknown): Recon {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    brokerConnected: r["brokerConnected"] === true || r["mt5Connected"] === true,
    brokerOrders: count(r["brokerOrders"]),
    brokerPositions: count(r["brokerPositions"]),
    mismatches: count(r["mismatches"]),
    comparisonPerformed: r["comparisonPerformed"] === true,
    comparisonUnavailableReason:
      typeof r["comparisonUnavailableReason"] === "string"
        ? (r["comparisonUnavailableReason"] as string)
        : "No comparison result was reported by the server.",
    localOrders: num(r["localOrders"]) ?? 0,
    localPositions: num(r["localPositions"]) ?? 0,
    localLiveIntents: num(r["localLiveIntents"]) ?? 0,
    localSourceNote:
      typeof r["localSourceNote"] === "string" ? (r["localSourceNote"] as string) : "",
    syncStatus: typeof r["syncStatus"] === "string" ? (r["syncStatus"] as string) : "unknown",
    notice: typeof r["notice"] === "string" ? (r["notice"] as string) : "",
  };
}

export default function BrokerReconciliationPage() {
  const [state, setState] = useState<PageState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/broker-reconciliation/status", { credentials: "include" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          setState({ kind: "forbidden" });
          return;
        }
        if (!res.ok) {
          setState({ kind: "error", message: `Server returned ${res.status}.` });
          return;
        }
        setState({ kind: "ok", recon: normaliseRecon(await res.json()) });
      })
      .catch((e) => {
        if (!cancelled) setState({ kind: "error", message: String(e) });
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <GitMerge className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Broker Reconciliation</h1>
          <p className="text-sm text-muted-foreground">
            Intended to compare local OMS state against the MT5 bridge. Not implemented — see below.
          </p>
        </div>
        <Badge variant="outline">NOT IMPLEMENTED</Badge>
      </div>

      {state.kind === "loading" && <p className="text-sm text-muted-foreground">Loading…</p>}

      {state.kind === "forbidden" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Lock className="h-4 w-4" /> Admin only</CardTitle>
            <CardDescription>
              This page is restricted to admin and owner accounts. Nothing is shown here for your account —
              the numbers below are not hidden zeros, they are simply not available to you.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {state.kind === "error" && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-destructive" /> Could not read reconciliation status</CardTitle>
            <CardDescription>{state.message} No conclusion about broker agreement can be drawn from this page.</CardDescription>
          </CardHeader>
        </Card>
      )}

      {state.kind === "ok" && (
        <>
          <Card className="border-warning/40 bg-warning/5">
            <CardHeader>
              <CardTitle className="text-base">Status</CardTitle>
              <CardDescription>{state.recon.notice}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div>
                <Badge variant="outline">syncStatus={state.recon.syncStatus}</Badge>
                <Badge className="ml-2" variant="outline">brokerConnected={String(state.recon.brokerConnected)}</Badge>
                <Badge className="ml-2" variant="outline">comparisonPerformed={String(state.recon.comparisonPerformed)}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">{state.recon.comparisonUnavailableReason}</p>
            </CardContent>
          </Card>

          <div className="grid gap-3 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Local (this server process)</CardTitle>
                <CardDescription className="text-xs">{state.recon.localSourceNote}</CardDescription>
              </CardHeader>
              <CardContent className="text-sm space-y-1">
                <Row label="Orders" value={String(state.recon.localOrders)} />
                <Row label="Positions" value={String(state.recon.localPositions)} />
                <Row label="Live tester intents" value={String(state.recon.localLiveIntents)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Broker</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-1">
                {/* "—", never 0: a count that was never read is not a count of zero. */}
                <Row label="Broker orders" value={state.recon.brokerOrders == null ? "—" : String(state.recon.brokerOrders)} />
                <Row label="Broker positions" value={state.recon.brokerPositions == null ? "—" : String(state.recon.brokerPositions)} />
                <Row label="Mismatches" value={state.recon.mismatches == null ? "—" : String(state.recon.mismatches)} />
                <p className="text-xs text-muted-foreground mt-2">
                  No broker state has been read, so no mismatch count exists. A dash here means “not compared”, not “in agreement”.
                </p>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between border-b py-1"><span className="text-muted-foreground">{label}</span><span className="font-mono">{value}</span></div>;
}
