/** Speed line: MY mon (the query slot, with 最速/準速/無振/最慢 presets) plotted against a live
 * metagame speed-tier TABLE — every top-N usage mon shown at all four investment tiers at once, plus
 * the two lines that decide most Speed reads in practice: max investment under Tailwind and under
 * Choice Scarf (design ref: the gamewith / nerd-of-now speed tools). Each speed cell is coloured
 * against my mon: red = that line outspeeds me, green = I outspeed it. Click any cell to load that
 * mon at that line into the query slot. Custom opponents get their own rows with a real "actual"
 * speed (Scarf/Tailwind folded).
 *
 * Nothing here is behind a Calculate button. The table and my own speeds both recompute from a
 * SIGNATURE of the inputs they read, so editing a nature re-runs them and clicking a cell, switching
 * the add-to side or re-rendering does not: an explicit button on a derived number is a button that
 * exists only to make the reader wonder whether the number on screen is still the current one. */
import type {
  FormatId, NatureDto, SpeedInputDto, Status,
} from "@pokemon-champions/protocol";
import { isErrorShape } from "@pokemon-champions/protocol";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { BuildSetSummary, type BuildCardOption } from "../../components/BuildPicker.tsx";
import type { CalcRailApi, CalcRailTarget } from "../../components/CalcRail.tsx";
import { EntityHover } from "../../components/EntityHover.tsx";
import { FormatTabs } from "../../components/FormatTabs.tsx";
import { GameImage } from "../../components/GameImage.tsx";
import { displayName, useLang, useT } from "../../i18n.ts";
import { type ItemRef } from "../../runtime/projection.ts";
import { useRanking } from "../../hooks.ts";
import { useRuntime } from "../../runtime/context.tsx";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import {
  BOOST_STAGES, FieldCheck, MonPicker, STATUSES, boostLabel, natureLabel, useModalFill, megaFor, withMega,
  type BuildOption,
} from "./shared.tsx";

interface SpeedState {
  slug: string;
  ability: string;
  nature: string;
  item: string;
  speedSp: number;   // 0..32
  boost: number;     // -6..6
  status: string;
  tailwind: boolean;
  /** A drawer card is authoritative even when it is the deliberately blank Custom card. */
  pinned?: boolean;
}
const EMPTY_SPEED: SpeedState = {
  slug: "", ability: "", nature: "", item: "", speedSp: 32, boost: 0, status: "", tailwind: false,
  pinned: false,
};

function cleanSpeed(s: SpeedState, name: string): SpeedInputDto {
  return {
    name,
    ...(s.nature ? { nature: s.nature } : {}),
    ...(s.ability ? { ability: s.ability } : {}),
    sps: { spe: s.speedSp },
    ...(s.boost ? { boosts: { spe: s.boost } } : {}),
    ...(s.item ? { item: s.item } : {}),
    ...(s.status ? { status: s.status as Status } : {}),
    ...(s.tailwind ? { field: { tailwind: true } } : {}),
  };
}

type Preset = { plus: string; minus: string; neutral: string };
const TIER_KEYS = ["max", "fast", "none", "min"] as const;
type Tier = (typeof TIER_KEYS)[number];
const TIER_LABEL: Record<Tier, "speed.preset.max" | "speed.preset.fast" | "speed.preset.none" | "speed.preset.min"> = {
  max: "speed.preset.max", fast: "speed.preset.fast", none: "speed.preset.none", min: "speed.preset.min",
};

/** The three speed-relevant natures (found by their spe modifier — the dex is the authority). */
function useSpeedNatures(natures: NatureDto[]): Preset {
  return useMemo(() => ({
    plus: natures.find((n) => n.upStat === "spe" && n.downStat !== "spe")?.name ?? "",
    minus: natures.find((n) => n.downStat === "spe" && n.upStat !== "spe")?.name ?? "",
    neutral: natures.find((n) => !n.upStat || n.upStat === n.downStat)?.name ?? "",
  }), [natures]);
}

/** Every Pokémon Champions individual value is fixed at 31. The four tiers therefore differ only
 * by nature and SP: 最速 (+spe, 32), 準速 (neutral, 32), 無振 (neutral, 0), 最慢 (−spe, 0). */
function tierState(slug: string, tier: Tier, p: Preset): SpeedState {
  const c = tier === "max" ? { n: p.plus, sp: 32 }
    : tier === "fast" ? { n: p.neutral, sp: 32 }
    : tier === "none" ? { n: p.neutral, sp: 0 }
    : { n: p.minus, sp: 0 };
  return { ...EMPTY_SPEED, slug, nature: c.n, speedSp: c.sp };
}

/** The two modified lines, both read off MAX investment: the question they answer is "what does the
 * fastest build of this mon reach once the obvious multiplier lands", so a lower tier would not be
 * the line anyone checks. Both go through the engine rather than being multiplied here — the
 * rounding of a Speed modifier is the calculator's fact, not the table's. */
const SCARF = "Choice Scarf";
const MOD_KEYS = ["tailwind", "scarf"] as const;
type Mod = (typeof MOD_KEYS)[number];
const MOD_LABEL: Record<Mod, "speed.tailwind" | "speed.scarf"> = {
  tailwind: "speed.tailwind", scarf: "speed.scarf",
};

function modState(slug: string, mod: Mod, p: Preset): SpeedState {
  const base = tierState(slug, "max", p);
  return mod === "tailwind" ? { ...base, tailwind: true } : { ...base, item: SCARF };
}

function SpeedRow({ label, side, setSide, dex, natures, items, presets, onRemove }: {
  label: string;
  side: SpeedState;
  setSide: Dispatch<SetStateAction<SpeedState>>;
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  presets: Preset;
  onRemove?: () => void;
}) {
  const { lang } = useLang();
  const t = useT();
  const entry = dex.find((e) => e.slug === side.slug);
  const mega = entry?.isMega ? entry : megaFor(side.slug, side.item, dex, items);
  const requiredStone = entry?.isMega
    ? items.find((i) => i.requiredBy?.includes(entry.name)) : undefined;
  useEffect(() => {
    if (requiredStone && side.item !== requiredStone.name) {
      setSide((s) => ({ ...s, item: requiredStone.name }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredStone?.name, side.slug]);

  const preset = (nature: string, speedSp: number) =>
    setSide((s) => ({ ...s, nature, speedSp }));
  const activePreset = TIER_KEYS.find((tier) => {
    const selected = tierState(side.slug, tier, presets);
    return side.nature && side.nature === selected.nature
      && side.speedSp === selected.speedSp;
  });
  const scarfOn = side.item === SCARF;

  return (
    <div className="panel form-panel speed-row mon-config">
      <strong className="side-head">
        <span className="speed-heading-label">{label}
          {mega && <span className="mega-badge" title={displayName(mega, lang)}>MEGA</span>}
        </span>
        {onRemove && <button className="mini-x" onClick={onRemove} aria-label={t("a11y.remove")}>✕</button>}
      </strong>
      <MonPicker idKey={`spd-${label}`} slug={side.slug} dex={dex}
        onSlug={(slug) => setSide((s) => s.slug === slug ? s : { ...EMPTY_SPEED, slug })} />
      <div className="speed-presets">
        <button type="button" className={side.tailwind ? "on" : ""}
          aria-pressed={side.tailwind}
          onClick={() => setSide((s) => ({ ...s, tailwind: !s.tailwind }))}>
          {t("speed.tailwind")}
        </button>
        <button type="button" className={scarfOn ? "on" : ""}
          aria-pressed={scarfOn} disabled={!!entry?.isMega}
          title={entry?.isMega ? t("speed.megaNoScarf") : undefined}
          onClick={() => setSide((s) => ({ ...s, item: s.item === SCARF ? "" : SCARF }))}>
          {t("speed.scarf")}
        </button>
        {TIER_KEYS.map((tier) => {
          const selected = tierState(side.slug, tier, presets);
          return <button key={tier} type="button" className={activePreset === tier ? "on" : ""}
            aria-pressed={activePreset === tier}
            onClick={() => preset(selected.nature, selected.speedSp)}>
            {t(TIER_LABEL[tier])}
          </button>;
        })}
      </div>
      <div className="speed-fields">
        <label>{t("calc.ability")}
          <select value={side.ability}
            onChange={(e) => setSide((s) => ({ ...s, ability: e.target.value }))}>
            <option value="">—</option>
            {entry?.abilities.map((ability) => (
              <option key={ability.name} value={ability.name}>{displayName(ability, lang)}</option>
            ))}
          </select>
        </label>
        <label>{t("calc.nature")}
          <select value={side.nature}
            onChange={(e) => setSide((s) => ({ ...s, nature: e.target.value }))}>
            <option value="">—</option>
            {natures.map((n) => <option key={n.name} value={n.name}>{natureLabel(n, lang)}</option>)}
          </select>
        </label>
        <label>{t("speed.sp")}
          <input type="number" min={0} max={32} className="num" value={side.speedSp}
            onChange={(e) => setSide((s) => ({
              ...s, speedSp: Math.max(0, Math.min(32, Number(e.target.value))) }))} />
        </label>
        <label>{t("speed.boost")}
          <select className="boost-sel" value={side.boost}
            onChange={(e) => setSide((s) => ({ ...s, boost: Number(e.target.value) }))}>
            {BOOST_STAGES.map((n) => <option key={n} value={n}>{boostLabel(n)}</option>)}
          </select>
        </label>
        <label>{t("calc.status")}
          <select value={side.status}
            onChange={(e) => setSide((s) => ({ ...s, status: e.target.value }))}>
            {STATUSES.map((st) => (
              <option key={st} value={st === "Healthy" ? "" : st}>{t(`status.${st}`)}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

interface TierRow {
  rowKey?: string;
  state?: SpeedState;
  slug: string;
  name: string;
  rank: number | null;
  kind: "meta" | "custom" | "mine";
  base?: number;     // base Speed stat (same across every tier of a mon)
  tiers: Partial<Record<Tier, number>>;
  mods: Partial<Record<Mod, number>>;   // max investment under Tailwind / Choice Scarf
  actual?: number;   // custom opponents' real configured speed (Scarf/Tailwind folded)
}

function speedBuildCard(side: SpeedState, entry: DexIndexEntry): BuildCardOption {
  return {
    key: `speed:${entry.slug}:${side.item}:${side.ability}:${side.nature}:${side.speedSp}`,
    source: "custom",
    coverage: null,
    isModal: false,
    set: {
      species: entry.name,
      runForm: entry.isMega ? entry.name : null,
      ability: side.ability || null,
      item: side.item || null,
      nature: side.nature || null,
      moves: null,
      sps: { spe: side.speedSp },
    },
  };
}

export function SpeedTab({ dex, natures, items, onRailApi }: {
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  onRailApi?: (api: CalcRailApi) => void;
}) {
  const { adapter } = useRuntime();
  const t = useT();
  const { lang } = useLang();
  const loadModal = useModalFill();
  const presets = useSpeedNatures(natures);

  const [format, setFormat] = useState<FormatId>("single");
  const [trickRoom, setTrickRoom] = useState(false);
  const [topN, setTopN] = useState(60);
  const [mySides, setMySides] = useState<SpeedState[]>([
    { ...EMPTY_SPEED, slug: "garchomp" },
  ]);
  const [opponents, setOpponents] = useState<SpeedState[]>([
    { ...EMPTY_SPEED, slug: "mimikyu" },
  ]);
  const [rows, setRows] = useState<TierRow[]>([]);
  const [mySpeeds, setMySpeeds] = useState<Array<number | null>>([]);
  const [error, setError] = useState<string | null>(null);
  const [tableTarget, setTableTarget] = useState<CalcRailTarget>("primary");
  const [tableFeedback, setTableFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const ranking = useRanking(format);
  const rankingRows = ranking.status === "ready" ? ranking.data.rows : [];
  const entryOf = (slug: string) => dex.find((e) => e.slug === slug);
  const rankOf = (slug: string) => rankingRows.find((r) => r.slug === slug)?.rank ?? null;

  // Seed new hand-added MY rows at 最速 once the +spe nature is known. Drawer Custom cards are
  // pinned, so deliberately blank cards do not acquire an environment/default nature behind the user.
  useEffect(() => {
    if (presets.plus) setMySides((previous) => {
      let changed = false;
      const next = previous.map((side) => {
        if (side.nature || side.pinned) return side;
        changed = true;
        return { ...side, nature: presets.plus, speedSp: 32 };
      });
      return changed ? next : previous;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets.plus, mySides.length]);

  // Custom opponents auto-fill their highest-share observed build on a fresh pick (Meta fallback
  // only when no aggregate exists). Re-fill on a
  // FORMAT switch ONLY when the row is still bare or still holds its last (unedited) auto-fill — a
  // user-edited opponent (custom nature/item/speedSp) keeps its build instead of being clobbered back
  // to the environment default (parity with DamageTab/TuneTab's autofillSig guard — audit 2026-07-14).
  const speedFillSig = (ability: string, nature: string, item: string, speedSp: number) =>
    JSON.stringify([ability, nature, item, speedSp]);
  const oppFill = useRef<Array<{ key: string; sig: string }>>([]);
  useEffect(() => {
    opponents.forEach((o, i) => {
      if (!o.slug || o.pinned) return;
      const key = `${format}:${o.slug}`;
      const prev = oppFill.current[i];
      if (prev && prev.key === key) return;
      const bare = o.ability === "" && o.nature === "" && o.item === "" && o.speedSp === EMPTY_SPEED.speedSp;
      const refill = bare || (prev !== undefined
        && speedFillSig(o.ability, o.nature, o.item, o.speedSp) === prev.sig);
      oppFill.current[i] = { key, sig: prev?.sig ?? "" };
      if (!refill) return;
      void loadModal(o.slug, format).then((m) => {
        if (!m || oppFill.current[i]?.key !== key) return;
        const sp = m.sps.spe ?? 0;
        setOpponents((prevOpp) => prevOpp.map((x, j) =>
          j === i && x.slug === o.slug && !x.pinned
            ? { ...x, ability: m.ability, nature: m.nature, item: m.item, speedSp: sp } : x));
        oppFill.current[i] = { key, sig: speedFillSig(m.ability, m.nature, m.item, sp) };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, opponents.map((o) => o.slug).join(",")]);

  // The environment table is reference data, so keep it populated as its scope changes. The
  // explicit Calculate action below adds only the user's speed, position, and comparison colours.
  const tableToken = useRef(0);
  // Blank editor rows do not participate in the reference table. Adding several of them should
  // not dispatch the same large speed batch repeatedly before the user picks a species.
  const tableSig = JSON.stringify([format, topN, opponents.filter((side) => side.slug),
    rankingRows.length, presets, dex.length]);
  useEffect(() => {
    // Invalidate an older batch even when the new scope has no rows and exits before requesting.
    const token = ++tableToken.current;
    const custom = opponents.filter((o) => o.slug && entryOf(o.slug));
    const customSlugs = new Set(custom.map((o) => o.slug));
    const base: Array<{ rowKey?: string; slug: string; name: string; rank: number | null; kind: TierRow["kind"];
      state?: SpeedState }> = [];
    custom.forEach((o, index) => base.push({ rowKey: `custom-${index}`,
      slug: o.slug, name: entryOf(o.slug)!.name,
      rank: rankOf(o.slug), kind: "custom", state: o }));
    rankingRows.slice(0, topN).forEach((r) => {
      const e = entryOf(r.slug);
      if (!e || customSlugs.has(r.slug)) return;
      base.push({ slug: r.slug, name: r.name, rank: r.rank, kind: "meta" });
      // Add this mon's mega form(s) as their own rungs — mega Speed differs from the base (e.g.
      // Garchomp 102 → Mega 92), and the ranking only lists the base species.
      dex.filter((m) => m.isMega && m.baseSpecies === e.name).forEach((mg) => {
        if (customSlugs.has(mg.slug)) return;
        base.push({ slug: mg.slug, name: mg.name, rank: r.rank, kind: "meta" });
      });
    });
    if (!base.length) { setRows([]); return; }
    const inputs: SpeedInputDto[] = [];
    const desc: Array<{ row: number; col: Tier | Mod | "actual" }> = [];
    base.forEach((row, ri) => {
      TIER_KEYS.forEach((tier) => {
        inputs.push(cleanSpeed(tierState(row.slug, tier, presets), row.name));
        desc.push({ row: ri, col: tier });
      });
      MOD_KEYS.forEach((mod) => {
        // A Mega form battles holding its stone, so there is no Scarf line to report for it. The
        // cell stays empty rather than showing a speed the form cannot reach.
        if (mod === "scarf" && entryOf(row.slug)?.isMega) return;
        inputs.push(cleanSpeed(modState(row.slug, mod, presets), row.name));
        desc.push({ row: ri, col: mod });
      });
      if (row.kind === "custom" && row.state) {
        {
          const eff = withMega(row.state, dex, items);
          inputs.push(cleanSpeed(eff.state, eff.entry?.name ?? row.name));
        }
        desc.push({ row: ri, col: "actual" });
      }
    });
    // The table can exceed the 240-item batch cap (top-100 + mega rungs × 4 tiers), so fan out in
    // ≤240-item chunks and stitch the results back in order — res[i] still aligns with inputs[i]/desc[i].
    const chunks: SpeedInputDto[][] = [];
    for (let i = 0; i < inputs.length; i += 240) chunks.push(inputs.slice(i, i + 240));
    Promise.all(chunks.map((c) => adapter.speedBatch(c))).then((arrs) => {
      if (token !== tableToken.current) return;
      const res = arrs.flat();
      const out: TierRow[] = base.map((b) => ({ rowKey: b.rowKey, state: b.state,
        slug: b.slug, name: b.name, rank: b.rank,
        kind: b.kind, tiers: {}, mods: {} }));
      res.forEach((r, i) => {
        if (isErrorShape(r)) return;
        const d = desc[i]!;
        out[d.row]!.base = r.baseSpeed;   // identical across a mon's tiers — last write wins, same value
        if (d.col === "actual") out[d.row]!.actual = r.finalSpeed;
        else if (d.col === "tailwind" || d.col === "scarf") out[d.row]!.mods[d.col] = r.finalSpeed;
        else out[d.row]!.tiers[d.col] = r.finalSpeed;
      });
      out.sort((a, b) => (b.tiers.max ?? -1) - (a.tiers.max ?? -1));
      setRows(out);
      setError(null);
    }).catch((e) => {
      console.error("Speed table calculation failed:", e);
      if (token === tableToken.current) { setRows([]); setError(t("calc.error")); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableSig]);

  // Only the fields the calculation READS are in the signature. Format, the row count, the trick-room
  // view and the add-to side all leave it alone, so browsing the table never dispatches a batch; the
  // short debounce then coalesces the keystrokes inside the SP box into one run.
  const mineSig = useMemo(() => JSON.stringify(mySides.map((s) => [
    s.slug, s.ability, s.nature, s.item, s.speedSp, s.boost, s.status, s.tailwind,
  ])), [mySides]);
  const runToken = useRef(0);
  useEffect(() => {
    const token = ++runToken.current;
    const valid = mySides.flatMap((side, index) => {
      const entry = entryOf(side.slug);
      return entry ? [{ side, index, entry }] : [];
    });
    if (!valid.length) { setMySpeeds([]); return; }
    const timer = setTimeout(() => {
      adapter.speedBatch(valid.map(({ side, entry }) => {
        const effective = withMega(side, dex, items);
        return cleanSpeed(effective.state, effective.entry?.name ?? entry.name);
      })).then((result) => {
        if (token !== runToken.current) return;
        const speeds: Array<number | null> = Array.from({ length: mySides.length }, () => null);
        valid.forEach(({ index }, resultIndex) => {
          const row = result[resultIndex];
          speeds[index] = row && !isErrorShape(row) ? row.finalSpeed : null;
        });
        setMySpeeds(speeds);
        setError(null);
      }).catch((e) => {
        console.error("My speed calculations failed:", e);
        if (token === runToken.current) { setMySpeeds([]); setError(t("calc.error")); }
      });
    }, 160);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mineSig, dex.length, items.length]);

  // Cell tone vs every configured MY mon. A definitive colour means all of mine agree. A split
  // verdict deliberately falls back to the neutral cell: it is not one actionable speed relation.
  const hasResult = mySpeeds.some((speed) => speed != null);
  const calculatedMine = useMemo(() => !hasResult ? [] : mySides.flatMap((side, index) => {
    const entry = entryOf(side.slug);
    const speed = mySpeeds[index];
    return entry && speed != null ? [{ side, index, entry, speed }] : [];
  }), [hasResult, mySides, mySpeeds, dex]);
  const cellCls = (v: number | undefined): string => {
    if (v == null || !calculatedMine.length) return "";
    const diffs = calculatedMine.map(({ speed }) => trickRoom ? speed - v : v - speed);
    if (diffs.every((diff) => diff > 0)) return "faster";
    if (diffs.every((diff) => diff < 0)) return "slower";
    if (diffs.every((diff) => diff === 0)) return "tie";
    return "";
  };
  const mySlugs = useMemo(() => new Set(mySides.map((side) => side.slug).filter(Boolean)), [mySides]);
  const opponentRows = useMemo(
    () => mySlugs.size ? rows.filter((row) => row.kind === "custom" || !mySlugs.has(row.slug)) : rows,
    [rows, mySlugs],
  );
  const displayRows = useMemo(() => {
    if (!calculatedMine.length) return rows;
    const mine: TierRow[] = calculatedMine.map(({ entry, speed, index }) => ({
      rowKey: `mine-${index}`,
      slug: entry.slug, name: entry.name, rank: rankOf(entry.slug), kind: "mine",
      state: mySides[index], base: entry.stats.spe, tiers: {}, mods: {}, actual: speed,
    }));
    return [...opponentRows, ...mine].sort((a, b) => {
      const av = a.kind === "mine" ? a.actual : a.tiers.max;
      const bv = b.kind === "mine" ? b.actual : b.tiers.max;
      return (bv ?? -1) - (av ?? -1);
    });
    // rankOf is a cheap lookup over the already-loaded ranking rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, opponentRows, calculatedMine, rankingRows]);

  const addSide = useCallback((target: CalcRailTarget, picked: SpeedState) => {
    const list = target === "primary" ? mySides : opponents;
    const emptyIndex = list.findIndex((candidate) => !candidate.slug);
    if (emptyIndex < 0 && list.length >= 6) {
      return { ok: false as const, reason: "full" as const };
    }
    const next = emptyIndex >= 0
      ? list.map((candidate, index) => index === emptyIndex ? picked : candidate)
      : [...list, picked];
    if (target === "primary") setMySides(next); else setOpponents(next);
    return { ok: true as const };
  }, [mySides, opponents]);

  const addFromTable = (entry: DexIndexEntry, picked: SpeedState) => {
    const result = addSide(tableTarget, picked);
    const side = tableTarget === "primary" ? t("speed.ours") : t("speed.theirs");
    setTableFeedback(result.ok
      ? { ok: true, text: t("calc.rail.added")
        .replace("{name}", displayName(entry, lang)).replace("{side}", side) }
      : { ok: false, text: t("calc.rail.full").replace("{side}", side).replace("{count}", "6") });
  };

  const loadTier = (slug: string, tier: Tier) => {
    const entry = entryOf(slug);
    if (entry) addFromTable(entry, tierState(slug, tier, presets));
  };
  const loadMod = (slug: string, mod: Mod) => {
    const entry = entryOf(slug);
    if (entry) addFromTable(entry, modState(slug, mod, presets));
  };
  const loadActual = (r: TierRow) => {
    const entry = entryOf(r.slug);
    if (r.state && entry) addFromTable(entry, { ...r.state });
  };

  const pickFromRail = useCallback((target: CalcRailTarget, entry: DexIndexEntry,
                                    option: BuildOption | null) => {
    const picked: SpeedState = {
      ...EMPTY_SPEED,
      slug: entry.slug,
      ability: option?.modal.ability ?? "",
      nature: option?.modal.nature ?? "",
      item: option?.modal.item ?? "",
      speedSp: option ? option.modal.sps.spe ?? 0 : EMPTY_SPEED.speedSp,
      pinned: true,
    };
    return addSide(target, picked);
  }, [addSide]);

  const railApi = useMemo<CalcRailApi>(() => ({
    format,
    targets: [
      { id: "primary", label: t("speed.ours") },
      { id: "secondary", label: t("speed.theirs") },
    ],
    pick: pickFromRail,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [format, pickFromRail, lang]);
  useEffect(() => { onRailApi?.(railApi); }, [onRailApi, railApi]);

  return (
    <>
      <div className="speed-side-grid">
        <section className="speed-side-column">
          <div className="defenders-head speed-side-head">
            <h2 className="page-title" style={{ fontSize: 15, margin: 0 }}>{t("speed.ours")}</h2>
            <button className="ghost-btn" disabled={mySides.length >= 6}
              title={mySides.length >= 6 ? t("calc.maxSix") : undefined}
              onClick={() => setMySides((sides) => sides.length >= 6
                ? sides : [...sides, { ...EMPTY_SPEED }])}>
              + {t("speed.addMine")}
            </button>
          </div>
          <div className="speed-side-cards">
            {mySides.map((side, index) => (
              <SpeedRow key={index} label={`${t("speed.ours")} ${index + 1}`}
                side={side}
                setSide={(update) => setMySides((previous) => previous.map((candidate, at) =>
                  at === index
                    ? (typeof update === "function"
                      ? (update as (value: SpeedState) => SpeedState)(candidate) : update)
                    : candidate))}
                dex={dex} natures={natures} items={items} presets={presets}
                onRemove={mySides.length > 1
                  ? () => setMySides((previous) => previous.filter((_, at) => at !== index))
                  : undefined} />
            ))}
          </div>
        </section>
        <section className="speed-side-column">
          <div className="defenders-head speed-side-head">
            <h2 className="page-title" style={{ fontSize: 15, margin: 0 }}>{t("speed.theirs")}</h2>
            <button className="ghost-btn" disabled={opponents.length >= 6}
              title={opponents.length >= 6 ? t("calc.maxSix") : undefined}
              onClick={() => setOpponents((sides) => sides.length >= 6
                ? sides : [...sides, { ...EMPTY_SPEED }])}>
              + {t("speed.addOpponent")}
            </button>
          </div>
          <div className="speed-side-cards">
            {opponents.map((side, index) => (
              <SpeedRow key={index} label={`${t("speed.theirs")} ${index + 1}`} side={side}
                setSide={(update) => setOpponents((previous) => previous.map((candidate, at) =>
                  at === index
                    ? (typeof update === "function"
                      ? (update as (value: SpeedState) => SpeedState)(candidate) : update)
                    : candidate))}
                dex={dex} natures={natures} items={items} presets={presets}
                onRemove={() => setOpponents((previous) => previous.filter((_, at) => at !== index))} />
            ))}
          </div>
        </section>
      </div>

      {error && <div className="notice mono" style={{ marginTop: 14 }}>{error}</div>}

      {/* Format, depth and the Trick Room view scope THIS table and nothing else, so they sit on its
          heading rather than in a command bar above it that also implied a Calculate step. */}
      <div className="speed-tier-head">
        <h2 className="page-title" style={{ fontSize: 15, margin: 0 }}>{t("speed.env")}</h2>
        <span className="speed-tier-scope">
          <FormatTabs format={format} onChange={setFormat} />
          <label><span>{t("speed.topN")}</span>
            <select value={topN} onChange={(e) => setTopN(Number(e.target.value))}>
              {[30, 60, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <FieldCheck label={t("speed.trickRoom")} checked={trickRoom} onChange={setTrickRoom} />
        </span>
        {hasResult && (
          <span className="tier-legend">
            <span className="lg faster">{t("speed.legendFaster")}</span>
            <span className="lg slower">{t("speed.legendSlower")}</span>
          </span>
        )}
        <span className="muted speed-tier-hint">{t("speed.load")}</span>
        <span className="calc-rail-target speed-table-target" role="group"
          aria-label={t("calc.rail.target")}>
          <button type="button" className={tableTarget === "primary" ? "on" : ""}
            aria-pressed={tableTarget === "primary"}
            onClick={() => { setTableTarget("primary"); setTableFeedback(null); }}>
            {t("speed.ours")}
          </button>
          <button type="button" className={tableTarget === "secondary" ? "on" : ""}
            aria-pressed={tableTarget === "secondary"}
            onClick={() => { setTableTarget("secondary"); setTableFeedback(null); }}>
            {t("speed.theirs")}
          </button>
        </span>
      </div>
      {tableFeedback && (
        <div className={`calc-rail-feedback speed-table-feedback ${tableFeedback.ok ? "ok" : "error"}`}
          role="status">{tableFeedback.text}</div>
      )}
      {rows.length > 0 ? (
        <div className="panel speed-tier-wrap">
          <div className="speed-tier-scroll">
            <table className="speed-tier">
              <thead>
                <tr>
                  <th className="corner">{t("ranking.pokemon")}</th>
                  <th className="base-col">{t("speed.baseSpe")}</th>
                  <th className="actual-col">{t("speed.actual")}</th>
                  {MOD_KEYS.map((mod) => (
                    <th key={mod} className="mod-col" title={t("speed.modifiedMaxHint")}>
                      {t(MOD_LABEL[mod])}
                    </th>
                  ))}
                  {TIER_KEYS.map((tier) => <th key={tier}>{t(TIER_LABEL[tier])}</th>)}
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r) => {
                  const e = entryOf(r.slug);
                  const build = e && r.state ? speedBuildCard(r.state, e) : null;
                  const identity = <>
                    {e && <GameImage assetKey={e.key} role="dense"
                      alt={displayName(e, lang)} className="mini" />}
                    <span className="nm">{e ? displayName(e, lang) : r.name}</span>
                    {r.rank != null && <span className="rk num">#{r.rank}</span>}
                    {r.kind === "mine" && <span className="rung-you">{t("speed.you")}</span>}
                    {r.kind === "custom" && <span className="rung-you custom">{t("speed.customTag")}</span>}
                  </>;
                  return (
                    <tr key={r.rowKey ?? `${r.slug}-${r.kind}`} className={r.kind}>
                      <th className="tier-mon" onClick={() => r.kind !== "mine" && loadTier(r.slug, "max")}
                        role={r.kind === "mine" ? undefined : "button"}
                        tabIndex={r.kind === "mine" ? undefined : 0}
                        onKeyDown={(event) => {
                          if (r.kind !== "mine" && (event.key === "Enter" || event.key === " ")) {
                            event.preventDefault(); loadTier(r.slug, "max");
                          }
                        }}
                        title={r.kind === "mine" ? undefined : t("speed.load")}>
                        {build ? (
                          <EntityHover kind="spread" name="" link={false} passive
                            previewAddon={<BuildSetSummary option={build} index={0} />}>
                            <span className="speed-tier-identity">{identity}</span>
                          </EntityHover>
                        ) : e ? (
                          <EntityHover kind="pokemon" name={e.name} link={false} passive>
                            <span className="speed-tier-identity">{identity}</span>
                          </EntityHover>
                        ) : identity}
                      </th>
                      <td className="base-col"><span className="speed-value">{r.base ?? "—"}</span></td>
                      <td className={`spd actual-col ${cellCls(r.actual)}`}
                        role={r.kind === "mine" ? undefined : "button"}
                        tabIndex={r.kind === "mine" ? undefined : 0}
                        onKeyDown={(event) => {
                          if (r.kind !== "mine" && (event.key === "Enter" || event.key === " ")) {
                            event.preventDefault(); loadActual(r);
                          }
                        }}
                        onClick={() => r.kind !== "mine" && loadActual(r)}>
                        {r.actual != null && <span className="speed-value">{r.actual}</span>}
                      </td>
                      {MOD_KEYS.map((mod) => (
                        <td key={mod} className={`spd mod-col ${cellCls(r.mods[mod])}`}
                          role={r.kind === "mine" || r.mods[mod] == null ? undefined : "button"}
                          tabIndex={r.kind === "mine" || r.mods[mod] == null ? undefined : 0}
                          onKeyDown={(event) => {
                            if (r.kind !== "mine" && r.mods[mod] != null
                              && (event.key === "Enter" || event.key === " ")) {
                              event.preventDefault(); loadMod(r.slug, mod);
                            }
                          }}
                          onClick={() => r.kind !== "mine" && r.mods[mod] != null
                            && loadMod(r.slug, mod)}>
                          {r.mods[mod] != null && <span className="speed-value">{r.mods[mod]}</span>}
                        </td>
                      ))}
                      {TIER_KEYS.map((tier) => (
                        <td key={tier} className={`spd ${cellCls(r.tiers[tier])}`}
                          role={r.kind === "mine" ? undefined : "button"}
                          tabIndex={r.kind === "mine" ? undefined : 0}
                          onKeyDown={(event) => {
                            if (r.kind !== "mine" && (event.key === "Enter" || event.key === " ")) {
                              event.preventDefault(); loadTier(r.slug, tier);
                            }
                          }}
                          onClick={() => r.kind !== "mine" && loadTier(r.slug, tier)}>
                          <span className="speed-value">{r.tiers[tier] ?? "—"}</span>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        !error && (ranking.status === "loading"
          ? <div className="spinner">{t("state.loading")}</div>
          : <div className="notice">{t("speed.empty")}</div>)
      )}
    </>
  );
}
