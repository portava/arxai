import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, Check, KeyRound } from "lucide-react";

type EaInputs = {
  serverBaseUrl: string;
  heartbeatEndpoint: string;
  bridgeTokenHeader: string;
  tokenLast4: string | null;
  bridgeConnectionId: number | null;
  rawTokenPolicy: string;
  requiredEaInputs: Record<string, string | number | boolean>;
  note: string;
};

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* ignore */
        }
      }}
      data-testid={`copy-${label.toLowerCase().replace(/\s+/g, "-")}-button`}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
    </Button>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 border-b border-slate-800/60 last:border-0">
      <div className="text-slate-400 text-xs">{label}</div>
      <div className="flex items-center gap-2 min-w-0">
        <code className="font-mono text-xs text-slate-200 truncate max-w-[260px]" title={value}>
          {value}
        </code>
        <CopyButton value={value} label={label} />
      </div>
    </div>
  );
}

export function CopyLiveEaInputsCard() {
  const { data, isLoading, error } = useQuery<EaInputs>({
    queryKey: ["me-live-ea-inputs"],
    queryFn: async () => {
      const r = await fetch("/api/me/live/ea-inputs");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <Card data-testid="copy-live-ea-inputs-card">
        <CardContent className="p-6 text-sm text-slate-400">Loading EA inputs…</CardContent>
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card data-testid="copy-live-ea-inputs-card">
        <CardContent className="p-6 text-sm text-red-300">Failed to load EA inputs.</CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="copy-live-ea-inputs-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-amber-300" />
          Copy Live EA Inputs
        </CardTitle>
        <CardDescription>
          Paste these exact values into your MT5 EA Inputs. Raw bridge tokens are shown only once at
          creation in MT5 Setup; rotate by creating a new connection.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <FieldRow label="ServerBaseUrl" value={data.serverBaseUrl} />
        <FieldRow label="Heartbeat endpoint" value={data.heartbeatEndpoint} />
        <FieldRow label="Header name" value={data.bridgeTokenHeader} />
        <div className="flex items-center justify-between gap-3 py-1 border-b border-slate-800/60">
          <div className="text-slate-400 text-xs">Bridge token (last 4)</div>
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs text-slate-200">
              {data.tokenLast4 ? `…${data.tokenLast4}` : "no connection"}
            </code>
            {data.bridgeConnectionId != null && (
              <span className="text-xs text-slate-500">bridge #{data.bridgeConnectionId}</span>
            )}
          </div>
        </div>

        <div className="pt-2 space-y-1">
          <div className="text-xs uppercase tracking-wider text-slate-400">Required EA Inputs (defaults)</div>
          {Object.entries(data.requiredEaInputs).map(([k, v]) => (
            <div key={k} className="flex justify-between py-0.5">
              <span className="text-slate-400">{k}</span>
              <code className="font-mono text-xs text-slate-200">{String(v)}</code>
            </div>
          ))}
        </div>

        <div className="text-xs text-slate-500 pt-1">{data.rawTokenPolicy}</div>
        <div className="text-xs text-amber-300/80">{data.note}</div>
      </CardContent>
    </Card>
  );
}
