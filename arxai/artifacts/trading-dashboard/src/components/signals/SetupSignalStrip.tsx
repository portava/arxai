import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  governanceSignal,
  momentumSignal,
  formatSignalScore,
  type SignalTone,
} from "@/lib/setup-preview";

// SetupSignalStrip (Task #382 / #383) — the compact, glanceable readout of the
// real per-read signals: scanner score, per-symbol risk score, flame/run-on
// momentum, and a plain-English team-governance chip. Shared verbatim by the
// chart AI setup-preview card and the scanner scalp/signal cards so a trader
// gets the same honest "why" everywhere it appears.
//
// HONESTY: every figure is a REAL producer output, read straight from data the
// surface already received. When the backend left a signal null ("not
// consulted") the strip NEVER fabricates a value — it either shows an honest
// "not consulted" placeholder or hides the chip (per `nullBehavior`).

function toneClass(tone: SignalTone): string {
  switch (tone) {
    case "good": return "text-emerald-300 border-emerald-500/40";
    case "caution": return "text-amber-300 border-amber-500/40";
    case "bad": return "text-rose-300 border-rose-500/40";
    default: return "text-zinc-300 border-zinc-600/40";
  }
}

// One signal in the glanceable strip. Renders a real value chip, or — when the
// backend left the signal null — an honest muted "not consulted" placeholder
// (`nullBehavior="placeholder"`) or nothing at all (`nullBehavior="hide"`).
// Never a fabricated value.
//
// Each chip carries a hover/tap tooltip (`help`) that explains what the signal
// MEASURES and how to read it — never the current reading itself, so the
// "not consulted" state stays honest (the explanation is true even with no value).
function SignalChip({
  label,
  value,
  tone,
  testid,
  nullBehavior,
  help,
}: {
  label: string;
  value: string | null;
  tone?: SignalTone;
  testid: string;
  nullBehavior: "placeholder" | "hide";
  /** One-line plain-English explanation of what the signal measures. */
  help: string;
}) {
  if (value == null) {
    if (nullBehavior === "hide") return null;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex cursor-help items-center gap-1 text-zinc-600"
            data-testid={`${testid}-not-consulted`}
          >
            <span className="uppercase tracking-wide text-zinc-600">{label}</span>
            <span className="italic">not consulted</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[16rem] text-[11px] leading-snug">
          {help}
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help items-center gap-1" data-testid={testid}>
          <span className="uppercase tracking-wide text-zinc-500">{label}</span>
          <Badge
            variant="outline"
            className={`h-4 px-1 text-[9px] ${toneClass(tone ?? "neutral")}`}
          >
            {value}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[16rem] text-[11px] leading-snug">
        {help}
      </TooltipContent>
    </Tooltip>
  );
}

/** The real per-read signals the strip surfaces — every field nullable and honest. */
export interface SetupSignalStripValues {
  scannerScore: number | null;
  riskScore: number | null;
  flameStage: string | null;
  runOnQuality: string | null;
  governanceOutcome: string | null;
}

export function SetupSignalStrip({
  signals,
  testIdPrefix,
  nullBehavior = "placeholder",
}: {
  signals: SetupSignalStripValues;
  /** Prefix for the strip + chip test ids, e.g. "chart-setup-signal". */
  testIdPrefix: string;
  /** How to treat a null (not-consulted) signal: placeholder text or hide it. */
  nullBehavior?: "placeholder" | "hide";
}) {
  const momentum = momentumSignal(signals.flameStage, signals.runOnQuality);
  const governance = governanceSignal(signals.governanceOutcome);

  const chips = (
    <>
      <SignalChip
        label="Scanner"
        value={formatSignalScore(signals.scannerScore)}
        tone="neutral"
        testid={`${testIdPrefix}-scanner`}
        nullBehavior={nullBehavior}
        help="How strongly the market scanner rates this setup right now — a higher score means a cleaner, higher-conviction pattern."
      />
      <SignalChip
        label="Risk"
        value={formatSignalScore(signals.riskScore)}
        tone="neutral"
        testid={`${testIdPrefix}-risk`}
        nullBehavior={nullBehavior}
        help="The per-symbol risk score for current conditions — a higher number means riskier (e.g. wider spread or choppier price), so lower is safer."
      />
      <SignalChip
        label="Momentum"
        value={momentum?.label ?? null}
        tone={momentum?.tone}
        testid={`${testIdPrefix}-momentum`}
        nullBehavior={nullBehavior}
        help="Where the move sits in its momentum lifecycle (developing run → running → run-on → runaway move → exhausted) — early stages favour the trend, late ones warn it may be fading."
      />
      <SignalChip
        label="Team"
        value={governance?.label ?? null}
        tone={governance?.tone}
        testid={`${testIdPrefix}-governance`}
        nullBehavior={nullBehavior}
        help="The agent team's plain-English verdict on this setup — advisory only: 'approves' backs it, 'steering away' cautions against it."
      />
    </>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-zinc-700/40 bg-zinc-900/30 px-2 py-1.5 text-[10px]"
        data-testid={`${testIdPrefix}-strip`}
      >
        {chips}
      </div>
    </TooltipProvider>
  );
}

export default SetupSignalStrip;
