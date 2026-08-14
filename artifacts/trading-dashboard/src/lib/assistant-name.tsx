import React, { createContext, useContext } from "react";
import {
  useGetMeAssistantSettings,
  getGetMeAssistantSettingsQueryKey,
} from "@workspace/api-client-react";
import {
  DEFAULT_ASSISTANT_NAME,
  resolveAssistantName,
  validateAssistantName,
} from "@workspace/domain/assistant-name";

// Re-export the shared pure helpers so the rest of the frontend imports the
// assistant-name surface from a single place. Personalization/branding ONLY —
// nothing here affects AI logic, safety, or execution.
export {
  DEFAULT_ASSISTANT_NAME,
  resolveAssistantName,
  validateAssistantName,
};
export type {
  AssistantNameValidation,
  AssistantNameErrorCode,
} from "@workspace/domain/assistant-name";

interface AssistantNameContextValue {
  /** Resolved display name to show in user-facing copy (never empty). */
  name: string;
  /** True while the per-user setting is still loading. */
  isLoading: boolean;
  /** True when the user has not set a custom name (using the default). */
  isDefault: boolean;
}

const AssistantNameContext = createContext<AssistantNameContextValue | null>(null);

/**
 * Provides the resolved assistant display name app-wide. Fetches the per-user
 * setting via the generated hook and falls back to the default (Eleanor) while
 * loading or on error, so user-facing copy always has a name to render.
 */
export function AssistantNameProvider({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useGetMeAssistantSettings({
    query: {
      queryKey: getGetMeAssistantSettingsQueryKey(),
      staleTime: 5 * 60 * 1000,
      retry: false,
    },
  });

  const name = resolveAssistantName(data?.displayName);
  const isDefault = data?.isDefault ?? true;

  return (
    <AssistantNameContext.Provider value={{ name, isLoading, isDefault }}>
      {children}
    </AssistantNameContext.Provider>
  );
}

/**
 * Read the resolved assistant display name. Safe to call outside the provider —
 * it degrades to the default name so copy never breaks.
 */
export function useAssistantName(): AssistantNameContextValue {
  const ctx = useContext(AssistantNameContext);
  if (!ctx) {
    return { name: DEFAULT_ASSISTANT_NAME, isLoading: false, isDefault: true };
  }
  return ctx;
}
