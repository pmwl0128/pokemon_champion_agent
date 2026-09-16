/** Dex-detail page: the pokemon's own facts — base/actual stats, type matchups, learnable moves.
 * The hero's rank chips LINK to the meta-detail page (usage panels live there). */
import type { FormatId, LearnsetDto, PokemonCardDto, TypeName } from "@pokemon-champions/protocol";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { EntityHover } from "../components/EntityHover.tsx";
import { typeColor } from "../assets/icons.ts";
import { MonHero } from "../components/MonHero.tsx";
import { StatsPanel } from "../components/StatsPanel.tsx";
import {
  DexRail, EMPTY_FILTERS, pokemonMatches, type DexFilters,
} from "../components/DexRail.tsx";
import { RailHandle, useSideRail } from "../components/SideRail.tsx";
import { CategoryBadge, TypeBadge } from "../components/TypeBadge.tsx";
import { useAsync, useDexIndex, useLearners, usePokemonCard, useRanking } from "../hooks.ts";
import { displayName, useLang, useT, type MsgKey } from "../i18n.ts";
import { defensiveProfile, offensiveProfile } from "../lib/typechart.ts";
import { loadLearnset } from "../runtime/projection.ts";

function MatchupGroups({ groups }: { groups: Array<[MsgKey, TypeName[]]> }) {
  const t = useT();
  return (
    <div className="matchup-groups">
      {groups.map(([key, list]) => (
        <div className="mg" key={key}>
          <span className="lbl">{t(key)}</span>
          <span className="chips">
            {list.length === 0
              ? <span className="muted">—</span>
              : list.map((tp) => <TypeBadge key={tp} type={tp} iconOnly />)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Two columns: LEFT the defensive profile (what hits this mon), RIGHT the STAB coverage (what this
 * mon's own-type moves hit) — mirroring the stats panel's two-column split. */
function MatchupPanel({ types }: { types: TypeName[] }) {
  const t = useT();
  const def = defensiveProfile(types);
  const off = offensiveProfile(types);
  const defGroups: Array<[MsgKey, TypeName[]]> = [
    ["matchup.x4", def.x4], ["matchup.x2", def.x2], ["matchup.x05", def.x05],
    ["matchup.x025", def.x025], ["matchup.x0", def.x0],
  ];
  const offGroups: Array<[MsgKey, TypeName[]]> = [
    ["matchup.off.x2", off.x2], ["matchup.off.x05", off.x05], ["matchup.off.x0", off.x0],
  ];
  return (
    <section className="panel matchup-strip">
      <h2>{t("detail.matchup")}</h2>
      <div className="matchup-two">
        <div className="mcol">
          <span className="mcol-h">{t("matchup.defTitle")}</span>
          <MatchupGroups groups={defGroups} />
        </div>
        <div className="mcol">
          <span className="mcol-h">{t("matchup.offTitle")}
            <span className="stab-types">{types.map((tp) => <TypeBadge key={tp} type={tp} iconOnly />)}</span>
          </span>
          <MatchupGroups groups={offGroups} />
        </div>
      </div>
    </section>
  );
}

function LearnsetPanel({ slug }: { slug: string }) {
  const t = useT();
  const { lang } = useLang();
  const [query, setQuery] = useState("");
  const learnset = useAsync<LearnsetDto>(() => loadLearnset(slug), [slug]);

  const moves = useMemo(() => {
    if (learnset.status !== "ready") return [];
    const q = query.trim().toLowerCase();
    if (!q) return learnset.data.moves;
    return learnset.data.moves.filter((m) =>
      m.name.toLowerCase().includes(q) || (m.nameZh?.includes(query.trim()) ?? false) ||
      (m.nameJa?.includes(query.trim()) ?? false) || m.type.toLowerCase() === q);
  }, [learnset, query]);

  return (
    <section className="panel learnset-panel">
      <h2>
        {t("detail.learnset")}
        {learnset.status === "ready" && (
          <span className="muted num" style={{ float: "right", textTransform: "none" }}>
            {moves.length} / {learnset.data.moves.length}
          </span>
        )}
      </h2>
      <div className="search-row">
        <input type="search" value={query} placeholder={t("learnset.search")}
          onChange={(e) => setQuery(e.target.value)} aria-label={t("learnset.search")} />
      </div>
      {learnset.status === "loading" && <div className="spinner">{t("state.loading")}</div>}
      {learnset.status === "ready" && (
        <div className="learnset-table learnset-grid">
          {moves.map((m) => (
            <div className="learnset-row" key={m.name}>
              <TypeBadge type={m.type} iconOnly />
              <CategoryBadge category={m.category} />
              <EntityHover kind="move" name={m.name}>
                <span className="lm-name">{displayName(m, lang)}</span>
              </EntityHover>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function PokemonPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const card = usePokemonCard(slug);
  const dex = useDexIndex();
  const { lang } = useLang();
  const singleRanking = useRanking("single");
  const doubleRanking = useRanking("double");
  const t = useT();

  // The same browse rail the dex page carries, so reading one Pokemon and going to the next is a
  // single click instead of a trip back to the grid.
  const railState = useSideRail(360, 620);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<DexFilters>(EMPTY_FILTERS);
  const learners = useLearners(filters.pokemon.moves.length > 0 || railState.open);
  const learnerTable = learners.status === "ready" && learners.data ? learners.data.moves : null;
  const railRows = useMemo(() => {
    if (dex.status !== "ready") return [];
    const q = query.trim().toLowerCase();
    // A move filter cannot be answered before its index lands; an unfiltered list in the meantime
    // would flash a wrong answer, so hold an empty one.
    const sets = filters.pokemon.moves.length > 0
      ? (learnerTable ? filters.pokemon.moves.map((m) => new Set(learnerTable[m] ?? [])) : null)
      : [];
    if (sets === null) return [];
    return dex.data.filter((e) => pokemonMatches(e, filters.pokemon, sets) && (
      !q || e.name.toLowerCase().includes(q)
        || (e.nameZh?.includes(query.trim()) ?? false)
        || (e.nameJa?.includes(query.trim()) ?? false)
        || e.slug.includes(q) || String(e.nationalDex) === q));
  }, [dex, query, filters.pokemon, learnerTable]);

  const rail = (
    <>
      <RailHandle state={railState} label={t("rail.dex")} />
      <DexRail state={railState} tab="pokemon" query={query} setQuery={setQuery}
        filters={filters} setFilters={setFilters} learners={learnerTable} priorities={[]}
        rows={railRows} activeSlug={slug} count={railRows.length}
        label={`${t("rail.dex")} · ${t("dex.tab.pokemon")}`} />
    </>
  );

  if (card.status === "loading") {
    return <>{rail}<div className="spinner">{t("state.loading")}</div></>;
  }
  if (card.status === "error") {
    return <>{rail}<div className="notice">{t("state.errorDetail")}</div></>;
  }
  const mon = card.data;
  const rankingName = mon.isMega && mon.baseSpecies ? mon.baseSpecies : mon.name;
  const rankOf = (r: typeof singleRanking) =>
    r.status === "ready" ? r.data.rows.find((row) => row.name === rankingName)?.rank ?? null : null;
  const ranks: Array<[FormatId, number | null]> = [
    ["single", rankOf(singleRanking)], ["double", rankOf(doubleRanking)],
  ];

  /** Every form of this species, base first, offered in the hero's own title — the same control the
   * meta detail page uses, rather than a second switcher on a row of its own.
   *
   * A species used to have at most one Mega, so landing on one form and never being offered the
   * others was survivable; Regulation M-C added second Megas whose typing and stat shape differ
   * outright (Mega Garchomp is physical Dragon/Ground, Mega Garchomp Z a faster special pure
   * Dragon), so the siblings have to be reachable from whichever form you opened. */
  const baseName = mon.baseSpecies ?? mon.name;
  const siblings = dex.status === "ready"
    ? dex.data.filter((e) => e.name === baseName || e.baseSpecies === baseName)
      .sort((a, b) => Number(a.isMega) - Number(b.isMega) || a.name.localeCompare(b.name))
    : [];
  const forms = siblings.length > 1
    ? siblings.map((f) => ({
        key: f.slug, label: displayName(f, lang), active: f.slug === mon.slug,
        onSelect: () => navigate(`/pokemon/${f.slug}`),
      }))
    : undefined;

  return (
    <>
      {rail}
      {/* Same accent rule as the metagame detail page: the two pages are the same subject seen from
          two sides, so they wear the same colour. The rail stays outside — it belongs to the site. */}
      <div className="mon-theme" style={{ ["--accent" as string]: typeColor(mon.types[0] ?? "") }}>
        <MonHero mon={mon} ranks={ranks} forms={forms}
          onRank={(f) => {
            const ranking = f === "single" ? singleRanking : doubleRanking;
            const baseSlug = ranking.status === "ready"
              ? ranking.data.rows.find((row) => row.name === rankingName)?.slug : undefined;
            navigate(`/meta/${baseSlug ?? mon.slug}?format=${f}`);
          }} />
        <div className="detail-stack">
          <StatsPanel stats={mon.stats} />
          <MatchupPanel types={mon.types} />
          <LearnsetPanel slug={mon.slug} />
        </div>
      </div>
    </>
  );
}
