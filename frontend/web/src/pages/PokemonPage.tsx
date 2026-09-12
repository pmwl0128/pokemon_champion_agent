/** Dex-detail page: the pokemon's own facts — base/actual stats, type matchups, learnable moves.
 * The hero's rank chips LINK to the meta-detail page (usage panels live there). */
import type { FormatId, LearnsetDto, PokemonCardDto, TypeName } from "@pokemon-champions/protocol";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { EntityHover } from "../components/EntityHover.tsx";
import { MonHero } from "../components/MonHero.tsx";
import { StatsPanel } from "../components/StatsPanel.tsx";
import { CategoryBadge, TypeBadge } from "../components/TypeBadge.tsx";
import { useAsync, useDexIndex, usePokemonCard, useRanking } from "../hooks.ts";
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

/** Every form of this species, base first. A species used to have at most one Mega, so landing on
 * one form and never being offered the others was survivable; Regulation M-C added second Megas whose
 * typing and stat shape differ outright (Mega Garchomp is physical Dragon/Ground, Mega Garchomp Z is a
 * faster special pure Dragon), so the sibling forms have to be reachable from the form you opened. */
function FormSwitcher({ current }: { current: PokemonCardDto }) {
  const dex = useDexIndex();
  const navigate = useNavigate();
  const { lang } = useLang();
  const t = useT();
  const base = current.baseSpecies ?? current.name;
  const forms = dex.status === "ready"
    ? dex.data.filter((e) => e.name === base || e.baseSpecies === base)
      .sort((a, b) => Number(a.isMega) - Number(b.isMega) || a.name.localeCompare(b.name))
    : [];
  if (forms.length < 2) return null;
  return (
    <div className="form-switcher">
      <span className="lbl">{t("dex.forms")}</span>
      <div className="seg">
        {forms.map((f) => (
          <button key={f.slug} type="button"
            className={f.slug === current.slug ? "on" : undefined}
            aria-current={f.slug === current.slug ? "page" : undefined}
            onClick={() => navigate(`/pokemon/${f.slug}`)}>
            {displayName(f, lang)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function PokemonPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const card = usePokemonCard(slug);
  const singleRanking = useRanking("single");
  const doubleRanking = useRanking("double");
  const t = useT();

  if (card.status === "loading") return <div className="spinner">{t("state.loading")}</div>;
  if (card.status === "error") {
    return <div className="notice">{t("state.errorDetail")}</div>;
  }
  const mon = card.data;
  const rankingName = mon.isMega && mon.baseSpecies ? mon.baseSpecies : mon.name;
  const rankOf = (r: typeof singleRanking) =>
    r.status === "ready" ? r.data.rows.find((row) => row.name === rankingName)?.rank ?? null : null;
  const ranks: Array<[FormatId, number | null]> = [
    ["single", rankOf(singleRanking)], ["double", rankOf(doubleRanking)],
  ];

  return (
    <>
      <MonHero mon={mon} ranks={ranks}
        onRank={(f) => {
          const ranking = f === "single" ? singleRanking : doubleRanking;
          const baseSlug = ranking.status === "ready"
            ? ranking.data.rows.find((row) => row.name === rankingName)?.slug : undefined;
          navigate(`/meta/${baseSlug ?? mon.slug}?format=${f}`);
        }} />
      <FormSwitcher current={mon} />
      <div className="detail-stack">
        <StatsPanel stats={mon.stats} />
        <MatchupPanel types={mon.types} />
        <LearnsetPanel slug={mon.slug} />
      </div>
    </>
  );
}
