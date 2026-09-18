import { describe, expect, it } from "vitest";
import type { RuntimeAdapter } from "./runtime/adapter.ts";
import { loadOppSetsCached, QueryCache } from "./hooks.ts";

async function put(cache: QueryCache, key: string, value: unknown): Promise<void> {
  await cache.get(key, async () => value);
}

describe("QueryCache", () => {
  it("does not turn render-only peeks into LRU accesses", async () => {
    const cache = new QueryCache(2, 10_000, 1_000);
    await put(cache, "a", { value: "a" });
    await put(cache, "b", { value: "b" });

    expect(cache.peek("a")?.status).toBe("ready");
    await put(cache, "c", { value: "c" });

    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("b")?.status).toBe("ready");
  });

  it("keeps expensive large documents through small-entry count churn", async () => {
    const cache = new QueryCache(2, 10_000, 100);
    await put(cache, "matrix", { cells: "x".repeat(400) });
    await put(cache, "a", { value: "a" });
    await put(cache, "b", { value: "b" });
    await put(cache, "c", { value: "c" });

    expect(cache.peek("matrix")?.status).toBe("ready");
    expect(cache.peek("a")).toBeUndefined();
  });

  it("still evicts the oldest large document under byte pressure", async () => {
    const cache = new QueryCache(10, 650, 100);
    await put(cache, "old", { cells: "x".repeat(400) });
    await put(cache, "new", { cells: "y".repeat(400) });

    expect(cache.peek("old")).toBeUndefined();
    expect(cache.peek("new")?.status).toBe("ready");
  });
});

it("shares the matchup set catalog with imperative calculator consumers", async () => {
  let calls = 0;
  const catalog = { species: [], sets: {} };
  const adapter = {
    oppSets: async () => { calls += 1; return catalog; },
  } as unknown as RuntimeAdapter;

  const [first, second] = await Promise.all([
    loadOppSetsCached(adapter, "test-shared-catalog", "single"),
    loadOppSetsCached(adapter, "test-shared-catalog", "single"),
  ]);

  expect(first).toBe(catalog);
  expect(second).toBe(catalog);
  expect(calls).toBe(1);
});
