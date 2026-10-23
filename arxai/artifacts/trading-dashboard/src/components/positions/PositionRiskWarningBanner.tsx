import type { LivePosition } from "@workspace/api-client-react";

// Lightweight client-side banner derived from position fields. Authoritative
// warnings live in /positions/{id}/events on the server; this is just a
// glanceable summary for the detail page header.
export function PositionRiskWarningBanner({ position }: { position: LivePosition }) {
  const messages: { tone: "warn" | "danger"; text: string }[] = [];
  if (position.stopLoss == null) messages.push({ tone: "danger", text: "Stop loss is not set on this position." });
  if (position.status === "BROKER_ERROR") messages.push({ tone: "danger", text: "Broker reported an error syncing this position." });
  if (position.status === "SYNC_PENDING") messages.push({ tone: "warn", text: "Awaiting first broker sync." });
  if (position.rewardToRisk != null && position.rewardToRisk < 1) messages.push({ tone: "warn", text: `Reward-to-risk is ${position.rewardToRisk.toFixed(2)} — below 1.0.` });
  if (messages.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {messages.map((m, i) => (
        <div key={i} className={`rounded-md border px-3 py-2 text-xs ${m.tone === "danger" ? "border-rose-500/40 bg-rose-500/10 text-rose-200" : "border-amber-500/40 bg-amber-500/10 text-amber-200"}`}>
          {m.text}
        </div>
      ))}
    </div>
  );
}
