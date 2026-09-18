import type { FormatId } from "@pokemon-champions/protocol";
import { Component, Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { BRAND_LOGO } from "./assets/icons.ts";
import { FormatTabs } from "./components/FormatTabs.tsx";
import { RailHandle, RailLayer, useRailEscape, type RailState } from "./components/SideRail.tsx";
import { LangContext, detectLang, saveLang, useLang, useT, type Lang } from "./i18n.ts";
import { RankingPage } from "./pages/RankingPage.tsx";
import { RuntimeProvider, useRuntime } from "./runtime/context.tsx";

type Theme = "light" | "dark";
const THEME_KEY = "pcui-theme";

function detectTheme(): Theme {
  let theme: Theme = "light";
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    theme = saved === "light" || saved === "dark"
      ? saved : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    theme = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  return theme;
}

function saveTheme(theme: Theme) {
  try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* storage may be unavailable */ }
}

function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const t = useT();
  return (
    <div className="theme-toggle" role="group" aria-label={t("theme.selector")}>
      {/* Icon only: sun and moon are unambiguous at this size, and the words cost more width in the
          top bar than they add. The selected state carries its own daylight/night hue so the active
          mode reads at a glance instead of as one more blue-tinted control. */}
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
    </div>
  );
}

// Keep the ranking route in the entry chunk and split every secondary surface. Navigation intent
// preloads the relevant module, so desktop hover/keyboard focus hides the network boundary while a
// direct URL still downloads only the page it needs.
const loadDexPage = () => import("./pages/DexPage.tsx");
const loadPokemonPage = () => import("./pages/PokemonPage.tsx");
const loadMetaPage = () => import("./pages/MetaPage.tsx");
const loadMatchupPage = () => import("./pages/MatchupPage.tsx");
const loadCalcPage = () => import("./pages/CalcPage.tsx");
const loadAssistantPage = () => import("./pages/AssistantPage.tsx");
const loadUepPages = () => import("./pages/uep/index.ts");

const DexPage = lazy(() => loadDexPage().then((m) => ({ default: m.DexPage })));
const PokemonPage = lazy(() => loadPokemonPage().then((m) => ({ default: m.PokemonPage })));
const MetaPage = lazy(() => loadMetaPage().then((m) => ({ default: m.MetaPage })));
const MatchupPage = lazy(() => loadMatchupPage().then((m) => ({ default: m.MatchupPage })));
const CalcPage = lazy(() => loadCalcPage().then((m) => ({ default: m.CalcPage })));
const AssistantPage = lazy(() => loadAssistantPage().then((m) => ({ default: m.AssistantPage })));
// The trend rail is intentionally absent from the entry graph until its handle is pressed.
const TrendDrawer = lazy(() => import("./components/TrendDrawer.tsx")
  .then((m) => ({ default: m.TrendDrawer })));
// Both local UEP pages intentionally share one chunk; online runtimes never request it.
const SessionsPage = lazy(() => loadUepPages().then((m) => ({ default: m.SessionsPage })));
const SessionPage = lazy(() => loadUepPages().then((m) => ({ default: m.SessionPage })));

function NavItem({ to, label, preload, end = false }: {
  to: string;
  label: string;
  preload?: () => Promise<unknown>;
  end?: boolean;
}) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? "active" : "")}
      onPointerEnter={preload} onFocus={preload}>
      {label}
    </NavLink>
  );
}

function RouteLoading() {
  const t = useT();
  return <div className="spinner route-loading" role="status" aria-live="polite">{t("state.loading")}</div>;
}

function PageCrashFallback() {
  const t = useT();
  return (
    <main className="content" role="alert">
      <section className="panel route-missing">
        <h1>{t("state.pageCrashTitle")}</h1>
        <p>{t("state.pageCrashBody")}</p>
        <button type="button" className="primary-btn" onClick={() => window.location.reload()}>
          {t("state.reload")}
        </button>
      </section>
    </main>
  );
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error("UI render failed", error);
  }

  render() {
    return this.state.failed ? <PageCrashFallback /> : this.props.children;
  }
}

function RouteScrollReset() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [pathname]);
  return null;
}

function MissingRoute() {
  const t = useT();
  return (
    <section className="panel route-missing" role="status">
      <h1>{t("route.missingTitle")}</h1>
      <p>{t("route.missingBody")}</p>
      <NavLink className="primary-btn" to="/">{t("route.home")}</NavLink>
    </section>
  );
}

function EnvironmentTrendRail() {
  const location = useLocation();
  const navigate = useNavigate();
  const t = useT();
  const environmentRoute = location.pathname === "/" || location.pathname.startsWith("/meta/");
  const searchParams = new URLSearchParams(location.search);
  const format = searchParams.get("format") === "double"
    ? "double" as const : "single" as const;
  const open = environmentRoute && searchParams.get("trend") === "1";
  const setOpen = useCallback((open: boolean) => {
    const updated = new URLSearchParams(location.search);
    if (open) updated.set("trend", "1");
    else updated.delete("trend");
    navigate({ pathname: location.pathname, search: updated.toString() }, { replace: true });
  }, [location.pathname, location.search, navigate]);
  const setFormat = useCallback((next: FormatId) => {
    const updated = new URLSearchParams(location.search);
    updated.set("format", next);
    navigate({ pathname: location.pathname, search: updated.toString() }, { replace: true });
  }, [location.pathname, location.search, navigate]);
  // The URL marker is authoritative across detail navigation and reloads. This rail is a
  // viewport overlay, not a gutter rail: it never writes shell padding or resizes the page.
  const state: RailState = { open, setOpen, overlay: false, width: 320, side: "right" };
  useRailEscape(state);

  if (!environmentRoute) return null;
  return (
    <>
      <RailHandle state={state} label={t("nav.trend")} />
      {state.open && (
        /* Keep the animated rail shell mounted while the first lazy chunk resolves. Replacing one
         * RailLayer with another restarted its entrance animation and made the underlying page look
         * as though it had refreshed. Only the body crosses the Suspense boundary now. */
        <RailLayer state={state} label={t("trend.title")} className="trend-overlay"
          headDescription={t("trend.description")}
          headActions={<FormatTabs format={format} onChange={setFormat} className="page-tabs" />}>
          <Suspense fallback={
            <div className="spinner trend-rail-loading">{t("state.loading")}</div>
          }>
            <TrendDrawer format={format} />
          </Suspense>
        </RailLayer>
      )}
    </>
  );
}

function Shell({ theme, setTheme }: { theme: Theme; setTheme: (theme: Theme) => void }) {
  const { capabilities, can } = useRuntime();
  const t = useT();
  const { lang, setLang } = useLang();
  return (
    <div className="shell">
      <RouteScrollReset />
      <a className="skip-link" href="#main-content">{t("a11y.skipContent")}</a>
      <EnvironmentTrendRail />
      <header className="topbar">
        <span className="logo">
          <img src={BRAND_LOGO} alt="" aria-hidden />
          Champions
        </span>
        <nav aria-label={t("a11y.primaryNav")}>
          <NavItem to="/" end label={t("nav.ranking")} />
          <NavItem to="/dex" label={t("nav.dex")} preload={loadDexPage} />
          {can("calc.damage") && (
            <NavItem to="/calc" label={t("nav.calc")} preload={loadCalcPage} />
          )}
          {can("team.matchup") && (
            <NavItem to="/matchup" label={t("nav.matchup")} preload={loadMatchupPage} />
          )}
          {(can("llm.qa") || can("llm.builder")) && (
            <NavItem to="/assist" label={t("nav.assistant")} preload={loadAssistantPage} />
          )}
          {can("team.uep") && (
            <NavItem to="/sessions" label={t("nav.sessions")} preload={loadUepPages} />
          )}
        </nav>
        <span className="env num" title={capabilities.deploymentId}>
          <span>{capabilities.environment.season} · {capabilities.environment.rule}</span>
          {capabilities.environment.asOf && (
            <span className="env-date"> · {capabilities.environment.asOf}</span>
          )}
        </span>
        <ThemeToggle theme={theme} onChange={setTheme} />
        <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t("a11y.language")}>
          <option value="zh">中文</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
        </select>
      </header>
      <main id="main-content" className="content" tabIndex={-1}>
        <Suspense fallback={<RouteLoading />}>
          <Routes>
          <Route path="/" element={<RankingPage />} />
          <Route path="/dex" element={<DexPage />} />
          <Route path="/pokemon/:slug" element={<PokemonPage />} />
          <Route path="/meta/:slug" element={<MetaPage />} />
          <Route path="/trend" element={<Navigate to="/?trend=1" replace />} />
          <Route path="/matchup" element={<MatchupPage />} />
          <Route path="/calc" element={<CalcPage />} />
          {(can("llm.qa") || can("llm.builder")) && (
            <Route path="/assist" element={<AssistantPage />} />
          )}
          {can("llm.qa") && <Route path="/qa" element={<Navigate to="/assist" replace />} />}
          {can("llm.builder") && (
            <Route path="/builder" element={<Navigate to="/assist?tab=wizard" replace />} />
          )}
          {can("team.uep") && (
            <>
              <Route path="/sessions" element={<SessionsPage />} />
              <Route path="/sessions/:id" element={<SessionPage />} />
            </>
          )}
          <Route path="*" element={<MissingRoute />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

// Lang state lives above RuntimeProvider so error screens localize too.
export function App() {
  const [lang, setLangState] = useState<Lang>(detectLang());
  const [theme, setThemeState] = useState<Theme>(detectTheme);
  useEffect(() => {
    document.documentElement.lang = { zh: "zh-CN", en: "en", ja: "ja" }[lang];
    document.title = {
      zh: "宝可梦冠军队伍助手",
      en: "Pokémon Champions Team Assistant",
      ja: "Pokémon Champions 構築アシスタント",
    }[lang];
  }, [lang]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
  const setLang = (l: Lang) => {
    saveLang(l);
    setLangState(l);
  };
  const setTheme = (next: Theme) => {
    saveTheme(next);
    setThemeState(next);
  };
  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <AppErrorBoundary>
        <RuntimeProvider>
          <Shell theme={theme} setTheme={setTheme} />
        </RuntimeProvider>
      </AppErrorBoundary>
    </LangContext.Provider>
  );
}
