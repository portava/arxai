import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCurrentUser } from './useCurrentUser';
import { useAccountRefreshPreference } from './useAccountRefreshPreference';
import { createUnifiedPositionChangeRefresh } from './sharedAccountChangeRefresh';
import {
  authenticatedPositionUserId, readCachedPositionUserId, getUnifiedPositionsQueryKey,
  readUnifiedPositions, type UnifiedPositionsResponse,
} from './unifiedPositions';

/** One existing per-user report/query for lists and chart overlays. A refresh
 * changes no position optimistically and never establishes broker currentness.
 * The page's existing account stream provides advisory refresh hints. */
export function useUnifiedPositions() {
  const client = useQueryClient();
  const { user, isError: identityError } = useCurrentUser();
  const userId = identityError ? null : authenticatedPositionUserId(user);
  const [autoRefreshEnabled] = useAccountRefreshPreference();
  const query = useQuery({
    queryKey: getUnifiedPositionsQueryKey(userId ?? 0),
    queryFn: readUnifiedPositions,
    enabled: userId !== null,
    retry: false,
    refetchInterval: autoRefreshEnabled ? 5000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: autoRefreshEnabled,
    refetchOnReconnect: autoRefreshEnabled,
  });
  const refresh = useRef<ReturnType<typeof createUnifiedPositionChangeRefresh> | null>(null);
  useEffect(() => () => {
    refresh.current?.dispose();
    refresh.current = null;
  }, [client, userId]);
  const reload = useCallback(() => {
    // Old completion/close handlers cannot refresh a different user's report.
    if (userId === null || readCachedPositionUserId(client) !== userId) return;
    if (refresh.current?.notify()) return;
    refresh.current?.dispose();
    refresh.current = createUnifiedPositionChangeRefresh(client);
    refresh.current.notify();
  }, [client, userId]);
  const resolveCurrentPosition = useCallback((position: { scope: 'live' | 'demo'; brokerTicket: string | null }) => {
    // Recheck at the action boundary, even before React commits a cache change.
    if (userId === null || readCachedPositionUserId(client) !== userId) return null;
    const key = getUnifiedPositionsQueryKey(userId);
    if (client.getQueryState(key)?.status !== 'success') return null;
    const current = client.getQueryData<UnifiedPositionsResponse>(key);
    return [...(current?.live ?? []), ...(current?.demo ?? [])]
      .find(row => row.scope === position.scope && row.brokerTicket === position.brokerTicket) ?? null;
  }, [client, userId]);
  return {
    userId, user, identityError,
    data: userId !== null && !query.isError ? query.data : null,
    err: query.isError ? query.error.message : null,
    isPending: query.isPending, query, reload, resolveCurrentPosition,
  };
}
