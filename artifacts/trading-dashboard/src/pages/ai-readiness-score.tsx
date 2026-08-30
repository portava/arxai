import { useEffect, useState } from "react";
import { useProductRole } from "@/hooks/useProductRole";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";
import { AccessCheckingShell, AccessDeniedCard, SHADOW_ADMIN_DENIED_NOTE, shadowAdminDeniedMessage } from "@/components/access/AdminOnlyGate";

type NotMeasured = { factor: string; reason: string; wouldNeed: string };
type R = {
  score: number; label: string; factors: Record<string, number>; realBrokerReadiness: string;
  partial?: boolean;
  measuredFactorCount?: number;
  totalFactorCount?: number;
  notMeasured?: NotMeasured[];
  basis?: string;
  candleSource?: string;
};
const LABEL_COLOR: Record<string, string> = { NOT_READY: "bg-danger/20 text-danger", NEEDS_MORE_TESTING: "bg-warning/20 text-warning", PAPER_READY: "bg-primary/20 text-primary", DEMO_READY: "bg-success/20 text-success", LIVE_INTENT_READY: "bg-premium/20 text-premium" };

const PAGE_ICON = <Sparkles className="h-6 w-6 text-primary" />;

export default function AiReadinessScore() {
  // Admin/OWNER-only endpoint (/api/ai-readiness-score). Non-admins get the
  // denied state immediately and fire ZERO gated calls.
  const { isAdmin, isLoading: roleLoading } = useProductRole();
  const roleDenied = !roleLoading && !isAdmin;
  const [r, setR] = useState<R | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/ai-readiness-score");
      if (!res.ok) throw Object.assign(new Error("load failed"), { status: res.status });
      setLoadError(null); setR(await res.json());
    } catch (err) {
      const e = err as { status?: number };
      setLoadError(e.status === 403 || e.status === 401 ? shadowAdminDeniedMessage("the AI Readiness Score") : "Could not load the AI Readiness Score.");
    }
  }
  useEffect(() => {
    if (roleLoading || !isAdmin) return;
    void load(); const id = setInterval(load, 3000); return () => clearInterval(id);
  }, [roleLoading, isAdmin]);

  if (roleLoading) return <AccessCheckingShell icon={PAGE_ICON} title="AI Readiness Score" />;
  if (roleDenied || loadError) {
    return (
      <AccessDeniedCard
        icon={PAGE_ICON}
        title="AI Readiness Score"
        message={roleDenied ? shadowAdminDeniedMessage("the AI Readiness Score") : loadError!}
        note={SHADOW_ADMIN_DENIED_NOTE}
        onRetry={roleDenied ? undefined : () => void load()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Sparkles className="h-6 w-6 text-primary" />
        <div className="flex-1"><h1 className="text-2xl font-bold">AI Readiness Score</h1>
          <p className="text-sm text-muted-foreground">
            Partial 0–100 composite over the factors that are actually measured. Real-broker
            label is intentionally never shown until MT5 is connected.
          </p>
        </div>
        <Badge variant="outline">SYNTHETIC · SHADOW</Badge>
        {/* The label is rendered exactly as computed. It used to display
            PAPER_READY as "DEMO_READY", showing a higher rung than the score
            supported. */}
        {r && <Badge className={LABEL_COLOR[r.label]}>{r.label}</Badge>}
      </div>

      {/* Provenance banner — this composite is computed on fabricated candles. */}
      <Card className="border-warning/40 bg-warning/10">
        <CardContent className="p-3 text-xs text-warning">
          <p className="font-semibold">Computed on synthetic data.</p>
          <p className="mt-1 text-warning/80">
            {r?.basis ??
              "Derived from shadow decisions resolved against synthetic simulator candles. Not a live-readiness certification."}
          </p>
        </CardContent>
      </Card>

      {r && (
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl text-center">{r.score}/100</CardTitle>
            <CardDescription className="text-center">
              {r.measuredFactorCount != null && r.totalFactorCount != null
                ? `Mean of ${r.measuredFactorCount} measured factors (of ${r.totalFactorCount}). `
                : ""}
              {r.realBrokerReadiness}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {Object.entries(r.factors).map(([k, v]) => (
              <div key={k} className="border rounded p-2 text-xs">
                <p className="text-[10px] uppercase text-muted-foreground">{k}</p>
                <div className="flex items-center gap-2 mt-1">
                  <div className="flex-1 h-2 bg-muted rounded"><div className="h-2 bg-primary rounded" style={{ width: `${Math.min(100, v)}%` }} /></div>
                  <span className="font-mono w-10 text-right">{v}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Not-measured factors: rendered as explicitly unscored, never as bars.
          These three were typed constants (100 / 80 / 100) averaged into the
          composite as if they had been measured. */}
      {r?.notMeasured && r.notMeasured.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Not measured — excluded from the score</CardTitle>
            <CardDescription>
              These factors have no measurement behind them. They are not scored, not
              defaulted, and contribute nothing to the {r.score}/100 above.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {r.notMeasured.map((n) => (
              <div key={n.factor} className="border rounded p-2 text-xs">
                <div className="flex items-center gap-2">
                  <p className="text-[10px] uppercase text-muted-foreground flex-1">{n.factor}</p>
                  <Badge variant="outline" className="text-[10px]">not measured</Badge>
                </div>
                <p className="mt-1 text-muted-foreground">{n.reason}</p>
                <p className="mt-0.5 text-muted-foreground/80">Would need: {n.wouldNeed}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
