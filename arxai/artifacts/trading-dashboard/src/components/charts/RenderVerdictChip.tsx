// The chart's own render self-check, as the server judged it: every redraw
// posts a measurement of what the engine drew (renderEvidenceReporter.ts) and
// this chip shows the server's latest verdict on it. Display only — it changes
// no trade, gate or order.
import { useEffect, useState } from "react";
import type { RenderVerdict } from "@/lib/chart-engine/renderEvidenceReporter";

export type RenderVerdictTone = "verified" | "failed" | "unverified";

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

/** Chip copy for a verdict. Only a measured 100 reads as verified. */
export function renderVerdictCopy(verdict: RenderVerdict | null, now = Date.now()): { tone: RenderVerdictTone; text: string; title: string } {
  if (!verdict) return { tone: "unverified", text: "Render check pending", title: "The chart has not been measured yet." };
  const bars = verdict.report?.barsCompared;
  const when = verdict.report ? ` · ${ago(now - verdict.report.receivedAt)}` : "";
  const ha = verdict.report?.displayMode === "heikinAshi" ? " · Heikin Ashi (averaged, not tradable prices)" : "";
  if (verdict.status === "measured" && verdict.score === 100) {
    return { tone: "verified", text: `Render verified · ${bars ?? 0} bars${when}${ha}`, title: verdict.detail };
  }
  if (verdict.status === "measured") {
    return { tone: "failed", text: `Render check failed${when}: ${verdict.detail.replace(/^Renderer mismatch:\s*/, "")}`, title: verdict.detail };
  }
  return { tone: "unverified", text: `Render not verified${when}: ${verdict.detail}`, title: verdict.detail };
}

const TONE_CLASS: Record<RenderVerdictTone, string> = {
  verified: "border-emerald-700/60 text-emerald-300",
  failed: "border-red-700/60 text-red-300",
  unverified: "border-zinc-700 text-zinc-400",
};

export function RenderVerdictChip({ verdict }: { verdict: RenderVerdict | null }) {
  // Re-render every 5s while a verdict is shown so "Xs ago" stays honest
  // between posts (one timeout at a time; no interval).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!verdict?.report) return;
    const id = setTimeout(() => setNow(Date.now()), 5_000);
    return () => clearTimeout(id);
  }, [verdict, now]);
  const copy = renderVerdictCopy(verdict, now);
  return (
    <span
      role="status"
      title={copy.title}
      data-testid="chart-render-verdict"
      data-tone={copy.tone}
      className={`inline-block max-w-full truncate rounded border px-2 py-0.5 text-[11px] ${TONE_CLASS[copy.tone]}`}
    >
      {copy.text}
    </span>
  );
}
