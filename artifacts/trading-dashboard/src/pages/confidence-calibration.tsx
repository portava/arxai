import { useEffect, useState } from "react";
import { useProductRole } from "@/hooks/useProductRole";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Gauge } from "lucide-react";
import { AccessCheckingShell, AccessDeniedCard, SHADOW_ADMIN_DENIED_NOTE, shadowAdminDeniedMessage } from "@/components/access/AdminOnlyGate";

type Cal = { totalSample: number; label: string; buckets: Array<{ bucket: string; sample: number; winRate: number; avgR: number }> };
const LABEL_COLOR: Record<string, string> = { WELL_CALIBRATED: "bg-success/20 text-success", OVERCONFIDENT: "bg-danger/20 text-danger", UNDERCONFIDENT: "bg-warning/20 text-warning", RANDOM_CONFIDENCE: "bg-muted text-txt-secondary", NEEDS_MORE_DATA: "bg-muted text-txt-secondary" };

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
        <Badge variant="outline">SHADOW</Badge>
        {c && <Badge className={LABEL_COLOR[c.label]}>{c.label}</Badge>}
      </div>
      {c && (
        <Card>
          <CardHeader><CardTitle className="text-base">Calibration buckets</CardTitle><CardDescription>Total sample: {c.totalSample}</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {c.buckets.map((b) => (
              <div key={b.bucket} className="flex items-center gap-2 text-xs">
                <Badge variant="outline" className="w-20">{b.bucket}</Badge>
                <div className="flex-1 h-3 bg-muted rounded relative">
                  <div className="absolute inset-y-0 left-0 bg-primary rounded" style={{ width: `${b.winRate}%` }} />
                </div>
                <span className="w-16 text-right font-mono">{b.winRate}%</span>
                <span className="w-20 text-right font-mono">avg R {b.avgR}</span>
                <span className="w-16 text-right text-muted-foreground">n={b.sample}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
