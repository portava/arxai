import { getMeSharedAccountSummary } from "@workspace/api-client-react";

// A stalled response (including its body) must not hold the shared query open
// forever and prevent later account-change hints from reading newer evidence.
// This is a recovery deadline, not a broker-to-screen latency guarantee.
export const ACCOUNT_SUMMARY_READ_TIMEOUT_MS = 10_000;

export function readSharedAccountSummary({ signal }: { signal: AbortSignal }) {
  return new Promise<Awaited<ReturnType<typeof getMeSharedAccountSummary>>>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => {
      const error = new DOMException("Account read cancelled.", "AbortError");
      finish(() => reject(error));
      controller.abort();
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      finish(() => reject(new Error("Account update timed out. Waiting for a new report.")));
      controller.abort();
    }, ACCOUNT_SUMMARY_READ_TIMEOUT_MS);
    // Retire the read even if a transport/body reader fails to honor abort.
    // Its eventual result cannot overwrite a newer query response.
    void getMeSharedAccountSummary({ signal: controller.signal, cache: "no-store" })
      .then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

// Recovery is driven by the existing change hints, polls and manual refresh.
// Automatic retry backoff must not monopolize this shared query meanwhile.
export const sharedAccountSummaryReadOptions = {
  queryFn: readSharedAccountSummary,
  retry: false,
} as const;
