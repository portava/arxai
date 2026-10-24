// Broker Hub — the one reader of the cached broker health verdict
// (broker_health_state) and its audit trail (broker_health_logs).
//
// broker_health_state is a platform singleton: the operator toggles
// (executionEnabled, maintenanceMode), reconnect bookkeeping, the last bridge
// error and the cached result of the last health evaluation (lastStatus /
// lastEvaluatedAt). It answers "was the broker connected when we last
// checked" — a cache, not live truth. Live telemetry stays in mt5_state
// (mt5StateReader.ts) and mt5_connection (connections.ts).
//
// The writer is the health monitor route (routes/brokerHealth.ts): it creates
// the singleton, persists each evaluation and applies operator toggles. It
// reads the row back through this file like every other caller. The hub stays
// a read-only boundary (ci guard broker-hub-no-execution).
//
// Before this module the singleton was read raw in five places; three of them
// took `.limit(1)` without an order, so with a duplicate row (possible after a
// concurrent first write) they could read a different row than the route that
// writes the cache. Every read now takes the lowest-id row, the canonical one.
//
// Honesty: lastStatus is returned with lastEvaluatedAt so callers can label a
// stale verdict stale. Nothing here derives or upgrades a connected state;
// a missing row is null (callers report "unknown"), never CONNECTED.
// CI guard single-broker-state-source keeps these tables behind this file.

import { db, brokerHealthLogsTable, brokerHealthStateTable } from "@workspace/db";
import { asc, desc } from "drizzle-orm";

export type BrokerHealthStateRow = typeof brokerHealthStateTable.$inferSelect;
export type BrokerHealthLogRow = typeof brokerHealthLogsTable.$inferSelect;

/** A db handle or an open transaction. */
type Reader = Pick<typeof db, "select">;

/** The canonical (lowest-id) broker health singleton, or null before the first evaluation. */
export async function readBrokerHealthState(reader: Reader = db): Promise<BrokerHealthStateRow | null> {
  const rows = await reader.select().from(brokerHealthStateTable)
    .orderBy(asc(brokerHealthStateTable.id))
    .limit(1);
  return rows[0] ?? null;
}

/** Newest health snapshots first. */
export function listBrokerHealthLogs(limit: number): Promise<BrokerHealthLogRow[]> {
  return db.select().from(brokerHealthLogsTable)
    .orderBy(desc(brokerHealthLogsTable.createdAt))
    .limit(limit);
}

/** The newest health snapshot, or null when none was ever persisted. */
export async function readLatestBrokerHealthLog(): Promise<BrokerHealthLogRow | null> {
  return (await listBrokerHealthLogs(1))[0] ?? null;
}
