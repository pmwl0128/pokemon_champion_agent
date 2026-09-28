/** The calculator's side of the library workspace (frontend/design.md §2.4): a saved team fills our
 * side or theirs, one saved Pokémon joins a side, and either team on screen can be kept. It sits
 * under the roster, so every calculator tab shares it, and the team bars are its drop zones.
 *
 * A library team arrives pinned, like every hand-off of real builds: its blanks are facts about
 * that team, not gaps for the environment auto-fill. The calculator follows the team's format. */
import type { TeamDoc, TeamMemberDoc } from "@pokemon-champions/protocol";
import { useTransferT } from "../../lib/library/transferMessages.ts";
import {
  useLibraryReceiver, useLibrarySource, type ReceiveResult,
} from "../../lib/library/workspace.tsx";
import { teamToCalcMembers } from "../../lib/team.ts";
import { toTeamDoc } from "../../lib/teamDoc.ts";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import { TEAM_MAX } from "./duel/TeamBar.tsx";
import { monToMember, type MonState, type SideId } from "./duel/state.ts";
import { fromCalcMember, useRoster } from "./roster.tsx";

/** A roster side as team-json: the Pokémon actually picked, with what is filled in. */
export function sideTeamDoc(team: MonState[], format: "single" | "double", dex: DexIndexEntry[]): TeamDoc | null {
  const pokemon = team.flatMap((mon) => monToMember(mon, dex) ?? []);
  return pokemon.length ? toTeamDoc({ format, pokemon }) : null;
}

function memberMon(member: TeamMemberDoc, dex: DexIndexEntry[]): MonState | null {
  const [calc] = teamToCalcMembers({ pokemon: [member] });
  const mon = calc ? fromCalcMember(calc, dex) : null;
  return mon?.slug ? mon : null;
}

export function CalcLibraryTransfers({ dex }: { dex: DexIndexEntry[] }) {
  const t = useTransferT();
  const { teams, active, field, setTeams, setActive, setSlot, setField } = useRoster();

  const fillSide = (side: SideId, doc: TeamDoc): ReceiveResult => {
    const mons = teamToCalcMembers(doc).map((member) => fromCalcMember(member, dex))
      .filter((mon) => mon.slug).slice(0, TEAM_MAX);
    if (!mons.length) return { ok: false, message: t("transfer.unreadable") };
    setTeams((previous) => ({ ...previous, [side]: mons }));
    setActive((previous) => ({ ...previous, [side]: 0 }));
    setSlot((previous) => ({ ...previous, [side]: 0 }));
    if (doc.format !== field.format) setField((previous) => ({ ...previous, format: doc.format }));
    return { ok: true };
  };

  const joinSide = (side: SideId, member: TeamMemberDoc): ReceiveResult => {
    const mon = memberMon(member, dex);
    if (!mon) return { ok: false, message: t("transfer.unreadable") };
    const list = teams[side];
    // A side that is still one empty slot takes the Pokémon there instead of beside it.
    const replaceBlank = list.length === 1 && !list[0]!.slug;
    if (!replaceBlank && list.length >= TEAM_MAX) return { ok: false, message: t("transfer.calc.full") };
    const index = replaceBlank ? 0 : list.length;
    setTeams((previous) => ({ ...previous, [side]: replaceBlank ? [mon] : [...previous[side], mon] }));
    setActive((previous) => ({ ...previous, [side]: index }));
    return { ok: true };
  };

  useLibraryReceiver({ id: "calc-team-a", kind: "team", label: t("transfer.calc.teamOurs"),
    receive: ({ doc }) => fillSide("a", doc) });
  useLibraryReceiver({ id: "calc-team-b", kind: "team", label: t("transfer.calc.teamTheirs"),
    receive: ({ doc }) => fillSide("b", doc) });
  useLibraryReceiver({ id: "calc-mon-a", kind: "pokemon", label: t("transfer.calc.monOurs"),
    receive: ({ member }) => joinSide("a", member) });
  useLibraryReceiver({ id: "calc-mon-b", kind: "pokemon", label: t("transfer.calc.monTheirs"),
    receive: ({ member }) => joinSide("b", member) });
  // The Pokémon each side has up, one at a time, ahead of the whole teams.
  const upMon = (side: SideId) => {
    const mon = teams[side][Math.min(active[side], teams[side].length - 1)];
    return mon ? sideTeamDoc([mon], field.format, dex)?.pokemon[0] ?? null : null;
  };
  useLibrarySource({ id: "calc-keep-mon-a", origin: "calc", kind: "pokemon", label: t("transfer.calc.keepMonOurs"),
    read: () => upMon("a") });
  useLibrarySource({ id: "calc-keep-mon-b", origin: "calc", kind: "pokemon", label: t("transfer.calc.keepMonTheirs"),
    read: () => upMon("b") });
  useLibrarySource({ id: "calc-keep-a", origin: "calc", kind: "team", label: t("transfer.calc.saveOurs"),
    read: () => sideTeamDoc(teams.a, field.format, dex) });
  useLibrarySource({ id: "calc-keep-b", origin: "calc", kind: "team", label: t("transfer.calc.saveTheirs"),
    read: () => sideTeamDoc(teams.b, field.format, dex) });
  return null;
}
