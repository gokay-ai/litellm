import { Search, X } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";

import { ActivityMetrics } from "@/components/activity_metrics";
import type { Team } from "@/components/key_team_helpers/key_list";
import { USAGE_TOP_API_KEYS_MAX, type ApiKeyTruncation } from "@/components/UsagePage/apiKeyTruncation";
import type { DailyActivityKeySearchResponse } from "@/components/UsagePage/dailyActivityApi";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";

import { filterKeyActivity } from "../keyActivityFilter";
import type { ModelActivityData } from "../types";
import { keyActivityRowsToMetrics } from "./keySearch";

const SEARCH_DEBOUNCE_MS = 300;
const MIN_SEARCH_LENGTH = 2;

interface KeyActivityPanelProps {
  keyMetrics: Record<string, ModelActivityData>;
  hidePromptCachingMetrics?: boolean;
  apiKeyTruncation?: ApiKeyTruncation;
  onLoadMoreKeys?: (limit: number) => void;
  teams?: Team[];
  searchKeys?: (search: string) => Promise<DailyActivityKeySearchResponse>;
}

const keyActivitySummaryTitle = (
  isFiltering: boolean,
  apiKeyTruncation: ApiKeyTruncation | undefined,
): string | undefined => {
  if (isFiltering) return "Usage for matching keys";
  if (apiKeyTruncation === undefined) return undefined;
  return `Usage for the top ${apiKeyTruncation.limit.toLocaleString()} of ${apiKeyTruncation.total.toLocaleString()} keys`;
};

const KeyActivityPanel: React.FC<KeyActivityPanelProps> = ({
  keyMetrics,
  hidePromptCachingMetrics = false,
  apiKeyTruncation,
  onLoadMoreKeys,
  teams = [],
  searchKeys,
}) => {
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<{
    term: string;
    searchKeys: NonNullable<KeyActivityPanelProps["searchKeys"]>;
    metrics: Record<string, ModelActivityData>;
  } | null>(null);
  const searchIdRef = useRef(0);

  const localFiltered = useMemo(() => filterKeyActivity(keyMetrics, query), [keyMetrics, query]);
  const remoteSearchEnabled = apiKeyTruncation !== undefined && searchKeys !== undefined;
  const trimmedQuery = query.trim();
  const remoteSearchActive = remoteSearchEnabled && trimmedQuery.length >= MIN_SEARCH_LENGTH;
  const searchTerm = remoteSearchActive ? trimmedQuery : null;

  useEffect(() => {
    if (!searchTerm || !searchKeys) return;
    const searchId = ++searchIdRef.current;
    const timer = setTimeout(() => {
      searchKeys(searchTerm)
        .then((response) => {
          if (searchIdRef.current !== searchId) return;
          setSearchResult({
            term: searchTerm,
            searchKeys,
            metrics: keyActivityRowsToMetrics(response.api_keys, teams),
          });
        })
        .catch((error) => {
          if (searchIdRef.current !== searchId) return;
          console.error("Key activity search failed:", error);
          setSearchResult({ term: searchTerm, searchKeys, metrics: {} });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- teams is stable per parent render
  }, [searchTerm, searchKeys]);

  const isCurrentResult = searchResult?.term === searchTerm && searchResult?.searchKeys === searchKeys;
  const searching = searchTerm !== null && !isCurrentResult;
  const remoteMetrics = isCurrentResult ? searchResult.metrics : {};

  const filtered = useMemo(() => ({ ...remoteMetrics, ...localFiltered }), [localFiltered, remoteMetrics]);

  const totalKeys = Object.keys(keyMetrics).length;
  const shownKeys = Object.keys(filtered).length;
  const isFiltering = query.trim() !== "";
  const summaryTitle = keyActivitySummaryTitle(isFiltering, apiKeyTruncation);
  const nextApiKeyLimit =
    apiKeyTruncation === undefined ? undefined : Math.min(apiKeyTruncation.total, USAGE_TOP_API_KEYS_MAX);

  return (
    <div className="space-y-4">
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <InputGroup className="max-w-md">
          <InputGroupAddon>
            <Search className="size-4 text-muted-foreground" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search keys"
            placeholder="Search by key alias, key hash, user ID, or email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {isFiltering && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear key search" onClick={() => setQuery("")}>
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <span className="text-sm text-muted-foreground">
          {searching ? "Searching..." : `Showing ${shownKeys.toLocaleString()} of ${totalKeys.toLocaleString()} keys`}
        </span>
        {apiKeyTruncation !== undefined && (
          <span className="text-sm text-muted-foreground" role="note">
            Only the {apiKeyTruncation.limit.toLocaleString()} highest-spend keys of{" "}
            {apiKeyTruncation.total.toLocaleString()} are loaded
          </span>
        )}
        {apiKeyTruncation !== undefined &&
          nextApiKeyLimit !== undefined &&
          apiKeyTruncation.limit < USAGE_TOP_API_KEYS_MAX &&
          onLoadMoreKeys !== undefined && (
            <button
              type="button"
              className="text-sm text-primary underline underline-offset-4"
              onClick={() => onLoadMoreKeys(nextApiKeyLimit)}
            >
              {`Load top ${nextApiKeyLimit} keys`}
            </button>
          )}
      </div>
      {isFiltering && totalKeys > 0 && shownKeys === 0 ? (
        <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
          No keys match &quot;{query.trim()}&quot; in this date range
        </p>
      ) : (
        <ActivityMetrics
          modelMetrics={filtered}
          hidePromptCachingMetrics={hidePromptCachingMetrics}
          summaryTitle={summaryTitle}
        />
      )}
    </div>
  );
};

export default KeyActivityPanel;
