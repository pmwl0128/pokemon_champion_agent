/** One combatant's full editable build: species + forme, ability, nature, item, status, the SP /
 * boost / final-stat table, current HP, and the four move slots.
 *
 * The stat table shows base, investment and RESULT side by side because that is the number the calc
 * actually used — a spread that reads "32 Spe" tells you nothing about whether it clears a
 * benchmark, and re-deriving it in your head is exactly the arithmetic this page exists to remove. */
import type { LearnsetDto, NatureDto } from "@pokemon-champions/protocol";
import { STAT_KEYS } from "@pokemon-champions/protocol";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { AdaptiveCombobox } from "../../../components/AdaptiveCombobox.tsx";
import {
  BuildPicker, BuildSetSummary, type BuildCardOption,
} from "../../../components/BuildPicker.tsx";
import { EntityHover } from "../../../components/EntityHover.tsx";
import { GameImage } from "../../../components/GameImage.tsx";
import { PLACEHOLDERS } from "../../../assets/icons.ts";
import { TypeBadge } from "../../../components/TypeBadge.tsx";
import { displayName, useLang, useT } from "../../../i18n.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import {
  ItemCombo, MonPicker, STATUSES, boostLabel, clampNum, megaFor, natureLabel,
  buildConfigSig, spSum, spSumClass, type BuildOption,
} from "../shared.tsx";
import {
  ABILITY_NEEDS_TRIGGER, MOVE_SLOTS, boostedStat, curHPOf, effectiveEntry, finalStat, makeMon,
  maxHPOf, type MonState,
} from "./state.ts";

/** A learnset-restricted move input: typing resolves against this mon's own legal moves in any of
 * the three languages, so a slot can never hold a move the calc would reject. */
function MoveSlot({ value, onChange, learnset, index }: {
  value: string;
  onChange: (name: string) => void;
  learnset: LearnsetDto | null;
  index: number;
}) {
  const { lang } = useLang();
  const t = useT();
  const [text, setText] = useState("");
  const moves = learnset?.moves ?? [];

  useEffect(() => {
    const hit = moves.find((m) => m.name === value);
    setText(hit ? displayName(hit, lang) : value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, lang, moves.length]);

  const options = useMemo(() => moves.map((m) => ({
    key: m.name,
    value: displayName(m, lang),
    secondary: `${m.type}${m.power != null ? ` · ${m.power}` : ""}`,
  })), [moves, lang]);

  const resolve = (raw: string): string | null => {
    const q = raw.trim();
    if (!q) return "";
    const lower = q.toLowerCase();
    const exact = moves.find((m) => m.name.toLowerCase() === lower
      || m.nameZh === q || m.nameJa === q || displayName(m, lang).toLowerCase() === lower);
    if (exact) return exact.name;
    const part = moves.find((m) => m.name.toLowerCase().includes(lower)
      || (m.nameZh ?? "").includes(q) || (m.nameJa ?? "").includes(q));
    return part ? part.name : null;
  };

  const current = moves.find((m) => m.name === value);
  return (
    <div className="move-slot">
      <span className="move-slot-mark">
        {current ? <TypeBadge type={current.type} iconOnly /> : <span className="move-slot-dot" />}
      </span>
      <AdaptiveCombobox value={text} options={options}
        placeholder={`${t("calc.move")} ${index + 1}`}
        onValueChange={(next) => {
          setText(next);
          const hit = resolve(next);
          if (hit !== null && (hit === "" || moves.some((m) => m.name === hit
            && displayName(m, lang) === next.trim()))) onChange(hit);
        }}
        onCommit={(raw) => {
          const hit = resolve(raw);
          if (hit !== null) onChange(hit);
          else setText(current ? displayName(current, lang) : "");
        }} />
    </div>
  );
}

export function MonEditor({
  label, mon, setMon, dex, natures, items, learnset, loadSetOptions, onSetPick, onExport,
}: {
  label: string;
  mon: MonState;
  setMon: Dispatch<SetStateAction<MonState>>;
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  learnset: LearnsetDto | null;
  loadSetOptions: () => Promise<BuildOption[]>;
  onSetPick: (set: BuildOption, index: number) => void;
  onExport: () => void;
}) {
  const { lang } = useLang();
  const t = useT();
  const literal = dex.find((e) => e.slug === mon.slug);
  const mega = literal?.isMega ? literal : megaFor(mon.slug, mon.item, dex, items);
  const entry = effectiveEntry(mon, dex, items);
  // The stone is what activates a Mega, so a base species holding one IS that Mega for every number
  // on the page. The forme control and the item lock therefore key off the EFFECTIVE form, not the
  // literal pick — otherwise the card computes Mega Garchomp Z while its own fields still read
  // "Garchomp / no forme / editable item", which is three claims the result contradicts.
  const requiredStone = mega
    ? items.find((i) => i.requiredBy?.includes(mega.name)) : undefined;

  // A Mega form picked BY NAME requires its stone — pin the item and lock the input.
  useEffect(() => {
    if (requiredStone && mon.item !== requiredStone.name) {
      setMon((s) => ({ ...s, item: requiredStone.name }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredStone?.name, mon.slug]);

  // The ability selector must describe the form the engine will calculate, so a stone swap or an
  // explicit Mega pick replaces an incompatible base ability immediately rather than relying on an
  // invisible request-time correction.
  useEffect(() => {
    if (mega && !mega.abilities.some((a) => a.name === mon.ability)) {
      setMon((s) => ({ ...s, ability: mega.abilities[0]?.name ?? "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mega?.slug, mon.item]);

  // Forme picker: the base species plus every Mega form the dex lists for it. Derived from the
  // browse index that is already loaded — a forme switch must not cost a round trip.
  const baseName = entry?.isMega ? entry.baseSpecies : entry?.name;
  const formes = useMemo(() => {
    if (!baseName) return [];
    const base = dex.find((e) => e.name === baseName && !e.isMega);
    const megas = dex.filter((e) => e.isMega && e.baseSpecies === baseName);
    return megas.length && base ? [base, ...megas] : [];
  }, [dex, baseName]);

  /** Which way this mon's nature bends a stat — "" when it does not touch it. */
  const nature = natures.find((n) => n.name === mon.nature);
  const natureTone = (key: string) =>
    (nature?.upStat === key && nature.downStat !== key ? "up"
      : nature?.downStat === key && nature.upStat !== key ? "down" : "");

  const [exported, setExported] = useState(false);
  const maxHP = maxHPOf(mon, dex, items);
  const curHP = curHPOf(mon, maxHP);
  const spTotal = spSum(mon.sps);
  const needsTrigger = !!mon.ability && ABILITY_NEEDS_TRIGGER.has(mon.ability);
  const setButtonRef = useRef<HTMLButtonElement>(null);
  const requestSeq = useRef(0);
  const [setPickerOpen, setSetPickerOpen] = useState(false);
  const [setPickerBusy, setSetPickerBusy] = useState(false);
  const [setOptions, setSetOptions] = useState<BuildOption[]>([]);

  useEffect(() => {
    requestSeq.current += 1;
    setSetPickerOpen(false);
    setSetOptions([]);
    setSetPickerBusy(false);
  }, [mon.slug]);

  const openSetPicker = () => {
    if (setPickerOpen) { setSetPickerOpen(false); return; }
    setSetPickerOpen(true);
    setSetPickerBusy(true);
    const seq = ++requestSeq.current;
    void loadSetOptions().then((next) => {
      if (requestSeq.current === seq) setSetOptions(next);
    }).finally(() => {
      if (requestSeq.current === seq) setSetPickerBusy(false);
    });
  };
  const currentBuildSig = buildConfigSig(mon);
  const matchedSet = setOptions.find((option) => buildConfigSig(option.modal) === currentBuildSig);
  const matchedSetIndex = matchedSet ? setOptions.indexOf(matchedSet) : -1;
  const currentSetKey = matchedSet?.key;

  // A manually entered build can still be an exact environment card. Once the picker has loaded
  // enough facts to prove that identity, retain it for the compact hover cards; any later field edit
  // changes the signature and the display automatically falls back to "custom".
  useEffect(() => {
    if (!matchedSet) return;
    const buildRef = {
      key: matchedSet.key,
      source: matchedSet.source,
      coverage: matchedSet.coverage,
      isModal: matchedSet.isModal,
      labelIndex: Math.max(0, matchedSetIndex),
      signature: currentBuildSig,
    };
    setMon((current) => buildConfigSig(current) === currentBuildSig
      && (current.buildRef?.key !== buildRef.key
        || current.buildRef.source !== buildRef.source
        || current.buildRef.coverage !== buildRef.coverage
        || current.buildRef.isModal !== buildRef.isModal
        || current.buildRef.labelIndex !== buildRef.labelIndex
        || current.buildRef.signature !== buildRef.signature)
      ? { ...current, buildRef } : current);
  }, [currentBuildSig, matchedSet?.key, matchedSetIndex, setMon]);

  const editorActions = (
    <span className="mon-editor-actions">
      <button ref={setButtonRef} className="ghost-btn tiny" onClick={openSetPicker}
        disabled={!mon.slug} aria-expanded={setPickerOpen}
        title={t("calc.metaSetHint")}>{t("calc.metaSet")}</button>
      {setPickerOpen && (
        <BuildPicker options={setOptions} currentKey={currentSetKey}
          anchorRef={setButtonRef} busy={setPickerBusy}
          hint={t("calc.setPickHint")}
          onPick={(option) => {
            const picked = setOptions.find((candidate) => candidate.key === option.key);
            if (picked) onSetPick(picked, setOptions.indexOf(picked));
          }}
          onClose={() => setSetPickerOpen(false)} />
      )}
      <button className="ghost-btn tiny" disabled={!mon.slug}
        onClick={() => {
          onExport();
          setExported(true);
          window.setTimeout(() => setExported(false), 1600);
        }}>
        {exported ? t("calc.copied") : t("calc.exportMon")}
      </button>
    </span>
  );

  return (
    <section className="panel mon-editor">
      <div className="mon-editor-id">
        <div className="mon-editor-art">
          {entry
            ? <GameImage assetKey={entry.key} role="dense" alt={displayName(entry, lang)}
                className="mon-editor-sprite" />
            : <img className="mon-editor-sprite" src={PLACEHOLDERS.pokemon} alt="" aria-hidden />}
        </div>
        <div className="mon-editor-idfields">
          {/* Species and forme are one identity, so they sit on one row when both exist — a forme
              select stacked underneath would push the card taller than its partner across the page. */}
          <div className={`mon-editor-namerow${formes.length ? " split" : ""}`}>
          <div className="mon-editor-namefield">
            <span className="mon-editor-label-line">
              <span>{t("calc.name")}</span>
              <span className="mon-editor-types">
                {(entry?.types ?? []).map((ty) => <TypeBadge key={ty} type={ty} />)}
              </span>
              {!formes.length && editorActions}
            </span>
            <MonPicker idKey={label} slug={mon.slug} dex={dex}
              ariaLabel={t("calc.name")}
              onSlug={(slug) => setMon((s) => (s.slug === slug ? s : makeMon(slug)))} />
          </div>
          {formes.length > 0 && (
            <div className="mon-editor-namefield">
              <span className="mon-editor-form-heading">
                {t("calc.forme")}
                {mega && <span className="mega-badge" title={displayName(mega, lang)}>MEGA</span>}
                {editorActions}
              </span>
              <select value={entry?.slug ?? ""} aria-label={t("calc.forme")}
                onChange={(e) => {
                  const next = dex.find((x) => x.slug === e.target.value);
                  // A forme switch keeps the build — only the species changes. Dropping back to the
                  // base must also drop the stone, or the held item would silently re-Mega it and
                  // the picker would disagree with the numbers.
                  const dropStone = next && !next.isMega
                    && items.some((i) => i.name === mon.item && i.requiredBy?.length);
                  // A Mega picked here is stored as the Mega species; its stone is pinned by the
                  // effect above, so the two controls can never disagree again.
                  setMon((s) => ({ ...s, slug: e.target.value, ...(dropStone ? { item: "" } : {}) }));
                }}>
                {formes.map((f) => (
                  <option key={f.slug} value={f.slug}>{displayName(f, lang)}</option>
                ))}
              </select>
            </div>
          )}
          </div>
        </div>
      </div>

      <div className="mon-build-row">
        <label>{t("calc.ability")}
          <select value={mon.ability}
            onChange={(e) => setMon((s) => ({ ...s, ability: e.target.value, abilityOn: null }))}>
            <option value="">—</option>
            {(mega ?? literal)?.abilities.map((a) => (
              <option key={a.name} value={a.name}>{displayName(a, lang)}</option>
            ))}
          </select>
        </label>
        <label>{t("calc.nature")}
          <select value={mon.nature}
            onChange={(e) => setMon((s) => ({ ...s, nature: e.target.value }))}>
            <option value="">—</option>
            {natures.map((n) => <option key={n.name} value={n.name}>{natureLabel(n, lang)}</option>)}
          </select>
        </label>
        <label>{t("calc.item")}
          <ItemCombo idKey={label} value={mon.item} items={items} disabled={!!requiredStone}
            onChange={(item) => setMon((s) => ({ ...s, item }))} />
        </label>
        <label>{t("calc.status")}
          <select value={mon.status}
            onChange={(e) => setMon((s) => ({ ...s, status: e.target.value }))}>
            {STATUSES.map((st) => (
              <option key={st} value={st === "Healthy" ? "" : st}>{t(`status.${st}`)}</option>
            ))}
          </select>
        </label>
      </div>

      {needsTrigger && (
        <label className="inline-check" title={t("calc.abilityOnHint")}>
          <input type="checkbox" checked={mon.abilityOn === true}
            onChange={(e) => setMon((s) => ({ ...s, abilityOn: e.target.checked ? true : null }))} />
          <span>{t("calc.abilityOn")}</span>
        </label>
      )}

      <div className="stat-table">
        <div className="stat-table-head">
          <span>{t("calc.stat")}</span>
          <span>{t("calc.base")}</span>
          <span className="stat-head-sp">SP
            <span className={`sp-sum num ${spSumClass(spTotal)}`}>{spTotal}/66</span>
          </span>
          <span>{t("calc.boosts")}</span>
          <span>{t("calc.final")}</span>
          <span>{t("calc.current")}</span>
        </div>
        {STAT_KEYS.map((key) => (
          <div className="stat-table-row" key={key}>
            <span className="stat-name">{key.toUpperCase()}</span>
            <span className="num muted">{entry?.stats[key] ?? "—"}</span>
            <input type="number" min={0} max={32} step={1} className="num"
              value={mon.sps[key] ?? 0} aria-label={`${key} SP`}
              onChange={(e) => setMon((s) => ({
                ...s, sps: { ...s.sps, [key]: clampNum(e.target.value, 0, 32) },
              }))} />
            {key === "hp"
              ? (() => {
                  // HP's "boost" cell holds the damage taken so far instead: current HP is a
                  // quantity of exactly this stat, so it belongs on this row rather than in a
                  // separate block that repeats the same maximum underneath.
                  const pct = maxHP > 0 ? Math.round((curHP / maxHP) * 100) : 0;
                  const tone = pct > 50 ? "ok" : pct > 20 ? "warn" : "low";
                  return (
                    <span className={`boost-slider hp ${tone}`}>
                      <span className="boost-lane">
                        <span className="boost-track" aria-hidden
                          style={{ ["--fill-left" as string]: "0%",
                                   ["--fill-width" as string]: `${pct}%` }} />
                        <input type="range" min={1} max={Math.max(1, maxHP)} step={1}
                          value={curHP} disabled={!maxHP} aria-label={t("calc.curHP")}
                          onChange={(e) => setMon((s) => ({ ...s, curHP: Number(e.target.value) }))} />
                      </span>
                      <span className="boost-read num">{pct}%</span>
                    </span>
                  );
                })()
              : (() => {
                  const stage = mon.boosts[key as "atk"] ?? 0;
                  const half = (Math.abs(stage) / 6) * 50;
                  return (
                    <span className={`boost-slider ${stage > 0 ? "up" : stage < 0 ? "down" : "flat"}`}>
                      <span className="boost-lane">
                        {/* Own track, filled from the CENTRE: the native one fills from the left,
                            so a neutral 0 looked like a drop. */}
                        <span className="boost-track" aria-hidden
                          style={{ ["--fill-left" as string]: stage < 0 ? `${50 - half}%` : "50%",
                                   ["--fill-width" as string]: `${half}%` }} />
                        <input type="range" min={-6} max={6} step={1} value={stage}
                          aria-label={`${key} boost`}
                          onChange={(e) => setMon((s) => ({
                            ...s, boosts: { ...s.boosts, [key]: Number(e.target.value) },
                          }))} />
                      </span>
                      <span className="boost-read num">{boostLabel(stage)}</span>
                    </span>
                  );
                })()}
            {/* The stat value is what the BUILD computes to, and it says why it is that number:
                which way the nature bent it, and whether the investment is already at the 32-point
                ceiling. HP's is the maximum — a plain fact about the build, like every other row. */}
            <span className={`num stat-final ${key === "hp" ? "" : natureTone(key)}`
              + ((mon.sps[key] ?? 0) >= 32 ? " maxed" : "")}>
              {(key === "hp" ? maxHP : finalStat(mon, entry, natures, key)) || "—"}
            </span>
            {/* The current value is what the mon is playing at RIGHT NOW: for HP a quantity that
                only the reader knows (so it is the one editable cell), for everything else the
                build's value put through its boost stage. Coloured by the STAGE, not the nature —
                this column answers "what did the battle do to it", which is a different question
                from the one the column beside it answers. */}
            {key === "hp"
              ? <input type="number" className="num stat-cur hp-cur"
                  min={1} max={Math.max(1, maxHP)} value={curHP} disabled={!maxHP}
                  aria-label={t("calc.curHP")} title={`${t("calc.curHP")} / ${maxHP}`}
                  onChange={(e) => setMon((s) => ({
                    ...s, curHP: clampNum(e.target.value, 1, Math.max(1, maxHP)),
                  }))} />
              : (() => {
                  const stage = mon.boosts[key as "atk"] ?? 0;
                  const value = finalStat(mon, entry, natures, key);
                  return (
                    <span className={`num stat-cur${stage > 0 ? " up" : stage < 0 ? " down" : ""}`}>
                      {value ? boostedStat(value, stage) : "—"}
                    </span>
                  );
                })()}
          </div>
        ))}
      </div>

      <div className="move-slots">
        <span className="mon-editor-cap">{t("calc.moveSlots")}</span>
        {Array.from({ length: MOVE_SLOTS }, (_, i) => (
          <MoveSlot key={i} index={i} learnset={learnset} value={mon.moves[i] ?? ""}
            onChange={(name) => setMon((s) => {
              const moves = [...s.moves];
              while (moves.length < MOVE_SLOTS) moves.push("");
              moves[i] = name;
              return { ...s, moves };
            })} />
        ))}
        {learnset && learnset.moves.length === 0 && (
          <span className="muted">{t("calc.noMoves")}</span>
        )}
      </div>
    </section>
  );
}

/** Compact-card identity for a live calculator mon. Environment provenance is shown only while the
 * current item/ability/nature/SP/moves still match the applied card exactly. */
export function buildCardOptionForMon(
  mon: MonState, entry: DexIndexEntry, dex: DexIndexEntry[],
): BuildCardOption {
  const literal = dex.find((candidate) => candidate.slug === mon.slug);
  const signature = buildConfigSig(mon);
  const source = mon.buildRef?.signature === signature ? mon.buildRef : null;
  return {
    key: source?.key ?? `custom:${entry.slug}`,
    source: source?.source ?? "custom",
    coverage: source?.coverage ?? null,
    isModal: source?.isModal ?? false,
    labelIndex: source?.labelIndex,
    set: {
      species: literal?.isMega ? literal.baseSpecies ?? entry.name : literal?.name ?? entry.name,
      runForm: entry.name,
      ability: mon.ability || null,
      item: mon.item || null,
      nature: mon.nature || null,
      moves: [...mon.moves.filter(Boolean)],
      sps: { ...mon.sps },
    },
  };
}

/** Small read-only echo of a mon, used by the team strips. */
export function MonAvatar({ mon, dex, items, active, onClick, onRemove, title }: {
  mon: MonState;
  dex: DexIndexEntry[];
  items: ItemRef[];
  active: boolean;
  onClick: () => void;
  onRemove?: () => void;
  title?: string;
}) {
  const { lang } = useLang();
  const t = useT();
  const entry = effectiveEntry(mon, dex, items);
  const name = entry ? displayName(entry, lang) : t("calc.emptySlot");
  const hasBuild = !!entry && !!(mon.ability || mon.item || mon.nature
    || Object.values(mon.sps).some((value) => (value ?? 0) > 0) || mon.moves.some(Boolean));
  const preview = hasBuild && entry ? buildCardOptionForMon(mon, entry, dex) : null;
  const image = entry
    ? <GameImage assetKey={entry.key} role="dense" alt={name} className="mini" />
    : <img className="mini team-chip-empty" src={PLACEHOLDERS.pokemon} alt="" aria-hidden />;
  return (
    <span className={`team-chip${active ? " on" : ""}`}>
      <button type="button" className="team-chip-btn" onClick={onClick}
        aria-pressed={active} title={title ?? name}>
        {preview
          ? <EntityHover kind="spread" name="" link={false} passive
              previewAddon={<BuildSetSummary option={preview} index={0} />}>{image}</EntityHover>
          : image}
      </button>
      {onRemove && (
        <button type="button" className="team-chip-x" onClick={onRemove}
          aria-label={`${t("a11y.remove")} ${name}`}>✕</button>
      )}
    </span>
  );
}
