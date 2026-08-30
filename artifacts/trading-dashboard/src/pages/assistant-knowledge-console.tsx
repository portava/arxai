/**
 * Assistant Knowledge Console — tester / admin / owner only.
 *
 * Surfaces deterministic coverage stats so we can verify the assistant is
 * complete: route coverage, badge coverage, UI element coverage, refusal
 * patterns, walkthrough validity, missing knowledge, and recent gaps.
 *
 * Reads from /api/feedback (server enforces TESTER+ role). If the user
 * isn't authorized the panel still loads — just the "recent gaps" section
 * shows a permission notice.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ROUTE_KNOWLEDGE, resolveRoute } from "@/knowledge/routeKnowledge";
import { DECLARED_ROUTES } from "@/knowledge/declaredRoutes";
import { ARX_KNOWLEDGE } from "@/knowledge/arxAppKnowledge";
import { routeCoverage, badgeCoverage, REQUIRED_BADGES } from "@/knowledge/coverage";
import { UI_ELEMENTS } from "@/knowledge/uiElementRegistry";
import { WALKTHROUGHS, validateWalkthrough } from "@/knowledge/walkthroughs";
import { SAFETY_REFUSALS } from "@/knowledge/safetyRefusal";
import { SAFE_ACTION_KINDS, FORBIDDEN_INTENTS } from "@/knowledge/actionRouter";
import { STATUS_REGISTRY } from "@/knowledge/statusRegistry";
import { auditKnowledge, compileKnowledge, suggestForGap } from "@/knowledge/knowledgeCompiler";
import { GLOSSARY } from "@/knowledge/glossary";
import { Link } from "wouter";
import { useRuntimeContext } from "@/assistant/useRuntimeContext";
import { diagnose, explainAppStatus } from "@/assistant/appDoctor";

interface FeedbackItem {
  feedbackId: string;
  title: string;
  category: string;
  route: string | null;
  whatHappened: string;
  status: string;
  createdAt: string;
}

export default function AssistantKnowledgeConsole() {
  const [items, setItems] = useState<FeedbackItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback");
      if (!res.ok) {
        setError(res.status === 403
          ? "Only TESTER, ADMIN, or OWNER roles can read recent assistant gaps."
          : `HTTP ${res.status}`);
        setItems([]);
        return;
      }
      const j = await res.json();
      const list: FeedbackItem[] = Array.isArray(j) ? j : (j?.items ?? []);
      setItems(list.filter((x) => (x.title ?? "").startsWith("[KB-MISS]")).slice(0, 20));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const stats = useMemo(() => {
    // RANK 74: this used to pass ROUTE_KNOWLEDGE's OWN route list, so `missing`
    // was always empty and the card always read N/N green while 59 declared
    // routes were undocumented. It measures against the real App.tsx route
    // table now (DECLARED_ROUTES, pinned to App.tsx by declaredRoutes.test.ts).
    const route = routeCoverage([...DECLARED_ROUTES]);
    const badge = badgeCoverage();
    const dupKbIds = duplicateIds(ARX_KNOWLEDGE.map((e) => e.id));
    const dupRouteIds = duplicateIds(ROUTE_KNOWLEDGE.map((r) => r.route));
    const dupElementIds = duplicateIds(UI_ELEMENTS.map((e) => e.id));
    const invalidUiRoutes = UI_ELEMENTS.filter(
      (e) => e.relatedRoute && !resolveRoute(e.relatedRoute),
    );
    const invalidStatusRoutes = STATUS_REGISTRY.filter(
      (s) => s.related && !resolveRoute(s.related.route),
    );
    const walkBad = WALKTHROUGHS.flatMap((w) => {
      const v = validateWalkthrough(w);
      return v.ok ? [] : v.missing.map((m) => `${w.id}: ${m}`);
    });
    return { route, badge, dupKbIds, dupRouteIds, dupElementIds, invalidUiRoutes, invalidStatusRoutes, walkBad };
  }, []);

  const audit = useMemo(() => auditKnowledge(), []);
  const compiled = useMemo(() => compileKnowledge(), []);
  const suggestions = useMemo(() => {
    const s: ReturnType<typeof suggestForGap>[] = [];
    audit.routesMissing.slice(0, 5).forEach((r) => s.push(suggestForGap("route", r)));
    audit.badgesMissing.slice(0, 5).forEach((b) => s.push(suggestForGap("badge", b)));
    audit.invalidElementRoutes.slice(0, 5).forEach((e) => s.push(suggestForGap("element", e)));
    return s;
  }, [audit]);

  return (
    <div className="container mx-auto space-y-4 max-w-4xl" data-testid="assistant-knowledge-console">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" /> Assistant Knowledge Console
          </h1>
          <p className="text-sm text-muted-foreground">Coverage + invariant checks for the ARX Assistant.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span className="ml-1">Refresh</span>
        </Button>
      </header>

      <div className="grid sm:grid-cols-2 gap-3">
        <StatCard label="Knowledge score" value={`${audit.score}/100`} bad={audit.score < 80} hint={`Compiled ${compiled.length} items · ${GLOSSARY.length} glossary terms · ${WALKTHROUGHS.length} walkthroughs`} testId="kc-knowledge-score" />
        <StatCard label="Weak items (<50%)" value={String(audit.weakItems.length)} bad={audit.weakItems.length > 0} hint={audit.weakItems.slice(0, 3).map((w) => w.id).join(", ") || "—"} testId="kc-weak-items" />
        <StatCard label="Invalid links" value={String(audit.invalidLinks.length)} bad={audit.invalidLinks.length > 0} hint={audit.invalidLinks.slice(0, 3).join(", ") || "All compiled routes resolve."} testId="kc-invalid-links" />
        <StatCard label="Route coverage" value={`${stats.route.covered}/${stats.route.total}`} bad={stats.route.missing.length > 0} hint={stats.route.missing.join(", ") || `${stats.route.weak.length} weak entries.`} />
        <StatCard label="Badge coverage" value={`${REQUIRED_BADGES.length - stats.badge.missing.length}/${REQUIRED_BADGES.length}`} bad={stats.badge.missing.length > 0} hint={stats.badge.missing.join(", ") || "All required badges documented."} />
        <StatCard label="UI element registry" value={String(UI_ELEMENTS.length)} hint={`Routes referenced: ${UI_ELEMENTS.filter((e) => e.relatedRoute).length}, invalid: ${stats.invalidUiRoutes.length}`} bad={stats.invalidUiRoutes.length > 0} />
        <StatCard label="Status registry" value={String(STATUS_REGISTRY.length)} hint={`Invalid related routes: ${stats.invalidStatusRoutes.length}`} bad={stats.invalidStatusRoutes.length > 0} />
        <StatCard label="Walkthroughs" value={`${WALKTHROUGHS.length} / ${stats.walkBad.length === 0 ? "valid" : `${stats.walkBad.length} issues`}`} bad={stats.walkBad.length > 0} hint={stats.walkBad.slice(0, 3).join("; ")} />
        <StatCard label="Refusal patterns" value={String(SAFETY_REFUSALS.reduce((n, r) => n + r.patterns.length, 0))} hint={`${SAFETY_REFUSALS.length} refusal categories`} />
        <StatCard label="Safe action kinds" value={String(SAFE_ACTION_KINDS.length)} hint="Whitelist enforced in classifyAction" />
        <StatCard label="Forbidden intents" value={String(FORBIDDEN_INTENTS.length)} hint="Catalogued for tests + audits" />
        <StatCard label="Duplicate KB ids" value={String(stats.dupKbIds.length)} bad={stats.dupKbIds.length > 0} hint={stats.dupKbIds.join(", ") || "—"} />
        <StatCard label="Duplicate element ids" value={String(stats.dupElementIds.length)} bad={stats.dupElementIds.length > 0} hint={stats.dupElementIds.join(", ") || "—"} />
      </div>

      <section className="rounded-md border bg-card/50 p-3">
        <h2 className="text-sm font-semibold mb-2">Recent assistant gaps (last 20)</h2>
        {error && <p className="text-xs text-warning">{error}</p>}
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        {items && items.length === 0 && !error && (
          <p className="text-xs text-muted-foreground">No gaps logged.</p>
        )}
        {items && items.length > 0 && (
          <ul className="space-y-1.5">
            {items.map((it) => (
              <li key={it.feedbackId} className="text-xs border border-border/50 rounded p-2">
                <div className="font-mono text-[10px] text-muted-foreground">{it.route ?? "(no route)"} · {new Date(it.createdAt).toLocaleString()}</div>
                <div className="font-medium">{it.title.replace(/^\[KB-MISS\]\s*/, "")}</div>
                <div className="text-muted-foreground">{it.whatHappened}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {suggestions.length > 0 && (
        <section className="rounded-md border bg-card/50 p-3" data-testid="kc-suggestions">
          <h2 className="text-sm font-semibold mb-2">Knowledge gap suggestions (drafts)</h2>
          <ul className="space-y-1.5">
            {suggestions.map((s, i) => (
              <li key={`${s.type}-${i}`} className="text-xs border border-border/50 rounded p-2">
                <div className="font-mono text-[10px] text-muted-foreground">{s.type} · status: {s.status}</div>
                <div className="font-medium">{s.suggestedTitle}</div>
                <div className="text-muted-foreground">{s.draftExplanation}</div>
                <div className="text-[10px] text-warning/90 italic">Safety draft: {s.draftSafety}</div>
                <div className="text-[10px] text-muted-foreground">Reason: {s.reason}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex gap-2">
        <Link href="/assistant-manual" className="text-xs underline" data-testid="kc-open-manual">Open Assistant App Manual →</Link>
        <Link href="/assistant-knowledge-gaps" className="text-xs underline">Open Knowledge Gaps →</Link>
      </div>

      {/* TESTER+ only — gated by /api/feedback above (error => denied). */}
      {!error && <RuntimeDiagnosticsPanel />}

      <p className="text-[10px] text-muted-foreground italic">
        Coverage stats are deterministic — they read directly from the knowledge modules, not the network.
      </p>
    </div>
  );
}

function StatCard({ label, value, hint, bad, testId }: { label: string; value: string; hint?: string; bad?: boolean; testId?: string }) {
  return (
    <div className={`rounded-md border p-3 ${bad ? "border-danger/40 bg-danger/5" : "border-border bg-card/40"}`} data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${bad ? "text-danger" : ""}`}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-3">{hint}</div>}
    </div>
  );
}

function RuntimeDiagnosticsPanel() {
  const ctx = useRuntimeContext();
  const status = useMemo(() => explainAppStatus(ctx), [ctx]);
  const all = useMemo(() => diagnose(ctx), [ctx]);
  return (
    <section className="rounded-md border bg-card/50 p-3" data-testid="kc-runtime-diagnostics">
      <h2 className="text-sm font-semibold mb-2">Runtime Diagnostics</h2>
      <div className="grid sm:grid-cols-2 gap-3 text-xs">
        <div className="rounded border border-border/60 p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Health summary</div>
          <pre className="mt-1 max-h-40 overflow-auto text-[10px]" data-testid="kc-rd-health">
            {ctx.health ? JSON.stringify(ctx.health, null, 2) : "loading…"}
          </pre>
        </div>
        <div className="rounded border border-border/60 p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Bridge diagnostic</div>
          <pre className="mt-1 max-h-40 overflow-auto text-[10px]" data-testid="kc-rd-bridge">
            {ctx.bridge ? JSON.stringify(ctx.bridge, null, 2) : "loading…"}
          </pre>
        </div>
        <div className="rounded border border-border/60 p-2 sm:col-span-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Runtime context (safe)</div>
          <div className="mt-1 grid grid-cols-2 gap-2 text-[10px]">
            <div>route: <code>{ctx.route}</code></div>
            <div>viewport: {ctx.viewport}</div>
            <div>trading mode: {ctx.tradingMode}</div>
            <div>visible elements: {ctx.visibleElements.length}</div>
            <div>visible badges: {ctx.visibleBadges.length}</div>
            <div>active locks: {ctx.activeSafetyLocks.length}</div>
            <div>recent errors: {ctx.recentErrors.length}</div>
            <div>failed endpoints: {ctx.recentFailedEndpoints.length}</div>
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground">Safety locks: {ctx.activeSafetyLocks.join(" · ") || "—"}</div>
        </div>
        <div className="rounded border border-border/60 p-2 sm:col-span-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Latest doctor diagnoses</div>
          <div className="mt-1 text-[11px]" data-testid="kc-rd-status">Mode: <strong>{status.mode}</strong> · Why live unavailable: {status.whyLiveUnavailable}</div>
          <ul className="mt-2 space-y-1 text-[11px]" data-testid="kc-rd-diagnoses">
            {all.slice(0, 5).map((d) => (
              <li key={d.id} className="border border-border/40 rounded p-1.5">
                <span className="font-mono text-[10px] text-muted-foreground">[{d.category}]</span> {d.explanation}
                <div className="text-[10px] text-success/90">→ {d.safeNextStep}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground italic mt-2">
        No tokens, secrets, or broker credentials are collected. Live trading and broker execution remain server-enforced OFF.
      </p>
    </section>
  );
}

function duplicateIds(ids: string[]): string[] {
  const seen = new Map<string, number>();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
}
