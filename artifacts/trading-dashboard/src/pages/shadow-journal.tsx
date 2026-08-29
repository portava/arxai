import { useEffect, useState } from "react";
import { useProductRole } from "@/hooks/useProductRole";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { NotebookPen } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { AccessCheckingShell, AccessDeniedCard, SHADOW_ADMIN_DENIED_NOTE, shadowAdminDeniedMessage } from "@/components/access/AdminOnlyGate";

type Entry = { id: string; ts: string; symbol: string; strategy: string; marketCondition: string; aiSaw: string; whatHappened: string; rightOrWrong: "RIGHT" | "WRONG" | "PENDING"; lesson: string };
const RW_COLOR: Record<string, string> = { RIGHT: "bg-success/10 text-success border-success/25", WRONG: "bg-danger/10 text-danger border-danger/25", PENDING: "bg-muted/60 text-txt-secondary border-border" };

const PAGE_ICON = <NotebookPen className="h-6 w-6 text-primary" />;

export default function ShadowJournal() {
  // Admin/OWNER-only endpoint (/api/shadow-journal). Non-admins get the denied
  // state immediately and fire ZERO gated calls.
  const { isAdmin, isLoading: roleLoading } = useProductRole();
  const roleDenied = !roleLoading && !isAdmin;
  const [es, setEs] = useState<Entry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/shadow-journal?limit=200");
      if (!res.ok) throw Object.assign(new Error("load failed"), { status: res.status });
      const d = await res.json();
      setLoadError(null); setEs(d.entries ?? []);
    } catch (err) {
      const e = err as { status?: number };
      setLoadError(e.status === 403 || e.status === 401 ? shadowAdminDeniedMessage("the Shadow Journal") : "Could not load the Shadow Journal.");
    }
  }
  useEffect(() => {
    if (roleLoading || !isAdmin) return;
    void load(); const id = setInterval(load, 3000); return () => clearInterval(id);
  }, [roleLoading, isAdmin]);

  if (roleLoading) return <AccessCheckingShell icon={PAGE_ICON} title="Shadow Journal" />;
  if (roleDenied || loadError) {
    return (
      <AccessDeniedCard
        icon={PAGE_ICON}
        title="Shadow Journal"
        message={roleDenied ? shadowAdminDeniedMessage("the Shadow Journal") : loadError!}
        note={SHADOW_ADMIN_DENIED_NOTE}
        onRetry={roleDenied ? undefined : () => void load()}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <NotebookPen className="h-6 w-6 text-primary" />
        <div className="flex-1"><h1 className="text-2xl font-bold tracking-tight">Shadow Journal</h1>
          <p className="text-sm text-muted-foreground">Separate from simulator/demo/intent records. Pure shadow observations and lessons.</p>
        </div>
        <Badge variant="outline">SHADOW</Badge>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">{es.length} entries</CardTitle><CardDescription>Most recent first</CardDescription></CardHeader>
        <CardContent className="space-y-1">
          {es.map((e) => (
            <div key={e.id} className="rounded-lg bg-muted/40 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={RW_COLOR[e.rightOrWrong]}>{e.rightOrWrong}</Badge>
                <Badge variant="outline">{e.symbol}</Badge>
                <Badge variant="outline">{e.strategy}</Badge>
                <Badge variant="outline">mc {e.marketCondition}</Badge>
                <span className="ml-auto text-muted-foreground tabular-nums">{new Date(e.ts).toLocaleTimeString()}</span>
              </div>
              <div className="mt-1"><span className="text-muted-foreground">AI saw:</span> {e.aiSaw}</div>
              <div><span className="text-muted-foreground">Outcome:</span> {e.whatHappened}</div>
              <div className="text-success"><span className="text-muted-foreground">Lesson:</span> {e.lesson}</div>
            </div>
          ))}
          {es.length === 0 && (
            <EmptyState
              icon={NotebookPen}
              compact
              title="No shadow observations yet"
              description="Start shadow mode to populate the journal."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
