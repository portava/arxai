import type { BehaviorObservation, BehaviorPort } from "../agentSystem.types";

export async function behaviorSensor(
  port: BehaviorPort,
  now: Date = new Date(),
): Promise<BehaviorObservation> {
  const raw = await port.fetchBehavior();
  return { ...raw, observedAt: now.toISOString() };
}
