// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useScopedApiKeyLimit } from "./useScopedApiKeyLimit";

const renderScopedApiKeyLimit = (initialScope: string) =>
  renderHook(({ scope }: { scope: string }) => useScopedApiKeyLimit(scope), { initialProps: { scope: initialScope } });

describe("useScopedApiKeyLimit", () => {
  it("applies a loaded limit in scope A", () => {
    const { result } = renderScopedApiKeyLimit("A");

    act(() => result.current.loadMoreKeys(131));

    expect(result.current.apiKeyLimit).toBe(131);
  });

  it("does not apply a limit from another scope", () => {
    const { result, rerender } = renderScopedApiKeyLimit("A");
    act(() => result.current.loadMoreKeys(131));

    rerender({ scope: "B" });

    expect(result.current.apiKeyLimit).toBeUndefined();
  });

  it("does not revive a limit after switching away from and back to its scope", () => {
    const { result, rerender } = renderScopedApiKeyLimit("A");
    act(() => result.current.loadMoreKeys(131));

    rerender({ scope: "B" });
    expect(result.current.apiKeyLimit).toBeUndefined();

    rerender({ scope: "A" });

    expect(result.current.apiKeyLimit).toBeUndefined();
  });

  it("applies a loaded limit to the current scope", () => {
    const { result, rerender } = renderScopedApiKeyLimit("A");
    act(() => result.current.loadMoreKeys(131));
    rerender({ scope: "B" });

    act(() => result.current.loadMoreKeys(100));

    expect(result.current.apiKeyLimit).toBe(100);
  });
});
