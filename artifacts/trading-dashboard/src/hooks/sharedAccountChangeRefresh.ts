import { readCachedPositionUserId, getUnifiedPositionsQueryKey } from "./unifiedPositions";
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import { getGetMeSharedAccountSummaryQueryKey, getGetMt5StatusQueryKey } from "@workspace/api-client-react";

/** Hints carry no evidence: only the canonical HTTP reader may update amounts
 * or observation times. Controllers are scoped to their caller lifetime (SSE or explicit manual reads). */
function createAccountChangeRefresh(client: QueryClient, queryKey: QueryKey, onPendingChange?: (pending: boolean) => void) {
  const filters = { queryKey, exact: true } as const;
  let disposed = false;
  let dirty = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let observedQuery: Query | undefined;
  let unsubscribe = () => {};
  let pending = false;
  function reportPending() {
    const next = !disposed && (dirty || running);
    if (next !== pending) { pending = next; onPendingChange?.(next); }
  }

  function dispose() {
    disposed = true;
    dirty = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    unsubscribe();
    reportPending();
    // Do not abort a canonical read also owned by other mounted surfaces.
  }

  function scheduleTrailing() {
    if (disposed || !dirty || running || timer !== null) return;
    // Fixed window, not reset by incoming events: a busy feed cannot starve it.
    timer = setTimeout(() => { timer = null; pump(); }, 25);
  }

  function pump() {
    if (disposed || !dirty || running) return;
    const query = client.getQueryCache().find(filters);
    if (query) observedQuery = query;
    // An already-running read can predate the hint. Joining its promise would
    // silently consume the change. Keep dirty until it settles (or is cancelled),
    // then start a new read; never cancel other readers to accelerate a hint.
    if (query?.isActive() && query.state.fetchStatus !== "idle") return;
    dirty = false;
    running = true;
    void client.invalidateQueries({ ...filters, refetchType: "active" }, { cancelRefetch: false })
      .catch(() => { /* Keep existing evidence; normal query error/retry policy applies. */ })
      .finally(() => {
        running = false;
        scheduleTrailing();
        reportPending();
      });
  }

  unsubscribe = client.getQueryCache().subscribe(event => {
    // A logout/cache reset must not leave a waiter that refreshes under the next
    // session. A subsequent SSE connection creates its own controller.
    if (event.type === "removed" && event.query === observedQuery) { dispose(); return; }
    if (dirty && !running && event.query === observedQuery && (event.query.state.fetchStatus === "idle" || !event.query.isActive())) scheduleTrailing();
  });

  return {
    notify() {
      if (disposed) return false;
      dirty = true;
      reportPending();
      if (timer === null) pump();
      return true;
    },
    dispose,
  };
}

/** Keep both account readers on their existing generated cache keys. */
export function createSharedAccountChangeRefresh(client: QueryClient, onPendingChange?: (pending: boolean) => void) {
  return createAccountChangeRefresh(client, getGetMeSharedAccountSummaryQueryKey(), onPendingChange);
}
export function createPersonalAccountChangeRefresh(client: QueryClient, onPendingChange?: (pending: boolean) => void) {
  return createAccountChangeRefresh(client, getGetMt5StatusQueryKey(), onPendingChange);
}


/** A per-user positions query is not a whole-account native money report.
 * Bind each controller to one authenticated cache identity. Identity changes
 * retire it; an old stream cannot refresh the next user's query. */
export function createUnifiedPositionChangeRefresh(client: QueryClient, onPendingChange?: (pending:boolean)=>void) {
  let owner = readCachedPositionUserId(client);
  let disposed = false;
  let current: ReturnType<typeof createAccountChangeRefresh> | null = null;
  let unsubscribe = () => {};
  const dispose = () => { disposed=true; current?.dispose(); current=null; unsubscribe(); };
  unsubscribe=client.getQueryCache().subscribe(event=>{
    if(event.query.queryKey.length===1&&event.query.queryKey[0]==="me") {
      const next=readCachedPositionUserId(client);
      if(event.type==="removed"||(owner!==null&&next!==owner))dispose();
    }
  });
  return {
    notify(snapshotUserId?:unknown) {
      if(disposed)return false;
      const identity=readCachedPositionUserId(client);
      const snapshotId=typeof snapshotUserId==='string'&&/^[1-9]\d*$/.test(snapshotUserId)?Number(snapshotUserId):snapshotUserId;
      if(owner===null) {
        // A stream mounted before /me resolves needs its first matching owned
        // snapshot. An empty advisory hint cannot establish user ownership.
        if(identity===null||snapshotId!==identity)return false;
        owner=identity;
      }
      if(identity!==owner){dispose();return false;}
      if(snapshotUserId!==undefined&&snapshotId!==owner)return true;
      current??=createAccountChangeRefresh(client,getUnifiedPositionsQueryKey(owner),onPendingChange);
      if(!current.notify()){dispose();return false;}
      return true;
    },
    dispose,
  };
}
