import { createHash } from "node:crypto";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { atiDerivQuoteFramesTable as frames, db } from "@workspace/db";
import type { ForecastPaperInstruction } from "@workspace/domain/structural";
import type { AtiDerivQuoteFrame, AtiDerivQuoteOrigin } from "../data/atiDerivQuotes.js";
import { PublicPaperBracketHistory } from "../tradeEngine/publicPaperBrackets.js";
import type { EntryReplayPolicy, ReplaySampleObserver } from "../tradeEngine/paperLevels.js";
import type { AtiMt5ReplayQuote } from "./atiMt5QuoteReplay.js";

export type AtiDerivReplayWitness = {
  source: "ARCHIVED_DERIV_PUBLIC_BID_ASK";
  decisionEpoch: number;
  exitEpoch: number;
  entryObservedAt: number;
  samples: number;
  tapeHash: string;
};

export function loadAtiDerivReplayQuotes(origin: AtiDerivQuoteOrigin, through: number) {
  return db.select().from(frames).where(and(eq(frames.streamId, origin.streamId), eq(frames.symbol, origin.symbol),
    gte(frames.epoch, origin.epoch), lte(frames.epoch, Math.floor(through / 1000)), lte(frames.releasedAt, through)))
    .orderBy(asc(frames.epoch));
}

export function gradeAtiDerivReplay(rows: readonly AtiDerivQuoteFrame[], origin: AtiDerivQuoteOrigin, quote: AtiMt5ReplayQuote | null,
  plan: ForecastPaperInstruction, decisionAt: number, asOf: number, expiresAt: number, entryPolicy?: EntryReplayPolicy, onSample?: ReplaySampleObserver) {
  const unverified = { state: "UNVERIFIED" as const };
  const tape = rows.filter((row) => row.streamId === origin.streamId && row.symbol === origin.symbol &&
    row.epoch >= origin.epoch && row.epoch * 1000 <= asOf && row.releasedAt <= asOf);
  const anchor = tape[0];
  if (!quote || !anchor || anchor.epoch !== origin.epoch || anchor.releasedAt > decisionAt ||
      anchor.epoch * 1000 !== Date.parse(quote.observedAt) || anchor.bid !== quote.bid || anchor.ask !== quote.ask) return unverified;
  if (entryPolicy && decisionAt - anchor.epoch * 1000 > (origin.symbol.startsWith("1HZ") ? 1000 : 2000)) return unverified;
  const recorder = new PublicPaperBracketHistory();
  let prior: AtiDerivQuoteFrame | undefined;
  const encoded = (frame: AtiDerivQuoteFrame) => JSON.stringify([frame.streamId, frame.symbol, frame.epoch,
    frame.receivedAt, frame.releasedAt, frame.bid, frame.ask]);
  const archivePrefix = onSample ? createHash("sha256") : null;
  let invalidPrefix = false;
  for (const frame of tape) {
    if (onSample && (![frame.epoch, frame.receivedAt, frame.releasedAt, frame.bid, frame.ask].every(Number.isFinite) ||
        frame.releasedAt < frame.receivedAt || frame.releasedAt < frame.epoch * 1000 ||
        frame.bid == null || frame.ask == null || !(frame.bid > 0 && frame.ask >= frame.bid) ||
        (prior && (frame.epoch <= prior.epoch || frame.releasedAt < prior.releasedAt ||
          frame.epoch - prior.epoch > (origin.symbol.startsWith("1HZ") ? 1 : 2))))) {
      invalidPrefix = true;
      break;
    }
    prior = frame;
    recorder.observe({ epoch: frame.epoch, symbol: frame.symbol, quote: frame.bid ?? 0,
      bid: frame.bid ?? undefined, ask: frame.ask ?? undefined }, frame.receivedAt, frame.releasedAt, archivePrefix?.update(encoded(frame)).copy().digest("hex"));
  }
  const grade = recorder.gradeTicket(origin.symbol, plan, decisionAt, asOf, expiresAt, true, entryPolicy, onSample);
  if (grade.state !== "STOP" && grade.state !== "TARGET" && !grade.noFill) return invalidPrefix ? unverified : grade;
  if ((!grade.path && !grade.noFill) || grade.terminalEpoch == null) return unverified;
  const used = tape.filter((frame) => frame.epoch <= grade.terminalEpoch!);
  if (used.some((frame, i) => frame.releasedAt < frame.receivedAt || frame.releasedAt < frame.epoch * 1000 ||
      (i > 0 && (frame.releasedAt < used[i - 1]!.releasedAt || frame.epoch <= used[i - 1]!.epoch)))) return unverified;
  const hash = createHash("sha256");
  for (const frame of used) hash.update(encoded(frame));
  const tapeHash = hash.digest("hex");
  if (grade.noFill) return { ...grade, noFill: { ...grade.noFill, tapeHash } };
  if (!grade.path) return unverified;
  const derivReplay: AtiDerivReplayWitness = { source: "ARCHIVED_DERIV_PUBLIC_BID_ASK", decisionEpoch: origin.epoch,
    exitEpoch: grade.terminalEpoch, entryObservedAt: grade.path.entry.atMs, samples: grade.path.samples, tapeHash };
  return { ...grade, derivReplay };
}
