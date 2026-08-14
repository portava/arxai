// Approval-path cockpit card — Task #771.
//
// Pending/unapproved human traders land on the reduced cockpit (Task #768) but
// previously got little guidance on HOW to reach APPROVED. This card surfaces
// the trader's current approval status + the concrete, honest steps remaining,
// derived ENTIRELY from the existing /api/me/account-mode envelope (the same
// signal useTraderTier collapses). No new approval system, no fabricated states.
//
// Self-gating: renders nothing for approved traders (they already see the full
// menu) and for admins who are not previewing a user (they grant approval, they
// don't request it). While the envelope is still loading it stays hidden to
// avoid flashing a "pending" state at an approved trader.

import { Link } from "wouter";
import { ShieldQuestion, Check, Circle, GraduationCap } from "lucide-react";
import { CockpitCard } from "./primitives";
import { cn } from "@/lib/utils";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useTraderTier } from "@/hooks/useTraderTier";
import { resolveApprovalPath, type ApprovalTone } from "@/lib/approvalPath";

const TONE_TEXT: Record<ApprovalTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-primary",
};

const TONE_ACCENT: Record<ApprovalTone, "success" | "warning" | "danger" | "blue"> = {
  success: "success",
  warning: "warning",
  danger: "danger",
  info: "blue",
};

export function ApprovalPathCard() {
  const mode = useTradingMode();
  const tier = useTraderTier();

  // Don't flash a pending state while the envelope resolves, and never show this
  // to an already-approved trader (full menu is theirs) or to an admin who is
  // managing — not requesting — approvals.
  if (mode.isLoading || tier.isLoading) return null;
  if (tier.isApprovedTrader) return null;
  if (mode.isAdmin && !mode.isAdminPreviewingUserMode) return null;

  // Fail closed: without a real /api/me/account-mode envelope we have nothing to
  // derive from. Rendering anyway would synthesize a status (e.g. PRACTICE_ONLY)
  // not backed by server data — exactly the fabricated state this surface forbids.
  const env = mode.envelope;
  if (mode.isError || !env) return null;

  const view = resolveApprovalPath({
    isLiveShared: mode.isLiveShared,
    userApprovalStatus: env.userApprovalStatus,
    tradingMode: env.accountShellStatus.tradingMode,
    tradingStatus: env.accountShellStatus.tradingStatus,
    cleanUserMessage: mode.cleanUserMessage || null,
    cleanBlockedReason: mode.cleanBlockedReason,
  });

  // Belt-and-suspenders: the resolver should never report approved here (the
  // tier guard already returned), but if it does, render nothing.
  if (view.isApproved) return null;

  return (
    <CockpitCard
      title="Path to Approval"
      subtitle="What unlocks the full trading menu"
      icon={<ShieldQuestion className="h-[18px] w-[18px]" />}
      accent={TONE_ACCENT[view.tone]}
      data-testid="cockpit-approval-path"
    >
      <div
        className={cn("text-xl font-semibold", TONE_TEXT[view.tone])}
        data-testid="approval-status-label"
      >
        {view.statusLabel}
      </div>

      {view.detail && (
        <p className="mt-1 text-sm text-txt-secondary" data-testid="approval-detail">
          {view.detail}
        </p>
      )}

      <p className="mt-2 text-sm text-txt-secondary" data-testid="approval-guidance">
        {view.guidance}
      </p>

      <ol className="mt-4 space-y-2.5" data-testid="approval-steps">
        {view.steps.map((step, i) => (
          <li
            key={step.key}
            className="flex items-start gap-2.5 text-sm"
            data-testid={`approval-step-${step.key}`}
            data-done={step.done ? "true" : "false"}
          >
            <span
              className={cn(
                "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ring-1",
                step.done
                  ? "bg-success/10 text-success ring-success/30"
                  : "bg-secondary/40 text-txt-muted ring-border",
              )}
              aria-hidden
            >
              {step.done ? <Check className="h-3 w-3" /> : <Circle className="h-2 w-2 fill-current" />}
            </span>
            <span className={cn(step.done ? "text-txt-secondary line-through" : "text-foreground")}>
              <span className="mr-1 text-txt-muted">{i + 1}.</span>
              {step.label}
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-4">
        <Link
          href="/onboarding"
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary/70"
          data-testid="approval-learn-link"
        >
          <GraduationCap className="h-4 w-4" />
          Review onboarding while you wait
        </Link>
      </div>
    </CockpitCard>
  );
}
