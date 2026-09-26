/** Speed line: where OUR selected Pokémon stands in the metagame, and the tools to move it.
 *
 * The page reads the calc page's shared roster. Two cards, like the calculator's: ours on the left is
 * the reference the whole table is coloured against; the other side's is whatever the user chose to
 * compare — a specific build worth checking. Both edit the shared builds. The table is not a matchup
 * between the two teams: it lists the metagame, and a roster Pokémon appears in its own species' row.
 *
 * Only conditions that move a Speed number are offered, and since each is a single switch they sit
 * on the strip itself: each side's Tailwind, and Trick Room, which reverses who moves first. Weather
 * and terrain stay (Swift Swim, Surge Surfer…). Everything else on the shared field is the
 * calculator's and is not shown.
 *
 * The metagame table lists every top-N species at the four investment tiers plus the two modified
 * lines (Tailwind, Scarf at max investment) and, from the observed-build catalog the calculator
 * already loads, the real builds, with the Meta stitch last as the environment picker shows it. The
 * 实配 cell shows one build at a time and opens the build cards to switch it; a roster Pokémon's own
 * build joins that list — selected where it equals a real build, added on top where it does not.
 * Under its side's Tailwind a roster build's cell reads the doubled Speed (the cards keep the build's
 * own), and sorting and colouring follow the doubled number. The table only reads: nothing in it
 * writes to the roster.
 * Nothing here is behind a Calculate button either: each batch re-runs from a signature of exactly
 * the inputs it reads, and a hidden tab defers its work until it is shown again. */
import type {
  FormatId, NatureDto, OppSetCatalogDto, SpeedInputDto, SpeedlineDto,
} from "@pokemon-champions/protocol";
import { isErrorShape } from "@pokemon-champions/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BuildPicker, type BuildCardOption } from "../../components/BuildPicker.tsx";
import type { CalcRailApi, CalcRailTarget } from "../../components/CalcRail.tsx";
import { EntityHover } from "../../components/EntityHover.tsx";
import { GameImage } from "../../components/GameImage.tsx";
import { loadOppSetsCached, useMovesByName, useRanking } from "../../hooks.ts";
import { displayName, useLang, useT } from "../../i18n.ts";
import type { DexIndexEntry, RuntimeAdapter } from "../../runtime/adapter.ts";
import { useRuntime } from "../../runtime/context.tsx";
import type { ItemRef } from "../../runtime/projection.ts";
import { useRoster } from "./roster.tsx";
import {
  buildConfigSig, observedBuildOptions, useBuildOptions, withMega, type BuildOption,
} from "./shared.tsx";
import { FieldPanel, useFieldOffers } from "./duel/FieldPanel.tsx";
import { buildCardOptionForMon } from "./duel/MonEditor.tsx";
import { monsFromPaste } from "./duel/paste.ts";
import { SwapSeam } from "./duel/SwapSeam.tsx";
import { DuelBar, TeamBar, TEAM_MAX, type ImportOutcome } from "./duel/TeamBar.tsx";
import {
  applyBuildOption, effectiveEntry, makeMon, type MonState, type SharedFlagKey, type SideId,
} from "./duel/state.ts";
import {
  SCARF, SPEED_SIDE_FLAGS, SP_MAX, TIER_KEYS, TIER_SPEC, movesFirst, natureDir, neutralNature,
  offenseOf, speedInputOf, speedNature, spToBeat, type Tier,
} from "./speed/lens.ts";
import { SpeedCard } from "./speed/SpeedCard.tsx";

const TIER_LABEL: Record<Tier, "speed.preset.max" | "speed.preset.fast" | "speed.preset.none" | "speed.preset.min"> = {
  max: "speed.preset.max", fast: "speed.preset.fast", none: "speed.preset.none", min: "speed.preset.min",
};
const MOD_KEYS = ["tailwind", "scarf"] as const;
type Mod = (typeof MOD_KEYS)[number];
const MOD_LABEL: Record<Mod, "speed.tailwind" | "speed.scarf"> = { tailwind: "speed.tailwind", scarf: "speed.scarf" };
const SPEED_SHARED: SharedFlagKey[] = ["trickRoom"];
const SIDES: SideId[] = ["a", "b"];
const BATCH = 240;
const CURVE = Array.from({ length: SP_MAX + 1 }, (_, sp) => sp);

interface RealBuild {
  option: BuildOption;
  /** The build's own signature, to recognise a roster Pokémon that carries exactly this build. */
  sig: string;
  speed: number | null;
  lo: number | null;
  hi: number | null;
}

interface TierRow {
  rowKey: string;
  slug: string;
  name: string;
  rank: number | null;
  base?: number;
  tiers: Partial<Record<Tier, number>>;
  mods: Partial<Record<Mod, number>>;
  real: RealBuild[];
}

/** A roster Pokémon, placed in its species' row. */
interface Member {
  side: SideId;
  index: number;
  mon: MonState;
  /** Its build's Speed under the shared weather and terrain — the same terms as a real build's. */
  speed: number | null;
  /** The same build under its side's Tailwind, or null while that side has none. */
  tailwind: number | null;
  /** The real build it equals, if any. */
  matchKey: string | null;
  /** A slot with nothing set yet is on the team, but has no build to compare. */
  built: boolean;
}

/** One card in a 实配 picker, with the Speed the cell would show for it. */
interface RealCard {
  key: string;
  option: BuildCardOption;
  speed: number | null;
  coverage: number | null;
  /** The roster Pokémon carrying this build, if any. */
  member: Member | null;
}

type SortKey = "actual" | "base";
interface SpeedView {
  topN: number;
  compare: "active" | "team";
  sort: { key: SortKey; dir: "desc" | "asc" };
  /** The item a Pokémon held before the Scarf button swapped one in, by roster uid. */
  scarfRestore: Record<string, string>;
}
const VIEW_KEY = "pc-calc-speed-view-v1";
const DEFAULT_VIEW: SpeedView = {
  topN: 60, compare: "active", sort: { key: "actual", dir: "desc" }, scarfRestore: {},
};

function loadView(): SpeedView {
  try {
    const raw = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? "null") as Partial<SpeedView> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_VIEW;
    const restore = raw.scarfRestore && typeof raw.scarfRestore === "object"
      ? Object.fromEntries(Object.entries(raw.scarfRestore).filter(([, v]) => typeof v === "string"))
      : {};
    const sort = raw.sort && (raw.sort.key === "actual" || raw.sort.key === "base")
      ? { key: raw.sort.key, dir: raw.sort.dir === "asc" ? "asc" as const : "desc" as const }
      : DEFAULT_VIEW.sort;
    return {
      topN: [30, 60, 100].includes(raw.topN as number) ? raw.topN as number : DEFAULT_VIEW.topN,
      compare: raw.compare === "team" ? "team" : "active",
      sort,
      scarfRestore: restore as Record<string, string>,
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

/** Catalog nature names are not always capitalised ("relaxed"); the engine only knows the canonical. */
const canonicalNature = (name: string) => (name ? name[0]!.toUpperCase() + name.slice(1).toLowerCase() : name);

async function speedBatch(adapter: RuntimeAdapter, inputs: SpeedInputDto[]): Promise<Array<SpeedlineDto | null>> {
  const chunks: SpeedInputDto[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH) chunks.push(inputs.slice(i, i + BATCH));
  const parts = await Promise.all(chunks.map((chunk) => adapter.speedBatch(chunk)));
  return parts.flat().map((row) => (row && !isErrorShape(row) ? row as SpeedlineDto : null));
}

function SortGlyph({ dir }: { dir: "desc" | "asc" | null }) {
  return (
    <svg className={`th-sort-glyph${dir ? ` ${dir}` : ""}`} viewBox="0 0 10 12" aria-hidden>
      <path d="M5 1.5 8 5H2z" className="up" />
      <path d="M5 10.5 2 7h6z" className="down" />
    </svg>
  );
}

export function SpeedTab({ dex, natures, items, onRailApi, active: visible = true }: {
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  onRailApi?: (api: CalcRailApi) => void;
  /** False while another calc tab is showing: batches wait until the tab is back. */
  active?: boolean;
}) {
  const { adapter, capabilities } = useRuntime();
  const t = useT();
  const { lang } = useLang();
  const moveVocab = useMovesByName();
  const { teams, active, field, setTeams, setActive, setField, swapSides } = useRoster();
  const format: FormatId = field.format;
  const neutral = useMemo(() => neutralNature(natures), [natures]);
  const natureNames = useMemo(() => ({
    plus: natures.find((n) => n.upStat === "spe" && n.downStat !== "spe")?.name ?? "Timid",
    minus: natures.find((n) => n.downStat === "spe" && n.upStat !== "spe")?.name ?? "Brave",
  }), [natures]);

  const [view, setView] = useState<SpeedView>(loadView);
  useEffect(() => {
    try { sessionStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* storage blocked */ }
  }, [view]);
  const [error, setError] = useState<string | null>(null);

  const entryOf = useCallback((slug: string) => dex.find((e) => e.slug === slug), [dex]);
  const category = useCallback((move: string) => moveVocab.get(move)?.category, [moveVocab]);
  const nameOf = useCallback((slug: string) => {
    const entry = entryOf(slug);
    return entry ? displayName(entry, lang) : slug;
  }, [entryOf, lang]);
  const sideName = (side: SideId) => (side === "a" ? t("speed.ours") : t("speed.theirs"));

  const mineIndex = Math.min(active.a, teams.a.length - 1);
  const mine = teams.a[mineIndex]!;
  const foeIndex = Math.min(active.b, teams.b.length - 1);
  const foe = teams.b[foeIndex]!;

  const setMonByUid = useCallback((uid: string, update: (mon: MonState) => MonState) => {
    setTeams((previous) => {
      for (const side of SIDES) {
        const at = previous[side].findIndex((mon) => mon.uid === uid);
        const current = previous[side][at];
        if (!current) continue;
        const next = update(current);
        if (next === current) return previous;
        const team = [...previous[side]];
        team[at] = next;
        return { ...previous, [side]: team };
      }
      return previous;
    });
  }, [setTeams]);
  const setMine = useCallback((update: (mon: MonState) => MonState) => setMonByUid(mine.uid, update),
    [setMonByUid, mine.uid]);
  const setFoe = useCallback((update: (mon: MonState) => MonState) => setMonByUid(foe.uid, update),
    [setMonByUid, foe.uid]);

  // -- the roster: live Speeds, build Speeds, and our SP curves --------------------------------

  // Real builds are on nobody's side: the shared weather and terrain apply, no Tailwind does. A
  // roster build is read on the same terms when it sits in the table beside them.
  const plainField = useMemo(() => ({ ...field, sides: { a: {}, b: {} } }), [field]);
  // The same, keeping only each side's Tailwind: a roster build's cell reads it (see Member.tailwind).
  const tailwindField = useMemo(() => ({ ...field, sides: {
    a: { tailwind: !!field.sides.a.tailwind }, b: { tailwind: !!field.sides.b.tailwind } } }), [field]);
  const offenseMine = offenseOf(mine, effectiveEntry(mine, dex, items), category);
  const mineInput = speedInputOf(mine, field, "a", dex, items, neutral);
  const altNature = speedNature(natures, mine.nature, field.trickRoom ? "-" : "+", offenseMine);

  const teamPlan = useMemo(() => {
    const members = SIDES.flatMap((side) => teams[side].map((mon) => {
      const bare = { ...mon, boosts: {}, status: "", abilityOn: null };
      return {
        mon,
        live: speedInputOf(mon, field, side, dex, items, neutral),
        build: speedInputOf(bare, plainField, null, dex, items, neutral),
        tailwind: tailwindField.sides[side].tailwind
          ? speedInputOf(bare, tailwindField, side, dex, items, neutral) : null,
      };
    }));
    const inputs: SpeedInputDto[] = members.flatMap(({ live, build, tailwind }) =>
      (live && build ? [live, build, ...(tailwind ? [tailwind] : [])] : []));
    const curve = mineInput ? CURVE.map((sp) => ({ ...mineInput, sps: { spe: sp } })) : [];
    const alt = mineInput && altNature !== mineInput.nature
      ? CURVE.map((sp) => ({ ...mineInput, nature: altNature, sps: { spe: sp } })) : [];
    const all = [...inputs, ...curve, ...alt];
    return { members, curve, alt, all, sig: JSON.stringify(all) };
  }, [teams, field, plainField, tailwindField, dex, items, neutral, mineInput, altNature]);

  const [teamRun, setTeamRun] = useState<{
    sig: string; byUid: Record<string, SpeedlineDto>; buildByUid: Record<string, number>;
    tailwindByUid: Record<string, number>; curve: Array<number | null>; alt: Array<number | null>;
  } | null>(null);
  const teamToken = useRef(0);
  useEffect(() => {
    if (!visible || teamRun?.sig === teamPlan.sig) return;
    const token = ++teamToken.current;
    const plan = teamPlan;
    if (!plan.all.length) {
      setTeamRun({ sig: plan.sig, byUid: {}, buildByUid: {}, tailwindByUid: {}, curve: [], alt: [] });
      return;
    }
    const timer = window.setTimeout(() => {
      speedBatch(adapter, plan.all).then((out) => {
        if (token !== teamToken.current) return;
        const byUid: Record<string, SpeedlineDto> = {};
        const buildByUid: Record<string, number> = {};
        const tailwindByUid: Record<string, number> = {};
        let at = 0;
        for (const member of plan.members) {
          if (!member.live || !member.build) continue;
          const live = out[at++];
          const build = out[at++];
          const tailwind = member.tailwind ? out[at++] : null;
          if (live) byUid[member.mon.uid] = live;
          if (build) buildByUid[member.mon.uid] = build.finalSpeed;
          if (tailwind) tailwindByUid[member.mon.uid] = tailwind.finalSpeed;
        }
        const read = (n: number) => out.slice(at, at + n).map((row) => row?.finalSpeed ?? null);
        const curve = read(plan.curve.length); at += plan.curve.length;
        const alt = read(plan.alt.length);
        setTeamRun({ sig: plan.sig, byUid, buildByUid, tailwindByUid, curve, alt });
        setError(null);
      }).catch((e) => {
        console.error("Speed calculation failed:", e);
        if (token === teamToken.current) setError(t("calc.error"));
      });
    }, 160);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamPlan.sig, visible]);

  const speedOf = useCallback((mon: MonState) => teamRun?.byUid[mon.uid]?.finalSpeed ?? null, [teamRun]);
  const mineSpeed = speedOf(mine);

  // -- the metagame table ---------------------------------------------------------------------

  const ranking = useRanking(format);
  const rankingRows = useMemo(() => (ranking.status === "ready" ? ranking.data.rows : []), [ranking]);
  const [catalog, setCatalog] = useState<{ format: FormatId; data: OppSetCatalogDto | null } | null>(null);
  useEffect(() => {
    let live = true;
    loadOppSetsCached(adapter, capabilities.deploymentId, format)
      .then((data) => { if (live) setCatalog({ format, data }); })
      .catch((e) => {
        console.error(`observed build catalog failed for ${format}:`, e);
        if (live) setCatalog({ format, data: null });
      });
    return () => { live = false; };
  }, [adapter, capabilities.deploymentId, format]);
  const catalogData = catalog?.format === format ? catalog.data : null;

  // A roster species outside the top N still gets its row: the table is where its build is compared.
  const rosterSlugs = useMemo(() => [...new Set(SIDES.flatMap((side) => teams[side].flatMap((mon) => {
    const entry = effectiveEntry(mon, dex, items);
    return entry ? [entry.slug] : [];
  })))].sort(), [teams, dex, items]);
  const rosterKey = rosterSlugs.join("|");

  const tablePlan = useMemo(() => {
    const base: Array<{ row: TierRow; entry: DexIndexEntry }> = [];
    const seen = new Set<string>();
    const push = (entry: DexIndexEntry, rank: number | null) => {
      if (seen.has(entry.slug)) return;
      seen.add(entry.slug);
      base.push({ entry, row: { rowKey: `meta-${entry.slug}`, slug: entry.slug, name: entry.name,
        rank, tiers: {}, mods: {}, real: [] } });
    };
    rankingRows.slice(0, view.topN).forEach((ranked) => {
      const entry = entryOf(ranked.slug);
      if (!entry) return;
      push(entry, ranked.rank);
      // A Mega's Speed differs from its base (Garchomp 102 → Mega 92), and the ranking lists only
      // the base species, so each Mega gets its own rung.
      dex.filter((m) => m.isMega && m.baseSpecies === entry.name).forEach((mega) => push(mega, ranked.rank));
    });
    for (const slug of rosterSlugs) {
      const entry = entryOf(slug);
      if (!entry) continue;
      const baseSlug = entry.isMega ? dex.find((e) => e.name === entry.baseSpecies)?.slug : entry.slug;
      push(entry, rankingRows.find((r) => r.slug === baseSlug)?.rank ?? null);
    }
    const inputs: SpeedInputDto[] = [];
    const desc: Array<{ row: number; col: Tier | Mod | "real" | "lo" | "hi"; real?: number }> = [];
    const tierNature = (tier: Tier) => (TIER_SPEC[tier].dir === "+" ? natureNames.plus
      : TIER_SPEC[tier].dir === "-" ? natureNames.minus : neutral);
    base.forEach(({ row, entry }, ri) => {
      TIER_KEYS.forEach((tier) => {
        inputs.push({ name: entry.name, nature: tierNature(tier), sps: { spe: TIER_SPEC[tier].sp } });
        desc.push({ row: ri, col: tier });
      });
      inputs.push({ name: entry.name, nature: natureNames.plus, sps: { spe: SP_MAX }, field: { tailwind: true } });
      desc.push({ row: ri, col: "tailwind" });
      // A Mega battles holding its stone, so it has no Scarf line.
      if (!entry.isMega) {
        inputs.push({ name: entry.name, nature: natureNames.plus, sps: { spe: SP_MAX }, item: SCARF });
        desc.push({ row: ri, col: "scarf" });
      }
      const options = observedBuildOptions(catalogData, entry.slug, dex, items)
        .filter((option) => entry.isMega || !option.set.runForm || option.set.runForm === entry.name);
      row.real = options.map((option) => ({
        option, sig: buildConfigSig(applyBuildOption(makeMon(entry.slug), option)), speed: null, lo: null, hi: null,
      }));
      options.forEach((option, oi) => {
        const probe = (nature: string, spe: number) => speedInputOf(
          { ...makeMon(entry.slug), ability: option.modal.ability, item: option.modal.item, nature,
            sps: { spe } }, plainField, null, dex, items, neutral);
        const own = probe(option.modal.nature, option.modal.sps.spe ?? 0);
        if (own) { inputs.push(own); desc.push({ row: ri, col: "real", real: oi }); }
        // The cluster behind one representative build spans a Speed range; its ends are the
        // slowest nature seen at the lowest SP and the fastest at the highest.
        const profile = option.set.speedProfile;
        if (profile && profile.minSpeSp != null && profile.maxSpeSp != null) {
          const dirs = new Set(profile.natures.map((name) => natureDir(natures, canonicalNature(name))));
          const lo = probe(dirs.has("-") ? natureNames.minus : neutral, profile.minSpeSp);
          const hi = probe(dirs.has("+") ? natureNames.plus : neutral, profile.maxSpeSp);
          if (lo) { inputs.push(lo); desc.push({ row: ri, col: "lo", real: oi }); }
          if (hi) { inputs.push(hi); desc.push({ row: ri, col: "hi", real: oi }); }
        }
      });
    });
    return { base, inputs, desc, sig: `${JSON.stringify(inputs)}#${base.length}` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rankingRows, view.topN, rosterKey, dex, items, catalogData, field.weather, field.terrain, neutral, natureNames]);

  const [metaRows, setMetaRows] = useState<{ sig: string; rows: TierRow[] } | null>(null);
  const tableToken = useRef(0);
  useEffect(() => {
    if (!visible || metaRows?.sig === tablePlan.sig) return;
    const token = ++tableToken.current;
    const plan = tablePlan;
    if (!plan.inputs.length) { setMetaRows({ sig: plan.sig, rows: [] }); return; }
    speedBatch(adapter, plan.inputs).then((out) => {
      if (token !== tableToken.current) return;
      const rows: TierRow[] = plan.base.map(({ row }) => ({
        ...row, tiers: {}, mods: {}, real: row.real.map((real) => ({ ...real })),
      }));
      out.forEach((result, i) => {
        if (!result) return;
        const d = plan.desc[i]!;
        const row = rows[d.row]!;
        if (d.col === "real" || d.col === "lo" || d.col === "hi") {
          const real = row.real[d.real ?? 0];
          if (!real) return;
          if (d.col === "real") real.speed = result.finalSpeed;
          else real[d.col] = result.finalSpeed;
          return;
        }
        row.base = result.baseSpeed;
        if (d.col === "tailwind" || d.col === "scarf") row.mods[d.col] = result.finalSpeed;
        else row.tiers[d.col] = result.finalSpeed;
      });
      setMetaRows({ sig: plan.sig, rows });
      setError(null);
    }).catch((e) => {
      console.error("Speed table calculation failed:", e);
      if (token === tableToken.current) setError(t("calc.error"));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tablePlan.sig, visible]);

  // -- the Meta stitch: the environment picker's last card, loaded per species on demand ---------
  // A detail file per species is too much to fetch for the whole table up front. It is loaded for
  // the rows that need it to show anything (no real build, or a roster Pokémon that may carry it),
  // and for a row the moment its picker is about to open.
  const loadBuildOptions = useBuildOptions();
  const [metaSets, setMetaSets] = useState<Record<string, BuildOption | null>>({});
  const metaAsked = useRef(new Set<string>());
  const metaKey = (slug: string) => `${format}:${slug}`;
  const requestMeta = (slug: string) => {
    const key = metaKey(slug);
    if (metaAsked.current.has(key)) return;
    metaAsked.current.add(key);
    loadBuildOptions(slug, format)
      .then((options) => options.find((option) => option.source === "meta") ?? null)
      .catch(() => null)
      .then((meta) => setMetaSets((previous) => ({ ...previous, [key]: meta })));
  };
  const metaOf = (slug: string) => metaSets[metaKey(slug)];
  useEffect(() => {
    // Only once the table reflects the loaded catalog: before that every row looks build-less.
    if (catalog?.format !== format || metaRows?.sig !== tablePlan.sig) return;
    for (const row of metaRows.rows) {
      const onRoster = rosterSlugs.includes(row.slug);
      if (!row.real.length || onRoster) requestMeta(row.slug);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaRows, tablePlan.sig, rosterKey, format]);

  const metaPlan = useMemo(() => {
    const entries = Object.entries(metaSets).flatMap(([key, option]) => {
      if (!option || !key.startsWith(`${format}:`)) return [];
      const slug = key.slice(format.length + 1);
      const input = speedInputOf({ ...makeMon(slug), ability: option.modal.ability, item: option.modal.item,
        nature: option.modal.nature, sps: option.modal.sps }, plainField, null, dex, items, neutral);
      return input ? [{ key: option.key, input }] : [];
    });
    return { entries, sig: JSON.stringify(entries) };
  }, [metaSets, format, plainField, dex, items, neutral]);
  const [metaSpeeds, setMetaSpeeds] = useState<{ sig: string; byKey: Record<string, number> } | null>(null);
  useEffect(() => {
    if (!visible || metaSpeeds?.sig === metaPlan.sig) return;
    const plan = metaPlan;
    if (!plan.entries.length) { setMetaSpeeds({ sig: plan.sig, byKey: {} }); return; }
    let live = true;
    speedBatch(adapter, plan.entries.map((entry) => entry.input)).then((out) => {
      if (!live) return;
      const byKey: Record<string, number> = {};
      out.forEach((row, i) => { if (row) byKey[plan.entries[i]!.key] = row.finalSpeed; });
      setMetaSpeeds({ sig: plan.sig, byKey });
    }).catch((e) => console.error("Meta speed calculation failed:", e));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaPlan.sig, visible]);

  // -- roster Pokémon in their species' rows, and what each 实配 cell shows -----------------------

  const [picks, setPicks] = useState<Record<string, string>>({});
  const pct = (share: number | null | undefined) => (share == null ? "" : `${Math.round(share * 100)}%`);
  const memberTag = (member: Member) => `${sideName(member.side)} ${member.index + 1}`;
  const rowsView = useMemo(() => (metaRows?.rows ?? []).map((row) => {
    const entry = entryOf(row.slug);
    const meta = metaOf(row.slug);
    const metaSig = meta ? buildConfigSig(applyBuildOption(makeMon(row.slug), meta)) : null;
    const members: Member[] = SIDES.flatMap((side) => teams[side].flatMap((mon, index) => {
      if (effectiveEntry(mon, dex, items)?.slug !== row.slug) return [];
      const sig = buildConfigSig(mon);
      const built = !!(mon.ability || mon.item || mon.nature
        || Object.values(mon.sps).some((value) => (value ?? 0) > 0));
      const match = row.real.find((real) => real.sig === sig)?.option.key
        ?? (meta && metaSig === sig ? meta.key : null);
      return [{ side, index, mon, built, speed: teamRun?.buildByUid[mon.uid] ?? null,
        tailwind: field.sides[side].tailwind ? teamRun?.tailwindByUid[mon.uid] ?? null : null,
        matchKey: built ? match : null }];
    }));
    const own: RealCard[] = entry ? members.filter((member) => member.built && !member.matchKey).map((member) => ({
      key: `team:${member.mon.uid}`,
      option: { ...buildCardOptionForMon(member.mon, entry, dex), key: `team:${member.mon.uid}` },
      speed: member.speed, coverage: null, member,
    })) : [];
    const real: RealCard[] = row.real.map((build, i) => ({
      key: build.option.key,
      option: { key: build.option.key, source: build.option.source, coverage: build.option.coverage,
        isModal: build.option.isModal, set: build.option.set, labelIndex: i },
      speed: build.speed, coverage: build.option.coverage,
      member: members.find((member) => member.matchKey === build.option.key) ?? null,
    }));
    const metaCard: RealCard[] = meta ? [{
      key: meta.key,
      option: { key: meta.key, source: "meta", coverage: null, isModal: row.real.length === 0, set: meta.set },
      speed: metaSpeeds?.byKey[meta.key] ?? null, coverage: null,
      member: members.find((member) => member.matchKey === meta.key) ?? null,
    }] : [];
    const cards = [...own, ...real, ...metaCard];
    // What the roster carries comes first: ours, then theirs, then the most common real build.
    const built = members.filter((member) => member.built);
    const preferred = built.find((m) => m.side === "a") ?? built[0];
    const fallback = preferred ? (preferred.matchKey ?? `team:${preferred.mon.uid}`) : cards[0]?.key;
    const shown = cards.find((card) => card.key === picks[row.rowKey])
      ?? cards.find((card) => card.key === fallback) ?? null;
    // What the cell reads: a roster build under its side's Tailwind is that Pokémon moving at double.
    const tailwind = shown?.member?.tailwind ?? null;
    const speed = tailwind ?? shown?.speed ?? null;
    return { row, entry, members, cards, shown, speed, tailwind: tailwind != null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [metaRows, teams, teamRun, picks, metaSets, metaSpeeds, field.sides, dex, items, lang]);

  const sorted = useMemo(() => {
    const { key, dir } = view.sort;
    const value = (v: (typeof rowsView)[number]) => (key === "actual" ? v.speed : v.row.base ?? null);
    return [...rowsView].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      // Rows without a value sit at the bottom whichever way the column is sorted.
      if (va != null && vb != null && va !== vb) return dir === "desc" ? vb - va : va - vb;
      if (va == null && vb != null) return 1;
      if (vb == null && va != null) return -1;
      return (b.row.tiers.max ?? -1) - (a.row.tiers.max ?? -1) || (a.row.rank ?? 999) - (b.row.rank ?? 999);
    });
  }, [rowsView, view.sort]);
  const sortBy = (key: SortKey) => setView((v) => ({
    ...v, sort: v.sort.key === key ? { key, dir: v.sort.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" },
  }));

  // -- colour and hints against our selected Pokémon ----------------------------------------------

  const tr = field.trickRoom;
  const mineSpeeds = teams.a.flatMap((mon) => { const s = speedOf(mon); return s == null ? [] : [s]; });
  const cellCls = (v: number | null | undefined): string => {
    if (v == null) return "";
    const refs = view.compare === "active" ? (mineSpeed == null ? [] : [mineSpeed]) : mineSpeeds;
    if (!refs.length) return "";
    // "faster" = that line moves before ours (under Trick Room, by being slower).
    const diffs = refs.map((speed) => (tr ? speed - v : v - speed));
    if (diffs.every((d) => d > 0)) return "faster";
    if (diffs.every((d) => d < 0)) return "slower";
    if (diffs.every((d) => d === 0)) return "tie";
    return "";
  };
  const mineEntry = effectiveEntry(mine, dex, items);
  const mineName = mineEntry ? displayName(mineEntry, lang) : t("calc.emptySlot");
  const altRef = natures.find((n) => n.name === altNature);
  const altLabel = altRef ? displayName(altRef, lang) : altNature;
  const hintFor = (v: number | null | undefined): string | undefined => {
    if (v == null || mineSpeed == null || !teamRun) return undefined;
    const curSp = mine.sps.spe ?? 0;
    if (v === mineSpeed) return t("speed.cellTie").replace("{mine}", mineName);
    if (movesFirst(mineSpeed, v, tr)) {
      const edge = spToBeat(teamRun.curve, v, tr);
      return t("speed.cellAhead").replace("{mine}", mineName)
        .replace("{n}", String(edge == null ? 0 : Math.abs(curSp - edge)));
    }
    const need = spToBeat(teamRun.curve, v, tr);
    if (need != null) {
      return t("speed.cellNeed").replace("{mine}", mineName).replace("{sp}", String(need))
        .replace("{cur}", String(curSp));
    }
    const other = teamRun.alt.length ? spToBeat(teamRun.alt, v, tr) : null;
    if (other != null) {
      return t("speed.cellNeedNature").replace("{mine}", mineName).replace("{sp}", String(other))
        .replace("{nature}", altLabel);
    }
    return t("speed.cellOut").replace("{mine}", mineName);
  };

  // -- the rail adds to the roster --------------------------------------------------------------

  const place = useCallback((target: CalcRailTarget, mon: MonState) => {
    const side: SideId = target === "primary" ? "a" : "b";
    const team = teams[side];
    const activeEmpty = team[active[side]] && !team[active[side]]!.slug ? active[side] : -1;
    const emptyIndex = activeEmpty >= 0 ? activeEmpty : team.findIndex((candidate) => !candidate.slug);
    if (emptyIndex < 0 && team.length >= TEAM_MAX) return { ok: false as const, reason: "full" as const };
    const index = emptyIndex >= 0 ? emptyIndex : team.length;
    setTeams((previous) => ({ ...previous, [side]: emptyIndex >= 0
      ? previous[side].map((candidate, at) => at === emptyIndex ? mon : candidate)
      : [...previous[side], mon] }));
    setActive((previous) => ({ ...previous, [side]: index }));
    return { ok: true as const };
  }, [teams, active, setTeams, setActive]);
  const pickFromRail = useCallback((target: CalcRailTarget, entry: DexIndexEntry,
                                    option: BuildOption | null, optionIndex: number) => {
    const seed = { ...makeMon(entry.slug), pinned: true };
    const mon = option ? { ...applyBuildOption(seed, option, optionIndex), pinned: true } : seed;
    return place(target, mon);
  }, [place]);
  const railApi = useMemo<CalcRailApi>(() => ({
    format,
    targets: [{ id: "primary", label: t("speed.ours") }, { id: "secondary", label: t("speed.theirs") }],
    pick: pickFromRail,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [format, pickFromRail, lang]);
  useEffect(() => { onRailApi?.(railApi); }, [onRailApi, railApi]);

  // -- roster bar ---------------------------------------------------------------------------------

  const offers = useFieldOffers([mine, foe], field);
  const importPaste = async (side: SideId, text: string): Promise<ImportOutcome> => {
    const { mons, outcome } = await monsFromPaste(text, { dex, items, natures, adapter });
    if (!mons.length) return outcome;
    setTeams((previous) => ({ ...previous, [side]: mons }));
    setActive((previous) => ({ ...previous, [side]: 0 }));
    return outcome;
  };
  const wing = (side: SideId) => ({
    team: teams[side], index: active[side], dex, items, field, setField, side,
    allowedFlags: SPEED_SIDE_FLAGS, inlineFlags: true,
    onIndex: (i: number) => setActive((p) => (p[side] === i ? p : { ...p, [side]: i })),
    onAdd: () => {
      if (teams[side].length >= TEAM_MAX) return;
      setTeams((p) => (p[side].length >= TEAM_MAX ? p : { ...p, [side]: [...p[side], makeMon()] }));
      setActive((p) => ({ ...p, [side]: teams[side].length }));
    },
    onRemove: (i: number) => {
      setTeams((p) => ({ ...p, [side]: p[side].filter((_, j) => j !== i) }));
      setActive((p) => ({ ...p, [side]: Math.max(0, Math.min(p[side], teams[side].length - 2)) }));
    },
    onReset: () => {
      setTeams((p) => ({ ...p, [side]: [makeMon()] }));
      setActive((p) => ({ ...p, [side]: 0 }));
    },
    onImport: (text: string) => importPaste(side, text),
  });

  /** Scarf is an item: on remembers what it replaced, off gives that back. A Mega must hold its
   * stone, and Item Clause allows one Scarf per team. */
  const scarfFor = (mon: MonState, side: SideId) => {
    const on = mon.item === SCARF;
    const blocked = withMega(mon, dex, items).mega ? t("speed.megaNoScarf")
      : teams[side].some((other) => other.uid !== mon.uid && other.item === SCARF) ? t("speed.scarfClause") : null;
    return {
      on, blocked,
      toggle: () => {
        if (on) {
          const back = view.scarfRestore[mon.uid] ?? "";
          setMonByUid(mon.uid, (m) => ({ ...m, item: back }));
          setView((v) => {
            const rest = { ...v.scarfRestore };
            delete rest[mon.uid];
            return { ...v, scarfRestore: rest };
          });
        } else {
          setView((v) => ({ ...v, scarfRestore: { ...v.scarfRestore, [mon.uid]: mon.item } }));
          setMonByUid(mon.uid, (m) => ({ ...m, item: SCARF }));
        }
      },
    };
  };
  const foeEntry = effectiveEntry(foe, dex, items);

  // -- the 实配 picker ------------------------------------------------------------------------------

  const [openRow, setOpenRow] = useState<string | null>(null);
  const pickAnchor = useRef<HTMLElement | null>(null);
  const closePicker = useCallback(() => setOpenRow(null), []);
  const openView = openRow ? rowsView.find((v) => v.row.rowKey === openRow) ?? null : null;
  const cardNote = (card: RealCard, row: TierRow) => {
    const real = row.real.find((build) => build.option.key === card.key);
    const parts = [
      card.member ? memberTag(card.member) : "",
      t("speed.cardSpeed").replace("{n}", String(card.speed ?? "—")),
      real?.lo != null && real.hi != null
        ? t("speed.clusterRange").replace("{lo}", String(real.lo)).replace("{hi}", String(real.hi)) : "",
    ];
    return parts.filter(Boolean).join(" · ");
  };

  const markers = sorted.flatMap((v, index) => (v.members.length
    ? [{ v, position: ((index + 0.5) / Math.max(1, sorted.length)) * 100 }] : []));
  const scrollRef = useRef<HTMLDivElement>(null);
  const locateRow = (rowKey: string) => {
    const scroller = scrollRef.current;
    const target = document.getElementById(`speed-row-${rowKey}`);
    if (!scroller || !target) return;
    const rect = target.getBoundingClientRect();
    const top = scroller.scrollTop + rect.top - scroller.getBoundingClientRect().top;
    scroller.scrollTop = Math.max(0, top - (scroller.clientHeight - rect.height) / 2);
  };
  const sortHead = (key: SortKey, label: string, className: string, title?: string) => {
    const on = view.sort.key === key;
    return (
      <th className={`${className} sortable${on ? " sorted" : ""}`} title={title}
        aria-sort={on ? (view.sort.dir === "desc" ? "descending" : "ascending") : "none"}>
        <button type="button" className="th-sort" onClick={() => sortBy(key)} title={t("speed.sortBy")}>
          {label}<SortGlyph dir={on ? view.sort.dir : null} />
        </button>
      </th>
    );
  };

  return (
    <div className="spd-page">
      <DuelBar field={field}>
        <TeamBar label={t("calc.attacker")} teamLabel={t("calc.attackerTeam")} {...wing("a")} />
        <FieldPanel field={field} setField={setField} sharedFlags={SPEED_SHARED} inlineShared
          weatherSuggestions={offers.weather} terrainSuggestions={offers.terrain} />
        <TeamBar label={t("calc.defender")} teamLabel={t("calc.defenderTeam")} {...wing("b")} mirrored />
      </DuelBar>

      <div className="spd-top swap-seam-host">
        <SpeedCard label={t("speed.ours")} mon={mine} setMon={setMine} pickerKey="spd-a" dex={dex}
          natures={natures} items={items} format={format} offense={offenseMine} input={mineInput}
          result={teamRun?.byUid[mine.uid] ?? null} scarf={scarfFor(mine, "a")} />
        <SwapSeam onSwap={swapSides} />
        <SpeedCard label={t("speed.theirs")} mon={foe} setMon={setFoe} pickerKey="spd-b" dex={dex}
          natures={natures} items={items} format={format} offense={offenseOf(foe, foeEntry, category)}
          input={speedInputOf(foe, field, "b", dex, items, neutral)}
          result={teamRun?.byUid[foe.uid] ?? null} scarf={scarfFor(foe, "b")} />
      </div>

      {error && <div className="notice mono">{error}</div>}

      <div className="speed-tier-head">
        <h2 className="page-title" style={{ fontSize: 15, margin: 0 }}>{t("speed.env")}</h2>
        <span className="speed-tier-scope">
          <label><span>{t("speed.topN")}</span>
            <select value={view.topN} onChange={(e) => setView((v) => ({ ...v, topN: Number(e.target.value) }))}>
              {[30, 60, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </span>
        <span className="speed-tier-tools">
          <span className="tier-legend">
            <span className="lg faster">{t(view.compare === "active" ? "speed.legendBefore" : "speed.legendBeforeAll")}</span>
            <span className="lg slower">{t(view.compare === "active" ? "speed.legendAfter" : "speed.legendAfterAll")}</span>
            {tr && <span className="lg tr">{t("speed.trNote")}</span>}
          </span>
          <span className="spd-compare-seg" role="group" aria-label={t("speed.compareLabel")}>
            <span className="cap">{t("speed.compareLabel")}</span>
            <span className="seg">
              <button type="button" className={view.compare === "active" ? "on" : ""} aria-pressed={view.compare === "active"}
                onClick={() => setView((v) => ({ ...v, compare: "active" }))}>
                {t("speed.compareActive").replace("{name}", mineName).replace("{speed}", String(mineSpeed ?? "—"))}
              </button>
              <button type="button" className={view.compare === "team" ? "on" : ""} aria-pressed={view.compare === "team"}
                onClick={() => setView((v) => ({ ...v, compare: "team" }))}>
                {t("speed.compareTeam")}
              </button>
            </span>
          </span>
        </span>
      </div>

      {sorted.length > 0 ? (
        <div className="speed-tier-shell">
          <div className="panel speed-tier-wrap">
            <div className="speed-tier-scroll" ref={scrollRef}>
              <table className="speed-tier">
                <thead>
                  <tr>
                    <th className="corner">{t("ranking.pokemon")}</th>
                    {sortHead("base", t("speed.baseSpe"), "base-col")}
                    {sortHead("actual", t("speed.actual"), "actual-col", t("speed.realHint"))}
                    {MOD_KEYS.map((mod) => (
                      <th key={mod} className="mod-col" title={t("speed.modifiedMaxHint")}>{t(MOD_LABEL[mod])}</th>
                    ))}
                    {TIER_KEYS.map((tier) => <th key={tier}>{t(TIER_LABEL[tier])}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(({ row, entry, members, cards, shown, speed, tailwind }) => {
                    const ours = members.some((m) => m.side === "a");
                    const focus = members.some((m) => m.side === "a" && m.index === mineIndex);
                    // A cell showing one of OUR builds is a reference, not a line to read against.
                    const self = shown?.member?.side === "a";
                    const identity = <>
                      {entry && <GameImage assetKey={entry.key} role="dense" alt={displayName(entry, lang)} className="mini" />}
                      <span className="nm">{entry ? displayName(entry, lang) : row.name}</span>
                      {row.rank != null && <span className="rk num">#{row.rank}</span>}
                    </>;
                    const others = cards.filter((card) => card.option.source !== "meta").length - 1;
                    const shownTag = shown?.member ? sideName(shown.member.side)
                      : shown ? pct(shown.coverage) : "";
                    return (
                      <tr key={row.rowKey} id={`speed-row-${row.rowKey}`}
                        className={`${ours ? "mine" : members.length ? "custom" : "meta"}${focus ? " focus" : ""}`}>
                        <th className="tier-mon">
                          {entry ? (
                            <EntityHover kind="pokemon" name={entry.name} link={false} passive>
                              <span className="speed-tier-identity">{identity}</span>
                            </EntityHover>
                          ) : <span className="speed-tier-identity">{identity}</span>}
                          {members.map((member) => {
                            const on = active[member.side] === member.index;
                            return (
                              <button key={member.mon.uid} type="button"
                                className={`rung-you${member.side === "b" ? " custom" : ""}${on ? " on" : ""}`}
                                aria-pressed={on} title={t("speed.selectRow")}
                                onClick={() => setActive((p) => (p[member.side] === member.index ? p
                                  : { ...p, [member.side]: member.index }))}>
                                {memberTag(member)}
                              </button>
                            );
                          })}
                        </th>
                        <td className="base-col"><span className="speed-value">{row.base ?? "—"}</span></td>
                        <td className={`spd actual-col${self ? " self" : ` ${cellCls(speed)}`}${tailwind ? " on-tailwind" : ""}`}>
                          {shown && (
                            <button type="button" className={`speed-real${openRow === row.rowKey ? " open" : ""}`}
                              aria-haspopup="dialog" aria-expanded={openRow === row.rowKey}
                              title={[cardNote(shown, row),
                                tailwind ? `${t("speed.tailwind")} ×2 → ${speed}` : "",
                                self ? "" : hintFor(speed), t("speed.pickReal")].filter(Boolean).join("\n")}
                              onPointerEnter={() => requestMeta(row.slug)} onFocus={() => requestMeta(row.slug)}
                              onClick={(event) => {
                                if (openRow === row.rowKey) { setOpenRow(null); return; }
                                requestMeta(row.slug);
                                pickAnchor.current = event.currentTarget;
                                setOpenRow(row.rowKey);
                              }}>
                              <span className="speed-value">
                                {speed ?? "—"}
                                {tailwind && <span className="speed-tw-badge" aria-label={t("speed.tailwind")}>×2</span>}
                              </span>
                              <small className={shown.member ? `who ${shown.member.side}` : ""}>{shownTag}</small>
                              {/* The Meta card loads on hover; counting it would make the number jump. */}
                              <small className="more num">{others > 0 ? `+${others}` : ""}</small>
                            </button>
                          )}
                        </td>
                        {MOD_KEYS.map((mod) => (
                          <td key={mod} className={`spd mod-col ${cellCls(row.mods[mod])}`} title={hintFor(row.mods[mod])}>
                            {row.mods[mod] != null && <span className="speed-value">{row.mods[mod]}</span>}
                          </td>
                        ))}
                        {TIER_KEYS.map((tier) => (
                          <td key={tier} className={`spd ${cellCls(row.tiers[tier])}`} title={hintFor(row.tiers[tier])}>
                            <span className="speed-value">{row.tiers[tier] ?? "—"}</span>
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div className="speed-row-markers" role="navigation" aria-label={t("speed.locators")}>
            {markers.map(({ v, position }) => {
              const lead = v.members.find((m) => m.side === "a") ?? v.members[0]!;
              const label = t("speed.locate").replace("{side}", sideName(lead.side))
                .replace("{index}", String(lead.index + 1)).replace("{name}", nameOf(v.row.slug));
              return <button key={v.row.rowKey} type="button"
                className={`speed-row-marker ${lead.side === "a" ? "mine" : "custom"}`}
                style={{ top: `${position}%` }} aria-label={label} title={label}
                aria-controls={`speed-row-${v.row.rowKey}`} onClick={() => locateRow(v.row.rowKey)} />;
            })}
          </div>
          {openView && (
            <BuildPicker anchorRef={pickAnchor} onClose={closePicker} hint={t("speed.pickReal")}
              currentKey={openView.shown?.key}
              options={openView.cards.map((card) => ({ ...card.option, note: cardNote(card, openView.row) }))}
              onPick={(option) => setPicks((p) => ({ ...p, [openView.row.rowKey]: option.key }))} />
          )}
        </div>
      ) : (
        !error && (ranking.status === "loading"
          ? <div className="spinner">{t("state.loading")}</div>
          : <div className="notice">{t("speed.empty")}</div>)
      )}
    </div>
  );
}
