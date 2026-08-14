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

export const STATUS_COLORS = {
  bullish: { text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30", badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", solid: "bg-emerald-500", ring: "ring-emerald-500/40" },
  bearish: { text: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500/30", badge: "bg-rose-500/15 text-rose-300 border-rose-500/30", solid: "bg-rose-500", ring: "ring-rose-500/40" },
  warning: { text: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30", badge: "bg-amber-500/15 text-amber-300 border-amber-500/30", solid: "bg-amber-500", ring: "ring-amber-500/40" },
  danger: { text: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/30", badge: "bg-red-500/15 text-red-300 border-red-500/30", solid: "bg-red-500", ring: "ring-red-500/40" },
  success: { text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30", badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", solid: "bg-emerald-500", ring: "ring-emerald-500/40" },
  info: { text: "text-cyan-300", bg: "bg-cyan-500/10", border: "border-cyan-500/30", badge: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30", solid: "bg-cyan-500", ring: "ring-cyan-500/40" },
  neutral: { text: "text-slate-300", bg: "bg-slate-500/10", border: "border-slate-500/30", badge: "bg-slate-500/15 text-slate-300 border-slate-500/30", solid: "bg-slate-500", ring: "ring-slate-500/40" },
  inactive: { text: "text-slate-500", bg: "bg-slate-700/20", border: "border-slate-700/30", badge: "bg-slate-700/20 text-slate-500 border-slate-700/30", solid: "bg-slate-600", ring: "ring-slate-700/40" },
  premium: { text: "text-violet-300", bg: "bg-violet-500/10", border: "border-violet-500/30", badge: "bg-violet-500/15 text-violet-300 border-violet-500/30", solid: "bg-violet-500", ring: "ring-violet-500/40" },
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
export const SHADOWS = {
  subtle: "shadow-sm shadow-black/20",
  elevated: "shadow-lg shadow-black/40",
  modal: "shadow-2xl shadow-black/60",
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
