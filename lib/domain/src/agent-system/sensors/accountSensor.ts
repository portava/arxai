import type { AccountObservation, AccountPort } from "../agentSystem.types";

export async function accountSensor(
  port: AccountPort,
  now: Date = new Date(),
): Promise<AccountObservation> {
  const raw = await port.fetchAccount();
  return { ...raw, observedAt: now.toISOString() };
}
