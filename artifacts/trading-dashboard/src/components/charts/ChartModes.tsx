import { Suspense, lazy, useState } from "react";
import type { ChartIntelligenceResponse } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Eye,
  Sparkles,
  Zap,
  ShieldAlert,
  History,
  GraduationCap,
  Wrench,
  ChevronDown,
  ChevronUp,
  Loader2,
} from "lucide-react";
import { ChartPulse } from "@/components/charts/ChartPulse";
import { useTradingMode } from "@/hooks/useTradingMode";

// ChartModes — Chart Brain v2 (Task 3) mode organiser.
//
// Presents the Chart Intelligence State through a small set of modes so the
// chart is never cluttered with every overlay at once:
//   Clean   — chart only; pulse hidden; fastest.
//   AI      — pulse + full natural-language sentences.
//   Scalp   — pulse only; fast, quick-decision focused.
//   Risk    — pulse + sentences with the risk read up top.
//   Review  — not built yet: says it does not load the saved decision receipts
//             (they exist; this view just doesn't show them); paused in
//             live-shared mode.
//   Learning— not built yet: says it does not show chart memory or coaching;
//             paused in live-shared mode.
//   Admin   — operator-only raw diagnostics (gated; admin, not previewing).
//
// PERFORMANCE: the sentences and diagnostics bodies are React.lazy, so only the
// active mode's heavy content is ever mounted. Clean/Scalp never pull them in.
// SAFETY: pure display — no mode places, modifies, or closes a trade. Deep
// Review/Learning content does not run during live execution.

const ChartSentencesPanel = lazy(() =>
  import("@/components/charts/ChartSentencesPanel").then((m) => ({
    default: m.ChartSentencesPanel,
  })),
);
const ChartDiagnosticsPanel = lazy(() =>
  import("@/components/charts/ChartDiagnosticsPanel").then((m) => ({
    default: m.ChartDiagnosticsPanel,
  })),
);
const ChartRiskPanel = lazy(() =>
  import("@/components/charts/ChartReadPanels").then((m) => ({
    default: m.ChartRiskPanel,
  })),
);
const ChartScalpPanel = lazy(() =>
  import("@/components/charts/ChartReadPanels").then((m) => ({
    default: m.ChartScalpPanel,
  })),
);
const ChartEntryPanel = lazy(() =>
  import("@/components/charts/ChartReadPanels").then((m) => ({
    default: m.ChartEntryPanel,
  })),
);
const ChartExitPanel = lazy(() =>
  import("@/components/charts/ChartReadPanels").then((m) => ({
    default: m.ChartExitPanel,
  })),
);
const ChartAgentConsensusPanel = lazy(() =>
  import("@/components/charts/ChartReadPanels").then((m) => ({
    default: m.ChartAgentConsensusPanel,
  })),
);
const RubyDraftReadPanel = lazy(() =>
  import("@/components/charts/RubyDraftReadPanel").then((m) => ({
    default: m.RubyDraftReadPanel,
  })),
);

type ChartState = ChartIntelligenceResponse["state"];

type ChartMode =
  | "clean"
  | "ai"
  | "scalp"
  | "risk"
  | "review"
  | "learning"
  | "admin";

interface ModeDef {
  key: ChartMode;
  label: string;
  icon: typeof Eye;
}

const BASE_MODES: ModeDef[] = [
  { key: "clean", label: "Clean", icon: Eye },
  { key: "ai", label: "AI", icon: Sparkles },
  { key: "scalp", label: "Scalp", icon: Zap },
  { key: "risk", label: "Risk", icon: ShieldAlert },
  { key: "review", label: "Review", icon: History },
  { key: "learning", label: "Learning", icon: GraduationCap },
];

const LazyFallback = (
  <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-[11px] text-zinc-500">
    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
  </div>
);

function EmptyMode({
  title,
  body,
  testid,
}: {
  title: string;
  body: string;
  testid: string;
}) {
  return (
    <div
      className="rounded-md border border-zinc-800 bg-zinc-950/40 p-4 text-[11px] text-zinc-400"
      data-testid={testid}
    >
      <div className="font-semibold text-zinc-300">{title}</div>
      <p className="mt-1 text-zinc-500">{body}</p>
    </div>
  );
}

export function ChartModes({ state }: { state: ChartState | null }) {
  const [mode, setMode] = useState<ChartMode>("ai");
  const [collapsed, setCollapsed] = useState(false);
  const tm = useTradingMode();

  const canAdmin = tm.shouldShowAdminDiagnostics && !tm.isAdminPreviewingUserMode;
  const modes: ModeDef[] = canAdmin
    ? [...BASE_MODES, { key: "admin", label: "Diagnostics", icon: Wrench }]
    : BASE_MODES;

  // Deep modes are paused while the account is in live-shared mode. This is
  // keyed to the account mode, NOT to whether a live trade is open.
  const liveActive = tm.isLiveShared;

  return (
    <div className="space-y-2" data-testid="chart-modes">
      {/* Mode switcher — horizontally scrollable on mobile. */}
      <div className="flex items-center gap-2">
        <div
          className="flex flex-1 items-center gap-1 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950/40 p-1"
          role="tablist"
          aria-label="Chart modes"
        >
          {modes.map((m) => {
            const Icon = m.icon;
            const active = mode === m.key;
            return (
              <Button
                key={m.key}
                size="sm"
                variant={active ? "default" : "ghost"}
                className="h-7 shrink-0 px-2 text-[11px]"
                onClick={() => setMode(m.key)}
                role="tab"
                aria-selected={active}
                data-testid={`chart-mode-${m.key}`}
              >
                <Icon className="mr-1 h-3 w-3" /> {m.label}
              </Button>
            );
          })}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 px-2 text-[11px]"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          data-testid="chart-modes-collapse"
        >
          {collapsed ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {/* Active-mode body (collapsible for mobile / to keep execution controls
          accessible). Only the active mode mounts its content. */}
      {!collapsed && (
        <div data-testid={`chart-mode-body-${mode}`}>
          {mode === "clean" && (
            <EmptyMode
              title="Clean chart"
              body="Just the candles. Switch to AI, Scalp, or Risk to bring in the chart's read."
              testid="chart-mode-clean"
            />
          )}

          {mode === "scalp" && (
            <div className="space-y-2">
              <ChartPulse state={state} />
              <Suspense fallback={LazyFallback}>
                <ChartScalpPanel state={state} />
                <ChartEntryPanel state={state} />
              </Suspense>
            </div>
          )}

          {mode === "ai" && (
            <div className="space-y-2">
              <ChartPulse state={state} />
              <Suspense fallback={LazyFallback}>
                <ChartSentencesPanel state={state} />
                <ChartAgentConsensusPanel state={state} />
                {state && (
                  <RubyDraftReadPanel
                    symbol={state.symbol}
                    timeframe={state.timeframe}
                  />
                )}
              </Suspense>
            </div>
          )}

          {mode === "risk" && (
            <div className="space-y-2">
              <ChartPulse state={state} />
              <Suspense fallback={LazyFallback}>
                <ChartRiskPanel state={state} />
                <ChartExitPanel state={state} />
              </Suspense>
            </div>
          )}

          {mode === "review" &&
            (liveActive ? (
              <EmptyMode
                title="Review paused"
                body="Review is paused while your account is in live-shared mode (whether or not a trade is open). Clean, AI, Scalp and Risk still work."
                testid="chart-mode-review-paused"
              />
            ) : (
              <EmptyMode
                title="Review"
                body="This view isn't built yet: your saved decision receipts and session review are not loaded here, so an empty panel does not mean you have nothing to review."
                testid="chart-mode-review"
              />
            ))}

          {mode === "learning" &&
            (liveActive ? (
              <EmptyMode
                title="Learning paused"
                body="Learning is paused while your account is in live-shared mode (whether or not a trade is open). Clean, AI, Scalp and Risk still work."
                testid="chart-mode-learning-paused"
              />
            ) : (
              <EmptyMode
                title="Learning"
                body="This view isn't built yet: the chart memory the levels already use (remembered holds, breaks and retests) and coaching are not shown here, so an empty panel does not mean there is nothing to learn from."
                testid="chart-mode-learning"
              />
            ))}

          {mode === "admin" && canAdmin && (
            <Suspense fallback={LazyFallback}>
              <ChartDiagnosticsPanel state={state} />
            </Suspense>
          )}
        </div>
      )}
    </div>
  );
}

export default ChartModes;
