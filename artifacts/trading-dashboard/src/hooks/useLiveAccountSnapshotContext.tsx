// LiveAccountSnapshotContext — shares a SINGLE SSE connection across
// all surfaces that need live account data on the same page (Dashboard,
// Cockpit, Open Trades). Multiple components calling useLiveAccountSnapshot()
// individually would each open their own SSE stream to the same endpoint.
// Wrapping the page tree in <LiveAccountSnapshotProvider> collapses all
// consumers to ONE stream.
//
// Usage:
//   // page / layout:
//   <LiveAccountSnapshotProvider>
//     <AccountSnapshotCard />
//     <OpenPositionsCard />
//   </LiveAccountSnapshotProvider>
//
//   // inside any child:
//   const snap = useLiveAccountSnapshotCtx();

import React, { createContext, useContext, type ReactNode } from "react";
import {
  useLiveAccountSnapshot,
  type UseLiveAccountSnapshotResult,
} from "./useLiveAccountSnapshot";

const LiveAccountSnapshotContext = createContext<UseLiveAccountSnapshotResult | null>(null);

export function LiveAccountSnapshotProvider({ children }: { children: ReactNode }) {
  const value = useLiveAccountSnapshot();
  return (
    <LiveAccountSnapshotContext.Provider value={value}>
      {children}
    </LiveAccountSnapshotContext.Provider>
  );
}

/** Consume the shared live-account snapshot. Must be under <LiveAccountSnapshotProvider>. */
export function useLiveAccountSnapshotCtx(): UseLiveAccountSnapshotResult {
  const ctx = useContext(LiveAccountSnapshotContext);
  if (!ctx) {
    throw new Error(
      "useLiveAccountSnapshotCtx must be used inside a <LiveAccountSnapshotProvider>",
    );
  }
  return ctx;
}
