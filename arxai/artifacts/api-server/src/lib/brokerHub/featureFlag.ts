export const BROKER_HUB_READONLY_DEFAULT_ENABLED = false;

export function isBrokerHubReadOnlyEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.ARX_BROKER_HUB_READONLY_ENABLED?.trim().toLowerCase() === "true";
}