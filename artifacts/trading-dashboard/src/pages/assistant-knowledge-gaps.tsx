/**
 * Tester/admin-only view: surfaces logged Assistant Knowledge Gaps
 * (questions the assistant could not answer or answered weakly).
 *
 * Reads from /api/feedback (server enforces OWNER/ADMIN/TESTER role) and
 * filters to items whose title is prefixed with [KB-MISS].
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FeedbackItem {
  feedbackId: string;
  title: string;
  category: string;
  severity: string;
  route: string | null;
  whatHappened: string;
  status: string;
  reporterRole: string;
  createdAt: string;
  context?: Record<string, unknown> | null;
}

interface GapBucket {
  question: string;
  count: number;
  routes: string[];
  latestId: string;
  latestAt: string;
  ids: string[];
}

export default function AssistantKnowledgeGaps() {
  const [items, setItems] = useState<FeedbackItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback");
      if (!res.ok) {
        setError(res.status === 403 ? "You need TESTER, ADMIN, or OWNER role to view this." : `HTTP ${res.status}`);
        setItems([]);
        return;
      }
      const j = await res.json();
      setItems((j.items ?? []) as FeedbackItem[]);
    } catch (e) {
      setError(String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const gaps = useMemo<GapBucket[]>(() => {
    const misses = (items ?? []).filter(
      (i) => i.title.startsWith("[KB-MISS]") && i.status !== "CLOSED" && i.status !== "WONT_FIX",
    );
    const byQ = new Map<string, GapBucket>();
    for (const m of misses) {
      const q = m.title.replace(/^\[KB-MISS\]\s*/, "").trim();
      const key = q.toLowerCase();
      const existing = byQ.get(key);
      if (existing) {
        existing.count += 1;
        if (m.route && !existing.routes.includes(m.route)) existing.routes.push(m.route);
        existing.ids.push(m.feedbackId);
        if (m.createdAt > existing.latestAt) {
          existing.latestAt = m.createdAt;
          existing.latestId = m.feedbackId;
        }
      } else {
        byQ.set(key, {
          question: q,
          count: 1,
          routes: m.route ? [m.route] : [],
          latestId: m.feedbackId,
          latestAt: m.createdAt,
          ids: [m.feedbackId],
        });
      }
    }
    return [...byQ.values()].sort((a, b) => b.count - a.count || b.latestAt.localeCompare(a.latestAt));
  }, [items]);

  async function markResolved(bucket: GapBucket) {
    setBusyId(bucket.latestId);
    setError(null);
    try {
      const responses = await Promise.all(
        bucket.ids.map((id) =>
          fetch(`/api/feedback/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "CLOSED", notes: "Resolved from Assistant Knowledge Gaps page" }),
          }),
        ),
      );
      const failures = responses.filter((r) => !r.ok);
      if (failures.length > 0) {
        const status = failures[0].status;
        if (status === 401 || status === 403) {
          setError("Marking gaps as resolved requires Admin or Owner permission. You can still view and triage gaps.");
        } else {
          setError(`Could not resolve ${failures.length} of ${responses.length} items (HTTP ${status}).`);
        }
      }
      await load();
    } catch (e) {
      setError(`Resolve failed: ${String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-[1100px] p-4 md:p-6 space-y-4" data-testid="assistant-knowledge-gaps">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">Assistant Knowledge Gaps</h1>
          <p className="text-xs text-muted-foreground">
            Questions the ARX Assistant could not confidently answer. Visible to Tester / Admin / Owner; only Admins or Owners can mark items resolved.
          </p>
        </div>
        <Button onClick={load} disabled={loading} size="sm" variant="outline" data-testid="kg-refresh">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          <span className="ml-1">Refresh</span>
        </Button>
      </header>

      {error && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning flex gap-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {!loading && gaps.length === 0 && !error && (
        <div className="rounded-md border border-success/30 bg-success/5 p-4 text-sm text-success flex gap-2">
          <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
          No outstanding knowledge gaps. The assistant has answered every recent question.
        </div>
      )}

      {gaps.length > 0 && (
        <div className="rounded-lg border border-white/10 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-white/[0.03] text-muted-foreground">
              <tr>
                <th className="text-left p-2 w-12">#</th>
                <th className="text-left p-2">Question</th>
                <th className="text-left p-2 w-40">Routes</th>
                <th className="text-left p-2 w-36">Latest</th>
                <th className="text-right p-2 w-28">Action</th>
              </tr>
            </thead>
            <tbody>
              {gaps.map((g, i) => (
                <tr key={g.latestId} className="border-t border-white/5 align-top">
                  <td className="p-2 text-muted-foreground">{g.count}</td>
                  <td className="p-2">
                    <div className="font-medium">{g.question}</div>
                    <div className="text-[10px] text-muted-foreground/70 mt-0.5">id: {g.latestId}</div>
                  </td>
                  <td className="p-2 text-muted-foreground">{g.routes.slice(0, 3).join(", ") || "—"}</td>
                  <td className="p-2 text-muted-foreground">{new Date(g.latestAt).toLocaleString()}</td>
                  <td className="p-2 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => markResolved(g)}
                      disabled={busyId === g.latestId}
                      data-testid={`kg-resolve-${i}`}
                    >
                      {busyId === g.latestId ? <Loader2 size={12} className="animate-spin" /> : "Mark resolved"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
