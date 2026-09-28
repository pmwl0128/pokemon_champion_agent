/** "My teams": a format's team slots in order, as the games list their battle teams. A taken slot
 * shows its six portraits, its name, where it came from and whether the rule has changed since, and
 * opens in place to the full party card and the actions that take the team elsewhere (diagnose,
 * calculator, metagame matrix) or manage it. An empty slot is where a pasted team goes. A slot opened
 * beyond the starting five can itself be deleted, team and all (its Pokémon stay in the box). */
import type { FormatId } from "@pokemon-champions/protocol";
import {
  IconArrowDown, IconArrowUp, IconClipboardText, IconCopy, IconEraser, IconPencil, IconPin, IconPinFilled,
  IconPlus, IconTrash, IconX,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { HintButton } from "../HintButton.tsx";
import { SegmentedControl } from "../SegmentedControl.tsx";
import { useToast } from "../Toast.tsx";
import { useDexByName } from "../../hooks.ts";
import { useLang } from "../../i18n.ts";
import { saveJson } from "../../lib/download.ts";
import { exportFileName, teamFile } from "../../lib/library/exchange.ts";
import { LIBRARY_START, TEAM_SLOT_STEP, type BoxRecord, type TeamRecord } from "../../lib/library/records.ts";
import {
  addToTeam, boxById, closeTeamSlot, duplicateTeam, moveTeam, openTeamSlots, removeTeam, restoreTeam, setTeamMembers,
  teamDocOf, updateTeam,
  type LibraryState,
} from "../../lib/library/repo.ts";
import { useLibraryWorkspace } from "../../lib/library/workspace.tsx";
import { stashCalcTeams, stashMatchupFill, teamToCalcMembers } from "../../lib/team.ts";
import { useRuntime } from "../../runtime/context.tsx";
import { TeamCard } from "../team/TeamCard.tsx";
import { BoxRecordEditDialog } from "./BoxRecordEditDialog.tsx";
import { BoxPicker } from "./BoxPicker.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RemoveMemberDialog } from "./RemoveMemberDialog.tsx";
import { EditDialog } from "./EditDialog.tsx";
import { fill, useLibraryT } from "./messages.ts";
import { PasteDialog, type PasteTarget } from "./PasteDialog.tsx";
import {
  activeTeamOf, formatDay, IconButton, SpriteRow, useActiveTeamSync, useRuleChange, useTeamLabel,
} from "./shared.tsx";

export function TeamShelf({ state, maxSlots, onDiagnose }: {
  state: LibraryState;
  /** The most team slots per format this browser may open. */
  maxSlots: number;
  /** Absent when this runtime cannot diagnose. */
  onDiagnose?: (team: unknown) => void;
}) {
  const t = useLibraryT();
  const { lang } = useLang();
  const { can } = useRuntime();
  const navigate = useNavigate();
  const toast = useToast();
  const dex = useDexByName();
  const teamLabel = useTeamLabel(dex, lang);
  const ruleChange = useRuleChange();
  const { active, setActive } = useLibraryWorkspace("active", "setActive");
  useActiveTeamSync(state);
  const [format, setFormat] = useState<FormatId>(active?.format ?? "single");
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<TeamRecord | null>(null);
  const [removing, setRemoving] = useState<{ team: TeamRecord; id: string } | null>(null);
  const [picking, setPicking] = useState<TeamRecord | null>(null);
  const [buildOf, setBuildOf] = useState<BoxRecord | null>(null);
  const [closing, setClosing] = useState<{ slot: number; name: string } | null>(null);
  const [params, setParams] = useSearchParams();

  // A link from the library dock names a team: show its format and open it.
  useEffect(() => {
    const id = params.get("team");
    if (!id) return;
    const team = state.teams.find((record) => record.id === id);
    if (team) { setFormat(team.format); setOpenId(team.id); }
    const updated = new URLSearchParams(params);
    updated.delete("team");
    setParams(updated, { replace: true });
  }, [params]);
  // A team's party as box ids, in order — the same order its card shows.
  const memberIds = (team: TeamRecord) => team.members.filter((id) => box.has(id));
  const [paste, setPaste] = useState<PasteTarget | null>(null);

  const box = boxById(state);
  const open = state.layout.teamSlots[format];
  const used = (id: FormatId) => state.teams.filter((team) => team.format === id).length;
  const slots = Array.from({ length: open }, (_, slot) =>
    state.teams.find((team) => team.format === format && team.slot === slot) ?? null);

  const remove = async (record: TeamRecord) => {
    const removed = await removeTeam(record.id);
    if (!removed) return;
    toast({
      text: fill(t("lib.toast.deleted"), { name: teamLabel(removed.name, teamDocOf(removed, box)).text }),
      action: {
        label: t("lib.toast.undo"),
        run: () => void restoreTeam(removed).then((ok) => { if (!ok) toast({ text: t("lib.toast.noSlot") }); }),
      },
    });
  };

  const closeSlot = async (slot: number) => {
    const layout = await closeTeamSlot(format, slot);
    if (layout) toast({ text: fill(t("lib.toast.slotDeleted"), { n: slot + 1 }) });
  };

  /** The slot's own delete, at the row's right end: only for a slot opened beyond the start, and
   * asked first when a team is in it. */
  const slotDelete = (slot: number, record: TeamRecord | null) => {
    const starting = slot < LIBRARY_START.teamSlots;
    const label = t(starting ? "lib.slot.deleteDefault" : "lib.slot.delete");
    return (
      <span className="lib-slot-delete" title={label}>
        <IconButton label={label} danger disabled={starting}
          onClick={() => {
            if (!record) { void closeSlot(slot); return; }
            setClosing({ slot, name: teamLabel(record.name, teamDocOf(record, box)).text });
          }}>
          <IconTrash />
        </IconButton>
      </span>
    );
  };

  const duplicate = async (record: TeamRecord) => {
    const copy = await duplicateTeam(record.id, (name) => fill(t("lib.copyName"), { name }));
    if (copy === "full") toast({ text: t("lib.toast.noSlot") });
    else if (copy) {
      setOpenId(copy.id);
      toast({ text: fill(t("lib.toast.duplicated"), { n: copy.slot + 1 }) });
    }
  };

  return (
    <section className="lib-shelf">
      <div className="lib-toolbar">
        <SegmentedControl kind="radio" value={format} onChange={setFormat} className="seg"
          ariaLabel={t("lib.formatPick")}
          items={(["single", "double"] as const).map((id) => ({
            id,
            label: <>{t(`format.${id}`)}<span className="lib-seg-count num">{used(id)}/{state.layout.teamSlots[id]}</span></>,
          }))} />
        {state.teams.length === 0 && <p className="lib-first-run muted">{t("lib.firstRun")}</p>}
        <span className="lib-toolbar-end">
          <button type="button" className="primary-btn lib-btn" onClick={() => setPaste({ mode: "team", format })}>
            <IconClipboardText aria-hidden />{t("lib.paste")}
          </button>
        </span>
      </div>

      {state.broken.teams.length > 0 && (
        <p className="notice lib-warn">{fill(t("lib.broken"), { n: state.broken.teams.length })}</p>
      )}

      <ol className="lib-teams">
        {slots.map((record, slot) => {
          const number = <span className="lib-slot-no num" aria-hidden>{slot + 1}</span>;
          if (!record) {
            return (
              <li key={`free-${slot}`} className="lib-slot-free">
                <button type="button" onClick={() => setPaste({ mode: "team", format, slot })}>
                  {number}
                  <span className="sr-only">{fill(t("lib.slot"), { n: slot + 1 })}</span>
                  <span className="lib-slot-free-label">{t("lib.slot.empty")}</span>
                  <span className="lib-slot-free-action"><IconClipboardText aria-hidden />{t("lib.slot.pasteHere")}</span>
                </button>
                {slotDelete(slot, null)}
              </li>
            );
          }
          const doc = teamDocOf(record, box);
          const expanded = openId === record.id;
          const label = teamLabel(record.name, doc);
          const changed = ruleChange(record.snapshot);
          const bodyId = `lib-team-${record.id}`;
          const current = active?.id === record.id;
          const manage = (
            <span className="lib-actions">
              {doc && (
                <IconButton label={t("lib.act.setActive")} pressed={current}
                            onClick={() => setActive(current ? null : activeTeamOf(record))}>
                  {current ? <IconPinFilled /> : <IconPin />}
                </IconButton>
              )}
              <IconButton label={t("lib.act.edit")} onClick={() => setEditing(record)}><IconPencil /></IconButton>
              {doc && (
                <IconButton label={t("lib.act.duplicate")} onClick={() => void duplicate(record)}><IconCopy /></IconButton>
              )}
              <IconButton label={t("lib.act.moveUp")} disabled={slot === 0}
                          onClick={() => void moveTeam(record.id, slot - 1)}><IconArrowUp /></IconButton>
              <IconButton label={t("lib.act.moveDown")} disabled={slot === open - 1}
                          onClick={() => void moveTeam(record.id, slot + 1)}><IconArrowDown /></IconButton>
              <IconButton label={t("lib.act.clear")} danger onClick={() => void remove(record)}><IconEraser /></IconButton>
            </span>
          );
          return (
            <li key={record.id} className={`lib-team${expanded ? " open" : ""}`}>
              <div className="lib-team-row">
              <button type="button" className="lib-team-head" aria-expanded={expanded} aria-controls={bodyId}
                      onClick={() => setOpenId(expanded ? null : record.id)}>
                {number}
                <span className="sr-only">{fill(t("lib.slot"), { n: slot + 1 })}</span>
                <SpriteRow species={doc?.pokemon.map((member) => member.species) ?? []} dex={dex} lang={lang} />
                <span className="lib-team-main">
                  <span className="lib-team-title">
                    <span className={`lib-team-name${label.auto ? " auto" : ""}`}>{label.text}</span>
                    {current && <span className="lib-current">{t("lib.activeBadge")}</span>}
                  </span>
                  <span className="lib-meta">
                    <span>{t(`lib.origin.${record.origin}`)}</span>
                    <span className="num">{fill(t("lib.updated"), { date: formatDay(record.updatedAt, lang) })}</span>
                    {changed && (
                      <span className="lib-rule-changed"
                            title={fill(t("lib.ruleChangedTip"), { saved: changed.saved, current: changed.current })}>
                        {t("lib.ruleChanged")}
                      </span>
                    )}
                  </span>
                </span>
                {record.tags.length > 0 && (
                  <span className="lib-tags">
                    {record.tags.map((tag) => <span key={tag} className="lib-tag">{tag}</span>)}
                  </span>
                )}
                <span className="lib-chevron" aria-hidden />
              </button>
              {slotDelete(slot, record)}
              </div>
              {expanded && (
                <div className="lib-team-body" id={bodyId}>
                  {record.notes && <p className="lib-notes">{record.notes}</p>}
                  {!doc && <p className="lib-notes muted">{t("lib.team.noMembersBody")}</p>}
                  {/* Left: managing this team (beside the card's own export menu); right: where the
                      team goes next — the same places, labels and hints as the builder's and the
                      diagnosis's result cards. The party itself is edited in place: × takes a
                      Pokémon out, + adds one from the boxes, dragging reorders. */}
                  <TeamCard team={doc ?? { format: record.format, pokemon: [] }} badges={manage}
                    memberCorner={(index) => (
                      <span className="party-corner-actions">
                        <button type="button" className="party-edit" title={t("lib.act.editBuild")}
                                aria-label={t("lib.act.editBuild")}
                                onClick={() => setBuildOf(box.get(memberIds(record)[index]!) ?? null)}>
                          <IconPencil aria-hidden />
                        </button>
                        <button type="button" className="party-remove" title={t("lib.members.remove")}
                                aria-label={t("lib.members.remove")}
                                onClick={() => setRemoving({ team: record, id: memberIds(record)[index]! })}>
                          <IconX aria-hidden />
                        </button>
                      </span>
                    )}
                    onReorder={(from, to) => {
                      const ids = memberIds(record);
                      const [moved] = ids.splice(from, 1);
                      ids.splice(to, 0, moved!);
                      void setTeamMembers(record.id, ids);
                    }}
                    addSlot={{ label: t("lib.members.add"), onAdd: () => setPicking(record) }}
                    extraExport={doc ? {
                      label: t("lib.act.file"), hint: t("lib.act.fileHint"),
                      run: () => saveJson(teamFile(state, record), exportFileName("team")),
                    } : undefined}
                    actions={doc && <>
                      {onDiagnose && (
                        <button type="button" className="second-btn" onClick={() => onDiagnose(doc)}>
                          {t("builder.sendDiagnose")}
                        </button>
                      )}
                      {can("calc.damage") && (
                        <HintButton hint={t("team.sendCalcHint")} onClick={() => {
                          stashCalcTeams({ format, attackers: teamToCalcMembers(doc), defenders: [] });
                          navigate("/calc?tab=damage");
                        }}>
                          {t("team.sendCalc")}
                        </HintButton>
                      )}
                      {can("team.matchup") && (
                        <HintButton hint={t("actual.sendMatchupHint")} onClick={() => {
                          stashMatchupFill({ source: "other", label: label.text, format, team: doc });
                          navigate("/matchup?mode=actual");
                        }}>
                          {t("actual.sendMatchup")}
                        </HintButton>
                      )}
                    </>} />
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {open < maxSlots && (
        <button type="button" className="second-btn lib-btn lib-more" onClick={() => void openTeamSlots(format, maxSlots)}>
          <IconPlus aria-hidden />{fill(t("lib.slot.more"), { n: Math.min(TEAM_SLOT_STEP, maxSlots - open) })}
        </button>
      )}

      {buildOf && <BoxRecordEditDialog record={buildOf} onClose={() => setBuildOf(null)} />}
      {closing && (
        <ConfirmDialog title={fill(t("lib.slot.deleteTitle"), { n: closing.slot + 1 })}
          body={fill(t("lib.slot.deleteBody"), { n: closing.slot + 1, name: closing.name })}
          confirm={t("lib.slot.delete")} onConfirm={() => closeSlot(closing.slot)} onClose={() => setClosing(null)} />
      )}
      {removing && (
        <RemoveMemberDialog state={state} team={removing.team} id={removing.id} onClose={() => setRemoving(null)} />
      )}
      {picking && (
        <BoxPicker state={state} blocked={new Set(picking.members)} onClose={() => setPicking(null)}
          onPick={(picked) => void addToTeam(picking.id, picked.id).then((result) => {
            if (!result.ok) toast({ text: t(result.reason === "full" ? "lib.toast.teamFull" : "lib.toast.alreadyIn") });
          })} />
      )}
      {editing && (
        <EditDialog kind="team" initial={{ label: editing.name, notes: editing.notes, tags: editing.tags }}
          placeholder={teamLabel("", teamDocOf(editing, box)).text}
          onSave={async (values) => {
            await updateTeam(editing.id, { name: values.label, notes: values.notes, tags: values.tags });
          }}
          onClose={() => setEditing(null)} />
      )}
      {paste && (
        <PasteDialog state={state} target={paste}
          onSaved={(id, saved) => { setFormat(saved); setOpenId(id); }}
          onClose={() => setPaste(null)} />
      )}
    </section>
  );
}
