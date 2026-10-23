/**
 * Trading School — Glossary. Searchable list of plain-English trading terms,
 * each with a simple definition, example, related lesson link, and Ask Ruby.
 * Renders inside AppLayout.
 */
import { useMemo, useState, type ChangeEvent } from "react";
import { Link } from "wouter";
import { GLOSSARY, STEPS } from "../data/content";
import { SchoolPageHeader, askRuby } from "../components/SchoolUI";
import { ScrollText, Search, Sparkles, ChevronRight } from "lucide-react";
import { useAssistantName } from "@/lib/assistant-name";

export default function TradingSchoolGlossary() {
  const { name } = useAssistantName();
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return GLOSSARY;
    return GLOSSARY.filter((g) => g.term.toLowerCase().includes(t) || g.simple.toLowerCase().includes(t));
  }, [q]);

  return (
    <div className="mx-auto w-full max-w-[900px] space-y-4 p-4 md:p-6 pb-32 md:pb-6" data-testid="page-school-glossary">
      <SchoolPageHeader title="Glossary" subtitle="Every trading word explained simply, with an example." icon={ScrollText} />

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-muted" />
        <input
          value={q} onChange={(e: ChangeEvent<HTMLInputElement>) => setQ(e.target.value)}
          placeholder="Search terms (e.g. spread, stop-loss, leverage)…"
          className="w-full rounded-xl border border-border bg-card py-2.5 pl-9 pr-3 text-sm text-foreground placeholder:text-txt-muted focus:border-primary/40 focus:outline-none"
          data-testid="glossary-search"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-background/40 p-6 text-center text-sm text-txt-muted">No terms match “{q}”. Try a simpler word.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {filtered.map((g) => {
            const step = g.relatedStep ? STEPS.find((s) => s.number === g.relatedStep) : null;
            return (
              <div key={g.term} className="rounded-2xl border border-border bg-card p-4">
                <div className="text-sm font-semibold text-foreground">{g.term}</div>
                <p className="mt-0.5 text-sm text-txt-secondary">{g.simple}</p>
                <p className="mt-1 text-xs text-txt-muted"><span className="font-medium text-txt-secondary">Example:</span> {g.example}</p>
                <div className="mt-2 flex items-center gap-2">
                  {step && (
                    <Link href={`/school/lesson/${step.id}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      Step {step.number} <ChevronRight className="h-3 w-3" />
                    </Link>
                  )}
                  <button onClick={askRuby} className="inline-flex items-center gap-1 text-xs text-ruby hover:underline">
                    <Sparkles className="h-3 w-3" /> Ask {name}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
