// User-facing — Live Readiness Status card
//
// Consumes GET /api/me/readiness/summary and renders a single, clear
// card that explains the live trading state in plain English:
//   - Real broker execution: locked / available
//   - Demo trading: available
//   - Primary reason (plain English; raw codes hidden by default)
//   - Next step
//
// Raw codes are placed behind an admin-only collapsible (we still show
// them so debug builds have access, but the headline copy is human).
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, ShieldCheck, FlaskConical, Info } from "lucide-react";
import { useAssistantName } from "@/lib/assistant-name";

type Summary = {
  ok: boolean;
  platformBridgeMode: string;
  plainEnglish: {
    headline: string;
    demoAvailable: boolean;
    liveBrokerExecutionPossible: boolean;
    primaryReason: string;
    nextStep: string;
  };
  userStatus: string;
  masterLiveTradingEnabled: boolean;
  scannerLiveEnabled: boolean;
  details: {
    platformHeadline: string;
    platformNextStep: string;
    userBlockReasons: string[];
  };
};

export function LiveReadinessStatusCard({ showRawCodes = false }: { showRawCodes?: boolean }) {
  const { name } = useAssistantName();
  const [data, setData] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/me/readiness/summary", { credentials: "include" });
        const j = await r.json();
        if (cancelled) return;
        if (j.ok) setData(j);
        else setErr(j.error ?? "load failed");
      } catch {
        if (!cancelled) setErr("network error");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (err) {
    return (
      <Card data-testid="card-live-readiness-status">
        <CardHeader><CardTitle className="text-base">Live readiness</CardTitle></CardHeader>
        <CardContent className="text-xs text-danger">Could not load readiness: {err}</CardContent>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card data-testid="card-live-readiness-status">
        <CardHeader><CardTitle className="text-base">Live readiness</CardTitle></CardHeader>
        <CardContent className="text-xs text-muted-foreground">Loading…</CardContent>
      </Card>
    );
  }

  const livePossible = data.plainEnglish.liveBrokerExecutionPossible;

  return (
    <Card data-testid="card-live-readiness-status">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {livePossible
            ? <ShieldCheck className="w-4 h-4 text-success" />
            : <ShieldAlert className="w-4 h-4 text-warning" />}
          {data.plainEnglish.headline}
        </CardTitle>
        <CardDescription>
          Demo trading, scanner, {name} and risk tools remain available even when
          real-broker execution is locked.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Badge className={livePossible ? "bg-success/20 text-success" : "bg-danger/20 text-danger"}
            data-testid="badge-live-status">
            Real broker execution: {livePossible ? "available" : "locked"}
          </Badge>
          <Badge className={data.plainEnglish.demoAvailable ? "bg-success/20 text-success" : "bg-muted text-txt-secondary"}
            data-testid="badge-demo-status">
            <FlaskConical className="w-3 h-3 mr-1" />
            Demo trading: {data.plainEnglish.demoAvailable ? "available" : "off"}
          </Badge>
        </div>
        <div className="rounded border border-border/60 p-3 space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Reason</div>
          <div data-testid="text-readiness-reason">{data.plainEnglish.primaryReason}</div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground pt-2">Next required step</div>
          <div className="text-muted-foreground" data-testid="text-readiness-next-step">{data.plainEnglish.nextStep}</div>
        </div>
        {showRawCodes && (
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-[11px] text-muted-foreground inline-flex items-center gap-1 hover:underline"
              data-testid="btn-toggle-raw-codes"
            >
              <Info className="w-3 h-3" /> {open ? "Hide" : "Show"} technical codes
            </button>
            {open && (
              <div className="mt-2 text-[11px] font-mono text-muted-foreground space-y-1" data-testid="block-raw-codes">
                <div>platformBridgeMode: {data.platformBridgeMode}</div>
                <div>userStatus: {data.userStatus}</div>
                <div>platformHeadline: {data.details.platformHeadline}</div>
                <div>platformNextStep: {data.details.platformNextStep}</div>
                {data.details.userBlockReasons.length > 0 && (
                  <div>userBlockReasons: {data.details.userBlockReasons.join(", ")}</div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
