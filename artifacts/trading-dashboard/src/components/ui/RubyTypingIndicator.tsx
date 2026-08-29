import { cn } from "@/lib/utils";
import { useAssistantName, DEFAULT_ASSISTANT_NAME } from "@/lib/assistant-name";

export type RubyState = "thinking" | "typing" | "usingTool" | "listening" | "transcribing" | "speaking" | "error";

export interface RubyTypingIndicatorProps {
  state: RubyState;
  /** Friendly contextual text override, e.g. "Ruby is reviewing your performance". */
  contextText?: string;
  className?: string;
  testId?: string;
}

function defaultLabel(name: string): Record<RubyState, string> {
  return {
    thinking:     `${name} is thinking`,
    typing:       `${name} is typing`,
    usingTool:    `${name} is checking`,
    listening:    `${name} is listening`,
    transcribing: `${name} is understanding you`,
    speaking:     `${name} is speaking`,
    error:        `${name} ran into a problem`,
  };
}

/**
 * Animated three-dot indicator with friendly status text.
 *
 * Replaces raw internal tool/function chips (getMyPerformanceSummary etc.)
 * in the user-facing chat. Internal tool names should only ever appear in
 * an admin/dev debug drawer, never in normal chat output.
 *
 * The dots animation uses Tailwind's built-in `animate-bounce` with
 * per-dot delays so it is dependency-free and SSR-safe.
 */
export function RubyTypingIndicator(props: RubyTypingIndicatorProps) {
  const { name } = useAssistantName();
  const { state, contextText, className, testId } = props;
  const label = contextText ?? defaultLabel(name)[state];
  const ariaLabel = `${label}…`;

  return (
    <div
      className={cn("inline-flex items-center gap-1.5 text-xs text-premium", className)}
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      data-testid={testId ?? "ruby-typing-indicator"}
      data-ruby-state={state}
    >
      <span className="font-medium">{label}</span>
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-premium animate-bounce" style={{ animationDelay: "0ms" }} />
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-premium animate-bounce" style={{ animationDelay: "150ms" }} />
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-premium animate-bounce" style={{ animationDelay: "300ms" }} />
      </span>
    </div>
  );
}

/**
 * Map an internal tool/function name (e.g. `getMyPerformanceSummary`) to a
 * user-friendly contextual line. Unknown tools fall back to "Ruby is
 * checking" so the user never sees a raw identifier.
 */
export function friendlyToolText(toolName: string, name: string = DEFAULT_ASSISTANT_NAME): string {
  const n = toolName.toLowerCase();
  if (n.includes("performance"))   return `${name} is reviewing your performance`;
  if (n.includes("scanner"))       return `${name} is reading the scanner`;
  if (n.includes("position"))      return `${name} is reviewing your open trades`;
  if (n.includes("trade") && n.includes("log")) return `${name} is reviewing your trade history`;
  if (n.includes("market") || n.includes("quote") || n.includes("candle")) return `${name} is checking market data`;
  if (n.includes("risk"))          return `${name} is checking your risk limits`;
  if (n.includes("mentor") || n.includes("memory")) return `${name} is checking your notes`;
  if (n.includes("mt5") || n.includes("bridge") || n.includes("heartbeat")) return `${name} is checking your connection`;
  if (n.includes("alert"))         return `${name} is checking your alerts`;
  if (n.includes("validate") || n.includes("safety")) return `${name} is running a safety check`;
  if (n.includes("execute") || n.includes("intent") || n.includes("order")) return `${name} is preparing the trade plan`;
  return `${name} is checking`;
}
