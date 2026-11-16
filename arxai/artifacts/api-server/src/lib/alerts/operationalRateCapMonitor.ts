/** Observation after a durable order-guard refusal, never an execution gate.
 * The shared dashboard alert writer owns hourly database deduplication. This
 * monitor only bounds concurrent delivery attempts; it never retries orders. */
export interface AuditedOrderOutcome {
  userId: number;
  auditLogId: number;
  mode: string;
  status: string;
  reason: string | null;
}

export interface OperationalRateCapEvent {
  event: "OPERATIONAL_RATE_CAP_REACHED";
  userId: number;
  auditLogId: number;
  mode: "SIMULATED" | "DEMO" | "LIVE";
  cap: number;
  windowHours: 24;
  observedAt: string;
}

export interface RateCapAlert {
  alertType: "operational_rate_cap";
  severity: "warning";
  source: "risk";
  title: string;
  message: string;
}

type Warning = {
  event: "OPERATIONAL_RATE_CAP_ALERT_UNAVAILABLE";
  userId: number;
  auditLogId: number;
  reason: "DELIVERY_FAILED" | "DELIVERY_TIMEOUT" | "CAPACITY_REACHED";
};

export function createOperationalRateCapMonitor(deps: {
  emit: (event: OperationalRateCapEvent | Warning) => void;
  notify: (userId: number, alert: RateCapAlert) => Promise<unknown>;
}, options: { timeoutMs?: number; maxPending?: number; now?: () => number } = {}) {
  const pending = new Set<number>();
  const emit = (event: OperationalRateCapEvent | Warning) => {
    try { deps.emit(event); } catch { /* Monitoring cannot change an audited refusal. */ }
  };
  return (input: AuditedOrderOutcome): void => {
    if (input.status !== "REJECTED" || !Number.isSafeInteger(input.userId) || input.userId <= 0
      || !Number.isSafeInteger(input.auditLogId) || input.auditLogId <= 0
      || !["SIMULATED", "DEMO", "LIVE"].includes(input.mode)) return;
    // Match the existing guard's exact code, never raw request/provider text.
    const match = /^OPERATIONAL_RATE_CAP_REACHED:([1-9][0-9]{0,9})_APPROVED_COMMANDS_PER_ROLLING_24H$/.exec(input.reason ?? "");
    if (!match) return;
    const event: OperationalRateCapEvent = {
      event: "OPERATIONAL_RATE_CAP_REACHED", userId: input.userId, auditLogId: input.auditLogId,
      mode: input.mode as OperationalRateCapEvent["mode"], cap: Number(match[1]), windowHours: 24,
      observedAt: new Date((options.now ?? Date.now)()).toISOString(),
    };
    emit(event);
    // Every audited refusal has a log event; concurrent requests for the same
    // owner share one dashboard delivery. Other owners never share an alert.
    if (pending.has(input.userId)) return;
    const warn = (reason: Warning["reason"]) => emit({
      event: "OPERATIONAL_RATE_CAP_ALERT_UNAVAILABLE", userId: event.userId,
      auditLogId: event.auditLogId, reason,
    });
    if (pending.size >= (options.maxPending ?? 256)) { warn("CAPACITY_REACHED"); return; }
    pending.add(input.userId);
    const timer = setTimeout(() => warn("DELIVERY_TIMEOUT"), options.timeoutMs ?? 2_000);
    timer.unref();
    // Detached, bounded delivery: a hung alert database cannot hold an order
    // response open or accumulate repeated writes for that user. Retain the
    // in-flight slot after timeout until the underlying write actually settles.
    void Promise.resolve().then(() => deps.notify(event.userId, {
      alertType: "operational_rate_cap", severity: "warning", source: "risk",
      title: "Operational command limit reached",
      message: `An order request was rejected at your operational cap of ${event.cap} approved commands in a rolling 24-hour window. This cap is separate from the daily trade limit. The rejected request was not approved.`,
    })).catch(() => warn("DELIVERY_FAILED")).finally(() => {
      clearTimeout(timer);
      pending.delete(event.userId);
    });
  };
}
