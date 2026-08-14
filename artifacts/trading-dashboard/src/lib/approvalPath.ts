// Trader approval-path resolver — Task #771.
//
// Pure, React-free, DB-free. Turns the existing per-user account-mode envelope
// (the SAME signals useTraderTier collapses to its approval boolean) into a
// small, HONEST "where am I on the path to live-trading approval?" view a
// pending trader can read on the cockpit.
//
// SAFETY / HONESTY:
//   • Introduces NO new approval system. Every field is derived from values the
//     server already exposes on GET /api/me/account-mode (userApprovalStatus,
//     isLiveShared, accountShellStatus, cleanUserMessage, cleanBlockedReason).
//   • `detail` is ONLY ever a server-authored string — never fabricated copy.
//   • Live approval is purely operator/admin-granted (there is no self-serve
//     "request access" endpoint), so the guidance points the trader at their
//     operator rather than inventing a button that does not exist.
//   • The full trading menu unlocks automatically once approved (useTraderTier);
//     this surface only explains the wait, it never gates or grants anything.

export type ApprovalStage =
  | "APPROVED"
  | "WAITING_APPROVAL"
  | "SUSPENDED"
  | "RISK_LOCKED"
  | "TRADING_DISABLED"
  | "PRACTICE_ONLY";

export type ApprovalTone = "success" | "warning" | "danger" | "info";

export interface ApprovalPathInput {
  /** LIVE_SHARED ⇒ necessarily approved + armed. */
  isLiveShared: boolean;
  /** envelope.userApprovalStatus (accountShellStatus.approvalStatus). */
  userApprovalStatus: string | null | undefined;
  /** accountShellStatus.tradingMode. */
  tradingMode: string | null | undefined;
  /** accountShellStatus.tradingStatus. */
  tradingStatus: string | null | undefined;
  /** Server-authored honest explanation (may be null). */
  cleanUserMessage: string | null | undefined;
  /** Server-authored honest block reason (may be null). */
  cleanBlockedReason: string | null | undefined;
}

export interface ApprovalStep {
  key: string;
  label: string;
  done: boolean;
}

export interface ApprovalPathView {
  /** True once the trader is approved for the full live experience. */
  isApproved: boolean;
  stage: ApprovalStage;
  statusLabel: string;
  tone: ApprovalTone;
  /** Server-authored honest detail; never fabricated. `null` when the server
   *  supplied no message. */
  detail: string | null;
  /** Plain-language explanation of HOW approval is granted. */
  guidance: string;
  /** Ordered progression to APPROVED with envelope-derived done flags. */
  steps: ApprovalStep[];
}

const APPROVAL_GUIDANCE =
  "Live trading access is granted by your operator — there is no self-serve " +
  "unlock. Reach out to them to request access; the full trading menu appears " +
  "automatically the moment you're approved.";

const SUSPENDED_GUIDANCE =
  "Your live access is on hold. Contact your operator to find out what's needed " +
  "to restore it.";

/**
 * Resolve a pending trader's honest approval-path view from the account-mode
 * envelope. The caller decides whether to render it (typically: only when the
 * trader is NOT yet approved).
 */
export function resolveApprovalPath(input: ApprovalPathInput): ApprovalPathView {
  const approvalStatus = (input.userApprovalStatus ?? "").toUpperCase();
  const tradingMode = (input.tradingMode ?? "").toUpperCase();
  const tradingStatus = (input.tradingStatus ?? "").toUpperCase();

  const isApproved = input.isLiveShared || approvalStatus === "APPROVED";

  // Honest detail: prefer the explicit block reason, else the general user
  // message. Both are server-authored — we never synthesize one.
  const detail = input.cleanBlockedReason ?? input.cleanUserMessage ?? null;

  // Envelope-derived progression. Each `done` flag maps to a real signal:
  //   1. trading enabled at all (tradingMode != DISABLED / unknown)
  //   2. operator approval granted
  //   3. live access activated (armed / shared-bridge attached)
  const steps: ApprovalStep[] = [
    {
      key: "enabled",
      label: "Trading enabled on your account",
      done: tradingMode !== "" && tradingMode !== "DISABLED",
    },
    {
      key: "approved",
      label: "Operator approves you for live trading",
      done: isApproved,
    },
    {
      key: "activated",
      label: "Live access activated",
      done: input.isLiveShared,
    },
  ];

  if (isApproved) {
    return {
      isApproved: true,
      stage: "APPROVED",
      statusLabel: "Approved for live trading",
      tone: "success",
      detail,
      guidance:
        "You're approved. The full trading menu is unlocked for your account.",
      steps,
    };
  }

  let stage: ApprovalStage;
  let statusLabel: string;
  let tone: ApprovalTone;
  let guidance: string;

  if (approvalStatus === "SUSPENDED" || approvalStatus === "DISABLED") {
    stage = "SUSPENDED";
    statusLabel = "Access on hold";
    tone = "danger";
    guidance = SUSPENDED_GUIDANCE;
  } else if (approvalStatus === "RISK_LOCKED") {
    stage = "RISK_LOCKED";
    statusLabel = "Restricted (risk lock)";
    tone = "danger";
    guidance = SUSPENDED_GUIDANCE;
  } else if (tradingMode === "DISABLED") {
    stage = "TRADING_DISABLED";
    statusLabel = "Trading not enabled yet";
    tone = "warning";
    guidance = APPROVAL_GUIDANCE;
  } else if (
    tradingStatus === "WAITING_APPROVAL" ||
    approvalStatus === "NOT_APPROVED"
  ) {
    stage = "WAITING_APPROVAL";
    statusLabel = "Waiting for approval";
    tone = "warning";
    guidance = APPROVAL_GUIDANCE;
  } else {
    // NOT_REQUIRED — demo/paper trader practicing; live needs operator approval.
    stage = "PRACTICE_ONLY";
    statusLabel = "Practice mode";
    tone = "info";
    guidance = APPROVAL_GUIDANCE;
  }

  return {
    isApproved: false,
    stage,
    statusLabel,
    tone,
    detail,
    guidance,
    steps,
  };
}
