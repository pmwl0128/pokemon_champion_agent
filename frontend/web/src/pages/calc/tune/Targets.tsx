/** Pinned survival targets, the solver that reverse-solves them through the `tune` operator, and the
 * solution cards it returns. Each allocation the operator reports is an absolute spread relative to
 * the spread it was solved from, so "apply" restores that base and writes the lane on top — applying
 * one lane after another never stacks two answers. */
import type { NatureDto, TuneCardDto } from "@pokemon-champions/protocol";
import { useEffect, useRef, useState } from "react";
import { GameImage } from "../../../components/GameImage.tsx";
import { displayName, optionalKey, useLang, useT, type MsgKey } from "../../../i18n.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import { natureLabel, spSum } from "../shared.tsx";
import type { MonState } from "../duel/state.ts";
import {
  formatProbability, lanesOf, num, record, survival, targetProbability,
  type Goal, type GoalTarget, type Hits, type Lane, type Rolls, type Spread,
} from "./model.ts";
import { TARGET_LABEL, TARGET_SHORT } from "./Verdict.tsx";
import { TuneCard } from "../TuneCard.tsx";

const STAT_LABEL: Record<string, MsgKey> = {
  hp: "stat.hp", atk: "stat.atk", def: "stat.def", spa: "stat.spa", spd: "stat.spd", spe: "stat.spe",
};

export interface TargetRow {
  goal: Goal;
  foe: DexIndexEntry | undefined;
  mine: DexIndexEntry | undefined;
  moveLabel: string;
  rolls: Rolls | null;
  focused: boolean;
}

/** What one benchmark was solved from; `benchmark_index` on a card points into this list. */
export interface SolveEntry {
  mineId: string;
  foeId: string;
  move: string;
  hits: Hits;
  target: GoalTarget;
  base: { sps: MonState["sps"]; nature: string };
}

export interface SolveRun {
  entries: SolveEntry[];
  cards: TuneCardDto[];
  /** Everything but our members' SP and nature — the part an applied lane must not have changed. */
  contextSig: string;
}

function sameSpread(a: Spread, b: Spread): boolean {
  return (["hp", "atk", "def", "spa", "spd", "spe"] as const)
    .every((key) => (a[key] ?? 0) === (b[key] ?? 0));
}

const RESULT_KEY: Record<string, MsgKey> = {
  already: "tune.res.already", cliff: "tune.res.cliff",
  infeasible: "tune.res.infeasible", unreachable: "tune.res.unreachable",
};
const tone = (result: string) =>
  result === "already" ? "pass" : result === "cliff" ? "warn" : "fail";

function SolutionCard({ card, entry, foe, mine, moveLabel, current, natures, canApply, onApply }: {
  card: TuneCardDto;
  entry: SolveEntry;
  foe: DexIndexEntry | undefined;
  mine: DexIndexEntry | undefined;
  moveLabel: string;
  current: MonState | null;
  natures: NatureDto[];
  canApply: boolean;
  onApply: (spread: Spread, nature: string) => void;
}) {
  const t = useT();
  const { lang } = useLang();
  const [open, setOpen] = useState(false);
  const lanes = lanesOf(card, entry.base.sps);
  const shownLanes = lanes.filter((lane) => lane.result !== "already");
  const statName = (stat: string) => {
    const key = STAT_LABEL[stat];
    return key ? t(key) : stat.toUpperCase();
  };
  const laneName = (kind: string, changed: Lane["changed"]) => kind === "mixed"
    ? changed.map((part) => statName(part.stat)).join(" + ")
    : t("tune.ws.laneOnly").replace("{stat}", statName(kind));
  const selected = typeof card.selected_lane === "string" ? card.selected_lane : null;
  const summary = card.result === "already"
    ? (typeof card.slack_sp === "number" && card.slack_sp > 0
      ? t("tune.ws.slack").replace("{n}", String(card.slack_sp)) : t("tune.res.already"))
    : card.result === "cliff" ? t("tune.ws.needSp").replace("{n}", String(card.delta_sp ?? 0))
      : card.result === "skipped" ? t("tune.ws.skipped")
        : RESULT_KEY[card.result] ? t(RESULT_KEY[card.result]!) : card.result;
  const isCurrent = (spread: Spread, nature: string) =>
    !!current && current.nature === nature && sameSpread(current.sps, spread);

  const ladder = (Array.isArray(card.probability_lanes) ? card.probability_lanes : [])
    .filter((lane) => lane.probability in TARGET_LABEL);
  const tiers = Array.isArray(card.survive_tiers) ? card.survive_tiers : [];
  const otherTier = tiers.find((tier) => tier.hits !== card.hits);
  const rawAlts = card.nature_alternatives;
  const natureAlts = (Array.isArray(rawAlts) ? rawAlts as unknown[] : [])
    .flatMap((raw) => {
      const alt = record(raw);
      const nature = alt && typeof alt.nature === "string" ? alt.nature : null;
      const need = alt ? num(alt.need_total) : null;
      return alt && nature && need !== null ? [{
        nature, need, delta: num(alt.delta_sp) ?? 0, pct: num(alt.meta_pct),
        result: String(alt.result ?? ""),
      }] : [];
    });
  const axis = lanes[0]?.kind === "def" || lanes[0]?.kind === "spd" ? lanes[0].kind : null;
  const attacker = record(card.attacker);
  const source = attacker && typeof attacker.source === "string" ? attacker.source : null;
  const sourceKey = source ? optionalKey(`tune.source.${source}`) : null;
  const assumptions = Array.isArray(card.assumptions) ? card.assumptions : [];
  const state = record(card.member_state);
  const stateStages = record(state?.boosts);
  const stateText = [
    ...(state && typeof state.status === "string" ? [t(`status.${state.status}` as MsgKey)] : []),
    ...Object.entries(stateStages ?? {}).flatMap(([stat, stage]) => {
      const value = num(stage);
      return value ? [`${statName(stat)} ${value > 0 ? "+" : ""}${value}`] : [];
    }),
  ].join(" · ");

  const applyButton = (spread: Spread, nature: string) => isCurrent(spread, nature)
    ? <span className="tw-lane-current">{t("tune.ws.applied")}</span>
    : (
      <button type="button" className="ghost-btn tiny" disabled={!canApply}
        title={canApply ? undefined : t("tune.ws.applyStale")}
        onClick={() => onApply(spread, nature)}>{t("tune.ws.apply")}</button>
    );

  return (
    <article className={`tw-solution ${tone(card.result)}`}>
      <header className="tw-solution-head">
        <span className="tw-matchup">
          {foe && <GameImage assetKey={foe.key} role="dense" alt="" className="mini" />}
          <b>{foe ? displayName(foe, lang) : String(card.vs)}</b>
          <span className="tw-matchup-move">{moveLabel}</span>
          <span className="tw-arrow" aria-hidden>→</span>
          {mine && <GameImage assetKey={mine.key} role="dense" alt="" className="mini" />}
          <b>{mine ? displayName(mine, lang) : card.member}</b>
        </span>
        <span className="tw-solution-goal">
          {t(entry.hits === 1 ? "tune.h1" : "tune.h2")} · {t(TARGET_LABEL[entry.target])}
          {stateText && <span className="tw-solution-state" title={t("tune.ws.stateHint")}>{stateText}</span>}
        </span>
        <span className={`tw-state ${tone(card.result)}`}>{summary}</span>
      </header>

      {/* A card from an operator build without allocation lanes still gets its full generic reading. */}
      {!Array.isArray(card.allocation_lanes) && card.result !== "skipped" && <TuneCard card={card} />}
      {(shownLanes.length > 0 || (axis && natureAlts.length > 0)) && (
        <div className="tw-lanes">
          {shownLanes.map((lane) => {
            const total = spSum(lane.spread);
            const reachable = lane.result === "cliff" || lane.result === "already";
            return (
              <div key={lane.kind} className={`tw-lane${lane.kind === selected ? " best" : ""}${reachable ? "" : " off"}`}>
                <span className="tw-lane-name">
                  {laneName(lane.kind, lane.changed)}
                  {lane.kind === selected && reachable && <em>{t("tune.ws.cheapest")}</em>}
                </span>
                <span className="tw-lane-change num">
                  {lane.changed.map((part) => (
                    <span key={part.stat}>{statName(part.stat)} {part.from}→<b>{part.to}</b></span>
                  ))}
                </span>
                <span className="tw-lane-cost num">
                  {reachable ? `+${lane.delta} SP` : t(RESULT_KEY[lane.result] ?? "tune.res.unreachable")}
                </span>
                <span className="tw-lane-act">
                  {reachable && lane.delta > 0 && applyButton(lane.spread, entry.base.nature)}
                </span>
                {reachable && lane.delta > 0 && total > 66 && (
                  <span className="tw-lane-note">
                    <span>{t("tune.ws.overBudget").replace("{total}", String(total))
                      .replace("{n}", String(total - 66))}</span>
                    {lane.donors.length > 0 && (
                      <span>{t("tune.ws.donors")}{lane.donors
                        .map((donor) => `${statName(donor.stat)} ${donor.current_sp}`).join(lang === "en" ? ", " : "、")}</span>
                    )}
                  </span>
                )}
              </div>
            );
          })}
          {axis && natureAlts.map((alt) => {
            const spread: Spread = { ...entry.base.sps, [axis]: alt.need };
            const nature = natures.find((candidate) => candidate.name === alt.nature);
            // Net change against the solved-from spread: a nature can make the requirement cheaper
            // than what is already invested, which frees SP rather than costing it.
            const net = alt.need - (entry.base.sps[axis] ?? 0);
            return (
              <div key={`nature-${alt.nature}`} className="tw-lane nature">
                <span className="tw-lane-name">{t("tune.ws.natureLane")}</span>
                <span className="tw-lane-change num">
                  <span>{nature ? natureLabel(nature, lang) : alt.nature}</span>
                  <span>{statName(axis)} {entry.base.sps[axis] ?? 0}→<b>{alt.need}</b></span>
                  {alt.pct !== null && <span className="muted">
                    {t("tune.ws.metaPct").replace("{n}", String(alt.pct))}</span>}
                </span>
                <span className={`tw-lane-cost num${net < 0 ? " saves" : ""}`}>
                  {net > 0 ? `+${net}` : net < 0 ? `−${-net}` : "±0"} SP
                </span>
                <span className="tw-lane-act">{applyButton(spread, alt.nature)}</span>
              </div>
            );
          })}
        </div>
      )}

      {(ladder.length > 0 || otherTier) && (
        <div className="tw-ladder">
          <div className="tw-ladder-probs">
            {ladder.length > 0 && axis && (
              <span className="tw-ladder-cap">{t("tune.ws.ladder").replace("{stat}", statName(axis))}</span>
            )}
            {ladder.map((lane) => (
              <span key={lane.probability} className={`tw-rung ${tone(lane.result)}${lane.primary ? " primary" : ""}`}>
                {t(TARGET_LABEL[lane.probability as GoalTarget])}
                <b className="num">{lane.result === "already" ? "✓"
                  : lane.result === "cliff" || lane.result === "infeasible" ? `${lane.need_total ?? "?"}`
                    : "✗"}</b>
              </span>
            ))}
          </div>
          {otherTier && (
            <span className={`tw-rung other ${tone(otherTier.result)}`}>
              {t(otherTier.hits === 1 ? "tune.h1" : "tune.h2")}
              <b className="num">{otherTier.result === "already" ? "✓"
                : otherTier.result === "cliff" || otherTier.result === "infeasible"
                  ? `${otherTier.need_total ?? "?"}` : "✗"}</b>
            </span>
          )}
        </div>
      )}

      <button type="button" className="tw-more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "▾" : "▸"} {t("tune.detail")}
      </button>
      {open && (
        <div className="tw-solution-detail">
          {sourceKey && (
            <div>{t("tune.attackerSet")}：{t(sourceKey)}
              {card.confidence && ` · ${(() => {
                const key = optionalKey(`conf.${card.confidence}`);
                return key ? t(key) : card.confidence;
              })()}`}</div>
          )}
          {lang === "en"
            ? assumptions.map((line, index) => <div key={index}>· {line}</div>)
            : assumptions.length > 0 && <div>· {t("tune.card.assumptionGeneric")}</div>}
          {entry.hits === 2 && <div>· {t("tune.ws.twoHitCaveat")}</div>}
        </div>
      )}
    </article>
  );
}

export function TargetsPanel({ rows, onRemove, onFocus, onClear, solve, run, stale, preset, natures,
  memberOf, entryOf, moveLabelOf, onApply }: {
  rows: TargetRow[];
  onRemove: (id: string) => void;
  onFocus: (goal: Goal) => void;
  onClear: () => void;
  solve: {
    available: boolean;
    busy: boolean;
    description: string;
    blocked: string | null;
    error: string | null;
    onSolve: () => void;
  };
  run: SolveRun | null;
  /** The matchup, sets or field changed since the run: its lanes no longer describe this page. */
  stale: boolean;
  /** The verdict's probability, as the number an untargeted solve would use. */
  preset: string;
  natures: NatureDto[];
  memberOf: (id: string) => MonState | null;
  entryOf: (side: "mine" | "foe", id: string, fallback: string) => DexIndexEntry | undefined;
  moveLabelOf: (move: string) => string;
  onApply: (mineId: string, spread: Spread, nature: string) => void;
}) {
  const t = useT();
  const { lang } = useLang();
  // A newly pinned target joins at the end of the strip; bring it into view by scrolling the strip
  // itself — never the page, which would move whatever the reader is working on.
  const strip = useRef<HTMLDivElement>(null);
  const count = useRef(rows.length);
  useEffect(() => {
    const node = strip.current;
    if (node && rows.length > count.current) node.scrollTo({ left: node.scrollWidth, behavior: "smooth" });
    count.current = rows.length;
  }, [rows.length]);
  const describe = solve.blocked ?? (solve.available ? solve.description : t("tune.ws.solveUnavailable"));

  return (
    <section className="panel tw-targets">
      <header className="tw-section-head">
        <div>
          <h2>{t("tune.ws.targets")}<span className="num">{rows.length}</span></h2>
          <p>{t("tune.ws.targetsHint")}</p>
        </div>
        {rows.length > 0 && (
          <button type="button" className="tw-text-btn" onClick={onClear}>{t("tune.ws.clearTargets")}</button>
        )}
      </header>

      {/* One fixed-height strip: pinning or dropping a target never moves anything below it. A
          target's hits and probability are edited in the verdict above once its chip is selected. */}
      <div className="tw-chips" ref={strip}>
        {rows.length === 0 ? (
          <span className="tw-chips-empty">{t("tune.ws.targetsEmpty").replace("{pct}", preset)}</span>
        ) : rows.map(({ goal, foe, mine, moveLabel, rolls, focused }) => {
          const live = survival(rolls, goal.hits);
          const met = !!rolls && live.probability >= targetProbability(goal.target);
          const tone = rolls ? (met ? "pass" : "fail") : "";
          const pair = `${foe ? displayName(foe, lang) : "—"} · ${moveLabel} → ${mine ? displayName(mine, lang) : "—"}`;
          return (
            <span key={goal.id} className={`tw-chip${focused ? " on" : ""} ${tone}`}>
              <button type="button" className="tw-chip-main" onClick={() => onFocus(goal)}
                title={`${pair} · ${t("tune.ws.focusHint")}`}>
                {foe && <GameImage assetKey={foe.key} role="dense" alt="" className="mini" />}
                <b>{moveLabel}</b>
                <span className="tw-arrow" aria-hidden>→</span>
                {mine && <GameImage assetKey={mine.key} role="dense" alt="" className="mini" />}
                <span className="tw-chip-goal">
                  {t(goal.hits === 1 ? "tune.h1" : "tune.h2")} {TARGET_SHORT[goal.target]}
                </span>
                <span className={`tw-chip-rate num ${tone}`}>
                  {rolls ? formatProbability(live.probability) : "…"}
                </span>
              </button>
              <button type="button" className="tw-chip-x" aria-label={`${t("a11y.remove")} ${pair}`}
                title={t("a11y.remove")} onClick={() => onRemove(goal.id)}>✕</button>
            </span>
          );
        })}
      </div>

      <div className="tw-solve">
        <div className="tw-solve-copy" title={run && stale ? t("tune.ws.stale") : describe}>
          <strong>{t("tune.ws.solveTitle")}</strong>
          {run && stale && <span className="tw-state warn">{t("tune.ws.stalePill")}</span>}
          <span className="tw-solve-desc">{describe}</span>
        </div>
        <button type="button" className="tw-action primary"
          disabled={!solve.available || solve.busy || !!solve.blocked}
          title={solve.available ? undefined : t("tune.ws.solveUnavailable")}
          onClick={solve.onSolve}>
          {solve.busy ? t("tune.ws.solving") : t("tune.ws.solve")}
        </button>
      </div>
      {solve.error && <div className="notice mono">{solve.error}</div>}
      {run && run.cards.length === 0 && <div className="tw-note">{t("tune.noCards")}</div>}
      {run && run.cards.length > 0 && (
        <div className={`tw-solutions${solve.busy ? " busy" : ""}`}>
          {run.cards.map((card, index) => {
            const entry = run.entries[typeof card.benchmark_index === "number" ? card.benchmark_index as number : index];
            if (!entry) return <TuneCard key={index} card={card} />;
            return (
              <SolutionCard key={`${entry.mineId}:${entry.foeId}:${entry.move}:${index}`} card={card}
                entry={entry} natures={natures}
                foe={entryOf("foe", entry.foeId, String(card.vs))}
                mine={entryOf("mine", entry.mineId, card.member)}
                moveLabel={moveLabelOf(entry.move)}
                current={memberOf(entry.mineId)}
                canApply={!stale && !!memberOf(entry.mineId)}
                onApply={(spread, nature) => onApply(entry.mineId, spread, nature)} />
            );
          })}
        </div>
      )}
    </section>
  );
}
