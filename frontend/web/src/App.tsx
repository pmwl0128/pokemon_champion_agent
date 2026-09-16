import type { FormatId } from "@pokemon-champions/protocol";
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { BRAND_LOGO } from "./assets/icons.ts";
import { RailHandle, RailLayer, type RailState } from "./components/SideRail.tsx";
import { LangContext, detectLang, saveLang, useLang, useT, type Lang } from "./i18n.ts";
import { RankingPage } from "./pages/RankingPage.tsx";
import { RuntimeProvider, useRuntime } from "./runtime/context.tsx";

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

  if (!environmentRoute) return null;
  return (
    <>
      <RailHandle state={state} label={t("nav.trend")} />
      {state.open && (
        <Suspense fallback={
          <RailLayer state={state} label={t("trend.title")} className="trend-overlay">
            <div className="spinner trend-rail-loading">{t("state.loading")}</div>
          </RailLayer>
        }>
          <TrendDrawer state={state} format={format} onFormatChange={setFormat} />
        </Suspense>
      )}
    </>
  );
}

function Shell() {
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
  useEffect(() => {
    document.documentElement.lang = { zh: "zh-CN", en: "en", ja: "ja" }[lang];
    document.title = {
      zh: "宝可梦冠军队伍助手",
      en: "Pokémon Champions Team Assistant",
      ja: "Pokémon Champions 構築アシスタント",
    }[lang];
  }, [lang]);
  const setLang = (l: Lang) => {
    saveLang(l);
    setLangState(l);
  };
  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <RuntimeProvider>
        <Shell />
      </RuntimeProvider>
    </LangContext.Provider>
  );
}
