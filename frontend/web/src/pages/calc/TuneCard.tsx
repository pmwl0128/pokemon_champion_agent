/** Benchmark-ordered cliff card for the authoritative `tune` operator. The session page renders the
 * same card for AGENT-authored tune results, so the reader stays lenient: anything that fails the
 * schema falls back to raw JSON instead of white-screening. */
import type { LearnsetDto, TuneCardDto } from "@pokemon-champions/protocol";
import { TuneCardDtoSchema } from "@pokemon-champions/protocol";
import { useState } from "react";
import { useAsync, useDexByName } from "../../hooks.ts";
import { displayName, optionalKey, useLang, useT, type MsgKey } from "../../i18n.ts";
import { useProseRenderer } from "../../lib/prose.tsx";
import { localName, useNameMaps } from "../../lib/names.ts";
import { loadLearnset } from "../../runtime/projection.ts";

const RESULT_LABEL: Record<string, MsgKey> = {
  already: "tune.res.already", cliff: "tune.res.cliff",
  infeasible: "tune.res.infeasible", unreachable: "tune.res.unreachable",
};
const resultTone = (r: string) => r === "already" ? "safe" : r === "cliff" ? "warn" : "ko";

/** One benchmark-ordered cliff card. Authoritative `tune`-operator cards are schema-valid, but the AI lane
 * also feeds AGENT-authored cards (design §6) that are untrusted JSON — a bad field (`survive_tiers:
 * [null]`, `stat:{}`, a non-string `member`/`note`) would crash the panel on a deref. Validate up
 * front and, on ANY schema miss, fall back to raw JSON instead of white-screening. The wrapper calls
 * no hooks, so the early return is safe; the body only ever sees a validated card. */
export function TuneCard({ card }: { card: TuneCardDto }) {
  const parsed = TuneCardDtoSchema.safeParse(card);
  if (!parsed.success) {
    return (
      <div className="panel tune-card">
        <pre className="artifact-pre mono">{JSON.stringify(card, null, 1)}</pre>
      </div>
    );
  }
  return <TuneCardBody card={parsed.data} />;
}

function TuneCardBody({ card }: { card: TuneCardDto }) {
  const t = useT();
  const { lang } = useLang();
  const dexByName = useDexByName();
  const names = useNameMaps();
  const localizeProse = useProseRenderer();
  const [open, setOpen] = useState(false);
  const tone = resultTone(card.result);
  // TuneCard also renders AGENT-authored tune-result cards (unvalidated, design §6): a field
  // typed as an array/object here can be any JSON, so guard every collection/deref — a
  // `{survive_tiers:"bad"}` must degrade, never throw `.map is not a function` and white-screen.
  const tiers = Array.isArray(card.survive_tiers) ? card.survive_tiers : [];
  const assumptions = Array.isArray(card.assumptions) ? card.assumptions : [];
  const hpLane = card.hp_lane && typeof card.hp_lane === "object" ? card.hp_lane : null;
  const attacker = card.attacker && typeof card.attacker === "object" ? card.attacker : null;
  const intimidate = card.intimidate && typeof card.intimidate === "object" ? card.intimidate : null;
  const reallocation = card.reallocation && typeof card.reallocation === "object"
    ? card.reallocation : null;
  const probabilityLanes = Array.isArray(card.probability_lanes) ? card.probability_lanes : [];
  const allocation = card.allocation && typeof card.allocation === "object" ? card.allocation : null;
  const ceilingLane = card.ceiling_lane && typeof card.ceiling_lane === "object"
    ? card.ceiling_lane : null;
  const hasDetail = !!(tiers.length || hpLane || intimidate || attacker || reallocation
    || probabilityLanes.length || allocation || ceilingLane || assumptions.length);
  // Localize the structured head: member/vs species via the dex index, move via the learnset of
  // whichever side OWNS it (survive = the opponent's move; ohko/2hko = the member's own).
  const localMon = (n: string) => {
    const e = dexByName.get(n);
    return e ? displayName(e, lang) : n;
  };
  const moveOwner = typeof card.vs === "string" && card.kind === "survive" ? card.vs : card.member;
  const ownerSlug = dexByName.get(moveOwner)?.slug ?? null;
  const ownerMoves = useAsync<LearnsetDto | null>(
    () => (card.move && ownerSlug ? loadLearnset(ownerSlug).catch(() => null) : Promise.resolve(null)),
    [ownerSlug, card.move]);
  const moveInfo = ownerMoves.status === "ready" && ownerMoves.data
    ? ownerMoves.data.moves.find((m) => m.name === card.move) : undefined;
  const kindKey = optionalKey(`tune.kind.${card.kind}`);
  const resultLabel = (result: string) => {
    const key = RESULT_LABEL[result];
    return key ? t(key) : result;
  };
  const statLabel = (stat: string | undefined) => {
    const key = stat ? optionalKey(`stat.${stat.toLowerCase()}`) : null;
    return key ? t(key) : stat?.toUpperCase() ?? "";
  };
  const sourceLabel = (source: string | undefined) => {
    const key = source ? optionalKey(`tune.source.${source}`) : null;
    return key ? t(key) : (lang === "en" ? source ?? "—" : t("tune.source.synthetic"));
  };
  const probabilityLabel = (probability: string) => {
    const key = optionalKey(`tune.prob.${probability}`);
    return key ? t(key) : probability;
  };
  const scopeLabel = (scope: string) => {
    const key = optionalKey(`tune.scope.${scope}`);
    return key ? t(key) : scope;
  };
  return (
    <div className={`panel tune-card ${tone}`}>
      <div className="tc-head">
        <span className="tc-vs">
          <span className="tc-aspect">{card.aspect === "speed" ? "⚡" : "🛡"}</span>
          {localMon(card.member)}
          <span className="tc-kind">{kindKey ? t(kindKey) : card.kind}</span>
          {typeof card.vs === "string" ? localMon(card.vs) : String(card.vs)}
          {card.move ? <span className="tc-move">· {moveInfo ? displayName(moveInfo, lang) : card.move}</span> : null}
        </span>
        <span className={`tc-result ${tone}`}>
          {resultLabel(card.result)}
        </span>
        {card.result === "cliff" && card.delta_sp != null && (
          <span className="tc-need num">{t("tune.card.needs")} +{card.delta_sp} SP
            {card.need_total != null ? ` → ${card.need_total}` : ""}{card.stat ? ` ${statLabel(card.stat)}` : ""}</span>
        )}
        {card.confidence && <span className="tc-conf">{
          (() => { const key = optionalKey(`conf.${card.confidence}`); return key ? t(key) : card.confidence; })()
        }</span>}
      </div>
      {reallocation && (
        <div className="tc-note">
          {t("tune.card.reallocate").replace("{n}", String(reallocation.required_sp))}
        </div>
      )}
      {allocation && (
        <div className="tc-note">
          {t("tune.card.allocation")}: {Object.entries(allocation).map(([stat, lane]) =>
            `${statLabel(stat)} +${lane.delta_sp} SP → ${lane.need_total}`).join(" · ")}
        </div>
      )}
      {tiers.length ? (
        <div className="tc-tiers">
          {tiers.map((tier, ti) => {
            const rKey = RESULT_LABEL[tier.result];
            return (
              <span key={ti} className={`vchip ${resultTone(tier.result)}`}>
                {t("tune.card.tier").replace("{n}", String(tier.hits))}: {rKey ? t(rKey) : resultLabel(tier.result)}
                {tier.result === "cliff" && tier.delta_sp
                  ? ` +${tier.delta_sp} SP${tier.need_total != null ? ` → ${tier.need_total}` : ""}` : ""}
              </span>
            );
          })}
          {hpLane && (
            <span className={`vchip ${resultTone(hpLane.result)}`}>
              {t("tune.card.hpLane")}: {resultLabel(hpLane.result)}
              {hpLane.result === "cliff" && hpLane.delta_sp ? ` +${hpLane.delta_sp} SP` : ""}
            </span>
          )}
        </div>
      ) : null}
      <div className="tc-note muted">{lang === "en" ? localizeProse(card.note) : t("tune.card.summary")}</div>
      {hasDetail && (
        <button className="tc-more" onClick={() => setOpen((o) => !o)}>
          {open ? "▲" : "▼"} {t("tune.detail")}
        </button>
      )}
      {open && (
        <div className="tc-detail">
          {attacker && (
            <div className="tc-line"><b>{t("tune.attackerSet")}</b> {sourceLabel(attacker.source)}
              {" · "}{attacker.ability ? localName(names.ability, attacker.ability, lang) : "—"}
              {" / "}{attacker.item ? localName(names.item, attacker.item, lang) : "—"}
              {" / "}{attacker.nature ? localName(names.nature, attacker.nature, lang) : "—"}</div>
          )}
          {tiers.map((tier, ti) => (
            <div key={ti} className="tc-line">{t("tune.card.tier").replace("{n}", String(tier.hits))}: {resultLabel(tier.result)}
              {tier.delta_sp
                ? ` (+${tier.delta_sp} SP${tier.need_total != null ? ` → ${tier.need_total}` : ""})`
                : ""}
              {tier.slack_sp != null ? ` · ${t("tune.card.slack").replace("{n}", String(tier.slack_sp))}` : ""}</div>
          ))}
          {hpLane && (
            <div className="tc-line">{t("tune.card.hpLane")}: {resultLabel(hpLane.result)}
              {hpLane.delta_sp ? ` (+${hpLane.delta_sp})` : ""}</div>
          )}
          {probabilityLanes.map((lane) => (
            <div key={lane.probability} className="tc-line">
              {t("tune.card.probability")}: {probabilityLabel(lane.probability)}
              {" · "}{resultLabel(lane.result)}
              {lane.delta_sp
                ? ` (+${lane.delta_sp} SP${lane.need_total != null ? ` → ${lane.need_total}` : ""})`
                : ""}
              {lane.scope ? ` · ${scopeLabel(lane.scope)}` : ""}
            </div>
          ))}
          {ceilingLane && (
            <div className="tc-line">
              {t("tune.card.ceiling")}: {resultLabel(ceilingLane.result)}
              {ceilingLane.target_speed != null ? ` · Speed ${ceilingLane.target_speed}` : ""}
              {ceilingLane.delta_sp ? ` (+${ceilingLane.delta_sp} SP → ${ceilingLane.need_total})` : ""}
            </div>
          )}
          {intimidate && <div className="tc-line">{t("tune.card.intimidate")}: {resultLabel(intimidate.result)}</div>}
          {reallocation && (
            <>
              <div className="tc-line"><b>{t("tune.card.donors")}</b>: {
                reallocation.candidate_donors.map((donor) =>
                  `${statLabel(donor.stat)} ${donor.current_sp} SP`
                  + (donor.available_without_breaking != null
                    ? ` (${t("tune.card.movable")} ${donor.available_without_breaking})` : "")).join(" · ")
              }</div>
              {reallocation.available_without_breaking != null && (
                <div className="tc-line">
                  {t("tune.card.safeCapacity")}: {reallocation.available_without_breaking} SP
                  {reallocation.preserves_existing_benchmarks === false
                    ? ` · ${t("tune.card.protectedShortfall").replace(
                        "{n}", String(reallocation.protected_shortfall_sp ?? 0))}` : ""}
                </div>
              )}
              <div className="tc-assume">· {t("tune.card.reallocationCaveat")}</div>
            </>
          )}
          {assumptions.length > 0 && <div className="tc-assume"><b>{t("tune.card.assumptions")}</b></div>}
          {lang === "en"
            ? assumptions.map((a, i) => <div key={i} className="tc-assume">· {localizeProse(a)}</div>)
            : assumptions.length > 0 && <div className="tc-assume">· {t("tune.card.assumptionGeneric")}</div>}
        </div>
      )}
    </div>
  );
}
