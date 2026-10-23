import type { ChartMarketSentenceTone } from "@workspace/api-client-react";

// Shared colour mapping for Chart Brain v2 sentence/pulse tones. Single source
// of truth so the Pulse panel and the Sentences panel stay visually consistent.
// Tones are HONEST signals (danger = dirty feed / veto, caution = conflict),
// never decoration — they always come from the backend sentence engine.

export interface ToneClasses {
  text: string;
  border: string;
  bg: string;
  dot: string;
}

const TONE_CLASSES: Record<ChartMarketSentenceTone, ToneClasses> = {
  bullish: {
    text: "text-emerald-300",
    border: "border-emerald-500/30",
    bg: "bg-emerald-500/5",
    dot: "bg-emerald-400",
  },
  bearish: {
    text: "text-rose-300",
    border: "border-rose-500/30",
    bg: "bg-rose-500/5",
    dot: "bg-rose-400",
  },
  neutral: {
    text: "text-zinc-300",
    border: "border-zinc-700",
    bg: "bg-zinc-900/40",
    dot: "bg-zinc-400",
  },
  caution: {
    text: "text-amber-300",
    border: "border-amber-500/30",
    bg: "bg-amber-500/5",
    dot: "bg-amber-400",
  },
  danger: {
    text: "text-red-300",
    border: "border-red-500/40",
    bg: "bg-red-500/10",
    dot: "bg-red-400",
  },
  info: {
    text: "text-sky-300",
    border: "border-sky-500/30",
    bg: "bg-sky-500/5",
    dot: "bg-sky-400",
  },
};

export function toneClasses(tone: ChartMarketSentenceTone): ToneClasses {
  return TONE_CLASSES[tone] ?? TONE_CLASSES.neutral;
}
