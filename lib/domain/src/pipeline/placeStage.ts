import { createDomainEvent } from "../events/eventFactory";
import type { ExecutionPort } from "./ports";
import type { PipelineContext, StageResult, ApproveOutput, PlaceOutput } from "./pipeline.types";

// IO stage — calls ExecutionPort. Returns a uniform StageResult that captures
// the order outcome plus a TRADE_OPENED event on success.
export async function runPlace(
  ctx: PipelineContext,
  approved: ApproveOutput,
  port: ExecutionPort,
  now: () => Date = () => new Date(),
): Promise<StageResult<PlaceOutput>> {
  const start = now().getTime();
  const sig = ctx.signal;
  const direction = sig.direction;
  if (!direction) {
    return {
      stage: "PLACE", status: "REJECTED", output: null,
      reasons: ["Signal has no direction (action=WAIT/AVOID?)"],
      events: [], durationMs: now().getTime() - start,
    };
  }

  try {
    const placed = await port.place({
      symbol: sig.symbol,
      direction,
      lotSize: approved.approvedLotSize,
      stopLoss: approved.approvedStopLoss,
      takeProfit: approved.approvedTakeProfit,
      correlationId: ctx.correlationId,
    });

    const event = createDomainEvent("TRADE_OPENED", {
      source: ctx.source, correlationId: ctx.correlationId,
      tradeId: placed.trade.id,
      symbol: placed.trade.symbol,
      direction: placed.trade.direction,
      entryPrice: placed.filledPrice,
      stopLoss: placed.trade.stopLoss,
      takeProfit: placed.trade.takeProfit ?? null,
      lotSize: placed.trade.lotSize,
      strategy: sig.strategy,
      signalId: sig.id,
    }, { now });

    return {
      stage: "PLACE", status: "PASSED", output: placed,
      reasons: [`Filled at ${placed.filledPrice} (slippage ${placed.slippage.toFixed(5)}, latency ${placed.latencyMs}ms)`],
      events: [event],
      durationMs: now().getTime() - start,
    };
  } catch (err) {
    return {
      stage: "PLACE", status: "ERRORED", output: null,
      reasons: [`Execution port error: ${(err as Error).message}`],
      events: [], durationMs: now().getTime() - start,
    };
  }
}
