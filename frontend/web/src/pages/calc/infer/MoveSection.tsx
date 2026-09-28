/** One direction of the pairing on screen, as the top of a side's card: that side's four moves
 * into the other side's selected Pokémon, each reading the damage predicted over what is inferred
 * so far, and under the selected move the form that records a hit that actually happened.
 *
 * The form asks only for what the hit showed (the HP before and after, a crit, a single target). The
 * frame it happened in — weather, terrain, side conditions, both sides' stat stages and status — is
 * whatever the cards and the strip say at that moment, frozen into the record; the observation log
 * lists it with each hit. */
import type { LearnsetDto } from "@pokemon-champions/protocol";
import { useEffect, useState } from "react";
import { GameImage } from "../../../components/GameImage.tsx";
import { displayName, useLang, useT, type MsgKey } from "../../../i18n.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import { BOOST_KEYS, boostLabel } from "../../../components/build/inputs.tsx";
import { useMetaUsage } from "../../../lib/metaUsage.ts";
import { MoveCell } from "../../../components/build/MoveCell.tsx";
import { SIDE_FLAGS, type FieldState, type MonState } from "../duel/state.ts";
import type { Observation, ObservationKind } from "./context.ts";
import type { Prediction, SpKey } from "./model.ts";
import { useInferT } from "./messages.ts";
import type { MoveReading } from "./useInference.ts";

type T = ReturnType<typeof useInferT>;

function readingText(t: T, reading: MoveReading, kind: ObservationKind): string | null {
  if (!reading.move) return null;
  if (reading.reason === "status") return t("infer.status");
  if (reading.reason === "unreadable") return t("infer.unreadable");
  if (reading.reason === "immune") return t("infer.immune");
  const p = reading.posterior;
  if (p === "pending") return "…";
  if (!p) return "—";
  return kind === "bulk" ? `${p.lo.toFixed(1)} – ${p.hi.toFixed(1)}%` : `${p.lo} – ${p.hi}`;
}

/** Prior (light) and posterior (solid) ranges on one scale. */
function RangeBar({ prior, posterior, scale }: {
  prior: Prediction | "pending" | null;
  posterior: Prediction | "pending" | null;
  scale: number;
}) {
  const at = (value: number) => Math.min(100, (value / scale) * 100);
  const span = (p: Prediction) => ({ left: `${at(p.lo)}%`, width: `${Math.max(0.8, at(p.hi) - at(p.lo))}%` });
  return (
    <div className="inf-range" aria-hidden>
      {prior && prior !== "pending" && <i className="prior" style={span(prior)} />}
      {posterior && posterior !== "pending" && <i className="post" style={span(posterior)} />}
    </div>
  );
}

/** The frame a record froze, in words: weather, terrain, each side's conditions, stages and status. */
export function useFrameText(stat: (key: SpKey | "spe") => string): (observation: Observation) => string[] {
  const t = useT();
  const ti = useInferT();
  return (observation) => {
    const { field } = observation;
    const out: string[] = [];
    if (field.weather) out.push(t(`weather.${field.weather}` as MsgKey));
    if (field.terrain) out.push(t(`terrain.${field.terrain}` as MsgKey));
    const sides = [
      { who: ti("infer.side.mine"), flags: field.sides.a ?? {}, boosts: observation.mineBoosts,
        status: observation.mineStatus },
      { who: ti("infer.side.foe"), flags: field.sides.b ?? {}, boosts: observation.foeBoosts,
        status: observation.foeStatus },
    ];
    for (const { who, flags, boosts, status } of sides) {
      for (const flag of SIDE_FLAGS) {
        if (flags[flag.key] && !(flag.doublesOnly && field.format === "single")) {
          out.push(`${who}${t(flag.label as MsgKey)}`);
        }
      }
      for (const key of BOOST_KEYS) {
        const stage = boosts[key] ?? 0;
        if (stage) out.push(`${who}${stat(key)}${boostLabel(stage)}`);
      }
      if (status) out.push(`${who}${t(`status.${status}` as MsgKey)}`);
    }
    return out;
  };
}

const intIn = (raw: string, lo: number, hi: number): number | null => {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return value >= lo && value <= hi ? value : null;
};

/** The record form under a selected move. Their HP is entered as the game prints it (percent), ours
 * as exact HP. */
function RecordForm({ kind, reading, mine, foe, field, ourMax, onAdd }: {
  kind: ObservationKind;
  reading: MoveReading | undefined;
  mine: MonState;
  foe: MonState;
  field: FieldState;
  ourMax: number;
  onAdd: (observation: Omit<Observation, "id">) => void;
}) {
  const t = useInferT();
  const full = kind === "bulk" ? "100" : String(ourMax);
  const [before, setBefore] = useState(full);
  const [after, setAfter] = useState("");
  const [crit, setCrit] = useState(false);
  const [single, setSingle] = useState(false);
  const readable = !!reading?.key && !reading.reason;
  // A different move or a different pairing is a different hit: its one-off flags start clear.
  useEffect(() => {
    setCrit(false);
    setSingle(false);
  }, [reading?.move, mine.uid, foe.uid]);
  useEffect(() => { setBefore(full); }, [full, mine.uid, foe.uid]);

  const b = kind === "bulk" ? intIn(before, 1, 100) : intIn(before, 1, ourMax);
  const a = intIn(after, 0, kind === "bulk" ? 100 : ourMax);
  const valid = b !== null && a !== null && a < b;
  const spreadOption = field.format === "double" && !!reading?.isSpread;

  const add = () => {
    if (!readable || !valid || !reading) return;
    onAdd({
      kind, foeId: foe.uid, mineId: mine.uid, move: reading.move, before: b!, after: a!, crit,
      singleTarget: spreadOption && single, field: structuredClone(field),
      mineSnapshot: structuredClone(mine), foeSnapshot: structuredClone(foe),
      mineBoosts: { ...mine.boosts }, foeBoosts: { ...foe.boosts },
      mineStatus: mine.status, foeStatus: foe.status, enabled: true,
    });
    setAfter("");
    setBefore(full);
  };

  if (!readable) {
    return <p className="inf-form-note muted inf-form-idle">
      {reading?.reason === "multiHit" ? t("infer.multiHit")
        : reading?.reason === "unreadable" ? t("infer.unreadableHint")
          : reading?.reason === "immune" ? t("infer.immuneHint") : t("infer.form.pick")}
    </p>;
  }
  const unit = kind === "bulk" ? "%" : "HP";
  return (
    <form className="inf-form" onSubmit={(event) => { event.preventDefault(); add(); }}>
      <div className="inf-form-hp">
        <span className="inf-form-cap">{t(kind === "bulk" ? "infer.form.foeHp" : "infer.form.mineHp")}</span>
        <label className="inf-hp-field"><span>{t("infer.form.before")}</span>
          <input className="num" inputMode="numeric" value={before} onChange={(e) => setBefore(e.target.value)} />
          <em>{unit}</em></label>
        <span className="inf-form-arrow">→</span>
        <label className="inf-hp-field"><span>{t("infer.form.after")}</span>
          <input className="num" inputMode="numeric" value={after} onChange={(e) => setAfter(e.target.value)} />
          <em>{kind === "offense" ? `${unit} / ${ourMax}` : unit}</em></label>
        <label className="inf-check"><input type="checkbox" checked={crit} onChange={(e) => setCrit(e.target.checked)} />
          {t("infer.form.crit")}</label>
        {spreadOption && (
          <label className="inf-check" title={t("infer.form.singleHint")}>
            <input type="checkbox" checked={single} onChange={(e) => setSingle(e.target.checked)} />
            {t("infer.form.single")}</label>
        )}
        <button type="submit" className="tw-action inf-add" disabled={!valid}
          title={t("infer.form.addHint")}>{t("infer.form.add")}</button>
      </div>
      {(after.trim() !== "" && !valid) && (
        <p className="inf-form-note bad">{t(kind === "bulk" ? "infer.form.badFoe" : "infer.form.badMine")}</p>
      )}
    </form>
  );
}

export function MoveSection({ kind, attacker, entries, readings, learnset, selected, onSelect,
  onMove, mine, foe, field, ourMax, onAdd }: {
  kind: ObservationKind;
  attacker: MonState;
    entries: { attacker: DexIndexEntry | undefined; defender: DexIndexEntry | undefined };
  readings: MoveReading[];
  learnset: LearnsetDto | null;
  selected: number;
  onSelect: (slot: number) => void;
  onMove: (slot: number, name: string) => void;
  mine: MonState;
  foe: MonState;
  field: FieldState;
  ourMax: number;
  onAdd: (observation: Omit<Observation, "id">) => void;
}) {
  const t = useInferT();
  const { lang } = useLang();
  const usage = useMetaUsage(attacker.slug, [field.format]);
  const name = (entry: DexIndexEntry | undefined) => entry ? displayName(entry, lang) : "—";
  const reading = readings[selected];
  const scale = kind === "bulk" ? 100 : Math.max(1, ourMax);
  const posterior = reading?.posterior;
  const verdict = !posterior || posterior === "pending" ? null
    : posterior.koAll ? t("infer.koAll") : posterior.koAny ? t("infer.koAny") : null;
  return (
    <div className={`inf-moves ${kind}`}>
      <header className="inf-pair-head">
        {entries.attacker && <GameImage assetKey={entries.attacker.key} role="dense" alt="" className="mini" />}
        <b>{t(kind === "bulk" ? "infer.pair.into" : "infer.pair.from")
          .replace("{mine}", name(kind === "bulk" ? entries.attacker : entries.defender))
          .replace("{foe}", name(kind === "bulk" ? entries.defender : entries.attacker))}</b>
        {entries.defender && <GameImage assetKey={entries.defender.key} role="dense" alt="" className="mini" />}
      </header>
      <p className="inf-pair-hint muted">{t(kind === "bulk" ? "infer.pair.intoHint" : "infer.pair.fromHint")}</p>
      <div className="tw-move-grid">
        {Array.from({ length: 4 }, (_, slot) => {
          const row = readings[slot];
          const text = row ? readingText(t, row, kind) : null;
          const p = row?.posterior;
          const ko = p && p !== "pending" && p.koAny ? (p.koAll ? t("infer.koAll") : t("infer.koAny")) : null;
          return (
            <MoveCell key={slot} index={slot} value={attacker.moves[slot] ?? ""} learnset={learnset} usage={usage}
              selected={slot === selected} pending={p === "pending"} onSelect={onSelect} onChange={onMove}>
              {text && <span className={row?.reason ? "muted" : ""}>{text}</span>}
              {ko && <span className="duel-move-ko">{ko}</span>}
            </MoveCell>
          );
        })}
      </div>
      {reading?.move && !reading.reason && (
        <div className="inf-predict">
          <RangeBar prior={reading.prior} posterior={posterior ?? null} scale={scale} />
          <span className="inf-predict-text num">
            {posterior && posterior !== "pending"
              ? (kind === "bulk" ? `${posterior.lo.toFixed(1)}–${posterior.hi.toFixed(1)}%`
                : `${posterior.lo}–${posterior.hi} HP · ${(posterior.lo / scale * 100).toFixed(1)}–${(posterior.hi / scale * 100).toFixed(1)}%`)
              : t(posterior === "pending" ? "infer.pending" : "infer.empty")}
            {verdict && <b> · {verdict}</b>}
          </span>
        </div>
      )}
      <RecordForm kind={kind} reading={reading} mine={mine} foe={foe} field={field} ourMax={ourMax}
        onAdd={onAdd} />
    </div>
  );
}
