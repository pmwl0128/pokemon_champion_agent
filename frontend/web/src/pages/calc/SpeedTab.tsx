/** Speed line: MY mon (the query slot, with 最速/準速/無振/最慢 presets) plotted against a live
 * metagame speed-tier TABLE — every top-N usage mon shown at ALL FOUR investment tiers at once
 * (design ref: the gamewith / nerd-of-now speed tools). Each speed cell is coloured against my mon:
 * red = that tier outspeeds me, green = I outspeed it. Click any cell to load that mon@tier into the
 * query slot. Custom opponents get their own rows with a real "actual" speed (Scarf/Tailwind folded). */
import type {
  FormatId, NatureDto, SpeedInputDto, Status,
} from "@pokemon-champions/protocol";
import { isErrorShape } from "@pokemon-champions/protocol";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { EntityHover } from "../../components/EntityHover.tsx";
import { FormatTabs } from "../../components/FormatTabs.tsx";
import { GameImage } from "../../components/GameImage.tsx";
import { displayName, useLang, useT } from "../../i18n.ts";
import { type ItemRef } from "../../runtime/projection.ts";
import { useRanking } from "../../hooks.ts";
import { useRuntime } from "../../runtime/context.tsx";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import {
  BOOST_STAGES, FieldCheck, MonPicker, STATUSES, boostLabel, natureLabel, useModalFill, ItemCombo, megaFor, withMega,
} from "./shared.tsx";

interface SpeedState {
  slug: string;
  nature: string;
  item: string;
  speedSp: number;   // 0..32
  speedIv: number;   // 0..31
  boost: number;     // -6..6
  status: string;
  tailwind: boolean;
}
const EMPTY_SPEED: SpeedState = {
  slug: "", nature: "", item: "", speedSp: 32, speedIv: 31, boost: 0, status: "", tailwind: false,
};

function cleanSpeed(s: SpeedState, name: string): SpeedInputDto {
  return {
    name,
    ...(s.nature ? { nature: s.nature } : {}),
    sps: { spe: s.speedSp },
    ...(s.speedIv !== 31 ? { ivs: { spe: s.speedIv } } : {}),
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

/** The SpeedState for one investment tier: 最速 (+spe, 32/31), 準速 (neutral, 32/31),
 * 無振 (neutral, 0/31), 最慢 (−spe, 0/0). */
function tierState(slug: string, tier: Tier, p: Preset): SpeedState {
  const c = tier === "max" ? { n: p.plus, sp: 32, iv: 31 }
    : tier === "fast" ? { n: p.neutral, sp: 32, iv: 31 }
    : tier === "none" ? { n: p.neutral, sp: 0, iv: 31 }
    : { n: p.minus, sp: 0, iv: 0 };
  return { ...EMPTY_SPEED, slug, nature: c.n, speedSp: c.sp, speedIv: c.iv };
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
  const mega = megaFor(side.slug, side.item, dex, items);
  const entry = dex.find((e) => e.slug === side.slug);
  const requiredStone = entry?.isMega
    ? items.find((i) => i.requiredBy?.includes(entry.name)) : undefined;
  useEffect(() => {
    if (requiredStone && side.item !== requiredStone.name) {
      setSide((s) => ({ ...s, item: requiredStone.name }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredStone?.name, side.slug]);

  const preset = (nature: string, speedSp: number, speedIv: number) =>
    setSide((s) => ({ ...s, nature, speedSp, speedIv }));

  return (
    <div className="panel form-panel speed-row mon-config">
      <strong className="side-head">
        {label}
        {mega && <span className="mega-badge" title={displayName(mega, lang)}>MEGA</span>}
        {onRemove && <button className="mini-x" onClick={onRemove} aria-label={t("a11y.remove")}>✕</button>}
      </strong>
      <MonPicker idKey={`spd-${label}`} slug={side.slug} dex={dex}
        displayEntry={mega ?? undefined}
        onSlug={(slug) => setSide((s) => ({ ...s, slug }))} />
      <div className="speed-presets">
        <button onClick={() => preset(presets.plus, 32, 31)}>{t("speed.preset.max")}</button>
        <button onClick={() => preset(presets.neutral, 32, 31)}>{t("speed.preset.fast")}</button>
        <button onClick={() => preset(presets.neutral, 0, 31)}>{t("speed.preset.none")}</button>
        <button onClick={() => preset(presets.minus, 0, 0)}>{t("speed.preset.min")}</button>
      </div>
      <div className="speed-fields">
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
        <label>{t("speed.iv")}
          <input type="number" min={0} max={31} className="num" value={side.speedIv}
            onChange={(e) => setSide((s) => ({
              ...s, speedIv: Math.max(0, Math.min(31, Number(e.target.value))) }))} />
        </label>
        <label>{t("speed.boost")}
          <select className="boost-sel" value={side.boost}
            onChange={(e) => setSide((s) => ({ ...s, boost: Number(e.target.value) }))}>
            {BOOST_STAGES.map((n) => <option key={n} value={n}>{boostLabel(n)}</option>)}
          </select>
        </label>
        <label>{t("calc.item")}
          <ItemCombo idKey={`spd-${label}`} value={side.item} items={items}
            disabled={!!requiredStone}
            onChange={(item) => setSide((s) => ({ ...s, item }))} />
        </label>
        <label>{t("calc.status")}
          <select value={side.status}
            onChange={(e) => setSide((s) => ({ ...s, status: e.target.value }))}>
            {STATUSES.map((st) => (
              <option key={st} value={st === "Healthy" ? "" : st}>{t(`status.${st}`)}</option>
            ))}
          </select>
        </label>
        <FieldCheck label={t("speed.tailwind")} checked={side.tailwind}
          onChange={(v) => setSide((s) => ({ ...s, tailwind: v }))} />
      </div>
    </div>
  );
}

interface TierRow {
  slug: string;
  name: string;
  rank: number | null;
  kind: "meta" | "custom" | "mine";
  base?: number;     // base Speed stat (same across every tier of a mon)
  tiers: Partial<Record<Tier, number>>;
  actual?: number;   // custom opponents' real configured speed (Scarf/Tailwind folded)
}

export function SpeedTab({ dex, natures, items }: {
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
}) {
  const { adapter } = useRuntime();
  const t = useT();
  const { lang } = useLang();
  const loadModal = useModalFill();
  const presets = useSpeedNatures(natures);

  const [format, setFormat] = useState<FormatId>("single");
  const [trickRoom, setTrickRoom] = useState(false);
  const [topN, setTopN] = useState(60);
  const [mySide, setMySide] = useState<SpeedState>({ ...EMPTY_SPEED, slug: "garchomp" });
  const [opponents, setOpponents] = useState<SpeedState[]>([]);
  const [rows, setRows] = useState<TierRow[]>([]);
  const [mySpeed, setMySpeed] = useState<number | null>(null);
  const [calculatedSig, setCalculatedSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ranking = useRanking(format);
  const rankingRows = ranking.status === "ready" ? ranking.data.rows : [];
  const entryOf = (slug: string) => dex.find((e) => e.slug === slug);
  const rankOf = (slug: string) => rankingRows.find((r) => r.slug === slug)?.rank ?? null;

  // Seed MY mon at 最速 once the +spe nature is known (my spread is mine — never meta-overwritten).
  useEffect(() => {
    if (presets.plus && !mySide.nature) {
      setMySide((s) => ({ ...s, nature: presets.plus, speedSp: 32, speedIv: 31 }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets.plus]);

  // Custom opponents auto-fill their meta-standard speed investment on a fresh pick. Re-fill on a
  // FORMAT switch ONLY when the row is still bare or still holds its last (unedited) auto-fill — a
  // user-edited opponent (custom nature/item/speedSp) keeps its build instead of being clobbered back
  // to the meta standard (parity with DamageTab/TuneTab's autofillSig guard — audit 2026-07-14).
  const speedFillSig = (nature: string, item: string, speedSp: number) =>
    JSON.stringify([nature, item, speedSp]);
  const oppFill = useRef<Array<{ key: string; sig: string }>>([]);
  useEffect(() => {
    opponents.forEach((o, i) => {
      if (!o.slug) return;
      const key = `${format}:${o.slug}`;
      const prev = oppFill.current[i];
      if (prev && prev.key === key) return;
      const bare = o.nature === "" && o.item === "" && o.speedSp === EMPTY_SPEED.speedSp;
      const refill = bare || (prev !== undefined && speedFillSig(o.nature, o.item, o.speedSp) === prev.sig);
      oppFill.current[i] = { key, sig: prev?.sig ?? "" };
      if (!refill) return;
      void loadModal(o.slug, format).then((m) => {
        if (!m) return;
        const sp = m.sps.spe ?? 0;
        setOpponents((prevOpp) => prevOpp.map((x, j) =>
          j === i ? { ...x, nature: m.nature, item: m.item, speedSp: sp } : x));
        oppFill.current[i] = { key, sig: speedFillSig(m.nature, m.item, sp) };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, opponents.map((o) => o.slug).join(",")]);

  // The environment table is reference data, so keep it populated as its scope changes. The
  // explicit Calculate action below adds only the user's speed, position, and comparison colours.
  const tableToken = useRef(0);
  const tableSig = JSON.stringify([format, topN, opponents, rankingRows.length, presets, dex.length]);
  useEffect(() => {
    // Invalidate an older batch even when the new scope has no rows and exits before requesting.
    const token = ++tableToken.current;
    const custom = opponents.filter((o) => o.slug && entryOf(o.slug));
    const customSlugs = new Set(custom.map((o) => o.slug));
    const base: Array<{ slug: string; name: string; rank: number | null; kind: TierRow["kind"];
      state?: SpeedState }> = [];
    custom.forEach((o) => base.push({ slug: o.slug, name: entryOf(o.slug)!.name,
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
    const desc: Array<{ row: number; col: Tier | "actual" }> = [];
    base.forEach((row, ri) => {
      TIER_KEYS.forEach((tier) => {
        inputs.push(cleanSpeed(tierState(row.slug, tier, presets), row.name));
        desc.push({ row: ri, col: tier });
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
      const out: TierRow[] = base.map((b) => ({ slug: b.slug, name: b.name, rank: b.rank,
        kind: b.kind, tiers: {} }));
      res.forEach((r, i) => {
        if (isErrorShape(r)) return;
        const d = desc[i]!;
        out[d.row]!.base = r.baseSpeed;   // identical across a mon's tiers — last write wins, same value
        if (d.col === "actual") out[d.row]!.actual = r.finalSpeed;
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

  const querySig = JSON.stringify([format, trickRoom, topN, mySide, opponents]);
  const runToken = useRef(0);
  const run = async () => {
    const mine = entryOf(mySide.slug);
    if (!mine || ranking.status !== "ready") return;
    const token = ++runToken.current;
    const submittedSig = querySig;
    setBusy(true);
    setError(null);
    const myEff = withMega(mySide, dex, items);
    try {
      const result = await adapter.speedBatch([
        cleanSpeed(myEff.state, myEff.entry?.name ?? mine.name),
      ]);
      if (token !== runToken.current) return;
      const mineRow = result[0];
      setMySpeed(mineRow && !isErrorShape(mineRow) ? mineRow.finalSpeed : null);
      setCalculatedSig(submittedSig);
    } catch (e) {
      console.error("My speed calculation failed:", e);
      if (token === runToken.current) {
        setMySpeed(null);
        setCalculatedSig(null);
        setError(t("calc.error"));
      }
    } finally {
      if (token === runToken.current) setBusy(false);
    }
  };

  // Cell tone vs my mon (Trick Room flips it: the slower mon moves first).
  const hasResult = mySpeed != null && calculatedSig === querySig;
  const cellCls = (v: number | undefined): string => {
    if (v == null || !hasResult || mySpeed == null) return "";
    const diff = trickRoom ? mySpeed - v : v - mySpeed;
    return diff > 0 ? "faster" : diff < 0 ? "slower" : "tie";
  };
  const myEntry = entryOf(mySide.slug);
  const opponentRows = useMemo(
    () => myEntry ? rows.filter((r) => r.slug !== myEntry.slug) : rows,
    [rows, myEntry?.slug],
  );
  const outspeedMax = !hasResult ? 0
    : opponentRows.filter((r) => r.tiers.max != null && cellCls(r.tiers.max) === "slower").length;
  const displayRows = useMemo(() => {
    if (!hasResult || mySpeed == null || !myEntry) return rows;
    const mine: TierRow = {
      slug: myEntry.slug, name: myEntry.name, rank: rankOf(myEntry.slug), kind: "mine",
      base: myEntry.stats.spe, tiers: {}, actual: mySpeed,
    };
    return [...opponentRows, mine].sort((a, b) => {
      const av = a.kind === "mine" ? a.actual : a.tiers.max;
      const bv = b.kind === "mine" ? b.actual : b.tiers.max;
      return (bv ?? -1) - (av ?? -1);
    });
    // rankOf is a cheap lookup over the already-loaded ranking rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, opponentRows, hasResult, mySpeed, myEntry?.slug]);

  const loadTier = (slug: string, tier: Tier) => setMySide(tierState(slug, tier, presets));
  const loadActual = (r: TierRow) => {
    const o = opponents.find((x) => x.slug === r.slug);
    if (o) setMySide({ ...o });
  };

  return (
    <>
      <SpeedRow label={t("speed.myMon")} side={mySide} setSide={setMySide} dex={dex}
        natures={natures} items={items} presets={presets} />

      <div className="panel form-panel" style={{ marginTop: 14 }}>
        <div className="field-row">
          <div className="field-controls">
            <FormatTabs format={format} onChange={setFormat} />
            <label>{t("speed.topN")}
              <select value={topN} onChange={(e) => setTopN(Number(e.target.value))}>
                {[30, 60, 100].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <FieldCheck label={t("speed.trickRoom")} checked={trickRoom} onChange={setTrickRoom} />
          </div>
          <button className="primary-btn" onClick={() => void run()}
            disabled={busy || !mySide.slug || ranking.status !== "ready"}>
            {busy ? t("state.loading") : t("calc.run")}
          </button>
        </div>
      </div>

      <div className="defenders-head">
        <h2 className="page-title" style={{ fontSize: 15, margin: 0 }}>{t("speed.custom")}</h2>
        <button className="ghost-btn" onClick={() => setOpponents((o) => [...o, { ...EMPTY_SPEED }])}>
          + {t("speed.addOpponent")}
        </button>
      </div>
      {opponents.length > 0 && (
        <div className="defenders-grid">
          {opponents.map((o, i) => (
            <SpeedRow key={i} label={`${t("matchup.opponent")} ${i + 1}`} side={o}
              setSide={(u) => setOpponents((prev) => prev.map((x, j) =>
                j === i ? (typeof u === "function" ? (u as (s: SpeedState) => SpeedState)(x) : u) : x))}
              dex={dex} natures={natures} items={items} presets={presets}
              onRemove={() => setOpponents((prev) => prev.filter((_, j) => j !== i))} />
          ))}
        </div>
      )}

      {error && <div className="notice mono" style={{ marginTop: 14 }}>{error}</div>}

      <div className="speed-tier-head">
        <h2 className="page-title" style={{ fontSize: 15, margin: 0 }}>{t("speed.env")}</h2>
        <span className="tier-legend">
          {hasResult && <span className="lg faster">{t("speed.legendFaster")}</span>}
          {hasResult && <span className="lg slower">{t("speed.legendSlower")}</span>}
          <span className="muted">· {t("speed.load")}</span>
        </span>
        {hasResult && mySpeed != null && (
          <span className="speed-summary">
            {t("speed.mySpeed")} {mySpeed}
            <span className="muted">
              {t("speed.summary").replace("{n}", String(outspeedMax)).replace("{m}", String(opponentRows.length))}
            </span>
          </span>
        )}
      </div>
      {rows.length > 0 ? (
        <div className="panel speed-tier-wrap">
          <div className="speed-tier-scroll">
            <table className="speed-tier">
              <thead>
                <tr>
                  <th className="corner">{t("ranking.pokemon")}</th>
                  <th className="base-col">{t("speed.baseSpe")}</th>
                  {TIER_KEYS.map((tier) => <th key={tier}>{t(TIER_LABEL[tier])}</th>)}
                  <th className="actual-col">{t("speed.actual")}</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r) => {
                  const e = entryOf(r.slug);
                  return (
                    <tr key={`${r.slug}-${r.kind}`} className={r.kind}>
                      <th className="tier-mon" onClick={() => r.kind !== "mine" && loadTier(r.slug, "max")}
                        role={r.kind === "mine" ? undefined : "button"}
                        tabIndex={r.kind === "mine" ? undefined : 0}
                        onKeyDown={(event) => {
                          if (r.kind !== "mine" && (event.key === "Enter" || event.key === " ")) {
                            event.preventDefault(); loadTier(r.slug, "max");
                          }
                        }}
                        title={r.kind === "mine" ? undefined : t("speed.load")}>
                        {e && <GameImage assetKey={e.key} role="dense"
                          alt={displayName(e, lang)} className="mini" />}
                        {e ? (
                          <EntityHover kind="pokemon" name={e.name} link={false}>
                            <span className="nm">{displayName(e, lang)}</span>
                          </EntityHover>
                        ) : <span className="nm">{r.name}</span>}
                        {r.rank != null && <span className="rk num">#{r.rank}</span>}
                        {r.kind === "mine" && <span className="rung-you">{t("speed.you")}</span>}
                        {r.kind === "custom" && <span className="rung-you custom">{t("speed.customTag")}</span>}
                      </th>
                      <td className="base-col"><span className="speed-value">{r.base ?? "—"}</span></td>
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
