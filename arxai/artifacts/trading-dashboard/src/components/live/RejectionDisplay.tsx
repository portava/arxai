// T033 Phase 8 — reusable structured-rejection display.
//
// Renders a live-trade rejection as:
//   • a clean, one-line user message (always)
//   • an expandable admin/owner detail block (raw code, reject layer, fixable-by,
//     suggested fix, plus the trade context the caller passes in) with a copy
//     button — gated behind `showAdminDetail`
//
// Drop-in for LiveSharedTradeTicket, the instant/scanner surfaces, and any other
// place a live BUY/SELL can fail. Mirrors the existing <details> admin pattern
// already used in the ticket, so it's mobile-readable (native disclosure, wraps).

import { useState } from "react";
import { AlertTriangle, Copy, Check } from "lucide-react";
import {
  structureRejection,
  rejectLayerLabel,
  fixableByLabel,
} from "@/lib/structuredRejection";

export interface RejectionContext {
  commandId?: string | null;
  brokerSymbol?: string | null;
  displaySymbol?: string | null;
  side?: string | null;
  lot?: number | null;
  mt5Retcode?: number | string | null;
  brokerMessage?: string | null;
  freshness?: string | null;
  timestamp?: string | null;
}

export function RejectionDisplay({
  rejection,
  context,
  showAdminDetail = false,
  overrideCode = null,
}: {
  /** Raw backend/EA rejection: a code string or {error,reason,primaryReason,detail}. */
  rejection: unknown;
  context?: RejectionContext;
  /** Owner/admin only — gates the expandable technical block. */
  showAdminDetail?: boolean;
  /**
   * Optional SPECIFIC blocker code (the resolver's `blockingReasonCode`, e.g.
   * LIVE_CONFIRMATION_REQUIRED). When present it drives the user-facing copy
   * while the canonical code stays in the admin trail — so "approved but Full
   * Live Activation missing" reads differently from "feed not confirmed".
   */
  overrideCode?: string | null;
}) {
  const s = structureRejection(rejection, {
    mt5Retcode: context?.mt5Retcode,
    overrideCode,
  });
  const [copied, setCopied] = useState(false);

  // Build the admin detail rows. Only include fields that are present, so the
  // block never shows empty "field: " lines. Missing context is simply omitted.
  const rows: Array<[string, string]> = [];
  const push = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === "") return;
    rows.push([k, String(v)]);
  };
  push("rawCode", s.technicalCode);
  push("rawReason", s.rawReason);
  push("rejectLayer", `${s.rejectLayer} (${rejectLayerLabel(s.rejectLayer)})`);
  push("category", s.category);
  push("fixableBy", `${s.fixableBy} — ${fixableByLabel(s.fixableBy)}`);
  push("commandId", context?.commandId);
  push("brokerSymbol", context?.brokerSymbol);
  push("displaySymbol", context?.displaySymbol);
  push("side", context?.side);
  push("lot", context?.lot);
  push("mt5Retcode", s.retcodeLabel ?? context?.mt5Retcode);
  push("brokerMessage", context?.brokerMessage);
  push("freshness", context?.freshness);
  push("timestamp", context?.timestamp ?? new Date().toISOString());

  const copyText = [
    `ARX live rejection`,
    `title: ${s.title}`,
    `user: ${s.userMessage}`,
    `suggestedFix: ${s.suggestedFix}`,
    ...rows.map(([k, v]) => `${k}: ${v}`),
  ].join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op, the detail is still visible */
    }
  }

  return (
    <div className="space-y-2 min-w-0" data-testid="rejection-display">
      {/* User-facing line — always shown, no jargon */}
      <div className="flex items-start gap-2 min-w-0">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-rose-400" aria-hidden />
        <div className="min-w-0">
          <div className="font-medium text-rose-100 break-words" data-testid="rejection-user-message">
            {s.userMessage}
          </div>
          {/* Suggested fix is useful to everyone, not just admins */}
          <div className="text-xs text-zinc-400 mt-0.5 break-words" data-testid="rejection-suggested-fix">
            {s.suggestedFix}
          </div>
        </div>
      </div>

      {/* Admin/owner technical detail — expandable, copyable */}
      {showAdminDetail && (
        <details className="border-t border-zinc-800 pt-2" data-testid="rejection-admin-detail">
          <summary className="cursor-pointer text-xs text-zinc-400 select-none">
            Technical detail (admin/owner)
          </summary>
          <div className="mt-2">
            <button
              type="button"
              onClick={copy}
              className="mb-2 inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              data-testid="rejection-copy-btn"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy detail"}
            </button>
            <div className="space-y-1.5 font-mono text-xs">
              {rows.map(([k, v]) => (
                <div key={k} className="flex flex-col sm:grid sm:grid-cols-[7rem_1fr] sm:gap-2 min-w-0">
                  <span className="text-zinc-500 shrink-0">{k}</span>
                  <span className="text-zinc-200 break-words min-w-0">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
