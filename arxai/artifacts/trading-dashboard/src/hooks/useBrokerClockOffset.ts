// useBrokerClockOffset — the signed-in trader's OWN bridge broker clock − UTC
// offset (GET /api/me/broker-clock), so the order window's "Today" expiry ends
// at the end of the broker's trading day, not 23:59 UTC. null = unknown (no
// bridge, or no measurement yet): "Today" then ends 23:59 UTC and the ticket
// says so.
import { useQuery } from "@tanstack/react-query";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export interface BrokerClock {
  bridgeConnectionId: number | null;
  brokerClockOffsetMs: number | null;
  brokerClockOffsetMeasuredAt: string | null;
}

export const BROKER_CLOCK_UNKNOWN_HINT = "Broker clock unknown — 'Today' ends 23:59 UTC";

export function parseBrokerClock(raw: unknown): BrokerClock {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    bridgeConnectionId: num(r.bridgeConnectionId),
    brokerClockOffsetMs: num(r.brokerClockOffsetMs),
    brokerClockOffsetMeasuredAt: typeof r.brokerClockOffsetMeasuredAt === "string" ? r.brokerClockOffsetMeasuredAt : null,
  };
}

export function useBrokerClockOffset(enabled: boolean = true): { offsetMs: number | null; loading: boolean; clock: BrokerClock | null } {
  const q = useQuery<BrokerClock>({
    queryKey: ["me-broker-clock"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/me/broker-clock`, { credentials: "include" });
      if (!r.ok) throw new Error(`broker-clock ${r.status}`);
      return parseBrokerClock(await r.json());
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return { offsetMs: q.data?.brokerClockOffsetMs ?? null, loading: q.isLoading && enabled, clock: q.data ?? null };
}
