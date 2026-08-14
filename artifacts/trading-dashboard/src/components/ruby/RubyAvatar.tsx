/**
 * RubyAvatar — premium animated Ruby character avatar for ARX AI.
 *
 * Pure SVG + CSS. No external animation libs, no network/asset loads, no
 * business logic. The component is a *visual presence layer*: it receives the
 * current Ruby/app state as a prop and renders the matching animation. All
 * Ruby brain/chat/voice/memory wiring stays where it already lives — this only
 * draws the face.
 *
 * Built as a character-style bust (head + headset + ARX visor) so it reads as a
 * professional trading analyst, not a toy robot. Designed to be swapped for
 * final artwork later: replace the <RubyFace/> SVG and keep the ring/state
 * shell intact.
 *
 * Honors prefers-reduced-motion: continuous animations stop, the avatar locks
 * to a calm static state, and status is still conveyed by ring color + label.
 */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useAssistantName } from "@/lib/assistant-name";
import "./RubyAvatar.css";

export type RubyState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "analyzingMarket"
  | "riskWarning"
  | "success"
  | "disconnected"
  | "alert";

export type RubySize = "xs" | "sm" | "md" | "lg" | "xl";
export type RubyVariant = "floating" | "chat" | "card" | "inline" | "hero";

const SIZE_PX: Record<RubySize, number> = { xs: 28, sm: 36, md: 48, lg: 72, xl: 112 };

/** Accent token per state — color is never the *only* status signal (label + icon back it up). */
const STATE_ACCENT: Record<RubyState, string> = {
  idle: "var(--ruby, #C45BFF)",
  listening: "var(--primary, #2F8CFF)",
  thinking: "var(--ruby, #C45BFF)",
  speaking: "var(--ruby, #C45BFF)",
  analyzingMarket: "var(--primary, #2F8CFF)",
  riskWarning: "var(--warning, #FFCC4D)",
  success: "var(--success, #42E6A4)",
  disconnected: "var(--txt-muted, #6F7785)",
  alert: "var(--warning, #FFCC4D)",
};

function stateLabel(name: string): Record<RubyState, string> {
  return {
    idle: `${name} is ready`,
    listening: "Listening…",
    thinking: `${name} is thinking…`,
    speaking: `${name} is speaking`,
    analyzingMarket: `${name} is reading the market…`,
    riskWarning: `${name} has a risk note`,
    success: `${name} has a clear read`,
    disconnected: `${name} is offline`,
    alert: `${name} has an alert`,
  };
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

export interface RubyAvatarProps {
  state?: RubyState;
  size?: RubySize;
  variant?: RubyVariant;
  showLabel?: boolean;
  label?: string;
  subLabel?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  /** Decorative-only when an external accessible label exists. */
  ariaHidden?: boolean;
  testId?: string;
}

/* ---------- the face (swap this block for final artwork) ---------- */
function RubyFace({ accent }: { accent: string }) {
  return (
    <g className="ruby-face" aria-hidden="true">
      {/* head/bust silhouette */}
      <path
        d="M50 22c10.5 0 18 8.4 18 19.5 0 7.2-3 13.2-7.6 16.6 7.7 2.6 13.6 8.2 16.1 15.9H23.5c2.5-7.7 8.4-13.3 16.1-15.9C35 54.7 32 48.7 32 41.5 32 30.4 39.5 22 50 22Z"
        fill="url(#ruby-bust)"
        stroke={accent}
        strokeOpacity="0.55"
        strokeWidth="1.4"
      />
      {/* visor / interface band */}
      <path d="M38 39h24" stroke={accent} strokeWidth="2.2" strokeLinecap="round" className="ruby-visor" />
      {/* eyes */}
      <circle className="ruby-eye" cx="43" cy="42.5" r="2.1" fill={accent} />
      <circle className="ruby-eye" cx="57" cy="42.5" r="2.1" fill={accent} />
      {/* headset cups */}
      <rect x="27.5" y="36" width="5" height="12" rx="2.5" fill={accent} fillOpacity="0.85" />
      <rect x="67.5" y="36" width="5" height="12" rx="2.5" fill={accent} fillOpacity="0.85" />
      {/* mic boom */}
      <path d="M67 47c3 2 4 5.5 3.4 8.8" stroke={accent} strokeWidth="1.4" fill="none" strokeLinecap="round" opacity="0.8" />
      <circle cx="70.8" cy="56.4" r="1.4" fill={accent} />
    </g>
  );
}

export function RubyAvatar({
  state = "idle",
  size = "md",
  variant = "inline",
  showLabel = false,
  label,
  subLabel,
  onClick,
  disabled = false,
  className,
  ariaHidden = false,
  testId = "ruby-avatar",
}: RubyAvatarProps) {
  const { name } = useAssistantName();
  const reduced = usePrefersReducedMotion();
  const effective: RubyState = disabled ? "disconnected" : state;
  const accent = STATE_ACCENT[effective];
  const px = SIZE_PX[size];
  const resolvedLabel = label ?? stateLabel(name)[effective];

  const interactive = !!onClick && !disabled;
  const Wrapper: any = interactive ? "button" : "div";

  return (
    <Wrapper
      type={interactive ? "button" : undefined}
      onClick={interactive ? onClick : undefined}
      disabled={interactive ? disabled : undefined}
      aria-label={ariaHidden ? undefined : interactive ? `Open ${name} assistant` : resolvedLabel}
      aria-hidden={ariaHidden || undefined}
      data-testid={testId}
      data-state={effective}
      data-variant={variant}
      data-reduced={reduced ? "1" : "0"}
      className={cn(
        "ruby-avatar",
        interactive && "ruby-avatar--interactive",
        showLabel && "ruby-avatar--with-label",
        className,
      )}
      style={{ ["--ruby-accent" as any]: accent }}
    >
      <span className="ruby-avatar__ringwrap" style={{ width: px, height: px }}>
        {/* outer reactive ring(s) */}
        <span className="ruby-avatar__ring" aria-hidden="true" />
        <span className="ruby-avatar__ring ruby-avatar__ring--2" aria-hidden="true" />

        {/* state-specific decorations */}
        {effective === "listening" && (
          <>
            <span className="ruby-wave" aria-hidden="true" />
            <span className="ruby-wave ruby-wave--2" aria-hidden="true" />
          </>
        )}
        {effective === "speaking" && (
          <span className="ruby-bars" aria-hidden="true">
            <i /><i /><i /><i />
          </span>
        )}
        {effective === "thinking" && (
          <span className="ruby-orbit" aria-hidden="true"><i /><i /><i /></span>
        )}
        {effective === "analyzingMarket" && (
          <span className="ruby-radar" aria-hidden="true" />
        )}
        {effective === "success" && (
          <span className="ruby-badge ruby-badge--ok" aria-hidden="true">✓</span>
        )}
        {(effective === "riskWarning" || effective === "alert") && (
          <span className="ruby-badge ruby-badge--warn" aria-hidden="true">!</span>
        )}
        {effective === "disconnected" && (
          <span className="ruby-badge ruby-badge--off" aria-hidden="true" />
        )}

        {/* avatar core */}
        <svg className="ruby-avatar__svg" viewBox="0 0 100 100" width={px} height={px} role="img" aria-hidden="true">
          <defs>
            <radialGradient id="ruby-bust" cx="50%" cy="38%" r="70%">
              <stop offset="0%" stopColor="#1A2233" />
              <stop offset="100%" stopColor="#0E131B" />
            </radialGradient>
            <radialGradient id="ruby-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--ruby-accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--ruby-accent)" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx="50" cy="50" r="48" fill="url(#ruby-glow)" className="ruby-aura" />
          <circle cx="50" cy="50" r="46" fill="#0B0F16" stroke="var(--ruby-accent)" strokeOpacity="0.35" strokeWidth="1" />
          <RubyFace accent="var(--ruby-accent)" />
        </svg>
      </span>

      {showLabel && (
        <span className="ruby-avatar__labels">
          <span className="ruby-avatar__label">{resolvedLabel}</span>
          {subLabel && <span className="ruby-avatar__sublabel">{subLabel}</span>}
        </span>
      )}
    </Wrapper>
  );
}

/* ---------- small composables built on top of RubyAvatar ---------- */

/** Inline "Ruby is thinking…" indicator — replaces generic spinners in Ruby contexts. */
export function RubyThinkingIndicator({ label, size = "sm" as RubySize }: { label?: string; size?: RubySize }) {
  const { name } = useAssistantName();
  return (
    <div className="flex items-center gap-2 text-sm text-txt-secondary" role="status" aria-live="polite">
      <RubyAvatar state="thinking" size={size} ariaHidden />
      <span>{label ?? `${name} is thinking…`}</span>
    </div>
  );
}

/** Header presence row for Ruby insight cards. */
export function RubyPresenceCard({
  title, state = "idle", subLabel, onAsk, children,
}: {
  title: string;
  state?: RubyState;
  subLabel?: string;
  onAsk?: () => void;
  children?: React.ReactNode;
}) {
  const { name } = useAssistantName();
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-3">
        <RubyAvatar state={state} size="md" ariaHidden />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          {subLabel && <div className="text-xs text-txt-muted">{subLabel}</div>}
        </div>
        {onAsk && (
          <button onClick={onAsk}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-ruby/40 bg-ruby/10 px-2.5 py-1.5 text-xs font-medium text-ruby hover:bg-ruby/20">
            Ask {name}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}
