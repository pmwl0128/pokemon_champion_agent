import { describe, expect, it } from "vitest";
import { resolveTheme, themePreference, watchTheme } from "./theme.ts";

describe("theme preference", () => {
  it("keeps existing explicit choices, defaults missing/invalid values to auto", () => {
    expect(themePreference("light")).toBe("light");
    expect(themePreference("dark")).toBe("dark");
    for (const saved of [null, "auto", "invalid"]) expect(themePreference(saved)).toBe("auto");
  });

  it("follows system changes only in auto and removes its listener on cleanup", () => {
    const listeners = new Set<() => void>();
    const system = {
      matches: false,
      addEventListener: (_event: string, listener: () => void) => { listeners.add(listener); },
      removeEventListener: (_event: string, listener: () => void) => { listeners.delete(listener); },
    };
    const applied: string[] = [];
    const stop = watchTheme("auto", system, (theme) => applied.push(theme));
    expect(applied).toEqual(["light"]);
    system.matches = true;
    listeners.forEach((listener) => listener());
    expect(applied).toEqual(["light", "dark"]);
    stop();
    expect(listeners.size).toBe(0);
    const stopManual = watchTheme("light", system, (theme) => applied.push(theme));
    expect(applied.at(-1)).toBe("light");
    expect(listeners.size).toBe(0);
    stopManual();
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
  });
});
