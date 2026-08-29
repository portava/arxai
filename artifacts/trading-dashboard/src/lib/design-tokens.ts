// ── ARX AI Design Tokens ───────────────────────────────────────────────────
// ARX brand colors — used by logo system, brand kit, and accent surfaces.
export const ARX_COLORS = {
  primaryDark: "#050B14",
  deepNavy: "#08111F",
  arxBlue: "#1E7BFF",
  electricCyan: "#00B7FF",
  white: "#F8FAFC",
  silver: "#C9D3DF",
  mutedText: "#8B98A8",
  danger: "#EF4444",
  success: "#22C55E",
  warning: "#FACC15",
} as const;

// Single source of truth for status colors, semantic scales, spacing,
// shadows, and typography. Use these helpers everywhere — never hand-write
// conditional color classes.

// ARX 6.0: tones now flow through the CSS palette tokens (index.css), so
// every tone renders correctly in BOTH themes and there is exactly one place
// a semantic color is defined. Shape and keys are unchanged — only the class
// strings moved off stock-Tailwind emerald/rose/amber/cyan/slate/violet.
export const STATUS_COLORS = {
  bullish: { text: "text-success", bg: "bg-success/10", border: "border-success/25", badge: "bg-success/10 text-success border-success/25", solid: "bg-success", ring: "ring-success/30" },
  bearish: { text: "text-danger", bg: "bg-danger/10", border: "border-danger/25", badge: "bg-danger/10 text-danger border-danger/25", solid: "bg-danger", ring: "ring-danger/30" },
  warning: { text: "text-warning", bg: "bg-warning/10", border: "border-warning/25", badge: "bg-warning/10 text-warning border-warning/25", solid: "bg-warning", ring: "ring-warning/30" },
  danger: { text: "text-danger", bg: "bg-danger/10", border: "border-danger/25", badge: "bg-danger/10 text-danger border-danger/25", solid: "bg-danger", ring: "ring-danger/30" },
  success: { text: "text-success", bg: "bg-success/10", border: "border-success/25", badge: "bg-success/10 text-success border-success/25", solid: "bg-success", ring: "ring-success/30" },
  info: { text: "text-ruby", bg: "bg-ruby/10", border: "border-ruby/25", badge: "bg-ruby/10 text-ruby border-ruby/25", solid: "bg-ruby", ring: "ring-ruby/30" },
  neutral: { text: "text-txt-secondary", bg: "bg-muted/60", border: "border-border", badge: "bg-muted/60 text-txt-secondary border-border", solid: "bg-muted-foreground", ring: "ring-border" },
  inactive: { text: "text-txt-muted", bg: "bg-muted/40", border: "border-border/60", badge: "bg-muted/40 text-txt-muted border-border/60", solid: "bg-muted", ring: "ring-border/60" },
  premium: { text: "text-premium", bg: "bg-premium/10", border: "border-premium/25", badge: "bg-premium/10 text-premium border-premium/25", solid: "bg-premium", ring: "ring-premium/30" },
} as const;

export type StatusTone = keyof typeof STATUS_COLORS;

// ── Helpers ────────────────────────────────────────────────────────────────
export function pnlTone(value: number | null | undefined): StatusTone {
  if (value === null || value === undefined || value === 0) return "neutral";
  return value > 0 ? "bullish" : "bearish";
}

export function directionTone(dir: string | null | undefined): StatusTone {
  if (dir === "BUY") return "bullish";
  if (dir === "SELL") return "bearish";
  return "neutral";
}

// ── Confidence: 4-tier scale per spec ───────────────────────────────────────
export type ConfidenceTier = "weak" | "moderate" | "strong" | "elite";
export function confidenceTier(score: number | null | undefined): ConfidenceTier {
  const v = score ?? 0;
  if (v >= 86) return "elite";
  if (v >= 71) return "strong";
  if (v >= 41) return "moderate";
  return "weak";
}
export function confidenceTone(score: number | null | undefined): StatusTone {
  const t = confidenceTier(score);
  return t === "elite" ? "premium" : t === "strong" ? "success" : t === "moderate" ? "warning" : "danger";
}
export const CONFIDENCE_LABEL: Record<ConfidenceTier, string> = {
  weak: "Weak",
  moderate: "Moderate",
  strong: "Strong",
  elite: "Elite Setup",
};

// ── Volatility: 4-state scale ───────────────────────────────────────────────
export type VolatilityState = "CALM" | "NORMAL" | "EXPANDING" | "DANGEROUS";
export function volatilityTone(state: VolatilityState | string | null | undefined): StatusTone {
  switch (state) {
    case "CALM": return "info";
    case "NORMAL": return "neutral";
    case "EXPANDING": return "warning";
    case "DANGEROUS": return "danger";
    default: return "neutral";
  }
}
export const VOLATILITY_LABEL: Record<VolatilityState, string> = {
  CALM: "Calm",
  NORMAL: "Normal",
  EXPANDING: "Expanding",
  DANGEROUS: "Dangerous",
};

// ── Risk: 4-state scale ─────────────────────────────────────────────────────
export type RiskState = "LOW" | "MODERATE" | "HIGH" | "BLOCKED";
export function riskTone(state: RiskState | string | null | undefined): StatusTone {
  switch (state) {
    case "LOW": return "success";
    case "MODERATE": return "info";
    case "HIGH": return "warning";
    case "BLOCKED": return "danger";
    default: return "neutral";
  }
}
export const RISK_LABEL: Record<RiskState, string> = {
  LOW: "Low Risk",
  MODERATE: "Moderate",
  HIGH: "High Risk",
  BLOCKED: "Blocked",
};

// ── Market condition: 5-state scale ─────────────────────────────────────────
export type MarketCondition = "TRENDING" | "RANGE" | "CHOP" | "BREAKOUT" | "REVERSAL_RISK";
export function marketConditionTone(state: MarketCondition | string | null | undefined): StatusTone {
  switch (state) {
    case "TRENDING": return "success";
    case "BREAKOUT": return "premium";
    case "RANGE": return "info";
    case "CHOP": return "neutral";
    case "REVERSAL_RISK": return "warning";
    default: return "neutral";
  }
}
export const MARKET_CONDITION_LABEL: Record<MarketCondition, string> = {
  TRENDING: "Trending",
  RANGE: "Range",
  CHOP: "Chop",
  BREAKOUT: "Breakout",
  REVERSAL_RISK: "Reversal Risk",
};

// ── Trade health: 0-100 score ───────────────────────────────────────────────
export function tradeHealthTone(score: number | null | undefined): StatusTone {
  const v = score ?? 0;
  if (v >= 75) return "success";
  if (v >= 50) return "info";
  if (v >= 30) return "warning";
  return "danger";
}

// ── Spacing scale (for inline style) ────────────────────────────────────────
export const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

// ── Radius / Shadow tokens (Tailwind class strings) ─────────────────────────
export const RADIUS = { sm: "rounded-sm", md: "rounded-md", lg: "rounded-lg", xl: "rounded-xl" } as const;
// Shadows are theme-colored via the --shadow-* tokens in index.css now, so
// the composites no longer force black overlays.
export const SHADOWS = {
  subtle: "shadow-sm",
  elevated: "shadow-lg",
  modal: "shadow-2xl",
} as const;

// ── Typography tokens (Tailwind composites) ─────────────────────────────────
export const TYPO = {
  display: "text-3xl md:text-4xl font-bold tracking-tight",
  heading: "text-xl md:text-2xl font-bold tracking-tight",
  subheading: "text-sm font-semibold uppercase tracking-wider",
  body: "text-sm",
  caption: "text-xs text-muted-foreground",
  mono: "font-mono tabular-nums",
} as const;

// ── Symbols (active-symbol picker source) ───────────────────────────────────
export const SYMBOLS = {
  forex: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "NZDUSD", "USDCHF"],
  indices: ["US30", "NAS100", "SPX500", "GER40", "UK100", "JP225"],
  stocks: ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "META", "GOOGL"],
  synthetic: ["Volatility 75 Index", "Volatility 75 (1s) Index", "Volatility 25 (1s) Index"],
} as const;

export const ALL_SYMBOLS: string[] = [
  ...SYMBOLS.forex, ...SYMBOLS.indices, ...SYMBOLS.stocks, ...SYMBOLS.synthetic,
];
