import { createAccountSnapshotScheduler } from './accountSnapshotScheduler.js';
import { operatorRoleFromSession } from '../security/adminRoleGate.js';

/** Reuse the session authority; a live stream may not upgrade its initial
 * effective (including user-preview) operator capability. */
export async function resolveAccountStreamAuthorization(
  initialUserId: number,
  initialOperator: boolean,
  readSession: () => Promise<{ id: number; role: string } | null>,
): Promise<{ isOperator: boolean } | null> {
  const session = await readSession();
  return session?.id === initialUserId
    ? { isOperator: initialOperator && operatorRoleFromSession(session.role) != null }
    : null;
}

/** Advisory authorization only. Allocation rows are globally user-keyed; use
 * the existing allocation view, never invent a per-master allocation relation.
 * Re-read session and pin after the awaited view to reject changes during it.
 * This is a current-read check, not a transaction or a freshness guarantee. */
export async function resolveSharedAccountChangeScope(
  initialUserId: number,
  initialOperator: boolean,
  dependencies: {
    readSession: () => Promise<{ id: number; role: string } | null>;
    readView: (userId: number) => Promise<{ pool: { masterConnectionId: number } | null; hasAllocation: boolean }>;
    readPin: () => Promise<number | null>;
  },
): Promise<number | null> {
  const before = await dependencies.readSession();
  if (before?.id !== initialUserId) return null;
  const view = await dependencies.readView(initialUserId);
  const currentPin = await dependencies.readPin();
  const after = await dependencies.readSession();
  if (after?.id !== initialUserId) return null;
  // Initial effective role is a cap: user-preview must not become operator
  // merely because the persisted session still has its real operator role.
  const operator = initialOperator && operatorRoleFromSession(after.role) != null;
  if (!operator && !view.hasAllocation) return null;
  const connectionId = view.pool?.masterConnectionId;
  if (!Number.isSafeInteger(connectionId) || connectionId! <= 0) return null;
  if (currentPin !== connectionId) return null;
  return connectionId!;
}

type ConnectionBus = {
  onConnection: (connectionId: number, listener: () => void) => void;
  offConnection: (connectionId: number, listener: () => void) => void;
};

/** Same-process invalidation hints only: no funds, identifiers or freshness.
 * Binding precedes its first hint (and thus the client's initial refetch).
 * Bursts and events arriving during checks earn one serialized trailing check.
 */
export function createSharedAccountChangeStream(options: {
  bus: ConnectionBus;
  readScope: () => Promise<number | null>;
  sendHint: () => void;
  schedulerOptions?: Parameters<typeof createAccountSnapshotScheduler>[1];
}) {
  let stopped = false;
  let bound: { id: number; listener: () => void } | null = null;
  let pending = new Set<number>();
  const unbind = () => {
    if (bound) options.bus.offConnection(bound.id, bound.listener);
    bound = null;
  };
  const scheduler = createAccountSnapshotScheduler(async () => {
    const events = pending;
    pending = new Set();
    let id: number | null;
    try { id = await options.readScope(); }
    catch { if (!stopped) unbind(); return; }
    if (stopped) return;
    if (id == null || !Number.isSafeInteger(id) || id <= 0) { unbind(); return; }
    const changed = bound?.id !== id;
    if (changed) {
      unbind();
      const listener = () => {
        if (stopped || bound?.id !== id) return;
        pending.add(id);
        scheduler.request();
      };
      bound = { id, listener };
      options.bus.onConnection(id, listener);
    }
    if (changed || events.has(id)) options.sendHint();
  }, options.schedulerOptions);
  return {
    request: () => scheduler.request(),
    stop() { stopped = true; scheduler.stop(); pending.clear(); unbind(); },
  };
}
