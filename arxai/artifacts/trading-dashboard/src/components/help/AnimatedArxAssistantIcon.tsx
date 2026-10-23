/**
 * AnimatedArxAssistantIcon
 *
 * Premium animated icon for the floating Ruby assistant trigger.
 * Pure CSS + SVG — no external animation libraries, no network calls.
 *
 * Motion states (drives shape/animation):
 *   - idle:     glowing AI-core orb
 *   - hover:    stronger glow + particle bloom
 *   - opening:  orb morphs into chat bubble
 *   - open:     final chat bubble with ARX mark
 *   - closing:  bubble morphs back to orb
 *   - thinking: rotating cyan ring (assistant generating)
 *   - typing:   three-dot wave inside bubble (assistant streaming/typing)
 *   - ready:    one-shot soft cyan pulse (answer ready)
 *   - disabled: desaturated/dimmed (assistant unavailable)
 *
 * Status overlay (independent ring around the icon):
 *   - none:     no ring
 *   - warning:  amber ring (app blockers detected — NOT live-trading readiness)
 *   - error:    red ring (assistant or system failure)
 *
 * Honors `prefers-reduced-motion` (CSS) — locks shape to "open", disables
 * all looped animations. Status rings still render statically so warning/
 * error remains discoverable without motion.
 */
import { useEffect, useState } from "react";
import { useAssistantName } from "@/lib/assistant-name";
import "./AnimatedArxAssistantIcon.css";

export type ArxAssistantIconState =
  | "idle"
  | "hover"
  | "opening"
  | "open"
  | "closing"
  | "thinking"
  | "typing"
  | "ready"
  | "disabled";

export type ArxAssistantIconStatus = "none" | "warning" | "error";

export interface AnimatedArxAssistantIconProps {
  state?: ArxAssistantIconState;
  status?: ArxAssistantIconStatus;
  size?: number;
  className?: string;
  /** Decorative-only when paired with an external aria-label. */
  ariaHidden?: boolean;
  /** Optional test id (defaults to "arx-aicon"). */
  testId?: string;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

export function AnimatedArxAssistantIcon({
  state = "idle",
  status = "none",
  size = 28,
  className,
  ariaHidden = true,
  testId = "arx-aicon",
}: AnimatedArxAssistantIconProps) {
  const reduced = usePrefersReducedMotion();
  // When reduced motion is on, lock to a static "open" bubble — recognisable, no motion.
  // Exception: keep "disabled" so a muted assistant remains visibly muted.
  const effective: ArxAssistantIconState =
    reduced && state !== "disabled" ? "open" : state;

  const showBubble =
    effective === "open" ||
    effective === "opening" ||
    effective === "thinking" ||
    effective === "typing" ||
    effective === "ready";

  return (
    <span
      className={`arx-aicon ${className ?? ""}`}
      data-state={effective}
      data-status={status}
      data-testid={testId}
      style={{ width: size, height: size }}
      aria-hidden={ariaHidden}
    >
      <svg
        viewBox="0 0 32 32"
        width={size}
        height={size}
        role="img"
        focusable="false"
      >
        <defs>
          <radialGradient id="arx-aicon-orb" cx="50%" cy="45%" r="55%">
            <stop offset="0%" stopColor="#7dd3fc" stopOpacity="1" />
            <stop offset="55%" stopColor="#0ea5e9" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#082f49" stopOpacity="1" />
          </radialGradient>
          <radialGradient id="arx-aicon-aura-grad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.55" />
            <stop offset="60%" stopColor="#0ea5e9" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="arx-aicon-stroke" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#67e8f9" />
            <stop offset="100%" stopColor="#0284c7" />
          </linearGradient>
          <filter id="arx-aicon-blur" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.2" />
          </filter>
        </defs>

        {/* Aura halo */}
        <circle
          className="arx-aicon-aura"
          cx="16" cy="16" r="14"
          fill="url(#arx-aicon-aura-grad)"
          filter="url(#arx-aicon-blur)"
        />

        {/* Orbiting connection dots (idle) */}
        <g className="arx-aicon-orbit" opacity={effective === "idle" || effective === "hover" ? 1 : 0}>
          <circle cx="16" cy="3.5" r="0.9" fill="#67e8f9" opacity="0.85" />
          <circle cx="28.5" cy="16" r="0.7" fill="#67e8f9" opacity="0.6" />
          <circle cx="16" cy="28.5" r="0.5" fill="#67e8f9" opacity="0.45" />
        </g>

        {/* Core: orb (idle/hover) OR rounded chat bubble (opening/open/...). */}
        <g className="arx-aicon-core">
          {/* Orb body — visible when not bubble-state */}
          <circle
            cx="16" cy="16" r="9"
            fill="url(#arx-aicon-orb)"
            stroke="url(#arx-aicon-stroke)"
            strokeWidth="0.8"
            opacity={showBubble ? 0 : 1}
            style={{ transition: "opacity 220ms ease" }}
          />
          {/* Chat bubble body — visible during bubble states */}
          <path
            d="M7 11.5
               a4 4 0 0 1 4 -4
               h10
               a4 4 0 0 1 4 4
               v6.5
               a4 4 0 0 1 -4 4
               h-7.2
               l-3.4 2.8
               a0.4 0.4 0 0 1 -0.65 -0.31
               v-2.49
               h-2.75
               a4 4 0 0 1 -4 -4
               z"
            fill="url(#arx-aicon-orb)"
            stroke="url(#arx-aicon-stroke)"
            strokeWidth="0.8"
            opacity={showBubble ? 1 : 0}
            style={{ transition: "opacity 220ms ease" }}
          />

          {/* Inner glint — always present for premium feel */}
          <ellipse cx="13" cy="12.5" rx="2.4" ry="1.5" fill="#e0f2fe" opacity="0.55" />
        </g>

        {/* Mini candlesticks — visible during idle/hover, hidden when open */}
        <g className="arx-aicon-candles" opacity={showBubble ? 0 : 1}
           style={{ transition: "opacity 280ms ease" }}>
          {/* Candle 1 — bearish red (left) */}
          <line x1="10.5" y1="10.5" x2="10.5" y2="13" stroke="#f87171" strokeWidth="0.5" strokeLinecap="round" />
          <rect x="9.2" y="13" width="2.6" height="3.8" rx="0.3" fill="#f87171" opacity="0.9" />
          <line x1="10.5" y1="16.8" x2="10.5" y2="19" stroke="#f87171" strokeWidth="0.5" strokeLinecap="round" />

          {/* Candle 2 — bullish green (middle) */}
          <line x1="14.5" y1="9" x2="14.5" y2="12" stroke="#4ade80" strokeWidth="0.5" strokeLinecap="round" />
          <rect x="13.2" y="12" width="2.6" height="5" rx="0.3" fill="#4ade80" opacity="0.9" />
          <line x1="14.5" y1="17" x2="14.5" y2="19.5" stroke="#4ade80" strokeWidth="0.5" strokeLinecap="round" />

          {/* Candle 3 — bullish green (right, tallest — trending up) */}
          <line x1="18.5" y1="8"  x2="18.5" y2="11" stroke="#4ade80" strokeWidth="0.5" strokeLinecap="round" />
          <rect x="17.2" y="11" width="2.6" height="6.5" rx="0.3" fill="#4ade80" opacity="0.9" />
          <line x1="18.5" y1="17.5" x2="18.5" y2="20" stroke="#4ade80" strokeWidth="0.5" strokeLinecap="round" />

          {/* Candle 4 — small doji (far right, uncertainty) */}
          <line x1="22.5" y1="11" x2="22.5" y2="13" stroke="#67e8f9" strokeWidth="0.5" strokeLinecap="round" />
          <rect x="21.2" y="13" width="2.6" height="1.2" rx="0.3" fill="#67e8f9" opacity="0.85" />
          <line x1="22.5" y1="14.2" x2="22.5" y2="16" stroke="#67e8f9" strokeWidth="0.5" strokeLinecap="round" />
        </g>

        {/* Bubble tail — fades in with bubble */}
        <path
          className="arx-aicon-tail"
          d="M11 22 l-2.4 2.6 a0.4 0.4 0 0 1 -0.65 -0.31 v-2.49 z"
          fill="url(#arx-aicon-orb)"
          stroke="url(#arx-aicon-stroke)"
          strokeWidth="0.8"
        />

        {/* ARX wordmark — visible only when bubble is forming/open/ready */}
        <g className="arx-aicon-mark">
          <text
            x="16" y="17.4"
            textAnchor="middle"
            fontFamily="ui-sans-serif, system-ui, sans-serif"
            fontWeight="800"
            fontSize="6.4"
            letterSpacing="0.5"
            fill="#f0f9ff"
          >ARX</text>
        </g>

        {/* Thinking ring — rotating cyan dashed arc when state="thinking" */}
        <g className="arx-aicon-think-ring">
          <circle
            cx="16" cy="16" r="11.5"
            fill="none"
            stroke="#22d3ee"
            strokeWidth="1.1"
            strokeDasharray="6 4"
            strokeLinecap="round"
            opacity="0.9"
          />
        </g>

        {/* Typing dots — three glowing dots inside bubble when state="typing" */}
        <g>
          <circle className="arx-aicon-typing-dot d1" cx="12.5" cy="16" r="1.1" fill="#e0f2fe" />
          <circle className="arx-aicon-typing-dot d2" cx="16"   cy="16" r="1.1" fill="#e0f2fe" />
          <circle className="arx-aicon-typing-dot d3" cx="19.5" cy="16" r="1.1" fill="#e0f2fe" />
        </g>

        {/* Status ring (warning/error) — independent of motion state */}
        <circle className="arx-aicon-status-ring" cx="16" cy="16" r="14.5" />

        {/* Hover/tap particles */}
        <circle className="arx-aicon-particle p1" cx="22" cy="9"  r="0.9" fill="#a5f3fc" style={{ ["--dx" as never]: "6px", ["--dy" as never]: "-8px" } as React.CSSProperties} />
        <circle className="arx-aicon-particle p2" cx="9"  cy="10" r="0.7" fill="#a5f3fc" style={{ ["--dx" as never]: "-7px", ["--dy" as never]: "-6px" } as React.CSSProperties} />
        <circle className="arx-aicon-particle p3" cx="24" cy="22" r="0.6" fill="#a5f3fc" style={{ ["--dx" as never]: "8px",  ["--dy" as never]: "6px"  } as React.CSSProperties} />
      </svg>
    </span>
  );
}

// ─── Composite icon-state hook ────────────────────────────────────────────────
//
// Aggregates the assistant's runtime signals into ONE composite (state, status).
// Pure derivation — no side effects, no fetches.
//
// Inputs (all optional):
//   open               panel open?
//   hover              trigger hovered?
//   opening            brief morph window before panel mounts?
//   thinking           assistant currently generating an answer?
//   typing             assistant currently streaming text?
//   readyAt            timestamp of latest "answer ready" (drives ready pulse)
//   error              boolean — assistant/system failure
//   disabled           boolean — assistant unavailable
//   blockerCount       number of active app blockers (drives warning ring)
//
// Output:
//   state    -> motion state for icon
//   status   -> "warning" | "error" | "none" (overlay ring)
//   ariaLabel-> dynamic aria-label for the trigger button
//   tooltip  -> short hint string (desktop tooltip)
//
export interface AssistantIconStateInputs {
  open: boolean;
  hover?: boolean;
  opening?: boolean;
  thinking?: boolean;
  typing?: boolean;
  readyAt?: number | null;
  error?: boolean;
  disabled?: boolean;
  blockerCount?: number;
}

export interface AssistantIconStateOutputs {
  state: ArxAssistantIconState;
  status: ArxAssistantIconStatus;
  ariaLabel: string;
  tooltip: string;
}

const READY_PULSE_MS = 900;

export function useAssistantIconState(inputs: AssistantIconStateInputs): AssistantIconStateOutputs {
  const { name } = useAssistantName();
  const { open, hover, opening, thinking, typing, readyAt, error, disabled, blockerCount = 0 } = inputs;

  // Decay "ready" pulse after READY_PULSE_MS so it triggers a one-shot animation.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!readyAt) return;
    const remaining = Math.max(0, READY_PULSE_MS - (Date.now() - readyAt));
    if (remaining === 0) return;
    const t = window.setTimeout(() => setNow(Date.now()), remaining);
    return () => window.clearTimeout(t);
  }, [readyAt]);
  const readyActive = !!readyAt && (now - readyAt) < READY_PULSE_MS;

  // Status overlay (warning is for app blockers — NEVER live-trading readiness).
  const status: ArxAssistantIconStatus = error
    ? "error"
    : blockerCount > 0
      ? "warning"
      : "none";

  // Motion state — order of precedence: disabled > thinking/typing > ready > open/hover/opening > idle.
  let state: ArxAssistantIconState;
  if (disabled) state = "disabled";
  else if (thinking) state = "thinking";
  else if (typing) state = "typing";
  else if (readyActive) state = "ready";
  else if (open) state = "open";
  else if (opening) state = "opening";
  else if (hover) state = "hover";
  else state = "idle";

  // Dynamic aria-label & tooltip. NEVER reference live-trading from these strings.
  let ariaLabel = `Open ${name}`;
  let tooltip = `${name} — ask anything about this app`;
  if (disabled) {
    ariaLabel = `${name} unavailable`;
    tooltip = "Assistant unavailable";
  } else if (error) {
    ariaLabel = `${name} error — open to retry`;
    tooltip = "Assistant error — tap to retry";
  } else if (thinking) {
    ariaLabel = `${name} is thinking`;
    tooltip = "Thinking…";
  } else if (typing) {
    ariaLabel = `${name} is responding`;
    tooltip = "Responding…";
  } else if (open) {
    ariaLabel = `Close ${name}`;
    tooltip = "Close assistant";
  } else if (status === "warning") {
    ariaLabel = `${name} — ${blockerCount} blocker${blockerCount === 1 ? "" : "s"} detected, open to review`;
    tooltip = "Blockers detected — ask why";
  }

  return { state, status, ariaLabel, tooltip };
}

export default AnimatedArxAssistantIcon;
