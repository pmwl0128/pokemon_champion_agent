import { boxCells } from "../../lib/library/boxCells.ts";
import { useDeleteBoxRecord } from "./useDeleteBoxRecord.ts";
import { useEscapeLayer } from "../EscapeLayers.tsx";
/** "Pokémon boxes": the Pokémon the reader owns, laid out like the games' PC boxes — 6 × 5 cells a
 * box, one box on screen, arrows between them. The cell picked is shown beside the box, filling the
 * rest of the row: the Pokémon itself, editable in place and saved as it is edited, or, for an empty
 * cell, a way to put one there.
 *
 * A Pokémon moves by dragging it onto another cell (onto an arrow to change box first), or in move
 * mode, which stays on until cancelled: pick Pokémon — a click, Ctrl / Shift + click to add, or a
 * frame dragged across the grid — then a target cell; a group lands keeping its shape, one Pokémon
 * swaps with whatever is there. Arrow keys walk the grid. A box opened beyond the starting two can be
 * deleted, with whatever it still holds. */
import { type TeamMemberDoc } from "@pokemon-champions/protocol";
import {
  IconArrowsMove, IconChevronLeft, IconChevronRight, IconClipboardText, IconPencil, IconPlus, IconTrash,
  IconUsersPlus,
} from "@tabler/icons-react";
import {
  useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent,
  type PointerEvent,
} from "react";
import { useSearchParams } from "react-router-dom";
import { AdaptiveCombobox } from "../AdaptiveCombobox.tsx";
import { GameImage } from "../GameImage.tsx";
import { useToast } from "../Toast.tsx";
import { useDexByName, useDexIndex } from "../../hooks.ts";
import { displayName, useLang } from "../../i18n.ts";
import { useLibrarySnapshot } from "../../lib/library/hooks.ts";
import {
  BOX_COLUMNS, BOX_SLOTS, LIBRARY_START, type BoxRecord, type TeamRecord,
} from "../../lib/library/records.ts";
import {
  addToBox, deleteBox, freeCells, moveBoxRecord, moveBoxGroup, addBox, removeBoxRecord, renameBox,
  updateBoxRecord, type LibraryState,
} from "../../lib/library/repo.ts";
import { matchLocal } from "../../lib/pasteMembers.ts";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import { useLibraryWorkspace } from "../../lib/library/workspace.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { MonBuildEditor } from "./MonBuildEditor.tsx";
import { fill, useLibraryT } from "./messages.ts";
import { JoinTeamDialog } from "./JoinTeamDialog.tsx";
import { PasteDialog } from "./PasteDialog.tsx";
import { RenameBoxDialog } from "./RenameBoxDialog.tsx";
import {
  boxTint, formatDay, IconButton, parseTags, speciesLabel, speciesSlug, useBoxName, useDefaultBoxName,
} from "./shared.tsx";

/** How long a dragged Pokémon hovers over an arrow before the next box opens under it. */
const DRAG_FLIP_MS = 450;
/** How long the detail waits after the last keystroke before saving. */
const SAVE_DELAY_MS = 500;

/** A typed name → a dex entry: an exact name in any language, else the one species it is part of
 * ("烈咬" finds Garchomp — its Mega form, whose name contains the base name, does not count as a
 * second candidate). */
function findSpecies(dex: DexIndexEntry[], text: string): DexIndexEntry | undefined {
  const exact = matchLocal(dex, text);
  if (exact) return exact;
  const needle = text.trim().toLocaleLowerCase();
  if (!needle) return undefined;
  const names = (entry: DexIndexEntry) => [entry.name, entry.nameZh, entry.nameJa]
    .flatMap((name) => name ? [name.toLocaleLowerCase()] : []);
  const hits = dex.filter((entry) => names(entry).some((name) => name.includes(needle)));
  const base = hits.find((entry) => hits.every((other) =>
    names(other).some((name) => names(entry).some((own) => name.includes(own)))));
  return base;
}

export function BoxShelf({ state, maxBoxes }: {
  state: LibraryState;
  /** The most boxes this browser may open. */
  maxBoxes: number;
}) {
  const t = useLibraryT();
  const { lang } = useLang();
  const toast = useToast();
  const dex = useDexByName();
  const boxName = useBoxName();
  const defaultBoxName = useDefaultBoxName();
  // The box on show is the workspace's current box, shared with the dock: "keep" on any page puts
  // a Pokémon there.
  const { currentBox: current, setCurrentBox: setCurrent } = useLibraryWorkspace("currentBox", "setCurrentBox");
  const [selected, setSelected] = useState(0);
  // Move mode stays on until cancelled; `held` are the Pokémon picked to move next, in one box.
  const [moveMode, setMoveMode] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const [frame, setFrame] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const frameStart = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const [params, setParams] = useSearchParams();
  const [renaming, setRenaming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [joining, setJoining] = useState<BoxRecord | null>(null);
  const [pasting, setPasting] = useState(false);
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const flipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const boxes = state.layout.boxes.length;
  const box = Math.min(current, boxes - 1);
  const cells = useMemo(() => boxCells(state.box, box), [state.box, box]);
  const picked = cells[selected] ?? null;
  const species = new Set(state.box.map((record) => record.member.species)).size;
  const teamsOf = (id: string) => state.teams.filter((team) => team.members.includes(id));

  const endMove = () => { setMoveMode(false); setHeld([]); setFrame(null); };
  useEscapeLayer(moveMode, endMove, 10);
  // Escape leaves move mode; Pokémon deleted elsewhere drop out of the held group.
  useEffect(() => {
    if (!moveMode) return;
    setHeld((ids) => {
      const kept = ids.filter((id) => state.box.some((record) => record.id === id));
      return kept.length === ids.length ? ids : kept;
    });
  }, [moveMode, state.box]);

  // A link names a cell (the dock, a team card): show that box and select it.
  useEffect(() => {
    const cell = params.get("cell");
    if (!cell) return;
    const [boxPart, slotPart] = cell.split(".").map(Number);
    if (Number.isInteger(boxPart) && Number.isInteger(slotPart)) {
      setCurrent(boxPart!);
      setSelected(slotPart!);
    }
    const updated = new URLSearchParams(params);
    updated.delete("cell");
    updated.delete("edit");
    setParams(updated, { replace: true });
  }, [params]);

  const showBox = (index: number) => setCurrent((index + boxes) % boxes);

  const moveTo = async (id: string, slot: number) => {
    setDropSlot(null);
    await moveBoxRecord(id, { box, slot });
    setSelected(slot);
  };

  /** Put the held group down with its top-left Pokémon on `slot`, every other keeping its offset. */
  const dropHeld = async (slot: number) => {
    const records = held.map((id) => state.box.find((record) => record.id === id)).filter((record): record is BoxRecord => !!record);
    if (!records.length) return;
    if (records.length === 1) {
      await moveTo(records[0]!.id, slot);
      setHeld([]);
      return;
    }
    const anchor = records.reduce((best, record) => (record.slot < best.slot ? record : best));
    const row = (at: number) => Math.floor(at / BOX_COLUMNS);
    const col = (at: number) => at % BOX_COLUMNS;
    const moves = records.map((record) => {
      const r = row(slot) + row(record.slot) - row(anchor.slot);
      const c = col(slot) + col(record.slot) - col(anchor.slot);
      return { id: record.id, to: { box, slot: r * BOX_COLUMNS + c }, fits: r >= 0 && r < BOX_SLOTS / BOX_COLUMNS && c >= 0 && c < BOX_COLUMNS };
    });
    if (moves.some((move) => !move.fits) || !(await moveBoxGroup(moves.map(({ id, to }) => ({ id, to }))))) {
      toast({ text: t("lib.box.groupNoRoom") });
      return;
    }
    setHeld([]);
    setSelected(slot);
  };

  /** Send the held group to another box, into its free cells in order (its shape is not kept). */
  const sendHeld = async (target: number) => {
    const ids = held.filter((id) => state.box.some((record) => record.id === id));
    const free = Array.from({ length: BOX_SLOTS }, (_, slot) => slot)
      .filter((slot) => !state.box.some((record) => record.box === target && record.slot === slot && !ids.includes(record.id)));
    if (!ids.length) return;
    if (free.length < ids.length
      || !(await moveBoxGroup(ids.map((id, at) => ({ id, to: { box: target, slot: free[at]! } }))))) {
      toast({ text: fill(t("lib.box.sendNoRoom"), { name: boxName(state.layout, target) }) });
      return;
    }
    setHeld([]);
    setCurrent(target);
    setSelected(free[0]!);
    toast({ text: fill(t("lib.box.sent"), { n: ids.length, name: boxName(state.layout, target) }) });
  };

  const pick = (slot: number, event?: MouseEvent) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (!moveMode) { setSelected(slot); return; }
    const record = cells[slot];
    const adding = !!event && (event.ctrlKey || event.metaKey || event.shiftKey);
    // A Pokémon from another box starts a new group: a group lives in one box.
    const heldHere = held.filter((id) => cells.some((cell) => cell?.id === id));
    if (record && heldHere.includes(record.id)) {
      setHeld(heldHere.filter((id) => id !== record.id));
      return;
    }
    if (record && (adding || held.length === 0)) {
      setHeld([...(adding ? heldHere : []), record.id]);
      setSelected(slot);
      return;
    }
    if (held.length) void dropHeld(slot);
  };

  // Framing: in move mode a drag across the grid picks every Pokémon it touches.
  const onGridPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!moveMode || event.button !== 0) return;
    frameStart.current = { x: event.clientX, y: event.clientY, active: false };
  };
  const onGridPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = frameStart.current;
    const grid = gridRef.current;
    if (!start || !grid) return;
    if (!start.active && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return;
    if (!start.active) { start.active = true; grid.setPointerCapture(event.pointerId); }
    const origin = grid.getBoundingClientRect();
    setFrame({ x0: start.x - origin.left, y0: start.y - origin.top, x1: event.clientX - origin.left, y1: event.clientY - origin.top });
  };
  const onGridPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = frameStart.current;
    frameStart.current = null;
    const grid = gridRef.current;
    if (!start?.active || !grid) return;
    // The click that ends a drag lands on whatever is under the pointer (the grid, under capture);
    // swallow only that one.
    suppressClick.current = true;
    setTimeout(() => { suppressClick.current = false; }, 0);
    const left = Math.min(start.x, event.clientX);
    const right = Math.max(start.x, event.clientX);
    const top = Math.min(start.y, event.clientY);
    const bottom = Math.max(start.y, event.clientY);
    const touched = cells.flatMap((record, slot) => {
      const node = cellRefs.current[slot];
      if (!record || !node) return [];
      const r = node.getBoundingClientRect();
      return r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom ? [record.id] : [];
    });
    const heldHere = held.filter((id) => cells.some((cell) => cell?.id === id));
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    setHeld(additive ? [...new Set([...heldHere, ...touched])] : touched);
    setFrame(null);
  };

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: BOX_COLUMNS, ArrowUp: -BOX_COLUMNS }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = selected + step;
    if (next < 0 || next >= BOX_SLOTS) return;
    setSelected(next);
    cellRefs.current[next]?.focus();
  };

  const flipLater = (index: number) => {
    if (flipTimer.current) clearTimeout(flipTimer.current);
    flipTimer.current = setTimeout(() => showBox(index), DRAG_FLIP_MS);
  };
  const flipCancel = () => {
    if (flipTimer.current) clearTimeout(flipTimer.current);
    flipTimer.current = null;
  };

  const remove = useDeleteBoxRecord();

  const open = async () => {
    const layout = await addBox(maxBoxes);
    if (layout) {
      setCurrent(layout.boxes.length - 1);
      setSelected(0);
    }
  };

  const name = boxName(state.layout, box);
  const used = cells.filter(Boolean).length;
  const starting = box < LIBRARY_START.boxes;

  const close = async () => {
    const layout = await deleteBox(box);
    if (!layout) return;
    endMove();
    setCurrent(Math.max(0, box - 1));
    setSelected(0);
    toast({ text: fill(t("lib.box.deleted"), { name }) });
  };

  const dragProps = (record: BoxRecord | null, slot: number) => ({
    // In move mode a drag frames a selection instead.
    draggable: Boolean(record) && !moveMode,
    onDragStart: (event: DragEvent) => {
      if (!record) return;
      event.dataTransfer.setData("application/x-pc-box-id", record.id);
      event.dataTransfer.effectAllowed = "move";
      setSelected(slot);
    },
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (dropSlot !== slot) setDropSlot(slot);
    },
    onDragLeave: () => setDropSlot((value) => value === slot ? null : value),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      const id = event.dataTransfer.getData("application/x-pc-box-id");
      if (id && state.box.some((entry) => entry.id === id)) void moveTo(id, slot);
      else setDropSlot(null);
    },
    onDragEnd: () => { setDropSlot(null); flipCancel(); },
  });

  const arrowDrag = (index: number) => ({
    onDragEnter: () => flipLater(index),
    onDragOver: (event: DragEvent) => event.preventDefault(),
    onDragLeave: flipCancel,
    onDrop: flipCancel,
  });

  return (
    <section className="lib-shelf">
      <div className="lib-toolbar">
        <span className="lib-count muted num">{fill(t("lib.box.total"), { n: state.box.length, s: species })}</span>
        <span className="lib-toolbar-end">
          <button type="button" className="second-btn lib-btn" onClick={() => setPasting(true)}>
            <IconClipboardText aria-hidden />{t("lib.box.fromText")}
          </button>
        </span>
      </div>

      {state.broken.box.length > 0 && (
        <p className="notice lib-warn">{fill(t("lib.broken"), { n: state.broken.box.length })}</p>
      )}

      <div className="lib-boxes">
        <div className="lib-box-panel" style={{ ["--box-tint" as string]: boxTint(box) }}>
          <div className="lib-box-head">
            <span {...arrowDrag(box - 1)}>
              <IconButton label={t("lib.box.prev")} disabled={boxes < 2} onClick={() => showBox(box - 1)}>
                <IconChevronLeft />
              </IconButton>
            </span>
            <div className="lib-box-title">
              <h2>{name}</h2>
              <button type="button" className="lib-box-rename" title={t("lib.box.rename")}
                      aria-label={t("lib.box.rename")} onClick={() => setRenaming(true)}>
                <IconPencil aria-hidden />
              </button>
              <button type="button" className={`lib-box-rename${moveMode ? " on" : ""}`} title={t("lib.box.move")}
                      aria-label={t("lib.box.move")} aria-pressed={moveMode}
                      onClick={() => (moveMode ? endMove() : setMoveMode(true))}>
                <IconArrowsMove aria-hidden />
              </button>
              {/* A disabled button shows no tooltip; the wrapper carries why it is disabled. */}
              <span className="lib-box-tip" title={t(starting ? "lib.box.deleteDefault" : "lib.box.delete")}>
                <button type="button" className="lib-box-rename danger" aria-label={t("lib.box.delete")}
                        disabled={starting} onClick={() => (used ? setClosing(true) : void close())}>
                  <IconTrash aria-hidden />
                </button>
              </span>
            </div>
            <span className="lib-box-used num">{used}/{BOX_SLOTS}</span>
            <span {...arrowDrag(box + 1)}>
              <IconButton label={t("lib.box.next")} disabled={boxes < 2} onClick={() => showBox(box + 1)}>
                <IconChevronRight />
              </IconButton>
            </span>
          </div>

          {/* Laid over the box, not above it: entering move mode must not shift the grid. */}
          {moveMode && (
            <div className="lib-box-moving" role="status">
              <IconArrowsMove aria-hidden />
              <span>{held.length ? fill(t("lib.box.movingHeld"), { n: held.length }) : t("lib.box.movePick")}</span>
              <button type="button" className="second-btn" onClick={endMove}>{t("lib.box.moveDone")}</button>
              {held.length > 0 && boxes > 1 && (
                <span className="lib-box-send">
                  <span className="muted">{t("lib.box.sendTo")}</span>
                  {state.layout.boxes.map((_, index) => index === box ? null : (
                    <button key={index} type="button" className="lib-box-send-chip"
                            style={{ ["--box-tint" as string]: boxTint(index) }}
                            onClick={() => void sendHeld(index)}>{boxName(state.layout, index)}</button>
                  ))}
                </span>
              )}
            </div>
          )}

          <div ref={gridRef} className={`lib-box-grid${moveMode ? " moving" : ""}`} role="group" aria-label={name}
               onKeyDown={onGridKey} onPointerDown={onGridPointerDown} onPointerMove={onGridPointerMove}
               onPointerUp={onGridPointerUp} onPointerCancel={() => { frameStart.current = null; setFrame(null); }}>
            {frame && (
              <span className="lib-box-frame" aria-hidden style={{
                left: Math.min(frame.x0, frame.x1), top: Math.min(frame.y0, frame.y1),
                width: Math.abs(frame.x1 - frame.x0), height: Math.abs(frame.y1 - frame.y0),
              }} />
            )}
            {cells.map((record, slot) => {
              const inTeam = record ? state.teams.some((team) => team.members.includes(record.id)) : false;
              const label = record
                ? `${fill(t("lib.box.cell"), { n: slot + 1 })}: ${record.nickname || speciesLabel(record.member.species, dex, lang)}`
                : fill(t("lib.box.cellEmpty"), { n: slot + 1 });
              const classes = ["lib-cell", record ? "filled" : "free", slot === selected ? "on" : "",
                record && held.includes(record.id) ? "lifted" : "", dropSlot === slot ? "drop" : ""].filter(Boolean).join(" ");
              return (
                <button key={slot} type="button" ref={(node) => { cellRefs.current[slot] = node; }}
                        className={classes} tabIndex={slot === selected ? 0 : -1} aria-label={label}
                        aria-current={slot === selected || undefined} onClick={(event) => pick(slot, event)}
                        {...dragProps(record, slot)}>
                  {record && (
                    <>
                      <GameImage assetKey={`pokemon:${speciesSlug(record.member.species, dex)}`} role="dense" alt="" />
                      {inTeam && <span className="lib-cell-team" title={t("lib.box.inTeamMark")} />}
                    </>
                  )}
                </button>
              );
            })}
          </div>

          {boxes > 2 || maxBoxes > boxes ? (
            <div className="lib-box-dots" role="group" aria-label={t("lib.box.pick")}>
              {state.layout.boxes.map((_, index) => (
                <button key={index} type="button" className={`lib-box-dot${index === box ? " on" : ""}`}
                        aria-label={boxName(state.layout, index)} aria-current={index === box || undefined}
                        title={boxName(state.layout, index)} onClick={() => showBox(index)}
                        onDragEnter={() => flipLater(index)} onDragLeave={flipCancel}>
                  <span className="num">{index + 1}</span>
                </button>
              ))}
              {maxBoxes > boxes && (
                <button type="button" className="lib-box-dot add" title={t("lib.box.open")}
                        aria-label={t("lib.box.open")} onClick={() => void open()}>
                  <IconPlus aria-hidden />
                </button>
              )}
            </div>
          ) : null}
        </div>

        <aside className="lib-box-detail" aria-live="polite">
          {picked ? (
            <BoxEditor record={picked} teams={teamsOf(picked.id)}
              where={`${name} · ${fill(t("lib.box.cell"), { n: selected + 1 })}`}
              onJoin={() => setJoining(picked)} onDelete={() => void remove(picked)} />
          ) : (
            <>
              <div className="lib-detail-where muted">
                {name} · {fill(t("lib.box.cell"), { n: selected + 1 })}
              </div>
              <AddToCell box={box} slot={selected} state={state}
                onAdded={() => {
                  // Next empty cell of this box, so a run of Pokémon can be typed in one after another.
                  const next = freeCells(state, { box, slot: selected + 1 }).find((cell) => cell.box === box && cell.slot !== selected);
                  if (next) setSelected(next.slot);
                }}
                onPaste={() => setPasting(true)} />
            </>
          )}
        </aside>
      </div>

      {joining && <JoinTeamDialog state={state} record={joining} onClose={() => setJoining(null)} />}
      {renaming && (
        <RenameBoxDialog initial={state.layout.boxes[box]?.name ?? ""} placeholder={defaultBoxName(box)}
          onSave={(value) => renameBox(box, value)} onClose={() => setRenaming(false)} />
      )}
      {closing && (
        <ConfirmDialog title={fill(t("lib.box.deleteTitle"), { name })}
          body={fill(t("lib.box.deleteBody"), { n: used })} confirm={t("lib.box.delete")}
          onConfirm={close} onClose={() => setClosing(false)} />
      )}
      {pasting && (
        <PasteDialog state={state} target={{ mode: "box", at: { box, slot: selected } }}
          onClose={() => setPasting(false)} />
      )}
    </section>
  );
}

interface Draft {
  member: TeamMemberDoc;
  nickname: string;
  notes: string;
  /** As typed: parsed into tags when saved, so a trailing comma survives a pause. */
  tags: string;
}

const draftOf = (record: BoxRecord): Draft => ({
  member: record.member, nickname: record.nickname, notes: record.notes, tags: record.tags.join(", "),
});

/** The draft says what the record says (a save of it would change nothing). */
const matches = (draft: Draft, record: BoxRecord) =>
  JSON.stringify(draft.member) === JSON.stringify(record.member) && draft.nickname.trim() === record.nickname
  && draft.notes.trim() === record.notes && JSON.stringify(parseTags(draft.tags)) === JSON.stringify(record.tags);

/** The picked Pokémon, edited in place: species and forme, build (with an environment build), SP,
 * nickname, notes and tags. Every change is saved a moment after the last keystroke; picking another
 * cell saves what is pending first. */
function BoxEditor({ record, teams, where, onJoin, onDelete }: {
  record: BoxRecord;
  teams: TeamRecord[];
  where: string;
  onJoin: () => void;
  onDelete: () => void;
}) {
  const t = useLibraryT();
  const { lang } = useLang();
  const dex = useDexByName();
  const [draft, setDraft] = useState<Draft>(() => draftOf(record));
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const pending = useRef<{ id: string; draft: Draft } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const job = pending.current;
    pending.current = null;
    if (!job) return;
    setStatus("saving");
    try {
      await updateBoxRecord(job.id, {
        member: job.draft.member, nickname: job.draft.nickname, notes: job.draft.notes.trim(),
        tags: parseTags(job.draft.tags),
      });
      setStatus("saved");
    } catch {
      setStatus("failed");
    }
  }, []);

  // Another cell: what is pending for this one is saved, and the new one is loaded.
  useEffect(() => {
    setDraft(draftOf(record));
    setStatus("idle");
    return () => { void flush(); };
  }, [record.id]);
  // An edit made elsewhere (the dock) while nothing is pending here shows up here.
  useEffect(() => {
    if (!pending.current) setDraft((current) => (matches(current, record) ? current : draftOf(record)));
  }, [record]);

  const change = (patch: Partial<Draft>) => {
    setDraft((current) => {
      const next = { ...current, ...patch };
      pending.current = { id: record.id, draft: next };
      return next;
    });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  const label = speciesLabel(draft.member.species, dex, lang);
  return (
    <div className="lib-detail lib-box-editor">
      <div className="lib-editor-head">
        <span className="lib-detail-where muted">{where}</span>
        <span className="lib-editor-status muted" role="status">
          {status === "saving" ? t("lib.detail.saving") : status === "saved" ? t("lib.detail.saved")
            : status === "failed" ? <em className="lib-add-error">{t("lib.detail.failed")}</em> : null}
        </span>
        <span className="lib-detail-actions">
          <button type="button" className="second-btn lib-btn" onClick={onJoin}>
            <IconUsersPlus aria-hidden />{t("lib.join")}
          </button>
          <IconButton label={t("lib.act.delete")} danger onClick={onDelete}><IconTrash /></IconButton>
        </span>
      </div>

      <MonBuildEditor value={draft.member} onChange={(member) => change({ member })} layout="panel"
        beside={(
          <div className="lib-editor-notes side">
            <label>
              <span>{t("lib.field.nickname")}</span>
              <input value={draft.nickname} maxLength={40} placeholder={label}
                     onChange={(event) => change({ nickname: event.target.value })} />
            </label>
            <label>
              <span>{t("lib.field.tags")} <small className="muted">{t("lib.field.tagsHint")}</small></span>
              <input value={draft.tags} onChange={(event) => change({ tags: event.target.value })} />
            </label>
          </div>
        )} />

      <div className="lib-editor-notes">
        <label className="wide">
          <span>{t("lib.field.notes")}</span>
          <textarea rows={2} value={draft.notes} maxLength={4000}
                    onChange={(event) => change({ notes: event.target.value })} />
        </label>
      </div>

      <div className="lib-detail-foot">
        {teams.length > 0 ? (
          <span className="lib-detail-teams">
            <span className="muted">{t("lib.box.inTeams")}</span>
            {teams.map((team) => (
              <span key={team.id} className="lib-tag">
                {fill(t("lib.box.teamRef"), { format: t(`format.${team.format}`), n: team.slot + 1 })}
              </span>
            ))}
          </span>
        ) : <span />}
        <span className="muted num">{t(`lib.origin.${record.origin}`)} · {formatDay(record.createdAt, lang)}</span>
      </div>
    </div>
  );
}

/** An empty cell: type a name (any language) to put that species there, or paste a text. */
function AddToCell({ box, slot, state, onAdded, onPaste }: {
  box: number;
  slot: number;
  state: LibraryState;
  onAdded: () => void;
  onPaste: () => void;
}) {
  const t = useLibraryT();
  const { lang } = useLang();
  const toast = useToast();
  const snapshot = useLibrarySnapshot();
  const dexList = useDexIndex();
  const [value, setValue] = useState("");
  const [unknown, setUnknown] = useState(false);
  const full = freeCells(state).length === 0;

  const options = useMemo(() => dexList.status === "ready" ? dexList.data.map((entry) => ({
    key: entry.slug,
    value: displayName(entry, lang),
    secondary: entry.name,
    searchText: `${entry.nameZh ?? ""} ${entry.nameJa ?? ""} ${entry.slug}`,
  })) : [], [dexList, lang]);

  const add = async (text: string) => {
    if (dexList.status !== "ready" || !text.trim()) return;
    const entry = findSpecies(dexList.data, text);
    if (!entry) { setUnknown(true); return; }
    try {
      const record = await addToBox({
        species: entry.name, item: null, ability: null, moves: [], nature: null, spread: null,
      }, { origin: "manual", snapshot }, { box, slot });
      if (!record) { toast({ text: t("lib.box.full") }); return; }
      setValue("");
      setUnknown(false);
      toast({
        text: fill(t("lib.box.added"), { name: displayName(entry, lang) }),
        action: { label: t("lib.toast.undo"), run: () => void removeBoxRecord(record.id) },
      });
      onAdded();
    } catch {
      toast({ text: t("lib.toast.failed") });
    }
  };

  return (
    <form className="lib-add" onSubmit={(event) => { event.preventDefault(); void add(value); }}>
      <label htmlFor="lib-box-add" className="lib-add-title">
        <IconPlus aria-hidden />{t("lib.box.addLabel")}
      </label>
      <span className="lib-add-row">
        <AdaptiveCombobox id="lib-box-add" value={value} options={options} maxLength={60} disabled={full}
          placeholder={t("lib.box.addPlaceholder")} aria-invalid={unknown || undefined}
          onValueChange={(next) => { setValue(next); setUnknown(false); }}
          onCommit={(next, reason) => { if (reason === "selection") void add(next); }} />
        <button type="submit" className="primary-btn" disabled={full || !value.trim()}>{t("lib.box.add")}</button>
      </span>
      {unknown && <span className="lib-add-error">{t("lib.box.unknown")}</span>}
      {full && <span className="lib-add-error">{t("lib.box.full")}</span>}
      <button type="button" className="lib-link-btn" disabled={full} onClick={onPaste}>
        <IconClipboardText aria-hidden />{t("lib.box.fromText")}
      </button>
      <p className="muted lib-add-hint">{t("lib.box.fromTextHint")}</p>
    </form>
  );
}
