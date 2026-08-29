import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Issue {
  feedbackId: string; title: string; category: string; severity: string; priority: string;
  status: string; route?: string | null; whatHappened: string; reporterRole: string;
  createdAt: string; notes?: string | null;
}
const STATUSES = ["NEW", "TRIAGED", "IN_PROGRESS", "FIXED", "NEEDS_RETEST", "CLOSED", "WONT_FIX"] as const;
const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export default function AdminIssues() {
  const [items, setItems] = useState<Issue[]>([]);
  const [filter, setFilter] = useState<string>("");

  const load = useCallback(async () => {
    const url = filter ? `/api/feedback?status=${filter}` : "/api/feedback";
    const r = await fetch(url, { headers: { "x-security-role": "ADMIN" } });
    const j = await r.json();
    setItems(j.items ?? []);
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  async function patch(id: string, fields: { status?: string; priority?: string }) {
    await fetch(`/api/feedback/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json", "x-security-role": "ADMIN" },
      body: JSON.stringify(fields),
    });
    void load();
  }

  const tone = (s: string) => s === "FIXED" || s === "CLOSED" ? "bg-success/20 text-success"
    : s === "IN_PROGRESS" || s === "NEEDS_RETEST" ? "bg-warning/20 text-warning"
    : s === "WONT_FIX" ? "bg-secondary/20 text-txt-secondary" : "bg-danger/20 text-danger";
  const sevTone = (s: string) => s === "critical" ? "bg-danger/20 text-danger"
    : s === "high" ? "bg-warning/20 text-warning"
    : s === "medium" ? "bg-primary/20 text-primary" : "bg-secondary/20 text-txt-secondary";

  return (
    <div className="space-y-4" data-testid="page-admin-issues">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Issue Tracker</h1>
          <p className="text-sm text-muted-foreground">{items.length} issues · filter: {filter || "all"}</p>
        </div>
        <div className="flex gap-2">
          <select className="rounded border bg-background px-2 py-1.5 text-sm" value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="issues-filter">
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Button onClick={() => void load()} variant="outline" size="sm">Refresh</Button>
        </div>
      </div>

      {items.length === 0 && (
        <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">No issues yet. Use the Report Issue button on any page to file one.</CardContent></Card>
      )}

      <div className="space-y-2">
        {items.map((i) => (
          <Card key={i.feedbackId} data-testid={`issue-${i.feedbackId}`}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex flex-wrap items-center gap-2">
                <Badge className="font-mono text-[10px]">{i.feedbackId}</Badge>
                <Badge variant="outline">{i.category}</Badge>
                <Badge className={sevTone(i.severity)}>{i.severity}</Badge>
                <Badge className="bg-premium/20 text-premium font-mono">{i.priority}</Badge>
                <Badge className={tone(i.status)}>{i.status}</Badge>
                <span className="ml-auto text-[10px] font-normal text-muted-foreground">{new Date(i.createdAt).toLocaleString()}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="font-semibold">{i.title}</p>
              <p className="text-muted-foreground whitespace-pre-wrap">{i.whatHappened}</p>
              {i.route && <p className="text-xs"><span className="text-muted-foreground">route:</span> <code>{i.route}</code></p>}
              <div className="flex flex-wrap gap-2 pt-1">
                <select className="rounded border bg-background px-2 py-1 text-xs" value={i.status} onChange={(e) => void patch(i.feedbackId, { status: e.target.value })} data-testid={`issue-status-${i.feedbackId}`}>
                  {STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
                <select className="rounded border bg-background px-2 py-1 text-xs" value={i.priority} onChange={(e) => void patch(i.feedbackId, { priority: e.target.value })}>
                  {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
