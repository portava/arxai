// Build G — Operator-initiated reconnect. Queues a command for the EA.
import { useState } from "react";
import { useReconnectBroker, getGetBrokerHealthQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export function ReconnectButton() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"idle" | "ok" | "err">("idle");
  const mut = useReconnectBroker({
    mutation: {
      onSuccess: () => {
        setStatus("ok");
        qc.invalidateQueries({ queryKey: getGetBrokerHealthQueryKey() });
        setTimeout(() => setStatus("idle"), 2_500);
      },
      onError: () => { setStatus("err"); setTimeout(() => setStatus("idle"), 3_000); },
    },
  });
  return (
    <button
      type="button"
      onClick={() => mut.mutate({ data: { reason: "operator-initiated from dashboard" } })}
      disabled={mut.isPending}
      className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
    >
      {mut.isPending ? "Reconnecting…" : status === "ok" ? "Queued ✓" : status === "err" ? "Failed — retry" : "Reconnect broker"}
    </button>
  );
}
