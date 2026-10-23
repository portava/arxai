import type {
  ExecutionDiagnosticsPort, ExecutionObservation,
} from "../agentSystem.types";

export async function executionSensor(
  port: ExecutionDiagnosticsPort,
  now: Date = new Date(),
): Promise<ExecutionObservation> {
  const raw = await port.fetchDiagnostics();
  return { ...raw, observedAt: now.toISOString() };
}
