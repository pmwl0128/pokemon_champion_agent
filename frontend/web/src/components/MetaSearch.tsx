/** The site search on pages that have none of their own (teams, assist, sessions): the environment
 * ranking search, the same panel the ranking page carries. A row opens that Pokémon's environment
 * detail, where the same search is still open. It starts on the current team's format and has its
 * own singles/doubles switch. Loaded the first time it is opened. */
import type { FormatId } from "@pokemon-champions/protocol";
import { useCallback, useState } from "react";
import { useRanking } from "../hooks.ts";
import { useLibraryWorkspace } from "../lib/library/workspace.tsx";
import { FormatTabs } from "./FormatTabs.tsx";
import { MetaRail } from "./MetaRails.tsx";
import { useSiteSearch, type RailState } from "./SideRail.tsx";

export function MetaSearch() {
  const { fallbackOpen, setFallbackOpen } = useSiteSearch();
  const { active } = useLibraryWorkspace("active");
  const [format, setFormat] = useState<FormatId>(active?.format ?? "single");
  const ranking = useRanking(format);
  const ignoreAllowed = useCallback(() => {}, []);
  // A little wider than the ranking page's panel: its head also carries the format switch.
  const state: RailState = { open: fallbackOpen, setOpen: setFallbackOpen, width: 344 };
  return (
    <MetaRail state={state} format={format} ranking={ranking} onAllowed={ignoreAllowed}
      headActions={<FormatTabs format={format} onChange={setFormat} className="rail-format" />} />
  );
}
