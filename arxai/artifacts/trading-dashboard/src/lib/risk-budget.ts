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

/** Same account-scoped read used by Risk Command Center. Read-only. */
export async function fetchRiskBudget(): Promise<RiskBudgetSnapshot> {
  const response = await fetch("/api/risk/budget", {
    credentials: "include",
    headers: { "content-type": "application/json" },
  });
  if (!response.ok) throw new Error(`Risk budget unavailable (${response.status})`);
  return response.json() as Promise<RiskBudgetSnapshot>;
}

export function riskUtilizationPercent(budget: Pick<RiskBudgetSnapshot, "dailyRiskLimit" | "dailyRiskUsed">): number | null {
  if (budget.dailyRiskLimit == null || !Number.isFinite(budget.dailyRiskLimit) || budget.dailyRiskLimit <= 0 ||
      !Number.isFinite(budget.dailyRiskUsed)) return null;
  return Math.round((budget.dailyRiskUsed / budget.dailyRiskLimit) * 1000) / 10;
}
