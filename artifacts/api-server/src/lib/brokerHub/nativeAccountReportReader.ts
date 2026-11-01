// One latest-attempt reader. No accepted/stream filter: a newer rejection,
// malformed version or wrong stream must withhold an older historical report.
import { db, bridgeV2EventsTable } from '@workspace/db';
import { and, desc, eq } from 'drizzle-orm';
import { projectNativeAccountReport, projectLegacyAccountMoney, validNativeAccountConnection, type NativeAccountConnection, type NativeAccountReceipt } from './nativeAccountReport.js';
export async function loadLatestAccountReportAttempt(connection: NativeAccountConnection | null): Promise<NativeAccountReceipt | null> {
    if (!validNativeAccountConnection(connection))
        return null;
    const rows = await db.select({ userId: bridgeV2EventsTable.userId, bridgeConnectionId: bridgeV2EventsTable.bridgeConnectionId, protocolVersion: bridgeV2EventsTable.protocolVersion, messageType: bridgeV2EventsTable.messageType, streamKey: bridgeV2EventsTable.streamKey, sequence: bridgeV2EventsTable.sequence, idempotencyKey: bridgeV2EventsTable.idempotencyKey, eaVersion: bridgeV2EventsTable.eaVersion, eaCreatedAtEpochMs: bridgeV2EventsTable.eaCreatedAtEpochMs, accepted: bridgeV2EventsTable.accepted, sequenceVerdict: bridgeV2EventsTable.sequenceVerdict, duplicateDropped: bridgeV2EventsTable.duplicateDropped, serverReceivedAtEpochMs: bridgeV2EventsTable.serverReceivedAtEpochMs, payload: bridgeV2EventsTable.payload })
        .from(bridgeV2EventsTable).where(and(eq(bridgeV2EventsTable.userId, connection.userId), eq(bridgeV2EventsTable.bridgeConnectionId, connection.id), eq(bridgeV2EventsTable.messageType, 'ACCOUNT_SNAPSHOT')))
        .orderBy(desc(bridgeV2EventsTable.id)).limit(1);
    return rows[0] ?? null;
}
export async function loadNativeAccountReport(connection: NativeAccountConnection | null, now: () => number = Date.now) {
    const receipt = await loadLatestAccountReportAttempt(connection);
    return projectNativeAccountReport(connection, receipt, now());
}
export async function loadBridgeV2AccountReport(connection: NativeAccountConnection | null, now: () => number = Date.now) {
    const receipt = await loadLatestAccountReportAttempt(connection);
    const nowMs = now();
    const nativeAccountReport = projectNativeAccountReport(connection, receipt, nowMs);
    const legacy = projectLegacyAccountMoney(connection, receipt, nowMs);
    return { ...legacy, lastAccountSnapshotAt: nativeAccountReport.status === 'reported' ? nativeAccountReport.observedAt : legacy.lastAccountSnapshotAt, accountAmountsCurrentVerified: false as const, accountMoneyReason: nativeAccountReport.reason, nativeAccountReport };
}
