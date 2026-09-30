import { useCallback, useLayoutEffect, useState } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "auto";
const THEME_KEY = "pcui-theme"; // Preserve existing explicit day/night choices.

export function themePreference(saved: string | null): ThemePreference {
  return saved === "light" || saved === "dark" ? saved : "auto";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  return preference === "auto" ? systemDark ? "dark" : "light" : preference;
}

interface SystemTheme {
  readonly matches: boolean;
  addEventListener(event: "change", listener: () => void): void;
  removeEventListener(event: "change", listener: () => void): void;
}

/** Only automatic mode subscribes. Updating CSS, rather than React's page state, avoids
 * recalculating tools just because the operating system changed its appearance. */
export function watchTheme(preference: ThemePreference, system: SystemTheme | undefined,
  apply: (theme: Theme) => void): () => void {
  const update = () => apply(resolveTheme(preference, system?.matches ?? false));
  update();
  if (preference !== "auto" || !system) return () => {};
  system.addEventListener("change", update);
  return () => system.removeEventListener("change", update);
}

export function useThemePreference() {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    try { return themePreference(localStorage.getItem(THEME_KEY)); } catch { return "auto"; }
  });
  useLayoutEffect(() => watchTheme(preference,
    window.matchMedia?.("(prefers-color-scheme: dark)"), (theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    }), [preference]);
  const choose = useCallback((next: ThemePreference) => {
    try { localStorage.setItem(THEME_KEY, next); } catch { /* Storage is optional. */ }
    setPreference(next);
  }, []);
  return [preference, choose] as const;
}
