import { Suspense, lazy, useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { BRAND_LOGO } from "./assets/icons.ts";
import { LangContext, detectLang, saveLang, useLang, useT, type Lang } from "./i18n.ts";
import { RankingPage } from "./pages/RankingPage.tsx";
import { RuntimeProvider, useRuntime } from "./runtime/context.tsx";

// Keep the ranking route in the entry chunk and split every secondary surface. Navigation intent
// preloads the relevant module, so desktop hover/keyboard focus hides the network boundary while a
// direct URL still downloads only the page it needs.
const loadDexPage = () => import("./pages/DexPage.tsx");
const loadPokemonPage = () => import("./pages/PokemonPage.tsx");
const loadMetaPage = () => import("./pages/MetaPage.tsx");
const loadTrendPage = () => import("./pages/TrendPage.tsx");
const loadMatchupPage = () => import("./pages/MatchupPage.tsx");
const loadCalcPage = () => import("./pages/CalcPage.tsx");
const loadQaPage = () => import("./pages/QaPage.tsx");
const loadBuilderPage = () => import("./pages/BuilderPage.tsx");
const loadUepPages = () => import("./pages/uep/index.ts");

const DexPage = lazy(() => loadDexPage().then((m) => ({ default: m.DexPage })));
const PokemonPage = lazy(() => loadPokemonPage().then((m) => ({ default: m.PokemonPage })));
const MetaPage = lazy(() => loadMetaPage().then((m) => ({ default: m.MetaPage })));
const TrendPage = lazy(() => loadTrendPage().then((m) => ({ default: m.TrendPage })));
const MatchupPage = lazy(() => loadMatchupPage().then((m) => ({ default: m.MatchupPage })));
const CalcPage = lazy(() => loadCalcPage().then((m) => ({ default: m.CalcPage })));
const QaPage = lazy(() => loadQaPage().then((m) => ({ default: m.QaPage })));
const BuilderPage = lazy(() => loadBuilderPage().then((m) => ({ default: m.BuilderPage })));
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

function Shell() {
  const { capabilities, can } = useRuntime();
  const t = useT();
  const { lang, setLang } = useLang();
  return (
    <div className="shell">
      <RouteScrollReset />
      <a className="skip-link" href="#main-content">{t("a11y.skipContent")}</a>
      <header className="topbar">
        <span className="logo">
          <img src={BRAND_LOGO} alt="" aria-hidden />
          Champions
        </span>
        <nav aria-label={t("a11y.primaryNav")}>
          <NavItem to="/" end label={t("nav.ranking")} />
          <NavItem to="/dex" label={t("nav.dex")} preload={loadDexPage} />
          <NavItem to="/trend" label={t("nav.trend")} preload={loadTrendPage} />
          {can("team.matchup") && (
            <NavItem to="/matchup" label={t("nav.matchup")} preload={loadMatchupPage} />
          )}
          {can("calc.damage") && (
            <NavItem to="/calc" label={t("nav.calc")} preload={loadCalcPage} />
          )}
          {can("llm.qa") && (
            <NavItem to="/qa" label={t("nav.qa")} preload={loadQaPage} />
          )}
          {can("llm.builder") && (
            <NavItem to="/builder" label={t("nav.builder")} preload={loadBuilderPage} />
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
          <Route path="/trend" element={<TrendPage />} />
          <Route path="/matchup" element={<MatchupPage />} />
          <Route path="/calc" element={<CalcPage />} />
          {can("llm.qa") && <Route path="/qa" element={<QaPage />} />}
          {can("llm.builder") && <Route path="/builder" element={<BuilderPage />} />}
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
