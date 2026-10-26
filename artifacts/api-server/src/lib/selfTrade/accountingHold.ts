// Admission shares the agent lock with result settlement. A durable accounting
// marker is unresolved until an explicit audited historical-evidence workflow
// replaces it; time, a current bridge switch, or a guessed profit cannot clear it.
import { and, eq, sql } from "drizzle-orm";
import { db, selfTradeAgentExecutionsTable as executions } from "@workspace/db";

export const ENTRY_ACCOUNTING_UNRESOLVED = "ENTRY_ACCOUNTING_UNRESOLVED";
export async function hasUnresolvedAgentAccounting(
  reader: Pick<typeof db, "select">,
  agentId: number,
): Promise<boolean> {
  const rows = await reader
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.agentId, agentId),
        sql`${executions.managementState} ? 'closeAccounting'`,
      ),
    )
    .limit(1);
  // Even malformed/null/unknown status markers hold; there is no implicit
  // resolution state or timer in this version. The owning agent has one shared
  // capital ledger; another agent stays isolated.
  return rows.length > 0;
}
