// Phase 10H — Activity timeline page.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Ev = { id: number; eventType: string; title: string; description: string; source: string; createdAt: string };
type Resp = { events: Ev[]; isEmpty: boolean };

const SOURCES = ["all", "mt5", "session", "trade", "risk", "ai", "playbook", "journal", "system", "security"] as const;
type Src = typeof SOURCES[number];

export default function Activity() {
  const [src, setSrc] = useState<Src>("all");
  const url = src === "all" ? "/api/me/activity" : `/api/me/activity?source=${src}`;
  const q = useQuery({ queryKey: ["meActivity", src], queryFn: async () => {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()) as Resp;
  }, refetchInterval: 30_000 });

  return (
    <div className="max-w-3xl">
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle>Activity timeline</CardTitle>
          <div className="flex flex-wrap gap-1 mt-2">
            {SOURCES.map((s) => (
              <button key={s} onClick={() => setSrc(s)} className={`px-2 py-1 text-xs rounded ${src === s ? "bg-primary text-foreground" : "bg-secondary text-txt-secondary"}`}>{s}</button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {q.isLoading && <div className="text-sm text-txt-secondary">Loading…</div>}
          {!q.isLoading && (q.data?.events ?? []).length === 0 && (
            <div className="text-sm text-txt-secondary py-8 text-center">
              <div>No activity yet</div>
              <div className="text-xs mt-1">Your timeline will populate as you connect MT5, start sessions, create demo trades, and review your trades.</div>
            </div>
          )}
          <ul className="space-y-2">
            {(q.data?.events ?? []).map((e) => (
              <li key={e.id} className="border border-border rounded p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{e.source}</Badge>
                    <span className="font-medium text-sm">{e.title}</span>
                  </div>
                  <span className="text-xs text-txt-muted">{new Date(e.createdAt).toLocaleString()}</span>
                </div>
                {e.description && <div className="text-xs text-txt-secondary mt-1">{e.description}</div>}
                <div className="text-[10px] text-txt-muted mt-1">{e.eventType}</div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
