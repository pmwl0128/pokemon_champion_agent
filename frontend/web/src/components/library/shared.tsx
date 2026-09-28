/** Small pieces the teams page's parts share: how a record is named, when it was saved under a
 * different rule, and how dates and sizes read. */
import type { TeamDoc } from "@pokemon-champions/protocol";
import { useEffect, type ReactNode } from "react";
import { GameImage } from "../GameImage.tsx";
import { useToast } from "../Toast.tsx";
import { displayName, type Lang } from "../../i18n.ts";
import { saveJson } from "../../lib/download.ts";
import { exportAll, exportFileName } from "../../lib/library/exchange.ts";
import type { LibraryLayout, LibrarySnapshot, TeamRecord } from "../../lib/library/records.ts";
import type { LibraryState } from "../../lib/library/repo.ts";
import { useLibraryWorkspace, type ActiveTeam } from "../../lib/library/workspace.tsx";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import { useRuntime } from "../../runtime/context.tsx";
import { slugify } from "../team/MonChip.tsx";
import { fill, useLibraryT } from "./messages.ts";

type DexMap = Map<string, DexIndexEntry>;

export function speciesLabel(species: string, dex: DexMap, lang: Lang): string {
  const entry = dex.get(species);
  return entry ? displayName(entry, lang) : species;
}

export function speciesSlug(species: string, dex: DexMap): string {
  return dex.get(species)?.slug ?? slugify(species);
}

/** An unnamed team is called by its first members, in the reader's language. */
export function useTeamLabel(dex: DexMap, lang: Lang) {
  const t = useLibraryT();
  return (name: string, team: TeamDoc | null): { text: string; auto: boolean } => {
    if (name) return { text: name, auto: false };
    if (!team) return { text: t("lib.team.noMembers"), auto: true };
    const names = team.pokemon.slice(0, 3).map((member) => speciesLabel(member.species, dex, lang));
    const joined = names.join(lang === "en" ? ", " : "、");
    return {
      text: team.pokemon.length > 3 ? fill(t("lib.andMore"), { names: joined }) : joined,
      auto: true,
    };
  };
}

/** A box's name when the reader has not named it: the first two are "Singles" and "Doubles" — where
 * each format's teams put their Pokémon first — and the rest "Box n". */
/** Each box's own tint, as the games give boxes their own wallpaper: 32 hues a small step apart,
 * starting from the brand blue and going once round the wheel, so neighbouring boxes differ gently.
 * Only ever mixed a few percent into the panel colour, so it stays quiet in both themes. */
const BOX_TINTS = 32;

export function boxTint(index: number): string {
  const step = ((index % BOX_TINTS) + BOX_TINTS) % BOX_TINTS;
  return `hsl(${(222 + step * (360 / BOX_TINTS)) % 360} 52% 50%)`;
}

export function useDefaultBoxName() {
  const t = useLibraryT();
  return (index: number): string => index === 0 ? t("lib.box.defaultSingle")
    : index === 1 ? t("lib.box.defaultDouble") : fill(t("lib.box.name"), { n: index + 1 });
}

/** A box's name: the reader's own, else the default. */
export function useBoxName() {
  const defaultName = useDefaultBoxName();
  return (layout: LibraryLayout, index: number): string => layout.boxes[index]?.name || defaultName(index);
}

export interface RuleChange {
  saved: string;
  current: string;
}

/** A record saved under another season or rule than the one on screen. Only a known difference
 * counts: a record with no snapshot, or a runtime that does not name its rule, is not flagged. */
export function useRuleChange() {
  const { capabilities } = useRuntime();
  const { season, rule } = capabilities.environment;
  return (snapshot: LibrarySnapshot | null): RuleChange | null => {
    if (!season || !rule || !snapshot?.season || !snapshot.rule) return null;
    if (snapshot.season === season && snapshot.rule === rule) return null;
    return { saved: `${snapshot.season} · ${snapshot.rule}`, current: `${season} · ${rule}` };
  };
}

const LOCALES: Record<Lang, string> = { zh: "zh-CN", en: "en", ja: "ja" };

/** Month and day this year, the full date otherwise. */
export function formatDay(ms: number, lang: Lang): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(LOCALES[lang], sameYear
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Tags typed as one line: commas (either width) or the ideographic comma separate them. */
export function parseTags(text: string): string[] {
  const tags = text.split(/[,，、]/).map((tag) => tag.trim().slice(0, 40)).filter(Boolean);
  return [...new Set(tags)].slice(0, 20);
}

/** The members as a row of small portraits — a team's face in a list. */
export function SpriteRow({ species, dex, lang, className = "lib-sprites" }: {
  species: string[];
  dex: DexMap;
  lang: Lang;
  className?: string;
}) {
  return (
    <span className={className}>
      {species.map((name, index) => (
        <GameImage key={`${name}-${index}`} assetKey={`pokemon:${speciesSlug(name, dex)}`} role="dense"
                   alt={speciesLabel(name, dex, lang)} />
      ))}
    </span>
  );
}

/** Everything in the store as one file, rows that no longer read included. */
export function useExportAll() {
  const t = useLibraryT();
  const toast = useToast();
  return async () => {
    try {
      saveJson(await exportAll(), exportFileName());
    } catch {
      toast({ text: t("lib.unavailable") });
    }
  };
}

/** A square icon-only action; the label is its tooltip and its accessible name. */
export function IconButton({ label, danger = false, disabled = false, pressed, onClick, children }: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  /** A toggle's state; leave out for a plain action. */
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={`lib-icon-btn${danger ? " danger" : ""}${pressed ? " on" : ""}`} title={label}
            aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

/** What is remembered of the current team, from a team record. */
export function activeTeamOf(team: TeamRecord): ActiveTeam {
  return { id: team.id, format: team.format };
}

/** Forget the current team once it is deleted. */
export function useActiveTeamSync(state: LibraryState | null) {
  const { active, setActive } = useLibraryWorkspace("active", "setActive");
  useEffect(() => {
    if (state && active && !state.teams.some((record) => record.id === active.id)) setActive(null);
  }, [state, active, setActive]);
}
