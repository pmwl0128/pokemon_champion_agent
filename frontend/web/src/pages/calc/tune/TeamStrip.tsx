/** The bar that opens the bulk tool: the calculator's roster bar, so switching tabs does not move a
 * pixel — the same two wings and the same centre console. What differs is only what it offers:
 * the conditions the solver can actually carry. Format, weather and terrain sit in the console as
 * everywhere; our screens are the one side condition, under our roster; the attacking side and the
 * field-wide switches offer nothing. A toggle the solver would silently drop does not belong here:
 * it would make the live number and the solved number disagree. Whatever else is set on the shared
 * field stays there for the calculator and simply is not shown. */
import { memo, type Dispatch, type SetStateAction } from "react";
import { useT, type MsgKey } from "../../../i18n.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import { FieldPanel } from "../duel/FieldPanel.tsx";
import { DuelBar, TeamBar, type ImportOutcome } from "../duel/TeamBar.tsx";
import type { FieldState, MonState, SharedFlagKey } from "../duel/state.ts";
import type { TuneSide } from "./model.ts";

/** Our screens, stored on the shared field's side "a" — ours, the side being hit here. */
export const SCREEN_FLAGS: Array<{ key: string; label: MsgKey }> = [
  { key: "reflect", label: "calc.reflect" },
  { key: "light_screen", label: "calc.lightScreen" },
  { key: "aurora_veil", label: "calc.auroraVeil" },
];

const SCREEN_KEYS: ReadonlySet<string> = new Set(SCREEN_FLAGS.map(({ key }) => key));
const NO_FLAGS: ReadonlySet<string> = new Set<string>();
const NO_SHARED: SharedFlagKey[] = [];

export const TeamStrip = memo(function TeamStrip({ teams, active, field, setField, dex, items, onActive,
  onAdd, onRemove, onReset, onImport }: {
  teams: Record<TuneSide, MonState[]>;
  active: Record<TuneSide, number>;
  field: FieldState;
  setField: Dispatch<SetStateAction<FieldState>>;
  dex: DexIndexEntry[];
  items: ItemRef[];
  onActive: (side: TuneSide, index: number) => void;
  onAdd: (side: TuneSide) => void;
  onRemove: (side: TuneSide, index: number) => void;
  onReset: (side: TuneSide) => void;
  onImport: (side: TuneSide, text: string) => Promise<ImportOutcome>;
}) {
  const t = useT();
  const roster = (side: TuneSide) => ({
    team: teams[side], index: active[side], dex, items, field, setField,
    onIndex: (index: number) => onActive(side, index),
    onAdd: () => onAdd(side),
    onRemove: (index: number) => onRemove(side, index),
    onReset: () => onReset(side),
    onImport: (text: string) => onImport(side, text),
  });
  return (
    <DuelBar field={field}>
      <TeamBar label={t("calc.attacker")} teamLabel={t("calc.attackerTeam")} {...roster("mine")}
        side="a" allowedFlags={SCREEN_KEYS} flagNote={t("tune.ws.screensNote")} />
      <FieldPanel field={field} setField={setField} weatherSuggestions={[]} terrainSuggestions={[]}
        sharedFlags={NO_SHARED} />
      <TeamBar label={t("calc.defender")} teamLabel={t("calc.defenderTeam")} {...roster("foe")}
        side="b" allowedFlags={NO_FLAGS} lockedNote={t("tune.ws.foeNoConds")} mirrored />
    </DuelBar>
  );
});
