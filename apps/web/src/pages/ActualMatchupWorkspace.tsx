import type {
  ActualDamageFactDto, ActualMatchupCellDto, ActualMatchupResponseDto, FormatId, SpeciesRowDto,
} from "@pokemon-champions/protocol";
import { ActualMatchupResponseDtoSchema } from "@pokemon-champions/protocol";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EntityHover } from "../components/EntityHover.tsx";
import { GameImage } from "../components/GameImage.tsx";
import { SegmentedControl } from "../components/SegmentedControl.tsx";
import {
  useAbilities, useDexByName, useDexIndex, useItems, useMoves, useNatures, useOppCache,
} from "../hooks.ts";
import { displayName, useLang, useT, type Lang } from "../i18n.ts";
import { useDamageText } from "../lib/damageText.tsx";
import { koTone } from "../lib/ko.ts";
import {
  readMatchupSources, readTeamMembers, stashDamageFill, takeMatchupFill,
  type MatchupTeamSource, type TeamMemberish,
} from "../lib/team.ts";
import { CellInspector, SetBlock, type InspectorDamage } from "../components/CellInspector.tsx";
import { activeKey, ColHead } from "../components/MatchupHeads.tsx";
import { useRuntime } from "../runtime/context.tsx";
import { slugify } from "./uep/MonChip.tsx";


/** The skill emits the lossless canonical key and the bridge deliberately preserves it. */
const variantKey = (cell: { opponent_variant?: string }, fallback: string): string =>
  cell.opponent_variant ?? fallback;

type InputMode = "manual" | "text" | "recent";
type ResultView = "check" | "ko";
type Spread = Record<"hp" | "atk" | "def" | "spa" | "spd" | "spe", number>;
interface DraftMember extends TeamMemberish { id: string; spread: Spread; moves: string[] }
interface NamedOption { name: string; nameZh?: string; nameJa?: string }
interface ActualVocab {
  species: NamedOption[]; moves: NamedOption[]; items: NamedOption[];
  abilities: NamedOption[]; natures: NamedOption[];
}

/** Browser-session continuity, mirroring the wizard and the diagnose tab: a matchup battery is a
 * minute-scale server round trip, and the parent unmounts this whole workspace whenever the user
 * switches to the KO/check matrices, so an un-stashed result was silently thrown away. Draft input
 * is stashed too — retyping six sets to re-run is the more expensive half of the loss. */
const STORE_KEY = "pc-actual-matchup-v1";

interface Stash {
  mode?: InputMode;
  members?: DraftMember[];
  text?: string;
  topK?: number;
  response?: unknown;
}

function readStash(): Stash {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "{}") as Stash;
  } catch {
    return {};
  }
}

function writeStash(s: Stash): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch { /* storage blocked — continuity just won't survive navigation */ }
}

/** The in-flight battery, held OUTSIDE React (same shape as the diagnose tab's active task).
 * Stashing the RESULT was only half the fix: a battery runs for minutes and switching to the KO or
 * check matrix unmounts this whole workspace, so a run still in flight had every `setState` after
 * its await turn into a no-op and its result was dropped. Module scope outlives the unmount, so the
 * result reaches the stash regardless and a remount re-attaches to the same promise. */
interface ActiveBatteryTask {
  promise: Promise<ActualMatchupResponseDto>;
}
let activeBatteryTask: ActiveBatteryTask | null = null;

const EMPTY_SPREAD: Spread = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
const STATS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;
const TOP_K_PRESETS = [8, 20, 30, 50, 60] as const;

function newMember(seed?: TeamMemberish, index = 0): DraftMember {
  return {
    id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
    species: seed?.species ?? "",
    item: seed?.item ?? "",
    ability: seed?.ability ?? "",
    nature: seed?.nature ?? "",
    moves: [...(seed?.moves ?? []), "", "", "", ""].slice(0, 4),
    spread: { ...EMPTY_SPREAD, ...(seed?.spread ?? {}) },
  };
}

function membersFromTeam(team: unknown): DraftMember[] {
  return readTeamMembers(team).map((member, index) => newMember(member, index));
}

function teamFromMembers(format: FormatId, members: DraftMember[]) {
  return {
    schema_version: 1, format, season: null, rule: null,
    pokemon: members.filter((member) => member.species.trim()).map((member) => ({
      species: member.species.trim(), item: member.item?.trim() || null,
      ability: member.ability?.trim() || null, nature: member.nature?.trim() || null,
      moves: member.moves.map((move) => move.trim()).filter(Boolean).slice(0, 4),
      spread: member.spread, tera: null, completeness: "extracted_set",
    })),
    provenance: null,
  };
}

function localizedOption(row: { name: string; nameZh?: string; nameJa?: string }, lang: string) {
  return lang === "zh" ? row.nameZh ?? row.name : lang === "ja" ? row.nameJa ?? row.name : row.name;
}

function useActualVocab(): ActualVocab {
  const dex = useDexIndex();
  const moves = useMoves();
  const items = useItems();
  const abilities = useAbilities();
  const natures = useNatures();
  return useMemo(() => ({
    species: dex.status === "ready" ? dex.data : [],
    moves: moves.status === "ready" ? moves.data : [],
    items: items.status === "ready" ? items.data : [],
    abilities: abilities.status === "ready" ? abilities.data : [],
    natures: natures.status === "ready" ? natures.data : [],
  }), [dex, moves, items, abilities, natures]);
}

function displayInputValue(rows: NamedOption[], value: string, lang: Lang): string {
  const row = rows.find((entry) => entry.name === value
    || entry.nameZh === value || entry.nameJa === value);
  return row ? localizedOption(row, lang) : value;
}

function canonicalInputValue(rows: NamedOption[], value: string): string {
  return rows.find((entry) => entry.name === value
    || entry.nameZh === value || entry.nameJa === value)?.name ?? value;
}

function LocalizedInput({ list, rows, value, onChange, placeholder }: {
  list: string; rows: NamedOption[]; value: string;
  onChange: (value: string) => void; placeholder?: string;
}) {
  const { lang } = useLang();
  return <input list={list} value={displayInputValue(rows, value, lang)}
    onChange={(event) => onChange(canonicalInputValue(rows, event.target.value))}
    placeholder={placeholder} />;
}

function VocabLists({ vocab }: { vocab: ActualVocab }) {
  const { lang } = useLang();
  const options = (id: string, rows: NamedOption[]) => (
    <datalist id={id}>{rows.map((row) => {
      const display = localizedOption(row, lang);
      return <option key={row.name} value={display}>{display === row.name ? "" : row.name}</option>;
    })}</datalist>
  );
  return <>
    {options("actual-species-options", vocab.species)}
    {options("actual-move-options", vocab.moves)}
    {options("actual-item-options", vocab.items)}
    {options("actual-ability-options", vocab.abilities)}
    {options("actual-nature-options", vocab.natures)}
  </>;
}

function MemberEditor({ member, index, count, vocab, onChange, onRemove, onDuplicate }: {
  member: DraftMember; index: number; count: number;
  vocab: ActualVocab;
  onChange: (next: DraftMember) => void; onRemove: () => void; onDuplicate: () => void;
}) {
  const t = useT();
  const dex = useDexByName();
  const { lang } = useLang();
  const entry = dex.get(member.species);
  const name = entry ? displayName(entry, lang) : member.species || t("actual.member.empty");
  return (
    <article className="actual-member-card">
      <header className="actual-member-head">
        <span className="actual-member-index num">{String(index + 1).padStart(2, "0")}</span>
        {entry && <GameImage assetKey={`pokemon:${entry.slug}`} role="dense" alt="" className="mini" />}
        <strong>{name}</strong>
        <span className="actual-member-actions">
          <button type="button" className="linkish" onClick={onDuplicate}>{t("actual.duplicate")}</button>
          <button type="button" className="linkish" onClick={onRemove} disabled={count === 1}>{t("actual.remove")}</button>
        </span>
      </header>
      <div className="actual-member-fields">
        <label className="actual-species-field"><span>{t("actual.species")}</span>
          <LocalizedInput list="actual-species-options" rows={vocab.species} value={member.species}
            onChange={(value) => onChange({ ...member, species: value })}
            placeholder={t("actual.speciesHint")} /></label>
        <label><span>{t("actual.item")}</span><LocalizedInput list="actual-item-options"
          rows={vocab.items} value={member.item ?? ""}
          onChange={(value) => onChange({ ...member, item: value })} /></label>
        <label><span>{t("actual.ability")}</span><LocalizedInput list="actual-ability-options"
          rows={vocab.abilities} value={member.ability ?? ""}
          onChange={(value) => onChange({ ...member, ability: value })} /></label>
        <label><span>{t("actual.nature")}</span><LocalizedInput list="actual-nature-options"
          rows={vocab.natures} value={member.nature ?? ""}
          onChange={(value) => onChange({ ...member, nature: value })} /></label>
      </div>
      <div className="actual-moves">
        {member.moves.map((move, moveIndex) => <label key={moveIndex}>
          <span>{t("actual.move").replace("{n}", String(moveIndex + 1))}</span>
          <LocalizedInput list="actual-move-options" rows={vocab.moves} value={move} onChange={(value) => {
            const moves = [...member.moves]; moves[moveIndex] = value;
            onChange({ ...member, moves });
          }} /></label>)}
      </div>
      <fieldset className="actual-spread"><legend>{t("actual.spread")}</legend>
        {STATS.map((stat) => <label key={stat}><span>{t(`stat.${stat}`)}</span>
          <input className="num" type="number" min={0} max={32} value={member.spread[stat]}
            onChange={(e) => onChange({ ...member, spread: {
              ...member.spread, [stat]: Math.max(0, Math.min(32, Number(e.target.value) || 0)),
            } })} /></label>)}
        <span className={`actual-sp-total num${Object.values(member.spread).reduce((a, b) => a + b, 0) > 66 ? " over" : ""}`}>
          {t("actual.spTotal").replace("{n}", String(Object.values(member.spread).reduce((a, b) => a + b, 0)))}</span>
      </fieldset>
    </article>
  );
}

function RecentSources({ sources, onUse }: {
  sources: MatchupTeamSource[]; onUse: (source: MatchupTeamSource) => void;
}) {
  const t = useT();
  const dex = useDexByName();
  const { lang } = useLang();
  if (!sources.length) return <div className="actual-empty-state">
    <span className="actual-empty-mark" aria-hidden>↗</span>
    <strong>{t("actual.recentEmpty")}</strong><p>{t("actual.recentEmptyHint")}</p>
  </div>;
  return <div className="actual-source-grid">{sources.map((source) => {
    const members = readTeamMembers(source.team);
    return <button type="button" className="actual-source-card" key={source.id} onClick={() => onUse(source)}>
      <span className="actual-source-meta"><b>{source.label}</b><span>{t(`format.${source.format}`)} · {members.length}</span></span>
      <span className="actual-source-party">{members.map((member, index) => {
        const row = dex.get(member.species);
        return <span key={`${member.species}-${index}`} title={row ? displayName(row, lang) : member.species}>
          <GameImage assetKey={`pokemon:${row?.slug ?? slugify(member.species)}`} role="dense" alt="" className="mini" />
        </span>;
      })}</span>
      <span className="actual-source-use">{t("actual.useSource")} →</span>
    </button>;
  })}</div>;
}

/** Same markup as the reference grids' DetailMon (sprite + localized name in one hover chip), so a
 * cell inspector looks the same wherever it was opened. */
function DetailMon({ name, lang }: { name: string; lang: string }) {
  const dex = useDexByName();
  const row = dex.get(name);
  return (
    <EntityHover kind="pokemon" name={name}>
      <span className="prose-mon">
        <GameImage assetKey={`pokemon:${row?.slug ?? slugify(name)}`} role="dense" alt=""
                   className="prose-mon-img" />
        {row ? displayName(row, lang as Parameters<typeof displayName>[1]) : name}
      </span>
    </EntityHover>
  );
}

function Elapsed() {
  const t = useT();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="num">{t("actual.elapsed").replace("{n}", String(seconds))}</span>;
}

/** An actual-battery damage fact in the inspector's shape.
 *
 * The skill emits snake_case; `damageText.ko` reads camelCase, so `chance_pct` silently never
 * reached it and every uncertain kill lost its percentage. It also prefers the engine's
 * recovery-aware verdict over the static rolls: Leftovers turns a static 2HKO into an 87.5%
 * chance, and the grade is computed from that number — labelling the same cell 确2 contradicted it.
 */
function actualDamage(fact: ActualDamageFactDto | null | undefined,
                      t: (k: never) => string): InspectorDamage | null {
  if (!fact) return null;
  const rich = fact.ko_chance;
  const g = fact.ko_guaranteed, p = fact.ko_possible;
  const staticGuaranteed = g != null && (p == null || g === p);
  const ko = rich
    ? { text: rich.text, n: rich.n ?? p ?? g, guaranteed: rich.guaranteed ?? staticGuaranteed,
        chancePct: rich.chance_pct }
    : { text: fact.ko, n: staticGuaranteed ? g : (p ?? g), guaranteed: staticGuaranteed };
  const caveats = fact.ko_exact === false ? [t("matchup.staticApprox" as never)] : [];
  return { move: fact.move, minPercent: fact.min_percent, maxPercent: fact.max_percent,
           ko, caveats };
}

/** The member's own registered set, in the shape SetBlock renders. */
function sourceAsSet(source: TeamMemberish | null | undefined,
                     row: { member_run_form?: string | null; member: string }) {
  if (!source) return undefined;
  return {
    species: row.member, runForm: row.member_run_form ?? null,
    ability: source.ability ?? null, item: source.item ?? null, nature: source.nature ?? null,
    moves: (source.moves ?? []).filter(Boolean),
    sps: (source.spread ?? null) as Record<string, number> | null,
  };
}

function koTurns(fact: ActualDamageFactDto | null): { turns: number | null; certain: boolean } {
  if (!fact) return { turns: null, certain: false };
  // Prefer the recovery-aware verdict over the static rolls. A defender holding Leftovers can turn
  // a static 2HKO into an 87.5% chance, and the check grade already treats that kill as uncertain —
  // labelling the same cell 确2 made the two tables contradict each other.
  const chance = (fact as { ko_chance?: { n?: number; guaranteed?: boolean } }).ko_chance;
  if (chance && (chance.guaranteed != null || chance.n != null)) {
    return { turns: chance.n ?? fact.ko_possible ?? null, certain: chance.guaranteed === true };
  }
  const guaranteed = fact.ko_guaranteed ?? null;
  const possible = fact.ko_possible ?? null;
  const certain = guaranteed != null && (possible == null || possible === guaranteed);
  return { turns: certain ? guaranteed : possible, certain };
}

function ActualResult({ response, format, sourceTeam }: {
  response: ActualMatchupResponseDto; format: FormatId; sourceTeam: unknown;
}) {
  const t = useT();
  const { lang } = useLang();
  const navigate = useNavigate();
  const dex = useDexByName();
  const damageText = useDamageText();
  const opp = useOppCache(format);
  const sets = opp.status === "ready" ? opp.data.sets : undefined;
  const [view, setView] = useState<ResultView>("ko");
  // Which side is ATTACKING. Both directions are already computed per cell (`offense` = ours,
  // `incoming` = theirs), so this is a pure re-read — no second request, no second table. A second
  // table would also be the wrong shape here: sources are few and targets many, so the transpose
  // is very tall and very narrow.
  const [dir, setDir] = useState<"out" | "in">("out");
  const [selected, setSelected] = useState<{ sourceId: string; cellId: string } | null>(null);
  // Which BUILD each opponent column is read as, keyed by dex slug — same model as the reference
  // grids. A ranked opponent expands into one cell per real build; showing them as adjacent columns
  // made the table several times wider and buried the species, so one species is one column and the
  // head switches which of its builds that column shows.
  const [colPicks, setColPicks] = useState<Record<string, string>>({});
  const [openCol, setOpenCol] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const result = response.result;
  const targets = result.members[0]?.cells ?? [];
  const byTarget = useMemo(() => new Map(result.members.map((row) =>
    [row.source_id, new Map(row.cells.map((c) => [c.target_id, c]))])), [result]);
  // One column per SPECIES; its builds become the head's switchable options. Order follows the
  // backend's usage-rank order of first appearance.
  const columns = useMemo(() => {
    const roster = new Map((opp.status === "ready" ? opp.data.species : []).map((r) => [r.slug, r]));
    const at = new Map<string, number>();
    const out: { slug: string; row: SpeciesRowDto; cells: ActualMatchupCellDto[] }[] = [];
    for (const target of targets) {
      const dexRow = dex.get(target.opponent);
      const slug = dexRow?.slug ?? slugify(target.opponent);
      const seen = at.get(slug);
      if (seen != null) { out[seen]!.cells.push(target); continue; }
      at.set(slug, out.length);
      const base = roster.get(slug);
      out.push({
        slug, cells: [target],
        row: base ?? {
          rank: target.usage_rank ?? null, slug, name: target.opponent,
          nameZh: dexRow?.nameZh, nameJa: dexRow?.nameJa, realTeamBacked: false,
        },
      });
    }
    // Offer only the builds this battery actually computed — the cache may know builds that were
    // never run here, and a head listing one would switch the column to an empty cell.
    // Both sides use the skill's lossless canonical variant id unchanged.
    return out.map((c) => {
      const known = new Map((roster.get(c.slug)?.variants ?? []).map((v) => [v.key, v]));
      const variants = c.cells.map((cell) => {
        const key = variantKey(cell, c.slug);
        return known.get(key) ?? {
          key, isModal: cell.opponent_is_modal ?? c.cells.length === 1,
          item: cell.opponent_cluster?.item ?? null,
          ability: cell.opponent_cluster?.ability ?? null,
          runForm: cell.opponent_run_form ?? undefined,
          coverage: null,
        };
      });
      return { ...c, row: { ...c.row, variants } };
    });
  }, [targets, opp, dex]);
  const selectedRow = selected ? result.members.find((row) => row.source_id === selected.sourceId) : null;
  const cell = selectedRow?.cells.find((item) => item.cell_id === selected?.cellId) ?? null;
  // The inspector shows whichever direction the grid is showing.
  const detailCheck = cell ? (dir === "in" ? cell.reverse_check : cell.check) : null;
  const source = selectedRow ? readTeamMembers(sourceTeam)[selectedRow.source_index] : null;
  const selectedMemberName = selectedRow?.member_run_form ?? selectedRow?.member;
  useEffect(() => {
    if (!selected) return;
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    }));
  }, [selected]);

  const mon = (name: string) => {
    const row = dex.get(name);
    return { row, slug: row?.slug ?? slugify(name), label: row ? displayName(row, lang) : name };
  };
  return <section className="actual-results" aria-live="polite">
    <div className="actual-results-head">
      <div><span className="eyebrow">{t("actual.resultEyebrow")}</span><h2>{t("actual.resultTitle")}</h2>
        <p>{t("actual.resultScope").replace("{sources}", String(result.source_count)).replace("{targets}", String(result.top_k))}</p></div>
      <div className="actual-result-tools">
        <span className={`actual-complete ${result.coverage.complete ? "ok" : "warn"}`}>
          {result.coverage.complete ? "✓" : "!"} {t(result.coverage.complete ? "actual.complete" : "actual.partial")}</span>
        <SegmentedControl kind="radio" value={view} onChange={setView} ariaLabel={t("actual.resultView")} className="seg"
          items={[{ id: "ko", label: t("matchup.ko") }, { id: "check", label: t("matchup.check") }]} />
      </div>
    </div>
    <div className="matchup-scroll actual-grid-scroll"><table className="matchup-grid actual-grid">
      {/* A check GRADE already folds both directions in (C2 = survives the switch-in AND kills), so
        * the direction toggle belongs to the KO view only. Layout stays members-as-rows in both
        * directions: a real transpose would be very tall and very narrow (few sources, many targets),
        * so only the damage fact being read changes. */}
      <thead><tr><th className="corner corner-swap">
        {/* Applies to BOTH views: on KO it picks which damage fact to read, on the check view it
          * reads the reverse grade (can the opponent answer US) — two different, both-valid
          * readings. Layout stays members-as-rows either way; a real transpose here would be very
          * tall and very narrow (few sources, many targets). */}
        <button type="button" className="dir-swap"
                onClick={() => { setDir((d) => d === "out" ? "in" : "out"); setSelected(null); }}
                title={t("actual.swapHint")} aria-label={t("actual.swap")}>
          <span className="dir-side">{t(dir === "out" ? "matchup.member" : "matchup.opponent")}</span>
          <span className="dir-arrow" aria-hidden>⇄</span>
          <span className="dir-side">{t(dir === "out" ? "matchup.opponent" : "matchup.member")}</span>
        </button>
      </th>
        {columns.map((col) => <ColHead key={col.slug} s={col.row} lang={lang} picks={colPicks}
          open={openCol === col.slug}
          onToggle={() => setOpenCol((k) => (k === col.slug ? null : col.slug))}
          onClose={() => setOpenCol(null)}
          onPick={(key) => { setColPicks((m) => ({ ...m, [col.slug]: key })); setSelected(null); }} />)}
      </tr></thead>
      <tbody>{result.members.map((row) => { const info = mon(row.member_run_form ?? row.member); return <tr key={row.source_id}>
        <th className="row-head" title={row.member_run_form ? `${row.member} → ${info.label}` : info.label}><span className="row-head-inner">
          <GameImage assetKey={`pokemon:${info.slug}`} role="dense" alt="" className="mini" />
          {/* No MEGA badge: the battery substitutes the Mega form silently, so `info.label` ALREADY
            * names it. Badging it again is a marker the reference grids don't carry. */}
          <span className="nm">{info.label}</span>
          </span></th>
        {columns.map((col) => {
          // Read the build this column is switched to, then index BY TARGET, never by array
          // position: the column set comes from members[0], so a row missing one cell (an
          // uncomputable pair) used to shift every later cell one column left and silently
          // mislabel the whole rest of that row.
          const key = activeKey(col.row, colPicks);
          const target = col.cells.find((c) => variantKey(c, col.slug) === key) ?? col.cells[0];
          const item = target && byTarget.get(row.source_id)?.get(target.target_id);
          if (!item) return <td key={col.slug} className="ko-none" />;
          const on = selected?.cellId === item.cell_id;
          const activeCheck = dir === "in" ? item.reverse_check : item.check;
          const grade = activeCheck?.grade;
          const wall = grade === "C0" && activeCheck?.c0_kind === "wall_no_ko";
          const contested = !!activeCheck?.contested;
          // Both directions are computed per cell; the swap only chooses which one to read.
          const dmg = dir === "in" ? item.incoming : item.offense;
          const ko = koTurns(dmg);
          const tone = koTone(ko.turns, ko.certain, dmg?.max_percent ?? null);
          const label = view === "check" ? grade ?? "" : ko.turns == null ? "" : ko.certain
            ? lang === "en" ? String(ko.turns) : lang === "ja" ? `確${ko.turns}` : `确${ko.turns}`
            : lang === "en" ? `~${ko.turns}` : `乱${ko.turns}`;
          const cls = view === "check" ? (grade ? `grade-${grade}` : "ko-none") : `ko-${tone}`;
          return <td key={col.slug}
            className={`${cls}${view === "check" && wall ? " wall" : ""}${view === "check" && contested ? " contested" : ""}${on ? " on" : ""}`}
            title={view === "check" && contested ? t("matchup.contested") : undefined}
            role="button" tabIndex={0}
            aria-pressed={on} onClick={() => setSelected({ sourceId: row.source_id, cellId: item.cell_id })}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") {
              e.preventDefault(); setSelected({ sourceId: row.source_id, cellId: item.cell_id });
            } }}>{label}</td>;
        })}</tr>; })}</tbody>
    </table></div>
    {view === "check" ? <div className="legend"><span className="chip grade-C2">C2</span><span className="muted">{t("matchup.c2")}</span>
      <span className="chip grade-C1">C1</span><span className="muted">{t("matchup.c1")}</span>
      <span className="chip grade-C0">C0</span><span className="muted">{t("matchup.c0")}</span></div>
      : <div className="legend"><span className="muted">{t("matchup.koLegend")}:</span>{["ohkoG", "2hko", "3hko", "4hko", "slow"].map((tone, i) =>
        <span key={tone} className={`chip ko-${tone}`}>{i === 0 ? "OHKO" : i === 4 ? "5+" : `${i + 1}HKO`}</span>)}</div>}
    {cell && selectedRow && (() => {
      const ours = mon(selectedMemberName!), theirs = mon(cell.opponent);
      const targetSet = sets?.[variantKey(cell, theirs.slug)];
      const dirs = [
        { label: t("matchup.ourKo"), damage: actualDamage(cell.offense, t) },
        { label: t("matchup.incoming"), damage: actualDamage(cell.incoming, t) },
      ];
      return (
        <CellInspector
          panelRef={detailRef}
          head={<><DetailMon name={dir === "in" ? cell.opponent : selectedMemberName!} lang={lang} />
                 <span>→</span>
                 <DetailMon name={dir === "in" ? selectedMemberName! : cell.opponent} lang={lang} /></>}
          grade={view === "check" ? detailCheck?.grade ?? null : null}
          gradeFacts={view === "check" ? ([
            detailCheck?.c0_kind === "wall_no_ko"
              ? <>· {t("matchup.c0Kind.wall_no_ko")}</> : null,
            detailCheck?.contested ? <>· {t("matchup.resolvability.contested")}</> : null,
          ].filter(Boolean) as ReactNode[]) : undefined}
          // The direction being viewed reads first.
          directions={dir === "in" ? [dirs[1]!, dirs[0]!] : dirs}
          speed={dir === "in"
            ? { mine: cell.speed.opponent, theirs: cell.speed.member,
                faster: cell.speed.faster === "member" ? "opponent"
                  : cell.speed.faster === "opponent" ? "member" : cell.speed.faster }
            : { mine: cell.speed.member, theirs: cell.speed.opponent,
                faster: cell.speed.faster }}
          sets={
            <>
              <div className="md-line md-caveat">
                {t("actual.actualSetNote")}
                <button type="button" className="second-btn md-verify" onClick={() => {
                  const ourSet = { slug: ours.slug,
                    ...(source?.ability && !selectedRow.member_run_form ? { ability: source.ability } : {}),
                    ...(source?.item ? { item: source.item } : {}),
                    ...(source?.nature ? { nature: source.nature } : {}),
                    ...(source?.spread ? { sps: source.spread } : {}) };
                  const theirSet = { slug: theirs.slug,
                    ...(targetSet?.ability ? { ability: targetSet.ability } : {}),
                    ...(targetSet?.item ? { item: targetSet.item } : {}),
                    ...(targetSet?.nature ? { nature: targetSet.nature } : {}),
                    ...(targetSet?.sps ? { sps: targetSet.sps } : {}) };
                  const incoming = cell.incoming;
                  stashDamageFill(dir === "in"
                    ? { format, attackerSlug: theirs.slug, attacker: theirSet, defender: ourSet,
                        ...(incoming?.move ? { move: incoming.move } : {}) }
                    : { format, attackerSlug: ours.slug, attacker: ourSet, defender: theirSet,
                        ...(cell.offense?.move ? { move: cell.offense.move } : {}) });
                  navigate("/calc?tab=damage");
                }}>{t("builder.verifyCalc")}</button>
              </div>
              {/* Both sides' sets, the same block the reference grids show. */}
              <div className="md-sets">
                <SetBlock title={ours.label} set={sourceAsSet(source, selectedRow)} />
                <SetBlock title={theirs.label} set={targetSet} />
              </div>
            </>
          }
        />
      );
    })()}
  </section>;
}

export function ActualMatchupWorkspace({ format, onFormatChange }: {
  format: FormatId; onFormatChange: (format: FormatId) => void;
}) {
  const t = useT();
  const { adapter } = useRuntime();
  const vocab = useActualVocab();
  const stash = useMemo(readStash, []);
  const [mode, setMode] = useState<InputMode>(stash.mode ?? "manual");
  const [members, setMembers] = useState<DraftMember[]>(
    () => (stash.members?.length ? stash.members : [newMember()]));
  const [text, setText] = useState(stash.text ?? "");
  const [topK, setTopK] = useState(stash.topK ?? 30);
  const [sources, setSources] = useState<MatchupTeamSource[]>(readMatchupSources);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(null);
  const [response, setResponse] = useState<ActualMatchupResponseDto | null>(() => {
    // Re-validate through the schema rather than trusting readStash's raw JSON.parse: a response
    // cached by an OLDER build can lack fields this build reads unconditionally, and rendering it
    // raw would white-screen the tab. safeParse fills defaults for a compatible cache and drops
    // an incompatible one (same guard the diagnose tab applies to its report).
    const parsed = ActualMatchupResponseDtoSchema.safeParse(stash.response);
    return parsed.success ? parsed.data : null;
  });
  const resultRef = useRef<HTMLDivElement>(null);

  const loadTeam = (team: unknown, nextFormat?: FormatId) => {
    const loaded = membersFromTeam(team);
    if (!loaded.length) return;
    setMembers(loaded); setMode("manual"); setResponse(null); setError(null);
    if (nextFormat) onFormatChange(nextFormat);
  };
  useEffect(() => {
    const fill = takeMatchupFill();
    if (fill) loadTeam(fill.team, fill.format);
    setSources(readMatchupSources());
  }, []);
  useEffect(() => {
    writeStash({ mode, members, text, topK, ...(response ? { response } : {}) });
  }, [mode, members, text, topK, response]);

  const sourceTeam = useMemo(() => teamFromMembers(format, members), [format, members]);
  const sourceCount = mode === "text" ? null : readTeamMembers(sourceTeam).length;
  const estimatedUnits = sourceCount ? Math.ceil(sourceCount * topK / 30) : null;
  const refreshQuota = () => adapter.quota?.().then(
    (all) => setQuota(all.matchup), () => {});
  useEffect(() => { refreshQuota(); }, [adapter]);
  // Re-attach to a battery still in flight from an earlier mount of this workspace.
  useEffect(() => {
    const task = activeBatteryTask;
    if (!task) return;
    let live = true;
    setRunning(true);
    setError(null);
    task.promise.then((next) => {
      if (!live) return;
      setResponse(next);
      const normalized = membersFromTeam(next.team);
      if (normalized.length) setMembers(normalized);
      refreshQuota();
    }, (reason: unknown) => {
      if (live) setError(String(reason));
    }).finally(() => {
      if (live) setRunning(false);
    });
    return () => { live = false; };
  }, []);

  const hasIllegalSpread = mode === "manual" && members.some((member) =>
    Object.values(member.spread).reduce((sum, value) => sum + value, 0) > 66);

  const run = async () => {
    const hasInput = mode === "text" ? !!text.trim() : readTeamMembers(sourceTeam).length > 0;
    if (!hasInput || hasIllegalSpread || running || activeBatteryTask) return;
    setRunning(true); setError(null); setResponse(null);
    const promise = adapter.actualMatchup({ format, topK,
      ...(mode === "text" ? { text: text.trim() } : { team: sourceTeam }) });
    const task: ActiveBatteryTask = { promise };
    activeBatteryTask = task;
    try {
      const next = await promise;
      // Persist directly: this continuation runs whether or not the workspace is still mounted,
      // and the stash-writing effect only fires while it is.
      writeStash({ ...readStash(), response: next });
      setResponse(next);
      const normalized = membersFromTeam(next.team);
      if (normalized.length) setMembers(normalized);
      refreshQuota();
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (reason) {
      setError(String(reason));
    } finally {
      if (activeBatteryTask === task) activeBatteryTask = null;
      setRunning(false);
    }
  };

  // The variant hint only applies once a run produced a species with more than one real build.
  // Counting opponents here rather than reading the results section's column model keeps the guide
  // at the top of the tab without lifting that section's state up.
  const hasBuilds = useMemo(() => {
    const cells = response?.result.members[0]?.cells ?? [];
    const seen = new Set<string>();
    // `Set.add` returns the SET, never a "was it new?" boolean — so ask before adding.
    return cells.some((c) => (seen.has(c.opponent) ? true : (seen.add(c.opponent), false)));
  }, [response]);

  return <div className="actual-workspace">
    <VocabLists vocab={vocab} />
    {/* Both guides sit at the TOP of the tab, exactly where the two reference grids put theirs —
      * they describe how to read the whole tab, not just the results section, and having them
      * appear halfway down once a run finished made the three matchup views look unrelated. This
      * replaces the old "calculate with custom sets" disclosure line, which only restated the tab's
      * own name. */}
    <div className="matrix-guide" aria-live="polite">
      <span className="matrix-guide-mark" aria-hidden>↘</span>{t("actual.cellHint")}
    </div>
    {hasBuilds && (
      <div className="matrix-guide variant-guide">
        <span className="matrix-guide-mark" aria-hidden>◧</span>
        {t("matchup.variantHint")}
      </div>
    )}
    <section className="panel actual-input-panel">
      <div className="actual-input-head">
        <div><h3>{t("actual.inputTitle")}</h3></div>
        <SegmentedControl kind="tabs" idBase="actual-input" value={mode} onChange={setMode}
          ariaLabel={t("actual.inputMode")} className="seg" items={[
            { id: "manual", label: t("actual.manual") }, { id: "text", label: t("actual.text") },
            { id: "recent", label: t("actual.recent") },
          ]} />
      </div>
      {mode === "manual" && <div className="actual-members">
        {members.map((member, index) => <MemberEditor key={member.id} member={member} index={index} count={members.length}
          vocab={vocab}
          onChange={(next) => setMembers((rows) => rows.map((row) => row.id === member.id ? next : row))}
          onRemove={() => setMembers((rows) => rows.filter((row) => row.id !== member.id))}
          onDuplicate={() => setMembers((rows) => rows.length < 12 ? [...rows, newMember(member, rows.length)] : rows)} />)}
        <button type="button" className="actual-add-member" disabled={members.length >= 12}
          onClick={() => setMembers((rows) => [...rows, newMember(undefined, rows.length)])}>
          <span>＋</span><b>{t("actual.addMember")}</b><small>{t("actual.addMemberHint")}</small></button>
      </div>}
      {mode === "text" && <div className="actual-text-import"><label htmlFor="actual-text">{t("actual.textLabel")}</label>
        <textarea id="actual-text" rows={12} maxLength={16000} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={t("actual.textPlaceholder")} />
        <p>{t("actual.textSupport")}</p></div>}
      {mode === "recent" && <RecentSources sources={sources} onUse={(source) => loadTeam(source.team, source.format)} />}
    </section>
    <section className="panel actual-runbar">
      <div className="actual-topk"><div><b>{t("actual.topK")}</b><span>{t("actual.topKHint")}</span></div>
        <div className="actual-topk-presets">{TOP_K_PRESETS.map((value) => <button type="button" key={value}
          className={topK === value ? "on" : ""} onClick={() => setTopK(value)}>{value}</button>)}
          <label><span>{t("actual.custom")}</span><input className="num" type="number" min={1} max={60} value={topK}
            onChange={(e) => setTopK(Math.max(1, Math.min(60, Number(e.target.value) || 1)))} /></label></div></div>
      <div className="actual-run-action"><span className="actual-budget muted num">
          {!adapter.quota
            ? t("actual.budget.local")
            : quota?.limit === 0
              ? t("actual.budget.unlimited")
              : estimatedUnits == null
                ? t("actual.budget.text").replace("{remaining}", quota
                    ? String(Math.max(0, quota.limit - quota.used)) : "—")
                : t("actual.budget.estimate")
                    .replace("{cost}", String(estimatedUnits))
                    .replace("{remaining}", quota
                      ? String(Math.max(0, quota.limit - quota.used)) : "—")}
        </span>
        <button type="button" className="primary-btn" disabled={running || hasIllegalSpread || (mode === "text" ? !text.trim() : readTeamMembers(sourceTeam).length === 0)}
          onClick={run}>{running ? t("actual.running") : t("actual.run")}</button></div>
    </section>
    {running && <section className="panel actual-progress" aria-live="polite"><span className="actual-progress-orbit" aria-hidden />
      <div><h3>{t("actual.progressTitle")}</h3><p>{t("actual.progressScope").replace("{sources}", String(mode === "text" ? "—" : readTeamMembers(sourceTeam).length)).replace("{targets}", String(topK))}</p></div><Elapsed /></section>}
    {error && <div className="notice actual-error">{t("actual.error")}<button type="button" className="linkish" onClick={run}>{t("actual.retry")}</button></div>}
    <div ref={resultRef}>{response && <ActualResult response={response} format={format} sourceTeam={response.team} />}</div>
  </div>;
}
