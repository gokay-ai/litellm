import { useCallback, useState } from "react";

interface ScopedApiKeyLimitState {
  scope: string;
  limit: number;
}

interface ScopedApiKeyLimitResult {
  apiKeyLimit: number | undefined;
  loadMoreKeys: (limit: number) => void;
}

export const useScopedApiKeyLimit = (scope: string): ScopedApiKeyLimitResult => {
  const [state, setState] = useState<ScopedApiKeyLimitState | null>(null);

  if (state !== null && state.scope !== scope) {
    setState(null);
  }

  const apiKeyLimit = state?.scope === scope ? state.limit : undefined;
  const loadMoreKeys = useCallback((limit: number) => setState({ scope, limit }), [scope]);

  return { apiKeyLimit, loadMoreKeys };
};
