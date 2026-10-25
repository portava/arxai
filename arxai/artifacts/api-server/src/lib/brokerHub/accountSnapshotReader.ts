// Broker Hub read side of the authoritative account snapshot (owner decision 16).
//
// Every read is scoped to one user: the connection must belong to `userId`
// (getUserConnection) and the legacy projection is that user's own mt5_state
// row (readLatestUserMt5State). The platform (ownerless) mt5_state row and
// other users' rows are never read here.

import {
  connectionAccountSnapshot,
  legacyStateAccountSnapshot,
  reconcileAccountSnapshots,
  selectConnectionAccountSnapshot,
  type AccountReconciliation,
  type AccountSnapshot,
} from "./accountSnapshot.js";
import { getUserConnection } from "./connections.js";
import { readLatestUserMt5State } from "./mt5StateReader.js";

/** The authoritative snapshot of one of `userId`'s connections (unknown when not theirs or never synced). */
export async function readConnectionAccountSnapshot(userId: number, connectionId: number): Promise<AccountSnapshot> {
  return connectionAccountSnapshot(await getUserConnection(userId, connectionId));
}

/**
 * Diff `userId`'s connection snapshot against that user's legacy mt5_state
 * projection. Report only: nothing is chosen or written.
 */
export async function readConnectionAccountReconciliation(userId: number, connectionId: number): Promise<AccountReconciliation> {
  const [conn, legacyRow] = await Promise.all([
    getUserConnection(userId, connectionId),
    readLatestUserMt5State(userId),
  ]);
  return reconcileAccountSnapshots(connectionAccountSnapshot(conn), legacyStateAccountSnapshot(legacyRow));
}

/** The snapshot to show for `userId`'s connection, falling back to the legacy feed only with identity evidence. */
export async function readSelectedConnectionAccountSnapshot(userId: number, connectionId: number): Promise<AccountSnapshot> {
  const [conn, legacyRow] = await Promise.all([
    getUserConnection(userId, connectionId),
    readLatestUserMt5State(userId),
  ]);
  return selectConnectionAccountSnapshot({ userId, connection: conn, legacy: legacyRow });
}
