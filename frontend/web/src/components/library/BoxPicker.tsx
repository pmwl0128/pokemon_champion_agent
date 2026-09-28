import { boxCells } from "../../lib/library/boxCells.ts";
/** Pick one box Pokémon: the boxes as they are, one at a time, 6 × 5. Pokémon that cannot be picked
 * (already in the team being built) stay visible but inert, so the box reads as the box. */
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useState } from "react";
import { GameImage } from "../GameImage.tsx";
import { Modal } from "../Modal.tsx";
import { useDexByName } from "../../hooks.ts";
import { useLang } from "../../i18n.ts";
import { type BoxRecord } from "../../lib/library/records.ts";
import type { LibraryState } from "../../lib/library/repo.ts";
import { fill, useLibraryT } from "./messages.ts";
import { IconButton, speciesLabel, speciesSlug, useBoxName } from "./shared.tsx";

export function BoxPicker({ state, blocked, onPick, onClose }: {
  state: LibraryState;
  /** Box ids that cannot be picked. */
  blocked: ReadonlySet<string>;
  onPick: (record: BoxRecord) => void;
  onClose: () => void;
}) {
  const t = useLibraryT();
  const { lang } = useLang();
  const dex = useDexByName();
  const boxName = useBoxName();
  const boxes = state.layout.boxes.length;
  // Open on the first box that holds anything.
  const [box, setBox] = useState(() => Math.max(0, state.box[0]?.box ?? 0));
  const cells = boxCells(state.box, box);

  return (
    <Modal title={t("lib.pick.title")} onClose={onClose} width={440} className="lib-dialog">
      {state.box.length === 0 ? (
        <p className="notice">{t("lib.pick.empty")}</p>
      ) : (
        <div className="lib-pick">
          <div className="lib-pick-head">
            <IconButton label={t("lib.box.prev")} disabled={boxes < 2} onClick={() => setBox((box - 1 + boxes) % boxes)}>
              <IconChevronLeft />
            </IconButton>
            <b>{boxName(state.layout, box)}</b>
            <IconButton label={t("lib.box.next")} disabled={boxes < 2} onClick={() => setBox((box + 1) % boxes)}>
              <IconChevronRight />
            </IconButton>
          </div>
          <div className="lib-pick-grid">
            {cells.map((record, slot) => {
              if (!record) return <span key={slot} className="lib-cell free" aria-hidden />;
              const name = record.nickname || speciesLabel(record.member.species, dex, lang);
              const inert = blocked.has(record.id);
              return (
                <button key={slot} type="button" className="lib-cell filled" disabled={inert}
                        title={inert ? `${name} · ${t("lib.pick.inTeam")}` : name}
                        aria-label={`${fill(t("lib.box.cell"), { n: slot + 1 })}: ${name}`}
                        onClick={() => { onPick(record); onClose(); }}>
                  <GameImage assetKey={`pokemon:${speciesSlug(record.member.species, dex)}`} role="dense" alt="" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}
