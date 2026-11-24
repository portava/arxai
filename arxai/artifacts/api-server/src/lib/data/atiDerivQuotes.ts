import { z } from "zod/v4";
import { logger } from "../logger.js";
import type { DerivTick } from "./providers/derivWsClient.js";

const symbol = z.string().regex(/^(R_(10|25|50|75|100)|1HZ(10|25|50|75|100)V)$/);
export const atiDerivQuoteOrigin = z.object({
  streamId: z.uuid(), symbol, epoch: z.number().int().positive(),
}).strict();
export type AtiDerivQuoteOrigin = z.infer<typeof atiDerivQuoteOrigin>;
export type AtiDerivQuoteFrame = AtiDerivQuoteOrigin & {
  receivedAt: number; releasedAt: number; bid: number | null; ask: number | null;
};

const framesByQuote = new WeakMap<object, AtiDerivQuoteFrame>();
const recent = new Map<string, AtiDerivQuoteFrame[]>();
const active = new Map<string, { streamId: string; untilMs: number }>();
const queued = new Map<string, AtiDerivQuoteFrame>();
const maxQueued = 4096;
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | undefined;
let lastWarningAt = 0;

function enqueue(frame: AtiDerivQuoteFrame) {
  const key = `${frame.streamId}:${frame.symbol}:${frame.epoch}`;
  if (queued.size < maxQueued) queued.set(key, frame);
  if (!timer) {
    timer = setTimeout(() => { timer = undefined; void flushAtiDerivQuotes(); }, 1_000);
    timer.unref();
  }
}

export async function flushAtiDerivQuotes() {
  if (flushing) return flushing;
  if (!queued.size) return;
  const batch = [...queued.entries()];
  flushing = (async () => {
    try {
      const { db, atiDerivQuoteFramesTable } = await import("@workspace/db");
      await db.insert(atiDerivQuoteFramesTable).values(batch.map(([, frame]) => frame)).onConflictDoNothing();
      for (const [key] of batch) queued.delete(key);
    } catch {
      // Retries are bounded by the queue. If receipts are lost, the grader
      // will detect the hole before reporting a settlement.
      if (Date.now() - lastWarningAt >= 60_000) {
        lastWarningAt = Date.now();
        logger.warn("ATI public Deriv quote archive write unavailable");
      }
    } finally {
      flushing = undefined;
    }
  })();
  return flushing;
}

/** Called only after the public socket releases a validated subscription tick. */
export function recordPublicDerivQuote(tick: DerivTick, streamId: string, receivedAt: number, releasedAt: number) {
  if (!symbol.safeParse(tick.symbol).success || receivedAt <= 0 || releasedAt < receivedAt || releasedAt < tick.epoch * 1000) return;
  const frame = { streamId, symbol: tick.symbol, epoch: tick.epoch, receivedAt, releasedAt,
    bid: tick.bid ?? null, ask: tick.ask ?? null };
  framesByQuote.set(tick, frame);
  const existing = recent.get(tick.symbol);
  const recentFrames = existing?.at(-1)?.streamId === streamId ? existing : [];
  if (recentFrames.length >= 12) recentFrames.shift();
  recentFrames.push(frame);
  recent.set(tick.symbol, recentFrames);
  const capture = active.get(tick.symbol);
  if (!capture) return;
  if (capture.streamId !== streamId || releasedAt > capture.untilMs) active.delete(tick.symbol);
  else enqueue(frame);
}

export function transferAtiDerivQuoteFrame(from: object, to: object) {
  const frame = framesByQuote.get(from);
  if (frame) framesByQuote.set(to, frame);
}

export function publicDerivQuoteOrigin(quote: { timestamp: string; bid?: number; ask?: number }): AtiDerivQuoteOrigin | null {
  const frame = framesByQuote.get(quote);
  if (!frame || frame.bid == null || frame.ask == null || frame.bid !== quote.bid || frame.ask !== quote.ask ||
      frame.epoch * 1000 !== Date.parse(quote.timestamp)) return null;
  return { streamId: frame.streamId, symbol: frame.symbol, epoch: frame.epoch };
}

export function retainAtiDerivQuotes(origin: AtiDerivQuoteOrigin, decisionAt: number, untilMs: number) {
  const snapshot = recent.get(origin.symbol);
  const anchor = snapshot?.find((frame) => frame.streamId === origin.streamId && frame.epoch === origin.epoch);
  if (!snapshot || !anchor || anchor.releasedAt > decisionAt) return false;
  const current = active.get(origin.symbol);
  active.set(origin.symbol, { streamId: origin.streamId,
    untilMs: current?.streamId === origin.streamId ? Math.max(current.untilMs, untilMs) : untilMs });
  for (const frame of snapshot) {
    if (frame.epoch >= origin.epoch && frame.releasedAt <= untilMs) enqueue(frame);
  }
  return true;
}

/** A pre-issue quote on the already observed stream anchors a fixed-horizon study. */
export function retainSpecialistQuoteStudy(symbol: string, issuedAt: number, end: number) {
  const frame = recent.get(symbol)?.at(-1);
  const cadenceMs = symbol.startsWith("1HZ") ? 1000 : 2000;
  if (!frame || frame.bid == null || frame.ask == null || !(frame.bid > 0 && frame.ask >= frame.bid) ||
      frame.releasedAt > issuedAt || issuedAt - frame.epoch * 1000 > cadenceMs) return undefined;
  const origin = { streamId: frame.streamId, symbol, epoch: frame.epoch };
  if (!retainAtiDerivQuotes(origin, issuedAt, end + 5000)) return undefined;
  return { version: "fixed-horizon-bid-ask-v1" as const, ...origin, bid: frame.bid, ask: frame.ask };
}
