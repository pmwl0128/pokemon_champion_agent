/** The teams page's search: the calculator's Pokémon rail, putting what it finds in the Pokémon Box
 * instead of opening the metagame page (which, here, read as leaving the page by accident). Its head
 * says which format's environment builds it offers and which box it fills; a build or 自定义 goes
 * into that box's next free cell through the library's own keep, with its undo. */
import type { FormatId, TeamMemberDoc } from "@pokemon-champions/protocol";
import { useMemo, useState } from "react";
import { CalcRail, type CalcRailApi } from "../CalcRail.tsx";
import { FormatTabs } from "../FormatTabs.tsx";
import { RailHandle, useSideRail } from "../SideRail.tsx";
import { useDexIndex } from "../../hooks.ts";
import { displayName, useLang } from "../../i18n.ts";
import type { LibraryState } from "../../lib/library/repo.ts";
import { useLibraryWorkspace } from "../../lib/library/workspace.tsx";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import type { BuildOption } from "../build/inputs.tsx";
import { fill, useLibraryT } from "./messages.ts";
import { useBoxName } from "./shared.tsx";

/** A picked environment build (or none: the species on its own) as a box Pokémon. */
function memberOf(entry: DexIndexEntry, option: BuildOption | null): TeamMemberDoc {
  if (!option) {
    return { species: entry.name, item: null, ability: entry.abilities[0]?.name ?? null, nature: null, moves: [], spread: {} };
  }
  const m = option.modal;
  return {
    species: entry.name, item: m.item || null, ability: m.ability || null, nature: m.nature || null,
    moves: m.moves.slice(0, 4), spread: { ...m.sps },
  };
}

export function TeamsRail({ state }: { state: LibraryState }) {
  const t = useLibraryT();
  const { lang } = useLang();
  const rail = useSideRail(380, "teams");
  const dex = useDexIndex();
  const { active, currentBox, setCurrentBox, keepMon } = useLibraryWorkspace("active", "currentBox", "setCurrentBox", "keepMon");
  const boxName = useBoxName();
  const [format, setFormat] = useState<FormatId>(active?.format ?? "single");
  const boxes = state.layout.boxes.length;
  const into = Math.min(currentBox, Math.max(0, boxes - 1));

  const api = useMemo<CalcRailApi>(() => ({
    format,
    targets: [{ id: "primary", label: boxName(state.layout, into) }],
    intro: (
      <div className="teams-rail-intro">
        <div className="teams-rail-row">
          <span>{t("lib.rail.builds")}</span>
          <FormatTabs format={format} onChange={setFormat} className="rail-format" />
          <label>
            <span>{t("lib.rail.into")}</span>
            <select value={into} onChange={(event) => setCurrentBox(Number(event.target.value))}>
              {Array.from({ length: boxes }, (_, index) => (
                <option key={index} value={index}>{boxName(state.layout, index)}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="teams-rail-hint muted">{t("lib.rail.hint")}</p>
      </div>
    ),
    pick: async (_target, entry, option) => {
      const name = displayName(entry, lang);
      const kept = await keepMon(memberOf(entry, option), option ? "meta" : "manual", name);
      return kept
        ? { ok: true, message: fill(t("lib.rail.added"), { box: kept.box, name }) }
        : { ok: false, message: t("lib.rail.full") };
    },
  }), [format, into, boxes, state.layout, boxName, setCurrentBox, keepMon, lang, t]);

  return (
    <>
      <RailHandle state={rail} label={t("calc.rail.title")} />
      <CalcRail state={rail} dex={dex.status === "ready" ? dex.data : NO_DEX} tab="teams" api={api} />
    </>
  );
}

const NO_DEX: DexIndexEntry[] = [];
