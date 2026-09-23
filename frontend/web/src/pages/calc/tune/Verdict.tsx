/** The live answer for the selected pair: how often our mon lives through the chosen move, drawn
 * from the engine's own sixteen rolls, and the control that pins it as a standing target. */
import { memo } from "react";
import { GameImage } from "../../../components/GameImage.tsx";
import { displayName, useLang, useT, type MsgKey } from "../../../i18n.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import {
  TARGETS, formatProbability, rollSurvival, survival, targetProbability,
  type GoalTarget, type Hits, type Rolls,
} from "./model.ts";

export const TARGET_LABEL: Record<GoalTarget, MsgKey> = {
  guaranteed: "tune.ws.prob.guaranteed",
  near_guaranteed: "tune.ws.prob.nearGuaranteed",
  likely: "tune.ws.prob.likely",
  three_quarters: "tune.ws.prob.threeQuarters",
  half: "tune.ws.prob.half",
};

/** Language-neutral short form for the compact target chips. */
export const TARGET_SHORT: Record<GoalTarget, string> = {
  guaranteed: "100%", near_guaranteed: "≥93.75%", likely: "≥81.25%", three_quarters: "≥75%", half: "≥50%",
};

function HitsToggle({ hits, onHits }: {
  hits: Hits;
  onHits: (hits: Hits) => void;
}) {
  const t = useT();
  return (
    <span className="seg tw-hits" role="group"
      aria-label={t("tune.ws.hitsLabel")}>
      {([1, 2] as const).map((value) => (
        <button key={value} type="button" className={hits === value ? "on" : ""}
          aria-pressed={hits === value} onClick={() => onHits(value)}>
          {t(value === 1 ? "tune.h1" : "tune.h2")}
        </button>
      ))}
    </span>
  );
}

function TargetSelect({ target, onTarget }: {
  target: GoalTarget;
  onTarget: (target: GoalTarget) => void;
}) {
  const t = useT();
  return (
    <select className="tw-target-select" value={target} aria-label={t("tune.ws.target")}
      onChange={(event) => onTarget(event.target.value as GoalTarget)}>
      {TARGETS.map((candidate) => (
        <option key={candidate.id} value={candidate.id}>{t(TARGET_LABEL[candidate.id])}</option>
      ))}
    </select>
  );
}

export type VerdictState = "ready" | "noMove" | "statusMove" | "noMon";

export const Verdict = memo(function Verdict({ foe, mine, moveLabel, rolls, pending, state, hits, onHits,
  target, onTarget, pinned, onTogglePin, onSwap }: {
  foe: DexIndexEntry | undefined;
  mine: DexIndexEntry | undefined;
  moveLabel: string;
  rolls: Rolls | null;
  pending: boolean;
  state: VerdictState;
  hits: Hits;
  onHits: (hits: Hits) => void;
  target: GoalTarget;
  onTarget: (target: GoalTarget) => void;
  pinned: boolean;
  onTogglePin: () => void;
  /** Attack and defence change places — the shared roster's swap, so the calculator follows. */
  onSwap: () => void;
}) {
  const t = useT();
  const { lang } = useLang();
  const ready = state === "ready" && !!rolls;
  const live = survival(ready ? rolls : null, hits);
  const met = ready && live.probability >= targetProbability(target);
  const strip = ready ? rollSurvival(rolls, hits) : [];
  const empty = state === "noMon" ? t("tune.ws.pickBoth")
    : state === "noMove" ? t("tune.ws.pickMove")
      : state === "statusMove" ? t("tune.ws.statusNoDamage") : t("state.loading");

  const who = (entry: DexIndexEntry | undefined) => entry ? (
    <span className="tw-who">
      <GameImage assetKey={entry.key} role="dense" alt="" className="mini" />
      <b>{displayName(entry, lang)}</b>
    </span>
  ) : <span className="tw-who muted">—</span>;

  return (
    <section className={`panel tw-verdict${pending ? " pending" : ""}`} aria-live="polite">
      <div className="tw-verdict-head">
        <span className="tw-matchup">
          {who(foe)}
          {moveLabel && <span className="tw-matchup-move">{moveLabel}</span>}
          <span className="tw-arrow" aria-hidden>→</span>
          {who(mine)}
          <button type="button" className="ghost-btn tw-swap" onClick={onSwap}
            title={t("calc.flipAxisHint")}>⇄ {t("calc.swap")}</button>
        </span>
        <span className="tw-verdict-controls">
          <label className="tw-target-field">
            <span>{t("tune.ws.target")}</span>
            <TargetSelect target={target} onTarget={onTarget} />
          </label>
          {/* Always rendered, so the controls beside it never shift when a verdict appears. */}
          <span className={`tw-state ${ready ? (met ? "pass" : "fail") : "idle"}`}>
            {ready ? (met ? t("tune.ws.met") : t("tune.ws.unmet")) : "—"}
          </span>
          <HitsToggle hits={hits} onHits={onHits} />
        </span>
      </div>

      <div className="tw-verdict-body">
        {ready ? (
          <>
            <div className="tw-rate">
              <b className={`num ${met ? "pass" : "fail"}`}>{formatProbability(live.probability)}</b>
              <span className="tw-rate-cap">
                {t("tune.ws.surviveRate")}
                <small className="num">
                  {t(hits === 1 ? "tune.ws.rolls1" : "tune.ws.rolls2")
                    .replace("{a}", String(live.alive)).replace("{n}", String(live.total))}
                </small>
              </span>
            </div>
            <div className="tw-rolls">
              <div className="tw-roll-strip" role="img"
                aria-label={`${t("tune.ws.rollsLabel")} ${rolls.damage.join(", ")}`}>
                {rolls.damage.map((damage, index) => (
                  <i key={index} style={{ ["--alive" as string]: `${(strip[index] ?? 0) * 100}%` }}
                    title={`${damage} / ${rolls.defenderHP}`} />
                ))}
              </div>
              <div className="tw-roll-scale num">
                <span>{t("tune.ws.damage")} {rolls.min}–{rolls.max}
                  <span className="muted"> ({rolls.minPercent.toFixed(1)}–{rolls.maxPercent.toFixed(1)}%)</span>
                </span>
                <span>HP {rolls.defenderHP}</span>
              </div>
            </div>
          </>
        ) : (
          <div className="tw-verdict-empty">{empty}</div>
        )}
        {/* Same box in both states: pinning swaps the label, never the size. */}
        <button type="button" className={`tw-action${pinned ? " done" : ""}`}
          onClick={onTogglePin} aria-pressed={pinned} disabled={!ready && !pinned}
          title={pinned ? t("tune.ws.unpinHint") : t("tune.ws.pinHint")}>
          {pinned ? `✓ ${t("tune.ws.pinned")}` : t("tune.ws.pin")}
        </button>
      </div>
    </section>
  );
});
