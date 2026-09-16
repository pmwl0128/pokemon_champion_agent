/** Every attacker×move against every defender on the page, in one grid.
 *
 * The duel above answers one question at a time; this answers "what does anything on my side do to
 * anything on theirs", which is the question a build session actually has. Columns are grouped under
 * the attacking mon's portrait so a column reads as "this mon, this move", and the axis flips rather
 * than being duplicated — the same two teams, asked the other way round. */
import type { DamageResultDto } from "@pokemon-champions/protocol";
import { isErrorShape } from "@pokemon-champions/protocol";
import { useState } from "react";
import { BuildSetSummary, type BuildCardOption } from "../../../components/BuildPicker.tsx";
import { EntityHover } from "../../../components/EntityHover.tsx";
import { GameImage } from "../../../components/GameImage.tsx";
import { displayName, useLang, useT } from "../../../i18n.ts";
import { useDamageText } from "../../../lib/damageText.tsx";
import { koLabel, koTone } from "../../../lib/ko.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";

export interface GridCol {
  attackerIndex: number;
  entry: DexIndexEntry;
  /** Immutable snapshot of the exact build used by this calculation run. */
  build: BuildCardOption;
  move: string;
  /** Plain localized name. Type and category badges are deliberately absent: a header row of a
   * dozen columns has to stay narrow, and the grid is read for its numbers, not its taxonomy. */
  label: string;
}

export interface GridRow {
  entry: DexIndexEntry;
  /** Immutable snapshot of the exact build used by this calculation run. */
  build: BuildCardOption;
}

export function AllMatchups({
  rows, cols, results, onFlip, onRun, runnable, stale, busy, error, fromLabel, toLabel,
}: {
  /** The axes the CURRENT results were computed against — never the live plan, or a stale grid
   * would be painted onto axes its cells do not belong to. */
  rows: GridRow[];
  cols: GridCol[];
  /** Row-major, aligned to rows × cols; a cell is a result, an engine error, or null (not run). */
  results: Array<DamageResultDto | { error?: unknown } | null>;
  onFlip: () => void;
  onRun: () => void;
  /** There is something to compute right now (both sides populated, within the batch bound). */
  runnable: boolean;
  /** The inputs moved since these results were produced. */
  stale: boolean;
  busy: boolean;
  error: string | null;
  fromLabel: string;
  toLabel: string;
}) {
  const { lang } = useLang();
  const t = useT();
  const damageText = useDamageText();
  const [cell, setCell] = useState<{ r: number; c: number } | null>(null);

  // Column groups: consecutive runs of the same attacker, so its portrait spans its own moves.
  const groups: Array<{ index: number; entry: DexIndexEntry; build: BuildCardOption; span: number }> = [];
  for (const col of cols) {
    const last = groups[groups.length - 1];
    if (last && last.index === col.attackerIndex) last.span += 1;
    else groups.push({ index: col.attackerIndex, entry: col.entry, build: col.build, span: 1 });
  }

  const picked = cell ? results[cell.r * cols.length + cell.c] : null;
  const pickedOk = picked && !isErrorShape(picked) ? picked as DamageResultDto : null;

  return (
    <section className="panel all-matchups">
      {/* The rule belongs to the whole header, not to the title alone: the hint and the flip control
          are part of the same band, so they sit above the line rather than beside a short one. */}
      <header className="all-matchups-head">
        <h2>{t("calc.allMatchups")}</h2>
        <p className="muted">{t("calc.allMatchupsHint")}</p>
        <span className="all-matchups-actions">
          {stale && <span className="grid-stale">{t("calc.gridStale")}</span>}
          <button type="button" className="ghost-btn" onClick={onFlip}
            title={t("calc.flipAxisHint")}>⇄ {t("calc.flipAxis")}</button>
          <button type="button" className={stale || !results.length ? "primary-btn" : "ghost-btn"}
            onClick={onRun} disabled={busy || !runnable}>
            {busy ? t("state.loading")
              : results.length ? t("calc.gridRefresh") : t("calc.gridCompute")}
          </button>
        </span>
      </header>

      {error && <div className="notice mono">{error}</div>}

      {/* Nothing has been computed yet: the button above already says what to do, so an
          explanation of the button would only be text to scroll past. */}
      {!error && !runnable && (cols.length === 0 || rows.length === 0) && (
        <div className="notice">{t("calc.allMatchupsEmpty")}</div>
      )}

      {!error && cols.length > 0 && rows.length > 0 && (
        <div className="matrix-scroll">
          <table className={`calc-matrix all-grid${busy || stale ? " busy" : ""}`}>
            <thead>
              <tr>
                <th className="corner" rowSpan={2}>{toLabel} \ {fromLabel}</th>
                {groups.map((g, gi) => (
                  <th key={`${g.index}-${gi}`} colSpan={g.span} className="grid-attacker">
                    <EntityHover kind="spread" name="" link={false}
                      previewAddon={<BuildSetSummary option={g.build} index={0} />}>
                      <span className="p-inner">
                        <GameImage assetKey={g.entry.key} role="dense"
                          alt={displayName(g.entry, lang)} className="mini" />
                        <span className="nm">{displayName(g.entry, lang)}</span>
                      </span>
                    </EntityHover>
                  </th>
                ))}
              </tr>
              <tr>
                {cols.map((c, ci) => (
                  <th key={ci} className="grid-move">
                    <EntityHover kind="move" name={c.move} link={false}>
                      <span className="col-move">{c.label}</span>
                    </EntityHover>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  <th className="row-mon">
                    <EntityHover kind="spread" name="" link={false}
                      previewAddon={<BuildSetSummary option={row.build} index={0} />}>
                      <span className="p-inner">
                        <GameImage assetKey={row.entry.key} role="dense"
                          alt={displayName(row.entry, lang)} className="mini" />
                        <span className="nm">{displayName(row.entry, lang)}</span>
                      </span>
                    </EntityHover>
                  </th>
                  {cols.map((_, ci) => {
                    const res = results[ri * cols.length + ci];
                    if (!res || isErrorShape(res)) {
                      return <td key={ci} className="ko-none miss">—</td>;
                    }
                    const dto = res as DamageResultDto;
                    const turns = dto.koChance?.n
                      ?? (dto.maxPercent > 0
                        ? Math.ceil(100 / Math.max(dto.maxPercent, 0.01)) : null);
                    const tone = koTone(turns, dto.koChance?.guaranteed ?? false, dto.max);
                    const on = cell?.r === ri && cell?.c === ci;
                    return (
                      <td key={ci} className={`ko-${tone}${on ? " on" : ""}`}
                        role="button" tabIndex={0} aria-pressed={on}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault(); setCell({ r: ri, c: ci });
                          }
                        }}
                        onClick={() => setCell({ r: ri, c: ci })}>
                        <span className="pct num">{dto.maxPercent.toFixed(1)}%</span>
                        <span className="ko num">
                          {koLabel(turns, dto.max > 0, dto.koChance?.guaranteed ?? false, lang)}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pickedOk && (
        <div className="matrix-detail result-inspector">
          {/* No repeated "attacker -> defender - move" header: the summary line below already says
              exactly that, and the percentage rides with the KO reading it qualifies. */}
          {/* One line: the sentence on the left, the reading it produced on the right. The verdict
              keeps a fixed box whatever it says — "4击击倒概率：98.14%" and an absent verdict must not
              re-flow the row between them. */}
          <div className="detail-head">
            <span className="result-summary">{damageText.summary(pickedOk)}</span>
            <span className="result-verdict">
              {pickedOk.koChance ? damageText.ko(pickedOk.koChance) : ""}
            </span>
            <span className="detail-band num">
              {pickedOk.minPercent.toFixed(1)}% – {pickedOk.maxPercent.toFixed(1)}%
            </span>
          </div>
          <div className="result-rolls num">
            {t("calc.rolls")}: {pickedOk.damage.join(", ")} / HP {pickedOk.defenderHP}
          </div>
          {pickedOk.koCaveats?.map((cv) => (
            <div key={`${cv.code}-${cv.direction}`} className="result-caveat">
              {damageText.caveat(cv)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
