import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HelpCircle } from "lucide-react";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

interface HelpTopic { help_key: string; title: string; category: string; page_route: string | null; content: string; safety_note: string; related_build: string }

export function HelpDrawer({ route, trigger }: { route?: string; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [topics, setTopics] = useState<HelpTopic[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // CONFIDENT_ABSENT fix: this `.then(...)` chain had no `r.ok` check and no
  // `.catch`, so a failed help read fell through to `topics = []` and rendered
  // the confident empty state "No help topics for this page yet" — asserting
  // the library is empty when in fact it could not be read. A failed read now
  // says so and offers a retry.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(null);
    const url = route ? `${BASE}/api/help/page?route=${encodeURIComponent(route)}` : `${BASE}/api/help/topics`;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { if (!cancelled) setTopics(Array.isArray(d?.topics) ? d.topics : []); })
      .catch(e => {
        if (cancelled) return;
        setTopics([]);
        setError(e instanceof Error ? e.message : "the read failed");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, route, attempt]);

  return (
    <>
      <span onClick={() => setOpen(true)}>
        {trigger ?? (
          <Button variant="outline" size="sm"><HelpCircle className="h-4 w-4 mr-1" />Explain this</Button>
        )}
      </span>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="overflow-y-auto w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><HelpCircle className="h-4 w-4" />Help{route ? ` — ${route}` : ""}</SheetTitle>
            {/* DEAD_GAUGE fix: this header hard-coded a green "LIVE" badge next
                to a red "LIVE TRADING DISABLED" badge on every open. Neither
                read any state — they contradicted each other, and the second
                asserted the retired PAPER_ONLY claim on a build where live
                dispatch is real and admin-gated. Help content makes no
                trading-mode claim; the mode chip in the header is the one
                place that reports it. */}
            <SheetDescription className="text-xs">
              Read-only help content. Nothing in this drawer places a trade or changes your trading mode — check the mode chip in the header for that.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-3">
            {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
            {!loading && error && (
              <div className="rounded-md border border-danger/30 bg-danger/10 p-3 text-xs text-danger" data-testid="help-drawer-error">
                <p className="font-semibold">Couldn't load help topics</p>
                <p className="mt-1">This is a failed read, not an empty library — there may well be topics for this page.</p>
                <p className="mt-1 font-mono text-[10px]">{error}</p>
                <Button size="sm" variant="outline" className="mt-2" onClick={() => setAttempt(a => a + 1)}>Retry</Button>
              </div>
            )}
            {!loading && !error && topics.length === 0 && <p className="text-xs text-muted-foreground">No help topics for this page yet. Open the Help Center for the full library.</p>}
            {topics.map(t => (
              <div key={t.help_key} className="border rounded-md p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline" className="text-[10px]">{t.category}</Badge>
                  <Badge variant="outline" className="text-[10px]">Build {t.related_build}</Badge>
                </div>
                <h4 className="font-semibold text-sm">{t.title}</h4>
                <p className="text-xs mt-1">{t.content}</p>
                <p className="text-[10px] text-muted-foreground mt-2 italic">{t.safety_note}</p>
              </div>
            ))}
            <div className="pt-2">
              <a href={`${BASE}/help`} className="text-xs underline">Open full Help Center →</a>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
