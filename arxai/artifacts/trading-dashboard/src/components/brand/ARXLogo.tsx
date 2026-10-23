import React, { useId } from "react";
import { cn } from "@/lib/utils";
import { ARX_COLORS } from "@/lib/design-tokens";

export const ARX_BRAND = {
  name: "ARX AI",
  short: "ARX",
  tagline: "Analyze. Risk. eXecute.",
  lockup: "ARX AI — The AI trading fortress built for disciplined decisions.",
  description: "The AI trading fortress built for disciplined decisions.",
  meaning: {
    analyze: "AI market scanner, chart analysis, news risk, session timing, strategy matching, and opportunity scoring.",
    risk: "Risk Governor, stop-loss enforcement, max loss limits, drawdown protection, exposure control, and kill switch.",
    execute: "Manual simulator trades, AI-assisted trades, live tester intents, trade journal, learning loop, and future MT5 execution.",
  },
  colors: ARX_COLORS,
} as const;

type Mode = "dark" | "light";
type Size = "sm" | "md" | "lg" | "xl";

const SIZE_PX: Record<Size, number> = { sm: 20, md: 28, lg: 40, xl: 64 };

interface MarkProps {
  size?: Size | number;
  mode?: Mode;
  className?: string;
  title?: string;
  "data-testid"?: string;
}

/** Icon-only ARX mark — circular ring + shield silhouette + electric X. */
export function ARXLogoMark({ size = "md", mode = "dark", className, title = "ARX AI", ...rest }: MarkProps) {
  const px = typeof size === "number" ? size : SIZE_PX[size];
  const bg = mode === "dark" ? ARX_COLORS.deepNavy : ARX_COLORS.white;
  const ring = mode === "dark" ? ARX_COLORS.silver : ARX_COLORS.primaryDark;
  const shield = mode === "dark" ? ARX_COLORS.white : ARX_COLORS.primaryDark;
  const blue = ARX_COLORS.arxBlue;
  const cyan = ARX_COLORS.electricCyan;
  // Unique IDs per instance to prevent gradient collisions when many marks render together (e.g. brand-kit page).
  const uid = useId().replace(/:/g, "");
  const xId = `arxX-${uid}`;
  const shieldId = `arxShield-${uid}`;
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={title}
      className={cn("shrink-0", className)}
      data-testid={rest["data-testid"] ?? "arx-logo-mark"}
    >
      <title>{title}</title>
      <defs>
        <linearGradient id={xId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={cyan} />
          <stop offset="100%" stopColor={blue} />
        </linearGradient>
        <linearGradient id={shieldId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={shield} stopOpacity="0.95" />
          <stop offset="100%" stopColor={shield} stopOpacity="0.7" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill={bg} />
      <circle cx="32" cy="32" r="26" stroke={ring} strokeOpacity="0.35" strokeWidth="1.25" />
      <circle cx="32" cy="32" r="22" stroke={blue} strokeOpacity="0.55" strokeWidth="1" strokeDasharray="2 3" />
      <path
        d="M32 12 L48 18 V32 C48 42.5 41 50 32 53 C23 50 16 42.5 16 32 V18 Z"
        fill={`url(#${shieldId})`}
        fillOpacity="0.08"
        stroke={`url(#${shieldId})`}
        strokeWidth="1.25"
      />
      <path d="M22 22 L42 42" stroke={`url(#${xId})`} strokeWidth="4.5" strokeLinecap="round" />
      <path d="M42 22 L22 42" stroke={`url(#${xId})`} strokeWidth="4.5" strokeLinecap="round" />
      <circle cx="32" cy="32" r="2.4" fill={cyan} />
    </svg>
  );
}

interface WordmarkProps {
  mode?: Mode;
  size?: "sm" | "md" | "lg";
  className?: string;
  short?: boolean;
}

/** ARX AI wordmark — bold geometric uppercase with electric X. */
export function ARXWordmark({ mode = "dark", size = "md", className, short = false }: WordmarkProps) {
  const text = short ? "ARX" : "ARX AI";
  const color = mode === "dark" ? "text-white" : `text-[${ARX_COLORS.primaryDark}]`;
  const sizes: Record<NonNullable<WordmarkProps["size"]>, string> = {
    sm: "text-sm",
    md: "text-lg",
    lg: "text-3xl md:text-4xl",
  };
  // split so we can color the X
  const parts = text.split("");
  return (
    <span
      className={cn("font-black uppercase tracking-[0.18em] leading-none", color, sizes[size], className)}
      data-testid="arx-wordmark"
    >
      {parts.map((ch, i) => (
        <span
          key={i}
          style={ch === "X" ? { color: ARX_COLORS.arxBlue, textShadow: "0 0 8px rgba(30,123,255,0.45)" } : undefined}
        >
          {ch}
        </span>
      ))}
    </span>
  );
}

interface LockupProps {
  mode?: Mode;
  size?: "sm" | "md" | "lg";
  showTagline?: boolean;
  showDescription?: boolean;
  className?: string;
}

/** Full horizontal lockup: mark + ARX AI + tagline / description. */
export function ARXBrandLockup({
  mode = "dark",
  size = "md",
  showTagline = true,
  showDescription = false,
  className,
}: LockupProps) {
  const markSize: Size = size === "lg" ? "xl" : size === "sm" ? "md" : "lg";
  const subColor = mode === "dark" ? "text-zinc-300" : "text-zinc-600";
  const descColor = mode === "dark" ? "text-zinc-400" : "text-zinc-500";
  return (
    <div className={cn("flex items-center gap-3", className)} data-testid="arx-brand-lockup">
      <ARXLogoMark size={markSize} mode={mode} />
      <div className="min-w-0 flex flex-col">
        <ARXWordmark mode={mode} size={size} />
        {showTagline && (
          <span className={cn("text-[11px] md:text-xs font-mono uppercase tracking-[0.22em] mt-1", subColor)}>
            Analyze · Risk · eXecute
          </span>
        )}
        {showDescription && (
          <span className={cn("text-xs md:text-sm mt-1", descColor)}>{ARX_BRAND.description}</span>
        )}
      </div>
    </div>
  );
}

/** Small badge — icon mark in a soft container for nav rails / chips. */
export function ARXIconBadge({ size = "md", mode = "dark", className }: MarkProps) {
  return (
    <div
      className={cn(
        "rounded-md border flex items-center justify-center",
        mode === "dark" ? "bg-[#08111F] border-[#1E7BFF]/30" : "bg-white border-[#050B14]/15",
        className,
      )}
      data-testid="arx-icon-badge"
    >
      <ARXLogoMark size={size} mode={mode} />
    </div>
  );
}

/** Default ARXLogo = compact horizontal lockup (icon + ARX AI). */
export function ARXLogo(props: LockupProps) {
  return <ARXBrandLockup {...props} />;
}
