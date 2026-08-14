import type { Trade } from "../trade/trade.types";
import type { DnaReport, TraderProfile } from "./traderProfile.types";

export interface RevengeTradeReport extends DnaReport {
  cooldownUntil: string | null;     // ISO — when the system should resume normal trading
  triggeringLossId: Trade["id"] | null;
  followUpTrades: Trade["id"][];    // suspected revenge trades
}

// Revenge trading signature:
//   • A losing trade closes
//   • Within REVENGE_WINDOW_MS, ≥1 new entry on the same symbol
//   • The new entry is BIGGER than the loss's lot size, OR there are ≥2
//     follow-up entries on that symbol within the window
const REVENGE_WINDOW_MS = 30 * 60 * 1000;     // 30 min after a loss
const COOLDOWN_AFTER_DETECTION_MS = 60 * 60 * 1000;
const SIZE_ESCALATION_RATIO = 1.25;

export function detectRevengeTrading(
  _profile: TraderProfile,
  trades: Trade[],
  now: Date = new Date(),
): RevengeTradeReport {
  // Sort by openedAt ascending for chronological scanning.
  const ordered = [...trades].sort(
    (a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime(),
  );

  let triggeringLossId: Trade["id"] | null = null;
  let followUps: Trade[] = [];
  const evidence: string[] = [];

  for (const loss of ordered) {
    if (loss.status !== "CLOSED_LOSS" || !loss.closedAt) continue;
    const lossClosedAt = new Date(loss.closedAt).getTime();

    const windowEntries = ordered.filter((t) => {
      if (t.id === loss.id) return false;
      if (t.symbol !== loss.symbol) return false;
      const opened = new Date(t.openedAt).getTime();
      return opened > lossClosedAt && opened <= lossClosedAt + REVENGE_WINDOW_MS;
    });
    if (windowEntries.length === 0) continue;

    const escalated = windowEntries.find((t) => t.lotSize > loss.lotSize * SIZE_ESCALATION_RATIO);
    if (escalated || windowEntries.length >= 2) {
      triggeringLossId = loss.id;
      followUps = windowEntries;
      evidence.push(
        `Loss on ${loss.symbol} closed at ${new Date(loss.closedAt).toISOString()}`,
        `${windowEntries.length} follow-up entr${windowEntries.length === 1 ? "y" : "ies"} on ${loss.symbol} within 30 min`,
      );
      if (escalated) {
        evidence.push(
          `Lot escalated ${loss.lotSize.toFixed(2)} → ${escalated.lotSize.toFixed(2)} (${(escalated.lotSize / loss.lotSize).toFixed(2)}×)`,
        );
      }
      break;     // report the first detected episode
    }
  }

  if (!triggeringLossId) {
    return {
      detected: false, severity: "NONE", confidence: 0,
      evidence: [], recommendation: null,
      cooldownUntil: null, triggeringLossId: null, followUpTrades: [],
    };
  }

  const escalationCount = followUps.length;
  const confidence = Math.min(100, 60 + escalationCount * 15);
  const severity = escalationCount >= 3 ? "CRITICAL" : escalationCount >= 2 ? "HIGH" : "MEDIUM";
  const cooldownUntil = new Date(now.getTime() + COOLDOWN_AFTER_DETECTION_MS).toISOString();

  return {
    detected: true,
    severity,
    confidence,
    evidence,
    recommendation: `Pause new entries on the affected symbol until ${cooldownUntil}. Review the loss before resuming.`,
    cooldownUntil,
    triggeringLossId,
    followUpTrades: followUps.map((t) => t.id),
  };
}
