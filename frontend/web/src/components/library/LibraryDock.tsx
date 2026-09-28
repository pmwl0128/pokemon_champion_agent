import { useHoverPreview } from "../useHoverPreview.ts";
import { boxCells } from "../../lib/library/boxCells.ts";
import { useDeleteBoxRecord } from "./useDeleteBoxRecord.ts";
import { useEscapeLayer } from "../EscapeLayers.tsx";
/** The library dock: the reader's teams and boxes beside whatever page is open (frontend/design.md
 * §2.4). It never takes the page over — no scrim, the page stays live. On a wide screen it docks
 * into the right gutter like the page rails; narrower it floats over the right edge; on a phone it
 * is a sheet from the bottom.
 *
 * What the reader picks here (a team, one of its Pokémon, a box Pokémon) goes into the page
 * through the page's own receivers, listed in the action bar, or by dragging it onto the page.
 * What the page offers to keep (its sources) is saved from the same bar. Full management —
 * files, notes, diagnosis — stays on the teams page. */
import "../../styles.library.css";
import type { FormatId, TeamDoc, TeamMemberDoc } from "@pokemon-champions/protocol";
import {
  IconChevronLeft, IconChevronRight, IconDeviceFloppy, IconExternalLink, IconFileImport, IconPencil, IconTrash, IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BuildSetSummary, type BuildCardOption } from "../BuildPicker.tsx";
import { GameImage } from "../GameImage.tsx";
import { SegmentedControl } from "../SegmentedControl.tsx";
import { useToast } from "../Toast.tsx";
import { useDexByName, useItemsByName } from "../../hooks.ts";
import { useLang } from "../../i18n.ts";
import { useLibrary, useLibrarySnapshot } from "../../lib/library/hooks.ts";
import { BOX_SLOTS, type BoxRecord, type TeamRecord } from "../../lib/library/records.ts";
import {
  addToBox, boxById, moveBoxRecord, removeBoxRecord, renameBox, teamDocOf, updateTeam,
  type LibraryState,
} from "../../lib/library/repo.ts";
import {
  LIBRARY_MIME, useLibraryWorkspace, type AnyReceiver, type LibraryKind, type LibraryPayload,
  type LibrarySource,
} from "../../lib/library/workspace.tsx";
import { localName, useNameMaps } from "../../lib/names.ts";
import { formatTeamPlainText } from "../../lib/team.ts";
import { useRailGeometry } from "../SideRail.tsx";
import { fill, useLibraryT } from "./messages.ts";
import { BoxRecordEditDialog } from "./BoxRecordEditDialog.tsx";
import { EditDialog } from "./EditDialog.tsx";
import { RemoveMemberDialog } from "./RemoveMemberDialog.tsx";
import { RenameBoxDialog } from "./RenameBoxDialog.tsx";
import { HoverSet } from "../team/MonChip.tsx";
import { SaveTeamDialog } from "./SaveTeamDialog.tsx";
import {
  activeTeamOf, boxTint, speciesLabel, speciesSlug, SpriteRow, useActiveTeamSync, useBoxName, useDefaultBoxName,
  useTeamLabel,
} from "./shared.tsx";

const DOCK_WIDTH = 360;
const DOCK_FLOOR = 760;

type DockTab = "teams" | "box";

/** What the dock showed last, so closing and reopening it (or changing page) comes back to the
 * same place. It is this page view's memory only. */
const memory: { tab: DockTab; format: FormatId | null; cell: number; member: number | null } = {
  tab: "teams", format: null, cell: 0, member: null,
};

function dragData(event: DragEvent, payload: LibraryPayload, text: string) {
  event.dataTransfer.setData(LIBRARY_MIME, JSON.stringify(payload));
  event.dataTransfer.setData("text/plain", text);
  event.dataTransfer.effectAllowed = "copy";
}

export function LibraryDock() {
  const t = useLibraryT();
  const { lang } = useLang();
  const toast = useToast();
  const dex = useDexByName();
  const snapshot = useLibrarySnapshot();
  const workspace = useLibraryWorkspace();
  const { receivers, sources, active, setActive, setDragging, deliver, setOpen } = workspace;
  useEscapeLayer(true, () => setOpen(false), 20);
  const library = useLibrary();
  const state = library && library !== "unavailable" ? library : null;
  useActiveTeamSync(state);
  const overlay = useRailGeometry(true, DOCK_WIDTH, DOCK_FLOOR, "right");
  const [tab, setTabState] = useState<DockTab>(memory.tab);
  const [format, setFormatState] = useState<FormatId>(memory.format ?? active?.format ?? "single");
  // The box on show is the workspace's current box: where "keep" puts a Pokémon from any page.
  const box = workspace.currentBox;
  const [cell, setCellState] = useState(memory.cell);
  const [member, setMemberState] = useState<number | null>(memory.member);
  const [tall, setTall] = useState(false);
  const [saving, setSaving] = useState<{ source: LibrarySource; doc: TeamDoc } | null>(null);
  const [editingMon, setEditingMon] = useState<BoxRecord | null>(null);
  const [editingTeam, setEditingTeam] = useState<TeamRecord | null>(null);
  const [removingMember, setRemovingMember] = useState<{ team: TeamRecord; id: string } | null>(null);
  const navigate = useNavigate();
  const teamLabel = useTeamLabel(dex, lang);

  const setTab = (next: DockTab) => { memory.tab = next; setTabState(next); };
  const setFormat = (next: FormatId) => { memory.format = next; setFormatState(next); };
  const setBox = workspace.setCurrentBox;
  const setCell = (next: number) => { memory.cell = next; setCellState(next); };
  const setMember = (next: number | null) => { memory.member = next; setMemberState(next); };

  const boxes = state?.layout.boxes.length ?? 2;
  const shownBox = Math.min(box, boxes - 1);
  const byId = useMemo(() => state ? boxById(state) : new Map<string, BoxRecord>(), [state]);
  const activeRecord = state?.teams.find((team) => team.id === active?.id) ?? null;
  const activeDoc = activeRecord ? teamDocOf(activeRecord, byId) : null;
  const cellRecord = state?.box.find((record) => record.box === shownBox && record.slot === cell) ?? null;

  // The dock's selection, as the page would receive it.
  const monName = (value: TeamMemberDoc, nickname = "") => nickname || speciesLabel(value.species, dex, lang);
  const selectedMember = tab === "teams" && activeDoc && member !== null ? activeDoc.pokemon[member] ?? null : null;
  const payloads: Partial<Record<LibraryKind, LibraryPayload>> = {};
  if (tab === "teams" && activeDoc && activeRecord) {
    payloads.team = { kind: "team", doc: activeDoc, name: teamLabel(activeRecord.name, activeDoc).text };
    if (selectedMember) payloads.pokemon = { kind: "pokemon", member: selectedMember, name: monName(selectedMember) };
  }
  if (tab === "box" && state) {
    if (cellRecord) payloads.pokemon = { kind: "pokemon", member: cellRecord.member, name: monName(cellRecord.member, cellRecord.nickname) };
    if (state.box.length) payloads.box = { kind: "box", species: [...new Set(state.box.map((record) => record.member.species))] };
  }
  // The teams tab hands over whole teams only; one Pokémon goes from the box tab.
  const shownReceivers = receivers.filter((receiver) =>
    tab === "teams" ? receiver.kind === "team" : receiver.kind !== "team");

  const run = (receiver: AnyReceiver) => {
    const payload = payloads[receiver.kind];
    if (payload) deliver(receiver, payload);
  };

  // A page's own "save team" asked for this dock: open straight onto that source's save dialog.
  const { saveRequest, requestSave } = workspace;
  useEffect(() => {
    if (!saveRequest || !state) return;
    requestSave(null);
    const source = sources.find((candidate) => candidate.id === saveRequest);
    if (source) void keep(source);
  }, [saveRequest, state, sources, requestSave]);

  const keep = async (source: LibrarySource) => {
    if (!state) return;
    if (source.kind === "team") {
      const doc = source.read();
      if (!doc) { toast({ text: t("dock.nothingToKeep") }); return; }
      setSaving({ source, doc });
      return;
    }
    const value = source.read();
    if (!value) { toast({ text: t("dock.nothingToKeep") }); return; }
    const record = await addToBox(value, { origin: source.origin, snapshot }, { box: shownBox, slot: cell });
    if (!record) { toast({ text: t("lib.box.full") }); return; }
    setTab("box");
    setBox(record.box);
    setCell(record.slot);
    toast({
      text: fill(t("lib.box.added"), { name: monName(value) }),
      action: { label: t("lib.toast.undo"), run: () => void removeBoxRecord(record.id) },
    });
  };

  /** Delete a box Pokémon from the dock, with an undo, as the teams page does. */
  const deleteMon = useDeleteBoxRecord();

  const dragStart = (payload: LibraryPayload, text: string) => (event: DragEvent) => {
    dragData(event, payload, text);
    setDragging(payload.kind);
  };
  const dragEnd = () => setDragging(null);

  // A Pokémon dropped on a box cell: one from the library moves there, one from the page is kept
  // there (or in the next free cell after it).
  const dropMon = async (payload: Extract<LibraryPayload, { kind: "pokemon" }>, slot: number) => {
    setDragging(null);
    setCell(slot);
    if (payload.boxId) { await moveBoxRecord(payload.boxId, { box: shownBox, slot }); return; }
    const record = await addToBox(payload.member, { origin: "manual", snapshot }, { box: shownBox, slot });
    if (!record) { toast({ text: t("lib.box.full") }); return; }
    setCell(record.slot);
    toast({
      text: fill(t("lib.box.added"), { name: payload.name }),
      action: { label: t("lib.toast.undo"), run: () => void removeBoxRecord(record.id) },
    });
  };

  const mode = overlay ? " overlay" : " docked";
  return (
    <aside id="library-dock" className={`dock${mode}${tall ? " tall" : ""}`} aria-label={t("dock.title")}>
      <button type="button" className="dock-grab" aria-label={t(tall ? "dock.collapse" : "dock.expand")}
              onClick={() => setTall(!tall)} />
      <header className="dock-head">
        <SegmentedControl kind="tabs" idBase="dock-tab" value={tab} onChange={setTab} className="seg"
          ariaLabel={t("dock.title")}
          items={(["teams", "box"] as const).map((id) => ({ id, label: t(`dock.tab.${id}`) }))} />
        <span className="dock-head-end">
          <Link to="/teams" className="dock-icon" title={t("dock.openPage")} aria-label={t("dock.openPage")}>
            <IconExternalLink aria-hidden />
          </Link>
          <button type="button" className="dock-icon" title={t("common.close")} aria-label={t("common.close")}
                  onClick={() => setOpen(false)}>
            <IconX aria-hidden />
          </button>
        </span>
      </header>

      <div className="dock-body">
        {library === "unavailable" && <p className="notice lib-warn">{t("lib.unavailable")}</p>}
        {library === undefined && <p className="muted dock-note">{t("lib.loading")}</p>}
        {state && tab === "teams" && (
          <TeamsPane state={state} format={format} setFormat={setFormat} activeId={active?.id ?? null}
            member={member}
            onPick={(team) => { setActive(activeTeamOf(team)); setMember(null); }}
            onPickMember={(index) => setMember(member === index ? null : index)}
            dragStart={dragStart} dragEnd={dragEnd}
            onEditMon={setEditingMon} onRemoveMember={(team, id) => setRemovingMember({ team, id })}
            onEditTeam={setEditingTeam} onOpenTeam={(team) => navigate(`/teams?team=${team.id}`)} />
        )}
        {state && tab === "box" && (
          <BoxPane state={state} box={shownBox} cell={cell} setBox={setBox} setCell={setCell}
            dragStart={dragStart} dragEnd={dragEnd} onDropMon={(payload, slot) => void dropMon(payload, slot)}
            onEditMon={setEditingMon} onDeleteMon={(record) => void deleteMon(record)} />
        )}
      </div>

      <footer className="dock-actions">
        {shownReceivers.length > 0 && (
          <div className="dock-action-group">
            <span className="dock-action-title">{t("dock.toPage")}</span>
            <div className="dock-action-row">
              {shownReceivers.map((receiver) => {
                const ready = Boolean(payloads[receiver.kind]);
                return (
                  <button key={receiver.id} type="button" className="second-btn dock-btn fill" disabled={!ready}
                          title={ready ? undefined : t(receiver.kind === "team" ? "dock.needTeam" : "dock.needMon")}
                          onClick={() => run(receiver)}>
                    <IconFileImport aria-hidden />{receiver.label}
                  </button>
                );
              })}
            </div>
            <span className="dock-hint muted">{t("dock.dragHint")}</span>
          </div>
        )}
        {sources.length > 0 && (
          <div className="dock-action-group">
            <span className="dock-action-title">{t("dock.toLibrary")}</span>
            <div className="dock-action-row">
              {/* One Pokémon before whole teams, whatever order the page offered them in. */}
              {[...sources].sort((x, y) => Number(x.kind === "team") - Number(y.kind === "team")).map((source) => (
                <button key={source.id} type="button" className="primary-btn dock-btn save" disabled={!state}
                        onClick={() => void keep(source)}>
                  <IconDeviceFloppy aria-hidden />{source.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {shownReceivers.length === 0 && sources.length === 0 && (
          <p className="muted dock-note">{t("dock.nothingHere")}</p>
        )}
      </footer>

      {editingMon && <BoxRecordEditDialog record={editingMon} onClose={() => setEditingMon(null)} />}
      {removingMember && state && (
        <RemoveMemberDialog state={state} team={removingMember.team} id={removingMember.id}
          onClose={() => setRemovingMember(null)} />
      )}
      {editingTeam && (
        <EditDialog kind="team" initial={{ label: editingTeam.name, notes: editingTeam.notes, tags: editingTeam.tags }}
          placeholder={teamLabel("", teamDocOf(editingTeam, byId)).text}
          onSave={async (values) => {
            await updateTeam(editingTeam.id, { name: values.label, notes: values.notes, tags: values.tags });
          }}
          onClose={() => setEditingTeam(null)} />
      )}
      {saving && state && (
        <SaveTeamDialog state={state} doc={saving.doc} origin={saving.source.origin}
          onSaved={(id) => {
            // A team just kept from the page is the one the reader is working with.
            setFormat(saving.doc.format);
            setTab("teams");
            setActive({ id, format: saving.doc.format });
          }}
          onClose={() => setSaving(null)} />
      )}
    </aside>
  );
}

function TeamsPane({ state, format, setFormat, activeId, member, onPick, onPickMember, dragStart, dragEnd,
  onEditMon, onRemoveMember, onEditTeam, onOpenTeam }: {
  onEditMon: (record: BoxRecord) => void;
  onRemoveMember: (team: TeamRecord, id: string) => void;
  onEditTeam: (team: TeamRecord) => void;
  onOpenTeam: (team: TeamRecord) => void;
  state: LibraryState;
  format: FormatId;
  setFormat: (format: FormatId) => void;
  activeId: string | null;
  member: number | null;
  onPick: (team: LibraryState["teams"][number]) => void;
  onPickMember: (index: number) => void;
  dragStart: (payload: LibraryPayload, text: string) => (event: DragEvent) => void;
  dragEnd: () => void;
}) {
  const t = useLibraryT();
  const { lang } = useLang();
  const dex = useDexByName();
  const names = useNameMaps();
  const teamLabel = useTeamLabel(dex, lang);
  const byId = boxById(state);
  const slots = Array.from({ length: state.layout.teamSlots[format] }, (_, slot) =>
    state.teams.find((team) => team.format === format && team.slot === slot) ?? null);
  const used = (id: FormatId) => state.teams.filter((team) => team.format === id).length;
  return (
    <>
      <SegmentedControl kind="radio" value={format} onChange={setFormat} className="seg dock-format"
        ariaLabel={t("lib.formatPick")}
        items={(["single", "double"] as const).map((id) => ({
          id, label: <>{t(`format.${id}`)}<span className="lib-seg-count num">{used(id)}/{state.layout.teamSlots[id]}</span></>,
        }))} />
      {used(format) === 0 ? (
        <p className="muted dock-note">{fill(t("dock.noTeams"), { format: t(`format.${format}`) })}</p>
      ) : !state.teams.some((team) => team.id === activeId && team.format === format) ? (
        <p className="muted dock-note">{t("dock.pickTeam")}</p>
      ) : null}
      <ol className="dock-teams">
        {slots.map((team, slot) => {
          if (!team) {
            return (
              <li key={`free-${slot}`} className="dock-team-free">
                <span className="lib-slot-no num">{slot + 1}</span>
                <span className="muted">{t("lib.slot.empty")}</span>
              </li>
            );
          }
          const doc = teamDocOf(team, byId);
          const label = teamLabel(team.name, doc);
          const on = team.id === activeId;
          return (
            <li key={team.id} className={`dock-team${on ? " on" : ""}`}>
              <button type="button" className="dock-team-head" aria-pressed={on} draggable={Boolean(doc)}
                      onClick={() => onPick(team)}
                      onDragStart={doc ? dragStart({ kind: "team", doc, name: label.text }, formatTeamPlainText(doc)) : undefined}
                      onDragEnd={dragEnd}>
                <span className="lib-slot-no num">{slot + 1}</span>
                <span className="dock-team-main">
                  <span className={`dock-team-name${label.auto ? " auto" : ""}`}>{label.text}</span>
                  <SpriteRow species={doc?.pokemon.map((mon) => mon.species) ?? []} dex={dex} lang={lang}
                             className="lib-sprites dock-mini" />
                </span>
                {on && <span className="dock-badge">{t("lib.activeBadge")}</span>}
              </button>
              {on && doc && (
                <ul className="dock-members">
                  {doc.pokemon.map((mon, index) => {
                    const id = team.members.filter((candidate) => byId.has(candidate))[index];
                    const record = id ? byId.get(id) : undefined;
                    return (
                    <SetHover key={`${mon.species}-${index}`} as="li" mon={mon}>
                      <button type="button" className={`dock-member${member === index ? " on" : ""}`}
                              aria-pressed={member === index} draggable
                              onClick={() => onPickMember(index)}
                              onDragStart={dragStart({ kind: "pokemon", member: mon, name: speciesLabel(mon.species, dex, lang),
                                boxId: team.members.filter((id) => byId.has(id))[index] },
                                formatTeamPlainText({ format, pokemon: [mon] }))}
                              onDragEnd={dragEnd}>
                        <GameImage assetKey={`pokemon:${speciesSlug(mon.species, dex)}`} role="dense" alt="" />
                        <span className="dock-member-name">{speciesLabel(mon.species, dex, lang)}</span>
                        <span className="dock-member-sub muted">
                          {mon.item ? localName(names.item, mon.item, lang) : "—"}
                        </span>
                      </button>
                      {member === index && record && (
                        <>
                          <button type="button" className="dock-member-act edit" title={t("lib.act.editBuild")}
                                  aria-label={t("lib.act.editBuild")} onClick={() => onEditMon(record)}>
                            <IconPencil aria-hidden />
                          </button>
                          <button type="button" className="dock-member-act remove" title={t("lib.members.remove")}
                                  aria-label={t("lib.members.remove")} onClick={() => onRemoveMember(team, record.id)}>
                            <IconTrash aria-hidden />
                          </button>
                        </>
                      )}
                    </SetHover>
                    );
                  })}
                </ul>
              )}
              {on && (
                <div className="dock-row-actions">
                  <span className="dock-row-actions-end">
                    <button type="button" className="ghost-btn dock-btn" onClick={() => onEditTeam(team)}>
                      {t("lib.act.edit")}
                    </button>
                    <button type="button" className="ghost-btn dock-btn" onClick={() => onOpenTeam(team)}>
                      {t("dock.openPage")} →
                    </button>
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** A box Pokémon as the site's configuration card (the calculator's picker, the table heads). */
function boxCardOption(record: BoxRecord, runForm: string | null): BuildCardOption {
  const { member } = record;
  return {
    key: record.id, source: "custom", coverage: null, isModal: false,
    set: {
      species: member.species, runForm, ability: member.ability, item: member.item, nature: member.nature,
      moves: member.moves, sps: member.spread ?? null,
    },
  };
}

function BoxPane({ state, box, cell, setBox, setCell, dragStart, dragEnd, onDropMon, onEditMon, onDeleteMon }: {
  onEditMon: (record: BoxRecord) => void;
  onDeleteMon: (record: BoxRecord) => void;
  state: LibraryState;
  box: number;
  cell: number;
  setBox: (box: number) => void;
  setCell: (cell: number) => void;
  dragStart: (payload: LibraryPayload, text: string) => (event: DragEvent) => void;
  dragEnd: () => void;
  onDropMon: (payload: Extract<LibraryPayload, { kind: "pokemon" }>, slot: number) => void;
}) {
  const { dragging } = useLibraryWorkspace("dragging");
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const t = useLibraryT();
  const { lang } = useLang();
  const dex = useDexByName();
  const items = useItemsByName();
  const boxName = useBoxName();
  const defaultBoxName = useDefaultBoxName();
  const [renaming, setRenaming] = useState(false);
  const boxes = state.layout.boxes.length;
  const cells = boxCells(state.box, box);
  const picked = cells[cell] ?? null;
  // The Mega its stone makes it, so the card's stats and badge are the form it battles as.
  const megaOf = (record: BoxRecord) => {
    const form = record.member.item ? items.get(record.member.item)?.requiredBy?.[0] : undefined;
    return form && dex.get(form)?.baseSpecies === record.member.species ? form : null;
  };
  return (
    <>
      <div className="dock-box-head">
        <button type="button" className="dock-icon" aria-label={t("lib.box.prev")} disabled={boxes < 2}
                onClick={() => setBox((box - 1 + boxes) % boxes)}><IconChevronLeft aria-hidden /></button>
        <span className="dock-box-name">
          <b>{boxName(state.layout, box)}</b>
          <button type="button" className="dock-icon small" title={t("lib.box.rename")} aria-label={t("lib.box.rename")}
                  onClick={() => setRenaming(true)}><IconPencil aria-hidden /></button>
        </span>
        <span className="lib-box-used num">{cells.filter(Boolean).length}/{BOX_SLOTS}</span>
        <button type="button" className="dock-icon" aria-label={t("lib.box.next")} disabled={boxes < 2}
                onClick={() => setBox((box + 1) % boxes)}><IconChevronRight aria-hidden /></button>
      </div>
      {state.box.length === 0 && <p className="muted dock-note">{t("dock.emptyBox")}</p>}
      <div className="dock-grid" role="group" aria-label={boxName(state.layout, box)}
           style={{ ["--box-tint" as string]: boxTint(box) }}>
        {cells.map((record, slot) => {
          const name = record ? record.nickname || speciesLabel(record.member.species, dex, lang) : "";
          return (
            <SetHover key={slot} mon={record?.member ?? null}>
            <button type="button"
                    className={`lib-cell${record ? " filled" : " free"}${slot === cell ? " on" : ""}${dropSlot === slot ? " drop" : ""}`}
                    aria-label={record ? `${fill(t("lib.box.cell"), { n: slot + 1 })}: ${name}` : fill(t("lib.box.cellEmpty"), { n: slot + 1 })}
                    aria-pressed={slot === cell} draggable={Boolean(record)}
                    onClick={() => setCell(slot)}
                    onDragStart={record ? dragStart({ kind: "pokemon", member: record.member, name, boxId: record.id },
                      formatTeamPlainText({ format: "single", pokemon: [record.member] })) : undefined}
                    onDragEnd={() => { setDropSlot(null); dragEnd(); }}
                    onDragOver={(event) => {
                      if (dragging !== "pokemon") return;
                      event.preventDefault();
                      if (dropSlot !== slot) setDropSlot(slot);
                    }}
                    onDragLeave={() => setDropSlot((value) => value === slot ? null : value)}
                    onDrop={(event) => {
                      setDropSlot(null);
                      const raw = event.dataTransfer.getData(LIBRARY_MIME);
                      if (!raw) return;
                      event.preventDefault();
                      try {
                        const payload = JSON.parse(raw) as LibraryPayload;
                        if (payload.kind === "pokemon") onDropMon(payload, slot);
                      } catch { /* not a library payload */ }
                    }}>
              {record && <GameImage assetKey={`pokemon:${speciesSlug(record.member.species, dex)}`} role="dense" alt="" />}
            </button>
            </SetHover>
          );
        })}
      </div>
      {renaming && (
        <RenameBoxDialog initial={state.layout.boxes[box]?.name ?? ""} placeholder={defaultBoxName(box)}
          onSave={(value) => renameBox(box, value)} onClose={() => setRenaming(false)} />
      )}
      {picked && (
        <div className="build-card dock-card">
          <BuildSetSummary option={boxCardOption(picked, megaOf(picked))} index={picked.slot}
            title={picked.nickname || speciesLabel(picked.member.species, dex, lang)}
            corner={<>
              <button type="button" className="dock-icon small" title={t("lib.act.editBuild")}
                      aria-label={t("lib.act.editBuild")} onClick={() => onEditMon(picked)}>
                <IconPencil aria-hidden />
              </button>
              <button type="button" className="dock-icon small danger" title={t("lib.act.delete")}
                      aria-label={t("lib.act.delete")} onClick={() => onDeleteMon(picked)}>
                <IconTrash aria-hidden />
              </button>
            </>} />
        </div>
      )}
    </>
  );
}

/** Shows a Pokémon's build beside what it wraps while the pointer is over it. */
function SetHover({ mon, as = "span", children }: {
  mon: TeamMemberDoc | null;
  as?: "span" | "li";
  children: ReactNode;
}) {
  const { lang } = useLang();
  const dex = useDexByName();
  const { anchorRef: ref, open, handlers } = useHoverPreview<HTMLElement>();
  const Tag = as;
  return (
    <Tag ref={(node: HTMLElement | null) => { ref.current = node; }} className="set-hover"
         {...handlers}>
      {children}
      {open && mon && (
        <HoverSet anchorRef={ref} slug={speciesSlug(mon.species, dex)} label={speciesLabel(mon.species, dex, lang)}
                  mon={mon} lang={lang} side="left" />
      )}
    </Tag>
  );
}
