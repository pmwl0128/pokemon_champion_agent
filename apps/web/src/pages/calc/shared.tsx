/** Shared building blocks for the calc page's three tools (damage matrix / speed line / bulk
 * tune): the per-combatant form (SideForm), the mon picker it and the speed/tune rows reuse,
 * the SP/status/aura vocabularies, and the meta "standard build" auto-fill (toModalSet). */
import type {
  CombatantDto, FormatId, MetaDetailDto, NatureDto, SpSpread, Status,
} from "@pokemon-champions/protocol";
import { STAT_KEYS } from "@pokemon-champions/protocol";
import {
  useEffect, useMemo, useRef, useState,
  type Dispatch, type ReactNode, type SetStateAction,
} from "react";
import { GameImage } from "../../components/GameImage.tsx";
import { PLACEHOLDERS } from "../../assets/icons.ts";
import {
  AdaptiveCombobox, type ComboboxCommitReason,
} from "../../components/AdaptiveCombobox.tsx";
import { useDexIndex, useItems } from "../../hooks.ts";
import { displayName, useLang, useT } from "../../i18n.ts";
import { useRuntime } from "../../runtime/context.tsx";
import { HttpError, type DexIndexEntry } from "../../runtime/adapter.ts";
import type { ItemRef } from "../../runtime/projection.ts";

export const STATUSES = [
  "Healthy", "Burned", "Paralyzed", "Poisoned", "Badly Poisoned", "Asleep", "Frozen",
] as const;
export const BOOST_KEYS = ["atk", "def", "spa", "spd", "spe"] as const;

// Doubles partner auras the calc engine models as side flags (snake_case). Attacker-side buff the
// attacker; the defender-side one protects the defender. (Fairy/Dark Aura are NOT here — the engine
// only applies them when a COMBATANT itself carries the ability, not a partner — see design TODO.)
export const ATTACKER_AURAS = [
  ["helping_hand", "calc.helpingHand"], ["battery", "calc.battery"],
  ["power_spot", "calc.powerSpot"], ["steely_spirit", "calc.steelySpirit"],
] as const;
export const DEFENDER_AURAS = [["friend_guard", "calc.friendGuard"]] as const;

export interface SideState {
  slug: string;
  ability: string;
  item: string;
  nature: string;
  sps: Partial<Record<(typeof STAT_KEYS)[number], number>>;
  status: string;
  boosts: Partial<Record<(typeof BOOST_KEYS)[number], number>>;
}
export const EMPTY_SIDE: SideState = {
  slug: "", ability: "", item: "", nature: "", sps: {}, status: "", boosts: {},
};

export function natureLabel(n: NatureDto, lang: "zh" | "en" | "ja"): string {
  const statNames = {
    zh: { hp: "HP", atk: "攻击", def: "防御", spa: "特攻", spd: "特防", spe: "速度" },
    en: { hp: "HP", atk: "Atk", def: "Def", spa: "SpA", spd: "SpD", spe: "Spe" },
    ja: { hp: "HP", atk: "攻撃", def: "防御", spa: "特攻", spd: "特防", spe: "素早さ" },
  } as const;
  const mod = n.upStat && n.downStat
    ? `（${statNames[lang][n.upStat]}↑／${statNames[lang][n.downStat]}↓）` : "";
  return `${displayName(n, lang)}${mod}`;
}

/** Coerce a number input to [lo, hi], treating a cleared/NaN field as `lo` (so wiping a box to retype
 * never propagates NaN into an SP spread and shows dirty verdicts downstream). */
export function clampNum(raw: string, lo: number, hi: number): number {
  const n = Number(raw);
  return Number.isNaN(n) ? lo : Math.max(lo, Math.min(hi, n));
}

export function spSum(sps: SideState["sps"]): number {
  return STAT_KEYS.reduce((n, k) => n + (sps[k] ?? 0), 0);
}

/** Colour bucket for an SP total against the 66-point budget: under-spent / exactly full / illegal. */
export function spSumClass(n: number): string {
  return n > 66 ? "over" : n === 66 ? "full" : "under";
}

/** True when a side carries no user/meta config yet (just a species, or nothing). The auto-fill
 * effects only overwrite a BARE side, so a configured side swapped/pasted in keeps its build while a
 * fresh pick (or a species switch, which resets to EMPTY_SIDE) still gets its meta-standard fill. */
export function sideIsBare(s: SideState): boolean {
  return !s.ability && !s.item && !s.nature && !s.status
    && !Object.keys(s.sps).length && !Object.keys(s.boosts).length;
}

// Boost stages high→low so the dropdown reads +6 … 0 … −6 top-to-bottom.
export const BOOST_STAGES = [6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6] as const;
export const boostLabel = (n: number): string => (n > 0 ? `+${n}` : String(n));

/** A label-on-top / checkbox-below field cell, so screens/auras line up with the weather/terrain
 * selects in the calc field bar (label row aligns with their labels, box row with the selects). */
export function FieldCheck({ label, checked, onChange, title }: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}) {
  return (
    <label className="fld-chk" title={title}>
      <span className="cap">{label}</span>
      <span className="box"><input type="checkbox" checked={checked}
        onChange={(e) => onChange(e.target.checked)} /></span>
    </label>
  );
}

/** CombatantDto for the calc CLI: only the non-default fields are sent (an all-zero SP spread or a
 * "Healthy" status stays implicit so the engine applies its own defaults). */
export function cleanSide(s: SideState, name: string): CombatantDto {
  const sps: SpSpread = {};
  for (const k of STAT_KEYS) if (s.sps[k]) sps[k] = s.sps[k]!;
  const boosts: Partial<Record<(typeof BOOST_KEYS)[number], number>> = {};
  for (const k of BOOST_KEYS) if (s.boosts[k]) boosts[k] = s.boosts[k]!;
  return {
    name,
    ...(s.ability ? { ability: s.ability } : {}),
    ...(s.item ? { item: s.item } : {}),
    ...(s.nature ? { nature: s.nature } : {}),
    ...(Object.keys(sps).length ? { sps } : {}),
    ...(s.status ? { status: s.status as Status } : {}),
    ...(Object.keys(boosts).length ? { boosts } : {}),
  };
}

export interface ModalSet {
  ability: string;
  item: string;
  nature: string;
  sps: Partial<Record<(typeof STAT_KEYS)[number], number>>;
  moves: string[];
}

/** A convenience STARTING build for the calc tools, stitched from a mon's meta panels: the top
 * ability / item / nature / SP spread + top-4 damaging moves, each the marginal mode of its own
 * panel. These fields have NO joint-distribution guarantee — this combination may never have been
 * played together (dev/design.md §8 forbids treating such a stitch as a real set). It exists only to
 * seed the form so the user isn't typing from scratch; the UI labels it as an unverified default
 * (calc.fillDisclaimer) and the user is expected to adjust. Precise tuning routes through the skill
 * `tune` operator, which grounds on real joint samples instead. */
export function toModalSet(d: MetaDetailDto): ModalSet {
  return {
    ability: d.panels.abilities[0]?.name ?? "",
    item: d.panels.items[0]?.name ?? "",
    nature: d.panels.natures[0]?.name ?? "",
    sps: { ...(d.panels.spreads[0]?.spread ?? {}) },
    moves: d.panels.moves.filter((m) => m.category !== "Status").slice(0, 4).map((m) => m.name),
  };
}

/** Signature of a side's auto-fillable fields + its picked move(s). Two sides with the same signature
 * are indistinguishable to the auto-fill, so on a FORMAT switch a side still matching its last auto-fill
 * (the user never edited it) can be safely re-filled from the new format's modal set, while a user-edited
 * or swapped-in side is left alone. This replaces the `sideIsBare` heuristic, which couldn't tell an
 * unedited auto-fill from a deliberate build and so froze the wrong-format set on a switch (audit 2026-07-14). */
export function autofillSig(s: SideState, moves: string[] = []): string {
  const sps = STAT_KEYS.map((k) => `${k}:${s.sps[k] ?? 0}`).join(",");
  const boosts = BOOST_KEYS.map((k) => `${k}:${s.boosts[k] ?? 0}`).join(",");
  return JSON.stringify([s.ability, s.item, s.nature, sps, s.status, boosts, moves]);
}

/** The signature a side WOULD carry right after an auto-fill from `m` with `moves` — compare a live
 * side against this (via autofillSig) to tell whether it still holds an untouched auto-fill. */
export function modalSig(m: ModalSet, moves: string[]): string {
  return autofillSig(
    { slug: "", ability: m.ability, item: m.item, nature: m.nature, sps: m.sps, status: "", boosts: {} },
    moves);
}

/** Cached meta "standard build" loader — the fill auto-applied on a fresh pick. A 404 (unranked
 * this period) resolves to null so the caller just leaves the form empty.
 *
 * Mega forms are never ranked on their own: the meta folds their usage into the BASE species, so
 * the base's panels already ARE the Mega build (measured: `charizard`'s top item is Charizardite Y).
 * A Mega pick therefore retries once against its base species instead of dead-ending on an empty
 * form. The item is deliberately NOT taken from those panels — a base shared by two stones ranks
 * only one of them (Charizard X would inherit Charizardite Y) — it is pinned to THIS form's own
 * required stone. SideForm pins the same stone, but only on a slug change, so an auto-fill landing
 * afterwards must not reintroduce the wrong item. */
export function useModalFill(): (slug: string, fmt: FormatId) => Promise<ModalSet | null> {
  const { adapter } = useRuntime();
  const dexIndex = useDexIndex();
  const itemVocab = useItems();
  const cache = useRef(new Map<string, Promise<ModalSet | null>>());
  return (slug: string, fmt: FormatId) => {
    const key = `${fmt}:${slug}`;
    let hit = cache.current.get(key);
    if (!hit) {
      const dex = dexIndex.status === "ready" ? dexIndex.data : null;
      const items = itemVocab.status === "ready" ? itemVocab.data : null;
      const entry = dex?.find((e) => e.slug === slug);
      const base = entry?.isMega && entry.baseSpecies
        ? dex?.find((e) => e.name === entry.baseSpecies) : undefined;
      const stone = entry?.isMega && items
        ? items.find((i) => i.requiredBy?.includes(entry.name)) : undefined;
      // A 404 is only a DEFINITIVE "no build" once we could rule a base fallback in or out. With the
      // dex vocab still loading we cannot, so that null must not be cached as the answer.
      const definitive = dex !== null && (!entry || !entry.isMega || !!base);
      hit = (async () => {
        try {
          let dto: MetaDetailDto;
          try {
            dto = await adapter.detail(fmt, slug);
          } catch (e) {
            if (!(e instanceof HttpError && e.status === 404) || !base) throw e;
            dto = await adapter.detail(fmt, base.slug);
          }
          const modal = toModalSet(dto);
          return stone ? { ...modal, item: stone.name } : modal;
        } catch (e) {
          // 404 = unranked this period → no standard build; leave the form empty (cache it so we
          // don't re-hit a known-absent detail every pick).
          if (e instanceof HttpError && e.status === 404) {
            if (!definitive) cache.current.delete(key);
            return null;
          }
          // Any other failure (network, malformed projection, parse) is transient/real, not a "no build":
          // surface it, DROP the cache entry so a later re-pick retries (mirrors AsyncOnce's reject-drop —
          // a flaky load must not poison the slot for the whole session), and degrade to an empty form now.
          console.error(`meta detail auto-fill failed for ${fmt}/${slug}:`, e);
          cache.current.delete(key);
          return null;
        }
      })();
      cache.current.set(key, hit);
    }
    return hit;
  };
}

/** The Mega form this side's held stone unlocks for its species, or null. The engine does
 * NOT auto-mega on a held stone (measured: Garchomp+Garchompite still computes base-102
 * Speed), so the tabs substitute the Mega form themselves and badge the sprite. */
export function megaFor(slug: string, item: string, dex: DexIndexEntry[],
                        items: ItemRef[]): DexIndexEntry | null {
  if (!slug || !item) return null;
  const base = dex.find((e) => e.slug === slug);
  const target = items.find((i) => i.name === item)?.requiredBy?.[0];
  if (!base || !target) return null;
  const mega = dex.find((e) => e.name === target);
  return mega && mega.isMega && mega.baseSpecies === base.name ? mega : null;
}

/** Engine-facing view of a side: the Mega form (with its own legal ability) when the held
 * stone matches, else the side as-is. `entry` is what the request should be issued for. */
export function withMega<S extends { slug: string; item: string }>(
  s: S, dex: DexIndexEntry[], items: ItemRef[],
): { state: S; entry: DexIndexEntry | undefined; mega: boolean } {
  const base = dex.find((e) => e.slug === s.slug);
  const mega = megaFor(s.slug, s.item, dex, items);
  if (!mega) return { state: s, entry: base, mega: false };
  const state = { ...s };
  const withAbility = state as S & { ability?: string };
  if ("ability" in state && withAbility.ability !== undefined
      && !mega.abilities.some((a) => a.name === withAbility.ability)) {
    withAbility.ability = mega.abilities[0]?.name ?? "";
  }
  return { state, entry: mega, mega: true };
}

/** Item-category display order (52poke's taxonomy): battle staples first, the 75 Mega
 * stones last so they never bury the everyday picks. */
export const ITEM_CATEGORY_ORDER: Record<string, number> = {
  battle: 0, type_boost: 1, berry: 2, mega_stone: 3,
};
export function itemOrder(a: { category?: string; name: string },
                          b: { category?: string; name: string }): number {
  const ca = ITEM_CATEGORY_ORDER[a.category ?? ""] ?? 9;
  const cb = ITEM_CATEGORY_ORDER[b.category ?? ""] ?? 9;
  return ca - cb || a.name.localeCompare(b.name);
}

/** Typeable trilingual item input, mirroring MonPicker: free text in any of the
 * three languages resolves to the English canonical; empty clears. */
export function ItemCombo({ value, onChange, items, disabled }: {
  idKey: string;
  value: string;
  onChange: (canonical: string) => void;
  items: ItemRef[];
  /** A Mega FORM picked by name locks its stone — the input goes read-only. */
  disabled?: boolean;
}) {
  const { lang } = useLang();
  const [text, setText] = useState("");
  useEffect(() => {
    const cur = items.find((i) => i.name === value);
    setText(cur ? displayName(cur, lang) : value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, lang, items.length]);
  const options = useMemo(() => [...items].sort(itemOrder).map((i) => ({
    key: i.key, value: displayName(i, lang),
    secondary: i.name,
  })), [items, lang]);
  const resolve = (q: string): string | null => {
    const needle = q.trim().toLowerCase();
    if (!needle) return "";
    const exact = items.find((i) =>
      i.name.toLowerCase() === needle || i.nameZh === q.trim() || i.nameJa === q.trim()
      || displayName(i, lang).toLowerCase() === needle);
    if (exact) return exact.name;
    const part = items.find((i) =>
      i.name.toLowerCase().includes(needle) || (i.nameZh ?? "").includes(q.trim())
      || (i.nameJa ?? "").includes(q.trim()));
    return part ? part.name : null;
  };
  const commit = (raw: string) => {
    const hit = resolve(raw);
    if (hit !== null) onChange(hit);
    else {
      const cur = items.find((i) => i.name === value);
      setText(cur ? displayName(cur, lang) : "");
    }
  };
  return (
    <AdaptiveCombobox value={text} disabled={disabled} options={options}
        onValueChange={(next) => {
          setText(next);
          const q = next.trim();
          const exact = items.find((i) =>
            displayName(i, lang) === q || i.name === q || i.nameZh === q || i.nameJa === q);
          if (exact) onChange(exact.name);
          else if (!q) onChange("");
        }}
        onCommit={commit} />
  );
}

/** Trilingual mon input with suggestions + sprite. Typing is always literal; exact zh/ja/en names
 * and explicit option picks resolve locally, while fuzzy adapter resolution requires Enter.
 * Reused by SideForm and the speed-ladder rows. `displayEntry` overrides the sprite (the Mega form
 * when the held stone activates). */
export function MonPicker({ slug, onSlug, dex, placeholder, displayEntry }: {
  idKey: string;
  slug: string;
  onSlug: (slug: string) => void;
  dex: DexIndexEntry[];
  placeholder?: string;
  displayEntry?: DexIndexEntry;
}) {
  const { lang } = useLang();
  const t = useT();
  const { adapter } = useRuntime();
  const entry = dex.find((e) => e.slug === slug);
  const [text, setText] = useState("");
  const resolveToken = useRef(0);

  useEffect(() => {
    if (entry) setText(displayName(entry, lang));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, slug]);

  const monOptions = useMemo(() => dex.map((e) => ({
    key: e.key, value: displayName(e, lang),
    secondary: `${e.name}${e.nameZh && lang !== "zh" ? ` · ${e.nameZh}` : ""}`,
  })), [dex, lang]);

  const localEntry = (value: string) => {
    const q = value.trim();
    if (!q) return undefined;
    return dex.find((candidate) =>
      candidate.name.toLowerCase() === q.toLowerCase() ||
      candidate.nameZh === q ||
      candidate.nameJa === q ||
      candidate.slug === q.toLowerCase());
  };

  const edit = (value: string) => {
    ++resolveToken.current;
    setText(value);
    const q = value.trim();
    if (!q) { onSlug(""); return; }
    const local = localEntry(value);
    // Re-resolving the CURRENT mon would re-fire onSlug with the same slug, which (SideForm) resets
    // to EMPTY_SIDE and wipes the auto-fill the effect won't re-apply (same key). Skip it.
    if (local) { if (local.slug !== slug) onSlug(local.slug); return; }
    // Never keep calculating with the previous Pokémon while the visible text names no exact entry.
    onSlug("");
  };

  const commit = (value: string, reason: ComboboxCommitReason) => {
    const q = value.trim();
    if (!q) { onSlug(""); return; }
    const local = localEntry(value);
    if (local) {
      setText(displayName(local, lang));
      if (local.slug !== slug) onSlug(local.slug);
      return;
    }
    // Blur is not a user request to accept the first fuzzy match. Enter is.
    if (reason === "blur") return;
    const token = ++resolveToken.current;
    adapter.resolve([q], "pokemon").then((entries) => {
      if (token !== resolveToken.current) return;
      const canonical = entries[0]?.ok ? entries[0].canonical : undefined;
      const hit = canonical ? dex.find((e) => e.name === canonical) : undefined;
      if (hit) {
        setText(displayName(hit, lang));
        if (hit.slug !== slug) onSlug(hit.slug);
      } else {
        onSlug("");
      }
    }).catch(() => {
      if (token === resolveToken.current) onSlug("");
    });
  };

  const shown = displayEntry ?? entry;
  return (
    <span className="mon-picker">
      <span className="mon-picker-slot">
        {shown
          ? <GameImage assetKey={shown.key} role="card" alt={shown.name}
              className="mini mon-picker-img" />
          : <img className="mini mon-picker-img" src={PLACEHOLDERS.pokemon}
              alt="" loading="lazy" aria-hidden />}
      </span>
      <AdaptiveCombobox value={text} options={monOptions}
        onValueChange={edit} onCommit={commit}
        placeholder={placeholder ?? t("calc.pickHint")} />
    </span>
  );
}

/** One combatant's full editable set: mon + ability/nature/item/status + SP spread + boosts.
 * `footer` lets a caller (the tune tool) hang extra controls inside the same card. */
export function SideForm({ label, side, setSide, dex, natures, items, onRemove, onSwap, footer }: {
  label: string;
  side: SideState;
  setSide: Dispatch<SetStateAction<SideState>>;
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  onRemove?: () => void;
  onSwap?: () => void;
  footer?: ReactNode;
}) {
  const { lang } = useLang();
  const t = useT();
  const entry = dex.find((e) => e.slug === side.slug);
  const mega = megaFor(side.slug, side.item, dex, items);
  // A Mega form picked BY NAME requires its stone — pin the item and lock the input.
  const requiredStone = entry?.isMega
    ? items.find((i) => i.requiredBy?.includes(entry.name)) : undefined;
  useEffect(() => {
    if (requiredStone && side.item !== requiredStone.name) {
      setSide((s) => ({ ...s, item: requiredStone.name }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredStone?.name, side.slug]);

  return (
    <div className="panel form-panel side-grid mon-config">
      <strong className="side-head">
        {label}
        {mega && <span className="mega-badge" title={displayName(mega, lang)}>MEGA</span>}
        <span className="side-actions">
          {onSwap && <button className="mini-x swap" onClick={onSwap} title={t("calc.swap")}
            aria-label={t("a11y.swap")}>⇄</button>}
          {onRemove && <button className="mini-x" onClick={onRemove} aria-label={t("a11y.remove")}>✕</button>}
        </span>
      </strong>
      <label>{t("ranking.pokemon")}
        <MonPicker idKey={label} slug={side.slug} dex={dex}
          displayEntry={mega ?? undefined}
          onSlug={(slug) => setSide((s) => s.slug === slug ? s : { ...EMPTY_SIDE, slug })} />
      </label>
      <div className="mini-fields four">
        <label>{t("calc.ability")}
          <select value={side.ability}
            onChange={(e) => setSide((s) => ({ ...s, ability: e.target.value }))}>
            <option value="">—</option>
            {entry?.abilities.map((a) => (
              <option key={a.name} value={a.name}>{displayName(a, lang)}</option>
            ))}
          </select>
        </label>
        <label>{t("calc.nature")}
          <select value={side.nature}
            onChange={(e) => setSide((s) => ({ ...s, nature: e.target.value }))}>
            <option value="">—</option>
            {natures.map((n) => <option key={n.name} value={n.name}>{natureLabel(n, lang)}</option>)}
          </select>
        </label>
        <label>{t("calc.item")}
          <ItemCombo idKey={label} value={side.item} items={items}
            disabled={!!requiredStone}
            onChange={(item) => setSide((s) => ({ ...s, item }))} />
        </label>
        <label>{t("calc.status")}
          <select value={side.status}
            onChange={(e) => setSide((s) => ({ ...s, status: e.target.value }))}>
            {STATUSES.map((st) => (
              <option key={st} value={st === "Healthy" ? "" : st}>{t(`status.${st}`)}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="sp-boost-row">
        <div>
          <span className="sp-cap">{t("calc.sps")}
            <span className="sp-sep">·</span>
            <span className={`sp-sum num ${spSumClass(spSum(side.sps))}`}>{spSum(side.sps)}/66</span>
          </span>
          <div className="sp-grid">
            {STAT_KEYS.map((k) => (
              <label key={k}>{k}
                <input type="number" min={0} max={32} step={1} value={side.sps[k] ?? 0} className="num"
                  onChange={(e) => setSide((s) => ({
                    ...s, sps: { ...s.sps, [k]: clampNum(e.target.value, 0, 32) },
                  }))} />
              </label>
            ))}
          </div>
        </div>
        <div>
          <span className="sp-cap">{t("calc.boosts")}</span>
          <div className="sp-grid boosts">
            {BOOST_KEYS.map((k) => (
              <label key={k}>{k}
                <select className="boost-sel" value={side.boosts[k] ?? 0}
                  onChange={(e) => setSide((s) => ({
                    ...s, boosts: { ...s.boosts, [k]: Number(e.target.value) },
                  }))}>
                  {BOOST_STAGES.map((n) => <option key={n} value={n}>{boostLabel(n)}</option>)}
                </select>
              </label>
            ))}
          </div>
        </div>
      </div>
      {footer}
    </div>
  );
}
