// Panel C (operator access) of GET /api/admin/live-test-readiness/state.
//
// Truth rule: the checklist on /admin/live-test-readiness turns these fields
// into PASS / FAIL rows, so a value that was never read must not be sent as a
// configured setting. When the admin has no user_master_live_access row, the
// stop-loss / take-profit requirements are reported as null ("not configured,
// could not be read"), not as the fail-closed defaults the dispatch gate uses.
// The dispatch gate keeps its own defaults (runControlledDryRun); this panel
// only describes what is stored.

export type OperatorAccessRow = {
  approvedForMasterLive: boolean;
  masterLiveTradingEnabled: boolean;
  masterLiveStatus: string;
  riskDisclosureAcceptedAt: Date | string | null;
  riskSettingsConfiguredAt: Date | string | null;
  maxLot: number | null;
  maxOpenPositions: number | null;
  maxExposurePerSymbolLots: number | null;
  requireStopLoss: boolean;
  requireTakeProfit: boolean;
  scannerLiveEnabled: boolean;
};

export type OperatorArmingRow = { isArmed: boolean; killSwitchEngaged: boolean };

export type OperatorAccessPanel = {
  adminUserId: number;
  adminEmail: string | null;
  role: string | null;
  /** False when no user_master_live_access row exists for this admin. */
  operatorAccessRowFound: boolean;
  approvedForMasterLive: boolean;
  masterLiveTradingEnabled: boolean;
  masterLiveStatus: string;
  riskDisclosureAcceptedAt: Date | string | null;
  riskSettingsConfiguredAt: Date | string | null;
  maxLot: number | null;
  maxOpenPositions: number | null;
  maxExposurePerSymbolLots: number | null;
  /** Stored setting; null when there is no access row to read it from. */
  requireStopLoss: boolean | null;
  /** Stored setting; null when there is no access row to read it from. */
  requireTakeProfit: boolean | null;
  scannerLiveEnabled: boolean;
  allowedSymbols: string[];
  userArmed: boolean;
  userKillSwitchEngaged: boolean;
};

export function buildOperatorAccessPanel(args: {
  adminUserId: number;
  adminEmail: string | null;
  role: string | null;
  access: OperatorAccessRow | null;
  arming: OperatorArmingRow | null;
  allowedSymbols: string[];
}): OperatorAccessPanel {
  const { access, arming } = args;
  return {
    adminUserId: args.adminUserId,
    adminEmail: args.adminEmail,
    role: args.role,
    operatorAccessRowFound: access != null,
    approvedForMasterLive: access?.approvedForMasterLive ?? false,
    masterLiveTradingEnabled: access?.masterLiveTradingEnabled ?? false,
    masterLiveStatus: access?.masterLiveStatus ?? "NOT_APPROVED",
    riskDisclosureAcceptedAt: access?.riskDisclosureAcceptedAt ?? null,
    riskSettingsConfiguredAt: access?.riskSettingsConfiguredAt ?? null,
    maxLot: access?.maxLot ?? null,
    maxOpenPositions: access?.maxOpenPositions ?? null,
    maxExposurePerSymbolLots: access?.maxExposurePerSymbolLots ?? null,
    requireStopLoss: access ? access.requireStopLoss : null,
    requireTakeProfit: access ? access.requireTakeProfit : null,
    scannerLiveEnabled: access?.scannerLiveEnabled ?? false,
    allowedSymbols: args.allowedSymbols,
    userArmed: arming?.isArmed ?? false,
    userKillSwitchEngaged: arming?.killSwitchEngaged ?? false,
  };
}
