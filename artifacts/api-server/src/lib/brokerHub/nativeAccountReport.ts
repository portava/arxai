// Read-only native account report projection. Never an execution/risk authority.
import { createHash } from 'node:crypto';
import { bridgeV2 } from '@workspace/domain';
export interface NativeAccountConnection {
    readonly id: number;
    readonly userId: number | null;
    readonly accountNumber?: string | null;
    readonly serverName?: string | null;
}
export interface NativeAccountReceipt {
    readonly userId: number;
    readonly bridgeConnectionId: number | null;
    readonly protocolVersion: number;
    readonly messageType: string;
    readonly streamKey: string;
    readonly sequence: number;
    readonly idempotencyKey: string;
    readonly eaVersion?: string | null;
    readonly eaCreatedAtEpochMs?: number | null;
    readonly accepted: boolean;
    readonly sequenceVerdict: string;
    readonly duplicateDropped?: boolean;
    readonly serverReceivedAtEpochMs?: number | null;
    readonly payload: unknown;
}
export interface NativeAccountReportView {
    status: 'reported' | 'unavailable';
    reason: string;
    currentVerified: false;
    observedAt: string | null;
    receivedAt: string | null;
    observationAgeMs: number | null;
    currency: string | null;
    currencyDigits: number | null;
    amounts: {
        balance: string;
        equity: string;
        profit: string;
        credit: string;
        margin: string;
        freeMargin: string;
    } | null;
}
export function nativeAccountBinding(login: string | null | undefined, server: string | null | undefined): string | null {
    if (typeof login !== 'string' || !/^\d+$/.test(login) || login.length > 64 || typeof server !== 'string' || server.trim().length === 0 || server.includes('\0'))
        return null;
    const canonical = BigInt(login);
    if (canonical <= 0n)
        return null;
    return createHash('sha256').update('ARX_ACCOUNT_V1\n' + canonical.toString() + '\n' + server, 'utf8').digest('hex');
}
const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const validTime = (value: unknown): value is number => validId(value) && value <= 8640000000000000;
export function validNativeAccountConnection(connection: NativeAccountConnection | null | undefined): connection is NativeAccountConnection & {
    userId: number;
} { return !!connection && validId(connection.id) && validId(connection.userId); }
function unavailable(reason: string, receivedAt: string | null = null): NativeAccountReportView { return { status: 'unavailable', reason, currentVerified: false, observedAt: null, receivedAt, observationAgeMs: null, currency: null, currencyDigits: null, amounts: null }; }
/** Latest attempt only: callers must never search backward for a usable report. */
export function projectNativeAccountReport(connection: NativeAccountConnection | null, receipt: NativeAccountReceipt | null, nowMs: number): NativeAccountReportView {
    if (!validNativeAccountConnection(connection))
        return unavailable('CONNECTION_SCOPE_UNAVAILABLE');
    if (!receipt)
        return unavailable('NO_ACCOUNT_REPORT');
    if (receipt.userId !== connection.userId || receipt.bridgeConnectionId !== connection.id || receipt.messageType !== 'ACCOUNT_SNAPSHOT')
        return unavailable('ACCOUNT_SCOPE_MISMATCH');
    if (!validTime(nowMs) || !validTime(receipt.serverReceivedAtEpochMs) || receipt.serverReceivedAtEpochMs > nowMs)
        return unavailable('RECEIPT_TIME_INVALID');
    const receivedAt = new Date(receipt.serverReceivedAtEpochMs).toISOString();
    if (!receipt.accepted || receipt.duplicateDropped)
        return unavailable('ACCOUNT_REPORT_REJECTED', receivedAt);
    if (!['FIRST', 'IN_ORDER', 'GAP'].includes(receipt.sequenceVerdict))
        return unavailable('ACCOUNT_SEQUENCE_UNVERIFIED', receivedAt);
    if (receipt.protocolVersion !== 2)
        return unavailable('ACCOUNT_PROTOCOL_UNSUPPORTED', receivedAt);
    if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 0 || receipt.sequence > bridgeV2.NATIVE_ACCOUNT_MAX_SEQUENCE)
        return unavailable('ACCOUNT_SEQUENCE_UNVERIFIED', receivedAt);
    if (!receipt.payload || typeof receipt.payload !== 'object' || !Object.prototype.hasOwnProperty.call(receipt.payload, 'reportVersion'))
        return unavailable('LEGACY_ACCOUNT_REPORT_UNVERIFIED', receivedAt);
    const parsed = bridgeV2.nativeAccountReportPayloadSchema.safeParse(receipt.payload);
    if (!parsed.success)
        return unavailable('NATIVE_ACCOUNT_REPORT_INVALID', receivedAt);
    if (receipt.streamKey !== bridgeV2.NATIVE_ACCOUNT_STREAM)
        return unavailable('UNEXPECTED_ACCOUNT_STREAM', receivedAt);
    const report = parsed.data;
    const binding = nativeAccountBinding(connection.accountNumber, connection.serverName);
    if (!binding || report.accountBinding !== binding)
        return unavailable('ACCOUNT_BINDING_MISMATCH', receivedAt);
    if (!validTime(report.observedAtEpochMs) || report.observedAtEpochMs > receipt.serverReceivedAtEpochMs || report.observedAtEpochMs > nowMs || !validTime(receipt.eaCreatedAtEpochMs) || receipt.eaCreatedAtEpochMs < report.observedAtEpochMs || receipt.eaCreatedAtEpochMs > receipt.serverReceivedAtEpochMs)
        return unavailable('CAPTURE_TIME_INVALID', receivedAt);
    if (!report.terminalConnected)
        return unavailable('TERMINAL_DISCONNECTED', receivedAt);
    const { balance, equity, profit, credit, margin, freeMargin } = report;
    return { status: 'reported', reason: 'CLOCK_AND_CONTINUITY_UNVERIFIED', currentVerified: false, observedAt: new Date(report.observedAtEpochMs).toISOString(), receivedAt, observationAgeMs: nowMs - report.observedAtEpochMs, currency: report.currency, currencyDigits: report.currencyDigits, amounts: { balance, equity, profit, credit, margin, freeMargin } };
}
/** A correlated replay means exactly the previously stored accepted message,
 * not merely a repeated key or sequence. JSONB object key order is irrelevant. */
export function isExactNativeAccountReplay(stored: NativeAccountReceipt | null | undefined, incoming: NativeAccountReceipt): boolean {
    if (!stored || !stored.accepted || stored.duplicateDropped || !Number.isSafeInteger(stored.sequence) || stored.sequence < 0 || stored.sequence > bridgeV2.NATIVE_ACCOUNT_MAX_SEQUENCE)
        return false;
    const keys = ['userId', 'bridgeConnectionId', 'protocolVersion', 'messageType', 'streamKey', 'sequence', 'idempotencyKey', 'eaVersion', 'eaCreatedAtEpochMs'] as const;
    if (keys.some(key => stored[key] !== incoming[key]))
        return false;
    const old = bridgeV2.nativeAccountReportPayloadSchema.safeParse(stored.payload), next = bridgeV2.nativeAccountReportPayloadSchema.safeParse(incoming.payload);
    return old.success && next.success && JSON.stringify(old.data) === JSON.stringify(next.data);
}
/** Compatibility fields never convert native decimal strings into numbers. */
export function projectLegacyAccountMoney(connection: NativeAccountConnection | null, receipt: NativeAccountReceipt | null, nowMs: number) {
    const empty = { accountBalance: null as number | null, accountEquity: null as number | null, accountCurrency: null as string | null, lastAccountSnapshotAt: null as string | null };
    if (!validNativeAccountConnection(connection) || !receipt || receipt.userId !== connection.userId || receipt.bridgeConnectionId !== connection.id || receipt.messageType !== 'ACCOUNT_SNAPSHOT' || receipt.protocolVersion !== 2 || !receipt.accepted || receipt.duplicateDropped || !['FIRST', 'IN_ORDER', 'GAP'].includes(receipt.sequenceVerdict) || !validTime(nowMs) || !validTime(receipt.serverReceivedAtEpochMs) || receipt.serverReceivedAtEpochMs > nowMs)
        return empty;
    const legacy = bridgeV2.legacyAccountSnapshotPayloadSchema.safeParse(receipt.payload);
    if (!legacy.success)
        return empty;
    return { accountBalance: legacy.data.balance, accountEquity: legacy.data.equity, accountCurrency: legacy.data.currency, lastAccountSnapshotAt: new Date(receipt.serverReceivedAtEpochMs).toISOString() };
}
