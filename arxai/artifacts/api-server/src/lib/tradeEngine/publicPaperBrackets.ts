import {
  executableForecastPaperOrder,
  type ForecastPaperGrade,
  type ForecastPaperInstruction,
} from "@workspace/domain/structural";
import type { DerivTick } from "../data/providers/derivWsClient.js";
import { crossedPaperLevel, paperExitQuote } from "./paperLevels.js";

type Bracket = {
  id: number;
  symbol: string;
  direction: string;
  stopLoss: number;
  takeProfit?: number | null;
  openedAt: Date;
  updatedAt: Date;
};
type Quote = { bid: number; ask: number; at: Date; source: string };
type Reading = ({ ok: true } & Quote) | { ok: false; reasons: string[] };

// Fixed-frequency public volatility indices used by the paper engines.
// Keep recording independent of account polling, including ticks with missing sides.
export class PublicPaperBracketHistory {
  private streams = new Map<
    string,
    (DerivTick & { receivedAt: number; releasedAt: number })[]
  >();
  private checked = new Map<number, { key: string; epoch: number }>();

  observe(
    tick: DerivTick,
    receivedAt = tick.epoch * 1000,
    releasedAt = receivedAt,
  ) {
    if (!/^(R_(10|25|50|75|100)|1HZ(10|25|50|75|100)V)$/.test(tick.symbol))
      return;
    const ticks = this.streams.get(tick.symbol) ?? [];
    if (tick.epoch <= (ticks.at(-1)?.epoch ?? 0)) return;
    if (ticks.length >= 8192) ticks.splice(0, 4096);
    ticks.push({ ...tick, receivedAt, releasedAt });
    this.streams.set(tick.symbol, ticks);
  }

  gradeTicket(
    symbol: string,
    plan: ForecastPaperInstruction,
    publishedAt: number,
    now: number,
  ): ForecastPaperGrade {
    const pending: ForecastPaperGrade = { state: "PENDING" };
    if (plan.action === "HOLD") return { state: "SKIPPED" };
    const ticks = this.streams.get(symbol);
    if (!ticks?.length)
      return now - publishedAt > 3000 ? { state: "UNVERIFIED" } : pending;
    const cadence = symbol.startsWith("1HZ") ? 1000 : 2000;
    let previous = publishedAt;
    let entry: number | undefined;
    for (const tick of ticks) {
      const at = tick.epoch * 1000;
      if (tick.releasedAt > now) continue;
      // The venue stamps whole seconds. A fresh quote from the issuance
      // second may reach ARX after the ticket was published.
      if (at < publishedAt && tick.receivedAt <= publishedAt) continue;
      if (at - previous > cadence || tick.bid == null || tick.ask == null)
        return { state: "UNVERIFIED", entry };
      previous = at;
      if (entry == null) {
        if (tick.receivedAt <= publishedAt) continue;
        if (
          tick.releasedAt - publishedAt > 3000 ||
          tick.releasedAt - at > 3000 ||
          !executableForecastPaperOrder(plan, tick.bid, tick.ask)
        )
          return { state: "SKIPPED" };
        entry = plan.action === "BUY" ? tick.ask : tick.bid;
      }
      const exit = plan.action === "BUY" ? tick.bid : tick.ask;
      const hit = crossedPaperLevel(
        {
          direction: plan.action,
          stopLoss: plan.stop,
          takeProfit: plan.target,
        },
        exit,
      );
      if (hit)
        return {
          state: hit.hit === "TP" ? "TARGET" : "STOP",
          entry,
          exit,
          observedAt: tick.releasedAt,
        };
    }
    if (now - previous > cadence + 3000) return { state: "UNVERIFIED", entry };
    return entry == null ? pending : { state: "OPEN", entry };
  }

  read(order: Bracket, symbol: string, latest: Quote): Reading {
    const gap = {
      ok: false as const,
      reasons: [
        "Executable quote history is incomplete for this paper bracket. Its first stop or target requires review.",
      ],
    };
    const ticks = this.streams.get(symbol);
    if (!ticks) return gap;
    const cadence = symbol.startsWith("1HZ") ? 1000 : 2000;
    const start = Math.max(+order.openedAt, +order.updatedAt);
    const key = [
      symbol,
      start,
      order.direction,
      order.stopLoss,
      order.takeProfit,
    ].join("|");
    const prior = this.checked.get(order.id);
    let previous = prior?.key === key ? prior.epoch : start;
    let reachedLatest = false;
    if (+latest.at < previous) return gap;
    // Skip only quotes already verified under these exact bracket terms.
    let index = ticks.length;
    while (index && ticks[index - 1]!.epoch * 1000 >= previous) index--;
    for (; index < ticks.length; index++) {
      const tick = ticks[index]!,
        at = tick.epoch * 1000;
      if (at > +latest.at) break;
      if (at === +latest.at) {
        if (tick.bid !== latest.bid || tick.ask !== latest.ask) return gap;
        reachedLatest = true;
      }
      if (at - previous > cadence || tick.bid == null || tick.ask == null)
        return gap;
      const quote = {
        bid: tick.bid,
        ask: tick.ask,
        at: new Date(at),
        source: latest.source,
      };
      if (crossedPaperLevel(order, paperExitQuote(order.direction, quote)))
        return { ok: true, ...quote };
      previous = at;
    }
    if (!reachedLatest) return gap;
    // Discarding old checkpoints can require coverage review, never an invented fill.
    if (!this.checked.has(order.id) && this.checked.size >= 4096)
      this.checked.delete(this.checked.keys().next().value!);
    this.checked.set(order.id, { key, epoch: previous });
    return { ok: true, ...latest };
  }
}

export async function checkedPaperBracketQuote(
  order: Bracket,
  quote: Reading,
): Promise<Reading> {
  if (!quote.ok || quote.source !== "market_data_router:deriv_public")
    return quote;
  const { resolveDerivSymbol } =
    await import("../data/providers/derivProvider.js");
  const mapping = resolveDerivSymbol(order.symbol);
  if (!mapping || !/^V(10|25|50|75|100)(_1S)?$/.test(mapping.symbol))
    return quote;
  return publicPaperBrackets.read(order, mapping.derivId, quote);
}

export const publicPaperBrackets = new PublicPaperBracketHistory();
