import { afterEach, expect, test, vi } from "vitest";
import { loadTeamEvidence, watchTeamExpiry } from "./teamEvidence.ts";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test("only team evidence changes at the exact expiry; native absence does not reuse old teams", async () => {
  const mixed = { teamEvidenceExpiresAt: "2026-09-17T00:00:00Z", species: ["old", "native"] };
  const native = { species: ["native"] };
  const load = vi.fn(async (pure: boolean) => pure ? native : mixed);
  const deadline = Date.parse(mixed.teamEvidenceExpiresAt);
  expect(await loadTeamEvidence(load, () => deadline - 1)).toBe(mixed);
  expect(load.mock.calls.map(c => c[0])).toEqual([false]);
  expect(await loadTeamEvidence(load, () => deadline)).toBe(native);
  expect(load.mock.calls.map(c => c[0])).toEqual([false, false, true]);
  expect(await loadTeamEvidence(async pure => pure ? { available: false } : mixed, () => deadline))
    .toEqual({ available: false });
  await expect(loadTeamEvidence(async () => mixed, () => deadline)).rejects.toThrow("Native team data");
  const currentMeta = { season: "M-6", ranking: [] };
  expect(await loadTeamEvidence(async () => currentMeta, () => deadline)).toBe(currentMeta);
});

test("mounted views share one expiry timer and react after a suspended tab resumes", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const doc = new EventTarget();
  vi.stubGlobal("document", doc);
  const first = vi.fn(), second = vi.fn();
  const a = watchTeamExpiry(1000, first);
  const b = watchTeamExpiry(1000, second);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(999);
  expect(first).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  a(); b();
  const resumed = vi.fn();
  const stop = watchTeamExpiry(2000, resumed);
  vi.setSystemTime(3000);
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(resumed).toHaveBeenCalledOnce();
  stop();
  expect(vi.getTimerCount()).toBe(0);
});
