// Mood → trade-outcome correlation.
//
// Kept in its own module (no database imports) so the join can be unit tested
// in the offline CI lane.

/**
 * How a closed trade is attributed to a mood: the most recent check-in at or
 * before the trade opened, within this window. Outside it, the check-in is too
 * stale to say anything about that trade and the trade stays unattributed.
 */
export const MOOD_ATTRIBUTION_WINDOW_MS = 4 * 60 * 60_000; // 4 hours

export interface MoodOutcomeRow {
  mood: string;
  trades: number;
  wins: number;
  winRatePct: number;
  netPnl: number;
}

/**
 * Join closed trades to the mood the user was in when they opened them.
 * Pure so it can be tested without a database.
 *
 * A trade counts for a mood only when a check-in exists at or before
 * `openedAt` and within MOOD_ATTRIBUTION_WINDOW_MS. Everything else is
 * reported as `unattributedTrades` rather than silently folded in.
 */
export function correlateMoodOutcomes(
  checkIns: Array<{ mood: string; checkedInAt: Date }>,
  closedTrades: Array<{ openedAt: Date; pnl: number }>,
): { rows: MoodOutcomeRow[]; attributedTrades: number; unattributedTrades: number } {
  const sorted = [...checkIns].sort((a, b) => a.checkedInAt.getTime() - b.checkedInAt.getTime());
  const acc = new Map<string, { trades: number; wins: number; netPnl: number }>();
  let attributed = 0;
  let unattributed = 0;

  for (const t of closedTrades) {
    const at = t.openedAt.getTime();
    let match: { mood: string; checkedInAt: Date } | null = null;
    for (const c of sorted) {
      const ct = c.checkedInAt.getTime();
      if (ct > at) break;
      if (at - ct <= MOOD_ATTRIBUTION_WINDOW_MS) match = c;
    }
    if (!match) { unattributed++; continue; }
    attributed++;
    const cur = acc.get(match.mood) ?? { trades: 0, wins: 0, netPnl: 0 };
    cur.trades += 1;
    if (t.pnl > 0) cur.wins += 1;
    cur.netPnl += t.pnl;
    acc.set(match.mood, cur);
  }

  const rows = Array.from(acc.entries())
    .map(([mood, d]) => ({
      mood,
      trades: d.trades,
      wins: d.wins,
      winRatePct: d.trades ? Math.round((d.wins / d.trades) * 100) : 0,
      netPnl: Math.round(d.netPnl * 100) / 100,
    }))
    .sort((a, b) => a.netPnl - b.netPnl); // worst first — that is the useful end

  return { rows, attributedTrades: attributed, unattributedTrades: unattributed };
}
