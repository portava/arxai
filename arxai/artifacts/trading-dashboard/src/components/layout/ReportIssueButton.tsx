// Global Report Issue button — accessible from every page. Captures
// non-secret context (route, role, mode, timestamp, viewport). Posts to
// /api/feedback. Never captures secrets, MT5 tokens, or API keys.

import { useState } from "react";
import { useLocation } from "wouter";
import { Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

const CATEGORIES = ["BUG", "FEATURE", "UI", "TRADING", "CHART", "AI", "RISK", "JOURNAL", "MOBILE", "MT5", "OTHER"] as const;
const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export function ReportIssueButton() {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    title: "", category: "BUG" as typeof CATEGORIES[number], severity: "medium" as typeof SEVERITIES[number], whatHappened: "",
  });

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST", headers: { "content-type": "application/json", "x-security-role": "OWNER" },
        body: JSON.stringify({
          title: form.title || `Issue on ${location}`,
          category: form.category,
          severity: form.severity,
          route: location,
          whatHappened: form.whatHappened,
          currentMode: "BETA_TESTER",
          mt5Status: "deferred",
          context: {
            userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
            viewport: typeof window !== "undefined" ? { w: window.innerWidth, h: window.innerHeight } : null,
            ts: new Date().toISOString(),
          },
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? "submit failed");
      toast({ title: "Issue reported", description: j.feedbackId });
      setOpen(false); setForm({ title: "", category: "BUG", severity: "medium", whatHappened: "" });
    } catch (e) {
      toast({ title: "Failed to report", description: String(e), variant: "destructive" });
    } finally { setBusy(false); }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-20 right-20 md:bottom-6 md:right-24 z-40 inline-flex items-center gap-2 rounded-full border bg-background/85 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-lg backdrop-blur hover:text-foreground"
        aria-label="Report issue"
        data-testid="report-issue-trigger"
      >
        <Bug size={14} /> <span className="hidden md:inline">Report Issue</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setOpen(false)} role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-lg border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()} data-testid="report-issue-dialog">
            <div className="border-b p-3">
              <h2 className="font-semibold">Report Issue</h2>
              <p className="text-xs text-muted-foreground">Route: <code>{location}</code> · We never collect secrets.</p>
            </div>
            <div className="space-y-2 p-3 text-sm">
              <input className="w-full rounded border bg-background px-2 py-1.5" placeholder="Short title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} data-testid="report-title" />
              <div className="grid grid-cols-2 gap-2">
                <select className="rounded border bg-background px-2 py-1.5" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as typeof CATEGORIES[number] })}>
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
                <select className="rounded border bg-background px-2 py-1.5" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as typeof SEVERITIES[number] })}>
                  {SEVERITIES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              <textarea className="w-full rounded border bg-background px-2 py-1.5" rows={4} placeholder="What happened?" value={form.whatHappened} onChange={(e) => setForm({ ...form, whatHappened: e.target.value })} data-testid="report-what" />
            </div>
            <div className="flex justify-end gap-2 border-t p-3">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={busy || form.whatHappened.trim().length < 2} onClick={submit} data-testid="report-submit">{busy ? "Submitting…" : "Submit"}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
