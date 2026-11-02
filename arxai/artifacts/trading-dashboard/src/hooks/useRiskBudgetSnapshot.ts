import { useQuery } from "@tanstack/react-query";
import { fetchRiskBudget, RISK_BUDGET_QUERY_KEY } from "@/lib/risk-budget";

export function useRiskBudgetSnapshot() {
  return useQuery({
    queryKey: RISK_BUDGET_QUERY_KEY,
    queryFn: fetchRiskBudget,
    refetchInterval: 4000,
    retry: false,
  });
}
