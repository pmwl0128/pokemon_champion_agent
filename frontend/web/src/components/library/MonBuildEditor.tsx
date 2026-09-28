/** Editing one box Pokémon's build, with the calculator's own inputs (item combobox, move slots,
 * species and forme row, environment build picker), so a build is entered the same way everywhere.
 *
 * Two layouts. The dialog one (the library dock, a team card) is compact; the panel one (the box
 * page's detail) spreads out: the Pokémon's art on its type colours, the build, and beside the moves
 * a stat table — base stat, SP, and the Lv.50 value that comes out of them. The environment picker
 * offers singles and doubles builds together: a box Pokémon belongs to neither format.
 *
 * `full` adds species and forme and the environment picker. The editor only reports changes; the
 * caller decides when they are saved. */
import "../../styles.mbe.css";
import { STAT_KEYS, type FormatId, type NatureDto, type StatKey, type TeamMemberDoc } from "@pokemon-champions/protocol";
import type { CSSProperties, ReactNode } from "react";
import { GameImage } from "../GameImage.tsx";
import { typeColor, PLACEHOLDERS } from "../../assets/icons.ts";
import { useAsync, useDexIndex, useItems, useNatures } from "../../hooks.ts";
import { displayName, useLang, useT, type MsgKey } from "../../i18n.ts";
import { actualStat, natureMultiplier } from "../../lib/stats.ts";
import { loadLearnset } from "../../runtime/projection.ts";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import { MonNameRow, MonPortrait } from "../build/MonIdentity.tsx";
import { MoveSlot } from "../build/MoveCell.tsx";
import {
  BuildPickerButton, clampNum, ItemCombo, megaFor, NatureOptions, spSum, spSumClass, type BuildOption,
} from "../build/inputs.tsx";
import { useMetaUsage } from "../../lib/metaUsage.ts";
import { useLibraryT } from "./messages.ts";

import { MOVE_SLOTS } from "../../lib/battle.ts";
const BOTH_FORMATS: readonly FormatId[] = ["single", "double"];
const BASE_SCALE = 200;
const NO_NATURES: readonly NatureDto[] = [];

/** The dex's base-stat colours (the detail pages' stat panel), so a stat reads the same everywhere. */
function baseColor(value: number): string {
  if (value >= 130) return "#3FA129";
  if (value >= 100) return "#91A119";
  if (value >= 70) return "#FAC000";
  return "#FF8000";
}

const STAT_SHORT: Record<StatKey, string> = { hp: "HP", atk: "ATK", def: "DEF", spa: "SPA", spd: "SPD", spe: "SPE" };

/** Base stat, SP and the resulting Lv.50 value for each stat, with the base-stat total and the SP
 * budget underneath. The SP inputs are the build's; everything else follows from them. */
function BuildStats({ entry, nature, spread, onSp }: {
  entry: DexIndexEntry | undefined;
  nature: { upStat: StatKey | null; downStat: StatKey | null } | undefined;
  spread: Partial<Record<StatKey, number>>;
  onSp: (key: StatKey, value: number) => void;
}) {
  const t = useT();
  const lt = useLibraryT();
  const multOf = (key: StatKey) => natureMultiplier(nature, key);
  const rows = STAT_KEYS.map((key) => {
    const base = entry?.stats[key] ?? 0;
    const sp = spread[key] ?? 0;
    return { key, base, sp, mult: multOf(key), value: entry ? actualStat(base, key, sp, multOf(key)) : 0 };
  });
  const top = Math.max(1, ...rows.map((row) => row.value)) / 0.92;
  const total = spSum(spread);
  const bst = rows.reduce((sum, row) => sum + row.base, 0);
  return (
    <div className="mbe-stats">
      <div className="mbe-stats-head">
        <span />
        <span className="l">{lt("lib.stats.base")}</span>
        <span className="c">SP</span>
        <span className="r">{lt("lib.stats.actual")}</span>
      </div>
      {rows.map(({ key, base, sp, mult, value }) => (
        <div key={key} className={`mbe-stat${mult > 1 ? " up" : mult < 1 ? " down" : ""}`}>
          <span className="k" title={t(`stat.${key}` as MsgKey)}>{STAT_SHORT[key]}</span>
          <span className="bv num">{base || "—"}</span>
          <span className="track base">
            <span className="fill" style={{ width: `${Math.min(100, (base / BASE_SCALE) * 100)}%`, background: baseColor(base) }} />
          </span>
          <input type="number" min={0} max={32} step={1} className="num" value={sp} aria-label={`${t(`stat.${key}` as MsgKey)} SP`}
                 onChange={(event) => onSp(key, clampNum(event.target.value, 0, 32))} />
          <span className="track actual">
            <span className="fill" style={{ width: `${Math.min(100, (value / top) * 100)}%` }} />
          </span>
          <span className="av num">{value || "—"}{mult > 1 ? "↑" : mult < 1 ? "↓" : ""}</span>
        </div>
      ))}
      <div className="mbe-stats-foot">
        <span>{lt("lib.stats.total")} <b className="num">{bst || "—"}</b></span>
        <span>SP <b className={`sp-sum num ${spSumClass(total)}`}>{total}/66</b></span>
      </div>
    </div>
  );
}

export function MonBuildEditor({ value, onChange, layout = "dialog", beside, formats = BOTH_FORMATS }: {
  value: TeamMemberDoc;
  onChange: (next: TeamMemberDoc) => void;
  /** Species and forme, and the environment build picker. */
  /** `panel`: the box page's spread-out detail; `dialog`: compact. */
  layout?: "dialog" | "panel";
  /** Panel only: the caller's own fields, under the moves and beside the stats. */
  beside?: ReactNode;
  /** Whose environment builds the picker offers: both for a box Pokémon, the page's own elsewhere. */
  formats?: readonly FormatId[];
}) {
  const t = useT();
  const { lang } = useLang();
  const dex = useDexIndex();
  const items = useItems();
  const natures = useNatures();
  const dexList = dex.status === "ready" ? dex.data : [];
  const itemList = items.status === "ready" ? items.data : [];
  const literal = dexList.find((candidate) => candidate.name === value.species);
  const slug = literal?.slug ?? "";
  // The form it battles as (a held stone makes the Mega): its art, types and stats.
  const entry = (slug && megaFor(slug, value.item ?? "", dexList, itemList)) || literal;
  const learnset = useAsync(() => slug ? loadLearnset(slug).catch(() => null) : Promise.resolve(null), [slug]);
  const usage = useMetaUsage(slug, formats);
  const moves = Array.from({ length: MOVE_SLOTS }, (_, index) => value.moves[index] ?? "");
  const spread = value.spread ?? {};
  const total = spSum(spread);
  const nature = natures.status === "ready" ? natures.data.find((candidate) => candidate.name === value.nature) : undefined;

  const set = (patch: Partial<TeamMemberDoc>) => onChange({ ...value, ...patch });
  const setMove = (index: number, name: string) => {
    const next = [...moves];
    next[index] = name;
    set({ moves: next.filter(Boolean) });
  };
  const setSp = (key: StatKey, sp: number) => set({ spread: { ...spread, [key]: sp } });
  const applyBuild = (option: BuildOption) => {
    const m = option.modal;
    set({
      item: m.item || null, ability: m.ability || null, nature: m.nature || null,
      moves: m.moves.slice(0, MOVE_SLOTS), spread: { ...m.sps },
    });
  };

  const nameRow = (
    <MonNameRow slug={slug} item={value.item ?? ""} dex={dexList} items={itemList} pickerKey="box-editor"
      identityShown={layout === "dialog"}
      actions={slug ? (
        <BuildPickerButton slug={slug} format={formats[0] ?? "single"} formats={[...formats]} onPick={applyBuild} />
      ) : undefined}
      onSpecies={(nextSlug) => {
        const next = dexList.find((candidate) => candidate.slug === nextSlug);
        // Another species keeps the nature and SP the reader chose; its moves, ability and
        // item belonged to the old one.
        if (next && next.name !== value.species) {
          set({ species: next.name, ability: next.abilities[0]?.name ?? null, item: null, moves: [] });
        }
      }}
      onForme={(nextSlug, dropStone) => {
        const next = dexList.find((candidate) => candidate.slug === nextSlug);
        if (next) set({ species: next.name, ...(dropStone ? { item: null } : {}) });
      }} />
  );

  const buildRow = (
    <div className="mbe-row">
      <label>{t("calc.ability")}
        <select value={value.ability ?? ""} onChange={(event) => set({ ability: event.target.value || null })}>
          <option value="">—</option>
          {(entry ?? literal)?.abilities.map((ability) => (
            <option key={ability.name} value={ability.name}>{displayName(ability, lang)}</option>
          ))}
        </select>
      </label>
      <label>{t("calc.nature")}
        <select value={value.nature ?? ""} onChange={(event) => set({ nature: event.target.value || null })}>
          <NatureOptions natures={natures.status === "ready" ? natures.data : NO_NATURES} usage={usage} />
        </select>
      </label>
      <label>{t("calc.item")}
        <ItemCombo idKey="box-editor-item" value={value.item ?? ""} items={itemList} usage={usage}
                   onChange={(item) => set({ item: item || null })} />
      </label>
    </div>
  );

  const moveSlots = (
    <div className="mbe-moves">
      {moves.map((move, index) => (
        <MoveSlot key={index} index={index} value={move}
                  learnset={learnset.status === "ready" ? learnset.data : null} usage={usage}
                  onChange={(name) => setMove(index, name)} />
      ))}
    </div>
  );

  if (layout === "panel") {
    const types = entry?.types ?? [];
    const tint = {
      ["--t1" as string]: types[0] ? typeColor(types[0]) : "var(--brand)",
      ["--t2" as string]: types[1] ? typeColor(types[1]) : types[0] ? typeColor(types[0]) : "var(--brand)",
    } as CSSProperties;
    return (
      <div className="mon-build-editor spread">
        <div className="mbe-hero" style={tint}>
          <span className="mbe-hero-art">
            {entry
              ? <GameImage assetKey={entry.key} role="card" alt={displayName(entry, lang)} />
              : <img src={PLACEHOLDERS.pokemon} alt="" aria-hidden />}
          </span>
          <div className="mbe-hero-main">{nameRow}{buildRow}</div>
        </div>
        <div className="mbe-split">
          <div className="mbe-col">
            <span className="mbe-cap">{t("calc.moveSlots")}</span>
            {moveSlots}
            {beside}
          </div>
          <BuildStats entry={entry} nature={nature} spread={spread} onSp={setSp} />
        </div>
      </div>
    );
  }

  return (
    <div className={`mon-build-editor full`}>
      {(
        <div className="mbe-id">
          <MonPortrait entry={entry} name={entry ? displayName(entry, lang) : ""} />
          {nameRow}
        </div>
      )}
      {buildRow}
      {moveSlots}
      <div className="mbe-sp">
        <span className="mbe-sp-head">SP <span className={`sp-sum num ${spSumClass(total)}`}>{total}/66</span></span>
        {STAT_KEYS.map((key) => (
          <label key={key} className="mbe-sp-cell">
            <span>{t(`stat.${key}` as MsgKey)}</span>
            <input type="number" min={0} max={32} step={1} className="num" value={spread[key] ?? 0}
                   onChange={(event) => setSp(key, clampNum(event.target.value, 0, 32))} />
          </label>
        ))}
      </div>
    </div>
  );
}
