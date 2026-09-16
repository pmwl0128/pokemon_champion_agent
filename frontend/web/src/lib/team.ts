/** Team-json readers shared by the UEP panel and the calculator's team-tune mode, plus the
 * hand-off channel between them: "send this team to tune" stashes the team here and
 * navigates; the calc page picks it up (sessionStorage so a reload keeps the team). */

export interface TeamMemberish {
  species: string;
  item?: string | null;
  ability?: string | null;
  nature?: string | null;
  moves?: string[];
  spread?: Record<string, number> | null;
}

/** Lenient reader: team-json `pokemon` array → member list (unknown-safe). */
export function readTeamMembers(team: unknown): TeamMemberish[] {
  if (team === null || typeof team !== "object") return [];
  const mons = (team as { pokemon?: unknown }).pokemon;
  if (!Array.isArray(mons)) return [];
  return mons.flatMap((m) => {
    if (m === null || typeof m !== "object" || typeof (m as { species?: unknown }).species !== "string") return [];
    const mon = m as Record<string, unknown>;
    return [{
      species: mon.species as string,
      item: typeof mon.item === "string" ? mon.item : null,
      ability: typeof mon.ability === "string" ? mon.ability : null,
      nature: typeof mon.nature === "string" ? mon.nature : null,
      moves: Array.isArray(mon.moves) ? mon.moves.filter((x): x is string => typeof x === "string") : [],
      spread: mon.spread !== null && typeof mon.spread === "object" ? mon.spread as Record<string, number> : null,
    }];
  });
}

const SHOWDOWN_STATS: Array<[string, string]> = [
  ["hp", "HP"], ["atk", "Atk"], ["def", "Def"],
  ["spa", "SpA"], ["spd", "SpD"], ["spe", "Spe"],
];

/** Canonical, link-free team text suitable for clipboard and for the diagnose parser. */
export function formatTeamPlainText(team: unknown): string {
  return readTeamMembers(team).map((mon) => {
    const lines = [mon.item ? `${mon.species} @ ${mon.item}` : mon.species];
    if (mon.ability) lines.push(`Ability: ${mon.ability}`);
    if (mon.nature) lines.push(`${mon.nature} Nature`);
    const stats = SHOWDOWN_STATS.flatMap(([key, label]) => {
      const value = mon.spread?.[key];
      return typeof value === "number" && value > 0 ? [`${value} ${label}`] : [];
    });
    if (stats.length) lines.push(`SP: ${stats.join(" / ")}`);
    lines.push(...(mon.moves ?? []).slice(0, 4).map((move) => `- ${move}`));
    return lines.join("\n");
  }).join("\n\n");
}

export interface TuneFill {
  team: unknown;          // the full team-json (format rides inside it)
  label?: string;         // where it came from, for the tab header (e.g. the session intent)
  sessionId?: string;     // UEP session of origin — enables writing the tune request back
}

const FILL_KEY = "pc-tune-fill";

export function stashTuneFill(fill: TuneFill): void {
  try {
    sessionStorage.setItem(FILL_KEY, JSON.stringify(fill));
  } catch { /* storage blocked — the calc page just won't offer the team mode */ }
}

export function clearTuneFill(): void {
  try {
    sessionStorage.removeItem(FILL_KEY);
  } catch { /* nothing to clear */ }
}

/** Read (and keep) the stashed team, so a reload of the calc page retains it; the next
 * stash overwrites. */
export function takeTuneFill(): TuneFill | null {
  try {
    const raw = sessionStorage.getItem(FILL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TuneFill;
    return parsed && typeof parsed === "object" && "team" in parsed ? parsed : null;
  } catch {
    return null;
  }
}

/** Damage-calc hand-off (design §13): a battery/diagnose fact carries calculator-ready
 * coordinates — opponent as the attacker (its set auto-fills from usage), one of MY members
 * as the defender (real build), and the threatening move pre-selected. */
export interface DamageFill {
  format: "single" | "double";
  attackerSlug: string;
  /** Full attacker build (a team member handed to the calculator as the ATTACKER):
   * overrides the tab's usage auto-fill. */
  attacker?: { slug: string; ability?: string; item?: string; nature?: string;
               sps?: Record<string, number> };
  defender?: { slug: string; ability?: string; item?: string; nature?: string;
               sps?: Record<string, number> };
  /** Single threatening move (worst-matchup hand-off)… */
  move?: string;
  /** …or the member's own moveset (team-card hand-off) — pre-selected once loaded. */
  moves?: string[];
}

/** One attacker against one defender — what a matrix cell or a threat row hands over. It writes
 * into the SAME channel as a full-team hand-off (`stashCalcTeams`), so the calculator has one
 * reader and one set of rules about what arrives filled and what arrives blank.
 *
 * Deliberately NOT pinned: these callers name an opponent and expect its standard build to come
 * with it, so whatever they leave out is still filled from usage. */
export function stashDamageFill(fill: DamageFill): void {
  const moves = fill.moves?.length ? fill.moves : fill.move ? [fill.move] : [];
  stashCalcTeams({
    format: fill.format,
    attackers: [{
      slug: fill.attackerSlug,
      ...(fill.attacker ?? {}),
      ...(moves.length ? { moves } : {}),
    }],
    defenders: fill.defender ? [fill.defender] : [],
  });
}

/** A team-json document as calculator members. These are real builds, so they are pinned: a saved
 * team's empty slot is a fact about that team, not an invitation to invent the usual set. */
export function teamToCalcMembers(team: unknown): CalcMember[] {
  return readTeamMembers(team).slice(0, 6).map((mon) => ({
    species: mon.species,
    ...(mon.ability ? { ability: mon.ability } : {}),
    ...(mon.item ? { item: mon.item } : {}),
    ...(mon.nature ? { nature: mon.nature } : {}),
    ...(mon.spread ? { sps: mon.spread } : {}),
    ...(mon.moves?.length ? { moves: mon.moves } : {}),
    pinned: true,
  }));
}

/** Cross-feature team hand-off. The recent-source shelf is intentionally browser-session local:
 * it contains user sets, needs no server history, and is cleared when the browser session ends. */
export interface MatchupTeamSource {
  id: string;
  source: "builder" | "diagnose" | "session" | "other";
  label: string;
  format: "single" | "double";
  team: unknown;
  savedAt: number;
}

const MATCHUP_SOURCES_KEY = "pc-matchup-sources-v1";
const MATCHUP_FILL_KEY = "pc-matchup-fill-v1";

function matchupTeamKey(team: unknown, format?: "single" | "double"): string {
  const rows = readTeamMembers(team).map((member) => JSON.stringify({
    species: member.species.trim().toLowerCase(),
    item: member.item?.trim().toLowerCase() ?? "",
    ability: member.ability?.trim().toLowerCase() ?? "",
    nature: member.nature?.trim().toLowerCase() ?? "",
    moves: (member.moves ?? []).map((move) => move.trim().toLowerCase()).sort(),
    spread: Object.entries(member.spread ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  })).sort();
  const resolvedFormat = format ?? ((team as { format?: string })?.format === "double" ? "double" : "single");
  return JSON.stringify([resolvedFormat, rows]);
}

export function rememberMatchupSource(source: Omit<MatchupTeamSource, "id" | "savedAt">): void {
  if (readTeamMembers(source.team).length === 0) return;
  try {
    const key = matchupTeamKey(source.team, source.format);
    const rows = readMatchupSources().filter((row) =>
      matchupTeamKey(row.team, row.format) !== key && row.source !== source.source);
    const next: MatchupTeamSource = {
      ...source, id: `${source.source}-${Date.now()}`, savedAt: Date.now(),
    };
    sessionStorage.setItem(MATCHUP_SOURCES_KEY, JSON.stringify([next, ...rows].slice(0, 6)));
  } catch { /* storage blocked — direct navigation still works without the recent shelf */ }
}

export function readMatchupSources(): MatchupTeamSource[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(MATCHUP_SOURCES_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    const valid = raw.filter((row): row is MatchupTeamSource =>
      !!row && typeof row === "object" && "team" in row &&
      readTeamMembers((row as MatchupTeamSource).team).length > 0);
    const seen = new Set<string>();
    return valid.filter((row) => {
      const key = matchupTeamKey(row.team, row.format);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch {
    return [];
  }
}

export function stashMatchupFill(source: Omit<MatchupTeamSource, "id" | "savedAt">): void {
  rememberMatchupSource(source);
  try {
    sessionStorage.setItem(MATCHUP_FILL_KEY, JSON.stringify(source));
  } catch { /* recent shelf may still have succeeded */ }
}

export function takeMatchupFill(): Omit<MatchupTeamSource, "id" | "savedAt"> | null {
  try {
    const raw = sessionStorage.getItem(MATCHUP_FILL_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(MATCHUP_FILL_KEY);
    const parsed = JSON.parse(raw) as Omit<MatchupTeamSource, "id" | "savedAt">;
    return parsed && readTeamMembers(parsed.team).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** One member handed to the calculator. Only the fields the caller actually has: what it omits is
 * filled from usage, unless the member is `pinned` — that is the difference between "this opponent,
 * standard build" and "exactly what the reader picked, blanks included". */
export interface CalcMember {
  /** Dex slug, when the caller already resolved one… */
  slug?: string;
  /** …or the English canonical species; the calculator resolves it against the dex it already holds. */
  species?: string;
  ability?: string;
  item?: string;
  nature?: string;
  sps?: Record<string, number>;
  moves?: string[];
  /** The picks are complete — leave the empty fields empty instead of filling them from usage. */
  pinned?: boolean;
}

/** Both calculator rosters in one hand-off: the page's own Pokemon (plus the partners picked
 * alongside it) attack, and the KO picks defend. */
export interface CalcTeamsFill {
  format: "single" | "double";
  attackers: CalcMember[];
  defenders: CalcMember[];
}

const CALC_TEAMS_KEY = "pc-calc-teams-v1";

export function stashCalcTeams(fill: CalcTeamsFill): void {
  try {
    sessionStorage.setItem(CALC_TEAMS_KEY, JSON.stringify(fill));
  } catch { /* storage blocked — the calculator just opens on its own state */ }
}

/** Read AND CLEAR: a hand-off is one trip. Leaving it would re-apply on every later visit and
 * overwrite whatever the reader had built in the meantime. */
export function takeCalcTeams(): CalcTeamsFill | null {
  try {
    const raw = sessionStorage.getItem(CALC_TEAMS_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(CALC_TEAMS_KEY);
    const parsed = JSON.parse(raw) as CalcTeamsFill;
    if (!parsed || typeof parsed !== "object") return null;
    const members = (list: unknown): CalcMember[] => (Array.isArray(list) ? list : [])
      .filter((m): m is CalcMember =>
        !!m && typeof m === "object" && typeof (m as CalcMember).slug === "string")
      .slice(0, 6);
    return {
      format: parsed.format === "double" ? "double" : "single",
      attackers: members(parsed.attackers),
      defenders: members(parsed.defenders),
    };
  } catch {
    return null;
  }
}
