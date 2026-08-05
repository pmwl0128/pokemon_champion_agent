/** Bulk tune: fix a defender, throw a list of incoming attacks at it, and see — live, as you move
 * its HP/Def/SpD SP — what survives ONE and TWO hits (design ref: the gamewith bulk-calculator). The
 * central bar solves the least SP to survive-1 / survive-2 across every incoming attack; "precise"
 * mode hands the same setup to the skill `tune` operator for authoritative cliff cards. Bulk indices
 * (HP×Def / HP×SpD) and each attacker's Atk×BP index update live. */
import type {
  DamageBatchResultDto, DamageRequestDto, FieldDto, FormatId, LearnsetDto,
  NatureDto, StatKey, Terrain, TuneCardDto, Weather,
} from "@pokemon-champions/protocol";
import { STAT_KEYS, TERRAINS, TuneCardDtoSchema, WEATHERS, isErrorShape } from "@pokemon-champions/protocol";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { FormatTabs } from "../../components/FormatTabs.tsx";
import { useAsync, useDexByName, usePokemonCard } from "../../hooks.ts";
import { displayName, optionalKey, useLang, useT, type MsgKey } from "../../i18n.ts";
import { useProseRenderer } from "../../lib/prose.tsx";
import { localName, useNameMaps } from "../../lib/names.ts";
import { actualStat, boostMult } from "../../lib/stats.ts";
import { clearTuneFill, readTeamMembers, takeTuneFill, type TeamMemberish, type TuneFill } from "../../lib/team.ts";
import { loadLearnset, type ItemRef } from "../../runtime/projection.ts";
import { useRuntime } from "../../runtime/context.tsx";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import { BOOST_KEYS, EMPTY_SIDE, FieldCheck, MonPicker, SideForm, autofillSig, cleanSide, modalSig, sideIsBare, useModalFill, withMega, type SideState } from "./shared.tsx";

type DamageItem = DamageBatchResultDto[number];

interface Attack {
  side: SideState;
  moves: string[];   // several moves per attacker — each gets its own verdict/benchmark
}

/** Nature multiplier on one stat (HP always neutral). */
function natMult(nat: NatureDto | undefined, key: StatKey): 0.9 | 1 | 1.1 {
  if (!nat) return 1;
  if (nat.upStat === key) return 1.1;
  if (nat.downStat === key) return 0.9;
  return 1;
}

// Self held-item power multipliers the attack index models (the combatant's OWN item only — field
// items like Light Clay are the central bar's business and deliberately excluded). Type-boost items
// apply only when the picked move's type matches; effectiveness-gated items (Expert Belt) and
// one-shot berries are NOT modelled. Champions ships no direct Def/SpD-raising item, so bulk carries
// no item term.
const TYPE_BOOST_ITEM: Record<string, string> = {
  "Black Belt": "Fighting", "Black Glasses": "Dark", "Charcoal": "Fire", "Magnet": "Electric",
  "Miracle Seed": "Grass", "Silk Scarf": "Normal", "Hard Stone": "Rock", "Poison Barb": "Poison",
  "Soft Sand": "Ground", "Spell Tag": "Ghost",
};
function atkItemMult(item: string, phys: boolean, moveType: string): number {
  let m = 1;
  if (item === "Life Orb") m *= 1.3;
  else if (item === "Muscle Band" && phys) m *= 1.1;
  else if (item === "Wise Glasses" && !phys) m *= 1.1;
  if (TYPE_BOOST_ITEM[item] === moveType) m *= 1.2;
  return m;
}

/** One incoming attacker: its own set + SEVERAL move picks (from its learnset), each move
 * with its own live survive-1 / survive-2 verdict against the tuned defender and its own
 * Atk×BP power index. Rendered as the footer of a shared SideForm. */
function AttackerRow({ side, setSide, moves, setMoves, dex, natures, items, format, resultsByMove, onRemove, onSwap }: {
  side: SideState;
  setSide: Dispatch<SetStateAction<SideState>>;
  moves: string[];
  /** `expectSlug` (optional) guards a write against the CURRENTLY-committed attacker slug —
   * the async meta-fill passes it so a stale fetch can't stamp moves onto a since-switched mon. */
  setMoves: (m: string[], expectSlug?: string) => void;
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  format: FormatId;
  resultsByMove: Record<string, DamageItem>;
  onRemove?: () => void;
  onSwap?: () => void;
}) {
  const { lang } = useLang();
  const t = useT();
  const loadModal = useModalFill();
  const learnset = useAsync<LearnsetDto | null>(
    () => (side.slug ? loadLearnset(side.slug) : Promise.resolve(null)), [side.slug]);
  const card = usePokemonCard(side.slug);
  const damaging = useMemo(() => {
    if (learnset.status !== "ready" || !learnset.data) return [];
    return learnset.data.moves.filter((m) => m.category !== "Status");
  }, [learnset]);

  // Bare or unedited-auto-fill re-fills on a format switch (so a doubles attacker doesn't keep the
  // singles set); a user-edited / swapped-in attacker keeps its build (audit 2026-07-14).
  const fill = useRef<{ key: string; sig: string }>({ key: "", sig: "" });
  useEffect(() => {
    if (!side.slug) return;
    const key = `${format}:${side.slug}`;
    if (fill.current.key === key) return;
    const refill = sideIsBare(side) || autofillSig(side, moves) === fill.current.sig;
    fill.current = { key, sig: fill.current.sig };
    if (!refill) return;
    const filledSlug = side.slug;
    void loadModal(side.slug, format).then((m) => {
      if (!m) return;
      // A newer species/format was picked while this fetch was in flight. The ref-key check alone
      // is racy: a cache-hit modal can resolve BEFORE the switch's own effect run moves fill.current.
      // Guard on the COMMITTED slug (like the defender fill) — inside setSide's functional updater
      // AND via setMoves' expectSlug — so THIS mon's set/moves can never stomp the switched-in one.
      if (fill.current.key !== key) return;
      setSide((s) => (s.slug === filledSlug
        ? { ...s, ability: m.ability, item: m.item, nature: m.nature, sps: m.sps } : s));
      const first = m.moves[0];
      if (first) setMoves([first], filledSlug);
      fill.current = { key, sig: modalSig(m, first ? [first] : moves) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side.slug, format]);

  // Keep the picked moves valid across a species switch: drop moves missing from the new
  // learnset; an emptied selection falls to the first damaging move.
  useEffect(() => {
    if (!damaging.length) return;
    const valid = moves.filter((mv) => damaging.some((m) => m.name === mv));
    if (valid.length !== moves.length || valid.length === 0) {
      setMoves(valid.length ? valid : [damaging[0]!.name]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [damaging]);

  const nat = natures.find((n) => n.name === side.nature);
  // Attack index per move: actual Atk(SpA) × power × STAB × boost/burn/item — same scale as the
  // defender's HP×Def bulk index. Field terms (weather/screens) are excluded on purpose.
  const indexOf = (moveName: string): number | null => {
    const mv = damaging.find((m) => m.name === moveName);
    if (card.status !== "ready" || !mv || !mv.power) return null;
    const s = card.data.stats;
    const phys = mv.category === "Physical";
    const key = phys ? "atk" : "spa";
    const atk = actualStat(phys ? s.atk : s.spa, key,
      (phys ? side.sps.atk : side.sps.spa) ?? 0, natMult(nat, key)) * boostMult(side.boosts[key] ?? 0);
    const stab = card.data.types.includes(mv.type) ? 1.5 : 1;
    const burn = phys && side.status === "Burned" ? 0.5 : 1;
    // 0.44 = the L50 damage-formula lead term (2L/5+2)/50 — verified against the engine
    // (Garchomp EQ vs Hippowdon: 0.44*idx/bulk + 2/HP = 33.7% vs engine 34%). With it,
    // attack index ~= bulk index means the MAX roll lands ~100% (min roll 85%).
    return Math.round(0.44 * atk * mv.power * stab * burn
      * atkItemMult(side.item, phys, mv.type));
  };

  const setMoveAt = (idx: number, value: string) =>
    setMoves(moves.map((m, j) => (j === idx ? value : m)));
  const unpicked = damaging.filter((m) => !moves.includes(m.name));

  const footer = (
    <div className="tune-ctl tune-ctl-multi">
      {moves.map((moveName, mi) => {
        const result = resultsByMove[moveName];
        const ok = result && !isErrorShape(result);
        const surv1 = ok ? result.maxPercent < 100 : false;
        const surv2 = ok ? result.maxPercent < 50 : false;
        const atkIndex = indexOf(moveName);
        return (
          <div key={mi} className="tune-move-row">
            <select value={moveName} onChange={(e) => setMoveAt(mi, e.target.value)} aria-label={t("calc.move")}>
              {damaging.length === 0 && <option value="">{t("calc.noMoves")}</option>}
              {damaging.map((m) => (
                <option key={m.name} value={m.name} disabled={m.name !== moveName && moves.includes(m.name)}>
                  {displayName(m, lang)}{m.power != null ? ` (${m.power})` : ""}
                </option>
              ))}
            </select>
            <div className="tune-verdict">
              {ok ? (
                <>
                  <span className="dmg-band num">{result.minPercent.toFixed(1)}–{result.maxPercent.toFixed(1)}%</span>
                  <span className={`vchip ${surv1 ? "safe" : "ko"}`}>{t("tune.h1")} {surv1 ? "✓" : "✗"}</span>
                  <span className={`vchip ${surv2 ? "safe" : "ko"}`}>{t("tune.h2")} {surv2 ? "✓" : "✗"}</span>
                </>
              ) : result && isErrorShape(result) ? <span className="notice">{t("calc.error")}</span>
                : <span className="muted">{t("tune.pending")}</span>}
              {atkIndex != null && <span className="atk-index" title={t("tune.atkIndexHint")}>{t("tune.atkIndex")} <b className="num">{atkIndex}</b></span>}
              {moves.length > 1 && (
                <button className="linkish" onClick={() => setMoves(moves.filter((_, j) => j !== mi))}>✕</button>
              )}
            </div>
          </div>
        );
      })}
      {unpicked.length > 0 && (
        <button className="ghost-btn tune-add-move"
          onClick={() => setMoves([...moves, unpicked[0]!.name])}>
          + {t("calc.move")}
        </button>
      )}
    </div>
  );

  return (
    <SideForm label={t("calc.attacker")} side={side} setSide={setSide}
      dex={dex} natures={natures} items={items} onRemove={onRemove} onSwap={onSwap} footer={footer} />
  );
}

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

export function TuneTab({ dex, natures, items, initialTeamMode }: {
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  /** true when the URL asked for team mode (a hand-off from the UEP result panel). */
  initialTeamMode?: boolean;
}) {
  const { adapter, can } = useRuntime();
  const t = useT();
  const loadModal = useModalFill();

  const [format, setFormat] = useState<FormatId>("single");
  const [weather, setWeather] = useState<Weather | "">("");
  const [terrain, setTerrain] = useState<Terrain | "">("");
  const [reflect, setReflect] = useState(false);
  const [lightScreen, setLightScreen] = useState(false);
  const [defender, setDefender] = useState<SideState>({ ...EMPTY_SIDE, slug: "garchomp" });
  const [attacks, setAttacks] = useState<Attack[]>([
    { side: { ...EMPTY_SIDE, slug: "mimikyu" }, moves: [] },
  ]);
  // Live verdicts keyed `${attackIndex}:${move}` — one cell per (attacker, move) pair.
  const [results, setResults] = useState<Record<string, DamageItem>>({});
  const [solveBusy, setSolveBusy] = useState(false);
  const [solveNote, setSolveNote] = useState<string | null>(null);
  // A quick-solve suggestion, shown for review with an Apply button instead of writing back directly.
  const proseSolve = useProseRenderer();
  const [proposal, setProposal] = useState<
    { hits: number; def?: number; spd?: number; unreachable: boolean;
      perMove?: Array<{ move: string; attacker: string; stat: "def" | "spd";
                        min: number | null; binding: boolean }> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Precise mode: the authoritative `tune` operator (cliff cards) vs the live in-page quick calc.
  const canTune = can("team.tune");
  const [precise, setPrecise] = useState((initialTeamMode ?? false) && canTune);
  // Team CONTEXT from a UEP build session (precise-mode only; quick stays the simple tool).
  // A strip of members — click one to load its full recommended set as the tune target;
  // precise runs then send the WHOLE team with the edited member swapped over its entry.
  const [teamCtx, setTeamCtx] = useState<TuneFill | null>(() => takeTuneFill());
  const teamMembers = useMemo(
    () => (teamCtx ? readTeamMembers(teamCtx.team) : []), [teamCtx]);
  // Requests beyond the precise survival form (outspeed / KO, multi-member / whole-team,
  // environment-filtered or fuzzy goals) go to the session as a tune-request artifact; the
  // agent translates + runs and puts a tune-result back.
  const [tuneNote, setTuneNote] = useState("");
  const [lastRun, setLastRun] = useState<unknown[] | null>(null);
  const [writeState, setWriteState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [writeErr, setWriteErr] = useState("");
  const [resultRefresh, setResultRefresh] = useState(0);
  const [cards, setCards] = useState<TuneCardDto[] | null>(null);
  const [precBusy, setPrecBusy] = useState(false);
  const [precErr, setPrecErr] = useState<string | null>(null);

  const entryOf = (slug: string) => dex.find((e) => e.slug === slug);
  const { lang } = useLang();

  // Load a team member's FULL SET as the tune target: it arrives exactly as the build
  // recommended it, then every knob on this page applies to it like to any hand-picked mon.
  const loadMember = (m: TeamMemberish) => {
    const entry = dex.find((e) => e.name === m.species);
    if (!entry) return;
    const sps: SideState["sps"] = {};
    for (const [k, v] of Object.entries(m.spread ?? {})) {
      if (typeof v === "number" && v > 0 && (STAT_KEYS as readonly string[]).includes(k)) {
        sps[k as StatKey] = v;
      }
    }
    setDefender({ ...EMPTY_SIDE, slug: entry.slug, item: m.item ?? "",
                  ability: m.ability ?? "", nature: m.nature ?? "", sps });
    setCards(null);
  };

  // Arriving from the UEP result panel: precise mode, team format, first member pre-loaded.
  const handed = useRef(false);
  useEffect(() => {
    if (handed.current || !teamCtx) return;
    handed.current = true;
    const f = (teamCtx.team as { format?: unknown } | null)?.format;
    if (f === "single" || f === "double") setFormat(f);
    if (initialTeamMode && teamMembers[0]) loadMember(teamMembers[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamCtx]);

  // AI lane: send the free-text request (plus whatever benchmarks the form already ran, as
  // context the agent may reuse) into the originating session. Without an originating build
  // session (the tune page reached directly), the first send CREATES one — a tune ask is a
  // session-worthy intent of its own. The agent translates per the UEP discipline and puts
  // a tune-result artifact back.
  const [aiSid, setAiSid] = useState<string | null>(null);
  const aiSessionId = teamCtx?.sessionId ?? aiSid;
  const sendRequest = async () => {
    const s = adapter.sessions;
    if (!s || !tuneNote.trim()) return;
    setWriteState("busy"); setWriteErr("");
    // Carry enough for the agent to actually tune: the source team when we came from a build
    // session, PLUS a snapshot of the member's current edited set. Without this, a request from
    // the standalone tune page (no originating `draft`) leaves the agent with nothing to tune
    // (companion SKILL.md reads the team from `draft`) — see design §6.
    const memberSpread: Record<string, number> = {};
    for (const k of STAT_KEYS) if (defender.sps[k]) memberSpread[k] = defender.sps[k]!;
    const memberSet = {
      species: entryOf(defender.slug)?.name,
      ...(defender.item ? { item: defender.item } : {}),
      ...(defender.ability ? { ability: defender.ability } : {}),
      ...(defender.nature ? { nature: defender.nature } : {}),
      ...(Object.keys(memberSpread).length ? { spread: memberSpread } : {}),
    };
    const payload = JSON.stringify({
      kind: "tune-request",
      note: tuneNote.trim(),
      member: entryOf(defender.slug)?.name ?? undefined,
      member_set: memberSet,
      team: teamCtx?.team ?? null,
      form_benchmarks: lastRun ?? [],
    }, null, 1);
    try {
      let sid = aiSessionId;
      if (!sid) {
        const created = await s.create({ intent: tuneNote.trim().slice(0, 120), source: "tune-page" });
        sid = created.id;
        setAiSid(sid);
      }
      const sess = await s.get(sid);
      await s.putArtifact(sid, "tune-request", payload, sess.revision);
      setWriteState("done");
    } catch (e) {
      console.error("Tune request submission failed:", e);
      setWriteState("error"); setWriteErr(t("uep.submitError"));
    }
  };

  // Latest agent tune-result for this session (manual refresh — no SSE plumbing here).
  const agentResult = useAsync(async () => {
    const s = adapter.sessions;
    const sid = aiSessionId;
    if (!s || !sid) return null;
    try {
      const sess = await s.get(sid);
      const h = sess.heads["tune-result"];
      if (!h) return null;
      // Stale-guard: a tune-result that predates the latest tune-request is the answer to an
      // OLDER ask — don't render it as the response to the request just sent.
      const seqOf = (kind: string) =>
        sess.ledger.reduce((mx, e) => (e.kind === kind && e.sequence > mx ? e.sequence : mx), -1);
      if (seqOf("tune-result") < seqOf("tune-request")) return null;
      const a = await s.artifact(h);
      const parsed = JSON.parse(a.text) as { cards?: unknown[] };
      // Agent-authored artifact: keep only object cards. TuneCard is a lenient reader over its
      // fields, but a null/primitive element would throw on the first deref (no error boundary,
      // no raw fallback on this lane), so a malformed card must never reach it.
      if (!Array.isArray(parsed.cards)) return null;
      return parsed.cards.filter((c): c is TuneCardDto => !!c && typeof c === "object");
    } catch {
      return null;
    }
  }, [aiSessionId, resultRefresh]);

  const defCard = usePokemonCard(defender.slug);
  const defNat = natures.find((n) => n.name === defender.nature);

  // Live bulk indices — HP × Def (physical) and HP × SpD (special) actual stats, each defence scaled
  // by its own boost stage (Champions has no Def/SpD-raising item and status doesn't touch defence,
  // so no item/status term). Same scale as each attacker's Atk×BP×STAB index for direct comparison.
  const bulk = defCard.status === "ready" ? (() => {
    const s = defCard.data.stats;
    const hp = actualStat(s.hp, "hp", defender.sps.hp ?? 0, 1);
    const def = actualStat(s.def, "def", defender.sps.def ?? 0, natMult(defNat, "def"))
      * boostMult(defender.boosts.def ?? 0);
    const spd = actualStat(s.spd, "spd", defender.sps.spd ?? 0, natMult(defNat, "spd"))
      * boostMult(defender.boosts.spd ?? 0);
    return { phys: Math.round(hp * def), spec: Math.round(hp * spd) };
  })() : null;

  // Swapping the tuned mon clears the live verdicts (they'd otherwise keep showing the previous mon's
  // survive numbers against the new pick until the meta-fill + rebatch lands).
  useEffect(() => { setResults({}); }, [defender.slug]);
  // Any defender edit invalidates a pending quick-solve suggestion and its note (they were computed
  // against the old spread — showing them next to a changed config is a dirty read).
  const defSig = useMemo(() => JSON.stringify(defender), [defender]);
  useEffect(() => { setProposal(null); setSolveNote(null); }, [defSig]);

  // Defender auto-fills its meta-standard set on a fresh pick — a sensible bulk baseline to tune from.
  // Bare or unedited-auto-fill re-fills on a format switch; a configured/swapped-in defender is kept.
  const defFill = useRef<{ key: string; sig: string }>({ key: "", sig: "" });
  useEffect(() => {
    if (!defender.slug) return;
    const key = `${format}:${defender.slug}`;
    if (defFill.current.key === key) return;
    const refill = sideIsBare(defender) || autofillSig(defender) === defFill.current.sig;
    defFill.current = { key, sig: defFill.current.sig };
    if (!refill) return;
    const filledSlug = defender.slug;
    void loadModal(defender.slug, format).then((m) => {
      if (!m) return;
      // The hand-off (loadMember) switches the defender in the SAME mount flush that fires this
      // fill, so a cache-hit modal can resolve before any effect re-runs. Guard INSIDE the
      // functional updater — it always sees the latest committed state regardless of microtask
      // timing — so THIS slug's modal item/ability/nature/SP can never stomp the switched member.
      setDefender((s) => (s.slug === filledSlug
        ? { ...s, ability: m.ability, item: m.item, nature: m.nature, sps: m.sps } : s));
      if (defFill.current.key === key) defFill.current = { key, sig: modalSig(m, []) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defender.slug, format]);

  const buildField = (): FieldDto => {
    const defenderSide: Record<string, boolean> = {};
    if (reflect) defenderSide.reflect = true;
    if (lightScreen) defenderSide.light_screen = true;
    return {
      format,
      ...(weather ? { weather } : {}),
      ...(terrain ? { terrain } : {}),
      ...(Object.keys(defenderSide).length ? { defenderSide } : {}),
    };
  };

  // Live damage: every attack vs the current defender spread, recomputed on any edit (one batch).
  const runToken = useRef(0);
  const sig = JSON.stringify([defender, attacks, format, weather, terrain, reflect, lightScreen]);
  useEffect(() => {
    const dEntry = entryOf(defender.slug);
    const valid = attacks.flatMap((a, i) =>
      entryOf(a.side.slug) ? a.moves.filter(Boolean).map((move) => ({ a, i, move })) : []);
    if (!dEntry || !valid.length) { setResults({}); return; }
    const field = buildField();
    const items_: DamageRequestDto[] = valid.map(({ a, move }) => ({
      attacker: (() => {
        const eff = withMega(a.side, dex, items);
        return cleanSide(eff.state, eff.entry?.name ?? entryOf(a.side.slug)!.name);
      })(),
      defender: (() => {
        const eff = withMega(defender, dex, items);
        return cleanSide(eff.state, eff.entry?.name ?? dEntry.name);
      })(),
      move,
      field,
    }));
    const token = ++runToken.current;
    adapter.damageBatch(items_).then((res) => {
      if (token !== runToken.current) return;
      const map: Record<string, DamageItem> = {};
      valid.forEach((v, k) => { map[`${v.i}:${v.move}`] = res[k]!; });
      setResults(map);
      setError(null);
    }).catch((e) => {
      console.error("Live tune calculation failed:", e);
      if (token === runToken.current) { setResults({}); setError(t("calc.error")); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Global reverse solve: the least SP in Def / SpD so the defender survives `hits` hits of EVERY
  // incoming attack (physical hits vary Def, special hits vary SpD; each attack's category comes from
  // its live result). One batch of attacks×33 variants; per stat we take the worst attack's minimum.
  const solveAll = async (hits: number) => {
    const dEntry = entryOf(defender.slug);
    if (!dEntry) { setSolveNote(t("tune.pickDefender")); return; }
    const usable = attacks.flatMap((a, i) =>
      entryOf(a.side.slug)
        ? a.moves.filter((move) => {
            const r = results[`${i}:${move}`];
            return move && r && !isErrorShape(r);
          }).map((move) => ({ a, i, move }))
        : []);
    if (!usable.length) { setSolveNote(t("tune.needAttacks")); return; }
    const field = buildField();
    const items_: DamageRequestDto[] = [];
    const map: Array<{ key: string; stat: "def" | "spd"; sp: number }> = [];
    usable.forEach(({ a, i, move }) => {
      const r = results[`${i}:${move}`]!;
      if (isErrorShape(r)) return;
      const stat: "def" | "spd" = r.category === "Physical" ? "def" : "spd";
      const aEntry = entryOf(a.side.slug)!;
      for (let sp = 0; sp <= 32; sp++) {
        const dv: SideState = { ...defender, sps: { ...defender.sps, [stat]: sp } };
        items_.push({ attacker: cleanSide(a.side, aEntry.name),
          defender: cleanSide(dv, dEntry.name), move, field });
        map.push({ key: `${i}:${move}`, stat, sp });
      }
    });
    if (!items_.length) { setSolveNote(t("tune.needAttacks")); return; }
    if (items_.length > 240) { setSolveNote(t("calc.tooMany")); return; }
    setSolveBusy(true); setSolveNote(null);
    try {
      const res = await adapter.damageBatch(items_);
      const byAttack = new Map<string, { stat: "def" | "spd"; min: number | null }>();
      map.forEach((m, k) => {
        const r = res[k];
        const surv = !!(r && !isErrorShape(r) && r.maxPercent < 100 / hits);
        const cur = byAttack.get(m.key);
        if (!cur) byAttack.set(m.key, { stat: m.stat, min: surv ? m.sp : null });
        else if (surv && cur.min === null) cur.min = m.sp;   // sp ascends → first survivor is the min
      });
      const need: Record<"def" | "spd", number> = { def: 0, spd: 0 };
      let setDef = false, setSpd = false, unreachable = false;
      byAttack.forEach(({ stat, min }) => {
        if (min === null) { unreachable = true; return; }
        need[stat] = Math.max(need[stat], min);
        if (stat === "def") setDef = true; else setSpd = true;
      });
      // Per-move breakdown: the ONE suggestion is the max across attacks per stat (the
      // defender must satisfy the hungriest move); the rows disclose each move's own
      // minimum so a mixed list stays legible (user question 2026-07-16).
      const perMove = usable.map(({ a, i, move }) => {
        const rec = byAttack.get(`${i}:${move}`);
        const aEntry = entryOf(a.side.slug);
        return { move, attacker: aEntry?.name ?? "", stat: rec?.stat ?? "def",
                 min: rec?.min ?? null,
                 binding: rec?.min != null && rec.min === need[rec.stat] };
      });
      // Don't write back — surface the suggestion + an Apply button for review.
      setSolveNote(null);
      setProposal({ hits, ...(setDef ? { def: need.def } : {}), ...(setSpd ? { spd: need.spd } : {}),
        unreachable, perMove });
    } catch (e) {
      console.error("Tune solve failed:", e);
      setSolveNote(t("calc.error")); setProposal(null);
    } finally {
      setSolveBusy(false);
    }
  };

  // Swap an incoming attacker with the tuned defender (tune the attacker's bulk instead). Both keep
  // their build (the fill effects skip a non-bare side); the new attacker's move refills.
  const swapWithDefender = (i: number) => {
    const x = attacks[i]!.side;
    setAttacks((prev) => prev.map((a, j) => (j === i ? { ...a, side: defender, moves: [] } : a)));
    setDefender(x);
  };

  // Precise solve: hand the defender + each incoming attack to the skill `tune` operator as a
  // team-json member + survival benchmarks (a filled attacker becomes an explicit `attacker_set`;
  // an empty one lets tune pull the meta modal set). Returns benchmark-ordered cliff cards.
  const runPrecise = async () => {
    const dEntry = entryOf(defender.slug);
    if (!dEntry) { setPrecErr(t("tune.pickDefender")); return; }
    const spread: Record<string, number> = {};
    for (const k of STAT_KEYS) if (defender.sps[k]) spread[k] = defender.sps[k]!;
    const member = {
      species: dEntry.name, moves: [] as string[], spread,
      ...(defender.nature ? { nature: defender.nature } : {}),
      ...(defender.item ? { item: defender.item } : {}),
      ...(defender.ability ? { ability: defender.ability } : {}),
    };
    // Field conditions must match the live quick-calc exactly (external audit: terrain was dropped and
    // dual walls collapsed to reflect-only, so precise/quick disagreed). Terrain rides along; both
    // walls up map to aurora_veil, which the tune engine reduces for EITHER category (a plain
    // reflect/light_screen only guards its own category, per _screen_side).
    const conditions: Record<string, unknown> = {};
    if (weather) conditions.weather = weather.toLowerCase();
    if (terrain) conditions.terrain = terrain.toLowerCase();
    if (reflect && lightScreen) conditions.screens = "aurora_veil";
    else if (reflect) conditions.screens = "reflect";
    else if (lightScreen) conditions.screens = "light_screen";
    const benchmarks = attacks.flatMap((a) => {
      const aEntry = entryOf(a.side.slug);
      if (!aEntry || !a.moves.some(Boolean)) return [];
      const aset: Record<string, unknown> = {};
      if (a.side.ability) aset.ability = a.side.ability;
      if (a.side.item) aset.item = a.side.item;
      if (a.side.nature) aset.nature = a.side.nature;
      // Quick calc passes the attacker's status + boosts through cleanSide; precise must too, or a
      // burned / +2-Atk attacker gives a materially different verdict between the two modes. tune's
      // attacker_set spreads straight onto the ncp attacker (tune.py _attacker_ncp), which honors both.
      if (a.side.status) aset.status = a.side.status;
      const asp: Record<string, number> = {};
      for (const k of STAT_KEYS) if (a.side.sps[k]) asp[k] = a.side.sps[k]!;
      if (Object.keys(asp).length) aset.spread = asp;
      const aboost: Record<string, number> = {};
      for (const k of BOOST_KEYS) if (a.side.boosts[k]) aboost[k] = a.side.boosts[k]!;
      if (Object.keys(aboost).length) aset.boosts = aboost;
      return a.moves.filter(Boolean).map((move) => ({
        member: dEntry.name, kind: "survive", vs: aEntry.name, move,
        probability: "guaranteed",
        ...(Object.keys(conditions).length ? { conditions } : {}),
        ...(Object.keys(aset).length ? { attacker_set: aset } : {}),
      }));
    });
    if (!benchmarks.length) { setPrecErr(t("tune.needAttacks")); return; }
    // With a team context, tune the member INSIDE its real team: swap the edited set over
    // the original entry so the operator sees both the user's tweaks and the full roster.
    const teamObj = teamCtx?.team as { pokemon?: unknown[] } | null;
    const orig = teamMembers.find((p) => p.species === dEntry.name);
    const file = teamObj && Array.isArray(teamObj.pokemon) && orig
      ? {
          ...teamObj,
          pokemon: teamObj.pokemon.map((p) =>
            (p as { species?: unknown }).species === dEntry.name
              ? { ...(p as object), ...member, moves: orig.moves ?? [] } : p),
        }
      : { format, pokemon: [member] };
    setPrecBusy(true); setPrecErr(null);
    try {
      const out = await adapter.tune(file, benchmarks);
      setCards(out.cards);
      setLastRun(benchmarks);
      setWriteState("idle");
    } catch (e) {
      console.error("Precise tune failed:", e);
      setCards(null); setPrecErr(t("calc.error"));
    } finally {
      setPrecBusy(false);
    }
  };

  return (
    <>
      <div className="subtabs tune-mode">
        <button className={`subtab${!precise ? " on" : ""}`}
          onClick={() => setPrecise(false)}>{t("tune.mode.quick")}</button>
        {canTune ? (
          <button className={`subtab${precise ? " on" : ""}`}
            onClick={() => setPrecise(true)}>{t("tune.mode.precise")}</button>
        ) : (
          <span className="disabled-tab-tip" tabIndex={0}
                aria-label={t("tune.preciseUnavailable")}
                data-tooltip={t("tune.preciseUnavailable")}>
            <button className="subtab" disabled>{t("tune.mode.precise")}</button>
          </span>
        )}
      </div>
      {precise && teamCtx && teamMembers.length > 0 && (
        <div className="tune-team-strip">
          <span className="muted">{t("tune.team.strip")}{teamCtx.label ? ` · ${teamCtx.label}` : ""}:</span>
          <span className="seg">
            {teamMembers.map((m, i) => {
              const entry = dex.find((e) => e.name === m.species);
              const on = !!entry && entry.slug === defender.slug;
              return (
                <button key={`${m.species}-${i}`} className={on ? "on" : ""}
                        onClick={() => loadMember(m)}>
                  {entry ? displayName(entry, lang) : m.species}
                </button>
              );
            })}
          </span>
          <button className="linkish" onClick={() => { clearTuneFill(); setTeamCtx(null); }}>
            {t("tune.team.clear")}
          </button>
          <span className="muted tune-team-hint">{t("tune.team.pickHint")}</span>
        </div>
      )}
      <div className="tune-head">
        <h2 className="page-title" style={{ fontSize: 15, margin: 0 }}>{t("tune.target")}</h2>
        {bulk && (
          <span className="bulk-index" title={t("tune.bulkIndexHint")}>
            <span className="bi phys">{t("tune.physBulk")} <b className="num">{bulk.phys}</b></span>
            <span className="bi spec">{t("tune.specBulk")} <b className="num">{bulk.spec}</b></span>
          </span>
        )}
      </div>
      <SideForm label={t("tune.defender")} side={defender} setSide={setDefender}
        dex={dex} natures={natures} items={items} />

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
          </div>
          {precise ? (
            <button className="primary-btn" disabled={precBusy || !defender.slug}
              onClick={() => void runPrecise()}>
              {precBusy ? t("state.loading") : t("tune.solveAll")}
            </button>
          ) : (
            <div className="tune-solve-btns">
              <button className="primary-btn" disabled={solveBusy}
                onClick={() => void solveAll(1)}>{t("tune.solve1")}</button>
              <button className="primary-btn" disabled={solveBusy}
                onClick={() => void solveAll(2)}>{t("tune.solve2")}</button>
            </div>
          )}
        </div>
        {!precise && solveNote && <div className="tune-note">{solveNote}</div>}
        {!precise && proposal && (
          <div className="tune-proposal">
            <span className="tp-head">
              {t(proposal.unreachable ? "tune.propPartial" : "tune.propOk").replace("{h}", String(proposal.hits))}
            </span>
            <span className="tp-vals">
              {proposal.def != null && (
                <span className="vchip">Def SP {defender.sps.def ?? 0} → <b className="num">{proposal.def}</b></span>
              )}
              {proposal.spd != null && (
                <span className="vchip">SpD SP {defender.sps.spd ?? 0} → <b className="num">{proposal.spd}</b></span>
              )}
            </span>
            {(proposal.perMove?.length ?? 0) > 1 && (
              <ul className="tp-permove">
                {proposal.perMove!.map((pm, i) => (
                  <li key={`${pm.attacker}-${pm.move}-${i}`}
                      className={pm.binding ? "binding" : ""}>
                    {proseSolve(`${pm.attacker} ${pm.move}`)}
                    <span className="num muted"> → {pm.stat === "def" ? "Def" : "SpD"}{" "}
                      {pm.min != null ? `≥${pm.min}` : t("tune.propNoSp")}</span>
                    {pm.binding && <span className="tp-bind"> ←</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="defenders-head">
        <h2 className="page-title" style={{ fontSize: 15, margin: 0 }}>{t("tune.attackers")}</h2>
        <button className="ghost-btn"
          onClick={() => setAttacks((a) => [...a, { side: { ...EMPTY_SIDE }, moves: [] }])}>
          + {t("tune.addAttacker")}
        </button>
      </div>
      <div className="defenders-grid">
        {attacks.map((a, i) => (
          <AttackerRow key={i} side={a.side}
            setSide={(u) => setAttacks((prev) => prev.map((x, j) => j === i
              ? { ...x, side: typeof u === "function" ? (u as (s: SideState) => SideState)(x.side) : u }
              : x))}
            moves={a.moves}
            setMoves={(m, expectSlug) => setAttacks((prev) => prev.map((x, j) =>
              (j === i && (expectSlug === undefined || x.side.slug === expectSlug))
                ? { ...x, moves: m } : x))}
            dex={dex} natures={natures} items={items} format={format}
            resultsByMove={Object.fromEntries(
              a.moves.filter((mv) => results[`${i}:${mv}`])
                .map((mv) => [mv, results[`${i}:${mv}`]!]))}
            onSwap={() => swapWithDefender(i)}
            onRemove={attacks.length > 1 ? () => setAttacks((prev) => prev.filter((_, j) => j !== i)) : undefined} />
        ))}
      </div>

      {error && <div className="notice mono" style={{ marginTop: 14 }}>{error}</div>}

      {precise ? (
        <div className="tune-precise">
          {precErr && <div className="notice mono">{precErr}</div>}
          {cards && cards.length === 0 && <div className="notice">{t("tune.noCards")}</div>}
          {cards && cards.length > 0 && (
            <div className="tune-cards">
              {cards.map((c, i) => <TuneCard key={`${c.member}-${c.vs}-${c.move ?? i}`} card={c} />)}
            </div>
          )}
          {adapter.sessions && (
            <section className="panel tune-ai">
              <div className="tune-ai-head">
                <h2>{t("tune.ai.title")}</h2>
                <p className="muted">{t("tune.ai.hint")}</p>
              </div>
              <div className="tune-writeback">
                <textarea rows={3} value={tuneNote} placeholder={t("tune.ai.ph")}
                          onChange={(e) => { setTuneNote(e.target.value); setWriteState("idle"); }} />
                <div className="tune-ai-actions">
                  <button className="primary-btn" disabled={writeState === "busy" || !tuneNote.trim()}
                          onClick={() => void sendRequest()}>
                    {t("tune.ai.send")}
                  </button>
                  <button className="second-btn" onClick={() => setResultRefresh((n) => n + 1)}>
                    {t("tune.ai.refresh")}
                  </button>
                  {writeState === "done" && <span className="muted tune-ai-sent">{t("tune.ai.sent")}</span>}
                </div>
                {writeState === "error" && <div className="notice mono">{writeErr}</div>}
              </div>
              {agentResult.status === "ready" && agentResult.data && agentResult.data.length > 0 && (
                <>
                  <h3 className="tune-ai-result-head">{t("tune.ai.result")}</h3>
                  <div className="tune-cards">
                    {agentResult.data.map((c, i) => <TuneCard key={i} card={c} />)}
                  </div>
                </>
              )}
            </section>
          )}
          {(defender.status || Object.keys(defender.boosts).length > 0) && (
            <p className="notice mono">{t("tune.preciseDefIgnored")}</p>
          )}
          <p className="muted tune-hint">{t("tune.preciseHint")}</p>
        </div>
      ) : (
        <p className="muted tune-hint">{t("tune.hint")}</p>
      )}
    </>
  );
}
