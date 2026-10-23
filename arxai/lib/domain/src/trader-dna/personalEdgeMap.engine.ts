// ═══════════════════════════════════════════════════════════════════════════
// Personal Edge Map
//
// Buckets the trader's history by (symbol × session × strategyId × hourOfDay)
// and computes per-bucket win rate + R-expectancy + sample-weighted
// edgeScore01. Surfaces the trader's best and worst buckets and a single
// scalar `personalEdgeScore01` that rolls up to the trader-risk composer.
//
// edgeScore01 = sigmoid(expectancyR × log(1 + sample)) in [0..1].
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import { currentSession } from "../market/session.engine";
import {
  type TradeWithContext,
  type PersonalEdgeMap, type PersonalEdgeBucket, type SessionEnum,
} from "./traderDNA.types";

function bucketKey(s: string, sess: SessionEnum, strat: string, hour: number): string {
  return `${s}|${sess}|${strat}|${hour}`;
}
function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }

export function buildPersonalEdgeMap(trades: TradeWithContext[]): PersonalEdgeMap {
  const closed = trades.filter(t =>
    t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS" || t.status === "CLOSED_BREAKEVEN");
  const groups = new Map<string, TradeWithContext[]>();

  for (const t of closed) {
    const opened = new Date(t.openedAt);
    const sess: SessionEnum = (t.session ?? currentSession(opened)) as SessionEnum;
    const strategyId = t.strategyId ?? "UNKNOWN";
    const hour = opened.getUTCHours();
    const k = bucketKey(t.symbol, sess, strategyId, hour);
    const arr = groups.get(k) ?? [];
    arr.push(t);
    groups.set(k, arr);
  }

  const buckets: PersonalEdgeBucket[] = [];
  for (const [, arr] of groups) {
    const sample = arr.length;
    const wins = arr.filter(t => t.status === "CLOSED_WIN").length;
    const winRate01 = sample ? wins / sample : 0;
    const expectancyR = avg(arr.map(t => t.rMultiple ?? 0));
    const netPnl = arr.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const edgeScore01 = clamp01(sigmoid(expectancyR * Math.log(1 + sample)));
    const opened = new Date(arr[0].openedAt);
    const sess: SessionEnum = (arr[0].session ?? currentSession(opened)) as SessionEnum;
    buckets.push({
      symbol: arr[0].symbol, session: sess,
      strategyId: arr[0].strategyId ?? "UNKNOWN",
      hourOfDay: opened.getUTCHours(),
      sample, winRate01, expectancyR, netPnl, edgeScore01,
    });
  }

  const sorted = [...buckets].sort((a, b) => b.edgeScore01 - a.edgeScore01);
  const best  = sorted.slice(0, 3);
  const worst = sorted.slice(-3).reverse();

  const totalSample = buckets.reduce((s, b) => s + b.sample, 0);
  const personalEdgeScore01 = totalSample > 0
    ? clamp01(buckets.reduce((s, b) => s + b.edgeScore01 * b.sample, 0) / totalSample)
    : 0.5;

  return { buckets, best, worst, totalSample, personalEdgeScore01 };
}

function avg(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function clamp01(x: number): number { return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }
