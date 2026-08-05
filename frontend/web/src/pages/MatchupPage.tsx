/** Opponent matchup grid (the team skill's M5 reference cache). Two views over one dataset:
 *  - KO 表:   attacker i's hardest move vs defender j's standard set — the stored offense/KO grid.
 *  - Check 表: derived C2/C1/C0 check grades over attacker×attacker pairs.
 * Rows and columns are the meta top-K; cells are colored by KO bucket / check grade, and clicking
 * a cell opens its facts. Every cell is `low` confidence (retained observed builds, NOT your team) —
 * surfaced up top, never hidden. Available on either runtime when team.matchup is advertised. */
import type {
  FormatId, OppCheckGrade, OppCheckGridDto, OppKoGridDto, OppKoSummaryDto,
  OppOffenseDto, OppSetDto,
  SpeciesRowDto,
} from "@pokemon-champions/protocol";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { stashDamageFill } from "../lib/team.ts";
import { FormatTabs } from "../components/FormatTabs.tsx";
import { EntityHover } from "../components/EntityHover.tsx";
import { GameImage } from "../components/GameImage.tsx";
import { activeKey, ColHead, RowHead } from "../components/MatchupHeads.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SegmentedControl, segmentedPanelId, segmentedTabId }
  from "../components/SegmentedControl.tsx";
import { useOppCache, useOppChecks, useOppKo } from "../hooks.ts";
import { useRuntime } from "../runtime/context.tsx";
import { displayName, optionalKey, useLang, useT, type Lang } from "../i18n.ts";
import { useDamageText } from "../lib/damageText.tsx";
import { koLabel, koTone } from "../lib/ko.ts";
import { CellInspector, SetBlock, type InspectorDamage } from "../components/CellInspector.tsx";
import { ActualMatchupWorkspace } from "./ActualMatchupWorkspace.tsx";

function offenseKoChance(off: Pick<OppOffenseDto,
  "ko" | "koChance" | "koGuaranteed" | "koPossible">) {
  if (off.koChance) return off.koChance;
  // No engine verdict: fall back to the static rolls, where "guaranteed" means the WORST roll also
  // kills in that many turns. `koGuaranteed != null` was not that test — it labelled a 乱2 as 确2.
  const g = off.koGuaranteed, p = off.koPossible;
  const guaranteed = g != null && (p == null || g === p);
  return { text: off.ko, n: guaranteed ? g : (p ?? g ?? undefined), guaranteed };
}

/** An opponent-cache offense fact in the inspector's shape. One place decides 确 vs 乱 (always the
 * engine's recovery-aware verdict when present) and collects the caveats, so no grid can drift. */
function inspectorDamage(off: OppOffenseDto | null | undefined,
                         t: (k: never) => string,
                         damageText: ReturnType<typeof useDamageText>): InspectorDamage | null {
  if (!off) return null;
  const caveats: ReactNode[] = [];
  if (off.disguiseAdjusted) caveats.push(t("calc.disguiseAdjusted" as never));
  for (const cv of off.koCaveats ?? []) caveats.push(damageText.caveat(cv));
  return {
    move: off.move, minPercent: off.minPercent, maxPercent: off.maxPercent,
    ko: offenseKoChance(off), caveats,
  };
}

// The cache stores species name-sorted (stable git diffs); the grid orders by usage rank so the
// most-used mons sit top-left. Unranked rows sink to the end.
const byRank = (a: SpeciesRowDto, b: SpeciesRowDto): number =>
  (a.rank ?? 1e9) - (b.rank ?? 1e9);

/** The processed set one side was computed with. Public projections strip its provenance fields
 * while retaining the battle inputs needed by the detail panel and calculator hand-off (§7.1). */
const speciesSlug = (key: string, set: OppSetDto | undefined): string => {
  const name = set?.runForm || set?.species
    || (key.startsWith("variant:")
      ? (key.slice("variant:".length).split("|", 1)[0] ?? key) : key);
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
};

/** stashDamageFill side coordinates from an opponent-cache set. Cache keys may be variant ids;
 * the calculator coordinate must always be the dex species/form slug. */
export function fillFromSet(key: string, set: OppSetDto | undefined) {
  return {
    slug: speciesSlug(key, set),
    ...(set?.ability ? { ability: set.ability } : {}),
    ...(set?.item ? { item: set.item } : {}),
    ...(set?.nature ? { nature: set.nature } : {}),
    ...(set?.sps ? { sps: set.sps as Record<string, number> } : {}),
  };
}

function CellSets({ sets, aSlug, bSlug, aTitle, bTitle, format, move }: {
  sets: Record<string, OppSetDto> | undefined;
  aSlug: string; bSlug: string;
  aTitle: ReactNode; bTitle: ReactNode;
  format: FormatId;
  /** The cell's own move: pre-selected in the calculator hand-off. */
  move?: string | null;
}) {
  const t = useT();
  const damageText = useDamageText();
  const navigate = useNavigate();
  if (!sets || (!sets[aSlug] && !sets[bSlug])) return null;
  return (
    <>
      <div className="md-line md-caveat">
        {t("matchup.setUsed")}
        <button type="button" className="second-btn md-verify"
                onClick={() => {
                  const attacker = fillFromSet(aSlug, sets[aSlug]);
                  stashDamageFill({
                    format, attackerSlug: attacker.slug,
                    attacker,
                    defender: fillFromSet(bSlug, sets[bSlug]),
                    ...(move ? { move } : {}),
                  });
                  navigate("/calc?tab=damage");
                }}>
          {t("builder.verifyCalc")}
        </button>
      </div>
      <div className="md-sets">
        <SetBlock title={aTitle} set={sets[aSlug]} prose={damageText.name} />
        <SetBlock title={bTitle} set={sets[bSlug]} prose={damageText.name} />
      </div>
    </>
  );
}

function DetailMon({ s, lang }: { s: SpeciesRowDto; lang: Lang }) {
  return (
    <EntityHover kind="pokemon" name={s.name}>
      <span className="prose-mon">
        <GameImage assetKey={`pokemon:${s.slug}`} role="dense" alt=""
                   className="prose-mon-img" />
        {displayName(s, lang)}
      </span>
    </EntityHover>
  );
}







/** Detail-panel heading for a selected cell side. The cell's coordinates are VARIANT keys, so the
 * species must be resolved through the variant map (the roster is species-keyed — reading it with a
 * variant key returned undefined and crashed the panel). The build is appended when it is not the
 * default, since "Staraptor" alone would not say which of its builds this row is. */
function variantTitle(s: SpeciesRowDto | undefined, set: OppSetDto | undefined,
                      lang: Lang): string {
  if (!s) return set?.species ?? "—";
  const name = displayName(s, lang);
  return set?.item && set.isModal === false ? `${name} · ${set.item}` : name;
}





// -- KO / offense grid --------------------------------------------------------------------------

function KoGrid({ format }: { format: FormatId }) {
  const state = useOppKo(format);
  const { lang } = useLang();
  const t = useT();
  const damageText = useDamageText();
  const [sel, setSel] = useState<{ a: string; d: string } | null>(null);
  // The overview paints every cell from a compact document. The full 7–14 MB cache is useful only
  // for the selected cell's move, speed, caveats and sets, so defer it until selection.
  const cacheState = useOppCache(format, sel !== null);
  const detailCache = cacheState.status === "ready" ? cacheState.data : null;
  // speciesSlug -> variantKey, kept SEPARATELY per axis: a Pokemon read as one build while
  // attacking and another while defending is a normal thing to want, and sharing one map made
  // picking an attacker build silently rewrite the defender column too.
  const [rowPicks, setRowPicks] = useState<Record<string, string>>({});
  const [colPicks, setColPicks] = useState<Record<string, string>>({});
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sel) return;
    const frame = requestAnimationFrame(() => detailRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    }));
    return () => cancelAnimationFrame(frame);
  }, [sel, cacheState.status]);

  const view = useMemo(() => {
    if (state.status !== "ready") return null;
    const overview: OppKoGridDto = state.data;
    const cols = [...overview.species].sort(byRank);             // every species can be a defender
    // Attacker rows are decided by the ACTIVE build: switching a species to a build that has no
    // offense row (meta-only) correctly drops it from the rows.
    const rows = cols.filter((s) => overview.grid[activeKey(s, rowPicks)]);
    // Variant key -> its species row, so the detail panel can name a selected cell whose
    // coordinates are variant keys rather than species slugs.
    const byVariant = new Map<string, SpeciesRowDto>();
    for (const sp of overview.species) {
      for (const v of sp.variants ?? []) byVariant.set(v.key, sp);
      byVariant.set(sp.slug, sp);                     // legacy grid: key IS the species slug
    }
    return { overview, cols, rows, byVariant };
  }, [state, rowPicks]);

  if (state.status === "loading") return <div className="spinner">{t("state.loading")}</div>;
  if (state.status === "error") {
    return <div className="notice">{state.httpStatus === 404
      ? t("matchup.notBuilt")
      : t("state.errorDetail")}</div>;
  }
  if (!view) return null;
  const { overview, cols, rows, byVariant } = view;
  const detailCell = sel ? detailCache?.matrix[sel.a]?.[sel.d] : null;
  const detailOff = detailCell?.offense ?? null;

  return (
    <>
      <div className={`matrix-guide${sel ? " active" : ""}`} aria-live="polite">
        <span className="matrix-guide-mark" aria-hidden>{sel ? "✓" : "↘"}</span>
        {t(sel ? "matchup.cellSelected" : "matchup.cellHint")}
      </div>
      {cols.some((c) => (c.variants?.length ?? 0) > 1) && (
        <div className="matrix-guide variant-guide">
          <span className="matrix-guide-mark" aria-hidden>◧</span>
          {t("matchup.variantHint")}
        </div>
      )}
      <div className="matchup-scroll">
        <table className="matchup-grid">
          <thead>
            <tr>
              <th className="corner">{t("matchup.attacker")} \ {t("matchup.defender")}</th>
              {cols.map((c) => (
                <ColHead key={c.slug} s={c} lang={lang} picks={colPicks}
                         open={openPicker === `col:${c.slug}`}
                         onToggle={() => setOpenPicker((k) => k === `col:${c.slug}` ? null : `col:${c.slug}`)}
                         onPick={(key) => setColPicks((p) => ({ ...p, [c.slug]: key }))}
                         onClose={() => setOpenPicker(null)} />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const rk = activeKey(r, rowPicks);
              return (
              <tr key={r.slug}>
                <RowHead s={r} lang={lang} picks={rowPicks}
                         open={openPicker === `row:${r.slug}`}
                         onToggle={() => setOpenPicker((k) => k === `row:${r.slug}` ? null : `row:${r.slug}`)}
                         onPick={(key) => setRowPicks((p) => ({ ...p, [r.slug]: key }))}
                         onClose={() => setOpenPicker(null)} />
                {cols.map((c) => {
                  const ck = activeKey(c, colPicks);
                  // Only the true self-pair is blanked. Two BUILDS of one species face each other
                  // for real, and so does a build against its own mirror — but a cell comparing a
                  // build to itself carries no information the row header doesn't already give.
                  // The mirror IS computed (a build against its own twin is a real matchup and a
                  // direct read on its bulk-vs-power balance), so it renders like any other cell —
                  // only outlined so the same-build case stays legible.
                  const o: OppKoSummaryDto | null = overview.grid[rk]?.[ck] ?? null;
                  if (!o) return <td key={c.slug} className="ko-none" />;
                  // Community 确N/乱N: 确N when even the WORST roll KOes in N
                  // (koGuaranteed === koPossible); 乱N shows the BEST-roll turn count when
                  // the worst roll needs more (e.g. 45–51% => 确3 by rolls, 乱2 shown).
                  // koExact only says the 2+ turn number is a static approximation — it is
                  // NOT the guaranteed/possible split (earlier bug).
                  // "Guaranteed" must agree with the recovery-aware verdict, not just with the
                  // static rolls: a defender holding Leftovers can turn a static 2HKO into an 87.5%
                  // chance, and the grade already reads it that way. Labelling that cell 确2 while
                  // the check grid called the kill uncertain made the two tables contradict.
                  const [minPercent, maxPercent, kp, g, chanceN, chanceGuaranteed,
                    chancePct] = o;
                  const chance = chanceN != null || chanceGuaranteed != null || chancePct != null
                    ? { text: "", ...(chanceN != null ? { n: chanceN } : {}),
                        ...(chanceGuaranteed != null ? { guaranteed: chanceGuaranteed } : {}),
                        ...(chancePct != null ? { chancePct } : {}) }
                    : null;
                  const certain = chance != null
                    ? chance.guaranteed === true
                    : g != null && (kp == null || g === kp);
                  const turns = chance?.n ?? (certain ? g : kp);
                  const tone = koTone(turns, certain, maxPercent);
                  const on = sel?.a === rk && sel?.d === ck;
                  return (
                    <td key={c.slug} className={`ko-${tone}${ck === rk ? " mirror" : ""}${on ? " on" : ""}`}
                      title={`${minPercent}–${maxPercent}% · ${damageText.ko(chance ?? {
                        text: "", n: certain ? (g ?? undefined) : (kp ?? g ?? undefined),
                        guaranteed: certain,
                      })}`}
                      role="button" tabIndex={0} aria-pressed={on}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault(); setSel({ a: rk, d: ck });
                        }
                      }}
                      onClick={() => setSel({ a: rk, d: ck })}>
                      {tone === "immune"
                        ? "0"
                        : turns != null
                          ? certain
                            ? lang === "en" ? turns : lang === "ja" ? `確${turns}` : `确${turns}`
                            : lang === "en" ? `~${turns}` : `乱${turns}`
                          : ""}
                    </td>
                  );
                })}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <KoLegend />
      {sel && cacheState.status === "loading" &&
        <div className="spinner matchup-detail-loading">{t("state.loading")}</div>}
      {sel && cacheState.status === "error" &&
        <div className="notice">{t("state.errorDetail")}</div>}
      {sel && detailOff && detailCell && detailCache && (() => {
        // Both directions: the reverse cell is this same grid read the other way.
        const back = detailCache.matrix[sel.d]?.[sel.a]?.offense ?? null;
        return (
          <CellInspector
            panelRef={detailRef}
            head={<><DetailMon s={byVariant.get(sel.a)!} lang={lang} /> → <DetailMon s={byVariant.get(sel.d)!} lang={lang} /></>}
            directions={[
              { label: t("matchup.ourKo"), damage: inspectorDamage(detailOff, t, damageText) },
              { label: t("matchup.incoming"), damage: inspectorDamage(back, t, damageText) },
            ]}
            speed={{ mine: detailCell.speed.attacker, theirs: detailCell.speed.defender,
                     faster: detailCell.speed.faster }}
            sets={<CellSets sets={detailCache.sets} aSlug={sel.a} bSlug={sel.d}
              aTitle={variantTitle(byVariant.get(sel.a), detailCache.sets?.[sel.a], lang)}
              bTitle={variantTitle(byVariant.get(sel.d), detailCache.sets?.[sel.d], lang)}
              format={format} move={detailOff.move} />}
          />
        );
      })()}
    </>
  );
}

function KoLegend() {
  const t = useT();
  const tones: Array<["ohkoG" | "ohko" | "2hko" | "3hko" | "4hko" | "slow", string]> = [
    ["ohkoG", "OHKO"], ["2hko", "2HKO"], ["3hko", "3HKO"], ["4hko", "4HKO"], ["slow", "5+"],
  ];
  return (
    <div className="legend">
      <span className="muted">{t("matchup.koLegend")}:</span>
      {tones.map(([tone, lbl]) => <span key={tone} className={`chip ko-${tone}`}>{lbl}</span>)}
      <span className="muted">{t("matchup.koUncertain")}</span>
    </div>
  );
}

// -- Check grid ---------------------------------------------------------------------------------

function CheckGrid({ format }: { format: FormatId }) {
  const state = useOppChecks(format);
  const [sel, setSel] = useState<{ m: string; o: string } | null>(null);
  // The compact grade grid is enough to render the page. The much larger KO matrix is fetched only
  // after a cell is opened for its damage/speed detail, then remains session-cached.
  const cacheState = useOppCache(format, sel !== null);
  const sets = cacheState.status === "ready" && cacheState.data
    ? cacheState.data.sets : undefined;
  const { lang } = useLang();
  const t = useT();
  const damageText = useDamageText();
  const [rowPicks, setRowPicks] = useState<Record<string, string>>({});
  const [colPicks, setColPicks] = useState<Record<string, string>>({});
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const koCache = cacheState.status === "ready" ? cacheState.data : null;

  useEffect(() => {
    if (!sel) return;
    const frame = requestAnimationFrame(() => detailRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    }));
    return () => cancelAnimationFrame(frame);
  }, [sel]);

  const view = useMemo(() => {
    if (state.status !== "ready") return null;
    const checks: OppCheckGridDto = state.data;
    const cols = [...checks.species].sort(byRank);
    // Rows are the species that actually have an attacker row for their active build.
    const rows = cols.filter((s) => checks.grid[activeKey(s, rowPicks)]);
    const byVariant = new Map<string, SpeciesRowDto>();
    for (const sp of checks.species) {
      for (const v of sp.variants ?? []) byVariant.set(v.key, sp);
      byVariant.set(sp.slug, sp);
    }
    return { checks, cols, rows, byVariant };
  }, [state, rowPicks]);

  // Each cell is exactly the two builds it names — the grid holds every ordered build pair, so a
  // column reads its own build rather than an aggregate over the species.
  const readCell = (grid: OppCheckGridDto["grid"], rowKey: string, colKey: string) =>
    grid[rowKey]?.[colKey] ?? null;

  if (state.status === "loading") return <div className="spinner">{t("state.loading")}</div>;
  if (state.status === "error") {
    return <div className="notice">{state.httpStatus === 404
      ? t("matchup.notBuilt")
      : t("state.errorDetail")}</div>;
  }
  if (!view) return null;
  const { checks, cols, rows, byVariant } = view;
  const selCell = sel ? checks.grid[sel.m]?.[sel.o] ?? null : null;
  // Damage/speed for the selected pair come from the KO matrix — this grid intentionally does not
  // duplicate them (they are derived from it).
  const koCell = sel && koCache ? koCache.matrix[sel.m]?.[sel.o] ?? null : null;

  return (
    <>
      <div className={`matrix-guide${sel ? " active" : ""}`} aria-live="polite">
        <span className="matrix-guide-mark" aria-hidden>{sel ? "✓" : "↘"}</span>
        {t(sel ? "matchup.cellSelected" : "matchup.cellHint")}
      </div>
      {cols.some((c) => (c.variants?.length ?? 0) > 1) && (
        <div className="matrix-guide variant-guide">
          <span className="matrix-guide-mark" aria-hidden>◧</span>
          {t("matchup.variantHint")}
        </div>
      )}
      <div className="matchup-scroll">
        <table className="matchup-grid">
          <thead>
            <tr>
              <th className="corner">{t("matchup.member")} \ {t("matchup.opponent")}</th>
              {cols.map((c) => (
                <ColHead key={c.slug} s={c} lang={lang}
                         picks={colPicks}
                         open={openPicker === `col:${c.slug}`}
                         onToggle={() => setOpenPicker((k) => k === `col:${c.slug}` ? null : `col:${c.slug}`)}
                         onPick={(key) => setColPicks((p) => ({ ...p, [c.slug]: key }))}
                         onClose={() => setOpenPicker(null)} />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const rk = activeKey(r, rowPicks);
              return (
                <tr key={r.slug}>
                  <RowHead s={r} lang={lang} picks={rowPicks}
                           open={openPicker === `row:${r.slug}`}
                           onToggle={() => setOpenPicker((k) => k === `row:${r.slug}` ? null : `row:${r.slug}`)}
                           onPick={(key) => setRowPicks((p) => ({ ...p, [r.slug]: key }))}
                           onClose={() => setOpenPicker(null)} />
                  {cols.map((c) => {
                    const ck = activeKey(c, colPicks);
                    const cl = readCell(checks.grid, rk, ck);
                    const g = cl?.grade;
                    if (!g) return <td key={c.slug} className="ko-none" />;
                    const wall = g === "C0" && cl!.c0Kind === "wall_no_ko";
                    const contested = !!cl!.contested;
                    const on = sel?.m === rk && sel?.o === ck;
                    return (
                      <td key={c.slug}
                        className={`grade-${g}${wall ? " wall" : ""}${contested ? " contested" : ""}${on ? " on" : ""}`}
                        title={`${g}${contested ? ` · ${t("matchup.contested")}` : ""}`}
                        role="button" tabIndex={0} aria-pressed={on}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault(); setSel({ m: rk, o: ck });
                          }
                        }}
                        onClick={() => setSel({ m: rk, o: ck })}>
                        {g}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <CheckLegend />
      {sel && selCell && (
        <CellInspector
          panelRef={detailRef}
          head={<><DetailMon s={byVariant.get(sel.m)!} lang={lang} /> {t("matchup.vs")}{" "}
                 <DetailMon s={byVariant.get(sel.o)!} lang={lang} /></>}
          grade={selCell.grade}
          gradeFacts={[
            selCell.c0Kind === "wall_no_ko"
              ? <>· {t("matchup.c0Kind.wall_no_ko")}</> : null,
            selCell.contested ? <>· {t("matchup.resolvability.contested")}</> : null,
          ].filter(Boolean) as ReactNode[]}
          // Numbers come from the KO matrix, which this page already holds — the check grid is
          // derived from it and deliberately ships no duplicate damage/speed.
          directions={[
            { label: t("matchup.ourKo"), damage: inspectorDamage(koCell?.offense, t, damageText) },
            { label: t("matchup.incoming"),
              damage: inspectorDamage(koCache?.matrix[sel.o]?.[sel.m]?.offense, t, damageText) },
          ]}
          speed={koCell?.speed
            ? { mine: koCell.speed.attacker, theirs: koCell.speed.defender,
                faster: koCell.speed.faster }
            : null}
          sets={<CellSets sets={sets} aSlug={sel.m} bSlug={sel.o}
            aTitle={variantTitle(byVariant.get(sel.m), sets?.[sel.m], lang)}
            bTitle={variantTitle(byVariant.get(sel.o), sets?.[sel.o], lang)}
            format={format} move={koCell?.offense?.move} />}
        />
      )}
    </>
  );
}

function CheckLegend() {
  const t = useT();
  return (
    <div className="legend">
      <span className="chip grade-C2">C2</span><span className="muted">{t("matchup.c2")}</span>
      <span className="chip grade-C1">C1</span><span className="muted">{t("matchup.c1")}</span>
      <span className="chip grade-C0">C0</span><span className="muted">{t("matchup.c0")}</span>
    </div>
  );
}

// -- page ---------------------------------------------------------------------------------------

export function MatchupPage() {
  const { can } = useRuntime();
  const t = useT();
  const [format, setFormat] = useState<FormatId>("single");
  const [view, setView] = useState<"ko" | "check" | "actual">(() => {
    const requested = new URLSearchParams(window.location.search).get("mode");
    return requested === "check" || requested === "actual" ? requested : "ko";
  });

  const changeView = (next: "ko" | "check" | "actual") => {
    setView(next);
    const url = new URL(window.location.href);
    url.searchParams.set("mode", next);
    window.history.replaceState(window.history.state, "", url);
  };

  if (!can("team.matchup")) return <div className="notice">{t("matchup.unavailable")}</div>;

  return (
    <div className="matchup-page">
      <PageHeader className="matchup-page-header" title={t("matchup.title")} description={t("matchup.description")}>
        <SegmentedControl kind="tabs" idBase="matchup-view" value={view} onChange={changeView}
          ariaLabel={t("a11y.matchupView")} className="seg page-tabs" items={[
            { id: "ko", label: t("matchup.ko") },
            { id: "check", label: t("matchup.check") },
            { id: "actual", label: t("actual.tab") },
          ]} />
        <FormatTabs format={format} onChange={setFormat} className="page-tabs" />
      </PageHeader>
      <div role="tabpanel" id={segmentedPanelId("matchup-view", view)}
        aria-labelledby={segmentedTabId("matchup-view", view)}>
        {view === "ko" ? <KoGrid format={format} /> : view === "check"
          ? <CheckGrid format={format} />
          : <ActualMatchupWorkspace format={format} onFormatChange={setFormat} />}
      </div>
    </div>
  );
}
