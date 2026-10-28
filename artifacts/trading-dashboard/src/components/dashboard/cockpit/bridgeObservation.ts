// Bridge connectivity — from an observation, never from the account-mode envelope.
//
// The unified account-mode envelope (/me/account-mode) carries no heartbeat for
// non-admin users: `cleanBlockedReason` is an approval / arming / operator
// blocker and `userCanManualTrade` is status + approval only. Neither may be
// shown as "Connected" or "Disconnected".
//
// The one heartbeat-derived bridge state every user can read is the shared
// master pool's availability on /me/shared-account/summary
// (`allocationView.bridgeAvailability`, built in getUserAllocationView from the
// master heartbeat snapshot FRESH / STALE / MISSING, pause and over-allocation).
// It describes the SHARED MASTER bridge, so it is only used for users who trade
// through that route. Anyone else gets "Not checked here" — this card does not
// read their own MT5 bridge.

export type BridgeObservationState = "online" | "reconciling" | "unavailable" | "checking" | "not_checked";
export type BridgeObservationTone = "success" | "warning" | "danger" | "muted";

export interface BridgeObservation {
  state: BridgeObservationState;
  /** Short value for a "Bridge" row. */
  label: string;
  /** One plain sentence: what was observed and from which source, or that it was not checked. */
  detail: string;
  tone: BridgeObservationTone;
}

export interface SharedBridgeAvailabilityView {
  bridgeAvailability: string;
  bridgeMessage: string;
}

export interface BridgeObservationInput {
  /** The user trades through the shared master bridge (LIVE_SHARED or SHARED_MASTER_MT5 routing). */
  onSharedRoute: boolean;
  /** /me/shared-account/summary allocationView; null/undefined when not read. */
  allocationView: SharedBridgeAvailabilityView | null | undefined;
  /** The summary read is still in flight. */
  summaryLoading?: boolean;
}

export function describeBridgeObservation(input: BridgeObservationInput): BridgeObservation {
  if (!input.onSharedRoute) {
    return {
      state: "not_checked",
      label: "Not checked here",
      detail: "Your account does not trade through the shared master bridge, and this card does not read your own MT5 bridge heartbeat. See MT5 status.",
      tone: "muted",
    };
  }
  const view = input.allocationView;
  if (!view) {
    if (input.summaryLoading) {
      return { state: "checking", label: "Checking", detail: "Reading the shared master bridge status…", tone: "muted" };
    }
    return {
      state: "not_checked",
      label: "Not checked",
      detail: "The shared master bridge status could not be read, so its connection is unknown.",
      tone: "muted",
    };
  }
  const message = view.bridgeMessage || "";
  switch (view.bridgeAvailability) {
    case "HEALTHY":
      return { state: "online", label: "Online", detail: message || "Shared master bridge heartbeat is current.", tone: "success" };
    case "RECONCILING":
      return { state: "reconciling", label: "Reconciling", detail: message || "Shared master bridge snapshot is not current.", tone: "warning" };
    case "UNAVAILABLE":
      return { state: "unavailable", label: "Unavailable", detail: message || "Shared master bridge is not currently available.", tone: "danger" };
    default:
      return {
        state: "not_checked",
        label: "Not checked",
        detail: "The shared master bridge reported a status ARX does not recognise, so its connection is unknown.",
        tone: "muted",
      };
  }
}

/** Whether the user's route is the shared master bridge, from the envelope's routing fields. */
export function isOnSharedMasterRoute(mode: {
  isLiveShared: boolean;
  envelope: { accountShellStatus?: { accountMode?: string } | null } | null;
}): boolean {
  return mode.isLiveShared || mode.envelope?.accountShellStatus?.accountMode === "SHARED_MASTER_MT5";
}
