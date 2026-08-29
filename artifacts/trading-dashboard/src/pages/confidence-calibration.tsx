import { useEffect, useState } from "react";
import { useProductRole } from "@/hooks/useProductRole";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Gauge } from "lucide-react";
import { AccessCheckingShell, AccessDeniedCard, SHADOW_ADMIN_DENIED_NOTE, shadowAdminDeniedMessage } from "@/components/access/AdminOnlyGate";

type Cal = {
  totalSample: number; label: string;
  buckets: Array<{
    bucket: string; sample: number; winRate: number;
    expectedWinRate?: number; errorPctPts?: number | null; avgR: number;
  }>;
  calibrationErrorPctPts?: number | null;
  signedErrorPctPts?: number | null;
  tolerancePctPts?: number;
  monotonicitySlopePctPts?: number | null;
  method?: string;
  minSample?: number;
};
// CALIBRATED_ON_SYNTHETIC_ONLY is deliberately NOT green: the samples come from
// shadow decisions on synthetic simulator candles, so a good calibration error
// here is a statement about ARX's own random walk, not about the market.
const LABEL_COLOR: Record<string, string> = {
  CALIBRATED_ON_SYNTHETIC_ONLY: "bg-primary/20 text-primary",
  OVERCONFIDENT: "bg-danger/20 text-danger",
  UNDERCONFIDENT: "bg-warning/20 text-warning",
  RANDOM_CONFIDENCE: "bg-muted text-txt-secondary",
  NEEDS_MORE_DATA: "bg-muted text-txt-secondary",
};

const PAGE_ICON = <Gauge className="h-6 w-6 text-primary" />;

export default function ConfidenceCalibration() {
  // Admin/OWNER-only endpoint (/api/confidence-calibration). Non-admins get the
  // denied state immediately and fire ZERO gated calls.
  const { isAdmin, isLoading: roleLoading } = useProductRole();
  const roleDenied = !roleLoading && !isAdmin;
  const [c, setC] = useState<Cal | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/confidence-calibration");
      if (!res.ok) throw Object.assign(new Error("load failed"), { status: res.status });
      setLoadError(null); setC(await res.json());
    } catch (err) {
      const e = err as { status?: number };
      setLoadError(e.status === 403 || e.status === 401 ? shadowAdminDeniedMessage("Confidence Calibration") : "Could not load Confidence Calibration.");
    }
  }
  useEffect(() => {
    if (roleLoading || !isAdmin) return;
    void load(); const id = setInterval(load, 3000); return () => clearInterval(id);
  }, [roleLoading, isAdmin]);

  if (roleLoading) return <AccessCheckingShell icon={PAGE_ICON} title="Confidence Calibration" />;
  if (roleDenied || loadError) {
    return (
      <AccessDeniedCard
        icon={PAGE_ICON}
        title="Confidence Calibration"
        message={roleDenied ? shadowAdminDeniedMessage("Confidence Calibration") : loadError!}
        note={SHADOW_ADMIN_DENIED_NOTE}
        onRetry={roleDenied ? undefined : () => void load()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Gauge className="h-6 w-6 text-primary" />
        <div className="flex-1"><h1 className="text-2xl font-bold">Confidence Calibration</h1>
          <p className="text-sm text-muted-foreground">Compare AI confidence vs actual shadow win rate per bucket.</p>
        </div>
        <Badge variant="outline">SYNTHETIC · SHADOW</Badge>
        {c && <Badge className={LABEL_COLOR[c.label]}>{c.label}</Badge>}
      </div>

      <Card className="border-warning/40 bg-warning/10">
        <CardContent className="p-3 text-xs text-warning">
          <p className="font-semibold">Measured on synthetic data.</p>
          <p className="mt-1 text-warning/80">
            {c?.method ??
              "Samples are SHADOW decisions resolved against synthetic simulator candles — never live fills."}
            {" "}A good calibration error here describes ARX&apos;s consistency with its own
            generated prices. It is not evidence that these confidence numbers behave as
            probabilities in the real market.
          </p>
        </CardContent>
      </Card>

      {c && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Calibration buckets</CardTitle>
            <CardDescription>
              Total sample: {c.totalSample}
              {c.minSample != null ? ` (minimum ${c.minSample} for a verdict)` : ""}
              {c.calibrationErrorPctPts != null
                ? ` · mean absolute calibration error ${c.calibrationErrorPctPts} pts (tolerance ${c.tolerancePctPts ?? 10})`
                : " · calibration error not computable yet"}
              {c.signedErrorPctPts != null
                ? ` · signed ${c.signedErrorPctPts > 0 ? "+" : ""}${c.signedErrorPctPts} pts (positive = claimed more than delivered)`
                : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2 text-[10px] uppercase text-muted-foreground">
              <span className="w-20">bucket</span>
              <span className="flex-1">observed win rate vs claimed (marker)</span>
              <span className="w-16 text-right">observed</span>
              <span className="w-16 text-right">error</span>
              <span className="w-20 text-right">avg R</span>
              <span className="w-16 text-right">n</span>
            </div>
            {c.buckets.map((b) => (
              <div key={b.bucket} className="flex items-center gap-2 text-xs">
                <Badge variant="outline" className="w-20">{b.bucket}</Badge>
                <div className="flex-1 h-3 bg-muted rounded relative">
                  <div className="absolute inset-y-0 left-0 bg-primary rounded" style={{ width: `${b.winRate}%` }} />
                  {b.expectedWinRate != null && (
                    <div
                      title={`Claimed ${b.expectedWinRate}% (bucket midpoint)`}
                      className="absolute inset-y-0 w-0.5 bg-foreground"
                      style={{ left: `${Math.min(100, b.expectedWinRate)}%` }}
                    />
                  )}
                </div>
                <span className="w-16 text-right font-mono">{b.winRate}%</span>
                <span className="w-16 text-right font-mono text-muted-foreground">
                  {b.sample === 0 || b.errorPctPts == null ? "—" : `${b.errorPctPts > 0 ? "+" : ""}${b.errorPctPts}`}
                </span>
                <span className="w-20 text-right font-mono">avg R {b.avgR}</span>
                <span className="w-16 text-right text-muted-foreground">n={b.sample}</span>
              </div>
            ))}
            <p className="text-[10px] text-txt-muted">
              The vertical marker is what the confidence number claimed (the bucket midpoint);
              the bar is what actually happened. Error is claimed minus observed, in percentage
              points — positive means the model promised more than it delivered. Buckets with
              n=0 contribute nothing.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
