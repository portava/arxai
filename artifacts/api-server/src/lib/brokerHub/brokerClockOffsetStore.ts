// Durable side of the per-bridge broker clock offset (brokerClockOffset.ts):
// mt5_connection.broker_clock_offset_ms / broker_clock_offset_measured_at,
// written and read through the Broker Hub connection store. Best-effort both
// ways — a failed write or read leaves the in-memory measurement (or
// "unknown") exactly as it would be without persistence.
// Requires lib/db/migrations/2026-11-04_broker_clock_offset.sql.

import { getConnection, updateConnection } from "./connections.js";
import { setBrokerClockOffsetPersistence } from "./brokerClockOffset.js";

export async function persistBrokerClockOffset(bridgeConnectionId: number, offsetMs: number, measuredAtMs: number): Promise<void> {
  await updateConnection(bridgeConnectionId, { brokerClockOffsetMs: offsetMs, brokerClockOffsetMeasuredAt: new Date(measuredAtMs) });
}

export async function readPersistedBrokerClockOffset(bridgeConnectionId: number): Promise<{ offsetMs: number | null; measuredAtMs: number | null } | null> {
  const row = await getConnection(bridgeConnectionId);
  if (!row) return null;
  return { offsetMs: row.brokerClockOffsetMs ?? null, measuredAtMs: row.brokerClockOffsetMeasuredAt?.getTime() ?? null };
}

/** Boot wiring: register the mt5_connection writer/reader. */
export function installBrokerClockOffsetPersistence(): void {
  setBrokerClockOffsetPersistence({ persist: persistBrokerClockOffset, seed: readPersistedBrokerClockOffset });
}
