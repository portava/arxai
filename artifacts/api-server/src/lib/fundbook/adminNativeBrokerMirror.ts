// Operator display projection only. Fund accounting and execution continue to
// use their existing explicitly separate inputs; this helper cannot write them.
import { listConnections } from '../brokerHub/connections.js';
import { loadNativeAccountReport } from '../brokerHub/nativeAccountReportReader.js';
import { validNativeAccountConnection, type NativeAccountReportView } from '../brokerHub/nativeAccountReport.js';

type BridgeScope = { bridgeConnectionId: number; userId: number | null };
const unavailable = (reason: string): NativeAccountReportView => ({
  status: 'unavailable', reason, currentVerified: false,
  observedAt: null, receivedAt: null, observationAgeMs: null,
  currency: null, currencyDigits: null, amounts: null,
});

/** Called only after the operator route gate. No login, server, binding hash or
 * connection credentials enter the returned DTO. A changed/missing owner fails
 * closed rather than using an unrelated connection or retained scalar money. */
export async function appendAdminNativeAccountReports<T extends BridgeScope>(
  bridges: readonly T[],
): Promise<Array<T & { nativeAccountReport: NativeAccountReportView }>> {
  if (bridges.length === 0) return [];
  let connections: Awaited<ReturnType<typeof listConnections>>;
  try { connections = await listConnections(); }
  catch { return bridges.map(bridge => ({ ...bridge, nativeAccountReport: unavailable('ACCOUNT_REPORT_READ_FAILED') })); }

  const output: Array<T & { nativeAccountReport: NativeAccountReportView }> = [];
  // Bound read fanout for an all-connection operator page. Each native reader
  // selects the latest attempt for this exact captured owner/connection/binding.
  for (let start = 0; start < bridges.length; start += 8) {
    const batch = await Promise.all(bridges.slice(start, start + 8).map(async bridge => {
      const matches = connections.filter(connection => connection.id === bridge.bridgeConnectionId);
      const connection = matches.length === 1 ? matches[0] : null;
      let nativeAccountReport: NativeAccountReportView;
      if (!validNativeAccountConnection(connection) || connection.userId !== bridge.userId) {
        nativeAccountReport = unavailable('ACCOUNT_SCOPE_MISMATCH');
      } else {
        try { nativeAccountReport = await loadNativeAccountReport(connection); }
        catch { nativeAccountReport = unavailable('ACCOUNT_REPORT_READ_FAILED'); }
      }
      return { ...bridge, nativeAccountReport };
    }));
    for (const row of batch) output.push(row);
  }
  return output;
}
