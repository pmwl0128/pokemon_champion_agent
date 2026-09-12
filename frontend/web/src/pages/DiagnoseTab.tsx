/** Team diagnose tab (team.validate, design §7.5): free-form team text (Showdown export or
 * team-json) -> parse -> validate + diagnose report, with an optional AI reading. Lives
 * inside the builder page (same "teams" domain, shares TeamCard) and
 * accepts a hand-off from the wizard result ("diagnose this team"). Report facts render
 * with dex-localized species chips; session continuity mirrors the wizard's. */
import type { DiagnoseReportDto, FormatId } from "@pokemon-champions/protocol";
import { DIAGNOSE_TEXT_MAX_CHARS, DiagnoseReportDtoSchema } from "@pokemon-champions/protocol";
import { useEffect, useMemo, useState } from "react";
import { EntityHover } from "../components/EntityHover.tsx";
import { FormatTabs } from "../components/FormatTabs.tsx";
import { TypeBadge } from "../components/TypeBadge.tsx";
import { ThinkingToggle } from "../components/ThinkingToggle.tsx";
import { useDexByName } from "../hooks.ts";
import { displayName, optionalKey, useLang, useT } from "../i18n.ts";
import { useNavigate } from "react-router-dom";
import { useDamageText } from "../lib/damageText.tsx";
import { useAbilitiesByName, useItemsByName, useOppCache } from "../hooks.ts";
import {
  readTeamMembers, rememberMatchupSource, stashDamageFill, stashMatchupFill,
} from "../lib/team.ts";
import { slugify } from "./uep/MonChip.tsx";
import { useProseRenderer } from "../lib/prose.tsx";
import { HttpError } from "../runtime/adapter.ts";
import { useRuntime } from "../runtime/context.tsx";
import { TeamCard } from "./uep/TeamCard.tsx";

type ErrorKind = "limit" | "unparseable" | "generic";

function errorKind(e: unknown): ErrorKind {
  if (!(e instanceof HttpError)) return "generic";
  if (e.status === 429) return "limit";
  if (e.status === 400 && e.message.includes("unparseable")) return "unparseable";
  return "generic";
}

const DIAG_STORE_KEY = "pc-diagnose-v4";   // v4: role expectations use public attention levels

interface DiagStash {
  format?: FormatId;
  text?: string;
  report?: DiagnoseReportDto;
}

interface ActiveDiagnoseTask {
  promise: Promise<DiagnoseReportDto>;
  submission: DiagnoseSubmission;
  report?: DiagnoseReportDto;
}

interface DiagnoseSubmission {
  format: FormatId;
  text: string;
  explain: boolean;
  thinking: boolean;
  startedAt: number;
}

// SPA-route continuity for the one request that cannot be reconstructed from a job id.
// The server keeps no diagnose job, so retain its promise while this module stays loaded.
let activeDiagnoseTask: ActiveDiagnoseTask | null = null;

function submittedTeam(text: string, format: FormatId): unknown | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (readTeamMembers(parsed).length === 0) return null;
    return { ...(parsed as Record<string, unknown>), format };
  } catch {
    return null;
  }
}

function DiagnoseElapsed({ startedAt }: { startedAt: number }) {
  const t = useT();
  const [seconds, setSeconds] = useState(() => Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
  useEffect(() => {
    const timer = window.setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <span className="muted num">{t("diag.progress.elapsed").replace("{seconds}", String(seconds))}</span>;
}

function DiagnoseProgress({ submission, reportReady }: {
  submission: DiagnoseSubmission;
  reportReady: boolean;
}) {
  const t = useT();
  const team = useMemo(
    () => submittedTeam(submission.text, submission.format),
    [submission.text, submission.format]);
  const count = team ? readTeamMembers(team).length : 0;
  const steps = [
    t("diag.progress.parse"),
    t("diag.progress.structure"),
    t("diag.progress.checks"),
    ...(submission.explain ? [t(submission.thinking
      ? "diag.progress.explainThinking" : "diag.progress.explain")] : []),
  ];
  return (
    <section id="diag-progress" className="panel builder-progress diag-progress" aria-live="polite">
      <div className="diag-progress-head">
        <h2>{t(reportReady ? "diag.progress.explaining" : "diag.progress.title")}</h2>
        <DiagnoseElapsed startedAt={submission.startedAt} />
      </div>
      <p className="diag-progress-scope">
        {t("diag.progress.scope")
          .replace("{format}", t(`format.${submission.format}`))
          .replace("{count}", count ? String(count) : "—")}
      </p>
      <ol className="builder-gates diag-progress-steps">
        {steps.map((step, index) => {
          const deterministicStep = index < 3;
          const className = reportReady
            ? (deterministicStep ? "gate-done" : "gate-running")
            : (index === 0 ? "gate-running" : "");
          return <li key={step} className={className}>
            <span className="gate-line"><span className="gate-dot" />{step}</span>
          </li>;
        })}
      </ol>
      {!reportReady && team ? (
        <div className="diag-progress-preview">
          <h3>{t("diag.progress.preview")}</h3>
          <TeamCard team={team} />
        </div>
      ) : !reportReady ? (
        <p className="muted diag-progress-note">{t("diag.progress.previewPending")}</p>
      ) : null}
    </section>
  );
}

function readStash(): DiagStash {
  try {
    return JSON.parse(sessionStorage.getItem(DIAG_STORE_KEY) ?? "{}") as DiagStash;
  } catch {
    return {};
  }
}

function writeStash(s: DiagStash): void {
  try {
    sessionStorage.setItem(DIAG_STORE_KEY, JSON.stringify(s));
  } catch { /* storage blocked */ }
}

/** Localized species chips (English canonical in, dex display name out). */
function SpeciesChips({ names }: { names: string[] }) {
  const dex = useDexByName();
  const { lang } = useLang();
  if (names.length === 0) return <span className="muted">—</span>;
  return (
    <span className="gate-detail-chips">
      {names.map((n, i) => {
        const entry = dex.get(n);
        return (
          <EntityHover key={`${n}-${i}`} kind="pokemon" name={n}>
            <span className="gate-chip" title={n}>
              {entry ? displayName(entry, lang) : n}
            </span>
          </EntityHover>
        );
      })}
    </span>
  );
}

/** `some`: at least one member was recognized by species ONLY — no moves and no spread —
 * so its conclusions ride on neutral assumptions (drives the "partial report" notice, whose
 * text is specifically about species-only members). `all`: NO member has a moveset, so the
 * offense/roles panels (which read moves — a spread alone tells them nothing) would be a wall
 * of phantom gaps; drop them. The two conditions differ: a member with a spread but no moves
 * is not "species-only", yet it still can't be analyzed for offense/roles. */
function speciesOnlyCount(team: unknown): { some: boolean; all: boolean } {
  const mons = (team as { pokemon?: unknown })?.pokemon;
  if (!Array.isArray(mons) || mons.length === 0) return { some: false, all: false };
  const isObj = (m: unknown): m is { moves?: unknown[]; spread?: unknown } =>
    m !== null && typeof m === "object";
  const noMoves = (m: unknown): boolean => isObj(m) && !(m.moves?.length);
  const speciesOnly = (m: unknown): boolean => noMoves(m) && (isObj(m) && m.spread == null);
  return { some: mons.some(speciesOnly), all: mons.every(noMoves) };
}

function fillTemplate(template: string, params: Record<string, string | number | boolean | null>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = params[key];
    return value === null ? "—" : String(value ?? `{${key}}`);
  });
}

type CheckRow = NonNullable<DiagnoseReportDto["checks"]>["byOpponent"][number];

/** Clickable per-opponent detail under the checks table: each member's own facts vs that
 * opponent (grade, our KO line, the worst incoming line, the speed read) — the matchup
 * grid's cell detail, restricted to this row. */
function CheckRowDetail({ row, team, format }: {
  row: CheckRow; team: unknown; format: "single" | "double";
}) {
  const t = useT();
  const damageText = useDamageText();
  const navigate = useNavigate();
  // Every retained observed variant is an independent opponent. Its exact set is keyed by
  // variantId in the shipped cache; never silently substitute the species representative.
  const cacheState = useOppCache(format);
  const setFor = (variantId: string) => cacheState.status === "ready"
    ? cacheState.data.sets?.[variantId] : undefined;
  const members = readTeamMembers(team);
  const toCalc = (cell: NonNullable<CheckRow["cells"]>[number]) => {
    const member = members.find((m) => m.species === cell.member);
    const oppSet = setFor(cell.variantId);
    const runForm = oppSet?.runForm || oppSet?.species || row.opponent;
    stashDamageFill({
      format, attackerSlug: slugify(runForm),
      attacker: {
        slug: slugify(runForm),
        ...(oppSet?.ability ? { ability: oppSet.ability } : {}),
        ...(oppSet?.item ? { item: oppSet.item } : {}),
        ...(oppSet?.nature ? { nature: oppSet.nature } : {}),
        ...(oppSet?.sps ? { sps: oppSet.sps as Record<string, number> } : {}),
      },
      defender: {
        slug: slugify(cell.member),
        ...(member?.ability ? { ability: member.ability } : {}),
        ...(member?.item ? { item: member.item } : {}),
        ...(member?.nature ? { nature: member.nature } : {}),
        ...(member?.spread ? { sps: member.spread } : {}),
      },
      ...(cell.incoming?.move ? { move: cell.incoming.move } : {}),
    });
    navigate("/calc?tab=damage");
  };
  if (!row.cells?.length) return null;
  return (
    <div className="matchup-detail diag-check-detail">
      {row.cells.map((cell) => {
        const oppSet = setFor(cell.variantId);
        return (
          <div key={`${cell.variantId}:${cell.member}`} className="diag-cell">
          <div className="md-head">
            <SpeciesChips names={[cell.member]} />
            {cell.check?.grade && (
              <span className={`grade-pill grade-${cell.check.grade}`}>
                {cell.check.grade}
              </span>
            )}
            {cell.check?.c0Kind && (
              <span className="muted"> {t(cell.check.c0Kind === "wall_no_ko"
                ? "matchup.c0Kind.wall_no_ko" : "matchup.c0Kind.loss")}</span>
            )}
            {cell.check?.resolvability === "contested" && (
              <span className="muted"> · {t("matchup.contested")}</span>
            )}
          </div>
          {oppSet && (
            <div className="md-line md-caveat">
              {damageText.name([oppSet.item, oppSet.ability, oppSet.nature]
                .filter(Boolean).join(" · "))}
              {cell.coverage != null && (
                <span className="muted num"> · {(cell.coverage * 100).toFixed(1)}%</span>
              )}
            </div>
          )}
          {cell.offense && (
            <div className="md-line md-caveat">
              {t("matchup.ourKo")}: {damageText.name(cell.offense.move)}{" "}
              <span className="num">{cell.offense.minPercent}–{cell.offense.maxPercent}%</span>
              {" · "}{damageText.ko(offenseKoChanceDiag(cell.offense))}
            </div>
          )}
          {cell.incoming && (
            <div className="md-line md-caveat">
              {t("matchup.incoming")}: {damageText.name(cell.incoming.move)}{" "}
              <span className="num">{cell.incoming.minPercent}–{cell.incoming.maxPercent}%</span>
              {" · "}{damageText.ko(offenseKoChanceDiag(cell.incoming))}
            </div>
          )}
          <div className="md-line md-caveat num">
            {t("matchup.speed")}: {cell.speed.member ?? "—"} {t("matchup.vs")}{" "}
            {cell.speed.opponent ?? "—"}
            {cell.speed.faster ? (() => {
              const k = optionalKey(`matchup.faster.${cell.speed.faster}`);
              return k ? ` · ${t(k)}` : "";
            })() : ""}
            <button type="button" className="second-btn md-verify" onClick={() => toCalc(cell)}>
              {t("builder.verifyCalc")}
            </button>
          </div>
          </div>
        );
      })}
    </div>
  );
}

/** OppOffenseDto -> the ko-chance shape damageText.ko renders (mirrors MatchupPage). */
function offenseKoChanceDiag(off: NonNullable<CheckRow["cells"]>[number]["offense"]) {
  if (!off) return null;
  return off.koChance ?? {
    text: off.ko,
    n: off.koGuaranteed ?? off.koPossible ?? undefined,
    guaranteed: off.koGuaranteed != null,
  };
}

/** Mega facts (all dex/projection data, client-side): who holds a matching stone, the
 * Mega form's stat/type/ability deltas, and the registered count vs the meta modal. */
function MegaFacts({ team }: { team: unknown }) {
  const t = useT();
  const { lang } = useLang();
  const dex = useDexByName();
  const items = useItemsByName();
  const members = readTeamMembers(team);
  // A registered Mega arrives in EITHER shape and both count toward the slot budget:
  //   base species + its stone  ('Delphox' + Delphoxite)
  //   the Mega form named directly ('Mega Blastoise' + Blastoisinite)
  // Matching only `mega.baseSpecies === base.name` silently dropped the second: for a member already
  // named 'Mega Blastoise' that comparison is Blastoise === Mega Blastoise, never true — so a team
  // registering two stones reported only one.
  const holders = members.flatMap((m) => {
    const entry = dex.get(m.species);
    if (!entry) return [];
    if (entry.isMega) {
      const base = entry.baseSpecies ? dex.get(entry.baseSpecies) : undefined;
      return [{ member: m.species, base: base ?? entry, mega: entry }];
    }
    if (!m.item) return [];
    const target = items.get(m.item)?.requiredBy?.[0];
    const mega = target ? dex.get(target) : undefined;
    if (!mega || !mega.isMega || mega.baseSpecies !== entry.name) return [];
    return [{ member: m.species, base: entry, mega }];
  });
  if (holders.length === 0) return null;
  const KEYS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;
  const SHORT: Record<string, string> = { hp: "HP", atk: "A", def: "B", spa: "C", spd: "D", spe: "S" };
  return (
    <div className="panel builder-result diag-section">
      <h2>{t("diag.mega")}</h2>
      <p className="muted diag-note">{t("diag.mega.count").replace("{n}", String(holders.length))}</p>
      {holders.map(({ member, base, mega }) => (
        <div key={member} className="gate-detail-row diag-mega-row">
          <SpeciesChips names={[member]} />
          <span className="muted">→</span>
          <SpeciesChips names={[mega.name]} />
          <span className="num diag-mega-stats">
            {KEYS.map((k) => {
              const d = mega.stats[k] - base.stats[k];
              return d ? (
                <span key={k} className={d > 0 ? "prio-plus" : "prio-minus"}>
                  {SHORT[k]}{d > 0 ? `+${d}` : d}{" "}
                </span>
              ) : null;
            })}
          </span>
          {mega.abilities[0] && base.abilities.every((a) => a.name !== mega.abilities[0]!.name) && (
            <span className="muted">
              {t("diag.mega.ability")}: {displayName(mega.abilities[0], lang)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Archetype-counter surface: for each mainstream meta archetype, the members that can
 * answer it and HOW (priority / rewrites weather / anti-setup / breaks walls ...). Move- and
 * item-based mechanisms are computed client-side (complete — moves don't change on Mega);
 * own weather setters come from the skill coverage (Mega-aware). Format-gated like roles:
 * singles hides Trick Room / Tailwind / Intimidate; doubles hides Wall-break. */
function ModePressure({ report }: { report: DiagnoseReportDto }) {
  const t = useT();
  const { lang } = useLang();
  const abilities = useAbilitiesByName();
  const members = readTeamMembers(report.team);
  const dbl = (report.team as { format?: string })?.format === "double";
  const abName = (name: string): string => {
    const e = abilities.get(name);
    return e ? displayName(e, lang) : name;
  };
  type Member = (typeof members)[number];
  type Asset = { species: string; how: string };
  const hasMv = (m: Member, s: Set<string> | string): boolean =>
    (m.moves ?? []).some((mv) => {
      const k = mv.toLowerCase();
      return typeof s === "string" ? k === s : s.has(k);
    });
  const byMove = (s: Set<string> | string, how: string): Asset[] =>
    members.filter((m) => hasMv(m, s)).map((m) => ({ species: m.species, how }));
  const merge = (...lists: Asset[][]): Asset[] => {
    const map = new Map<string, Set<string>>();
    for (const list of lists) {
      for (const a of list) {
        if (!map.has(a.species)) map.set(a.species, new Set());
        map.get(a.species)!.add(a.how);
      }
    }
    return [...map].map(([species, hows]) => ({ species, how: [...hows].join(" / ") }));
  };
  const PRIORITY = new Set(["accelerock", "aqua jet", "bullet punch", "extreme speed",
    "first impression", "ice shard", "jet punch", "mach punch", "quick attack",
    "shadow sneak", "sucker punch", "vacuum wave", "water shuriken"]);
  const ANTI_SETUP = new Set(["whirlwind", "roar", "dragon tail", "circle throw", "haze",
    "clear smog", "topsy-turvy"]);
  const ANTI_SETUP_ABIL = new Set(["Unaware", "Imposter"]);
  const DISRUPT = new Set(["taunt", "encore", "disable", "quash", "imprison", "torment"]);
  const SCREEN_BREAK = new Set(["brick break", "psychic fangs", "raging bull"]);
  const OFF_SETUP = new Set(["swords dance", "dragon dance", "nasty plot", "calm mind",
    "bulk up", "quiver dance", "shell smash", "work up", "coil", "hone claws", "tail glow",
    "growth", "shift gear", "victory dance", "clangorous soul", "no retreat", "belly drum",
    "geomancy"]);
  const TRICK = new Set(["trick", "switcheroo"]);
  const CHOICE = new Set(["Choice Band", "Choice Specs", "Choice Scarf"]);
  const PUNISH = new Set(["Defiant", "Competitive", "Clear Body", "White Smoke",
    "Hyper Cutter", "Mirror Armor", "Guard Dog", "Inner Focus", "Own Tempo", "Oblivious",
    "Scrappy"]);
  const antiSetup = (): Asset[] => merge(
    byMove(ANTI_SETUP, t("diag.how.antiSetup")),
    members.filter((m) => m.ability && ANTI_SETUP_ABIL.has(m.ability))
      .map((m) => ({ species: m.species, how: t("diag.how.antiSetup") })));
  const choiceTrick = (): Asset[] =>
    members.filter((m) => m.item && CHOICE.has(m.item) && hasMv(m, TRICK))
      .map((m) => ({ species: m.species, how: t("diag.how.choiceTrick") }));
  // own weather setters: Mega-aware (Mega Froslass = Snow Warning), so read the skill coverage
  const weatherBearers = report.roles.coverage.find((c) => c.key === "weather_rewrite")?.bearers ?? [];
  const slowFirst = [...report.speed.order].reverse();
  const allRows: Record<string, { assets: Asset[]; extra?: string }> = {
    trickroom: {
      assets: merge(byMove(PRIORITY, t("diag.how.priority")), byMove(DISRUPT, t("diag.how.disrupt")),
        byMove("trick room", t("diag.how.ownTR"))),
      extra: slowFirst[0]
        ? `${t("diag.mode.slowest")}${slowFirst.slice(0, 2).map((o) => o.species).join(", ")}`
        : undefined,
    },
    tailwind: {
      assets: merge(byMove(PRIORITY, t("diag.how.priority")), byMove("tailwind", t("diag.how.ownTailwind")),
        byMove("trick room", t("diag.how.ownTR")), byMove("taunt", t("diag.how.taunt"))),
    },
    weather: {
      assets: weatherBearers.map((b) => ({
        species: b.species,
        how: b.via?.startsWith("ability:") ? abName(b.via.slice(b.via.indexOf(":") + 1))
                                           : t("diag.how.weather"),
      })),
    },
    intimidate: {
      assets: members.filter((m) => m.ability && PUNISH.has(m.ability))
        .map((m) => ({ species: m.species, how: abName(m.ability!) })),
    },
    screens: {
      assets: merge(byMove(SCREEN_BREAK, t("diag.how.breakScreen")), byMove(DISRUPT, t("diag.how.disrupt"))),
    },
    setup: {
      assets: merge(antiSetup(), byMove("encore", t("diag.how.encore")), byMove("taunt", t("diag.how.taunt"))),
    },
    break: {
      assets: merge(byMove(OFF_SETUP, t("diag.how.offSetup")), byMove("toxic", t("diag.how.toxic")),
        byMove("encore", t("diag.how.encore")), byMove("taunt", t("diag.how.taunt")), choiceTrick(),
        byMove("psychic noise", t("diag.how.psychicNoise"))),
    },
  };
  const order = dbl
    ? ["trickroom", "tailwind", "weather", "intimidate", "screens", "setup"]
    : ["weather", "screens", "setup", "break"];
  return (
    <div className="panel builder-result diag-section">
      <h2>{t("diag.modes")}</h2>
      <p className="muted diag-note">{t("diag.modes.hint")}</p>
      <table className="data-table diag-table">
        <tbody>
          {order.map((key) => {
            const r = allRows[key]!;   // order only lists keys present in allRows
            const descKey = optionalKey(`diag.modeDesc.${key}`);
            return (
              <tr key={key}>
                <td><span className={descKey ? "diag-label-info" : undefined}
                          title={descKey ? t(descKey) : undefined}>
                  {t(`diag.mode.${key}` as Parameters<typeof t>[0])}</span></td>
                <td>
                  {r.assets.length
                    ? <span className="diag-mode-assets">
                        {r.assets.map((a) => (
                          <span key={a.species} className="diag-mode-asset">
                            <SpeciesChips names={[a.species]} />
                            <span className="diag-mode-how">{a.how}</span>
                          </span>
                        ))}
                      </span>
                    : <span className="muted">{t("diag.mode.none")}</span>}
                  {r.extra && <div className="muted diag-fragile">{r.extra}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Report({ report }: { report: DiagnoseReportDto }) {
  const t = useT();
  const prose = useProseRenderer();
  const damageText = useDamageText();
  const [selOpp, setSelOpp] = useState<string | null>(null);
  const [showAllChecks, setShowAllChecks] = useState(false);
  const valid = report.legality.status === "valid";
  const unknown = report.legality.status === "unknown";
  const weakRows = report.defense.byAttackType.filter((e) => e.weak.length > 0);
  const calmTypes = report.defense.byAttackType.length - weakRows.length;
  const issues = report.legality.issues ?? [];
  const errorIssues = issues.filter((i) => i.severity === "error");
  const noticeIssues = issues.filter((i) => i.severity !== "error");
  const bare = speciesOnlyCount(report.team);
  const allCheckRows = report.checks?.byOpponent ?? [];
  const visibleCheckRows = showAllChecks ? allCheckRows : allCheckRows.slice(0, 10);
  const checkGradeCounts = allCheckRows.reduce<Record<"C2" | "C1" | "C0", number>>(
    (counts, row) => {
      const grade = row.observedFloor;
      if (grade === "C2" || grade === "C1" || grade === "C0") counts[grade] += 1;
      return counts;
    }, { C2: 0, C1: 0, C0: 0 });
  useEffect(() => {
    setSelOpp(null);
    setShowAllChecks(false);
  }, [report]);
  useEffect(() => {
    const format = (report.team as { format?: string })?.format === "double" ? "double" : "single";
    rememberMatchupSource({ source: "diagnose", label: t("actual.source.diagnose"), format,
      team: report.team });
  }, [report, t]);
  const issueText = (issue: (typeof issues)[number]) => {
    const key = optionalKey(`validation.${issue.code}`);
    return key ? fillTemplate(t(key), issue.params) : t("diag.warningGeneric");
  };
  const signalText = (signal: string) => {
    // item/ability signals carry a functional MEANING (the skill's signal maps) — show it,
    // or the row reads like a random equipment listing (user-reported confusion).
    if (signal.startsWith("item:") || signal.startsWith("ability:")) {
      const isItem = signal.startsWith("item:");
      const value = signal.slice(isItem ? 5 : 8);
      const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const meaning = optionalKey(`diag.sig.${slug}`);
      const label = prose(value);
      return meaning
        ? <>{label}<span className="diag-sig-meaning">（{t(meaning)}）</span></>
        : prose(t(isItem ? "diag.signal.item" : "diag.signal.ability").replace("{value}", value));
    }
    const key = optionalKey(`diag.cov.${signal}`);
    return key ? t(key) : signal;
  };
  const bearerHow = (raw: string | null | undefined) => {
    if (!raw) return null;
    return raw.split(", ").map((part, i) => {
      let label;
      if (part === "move") {
        label = t("diag.via.move");
      } else if (part.startsWith("move:")) {
        label = prose(t("diag.signal.move").replace("{value}", part.slice(5)));
      } else if (part.startsWith("item:")) {
        label = prose(t("diag.signal.item").replace("{value}", part.slice(5)));
      } else if (part.startsWith("ability:")) {
        label = prose(t("diag.signal.ability").replace("{value}", part.slice(8)));
      } else {
        label = prose(part);
      }
      return <span key={`${part}-${i}`}>{i > 0 ? " · " : ""}{label}</span>;
    });
  };
  return (
    <>
      <div className="panel result-panel builder-result">
        {bare.some && (
          <p className="notice diag-partial">{t("diag.partial")}</p>
        )}
        {errorIssues.length > 0 ? (
          <ul className="diag-errors">
            {errorIssues.map((issue, i) => <li key={i}>{prose(issueText(issue))}</li>)}
          </ul>
        ) : report.legality.errors.length > 0 && (
          <p className="notice diag-errors">{t("diag.legality.invalid")}</p>
        )}
        {(noticeIssues.length > 0 || (issues.length === 0 && report.legality.warnings.length > 0)) && (
          <ul className="diag-warnings">
            {noticeIssues.length > 0
              ? noticeIssues.map((issue, i) => <li key={i}>{prose(issueText(issue))}</li>)
              : <li>{t("diag.warningGeneric")}</li>}
          </ul>
        )}
        <TeamCard team={report.team} badges={
          <div className="builder-badges">
            <span className={valid ? "badge-ok" : unknown ? "badge-note" : "badge-err"}>
              {valid ? "✓ " : unknown ? "? " : "✗ "}
              {t(`diag.legality.${valid ? "valid" : unknown ? "unknown" : "invalid"}`)}
            </span>
          </div>
        } />
        <MegaFacts team={report.team} />
      </div>

      {/* Opt-in LLM reading — a decorated aside; the deterministic report stands alone. */}
      {report.explanation && (
        <div className="panel builder-result diag-section diag-explain">
          <h2>{t("diag.explanation")}</h2>
          {report.explanation.split(/\n+/).map((para, i) => (
            <p key={i} className="qa-answer-text">{prose(para)}</p>
          ))}
        </div>
      )}
      {report.explanationError && (
        <p className="notice qa-error">
          {t(report.explanationError === "rate_limited"
            ? "diag.explainError.limit" : "diag.explainError.generic")}
        </p>
      )}

      {report.checks && (
        <div className="panel builder-result diag-section">
          <h2>{t("diag.checks").replace("{k}", String(report.checks.topK))}</h2>
          <div className="diag-check-overview" aria-label={t("diag.checks.summary")}>
            {(["C2", "C1", "C0"] as const).map((grade) => (
              <span key={grade} className={`diag-check-count diag-grade-${grade}`}>
                {grade} <span className="num">{checkGradeCounts[grade]}</span>
              </span>
            ))}
            <span className="muted diag-check-shown">
              {t("diag.checks.shown")
                .replace("{shown}", String(visibleCheckRows.length))
                .replace("{total}", String(allCheckRows.length))}
            </span>
            {allCheckRows.length > 10 && (
              <button type="button" className="secondary-btn diag-check-toggle"
                onClick={() => {
                  if (showAllChecks && selOpp
                      && !allCheckRows.slice(0, 10).some((row) => row.opponent === selOpp)) {
                    setSelOpp(null);
                  }
                  setShowAllChecks((value) => !value);
                }}>
                {t(showAllChecks ? "diag.checks.showTop" : "diag.checks.showAll")
                  .replace("{total}", String(allCheckRows.length))}
              </button>
            )}
          </div>
          <table className="data-table diag-table diag-checks-table">
            <colgroup>
              <col className="diag-check-opponent" />
              <col className="diag-check-grade-col" />
              <col className="diag-check-members" />
            </colgroup>
            <thead>
              <tr>
                <th>{t("diag.checks.opponent")}</th>
                <th>{t("diag.checks.grade")}</th>
                <th>{t("diag.checks.by")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleCheckRows.map((row) => {
                const grade = row.observedFloor || "?";
                const clickable = (row.cells?.length ?? 0) > 0;
                const on = selOpp === row.opponent;
                return (
                  <tr key={row.opponent}
                      className={`${clickable ? "diag-row-click" : ""}${on ? " on" : ""}`}
                      onClick={clickable
                        ? () => setSelOpp(on ? null : row.opponent) : undefined}>
                    <td><SpeciesChips names={[row.opponent]} /></td>
                    <td>
                      <span className={`diag-grade diag-grade-${grade}`}>{grade}</span>
                      {!row.calculationComplete && (
                        <span className="muted"> · {t("diag.checks.incomplete")}</span>
                      )}
                    </td>
                    <td>
                      <SpeciesChips names={row.floorBy} />
                      {row.representedCoverage != null && (
                        <span className="muted num"> · {(row.representedCoverage * 100).toFixed(1)}%</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {selOpp && (() => {
            const row = report.checks!.byOpponent.find((r) => r.opponent === selOpp);
            const fmt = (report.team as { format?: string })?.format === "double"
              ? "double" as const : "single" as const;
            return row ? <CheckRowDetail row={row} team={report.team} format={fmt} /> : null;
          })()}
        </div>
      )}

      <div className="panel builder-result diag-section">
        <h2>{t("diag.defense")}</h2>
        <table className="data-table diag-table">
          <tbody>
            {weakRows.map((row) => (
              <tr key={row.type}>
                <td><TypeBadge type={row.type} /></td>
                <td><SpeciesChips names={row.weak} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {calmTypes > 0 && (
          <p className="muted diag-note">
            {t("diag.noWeak").replace("{n}", String(calmTypes))}
          </p>
        )}
      </div>

      {/* Offense and roles read moves; on a species-only parse they would render as a
          wall of dashes — drop them and let the partial notice carry the message. */}
      {!bare.all && <div className="panel builder-result diag-section">
        <h2>{t("diag.offense")}</h2>
        {report.offense.incompleteMembers.length > 0 && (
          <p className="notice diag-unconfirmed diag-incomplete">
            {t("diag.gapsUnconfirmed")}{" "}
            <SpeciesChips names={report.offense.incompleteMembers.map((m) => m.species)} />
          </p>
        )}
        <div className="gate-detail-row">
          <span className="gate-detail-label">{t("diag.hardGaps")}</span>
          {report.offense.hardGaps.length > 0
            ? <span className="gate-detail-chips">
                {report.offense.hardGaps.map((tp) => <TypeBadge key={tp} type={tp} />)}
              </span>
            : <span className="muted">—</span>}
        </div>
        <div className="gate-detail-row">
          <span className="gate-detail-label">{t("diag.stab")}</span>
          <span className="gate-detail-chips">
            {report.offense.stabTypes.map((tp) => <TypeBadge key={tp} type={tp} />)}
          </span>
        </div>
        {report.offense.otherTypes.length > 0 && (
          <div className="gate-detail-row">
            <span className="gate-detail-label">{t("diag.other")}</span>
            <span className="gate-detail-chips">
              {report.offense.otherTypes.map((tp) => <TypeBadge key={tp} type={tp} />)}
            </span>
          </div>
        )}
      </div>}

      <div className="panel builder-result diag-section">
        <h2>{t("diag.speed")}</h2>
        <ol className="diag-speed">
          {report.speed.order.map((o) => (
            <li key={o.species}>
              <SpeciesChips names={[o.species]} />
              <span className="num">{o.speed ?? "?"}</span>
            </li>
          ))}
        </ol>
        {report.speed.members.some((m) => m.assumedNeutral) && (
          <p className="muted diag-note">{t("diag.assumedNeutral")}</p>
        )}
      </div>

      {/* Archetype-counter surface sits directly before role coverage — the two role/
          coverage views read together. */}
      <ModePressure report={report} />

      {!bare.all && <div className="panel builder-result diag-section">
        <h2>{t("diag.roles")}</h2>
        {report.roles.incompleteMembers.length > 0 && (
          <p className="notice diag-unconfirmed diag-incomplete">
            {t("diag.rolesUncounted")}{" "}
            <SpeciesChips names={report.roles.incompleteMembers.map((m) => m.species)} />
          </p>
        )}
        {report.roles.attentionCalibration?.status === "carried_over" && (
          <p className="notice diag-unconfirmed">
            {t("diag.rolesCarriedOver")}{" "}
            {report.roles.attentionCalibration.measuredOn} &rarr;{" "}
            {report.roles.attentionCalibration.rule},{" "}
            {report.roles.attentionCalibration.expiresAt}
          </p>
        )}
        <table className="data-table diag-table diag-coverage-table">
          <tbody>
            {report.roles.coverage.map((c) => {
              const key = optionalKey(`diag.cov.${c.key}`);
              const descKey = optionalKey(`diag.covDesc.${c.key}`);
              // Public attention levels deliberately avoid the skill's legacy
              // required|optional wording. Both kinds of absence stay visible; color shows how
              // strongly the user should weigh the missing signal.
              const tier = c.expectation === "situational" ? "situational" : "priority";
              return (
                <tr key={c.key} className={c.present ? "" : `diag-missing-${tier}`}>
                  <td>{c.present ? "✓" : "✗"}</td>
                  <td>
                    <span className={`diag-tier diag-tier-${tier}`}>{t(`diag.tier.${tier}`)}</span>{" "}
                    <span className={descKey ? "diag-label-info" : undefined}
                          title={descKey ? t(descKey) : undefined}>{key ? t(key) : c.label}</span>
                  </td>
                  <td>
                    {c.bearers.length > 0
                      ? <span className="diag-mode-assets">
                          {c.bearers.map((b) => (
                            <span key={`${c.key}-${b.species}`} className="diag-mode-asset">
                              <SpeciesChips names={[b.species]} />
                              {b.via && <span className="diag-mode-how">{bearerHow(b.via)}</span>}
                            </span>
                          ))}
                        </span>
                      : <span className="muted">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="diag-signals">
          <p className="muted diag-note">{t("diag.compressionHint")}</p>
          {report.roles.members.map((m) => (
            <div key={m.species} className="gate-detail-row">
              <SpeciesChips names={[m.species]} />
              <span className="muted">{m.signals.length
                ? m.signals.map((signal, i) => <span key={`${signal}-${i}`}>{i > 0 ? " · " : ""}{signalText(signal)}</span>)
                : "—"}</span>
            </div>
          ))}
        </div>
      </div>}
    </>
  );
}

export function DiagnoseTab({ active, fill, onConsumeFill }: {
  active: boolean;
  /** A team-json handed over from the wizard result ("diagnose this team"). */
  fill: unknown | null;
  onConsumeFill: () => void;
}) {
  const { adapter } = useRuntime();
  const t = useT();
  const { lang } = useLang();
  const navigate = useNavigate();
  const stash = useMemo(readStash, []);
  const [format, setFormat] = useState<FormatId>(stash.format ?? "single");
  const [text, setText] = useState(stash.text ?? "");
  const [explain, setExplain] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [handoffReady, setHandoffReady] = useState(false);
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(null);
  const [report, setReport] = useState<DiagnoseReportDto | null>(() => {
    // Re-validate the persisted report through the schema (not the raw JSON.parse readStash
    // did): a report cached by an OLDER build lacks fields this build now reads unconditionally
    // (e.g. offense.incompleteMembers.length), and the stash bypasses the schema defaults the
    // network path applies — rendering a stale cache raw white-screened the tab. safeParse fills
    // defaults for a compatible cache and discards an incompatible one.
    const parsed = DiagnoseReportDtoSchema.safeParse(stash.report);
    return parsed.success ? parsed.data : null;
  });
  const [running, setRunning] = useState(() => activeDiagnoseTask !== null);
  const [submission, setSubmission] = useState<DiagnoseSubmission | null>(
    () => activeDiagnoseTask?.submission ?? null);
  const [error, setError] = useState<ErrorKind | null>(null);

  useEffect(() => {
    if (!running || !submission) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById("diag-progress")?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [running, submission?.startedAt]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    adapter.quota?.().then((all) => { if (live) setQuota(all.diagnose); }, () => {});
    return () => { live = false; };
  }, [adapter, active]);

  const thinkingUnavailable = quota === null
    || (quota.limit > 0 && quota.limit - quota.used < 2);
  useEffect(() => {
    if (thinkingUnavailable) setThinking(false);
  }, [thinkingUnavailable]);

  useEffect(() => {
    writeStash({ format, text, ...(report ? { report } : {}) });
  }, [format, text, report]);

  useEffect(() => {
    const task = activeDiagnoseTask;
    if (!task) return;
    let live = true;
    setRunning(true);
    setSubmission(task.submission);
    if (task.report) {
      setReport(task.report);
      setQuota(task.report.quota);
    }
    setError(null);
    task.promise.then((next) => {
      writeStash({ format: task.submission.format, text: task.submission.text, report: next });
      if (!live) return;
      setFormat(task.submission.format);
      setText(task.submission.text);
      setReport(next);
      setQuota(next.quota);
    }, (reason: unknown) => {
      if (live) setError(errorKind(reason));
    }).finally(() => {
      if (activeDiagnoseTask === task) activeDiagnoseTask = null;
      if (live) {
        setRunning(false);
        setSubmission(null);
      }
    });
    return () => { live = false; };
  }, []);

  const run = async (payload?: { format: FormatId; text: string }) => {
    const req = payload ?? { format, text: text.trim() };
    if (!req.text || running || activeDiagnoseTask || !adapter.diagnose) return;
    const nextSubmission: DiagnoseSubmission = {
      format: req.format,
      text: req.text,
      explain,
      thinking: explain && thinking,
      startedAt: Date.now(),
    };
    setRunning(true);
    setSubmission(nextSubmission);
    setHandoffReady(false);
    setReport(null);
    setError(null);
    let task: ActiveDiagnoseTask;
    const promise = adapter.diagnose({
      format: req.format,
      text: req.text.slice(0, DIAGNOSE_TEXT_MAX_CHARS),
      ...(nextSubmission.explain
        ? { explain: true, thinking: nextSubmission.thinking, lang } : {}),
    }, (partial) => {
      task.report = partial;
      writeStash({ format: req.format, text: req.text, report: partial });
      setReport(partial);
      setQuota(partial.quota);
    });
    task = { promise, submission: nextSubmission };
    activeDiagnoseTask = task;
    try {
      const next = await promise;
      writeStash({ format: req.format, text: req.text, report: next });
      setReport(next);
      setQuota(next.quota);
    } catch (e) {
      setError(errorKind(e));
    } finally {
      if (activeDiagnoseTask === task) activeDiagnoseTask = null;
      setRunning(false);
      setSubmission(null);
    }
  };

  // Wizard hand-off only fills the editable form. The visitor may change sets, format,
  // AI-reading mode, or thinking mode before consciously spending a diagnosis allowance.
  useEffect(() => {
    if (fill === null) return;
    const teamText = JSON.stringify(fill, null, 1);
    const fmt = (fill as { format?: string }).format === "double" ? "double" : "single";
    setFormat(fmt);
    setText(teamText);
    setReport(null);
    setError(null);
    setHandoffReady(true);
    onConsumeFill();
    requestAnimationFrame(() => document.getElementById("diag-text")?.focus());
  }, [fill]);

  return (
    <div>
      <p className="notice page-disclosure">{t("diag.disclosure")}</p>
      <div className="panel form-panel builder-form">
        <div className="builder-field">
          <label>{t("format.single")} / {t("format.double")}</label>
          <FormatTabs format={format} onChange={setFormat} />
        </div>
        <div className="builder-field">
          <label htmlFor="diag-text">{t("diag.text")}</label>
          <textarea id="diag-text" rows={8} value={text}
                    maxLength={DIAGNOSE_TEXT_MAX_CHARS}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={t("diag.placeholder")} />
          {handoffReady && <p className="notice diag-prefilled">{t("diag.prefilled")}</p>}
        </div>
        <div className="diag-mode-options">
          <label className="diag-explain-opt">
            <input type="checkbox" checked={explain}
                   onChange={(e) => {
                     setExplain(e.target.checked);
                     if (!e.target.checked) setThinking(false);
                   }} />
            {t("diag.explain")}
          </label>
          <ThinkingToggle checked={thinking} onChange={(checked) => {
            setThinking(checked);
            if (checked) setExplain(true);
          }}
            disabled={running || thinkingUnavailable} label={t("thinking.label")}
            tip={`${t("diag.thinkingTip")}${quota !== null && quota.limit > 0
              && quota.limit - quota.used < 2 ? ` ${t("thinking.insufficient")}` : ""}`} />
        </div>
        {/* One action row, mirroring the wizard: quota, then secondary actions, then the primary
          * button. The form stays mounted while a report is on screen, so the quota is rendered
          * ONLY here — the result panel used to repeat it, showing "2/4" twice at once. */}
        <div className="builder-actions">
          {quota && <span className="muted num qa-quota">
            {t("diag.quota")} {quota.limit === 0
              ? t("quota.unlimited") : `${quota.used}/${quota.limit}`}
          </span>}
          {report && (
            <button type="button" className="second-btn" onClick={() => {
              const teamFormat = (report.team as { format?: string })?.format === "double"
                ? "double" : "single";
              stashMatchupFill({ source: "diagnose", label: t("actual.source.diagnose"),
                format: teamFormat, team: report.team });
              navigate("/matchup?mode=actual");
            }}>{t("actual.sendMatchup")}</button>
          )}
          <button type="button" className="primary-btn"
                  disabled={running || !!(quota && quota.limit > 0 && quota.used >= quota.limit)}
                  onClick={() => void run()}>
            {running ? t("diag.running") : t("diag.run")}
          </button>
        </div>
      </div>

      {running && submission && (
        <DiagnoseProgress submission={submission} reportReady={report !== null} />
      )}
      {error && <p className="notice qa-error">{t(`diag.error.${error}`)}</p>}
      {report && <Report report={report} />}
    </div>
  );
}
