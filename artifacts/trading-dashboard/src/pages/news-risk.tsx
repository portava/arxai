import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Newspaper, Plus, Trash2 } from "lucide-react";

type Event = {
  id: number; eventName: string; currency: string; impact: "low" | "medium" | "high";
  eventTime: string; affectedSymbols: string[];
  avoidBeforeMinutes: number; avoidAfterMinutes: number; notes?: string;
  source: string; createdAt: string;
};

const IMPACT: Record<string, string> = {
  low: "bg-blue-500/20 text-blue-400",
  medium: "bg-amber-500/20 text-amber-400",
  high: "bg-rose-500/20 text-rose-400",
};

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, {
    headers: { "x-security-role": "ADMIN", "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  return r.json();
}

export default function NewsRiskPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [form, setForm] = useState({
    eventName: "", currency: "USD", impact: "high" as "low" | "medium" | "high",
    eventTime: new Date(Date.now() + 60 * 60_000).toISOString().slice(0, 16),
    affectedSymbols: "EURUSD,XAUUSD",
    avoidBeforeMinutes: 30, avoidAfterMinutes: 30, notes: "",
  });

  async function load() {
    const r = await fetch("/api/news-risk/events").then((x) => x.json());
    setEvents(r.events ?? []);
  }
  useEffect(() => { void load(); }, []);

  async function add() {
    if (!form.eventName) return;
    await api("/api/news-risk/events", {
      method: "POST",
      body: JSON.stringify({
        eventName: form.eventName, currency: form.currency, impact: form.impact,
        eventTime: new Date(form.eventTime).toISOString(),
        affectedSymbols: form.affectedSymbols.split(",").map((s) => s.trim()).filter(Boolean),
        avoidBeforeMinutes: Number(form.avoidBeforeMinutes), avoidAfterMinutes: Number(form.avoidAfterMinutes),
        notes: form.notes || undefined,
      }),
    });
    setForm({ ...form, eventName: "", notes: "" });
    load();
  }
  async function del(id: number) {
    await api(`/api/news-risk/events/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Newspaper className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">News Risk Filter</h1>
          <p className="text-sm text-muted-foreground">Manual + simulated events. External calendar provider deferred.</p>
        </div>
        <Badge variant="outline">SIMULATOR</Badge>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Add event (manual)</CardTitle><CardDescription>Used by AI brain, scanner and risk governor.</CardDescription></CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-4">
          <Input placeholder="Event name (e.g. CPI)" value={form.eventName} onChange={(e) => setForm({ ...form, eventName: e.target.value })} />
          <Input placeholder="Currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
          <select className="border rounded px-2 bg-background" value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value as "low" | "medium" | "high" })}>
            <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
          </select>
          <Input type="datetime-local" value={form.eventTime} onChange={(e) => setForm({ ...form, eventTime: e.target.value })} />
          <Input placeholder="Symbols (CSV)" value={form.affectedSymbols} onChange={(e) => setForm({ ...form, affectedSymbols: e.target.value })} className="md:col-span-2" />
          <Input type="number" placeholder="Avoid before (min)" value={form.avoidBeforeMinutes} onChange={(e) => setForm({ ...form, avoidBeforeMinutes: Number(e.target.value) })} />
          <Input type="number" placeholder="Avoid after (min)" value={form.avoidAfterMinutes} onChange={(e) => setForm({ ...form, avoidAfterMinutes: Number(e.target.value) })} />
          <Input placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="md:col-span-3" />
          <Button onClick={add}><Plus className="h-4 w-4 mr-1" />Add</Button>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {events.length === 0
          ? <p className="text-sm text-muted-foreground">No events.</p>
          : events.map((e) => (
              <Card key={e.id}>
                <CardContent className="p-3 flex items-center gap-3 flex-wrap text-sm">
                  <Badge className={IMPACT[e.impact]}>{e.impact.toUpperCase()}</Badge>
                  <Badge variant="outline">{e.currency}</Badge>
                  <span className="font-semibold">{e.eventName}</span>
                  <span className="text-muted-foreground">{new Date(e.eventTime).toLocaleString()}</span>
                  <span className="text-xs text-muted-foreground">avoid −{e.avoidBeforeMinutes}m / +{e.avoidAfterMinutes}m</span>
                  <div className="flex gap-1 flex-wrap">{e.affectedSymbols.map((s) => <Badge key={s} variant="outline" className="text-[10px]">{s}</Badge>)}</div>
                  {e.notes && <span className="text-xs text-muted-foreground italic ml-2">{e.notes}</span>}
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => del(e.id)}><Trash2 className="h-4 w-4" /></Button>
                </CardContent>
              </Card>
            ))}
      </div>
    </div>
  );
}
