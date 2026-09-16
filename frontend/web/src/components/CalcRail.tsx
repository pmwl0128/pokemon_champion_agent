/** Calculator-wide Pokemon rail.
 *
 * Search and filtering are the exact DexRail Pokemon axis. A result name is an accordion trigger;
 * only that row's environment builds are fetched and rendered. This keeps the rail cheap while the
 * calculator is busy: typing touches this component tree, not any damage/speed/tune input state. */
import type { FormatId } from "@pokemon-champions/protocol";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { BuildSetSummary } from "./BuildPicker.tsx";
import {
  DexRail, pokemonMatches, type DexFilters,
} from "./DexRail.tsx";
import type { RailState } from "./SideRail.tsx";
import { useLearners } from "../hooks.ts";
import { displayName, useLang, useT } from "../i18n.ts";
import type { DexIndexEntry } from "../runtime/adapter.ts";
import { useBuildOptions, type BuildOption } from "../pages/calc/shared.tsx";

export type CalcRailTab = "damage" | "speed" | "tune";
export type CalcRailTarget = "primary" | "secondary";

export interface CalcRailPickResult {
  ok: boolean;
  reason?: "full";
}

export interface CalcRailApi {
  format: FormatId;
  targets: readonly [
    { id: "primary"; label: string },
    { id: "secondary"; label: string },
  ];
  pick: (
    target: CalcRailTarget,
    entry: DexIndexEntry,
    option: BuildOption | null,
    optionIndex: number,
  ) => CalcRailPickResult;
}

const freshFilters = (): DexFilters => ({
  pokemon: { types: new Set(), ability: null, moves: [], stats: {} },
  moves: {
    types: new Set(), categories: new Set(), power: {}, accuracy: {}, pp: {},
    priorities: new Set(),
  },
  items: { categories: new Set() },
});

export function CalcRail({ state, dex, tab, api }: {
  state: RailState;
  dex: DexIndexEntry[];
  tab: CalcRailTab;
  api: CalcRailApi | undefined;
}) {
  const t = useT();
  const { lang } = useLang();
  const loadOptions = useBuildOptions();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [filters, setFilters] = useState<DexFilters>(freshFilters);
  const [expandedSlug, setExpandedSlug] = useState("");
  const [targetByTab, setTargetByTab] = useState<Record<CalcRailTab, CalcRailTarget>>({
    damage: "primary", speed: "primary", tune: "primary",
  });
  const [loaded, setLoaded] = useState<{
    slug: string;
    format: FormatId;
    status: "loading" | "ready" | "error";
    options: BuildOption[];
  } | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const target = targetByTab[tab];
  const learners = useLearners(filters.pokemon.moves.length > 0 || state.open);
  const learnerTable = learners.status === "ready" && learners.data ? learners.data.moves : null;

  const rows = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const sets = filters.pokemon.moves.length > 0
      ? (learnerTable
        ? filters.pokemon.moves.map((move) => new Set(learnerTable[move] ?? []))
        : null)
      : [];
    if (sets === null) return [];
    return dex.filter((entry) => pokemonMatches(entry, filters.pokemon, sets) && (
      !needle
      || entry.name.toLowerCase().includes(needle)
      || (entry.nameZh?.includes(deferredQuery.trim()) ?? false)
      || (entry.nameJa?.includes(deferredQuery.trim()) ?? false)
      || entry.slug.includes(needle)
      || String(entry.nationalDex) === needle
    ));
  }, [dex, deferredQuery, filters.pokemon, learnerTable]);

  useEffect(() => {
    if (!expandedSlug || !api) { setLoaded(null); return; }
    let current = true;
    const format = api.format;
    setLoaded({ slug: expandedSlug, format, status: "loading", options: [] });
    void loadOptions(expandedSlug, format).then((options) => {
      if (current) setLoaded({ slug: expandedSlug, format, status: "ready", options });
    }).catch((error) => {
      console.error("calculator rail build load failed:", error);
      if (current) setLoaded({ slug: expandedSlug, format, status: "error", options: [] });
    });
    return () => { current = false; };
    // `useBuildOptions` owns stable request caches; accordion identity and format are the only
    // request keys. Omitting its render-local function identity prevents duplicate fetch effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedSlug, api?.format]);

  useEffect(() => { setFeedback(null); }, [tab, target]);

  const choose = (entry: DexIndexEntry, option: BuildOption | null, optionIndex: number) => {
    if (!api) return;
    const result = api.pick(target, entry, option, optionIndex);
    const side = api.targets.find((candidate) => candidate.id === target)?.label ?? "";
    setFeedback(result.ok
      ? { ok: true, text: t("calc.rail.added")
        .replace("{name}", displayName(entry, lang)).replace("{side}", side) }
      : { ok: false, text: t("calc.rail.full").replace("{side}", side) });
  };

  const expansion = (entry: DexIndexEntry) => {
    const exact = loaded?.slug === entry.slug && loaded.format === api?.format ? loaded : null;
    return (
      <div className="calc-rail-builds">
        {exact?.status === "loading" && <div className="build-picker-state">{t("state.loading")}</div>}
        {exact?.status === "error" && <div className="build-picker-state">{t("state.errorDetail")}</div>}
        {exact?.status === "ready" && exact.options.map((option, index) => (
          <button type="button" className="build-card" key={option.key}
            onClick={() => choose(entry, option, index)}>
            <BuildSetSummary option={option} index={index} />
          </button>
        ))}
        <button type="button" className="build-card calc-rail-custom"
          onClick={() => choose(entry, null, -1)}>
          {t("calc.rail.custom")}
        </button>
      </div>
    );
  };

  const switcher = api ? (
    <div className="calc-rail-target" role="group" aria-label={t("calc.rail.target")}>
      {api.targets.map((candidate) => (
        <button type="button" key={candidate.id}
          className={target === candidate.id ? "on" : ""}
          aria-pressed={target === candidate.id}
          onClick={() => setTargetByTab((prev) => ({ ...prev, [tab]: candidate.id }))}>
          {candidate.label}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <DexRail state={state} tab="pokemon" query={query} setQuery={setQuery}
      filters={filters} setFilters={setFilters} learners={learnerTable} priorities={[]}
      rows={rows} label={t("calc.rail.title")} count={rows.length}
      headActions={switcher} expandedSlug={expandedSlug}
      onPokemonClick={(entry) => {
        setFeedback(null);
        setExpandedSlug((current) => current === entry.slug ? "" : entry.slug);
      }}
      renderPokemonExpansion={expansion}
      status={feedback && (
        <div className={`calc-rail-feedback ${feedback.ok ? "ok" : "error"}`} role="status">
          {feedback.text}
        </div>
      )} />
  );
}
