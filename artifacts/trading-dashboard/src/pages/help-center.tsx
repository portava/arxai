import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Link } from "wouter";
import { GraduationCap, LifeBuoy, Search, Wand2 } from "lucide-react";
import { WhyBlockedDrawer } from "@/components/help/WhyBlockedDrawer";
import { useOnboarding } from "@/components/onboarding/OnboardingProvider";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useTraderTier } from "@/hooks/useTraderTier";
import { useViewMode } from "@/hooks/useViewMode";
import { isHumanTraderAllowedPath } from "@/lib/routeAccess";
import { safeArray } from "@/lib/safeFormat";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

interface HelpTopic { help_key: string; title: string; category: string; page_route: string | null; content: string; safety_note: string; related_build: string }
interface ExplainResult { help_id: string; status: string; plainEnglishExplanation: string; reasonCodes: string[]; recommendedNextActions: string[]; relatedPages: string[]; safetyReminder: string; generatedAt: string }

export default function HelpCenter() {
  const mode = useTradingMode();
  const { effectiveIsAdmin: isAdmin } = useViewMode();
  const { isApprovedTrader } = useTraderTier();
  // DEAD_GAUGE fix: the onboarding "complete" step tells every user "You can
  // re-run onboarding any time from the Help Center", but this page carried no
  // onboarding or tour affordance at all — the only "Start app tour" control
  // lived in the retired FloatingHelpWidget, which components/help/
  // mountedAssistantTrigger.test.ts pins as having ZERO importers, so
  // useOnboarding().showTour was unreachable from anything that mounts. The
  // promise named a control no user could find. It exists here now.
  const { showTour } = useOnboarding();

  // RANK 51 — 100% of the Help Center's "Open page" links were un-followable.
  // The catalogue pointed at /trading-cockpit and /paper-testing-launch (no
  // <Route> exists for either) and at six admin surfaces on no trader
  // allowlist, so a trader clicking one either landed on Not Found or was
  // silently redirected to the cockpit by RouteAccessGuard. The catalogue is
  // fixed server-side, and this is the second line of defence: a link is only
  // rendered when THIS viewer's tier can actually reach it.
  const canOpen = (route: string | null): route is string =>
    typeof route === "string" && route.startsWith("/") &&
    (isAdmin || isHumanTraderAllowedPath(route, { isApprovedTrader }));
  const [topics, setTopics] = useState<HelpTopic[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("ALL");
  const [topicQuestion, setTopicQuestion] = useState("Why can't I start a session?");
  const [explainResult, setExplainResult] = useState<ExplainResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "Help Center";
    fetch(`${BASE}/api/help/topics`).then(r => r.json()).then(d => { setTopics(d.topics ?? []); setCategories(d.categories ?? []); });
  }, []);

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return topics.filter(t =>
      (cat === "ALL" || t.category === cat) &&
      (!ql || t.title.toLowerCase().includes(ql) || t.content.toLowerCase().includes(ql) || t.help_key.includes(ql))
    );
  }, [topics, q, cat]);

  async function explain() {
    setBusy(true); setExplainResult(null);
    const r = await fetch(`${BASE}/api/help/explain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: topicQuestion }) });
    const d = await r.json();
    setExplainResult(d.result ?? null);
    setBusy(false);
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 pb-32 md:pb-6">
      <div className="flex flex-wrap items-center gap-2">
        {mode.envelope && (
          <Badge
            variant="outline"
            className={
              mode.isLiveShared
                ? "bg-danger/15 text-danger border-danger/30"
                : mode.isDemo
                  ? "bg-primary/15 text-primary border-primary/30"
                  : "bg-ruby/15 text-ruby border-ruby/30"
            }
            data-testid="help-mode-badge"
            title={mode.cleanUserMessage}
          >
            {mode.cleanModeLabel}
          </Badge>
        )}
      </div>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
          <LifeBuoy className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-bold leading-tight">Help Center</h1>
          <p className="text-sm text-txt-secondary">Plain-English explanations of every safety system. Help content is read-only — nothing on this page places a trade.</p>
        </div>
      </div>

      {/* The affordance the onboarding "complete" step promises lives here. */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-4">
        <GraduationCap className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-sm font-semibold">New here, or want a refresher?</span>
        <Button
          size="sm"
          variant="outline"
          onClick={showTour}
          data-testid="button-restart-tour"
        >
          Restart the guided tour
        </Button>
        <Link className="text-xs text-primary underline" href="/onboarding" data-testid="link-onboarding-checklist">
          Open the onboarding checklist →
        </Link>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Wand2 className="h-4 w-4" />Ask a question</h2>
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input value={topicQuestion} onChange={e => setTopicQuestion(e.target.value)} placeholder="e.g. Why is autopilot blocked?" />
            <Button onClick={explain} disabled={busy} className="bg-primary text-white hover:bg-primary/90">{busy ? "Explaining…" : "Explain"}</Button>
          </div>
          <div className="flex flex-wrap gap-1 text-[11px]">
            {/* RANK 4: two of these presupposed the PAPER_ONLY lie — "Why is
                broker read-only?" and "Why is live trading disabled?" both
                asserted, in the question itself, something that is not true of
                this build. They ask about the user's real state now. */}
            {["Why can't I start a session?", "Why is autopilot blocked?", "Why can't I use the broker bridge?", "Can I trade live?", "What is the safest next step?"].map(s => (
              <Button key={s} size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setTopicQuestion(s)}>{s}</Button>
            ))}
          </div>
          {explainResult && (
            <Alert>
              <AlertTitle>{explainResult.status}</AlertTitle>
              <AlertDescription className="text-xs space-y-1">
                <p>{explainResult.plainEnglishExplanation}</p>
                {safeArray(explainResult.recommendedNextActions).length > 0 && (
                  <ul className="list-disc pl-5">{safeArray(explainResult.recommendedNextActions).map((a, i) => <li key={i}>{a}</li>)}</ul>
                )}
                <p className="italic text-txt-muted">{explainResult.safetyReminder}</p>
              </AlertDescription>
            </Alert>
          )}
          <WhyBlockedDrawer />
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Search className="h-4 w-4" />Browse topics</h2>
        <div className="space-y-3">
          <div className="flex gap-2 flex-wrap">
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search topics…" className="max-w-xs" />
            <Button size="sm" variant={cat === "ALL" ? "default" : "outline"} onClick={() => setCat("ALL")}>ALL</Button>
            {categories.map(c => <Button key={c} size="sm" variant={cat === c ? "default" : "outline"} onClick={() => setCat(c)}>{c}</Button>)}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {filtered.map(t => (
              <div key={t.help_key} className="rounded-xl border border-border bg-background/40 p-3">
                <div className="mb-1 flex items-center gap-1">
                  <Badge variant="outline" className="text-[10px]">{t.category}</Badge>
                  {canOpen(t.page_route) && (
                    <Link className="ml-auto text-[10px] text-primary underline" href={t.page_route}>Open page</Link>
                  )}
                </div>
                <h4 className="text-sm font-semibold">{t.title}</h4>
                <p className="mt-1 text-xs text-txt-secondary">{t.content}</p>
                <p className="mt-1 text-[10px] italic text-txt-muted">{t.safety_note}</p>
              </div>
            ))}
            {filtered.length === 0 && <p className="text-xs text-txt-muted">No topics match your search.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
