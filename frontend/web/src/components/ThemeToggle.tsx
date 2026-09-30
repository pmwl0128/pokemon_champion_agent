import { useT } from "../i18n.ts";
import type { ThemePreference } from "../lib/theme.ts";

export function ThemeToggle({ theme, onChange }: {
  theme: ThemePreference; onChange: (theme: ThemePreference) => void;
}) {
  const t = useT();
  return (
    <div className="theme-toggle" role="group" aria-label={t("theme.selector")}>
      <button type="button" className={`day${theme === "light" ? " on" : ""}`}
        aria-pressed={theme === "light"} title={t("theme.toLight")}
        aria-label={t("theme.toLight")} onClick={() => onChange("light")}>
        <svg viewBox="0 0 24 24" aria-hidden focusable="false">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      </button>
      <button type="button" className={`night${theme === "dark" ? " on" : ""}`}
        aria-pressed={theme === "dark"} title={t("theme.toDark")}
        aria-label={t("theme.toDark")} onClick={() => onChange("dark")}>
        <svg viewBox="0 0 24 24" aria-hidden focusable="false">
          <path d="M20.2 15.3A8.7 8.7 0 0 1 8.7 3.8 8.7 8.7 0 1 0 20.2 15.3Z" />
        </svg>
      </button>
      <button type="button" className={`auto${theme === "auto" ? " on" : ""}`}
        aria-pressed={theme === "auto"} title={t("theme.toAuto")}
        aria-label={t("theme.toAuto")} onClick={() => onChange("auto")}>
        <svg viewBox="0 0 24 24" aria-hidden focusable="false">
          <g className="auto-sun">
            <path d="M10.5 6a6 6 0 0 0 0 12" />
            <path d="M10.5 2v1.5M10.5 20.5V22M3.4 4.9l1.1 1.1M1 12h1.5M3.4 19.1L4.5 18" />
          </g>
          <path className="auto-moon" d="M13.5 4a8 8 0 0 1 0 16 8.5 8.5 0 0 0 0-16Z" />
        </svg>
      </button>
    </div>
  );
}
