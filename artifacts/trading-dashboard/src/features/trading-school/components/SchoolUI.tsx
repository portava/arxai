/**
 * Trading School — shared presentational components.
 * No business logic; these render content passed to them. Ruby's teacher card
 * reuses the RubyAvatar character so Ruby is consistent with the rest of ARX.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useAssistantName } from "@/lib/assistant-name";
import { RubyAvatar } from "@/components/ruby/RubyAvatar";
import type { RubyExplanation, RubyMode } from "../data/content";
import { Sparkles, GraduationCap, Lock, CheckCircle2 } from "lucide-react";

const RUBY_OPEN_KEY = "arx.assistant.open.v2";
export function askRuby() {
  try {
    sessionStorage.setItem(RUBY_OPEN_KEY, "1");
    window.dispatchEvent(new StorageEvent("storage", { key: RUBY_OPEN_KEY }));
  } catch { /* noop */ }
}

/** Ruby teacher card with the three explanation modes (Simple / Normal / Pro). */
export function RubyTeacherCard({ ruby, title }: { ruby: RubyExplanation; title?: string }) {
  const { name } = useAssistantName();
  const resolvedTitle = title ?? `${name} explains`;
  const [mode, setMode] = useState<RubyMode>("simple");
  const modes: { key: RubyMode; label: string }[] = [
    { key: "simple", label: "Explain like I'm 12" },
    { key: "normal", label: "Normal" },
    { key: "pro", label: "Pro" },
  ];
  return (
    <div className="rounded-2xl border border-ruby/25 bg-card p-4">
      <div className="mb-3 flex items-center gap-2.5">
        <RubyAvatar state="thinking" size="md" ariaHidden />
        <div>
          <div className="text-sm font-semibold text-foreground">{resolvedTitle}</div>
          <div className="text-[11px] text-txt-muted">Pick a level that suits you</div>
        </div>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {modes.map((m) => (
          <button key={m.key} onClick={() => setMode(m.key)}
            className={cn("rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
              mode === m.key ? "border-ruby/50 bg-ruby/15 text-ruby" : "border-border bg-background/40 text-txt-secondary hover:border-ruby/30")}>
            {m.label}
          </button>
        ))}
      </div>
      <p className="text-sm leading-relaxed text-txt-secondary">{ruby[mode]}</p>
      <button onClick={askRuby}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-1.5 text-xs font-medium text-ruby hover:bg-ruby/20">
        <Sparkles className="h-3.5 w-3.5" /> Ask {name} to explain more
      </button>
    </div>
  );
}

export function SchoolPageHeader({ title, subtitle, icon: Icon = GraduationCap }: { title: string; subtitle?: string; icon?: any }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-ruby/10 text-ruby ring-1 ring-ruby/25">
        <Icon className="h-6 w-6" />
      </span>
      <div>
        <h1 className="text-2xl font-bold leading-tight">{title}</h1>
        {subtitle && <p className="text-sm text-txt-secondary">{subtitle}</p>}
      </div>
    </div>
  );
}

export function StepStatusPill({ status }: { status: "locked" | "in-progress" | "complete" }) {
  if (status === "complete") return (
    <span className="inline-flex items-center gap-1 rounded-md border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-success">
      <CheckCircle2 className="h-3 w-3" /> Complete
    </span>
  );
  if (status === "locked") return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/40 px-1.5 py-0.5 text-[10px] font-semibold text-txt-muted">
      <Lock className="h-3 w-3" /> Locked
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
      In progress
    </span>
  );
}

/** Calm, woven-in education disclaimer (not an alarming banner). */
export function SchoolDisclaimer({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <p className={cn("text-txt-muted", compact ? "text-[11px]" : "text-xs leading-relaxed")}>
      {text}
    </p>
  );
}

/** Clean empty state for labs/sections that aren't interactive yet. */
export function ComingNextState({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-background/40 p-6 text-center">
      <RubyAvatar state="idle" size="lg" ariaHidden />
      <div className="mt-3 text-sm font-semibold text-foreground">{title}</div>
      <p className="mx-auto mt-1 max-w-md text-xs text-txt-muted">{blurb}</p>
      <span className="mt-3 inline-flex rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">Coming next</span>
    </div>
  );
}
