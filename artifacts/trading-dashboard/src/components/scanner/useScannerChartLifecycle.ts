import { useLayoutEffect, useRef } from "react";

/** Keep the canvas engine while cached contexts change, clearing its contents
 * before the browser can paint the new symbol beside old-market geometry. */
export function useScannerChartLifecycle(
  available: boolean,
  context: string,
  create: () => (() => void) | undefined,
  resetContext: () => void,
): void {
  const callbacks = useRef({ create, resetContext });
  useLayoutEffect(() => { callbacks.current = { create, resetContext }; });
  useLayoutEffect(() => {
    if (available) return callbacks.current.create();
    return undefined;
  }, [available]);
  useLayoutEffect(() => {
    if (available) callbacks.current.resetContext();
  }, [available, context]);
}
