import { useEffect, useState } from "react";
import { useProductRole } from "@/hooks/useProductRole";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";
import { AccessCheckingShell, AccessDeniedCard, SHADOW_ADMIN_DENIED_NOTE, shadowAdminDeniedMessage } from "@/components/access/AdminOnlyGate";

type R = { score: number; label: string; factors: Record<string, number>; realBrokerReadiness: string };
const LABEL_COLOR: Record<string, string> = { NOT_READY: "bg-danger/20 text-danger", NEEDS_MORE_TESTING: "bg-warning/20 text-warning", PAPER_READY: "bg-blue-500/20 text-blue-400", DEMO_READY: "bg-success/20 text-success", LIVE_INTENT_READY: "bg-premium/20 text-premium" };

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
          <p className="text-sm text-muted-foreground">0–100 composite. Real-broker label is intentionally never shown until MT5 is connected.</p>
        </div>
        <Badge variant="outline">SHADOW</Badge>
        {r && <Badge className={LABEL_COLOR[r.label]}>{r.label === "PAPER_READY" ? "DEMO_READY" : r.label}</Badge>}
      </div>
      {r && (
        <Card>
          <CardHeader><CardTitle className="text-2xl text-center">{r.score}/100</CardTitle><CardDescription className="text-center">{r.realBrokerReadiness}</CardDescription></CardHeader>
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
    </div>
  );
}
