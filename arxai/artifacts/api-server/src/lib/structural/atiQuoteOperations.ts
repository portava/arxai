import { and, eq, lte } from "drizzle-orm";
import { chartDecisionReceiptsTable as receipts, db } from "@workspace/db";
import {
  ATI_SPECIALIST_VERSION,
  forecastHorizonBars,
  forecastStepMs,
  hasAtiStructuralScope,
  type StructuralForecast,
} from "@workspace/domain/structural";
import {
  atiDerivQuoteOrigin,
  type AtiDerivQuoteFrame,
  type AtiDerivQuoteOrigin,
} from "../data/atiDerivQuotes.js";
import { resolveDerivSymbol } from "../data/providers/derivProvider.js";
import { loadAtiDerivReplayQuotes } from "../selfTrade/atiDerivQuoteReplay.js";
import { readSpecialistTape } from "./atiSpecialistTape.js";

type Receipt = { forecast: StructuralForecast; issuedAt: number; recordedAt: number };

export async function diagnoseAtiQuoteStream(
  row: Receipt,
  asOf: number,
  load: (
    origin: AtiDerivQuoteOrigin,
    through: number,
  ) => PromiseLike<readonly AtiDerivQuoteFrame[]> = loadAtiDerivReplayQuotes,
) {
  const f = row.forecast,
    s = f.atiSpecialists,
    end = f.asOf + 15 * 60_000;
  if (
    !Number.isFinite(asOf) ||
    ![row.issuedAt, row.recordedAt].every((t) => Number.isFinite(t) && t <= asOf) ||
    !s ||
    s.version !== ATI_SPECIALIST_VERSION ||
    !hasAtiStructuralScope(f) ||
    forecastHorizonBars(f) !== 15 ||
    forecastStepMs(f) !== 60_000 ||
    f.modelId !== s.modelId ||
    s.asOf !== f.asOf ||
    s.provider !== f.origin.provider ||
    s.symbol !== f.origin.symbol ||
    row.issuedAt < f.asOf ||
    row.recordedAt < row.issuedAt ||
    row.recordedAt >= f.asOf + 60_000
  )
    return null;
  const anchor = s.quoteStudy,
    cutoff = Math.min(asOf, end + 5000);
  const scope = {
    policy: "ati-public-quote-monitor-v1",
    source: f.origin.provider,
    symbol: f.origin.symbol,
    issuedAt: row.issuedAt,
    asOf,
    horizonEnd: end,
    effectiveCutoff: cutoff,
    executionAuthority: "NONE",
  };
  if (!anchor) return { ...scope, state: "NO_ISSUANCE_QUOTE", timeline: null };
  const key = atiDerivQuoteOrigin.safeParse({
    symbol: anchor.symbol,
    streamId: anchor.streamId,
    epoch: anchor.epoch,
  });
  if (
    !key.success ||
    resolveDerivSymbol(s.symbol)?.derivId !== anchor.symbol ||
    anchor.version !== "fixed-horizon-bid-ask-v1"
  )
    return { ...scope, state: "ANCHOR_UNVERIFIED", timeline: null };
  const cadence = anchor.symbol.startsWith("1HZ") ? 1 : 2;
  const exitEpoch = anchor.epoch + cadence * Math.ceil((end / 1000 - anchor.epoch) / cadence);
  if (anchor.epoch * 1000 > row.issuedAt || row.issuedAt - anchor.epoch * 1000 > cadence * 1000)
    return { ...scope, state: "ANCHOR_UNVERIFIED", timeline: null };
  const frames: AtiDerivQuoteFrame[] = (await load(key.data, cutoff)).filter(
    (frame) => frame.epoch <= exitEpoch && frame.epoch * 1000 <= cutoff && frame.releasedAt <= cutoff,
  );
  const first = frames[0];
  if (
    !first ||
    first.epoch !== anchor.epoch ||
    first.bid !== anchor.bid ||
    first.ask !== anchor.ask ||
    first.releasedAt > row.issuedAt ||
    frames.some((f) => f.streamId !== anchor.streamId || f.symbol !== anchor.symbol)
  )
    return { ...scope, state: "ANCHOR_UNVERIFIED", timeline: null };
  const gaps: { afterEpoch: number; resumedEpoch: number; missingTicks: number }[] = [];
  let clockFaults = 0,
    sequenceFaults = 0,
    staleQuotes = 0,
    missingSides = 0;
  for (const [i, frame] of frames.entries()) {
    const previous = frames[i - 1],
      lag = frame.releasedAt - frame.epoch * 1000;
    if (
      !Number.isFinite(lag) ||
      !Number.isFinite(frame.receivedAt) ||
      frame.receivedAt <= 0 ||
      lag < 0 ||
      frame.releasedAt < frame.receivedAt ||
      (previous && previous.releasedAt > frame.releasedAt)
    )
      clockFaults++;
    if (lag > 3000) staleQuotes++;
    if (
      frame.bid == null ||
      frame.ask == null ||
      !Number.isFinite(frame.bid) ||
      !Number.isFinite(frame.ask) ||
      frame.bid <= 0 ||
      frame.ask < frame.bid
    )
      missingSides++;
    if (previous) {
      const steps = (frame.epoch - previous.epoch) / cadence;
      if (!Number.isInteger(steps) || steps <= 0) sequenceFaults++;
      else if (steps > 1)
        gaps.push({ afterEpoch: previous.epoch, resumedEpoch: frame.epoch, missingTicks: steps - 1 });
    }
  }
  const last = frames.at(-1)!;
  // A venue tick can arrive up to three seconds late under the frozen quote policy.
  const dueEpoch = Math.min(exitEpoch, Math.floor((cutoff - 3000) / 1000));
  const overdueTailTicks = Math.max(0, Math.floor((dueEpoch - last.epoch) / cadence));
  const reading = readSpecialistTape(anchor, anchor.symbol, frames, row.issuedAt, row.recordedAt, end);
  const impaired =
    clockFaults + sequenceFaults + staleQuotes + missingSides + gaps.length + overdueTailTicks > 0;
  const ready = "prices" in reading;
  return {
    ...scope,
    state: impaired
      ? "IMPAIRED"
      : ready
        ? "VERIFIED_THROUGH_EXIT"
        : cutoff >= end + 5000
          ? "UNVERIFIED_AT_CLOSE"
          : "COLLECTING",
    timeline: {
      cadenceSeconds: cadence,
      frames: frames.length,
      firstEpoch: first.epoch,
      lastEpoch: last.epoch,
      gaps,
      overdueTailTicks,
      clockFaults,
      sequenceFaults,
      staleQuotes,
      missingSides,
    },
    priceReplay: ready ? "VERIFIED" : reading.reason,
  };
}

export async function readAtiQuoteOperations(ownerId: number, receiptId: string, asOf: Date) {
  const [row] = await db
    .select({
      snapshot: receipts.intelligenceSnapshot,
      recordedAt: receipts.createdAt,
      symbol: receipts.symbol,
    })
    .from(receipts)
    .where(
      and(
        eq(receipts.userId, ownerId),
        eq(receipts.source, "structural_forecast"),
        eq(receipts.receiptId, receiptId),
        lte(receipts.createdAt, asOf),
      ),
    )
    .limit(1);
  if (!row) return null;
  const payload = row.snapshot as { forecast?: StructuralForecast; issuedAt?: number } | null;
  if (
    !payload?.forecast ||
    payload.issuedAt == null ||
    payload.forecast.executionAuthority !== "NONE" ||
    payload.forecast.origin.symbol !== row.symbol
  )
    return null;
  const report = await diagnoseAtiQuoteStream(
    { forecast: payload.forecast, issuedAt: payload.issuedAt, recordedAt: +row.recordedAt },
    +asOf,
  );
  return report && { receiptId, ...report };
}
