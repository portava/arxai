import { z } from "zod/v4";
import type { EleanorMarketEdgeSignal } from "@workspace/domain/signal-intelligence";

export const atiMarketContext = z.object({
  decidedAtMs: z.number().int().positive(),
  builtAtMs: z.number().int().positive(),
  regime: z.string(),
  bias: z.string(),
  direction: z.string(),
  lifecycleStage: z.string(),
  dataSource: z.string(),
  session: z.string().nullable(),
  source: z.string().nullable(),
  sourceIdentity: z.string().nullable(),
  lastClosedBarAt: z.iso.datetime().nullable(),
}).strict().refine((context) =>
  context.builtAtMs <= context.decidedAtMs &&
  (context.lastClosedBarAt == null || Date.parse(context.lastClosedBarAt) <= context.builtAtMs));

export type AtiMarketContext = z.infer<typeof atiMarketContext>;

export function captureAtiMarketContext(signal: EleanorMarketEdgeSignal, ownerId: number, decidedAtMs: number): AtiMarketContext | null {
  const builtAtMs = Date.parse(signal.generatedAt);
  const source = signal.marketEvidence;
  if (source?.source === "mt5_broker" && source.userId !== ownerId) return null;
  const result = atiMarketContext.safeParse({
    decidedAtMs, builtAtMs, regime: signal.regime, bias: signal.bias, direction: signal.direction,
    lifecycleStage: signal.lifecycleStage, dataSource: signal.dataSource, session: signal.session?.session ?? null,
    source: source?.source ?? null, sourceIdentity: source?.sourceIdentity ?? null, lastClosedBarAt: source?.lastClosedCandleAt ?? null,
  });
  return result.success ? result.data : null;
}
