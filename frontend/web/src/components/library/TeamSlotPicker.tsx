/** Which team slot a team is saved to: the format's slots in order, each showing the team it holds.
 * Picking a taken slot means replacing that team — the caller says so next to its save button. */
import type { FormatId } from "@pokemon-champions/protocol";
import { useId } from "react";
import { useDexByName } from "../../hooks.ts";
import { useLang } from "../../i18n.ts";
import { boxById, teamDocOf, type LibraryState } from "../../lib/library/repo.ts";
import { fill, useLibraryT } from "./messages.ts";
import { SpriteRow, useTeamLabel } from "./shared.tsx";

export function TeamSlotPicker({ state, format, value, onChange, label }: {
  state: LibraryState;
  format: FormatId;
  value: number;
  onChange: (slot: number) => void;
  label: string;
}) {
  const t = useLibraryT();
  const { lang } = useLang();
  const dex = useDexByName();
  const teamLabel = useTeamLabel(dex, lang);
  const name = useId();
  const box = boxById(state);
  const slots = Array.from({ length: state.layout.teamSlots[format] }, (_, slot) =>
    state.teams.find((team) => team.format === format && team.slot === slot) ?? null);
  return (
    <fieldset className="lib-slot-pick">
      <legend>{label}</legend>
      {slots.map((team, slot) => {
        const doc = team ? teamDocOf(team, box) : null;
        return (
          <label key={slot} className={`lib-slot-option${slot === value ? " on" : ""}${team ? "" : " free"}`}>
            <input type="radio" name={name} checked={slot === value} onChange={() => onChange(slot)} />
            <span className="lib-slot-no num" aria-hidden>{slot + 1}</span>
            <span className="sr-only">{fill(t("lib.slot"), { n: slot + 1 })}</span>
            {team ? (
              <>
                {doc && <SpriteRow species={doc.pokemon.map((member) => member.species)} dex={dex} lang={lang}
                                   className="lib-sprites mini" />}
                <span className="lib-slot-option-name">{teamLabel(team.name, doc).text}</span>
              </>
            ) : (
              <span className="muted">{t("lib.slot.empty")}</span>
            )}
          </label>
        );
      })}
    </fieldset>
  );
}
