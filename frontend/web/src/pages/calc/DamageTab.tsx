/** Damage matrix: ONE attacker's several moves × several hypothetical defenders, computed in a
 * single fault-isolated batch (design ref: the gamewith calc's "add hypothetical enemy" flow).
 * Rows = defenders, columns = the attacker's picked moves, each cell a damage band + KO bucket;
 * clicking a cell opens its full roll/KO detail. */
import type {
  DamageBatchResultDto, DamageRequestDto, FieldDto, FormatId, LearnsetDto, MoveCategory,
  NatureDto, Terrain, TypeName, Weather,
} from "@pokemon-champions/protocol";
import { TERRAINS, WEATHERS, isErrorShape } from "@pokemon-champions/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { EntityHover } from "../../components/EntityHover.tsx";
import { FormatTabs } from "../../components/FormatTabs.tsx";
import { GameImage } from "../../components/GameImage.tsx";
import { CategoryBadge, TypeBadge } from "../../components/TypeBadge.tsx";
import { useAsync } from "../../hooks.ts";
import { displayName, useLang, useT } from "../../i18n.ts";
import { useDamageText } from "../../lib/damageText.tsx";
import { koLabel, koTone } from "../../lib/ko.ts";
import { takeDamageFill } from "../../lib/team.ts";
import { loadLearnset, type ItemRef } from "../../runtime/projection.ts";
import { useRuntime } from "../../runtime/context.tsx";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import {
  ATTACKER_AURAS, DEFENDER_AURAS, EMPTY_SIDE, FieldCheck, SideForm, autofillSig, cleanSide, modalSig,
  sideIsBare, useModalFill, withMega, type SideState,
} from "./shared.tsx";

interface Matrix {
  rows: DexIndexEntry[];
  cols: Array<{ move: string; type: TypeName; category: MoveCategory }>;
  results: DamageBatchResultDto;
}

export function DamageTab({ dex, natures, items }: {
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
}) {
  const { adapter } = useRuntime();
  const t = useT();
  const damageText = useDamageText();
  const { lang } = useLang();
  const loadModal = useModalFill();

  // Deep-link hand-off (design §13): a battery/diagnose fact opens this tab with the
  // opponent as the attacker (its set auto-fills below), MY member's real build as the
  // defender, and the threatening move pinned once the learnset arrives.
  const fill = useRef(takeDamageFill()).current;
  const pinnedMoves = useRef<string[] | null>(
    fill?.moves?.length ? fill.moves : fill?.move ? [fill.move] : null);

  const [attacker, setAttacker] = useState<SideState>(
    fill?.attacker
      ? { ...EMPTY_SIDE, slug: fill.attacker.slug,
          ability: fill.attacker.ability ?? "", item: fill.attacker.item ?? "",
          nature: fill.attacker.nature ?? "",
          sps: (fill.attacker.sps ?? {}) as SideState["sps"] }
      : { ...EMPTY_SIDE, slug: fill?.attackerSlug ?? "garchomp" });
  const [defenders, setDefenders] = useState<SideState[]>(
    fill?.defender
      ? [{ ...EMPTY_SIDE, slug: fill.defender.slug,
           ability: fill.defender.ability ?? "", item: fill.defender.item ?? "",
           nature: fill.defender.nature ?? "",
           sps: (fill.defender.sps ?? {}) as SideState["sps"] }]
      : [{ ...EMPTY_SIDE, slug: "mimikyu" }, { ...EMPTY_SIDE, slug: "garchomp" }]);
  const [selectedMoves, setSelectedMoves] = useState<string[]>([]);
  const [format, setFormat] = useState<FormatId>(fill?.format ?? "single");
  const [weather, setWeather] = useState<Weather | "">("");
  const [terrain, setTerrain] = useState<Terrain | "">("");
  const [reflect, setReflect] = useState(false);
  const [lightScreen, setLightScreen] = useState(false);
  const [auras, setAuras] = useState<Record<string, boolean>>({});   // doubles partner side flags
  const [busy, setBusy] = useState(false);
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cell, setCell] = useState<{ r: number; c: number } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const attackerLearnset = useAsync<LearnsetDto | null>(
    () => (attacker.slug ? loadLearnset(attacker.slug) : Promise.resolve(null)),
    [attacker.slug]);

  const damagingMoves = useMemo(() => {
    if (attackerLearnset.status !== "ready" || !attackerLearnset.data) return [];
    return attackerLearnset.data.moves.filter((m) => m.category !== "Status");
  }, [attackerLearnset]);

  // Auto-fill the attacker's standard build (ability/item/nature/SP) + top-4 usage moves whenever the
  // attacker or format changes. Re-fill when the side is bare OR still holds its last (unedited)
  // auto-fill — the latter is what makes a FORMAT switch update the build instead of freezing the other
  // format's set (a doubles Garchomp kept singles Focus Sash/moves before — audit 2026-07-14). A
  // user-edited or swapped-in side has a different signature and is left untouched.
  const atkFill = useRef<{ key: string; sig: string }>({ key: "", sig: "" });
  useEffect(() => {
    if (!attacker.slug) return;
    const key = `${format}:${attacker.slug}`;
    if (atkFill.current.key === key) return;
    const refill = sideIsBare(attacker)
      || autofillSig(attacker, selectedMoves) === atkFill.current.sig;
    atkFill.current = { key, sig: atkFill.current.sig };
    if (!refill) return;
    let cancel = false;
    void loadModal(attacker.slug, format).then((m) => {
      if (cancel || !m) return;
      setAttacker((s) => ({ ...s, ability: m.ability, item: m.item, nature: m.nature, sps: m.sps }));
      // Deep-linked moves win over the modal move set — they ARE the facts being verified.
      const pinned = pinnedMoves.current;
      const nextMoves = pinned ?? (m.moves.length ? m.moves : selectedMoves);
      if (pinned || m.moves.length) setSelectedMoves(nextMoves);
      if (pinned) pinnedMoves.current = null;
      atkFill.current = { key, sig: modalSig(m, nextMoves) };
    });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attacker.slug, format]);

  // A new attacker species invalidates the picked moves (they may not exist on the new learnset);
  // the fill / fallback effects repopulate from the new mon.
  useEffect(() => { setSelectedMoves([]); }, [attacker.slug]);

  // Same for each defender (keyed by index): bare or unedited-auto-fill re-fills on a format switch;
  // a configured/swapped-in defender keeps its build (defenders pick no moves, so the sig omits them).
  const defFill = useRef<Array<{ key: string; sig: string }>>([]);
  useEffect(() => {
    defenders.forEach((d, i) => {
      if (!d.slug) return;
      const key = `${format}:${d.slug}`;
      const prev = defFill.current[i];
      if (prev && prev.key === key) return;
      const refill = sideIsBare(d) || (prev !== undefined && autofillSig(d) === prev.sig);
      defFill.current[i] = { key, sig: prev?.sig ?? "" };
      if (!refill) return;
      void loadModal(d.slug, format).then((m) => {
        if (!m) return;
        setDefenders((prevD) => prevD.map((x, j) =>
          j === i ? { ...x, ability: m.ability, item: m.item, nature: m.nature, sps: m.sps } : x));
        defFill.current[i] = { key, sig: modalSig(m, []) };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, defenders.map((d) => d.slug).join(",")]);

  // Fallback for an UNRANKED attacker (no modal moves): the deep-linked moves if pinned,
  // else its first learnset moves.
  useEffect(() => {
    if (!selectedMoves.length && damagingMoves.length) {
      const pinned = pinnedMoves.current;
      const usable = pinned?.filter((mv) => damagingMoves.some((m) => m.name === mv));
      if (usable?.length) {
        pinnedMoves.current = null;
        setSelectedMoves(usable);
        return;
      }
      setSelectedMoves(damagingMoves.slice(0, 4).map((m) => m.name));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [damagingMoves]);

  const entryOf = (slug: string) => dex.find((e) => e.slug === slug);
  const toggleMove = (name: string) => setSelectedMoves((prev) =>
    prev.includes(name) ? prev.filter((m) => m !== name) : [...prev, name]);

  // Swap this defender with the attacker (compute the reverse hit). Both sides keep their tuned
  // build (the fill effects skip a non-bare side); the attacker's moves refill from its new learnset.
  const swapWithAttacker = (i: number) => {
    const d = defenders[i]!;
    const a = attacker;
    setAttacker(d);
    setDefenders((prev) => prev.map((x, j) => (j === i ? a : x)));
  };

  const run = async () => {
    const a = entryOf(attacker.slug);
    if (!a) return;
    const defSides = defenders.filter((d) => entryOf(d.slug));
    const rows = defSides.map((d) => entryOf(d.slug)!);
    const cols = selectedMoves
      .map((mv) => damagingMoves.find((m) => m.name === mv))
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => ({ move: m.name, type: m.type, category: m.category }));
    if (!rows.length || !cols.length) return;
    // The field is identical for every cell of the grid — build it once.
    const attackerSide: Record<string, boolean> = {};
    for (const [flag] of ATTACKER_AURAS) if (auras[flag]) attackerSide[flag] = true;
    const defenderSide: Record<string, boolean> = {};
    if (reflect) defenderSide.reflect = true;
    if (lightScreen) defenderSide.light_screen = true;
    for (const [flag] of DEFENDER_AURAS) if (auras[flag]) defenderSide[flag] = true;
    const field: FieldDto = {
      format,
      ...(weather ? { weather } : {}),
      ...(terrain ? { terrain } : {}),
      ...(Object.keys(attackerSide).length ? { attackerSide } : {}),
      ...(Object.keys(defenderSide).length ? { defenderSide } : {}),
    };
    // Held Mega stones compute as the Mega form (the engine does not auto-mega; withMega).
    const aEff = withMega(attacker, dex, items);
    const dEffs = defSides.map((d) => withMega(d, dex, items));
    const items_: DamageRequestDto[] = [];
    for (let ri = 0; ri < rows.length; ri++) {
      for (const col of cols) {
        items_.push({
          attacker: cleanSide(aEff.state, aEff.entry?.name ?? a.name),
          defender: cleanSide(dEffs[ri]!.state, dEffs[ri]!.entry?.name ?? rows[ri]!.name),
          move: col.move,
          field,
        });
      }
    }
    if (items_.length > 240) { setError(t("calc.tooMany")); return; }
    setBusy(true); setError(null); setCell(null);
    try {
      const results = await adapter.damageBatch(items_);
      setMatrix({ rows, cols, results });
    } catch (e) {
      console.error("Damage calculation failed:", e);
      setMatrix(null); setError(t("calc.error"));
    } finally {
      setBusy(false);
    }
  };

  const selected = matrix && cell
    ? matrix.results[cell.r * matrix.cols.length + cell.c] : null;
  const selectedRow = matrix && cell ? matrix.rows[cell.r] : null;
  const selectedCol = matrix && cell ? matrix.cols[cell.c] : null;
  const selectedAttacker = entryOf(attacker.slug);

  useEffect(() => {
    if (!matrix) return;
    const frame = requestAnimationFrame(() => resultRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    }));
    return () => cancelAnimationFrame(frame);
  }, [matrix]);

  useEffect(() => {
    if (!cell) return;
    const frame = requestAnimationFrame(() => detailRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    }));
    return () => cancelAnimationFrame(frame);
  }, [cell]);

  return (
    <>
      <SideForm label={t("calc.attacker")} side={attacker} setSide={setAttacker}
        dex={dex} natures={natures} items={items} />

      <section className="panel move-picker">
        <h2>{t("calc.moves")}</h2>
        <div className="move-chips">
          {damagingMoves.length === 0 && <span className="muted">{t("calc.noMoves")}</span>}
          {damagingMoves.map((m) => (
            <button key={m.name} className={`move-chip${selectedMoves.includes(m.name) ? " on" : ""}`}
              onClick={() => toggleMove(m.name)}>
              <EntityHover kind="move" name={m.name} link={false}>
                <span className="p-inner">
                  <TypeBadge type={m.type} iconOnly />
                  {displayName(m, lang)}{m.power != null ? ` ${m.power}` : ""}
                </span>
              </EntityHover>
            </button>
          ))}
        </div>
      </section>

      <div className="panel form-panel" style={{ marginTop: 14 }}>
        <div className="field-row">
          <div className="field-controls">
            <FormatTabs format={format} onChange={setFormat} />
            <span className="fld-group">
              <label>{t("calc.weather")}
                <select value={weather} onChange={(e) => setWeather(e.target.value as Weather | "")}>
                  <option value="">{t("calc.none")}</option>
                  {WEATHERS.map((w) => <option key={w} value={w}>{t(`weather.${w}`)}</option>)}
                </select>
              </label>
              <label>{t("calc.terrain")}
                <select value={terrain} onChange={(e) => setTerrain(e.target.value as Terrain | "")}>
                  <option value="">{t("calc.none")}</option>
                  {TERRAINS.map((x) => <option key={x} value={x}>{t(`terrain.${x}`)}</option>)}
                </select>
              </label>
            </span>
            <span className="fld-group">
              <FieldCheck label={t("calc.reflect")} checked={reflect} onChange={setReflect} />
              <FieldCheck label={t("calc.lightScreen")} checked={lightScreen} onChange={setLightScreen} />
            </span>
            {format !== "single" && (
              <span className="fld-group" title={t("calc.aurasHint")}>
                {[...ATTACKER_AURAS, ...DEFENDER_AURAS].map(([flag, key]) => (
                  <FieldCheck key={flag} label={t(key)} checked={!!auras[flag]}
                    onChange={(v) => setAuras((a) => ({ ...a, [flag]: v }))} />
                ))}
              </span>
            )}
          </div>
          <button className="primary-btn" onClick={() => void run()}
            disabled={busy || !attacker.slug || !selectedMoves.length || !defenders.some((d) => d.slug)}>
            {busy ? t("state.loading") : t("calc.run")}
          </button>
        </div>
      </div>

      <div className="defenders-head">
        <h2 className="page-title" style={{ fontSize: 15, margin: 0 }}>{t("calc.defenders")}</h2>
        <button className="ghost-btn" onClick={() => setDefenders((d) => [...d, { ...EMPTY_SIDE }])}>
          + {t("calc.addDefender")}
        </button>
      </div>
      <div className="defenders-grid">
        {defenders.map((d, i) => (
          <SideForm key={i} label={`${t("calc.defender")} ${i + 1}`} side={d}
            setSide={(u) => setDefenders((prev) => prev.map((x, j) =>
              j === i ? (typeof u === "function" ? (u as (s: SideState) => SideState)(x) : u) : x))}
            dex={dex} natures={natures} items={items}
            onSwap={() => swapWithAttacker(i)}
            onRemove={defenders.length > 1 ? () => setDefenders((prev) =>
              prev.filter((_, j) => j !== i)) : undefined} />
        ))}
      </div>

      {error && <div className="notice mono" style={{ marginTop: 14 }}>{error}</div>}

      {matrix && (
        <div ref={resultRef} className="panel matrix-wrap" style={{ marginTop: 14 }}>
          <div className={`matrix-guide${cell ? " active" : ""}`} aria-live="polite">
            <span className="matrix-guide-mark" aria-hidden>{cell ? "✓" : "↘"}</span>
            {t(cell ? "calc.resultSelected" : "calc.resultsReady")}
          </div>
          <div className="matrix-scroll">
            <table className="calc-matrix">
              <thead>
                <tr>
                  <th className="corner">{t("calc.defenders")} \ {t("calc.moves")}</th>
                  {matrix.cols.map((c) => (
                    <th key={c.move}>
                      <EntityHover kind="move" name={c.move} link={false}>
                        <span className="col-move"><TypeBadge type={c.type} iconOnly />
                          <CategoryBadge category={c.category} />{damageText.name(c.move)}</span>
                      </EntityHover>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((row, ri) => (
                  <tr key={row.slug}>
                    <th className="row-mon">
                      <EntityHover kind="pokemon" name={row.name} link={false}>
                        <span className="p-inner">
                          <GameImage assetKey={row.key} role="dense" alt={displayName(row, lang)}
                            className="mini" />
                          <span className="nm">{displayName(row, lang)}</span>
                        </span>
                      </EntityHover>
                    </th>
                    {matrix.cols.map((c, ci) => {
                      const res = matrix.results[ri * matrix.cols.length + ci];
                      if (!res || isErrorShape(res)) {
                        return <td key={c.move} className="ko-none miss">—</td>;
                      }
                      const turns = res.koChance?.n
                        ?? (res.maxPercent >= 100 ? 1 : Math.ceil(100 / Math.max(res.maxPercent, 0.01)));
                      const tone = koTone(turns, res.koChance?.guaranteed ?? false, res.max);
                      const on = cell?.r === ri && cell?.c === ci;
                      return (
                        <td key={c.move} className={`ko-${tone}${on ? " on" : ""}`}
                          role="button" tabIndex={0} aria-pressed={on}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault(); setCell({ r: ri, c: ci });
                            }
                          }}
                          onClick={() => setCell({ r: ri, c: ci })}>
                          <span className="pct num">{res.maxPercent.toFixed(1)}%</span>
                          <span className="ko num">
                            {koLabel(turns, res.max > 0, res.koChance?.guaranteed ?? false, lang)}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected && !isErrorShape(selected) && (
            <div ref={detailRef} className="matrix-detail result-inspector" tabIndex={-1}>
              <div className="result-inspector-head">
                <span className="result-kicker">
                  <span>{selectedAttacker ? displayName(selectedAttacker, lang) : attacker.slug}</span>
                  <span aria-hidden> → </span>
                  <span>{selectedRow ? displayName(selectedRow, lang) : ""}</span>
                  {selectedCol && <strong className="result-move"> · {damageText.name(selectedCol.move)}</strong>}
                </span>
                <strong className="result-band num">
                  {selected.minPercent.toFixed(1)}% – {selected.maxPercent.toFixed(1)}%
                </strong>
              </div>
              <div className="result-summary">{damageText.summary(selected)}</div>
              {selected.koChance && <div className="result-verdict">{damageText.ko(selected.koChance)}</div>}
              <div className="result-rolls num">
                {t("calc.rolls")}: {selected.damage.join(", ")} / HP {selected.defenderHP}
              </div>
              {selected.koCaveats?.map((cv) => (
                <div key={cv.code} className="result-caveat">
                  {damageText.caveat(cv)}
                </div>
              ))}
            </div>
          )}
          {selected && isErrorShape(selected) && (
            <div ref={detailRef} className="matrix-detail result-inspector notice" tabIndex={-1}>
              {t("calc.error")}
            </div>
          )}
        </div>
      )}
    </>
  );
}
