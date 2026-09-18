/** One side's result column: its four moves with what each does to the other side, and the detail
 * card for whichever move is selected.
 *
 * The HP bar belongs to THIS mon and is depleted by the OPPOSING card's selected move at that card's
 * roll — so the two columns together read as one turn: each side's output on its own card, each
 * side's remaining health under its own name. */
import type { DamageResultDto } from "@pokemon-champions/protocol";
import { useState } from "react";
import { GameImage } from "../../../components/GameImage.tsx";
import { PLACEHOLDERS } from "../../../assets/icons.ts";
import { useLang, useT } from "../../../i18n.ts";
import { useDamageText } from "../../../lib/damageText.tsx";
import { koLabel, koTone } from "../../../lib/ko.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import { typeColor } from "../../../assets/icons.ts";
import {
  ROLL_COUNT, ROLL_MODES, rollIndexOf, rollModeAt, rollModifier, rollValue,
} from "./state.ts";

export interface SlotResult {
  move: string;
  /** Plain localized name. The row is itself a button, so the move must NOT also be a link: a
   * nested target inside a click surface is a misclick waiting to happen, not an affordance. */
  label: string;
  category?: string;
  /** English canonical type, for the cell's own colour. */
  type?: string;
  result: DamageResultDto | null;
  failed: boolean;
}

/** Turns-to-KO for a result, falling back to the plain roll-band projection when the engine
 * reported no KO verdict (status moves and no-damage hits have none). */
export function turnsOf(res: DamageResultDto): number | null {
  if (res.koChance?.n != null) return res.koChance.n;
  if (res.maxPercent <= 0) return null;
  return Math.ceil(100 / Math.max(res.maxPercent, 0.01));
}

function HpBar({ entry, name, maxHP, remaining, notes, result }: {
  entry: DexIndexEntry | undefined;
  name: string;
  maxHP: number;
  remaining: number;
  /** Caveats about THIS mon, however they arrived. They collapse into one focusable warning icon so
   * the complete copy stays available without changing the card's height. */
  notes: string[];
  result: DamageResultDto | null;
}) {
  const t = useT();
  const pct = maxHP > 0 ? Math.max(0, Math.min(100, (remaining / maxHP) * 100)) : 0;
  const tone = pct > 50 ? "ok" : pct > 20 ? "warn" : pct > 0 ? "low" : "out";
  return (
    <div className="hp-bar-card">
      <div className="hp-bar-mon">
        {entry
          ? <GameImage assetKey={entry.key} role="dense" alt={name} className="hp-bar-sprite" />
          : <img className="hp-bar-sprite" src={PLACEHOLDERS.pokemon} alt="" aria-hidden />}
        <span className="hp-bar-heading">
          <span className="hp-bar-title-line">
            <span className="hp-bar-name-cluster">
              <span className="hp-bar-name">{name}</span>
              {entry?.isMega && <span className="mega-badge hp-mega-tag">MEGA</span>}
              {notes.length > 0 && (
                <span className="hp-warning" tabIndex={0} role="img"
                  aria-label={notes.join("；")} data-tooltip={notes.join("\n")}>
                  <span aria-hidden>!</span>
                </span>
              )}
            </span>
            <span className="duel-head-nums">
              <strong className="num">{result ? `${result.min} – ${result.max}` : "—"}</strong>
              <span className="muted num">
                {result ? `${result.minPercent.toFixed(1)}% – ${result.maxPercent.toFixed(1)}%` : ""}
              </span>
            </span>
          </span>
        </span>
      </div>
      <div className="hp-bar-track" role="img"
        aria-label={`${name}: ${remaining} / ${maxHP} ${t("calc.hpLeft")}`}>
        <span className={`hp-bar-fill ${tone}`} style={{ width: `${pct}%` }} />
        {/* An empty track is ambiguous on its own — it reads as "nothing computed" just as easily
            as "nothing left". Say which one it is. */}
        {maxHP > 0 && remaining <= 0 && <span className="hp-bar-out">{t("calc.fainted")}</span>}
        <span className="hp-bar-read num">
          <strong>{maxHP > 0 ? remaining : "—"}</strong>
          <span className="hp-bar-max">/{maxHP || "—"}</span>
        </span>
      </div>
    </div>
  );
}

export function ResultCard({
  monName, entry, slots, selected, onSelect, roll, onRoll, crit, onCrit,
  singleTarget, onSingleTarget, singleTargetAvailable, maxHP, remaining, busy, notes,
}: {
  monName: string;
  entry: DexIndexEntry | undefined;
  slots: SlotResult[];
  selected: number;
  onSelect: (index: number) => void;
  /** Index into the engine's sorted 16 rolls. */
  roll: number;
  onRoll: (index: number) => void;
  crit: boolean;
  onCrit: (on: boolean) => void;
  singleTarget: boolean;
  onSingleTarget: (on: boolean) => void;
  /** Doubles, and this mon's shown move really is a spread move — the only case where a
   * single-target variant is a different number. */
  singleTargetAvailable: boolean;
  maxHP: number;
  remaining: number;
  busy: boolean;
  notes: string[];
}) {
  const { lang } = useLang();
  const t = useT();
  const damageText = useDamageText();
  const [copied, setCopied] = useState(false);

  const active = slots[selected];
  const res = active?.result ?? null;
  const verdict = res?.koChance ? damageText.ko(res.koChance) : "";

  // The engine deals sixteen rolls for any real hit. A result with fewer of them — an immunity, a
  // status move — has no roll structure at all, so the control keeps the standard scale and
  // `rollValue` clamps into whatever came back: every roll of zero is still zero, and the pressed
  // button still says which roll the reader asked for.
  const rollCount = (res?.damage.length ?? 0) > 1 ? res!.damage.length : ROLL_COUNT;
  const rollMax = rollCount - 1;
  const rollIdx = Math.max(0, Math.min(rollMax, roll));
  const rollMode = rollModeAt(rollIdx, rollCount);
  const randomModifier = rollModifier(rollIdx, rollCount);
  const picked = res ? rollValue(res.damage, rollIdx) : null;
  const pickedPct = res && res.defenderHP > 0 && picked != null
    ? (picked / res.defenderHP) * 100 : null;

  const copyLine = () => {
    if (!res) return;
    // The engine's own English line, with the KO verdict appended: it names the investment, item and
    // field that produced these numbers, and it is the spelling every other calculator shares.
    const text = res.koChance?.text
      ? `${res.description} -- ${res.koChance.text}` : res.description;
    void navigator.clipboard.writeText(text).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); },
      () => { setCopied(false); });
  };

  return (
    <div className="duel-result">
      <HpBar entry={entry} name={monName} maxHP={maxHP} remaining={remaining} notes={notes}
        result={res} />

      {/* The four slots sit INSIDE the card, under the health they are about to spend. They are
          picked, not typed, so they read as buttons — the boxes further down the page that look
          like fields are the ones you can edit. */}
      <div className="duel-move-grid">
        {slots.map((slot, i) => {
          const r = slot.result;
          // A status move has no damage row at all. Reporting it as "0%" would put it in the same
          // sentence as a real immunity, which is a different fact about a different move.
          const status = (slot.category ?? r?.category) === "Status";
          const turns = r && !status ? turnsOf(r) : null;
          const tone = r && !status
            ? koTone(turns, r.koChance?.guaranteed ?? false, r.max) : "none";
          return (
            <button key={i} type="button"
              className={`duel-move-cell${i === selected ? " on" : ""}`}
              aria-pressed={i === selected}
              disabled={!slot.move}
              // The type is carried as a colour VARIABLE, not as a fill: several types are dark
              // enough that printing text on the flat colour is unreadable, so the cell uses it for
              // an edge and a wash and keeps the page's own ink.
              style={slot.type
                ? ({ ["--mv" as string]: typeColor(slot.type) }) : undefined}
              onClick={() => onSelect(i)}>
              <span className="duel-move-name">
                {slot.move ? slot.label : <span className="muted">—</span>}
              </span>
              <span className={`duel-move-pct num ko-text-${tone}`}>
                {status ? <span className="muted">{t("category.Status")}</span>
                  : slot.failed ? "—"
                    : r && r.max > 0
                      ? `${r.minPercent.toFixed(1)} – ${r.maxPercent.toFixed(1)}%`
                      : r ? "0%" : busy ? "…" : "—"}
                {!status && r && r.max > 0 && (
                  <span className="duel-move-ko">
                    {koLabel(turns, true, r.koChance?.guaranteed ?? false, lang)}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {/* The SAME rows whether or not there is a result: an empty state that swaps in a shorter
          tree changes the card's height, which moves the roster strip under the cursor that is
          clicking it. Placeholders keep the block structurally identical instead. */}
      {/* The roll is a slider over the sixteen, not a choice of three: the reader picks the roll they
          want to ask about and the health bar above follows immediately — no recalculation, the
          engine already returned every one of them. The three buttons stay as the three rolls worth
          a name, and land on the slider; a pick in between leaves all three unpressed, because none
          of them is where the slider is. Crit and single target are flags about the HIT, not roll
          picks, so the slider never touches them. */}
      <div className="duel-rolls">
        <span className="duel-rolls-cap">{t("calc.roll")}</span>
        <span className="duel-roll-read num">
          <strong>{res ? picked : "—"}</strong>
          <span className="muted">{pickedPct != null ? `${pickedPct.toFixed(1)}%` : ""}</span>
        </span>
        <span className="boost-slider roll duel-roll-lane">
          <span className="boost-lane">
            <span className="boost-track" aria-hidden
              style={{ ["--fill-left" as string]: "0%",
                       ["--fill-width" as string]: `${(rollIdx / Math.max(1, rollMax)) * 100}%` }} />
            <input type="range" min={0} max={rollMax} step={1} value={rollIdx} disabled={!res}
              aria-label={t("calc.rolls")}
              aria-valuetext={res ? t("calc.rollValue").replace("{n}", String(randomModifier)) : undefined}
              title={res ? t("calc.rollValue").replace("{n}", String(randomModifier)) : ""}
              onChange={(e) => onRoll(Number(e.target.value))} />
          </span>
        </span>
        <span className="duel-roll-mod num" aria-hidden>{res ? randomModifier : "—"}</span>
        <span className="duel-roll-btns">
          <span className="duel-roll-group" role="group" aria-label={t("calc.roll")}>
            {ROLL_MODES.map((mode) => {
              const on = rollMode === mode;
              return (
                <button key={mode} type="button" disabled={!res}
                  className={`roll-btn${on ? " on" : ""}`} aria-pressed={on}
                  onClick={() => onRoll(rollIndexOf(mode, rollCount))}>
                  {t(`calc.roll.${mode}`)}
                </button>
              );
            })}
          </span>
          <button type="button" className={`roll-btn flag${crit ? " on" : ""}`} disabled={!res}
            aria-pressed={crit} title={t("calc.critHint")}
            onClick={() => onCrit(!crit)}>{t("calc.crit")}</button>
          {singleTargetAvailable && (
            <button type="button" className={`roll-btn flag${singleTarget ? " on" : ""}`}
              aria-pressed={singleTarget} title={t("calc.singleTargetHint")}
              onClick={() => onSingleTarget(!singleTarget)}>{t("calc.singleTarget")}</button>
          )}
        </span>
      </div>

      {/* The copy control rides on the sentence it copies, not on the raw line below it. */}
      <div className="duel-summary-row">
        <span className="duel-summary">
          {res ? damageText.summary(res)
            : <span className="muted">{busy ? t("state.loading")
              : active?.failed ? t("calc.error") : t("calc.noMoveSelected")}</span>}
        </span>
        <span className={`duel-summary-verdict${res?.koChance?.guaranteed ? " guaranteed" : ""}`}
          title={verdict || undefined}>
          {verdict}
        </span>
        <button type="button" className="ghost-btn tiny" onClick={copyLine} disabled={!res}>
          {copied ? t("calc.copied") : t("calc.copyLine")}
        </button>
      </div>

      <div className="duel-line">
        <code className="duel-line-text" title={res?.description ?? ""}>
          {res ? (res.koChance?.text
            ? `${res.description} -- ${res.koChance.text}` : res.description) : ""}
        </code>
      </div>
    </div>
  );
}
