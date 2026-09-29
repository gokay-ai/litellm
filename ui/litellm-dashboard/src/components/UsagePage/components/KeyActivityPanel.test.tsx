import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelActivityData } from "../types";
import { USAGE_TOP_API_KEYS_MAX } from "../apiKeyTruncation";
import KeyActivityPanel from "./KeyActivityPanel";

const renderedMetrics = vi.hoisted(() => ({ current: {} as Record<string, ModelActivityData> }));

vi.mock("@/components/activity_metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/activity_metrics")>()),
  ActivityMetrics: ({
    modelMetrics,
    summaryTitle = "Overall Usage",
  }: {
    modelMetrics: Record<string, ModelActivityData>;
    summaryTitle?: string;
  }) => {
    renderedMetrics.current = modelMetrics;
    return (
      <>
        <h3>{summaryTitle}</h3>
        <ul data-testid="rendered-keys">
          {Object.keys(modelMetrics).map((hash) => (
            <li key={hash}>{hash}</li>
          ))}
        </ul>
      </>
    );
  },
}));

function activity(label: string, user_email: string | null, user_id: string | null): ModelActivityData {
  return {
    label,
    key_metadata: { key_alias: label, team_id: "team-1", user_id, user_email },
    total_requests: 1,
    total_successful_requests: 1,
    total_failed_requests: 0,
    total_cache_read_input_tokens: 0,
    total_cache_creation_input_tokens: 0,
    total_tokens: 10,
    prompt_tokens: 5,
    completion_tokens: 5,
    total_spend: 0.01,
    top_models: [],
    daily_data: [],
  };
}

const keyMetrics: Record<string, ModelActivityData> = {
  "hash-alice": activity("alice-key", "alice@example.com", "user-alice"),
  "hash-bob": activity("bob-key", "bob@example.com", "user-bob"),
};

describe("KeyActivityPanel", () => {
  it("renders every key and the full count before searching", () => {
    render(<KeyActivityPanel keyMetrics={keyMetrics} />);
    expect(screen.getByTestId("rendered-keys")).toHaveTextContent("hash-alicehash-bob");
    expect(screen.getByText("Showing 2 of 2 keys")).toBeInTheDocument();
  });

  it("narrows the rendered keys to those matching the user email", () => {
    render(<KeyActivityPanel keyMetrics={keyMetrics} />);
    fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "bob@example.com" } });
    expect(screen.getByTestId("rendered-keys")).toHaveTextContent("hash-bob");
    expect(screen.getByTestId("rendered-keys")).not.toHaveTextContent("hash-alice");
    expect(screen.getByText("Showing 1 of 2 keys")).toBeInTheDocument();
  });

  it("shows an empty state instead of zeroed metrics when nothing matches", () => {
    render(<KeyActivityPanel keyMetrics={keyMetrics} />);
    fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "carol" } });
    expect(screen.queryByTestId("rendered-keys")).not.toBeInTheDocument();
    expect(screen.getByText('No keys match "carol" in this date range')).toBeInTheDocument();
  });

  it("clears the search and restores every key", () => {
    render(<KeyActivityPanel keyMetrics={keyMetrics} />);
    fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "user-alice" } });
    expect(screen.getByTestId("rendered-keys")).toHaveTextContent("hash-alice");
    fireEvent.click(screen.getByLabelText("Clear key search"));
    expect(screen.getByLabelText("Search keys")).toHaveValue("");
    expect(screen.getByTestId("rendered-keys")).toHaveTextContent("hash-alicehash-bob");
  });

  it("says how many keys the proxy left out when only the top spenders were loaded", () => {
    render(<KeyActivityPanel keyMetrics={keyMetrics} apiKeyTruncation={{ limit: 2, total: 3000 }} />);
    expect(screen.getByRole("note")).toHaveTextContent("Only the 2 highest-spend keys of 3,000 are loaded");
  });

  it.each([
    [3000, USAGE_TOP_API_KEYS_MAX],
    [500, 500],
  ])("loads up to the maximum key count for a truncated response with %i total keys", (total, nextLimit) => {
    const onLoadMoreKeys = vi.fn();
    render(
      <KeyActivityPanel
        keyMetrics={keyMetrics}
        apiKeyTruncation={{ limit: 100, total }}
        onLoadMoreKeys={onLoadMoreKeys}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: `Load top ${nextLimit} keys` }));

    expect(onLoadMoreKeys).toHaveBeenCalledTimes(1);
    expect(onLoadMoreKeys).toHaveBeenCalledWith(nextLimit);
  });

  it("hides the load-more button at the maximum while preserving the truncation note", () => {
    render(
      <KeyActivityPanel
        keyMetrics={keyMetrics}
        apiKeyTruncation={{ limit: USAGE_TOP_API_KEYS_MAX, total: USAGE_TOP_API_KEYS_MAX + 1 }}
        onLoadMoreKeys={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /Load top/ })).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(
      `Only the ${USAGE_TOP_API_KEYS_MAX.toLocaleString()} highest-spend keys of 1,001 are loaded`,
    );
  });

  it("shows no truncation note when every key is loaded", () => {
    render(<KeyActivityPanel keyMetrics={keyMetrics} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("labels usage when only the top keys are loaded", () => {
    render(<KeyActivityPanel keyMetrics={keyMetrics} apiKeyTruncation={{ limit: 100, total: 131 }} />);

    expect(screen.getByRole("heading", { name: "Usage for the top 100 of 131 keys" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Overall Usage" })).not.toBeInTheDocument();
  });

  it("keeps the overall usage label when every key is loaded", () => {
    render(<KeyActivityPanel keyMetrics={keyMetrics} />);

    expect(screen.getByRole("heading", { name: "Overall Usage" })).toBeInTheDocument();
  });

  it("labels usage for matching keys while filtering", () => {
    render(<KeyActivityPanel keyMetrics={keyMetrics} apiKeyTruncation={{ limit: 100, total: 131 }} />);
    fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "alice" } });

    expect(screen.getByRole("heading", { name: "Usage for matching keys" })).toBeInTheDocument();
  });

  describe("remote search", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const remoteSearchProps = (searchKeys = vi.fn().mockResolvedValue({ api_keys: [] })) => ({
      apiKeyTruncation: { limit: 2, total: 3000 },
      searchKeys,
    });

    it("calls searchKeys after the debounce when the list is truncated and the query has 2+ characters", async () => {
      const searchKeys = vi.fn().mockResolvedValue({ api_keys: [] });
      render(<KeyActivityPanel keyMetrics={keyMetrics} {...remoteSearchProps(searchKeys)} />);

      fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "al" } });
      expect(searchKeys).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(searchKeys).toHaveBeenCalledWith("al");
    });

    it("does not call searchKeys for a one-character query or when every key is already loaded", async () => {
      const searchKeys = vi.fn().mockResolvedValue({ api_keys: [] });
      render(<KeyActivityPanel keyMetrics={keyMetrics} {...remoteSearchProps(searchKeys)} />);

      fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "a" } });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(searchKeys).not.toHaveBeenCalled();

      render(<KeyActivityPanel keyMetrics={keyMetrics} searchKeys={searchKeys} />);
      fireEvent.change(screen.getAllByLabelText("Search keys")[1], { target: { value: "alice" } });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(searchKeys).not.toHaveBeenCalled();
    });

    it("renders keys the server returns that the truncated local list does not contain", async () => {
      const searchKeys = vi.fn().mockResolvedValue({
        api_keys: [
          {
            api_key: "hash-carol",
            metrics: {
              spend: 0.5,
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
              api_requests: 0,
              successful_requests: 0,
              failed_requests: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            metadata: { key_alias: "carol-key", team_id: null },
          },
        ],
      });
      render(<KeyActivityPanel keyMetrics={keyMetrics} {...remoteSearchProps(searchKeys)} />);

      fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "carol" } });
      expect(screen.getByText("Searching...")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();
      });

      expect(searchKeys).toHaveBeenCalledWith("carol");
      expect(screen.getByTestId("rendered-keys")).toHaveTextContent("hash-carol");
    });

    it("drops results from a previous scope and searches again when searchKeys changes", async () => {
      const remoteRow = {
        api_key: "hash-carol",
        metrics: {
          spend: 0.5,
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          api_requests: 0,
          successful_requests: 0,
          failed_requests: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        metadata: { key_alias: "carol-key", team_id: null },
      };
      const firstSearchKeys = vi.fn().mockResolvedValue({ api_keys: [remoteRow] });
      const secondSearchKeys = vi.fn().mockResolvedValue({ api_keys: [] });
      const { rerender } = render(<KeyActivityPanel keyMetrics={keyMetrics} {...remoteSearchProps(firstSearchKeys)} />);

      fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "carol" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.getByTestId("rendered-keys")).toHaveTextContent("hash-carol");

      rerender(<KeyActivityPanel keyMetrics={keyMetrics} {...remoteSearchProps(secondSearchKeys)} />);

      expect(screen.getByText("Searching...")).toBeInTheDocument();
      expect(screen.queryByTestId("rendered-keys")).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(secondSearchKeys).toHaveBeenCalledWith("carol");
      expect(screen.queryByText("Searching...")).not.toBeInTheDocument();
      expect(screen.getByText('No keys match "carol" in this date range')).toBeInTheDocument();
    });

    it("keeps local daily history and top models for a key the remote search also returns", async () => {
      const localDailyData = [
        {
          date: "2026-09-27",
          metrics: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            api_requests: 0,
            spend: 1.5,
            successful_requests: 0,
            failed_requests: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      ];
      const localTopModels = [
        { model: "gpt-4o-mini", spend: 1.5, requests: 1, successful_requests: 1, failed_requests: 0, tokens: 10 },
      ];
      const localMetrics: Record<string, ModelActivityData> = {
        "hash-alice": {
          ...activity("alice-key", "alice@example.com", "user-alice"),
          daily_data: localDailyData,
          top_models: localTopModels,
        },
      };
      const searchKeys = vi.fn().mockResolvedValue({
        api_keys: [
          {
            api_key: "hash-alice",
            metrics: {
              spend: 99,
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
              api_requests: 0,
              successful_requests: 0,
              failed_requests: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            metadata: { key_alias: "alice-key", team_id: "team-1" },
          },
        ],
      });
      render(<KeyActivityPanel keyMetrics={localMetrics} {...remoteSearchProps(searchKeys)} />);

      fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "alice" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(searchKeys).toHaveBeenCalledWith("alice");
      expect(renderedMetrics.current["hash-alice"].daily_data).toBe(localDailyData);
      expect(renderedMetrics.current["hash-alice"].top_models).toBe(localTopModels);
      expect(renderedMetrics.current["hash-alice"].total_spend).toBe(0.01);
    });
  });
});
