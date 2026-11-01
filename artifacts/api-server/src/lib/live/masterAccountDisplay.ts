// Read-only projection. Broker Hub owns connection identity and the account
// update marker. Stored values may include never-observed database defaults
// after a partial update; observation times for every field and a coherent
// full account report are not proven. This adapter never substitutes pool money or heartbeat freshness.
import { connectionAccountSnapshot, type ConnectionAccountFacts } from '../brokerHub/accountSnapshot.js';
import { MT5_ACCOUNT_SNAPSHOT_FRESH_MS } from '../brokerHub/freshness.js';

export interface MasterAccountDisplayInput {
  masterConnectionId: number | null;
  connection: ConnectionAccountFacts | null;
  nowMs: number;
}
// Preserve the stored scalar exactly; currency-specific formatting belongs to
// presentation. Fixed two-decimal rounding can erase real sub-cent amounts.
const money = (value: number | null): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function projectPinnedMasterAccount(input: MasterAccountDisplayInput) {
  const pinned = Number.isSafeInteger(input.masterConnectionId) && input.masterConnectionId! > 0
    && input.connection?.id === input.masterConnectionId ? input.connection : null;
  const snapshot = connectionAccountSnapshot(pinned);
  const validTime = snapshot.status === 'observed' && snapshot.observedAtMs !== null
    && snapshot.observedAtMs > 0 && Number.isFinite(input.nowMs) && input.nowMs > 0
    && snapshot.observedAtMs <= input.nowMs;
  const snapshotAgeMs = validTime ? input.nowMs - snapshot.observedAtMs! : null;
  const mt5Balance = validTime ? money(snapshot.balance) : null;
  const mt5Equity = validTime ? money(snapshot.equity) : null;
  const snapshotStatus: 'FRESH' | 'STALE' | 'MISSING' =
    snapshotAgeMs === null || mt5Balance === null || mt5Equity === null ? 'MISSING'
      : snapshotAgeMs > MT5_ACCOUNT_SNAPSHOT_FRESH_MS ? 'STALE' : 'FRESH';
  return {
    mt5Balance,
    mt5Equity,
    mt5UsedMargin: validTime ? money(snapshot.margin) : null,
    mt5FreeMargin: validTime ? money(snapshot.freeMargin) : null,
    // Current heartbeat and sync-account schemas require balance AND equity;
    // optional margins can still retain older values or database defaults.
    // The stored marker does not date each field. Direct broker account profit
    // is absent from this view; equity minus balance is not a verified report
    // of ACCOUNT_PROFIT. Keep P/L unavailable rather than substitute it.
    mt5OpenPnl: null,
    accountCurrency: validTime ? snapshot.currency : null,
    accountObservationScope: 'LATEST_ACCOUNT_UPDATE' as const,
    amountsCoherent: false as const,
    snapshotStatus,
    snapshotAgeMs,
    lastMt5SnapshotAt: validTime ? snapshot.observedAt : null,
    syncStatus: snapshotStatus === 'FRESH' ? 'LIVE' as const : snapshotStatus === 'STALE' ? 'STALE' as const : 'UNAVAILABLE' as const,
  };
}
