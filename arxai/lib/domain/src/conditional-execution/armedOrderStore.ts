import type {
  ArmedOrder, ArmedOrderStatus, ArmedOrderStorePort,
} from "./conditionalExecution.types";

// inMemoryArmedOrderStore — minimal reference implementation of the typed
// ArmedOrderStorePort. Real implementations would persist (Postgres / Redis).
//
// listArmed() returns ONLY orders currently in ARMED state — the tick
// orchestrator uses this to know what to evaluate.
export function createInMemoryArmedOrderStore(): ArmedOrderStorePort {
  const orders = new Map<string, ArmedOrder>();

  return {
    async put(order) {
      orders.set(order.armedOrderId, { ...order });
    },
    async get(armedOrderId) {
      const o = orders.get(armedOrderId);
      return o ? { ...o } : null;
    },
    async listArmed() {
      return Array.from(orders.values()).filter((o) => o.status === "ARMED");
    },
    async updateStatus(armedOrderId: string, status: ArmedOrderStatus) {
      const o = orders.get(armedOrderId);
      if (!o) throw new Error(`armed order ${armedOrderId} not found — cannot update status`);
      o.status = status;
      orders.set(armedOrderId, o);
    },
  };
}
