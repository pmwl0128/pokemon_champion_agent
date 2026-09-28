/** Dex-detail page: the Pokémon's own facts — base stats and the Lv.50 values they give, abilities,
 * type matchups, learnable moves — on the same card the metagame detail page uses (the two pages are
 * the same subject seen from two sides). The hero's rank pills go to the metagame page, where the
 * usage panels live. */
import "../styles.meta.css";
import "../styles.dex.css";
import type { FormatId, LearnsetDto, MoveCategory, PokemonCardDto, StatKey, TypeName } from "@pokemon-champions/protocol";
import { MOVE_CATEGORIES, STAT_KEYS } from "@pokemon-champions/protocol";
import { useMemo, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { EntityHover } from "../components/EntityHover.tsx";
import {
  DexRail, EMPTY_FILTERS, pokemonMatches, type DexFilters,
} from "../components/DexRail.tsx";
import { RailHandle, useSideRail } from "../components/SideRail.tsx";
import { SegmentedControl } from "../components/SegmentedControl.tsx";
import { CategoryBadge, TypeBadge } from "../components/TypeBadge.tsx";
import {
  useAbilitiesByName, useAsync, useDexIndex, useLearners, usePokemonCard, useRanking,
} from "../hooks.ts";
import { displayName, effectText, useLang, useT, type MsgKey } from "../i18n.ts";
import { actualStat } from "../lib/stats.ts";
import { defensiveProfile, offensiveProfile } from "../lib/typechart.ts";
import { loadLearnset } from "../runtime/projection.ts";
import { MetaHero, type MetaForm } from "./meta/MetaHero.tsx";
import { accentStyle } from "./meta/UsageCard.tsx";

import { SP_MAX } from "../lib/battle.ts";

/** The hero's right column: each ability with what it does. */
function Abilities({ mon }: { mon: PokemonCardDto }) {
  const t = useT();
  const { lang } = useLang();
  const byName = useAbilitiesByName();
  return (
    <div className="mc-abilities dx-abilities">
      <div className="mc-head"><h3>{t("detail.abilities")}</h3></div>
      {mon.abilities.map((ability) => {
        const effect = byName.get(ability.name);
        return (
          <EntityHover key={ability.name} kind="ability" name={ability.name}>
            <span className="dx-ability">
              <b>{displayName(ability, lang)}</b>
              {effect && <span className="dx-ability-fx">{effectText(effect, lang)}</span>}
            </span>
          </EntityHover>
        );
      })}
    </div>
  );
}

/** Lv.50 values: each stat from its floor (0 SP, a lowering nature) to its ceiling (32 SP, a raising
 * one), the neutral span darker inside it, and the four numbers beside. HP takes no nature. */
function ActualStats({ mon }: { mon: PokemonCardDto }) {
  const t = useT();
  const rows = STAT_KEYS.map((key: StatKey) => {
    const base = mon.stats[key];
    const hp = key === "hp";
    const low = actualStat(base, key, 0, hp ? 1 : 0.9);
    const zero = actualStat(base, key, 0, 1);
    const full = actualStat(base, key, SP_MAX, 1);
    const high = actualStat(base, key, SP_MAX, hp ? 1 : 1.1);
    return { key, hp, low, zero, full, high };
  });
  const scale = Math.max(...rows.map((row) => row.high)) * 1.04;
  const pct = (value: number) => `${(value / scale) * 100}%`;
  return (
    <section className="mc-panel dx-actual">
      <div className="mc-head">
        <h3>{t("dx.actual")}</h3>
        <span className="mc-head-note">{t("dx.actualNote")}</span>
      </div>
      <div className="dx-actual-head">
        <span />
        <span />
        <span title={t("dx.lowHint")}>{t("dx.low")}</span>
        <span>0 SP</span>
        <span>32 SP</span>
        <span title={t("dx.highHint")}>{t("dx.high")}</span>
      </div>
      {rows.map(({ key, hp, low, zero, full, high }) => (
        <div key={key} className="dx-actual-row">
          <span className="dx-actual-k">{t(`stat.${key}` as MsgKey)}</span>
          <span className="dx-range" aria-hidden>
            <i className="span" style={{ left: pct(low), width: `calc(${pct(high)} - ${pct(low)})` } as CSSProperties} />
            <i className="core" style={{ left: pct(zero), width: `calc(${pct(full)} - ${pct(zero)})` } as CSSProperties} />
          </span>
          <span className="v muted">{hp ? "—" : low}</span>
          <span className="v">{zero}</span>
          <span className="v">{full}</span>
          <span className="v top">{hp ? "—" : high}</span>
        </div>
      ))}
    </section>
  );
}

function TypeGroups({ groups }: { groups: Array<[MsgKey, TypeName[]]> }) {
  const t = useT();
  return (
    <div className="dx-mgroups">
      {groups.map(([key, list]) => (
        <div className={`dx-mg${list.length ? "" : " none"}`} key={key}>
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

/** What hits this Pokémon how hard, and what its own-type moves hit. */
function Matchups({ types }: { types: TypeName[] }) {
  const t = useT();
  const def = defensiveProfile(types);
  const off = offensiveProfile(types);
  return (
    <section className="mc-panel dx-matchup">
      <div className="mc-head"><h3>{t("detail.matchup")}</h3></div>
      <div className="dx-matchup-cols">
        <div>
          <span className="dx-sub">{t("matchup.defTitle")}</span>
          <TypeGroups groups={[["matchup.x4", def.x4], ["matchup.x2", def.x2], ["matchup.x05", def.x05],
            ["matchup.x025", def.x025], ["matchup.x0", def.x0]]} />
        </div>
        <div>
          <span className="dx-sub">{t("matchup.offTitle")}
            <span className="dx-stab">{types.map((tp) => <TypeBadge key={tp} type={tp} iconOnly />)}</span>
          </span>
          <TypeGroups groups={[["matchup.off.x2", off.x2], ["matchup.off.x05", off.x05], ["matchup.off.x0", off.x0]]} />
        </div>
      </div>
    </section>
  );
}

type CategoryFilter = "all" | MoveCategory;

function Learnset({ slug }: { slug: string }) {
  const t = useT();
  const { lang } = useLang();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const learnset = useAsync<LearnsetDto>(() => loadLearnset(slug), [slug]);

  const moves = useMemo(() => {
    if (learnset.status !== "ready") return [];
    const raw = query.trim();
    const q = raw.toLowerCase();
    return learnset.data.moves.filter((m) => (category === "all" || m.category === category) && (!q
      || m.name.toLowerCase().includes(q) || (m.nameZh?.includes(raw) ?? false)
      || (m.nameJa?.includes(raw) ?? false) || m.type.toLowerCase() === q));
  }, [learnset, query, category]);

  return (
    <section className="mc-panel dx-learnset">
      <div className="mc-head">
        <h3>{t("detail.learnset")}</h3>
        {learnset.status === "ready" && (
          <span className="mc-head-note num">{moves.length} / {learnset.data.moves.length}</span>
        )}
      </div>
      <div className="dx-learn-tools">
        <input type="search" value={query} placeholder={t("learnset.search")}
          onChange={(e) => setQuery(e.target.value)} aria-label={t("learnset.search")} />
        <SegmentedControl kind="radio" value={category} onChange={setCategory} className="seg"
          ariaLabel={t("dex.category")}
          items={[{ id: "all" as CategoryFilter, label: t("dx.all") },
            ...MOVE_CATEGORIES.map((id) => ({ id: id as CategoryFilter, label: t(`category.${id}` as MsgKey) }))]} />
        <span className="dx-learn-legend" aria-hidden>{t("dex.power")}<i>·</i>{t("dex.accuracy")}</span>
      </div>
      {learnset.status === "loading" && <div className="spinner">{t("state.loading")}</div>}
      {learnset.status === "ready" && (
        <div className="dx-learn-grid">
          {moves.map((m) => (
            <EntityHover key={m.name} kind="move" name={m.name}>
              <span className="dx-move">
                <span className="dx-move-name">
                  <TypeBadge type={m.type} iconOnly />
                  <CategoryBadge category={m.category} />
                  <span className="nm">{displayName(m, lang)}</span>
                </span>
                <span className="num">{m.power ?? "—"}</span>
                <span className="num">{m.accuracy == null ? "—" : m.accuracy}</span>
              </span>
            </EntityHover>
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
  const railState = useSideRail(360, "dex");
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
  const toMeta = (format: FormatId) => {
    const ranking = format === "single" ? singleRanking : doubleRanking;
    const baseSlug = ranking.status === "ready"
      ? ranking.data.rows.find((row) => row.name === rankingName)?.slug : undefined;
    navigate(`/meta/${baseSlug ?? mon.slug}?format=${format}`);
  };

  /** Every form of this species, base first, offered in the hero's own title — the same control the
   * meta detail page uses.
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
  const forms: MetaForm[] | undefined = siblings.length > 1
    ? siblings.map((f) => ({
        key: f.slug, label: displayName(f, lang), assetKey: f.key, active: f.slug === mon.slug,
        onSelect: () => navigate(`/pokemon/${f.slug}`),
      }))
    : undefined;

  return (
    <>
      {rail}
      <div className="mc-page">
        <article className="mc-card dx-card" style={accentStyle(mon)}>
          <div className="mc-strip" />
          <MetaHero mon={mon} forms={forms} rank={null} ranks={ranks} format={null} onFormat={toMeta}
            rankTitle={(format) => t("dx.toMeta").replace("{format}", t(`format.${format}`))}
            abilities={<Abilities mon={mon} />} />
          <div className="dx-grid">
            <ActualStats mon={mon} />
            <Matchups types={mon.types} />
            <Learnset slug={mon.slug} />
          </div>
        </article>
      </div>
    </>
  );
}
