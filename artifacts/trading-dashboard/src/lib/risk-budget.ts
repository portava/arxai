export type RiskBudgetSnapshot = {
  venue: string;
  dailyRiskLimit: number | null;
  dailyRiskUsed: number;
  dailyRiskRemaining: number | null;
  weeklyRiskLimit: number | null;
  weeklyRiskUsed: number;
  openRisk: number;
  openPositions: number;
  equity: number | null;
  riskStatus: string;
};

export const RISK_BUDGET_QUERY_KEY = ["account-risk-budget"] as const;

/**
 * A failed budget read. `reason` is the plain cause for a page that names it:
 * the server's own {error} text or "HTTP <status>" for a non-2xx answer, and
 * "the response was not readable" for a 2xx body that is not JSON.
 */
export class RiskBudgetReadError extends Error {
  constructor(message: string, readonly reason: string, readonly status: number) {
    super(message);
    this.name = "RiskBudgetReadError";
  }
}

/** Same account-scoped read used by Risk Command Center. Read-only. */
export async function fetchRiskBudget(): Promise<RiskBudgetSnapshot> {
  const response = await fetch("/api/risk/budget", {
    credentials: "include",
    headers: { "content-type": "application/json" },
  });
  if (!response.ok) {
    let serverError: string | null = null;
    try {
      const body = await response.json() as { error?: unknown } | null;
      if (body != null && typeof body === "object" && body.error != null) serverError = String(body.error);
    } catch { /* an unreadable error body: the status alone */ }
    throw new RiskBudgetReadError(`Risk budget unavailable (${response.status})`, serverError ?? `HTTP ${response.status}`, response.status);
  }
  try {
    return await response.json() as RiskBudgetSnapshot;
  } catch {
    throw new RiskBudgetReadError("Risk budget unavailable (unreadable response)", "the response was not readable", response.status);
  }
}

export function riskUtilizationPercent(budget: Pick<RiskBudgetSnapshot, "dailyRiskLimit" | "dailyRiskUsed">): number | null {
  if (budget.dailyRiskLimit == null || !Number.isFinite(budget.dailyRiskLimit) || budget.dailyRiskLimit <= 0 ||
      !Number.isFinite(budget.dailyRiskUsed)) return null;
  return Math.round((budget.dailyRiskUsed / budget.dailyRiskLimit) * 1000) / 10;
}
