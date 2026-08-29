import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { useState } from "react";

interface Props {
  planId: number;
  isReady: boolean;
}

export function ConvertToLiveExecutionButton({ planId, isReady }: Props) {
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const convert = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/trade-plans/${planId}/convert`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data: { executionConfirmationId?: number }) => {
      setMessage(`Created execution confirmation #${data.executionConfirmationId} (PENDING). Open the Pre-Trade Confirmation flow to review and confirm.`);
      qc.invalidateQueries({ queryKey: ["trade-plans"] });
    },
    onError: (e: Error) => setMessage(e.message),
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => convert.mutate()}
        disabled={!isReady || convert.isPending}
        className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold ${
          isReady ? "bg-primary text-white hover:bg-primary" : "cursor-not-allowed bg-muted text-txt-secondary"
        }`}
      >
        <Rocket className="h-4 w-4" />
        {convert.isPending ? "Converting…" : "Convert to Live Execution"}
      </button>
      {!isReady && (
        <p className="mt-2 text-xs text-txt-muted">Run validate and pass all checks to enable conversion.</p>
      )}
      {message && (
        <p className={`mt-2 text-xs ${convert.isError ? "text-danger" : "text-success"}`}>{message}</p>
      )}
      <p className="mt-2 text-xs text-txt-muted">
        Conversion creates a pending confirmation. Live execution still requires the Safety Core and the Pre-Trade Confirmation flow.
      </p>
    </div>
  );
}
