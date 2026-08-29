import { useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

const CATEGORIES = ["BUG", "FEATURE", "UI", "TRADING", "CHART", "AI", "RISK", "JOURNAL", "MOBILE", "MT5", "OTHER"] as const;
const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export default function FeedbackCenter() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [form, setForm] = useState({
    title: "", category: "BUG" as typeof CATEGORIES[number], severity: "medium" as typeof SEVERITIES[number],
    route: typeof window !== "undefined" ? window.location.pathname : "", whatHappened: "", whatExpected: "", stepsToReproduce: "",
  });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST", headers: { "content-type": "application/json", "x-security-role": "OWNER" },
        body: JSON.stringify({
          ...form,
          currentMode: "BETA_TESTER",
          mt5Status: "deferred",
          context: { userAgent: navigator.userAgent, viewport: { w: window.innerWidth, h: window.innerHeight }, ts: new Date().toISOString() },
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? "submit failed");
      toast({ title: "Feedback submitted", description: j.feedbackId });
      setLocation("/admin/issues");
    } catch (e) {
      toast({ title: "Failed to submit", description: String(e), variant: "destructive" });
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4 p-1 max-w-2xl" data-testid="page-feedback-center">
      <div>
        <h1 className="text-2xl font-bold">Feedback Center</h1>
        <p className="text-sm text-muted-foreground">File a bug, feature idea, or workflow issue. We never collect secrets, MT5 tokens, or API keys.</p>
      </div>
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2">New report <Badge className="bg-warning/20 text-warning">BETA</Badge></CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="block">Title<input className="mt-1 w-full rounded border bg-background px-2 py-1.5" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} data-testid="fb-title" /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">Category
              <select className="mt-1 w-full rounded border bg-background px-2 py-1.5" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as typeof CATEGORIES[number] })} data-testid="fb-category">
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label className="block">Severity
              <select className="mt-1 w-full rounded border bg-background px-2 py-1.5" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as typeof SEVERITIES[number] })} data-testid="fb-severity">
                {SEVERITIES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
          </div>
          <label className="block">Route<input className="mt-1 w-full rounded border bg-background px-2 py-1.5 font-mono text-xs" value={form.route} onChange={(e) => setForm({ ...form, route: e.target.value })} /></label>
          <label className="block">What happened<textarea className="mt-1 w-full rounded border bg-background px-2 py-1.5" rows={3} value={form.whatHappened} onChange={(e) => setForm({ ...form, whatHappened: e.target.value })} data-testid="fb-what" /></label>
          <label className="block">What was expected<textarea className="mt-1 w-full rounded border bg-background px-2 py-1.5" rows={2} value={form.whatExpected} onChange={(e) => setForm({ ...form, whatExpected: e.target.value })} /></label>
          <label className="block">Steps to reproduce<textarea className="mt-1 w-full rounded border bg-background px-2 py-1.5" rows={3} value={form.stepsToReproduce} onChange={(e) => setForm({ ...form, stepsToReproduce: e.target.value })} /></label>
          <Button disabled={busy || form.title.trim().length < 2 || form.whatHappened.trim().length < 2} onClick={submit} data-testid="fb-submit">
            {busy ? "Submitting…" : "Submit Feedback"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
