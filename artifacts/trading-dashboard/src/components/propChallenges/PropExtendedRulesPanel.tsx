import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

// Phase 27-B — minimal read+edit panel for the extended prop firm rules.
// Read-only safety: never queues live trades, never modifies broker config,
// never bypasses paper_only enforcement. Calls PATCH /prop-challenges/:id/rules.

export interface ExtendedRules {
  trailingDrawdownEnabled: boolean;
  trailingDrawdownAmount: number;     // 0..1
  trailingDrawdownType: "STATIC" | "TRAILING";
  maxRiskPerTrade: number;            // 0..1
  maxOpenTrades: number;
  maxPendingOrders: number;
  maxPositionSize: number;            // lots
  newsTradingAllowed: boolean;
  weekendHoldingAllowed: boolean;
  overnightHoldingAllowed: boolean;
  strictGuardrailsEnabled: boolean;
}

interface Props {
  challengeId: number;
  rules: ExtendedRules;
  disabled?: boolean;
}

export function PropExtendedRulesPanel({ challengeId, rules, disabled }: Props) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ExtendedRules>(rules);
  const dirty = JSON.stringify(draft) !== JSON.stringify(rules);

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/prop-challenges/${challengeId}/rules`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `Save failed (${r.status})`);
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["prop-list"] });
      qc.invalidateQueries({ queryKey: ["prop-eval", challengeId] });
    },
  });

  function num<K extends keyof ExtendedRules>(k: K) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setDraft({ ...draft, [k]: Number(e.target.value) } as ExtendedRules);
  }
  function bool<K extends keyof ExtendedRules>(k: K) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setDraft({ ...draft, [k]: e.target.checked } as ExtendedRules);
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Extended prop rules</h3>
          <p className="text-[11px] text-slate-400">
            Demo-only enforcement. Live execution remains locked regardless of these settings.
          </p>
        </div>
        <button
          onClick={() => save.mutate()}
          disabled={!dirty || disabled || save.isPending}
          className="rounded bg-emerald-700 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
        >
          {save.isPending ? "Saving…" : dirty ? "Save rules" : "Saved"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
        {/* Trailing drawdown */}
        <div className="rounded border border-slate-800 p-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.trailingDrawdownEnabled}
              onChange={bool("trailingDrawdownEnabled")} disabled={disabled} />
            <span className="font-medium text-slate-100">Trailing drawdown</span>
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-slate-400">Amount (0..1)
              <input type="number" step="0.005" min="0.001" max="1" value={draft.trailingDrawdownAmount}
                onChange={num("trailingDrawdownAmount")} disabled={disabled}
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100" />
            </label>
            <label className="text-slate-400">Type
              <select value={draft.trailingDrawdownType}
                onChange={(e) => setDraft({ ...draft, trailingDrawdownType: e.target.value as "STATIC"|"TRAILING" })}
                disabled={disabled}
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100">
                <option value="STATIC">STATIC (vs starting)</option>
                <option value="TRAILING">TRAILING (vs peak)</option>
              </select>
            </label>
          </div>
        </div>

        {/* Per-trade limits */}
        <div className="rounded border border-slate-800 p-3">
          <div className="font-medium text-slate-100">Per-trade limits</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-slate-400">Max risk per trade (0..1)
              <input type="number" step="0.005" min="0.001" max="1" value={draft.maxRiskPerTrade}
                onChange={num("maxRiskPerTrade")} disabled={disabled}
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100" />
            </label>
            <label className="text-slate-400">Max position size (lots)
              <input type="number" step="0.01" min="0.01" max="100" value={draft.maxPositionSize}
                onChange={num("maxPositionSize")} disabled={disabled}
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100" />
            </label>
          </div>
        </div>

        {/* Concurrency */}
        <div className="rounded border border-slate-800 p-3">
          <div className="font-medium text-slate-100">Concurrency</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-slate-400">Max open trades
              <input type="number" step="1" min="1" max="100" value={draft.maxOpenTrades}
                onChange={num("maxOpenTrades")} disabled={disabled}
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100" />
            </label>
            <label className="text-slate-400" title="No PENDING status in demo schema — evaluates as INSUFFICIENT_DATA today.">
              Max pending orders
              <input type="number" step="1" min="1" max="100" value={draft.maxPendingOrders}
                onChange={num("maxPendingOrders")} disabled={disabled}
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100" />
            </label>
          </div>
          <p className="mt-2 text-[10px] text-amber-400">
            Pending-orders rule: INSUFFICIENT_DATA (demo schema has no PENDING status).
          </p>
        </div>

        {/* Restrictions */}
        <div className="rounded border border-slate-800 p-3">
          <div className="font-medium text-slate-100">Holding restrictions</div>
          <div className="mt-2 space-y-1">
            <label className="flex items-center gap-2 text-slate-300">
              <input type="checkbox" checked={draft.newsTradingAllowed}
                onChange={bool("newsTradingAllowed")} disabled={disabled} />
              <span>News trading allowed
                <span className="ml-1 text-[10px] text-amber-400">(no news provider — INSUFFICIENT_DATA)</span>
              </span>
            </label>
            <label className="flex items-center gap-2 text-slate-300">
              <input type="checkbox" checked={draft.weekendHoldingAllowed}
                onChange={bool("weekendHoldingAllowed")} disabled={disabled} />
              <span>Weekend holding allowed</span>
            </label>
            <label className="flex items-center gap-2 text-slate-300">
              <input type="checkbox" checked={draft.overnightHoldingAllowed}
                onChange={bool("overnightHoldingAllowed")} disabled={disabled} />
              <span>Overnight holding allowed</span>
            </label>
          </div>
        </div>

        {/* Strict guardrails */}
        <div className="rounded border border-slate-800 p-3 sm:col-span-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.strictGuardrailsEnabled}
              onChange={bool("strictGuardrailsEnabled")} disabled={disabled} />
            <span className="font-medium text-slate-100">Strict guardrails</span>
          </label>
          <p className="mt-1 text-[11px] text-slate-400">
            When enabled, HARD rule violations escalate demo rule status to <span className="font-mono text-amber-300">BLOCKED</span>{" "}
            (demo actions are flagged, never executed). Live execution remains locked at all times.
          </p>
        </div>
      </div>

      {save.isError && (
        <p className="mt-2 text-[11px] text-red-400">{(save.error as Error).message}</p>
      )}
    </div>
  );
}
