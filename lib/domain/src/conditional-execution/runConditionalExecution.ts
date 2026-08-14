import { evaluateArmedOrder } from "./evaluateArmedOrder.engine";
import type {
  ArmedOrder, ArmedOrderStorePort, ConditionalExecutionPort,
  EvaluationContext, FireOutcome, TickOutcome,
} from "./conditionalExecution.types";

// runConditionalExecutionTick — single tick orchestrator.
//
// For each armed order in the store:
//   • evaluate against the matching EvaluationContext
//   • on FIRE     — call ConditionalExecutionPort.sendOrder, record outcome,
//                   set status FIRED (regardless of broker result — the
//                   armed order is consumed once we attempted to send;
//                   broker result lives in the FireOutcome).
//   • on EXPIRE   — set status EXPIRED
//   • on INVALIDATE — set status INVALIDATED
//   • on STILL_ARMED — no status change
//
// The caller must supply a `getContext` function that returns the right
// EvaluationContext for a given armed order — this is where the caller
// wires in their market-data slice for that order's symbol/window.
//
// Orders without a context (getContext returned null) are skipped with a
// reason — defensive against partial market-data outages.
export interface RunTickDeps {
  store: ArmedOrderStorePort;
  executionPort: ConditionalExecutionPort;
  getContext: (order: ArmedOrder) => EvaluationContext | null;
}

export async function runConditionalExecutionTick(
  deps: RunTickDeps,
): Promise<TickOutcome[]> {
  const armed = await deps.store.listArmed();
  const outcomes: TickOutcome[] = [];

  for (const order of armed) {
    const ctx = deps.getContext(order);
    if (ctx === null) {
      outcomes.push({
        armedOrderId: order.armedOrderId,
        action: "STILL_ARMED",
        newStatus: "ARMED",
        conditionEvaluations: [],
        fireOutcome: null,
        reasons: ["no evaluation context available — skipped this tick"],
      });
      continue;
    }

    const evalResult = evaluateArmedOrder(order, ctx);

    switch (evalResult.action) {
      case "STILL_ARMED": {
        outcomes.push({
          armedOrderId: order.armedOrderId,
          action: "STILL_ARMED",
          newStatus: "ARMED",
          conditionEvaluations: evalResult.conditionEvaluations,
          fireOutcome: null,
          reasons: evalResult.reasons,
        });
        break;
      }
      case "EXPIRE": {
        await deps.store.updateStatus(order.armedOrderId, "EXPIRED");
        outcomes.push({
          armedOrderId: order.armedOrderId,
          action: "EXPIRE",
          newStatus: "EXPIRED",
          conditionEvaluations: evalResult.conditionEvaluations,
          fireOutcome: null,
          reasons: evalResult.reasons,
        });
        break;
      }
      case "INVALIDATE": {
        await deps.store.updateStatus(order.armedOrderId, "INVALIDATED");
        outcomes.push({
          armedOrderId: order.armedOrderId,
          action: "INVALIDATE",
          newStatus: "INVALIDATED",
          conditionEvaluations: evalResult.conditionEvaluations,
          fireOutcome: null,
          reasons: evalResult.reasons,
        });
        break;
      }
      case "FIRE": {
        // Mark FIRED FIRST, then attempt the send. Marking before sending
        // prevents double-fire on retry/race; the broker outcome is
        // captured in fireOutcome regardless.
        await deps.store.updateStatus(order.armedOrderId, "FIRED");
        const fireOutcome = await sendAndCapture(deps.executionPort, order);
        outcomes.push({
          armedOrderId: order.armedOrderId,
          action: "FIRE",
          newStatus: "FIRED",
          conditionEvaluations: evalResult.conditionEvaluations,
          fireOutcome,
          reasons: [...evalResult.reasons, ...fireOutcome.reasons],
        });
        break;
      }
    }
  }

  return outcomes;
}

async function sendAndCapture(
  port: ConditionalExecutionPort,
  order: ArmedOrder,
): Promise<FireOutcome> {
  const reasons: string[] = [];
  try {
    const raw = await port.sendOrder({
      ...order.pendingOrder,
      clientOrderId: order.armedOrderId,
    });
    if (!raw.ok) {
      reasons.push(`broker rejected: ${raw.errorMessage ?? raw.errorCode ?? "unknown"}`);
      return {
        status: "REJECTED",
        brokerOrderId: null, fillPrice: null, fillTime: null,
        reasons,
      };
    }
    reasons.push(`broker accepted: brokerOrderId ${raw.brokerOrderId ?? "—"}, fill ${raw.fillPrice ?? "—"}`);
    return {
      status: "FILLED",
      brokerOrderId: raw.brokerOrderId ?? null,
      fillPrice: raw.fillPrice ?? null,
      fillTime: raw.fillTime ?? null,
      reasons,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reasons.push(`port threw: ${msg}`);
    return {
      status: "ERROR",
      brokerOrderId: null, fillPrice: null, fillTime: null,
      reasons,
    };
  }
}
