/** Rich entity rendering for agent prose (trade-offs, assumptions, notes, tune summaries).
 * The CONTRACT (companion skill): agent prose narrates in the user's language but names
 * every entity by ENGLISH CANONICAL — copied from operator output, never hand-translated
 * (a hand-written "官译名" is a hallucination vector the panel cannot catch). This renderer
 * then localizes with authority: species (any of the three dex names) become an inline
 * portrait chip; moves become type-icon + authoritative local name; items get their sprite;
 * abilities and the 19 type tokens get local names. Unknown words pass through untouched —
 * free text is never machine-translated. */
import type { ReactNode } from "react";
import { useMemo } from "react";
import { EntityHover } from "../components/EntityHover.tsx";
import { GameImage } from "../components/GameImage.tsx";
import { TypeBadge } from "../components/TypeBadge.tsx";
import { useAbilities, useDexIndex, useItems, useMoves, useNatures } from "../hooks.ts";
import { displayName, optionalKey, useLang, useT, type Lang } from "../i18n.ts";
import type { DexIndexEntry } from "../runtime/adapter.ts";
import type { AbilityRef, ItemRef, MoveRef } from "../runtime/projection.ts";
import type { NatureDto } from "@pokemon-champions/protocol";

const TYPE_TOKENS = [
  "Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison", "Ground",
  "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy", "Typeless",
];
const TERM_TOKENS = ["Trick Room", "Tailwind", "Stealth Rock"];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasCJK = (s: string) => /[぀-ヿ㐀-鿿＀-￯]/.test(s);
const itemSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

interface Vocab {
  re: RegExp | null;
  mons: Map<string, DexIndexEntry>;    // any-language species name -> entry
  moves: Map<string, MoveRef>;         // aliases are accepted; short CJK names are context-gated
  items: Map<string, ItemRef>;         // item names are distinctive enough to accept all languages
  abilities: Map<string, { name: string; nameZh?: string; nameJa?: string }>;
  natures: Map<string, NatureDto>;
  types: Set<string>;
}

// LLM answers commonly write regional forms the community way ("Alolan Ninetales") while
// the dex canonical is suffixed ("Ninetales-Alola") — alias both spellings to the entry.
const REGIONAL: Array<[string, string]> = [
  ["-Alola", "Alolan "], ["-Galar", "Galarian "], ["-Hisui", "Hisuian "],
  ["-Paldea", "Paldean "],
];

function buildVocab(dex: DexIndexEntry[], moveList: MoveRef[], itemList: ItemRef[],
                    abilityList: AbilityRef[], natureList: NatureDto[]): Vocab {
  const mons = new Map<string, DexIndexEntry>();
  const abilities = new Map<string, { name: string; nameZh?: string; nameJa?: string }>();
  for (const e of dex) {
    mons.set(e.name, e);
    if (e.nameZh) mons.set(e.nameZh, e);
    if (e.nameJa) mons.set(e.nameJa, e);
    for (const [suffix, prefix] of REGIONAL) {
      if (e.name.includes(suffix)) mons.set(prefix + e.name.replace(suffix, ""), e);
    }
    // The dex zh/ja display spells forms "九尾（阿罗拉的样子）"; the community (and LLM
    // answers) say "阿罗拉九尾" / "アローラキュウコン" — derive those spellings.
    const zhForm = e.nameZh?.match(/^(.+)（(阿罗拉|伽勒尔|洗翠|帕底亚)的样子）$/);
    if (zhForm) mons.set(`${zhForm[2]}${zhForm[1]}`, e);
    const jaForm = e.nameJa?.match(/^(.+)（(アローラ|ガラル|ヒスイ|パルデア)のすがた）$/);
    if (jaForm) mons.set(`${jaForm[2]}${jaForm[1]}`, e);
    // zh answers often mix the Latin prefix into the zh name ("mega巨金怪") — accept both
    // casings alongside the official 超级 spelling.
    if (e.isMega && e.nameZh?.startsWith("超级")) {
      const rest = e.nameZh.slice(2);
      mons.set(`Mega${rest}`, e);
      mons.set(`mega${rest}`, e);
    }
  }
  // The provider contract still prefers English canonical names. Accept localized item and
  // move aliases as a resilience layer because provider prose can deviate from that contract.
  // Short CJK move aliases are context-gated while rendering: names such as 锁定 / 守住 can
  // otherwise turn ordinary narration into cards. Ability aliases remain canonical-only for
  // the same reason; item and species names are distinctive enough to match directly.
  for (const a of abilityList) abilities.set(a.name, a);
  const moves = new Map<string, MoveRef>();
  for (const m of moveList) {
    moves.set(m.name, m);
    if (m.nameZh) moves.set(m.nameZh, m);
    if (m.nameJa) moves.set(m.nameJa, m);
  }
  const items = new Map<string, ItemRef>();
  for (const i of itemList) {
    items.set(i.name, i);
    if (i.nameZh) items.set(i.nameZh, i);
    if (i.nameJa) items.set(i.nameJa, i);
  }
  const natures = new Map(natureList.map((n) => [n.name, n]));
  if (mons.size === 0) {
    return { re: null, mons, moves, items, abilities, natures, types: new Set() };
  }
  // English tokens take word boundaries; CJK names can't (no \b in CJK). Longest-first
  // alternation so "Ice Punch" (move) beats "Ice" (type) and "Mega Charizard Y" beats
  // "Charizard".
  const en: string[] = [...TERM_TOKENS, ...TYPE_TOKENS];
  const cjk: string[] = [];
  const route = (name: string) => (hasCJK(name) ? cjk : en).push(name);
  for (const name of mons.keys()) route(name);
  for (const name of moves.keys()) route(name);
  for (const name of items.keys()) route(name);
  for (const name of abilities.keys()) route(name);
  for (const name of natures.keys()) route(name);
  const sortLong = (a: string, b: string) => b.length - a.length;
  const enAlt = [...new Set(en)].sort(sortLong).map(escapeRe).join("|");
  const cjkAlt = cjk.sort(sortLong).map(escapeRe).join("|");
  const re = new RegExp(cjkAlt ? `\\b(?:${enAlt})\\b|(?:${cjkAlt})` : `\\b(?:${enAlt})\\b`, "g");
  return { re, mons, moves, items, abilities, natures, types: new Set(TYPE_TOKENS) };
}

function renderToken(vocab: Vocab, token: string, lang: Lang, t: ReturnType<typeof useT>,
                     key: number): ReactNode {
  const mon = vocab.mons.get(token);
  if (mon) {
    return (
      <EntityHover key={key} kind="pokemon" name={mon.name}>
        <span className="prose-mon" title={mon.name}>
          <GameImage assetKey={`pokemon:${mon.slug}`} role="dense" alt={displayName(mon, lang)}
                     className="prose-mon-img" />
          {displayName(mon, lang)}
        </span>
      </EntityHover>
    );
  }
  const mv = vocab.moves.get(token);
  if (mv) {
    return (
      <EntityHover key={key} kind="move" name={mv.name}>
        <span className="prose-type" title={mv.name}>
          <TypeBadge type={mv.type} iconOnly />{displayName(mv, lang)}
        </span>
      </EntityHover>
    );
  }
  const item = vocab.items.get(token);
  if (item) {
    return (
      <EntityHover key={key} kind="item" name={item.name}>
        <span className="prose-mon" title={item.name}>
          <GameImage assetKey={`item:${itemSlug(item.name)}`} role="dense" alt={displayName(item, lang)}
                     className="prose-item-img" />
          {displayName(item, lang)}
        </span>
      </EntityHover>
    );
  }
  const ability = vocab.abilities.get(token);
  if (ability) {
    return (
      <EntityHover key={key} kind="ability" name={ability.name}>
        <span title={ability.name}>{displayName(ability, lang)}</span>
      </EntityHover>
    );
  }
  const nature = vocab.natures.get(token);
  if (nature) return <span key={key} title={nature.name}>{displayName(nature, lang)}</span>;
  if (vocab.types.has(token)) {
    const k = optionalKey(`type.${token}`);
    return (
      <span key={key} className="prose-type" title={token}>
        <TypeBadge type={token} iconOnly />{k ? t(k) : token}
      </span>
    );
  }
  const k = optionalKey(`term.${token}`);
  return k ? <span key={key} title={token}>{t(k)}</span> : token;
}

function entityIdentity(vocab: Vocab, token: string): string | null {
  const mon = vocab.mons.get(token);
  if (mon) return `pokemon:${mon.name}`;
  const move = vocab.moves.get(token);
  if (move) return `move:${move.name}`;
  const item = vocab.items.get(token);
  if (item) return `item:${item.name}`;
  const ability = vocab.abilities.get(token);
  return ability ? `ability:${ability.name}` : null;
}

function shouldRenderEntity(vocab: Vocab, token: string, text: string, at: number): boolean {
  if (!hasCJK(token) || vocab.mons.has(token) || vocab.items.has(token)) return true;
  if (!vocab.moves.has(token)) return true;
  if ([...token].length >= 3) return true;
  const before = text.slice(Math.max(0, at - 10), at);
  const after = text.slice(at + token.length, at + token.length + 8);
  return /(?:招式|技能|使用|选择|携带|配合|通过|依靠|靠|用)\s*$/.test(before)
    || /^(?:强化|输出|攻击|补盲|招式|技能|战术|配置|作为|来)/.test(after);
}

/** Render agent prose with inline entities. Returns nodes — use inside a <li>/<p>/<span>. */
export function useProseRenderer(): (text: string) => ReactNode {
  const { lang } = useLang();
  const t = useT();
  const dexState = useDexIndex();
  const movesState = useMoves();
  const itemsState = useItems();
  const abilitiesState = useAbilities();
  const naturesState = useNatures();
  const vocab = useMemo(
    () => buildVocab(
      dexState.status === "ready" ? dexState.data : [],
      movesState.status === "ready" ? movesState.data : [],
      itemsState.status === "ready" ? itemsState.data : [],
      abilitiesState.status === "ready" ? abilitiesState.data : [],
      naturesState.status === "ready" ? naturesState.data : []),
    [dexState, movesState, itemsState, abilitiesState, naturesState]);
  return useMemo(() => (text: string): ReactNode => {
    if (!vocab.re || !text) return text;
    const parts: ReactNode[] = [];
    let last = 0;
    let k = 0;
    let previousIdentity: string | null = null;
    for (const m of text.matchAll(vocab.re)) {
      const token = m[0];
      const at = m.index ?? 0;
      if (at < last) continue; // already consumed as the preceding entity's localized gloss
      const identity = entityIdentity(vocab, token);
      const gap = text.slice(last, at);
      let end = at + token.length;
      const renderEntity = shouldRenderEntity(vocab, token, text, at);
      // Collapse immediately adjacent aliases of the same entity (including mixed-language
      // output such as "Primarina 西狮海壬") without touching later legitimate mentions.
      const duplicate = identity != null && identity === previousIdentity
        && /^[\s·、，,;/：:（）()]*$/.test(gap);
      let plainGlossEnd: number | null = null;

      // Providers sometimes repeat a canonical entity as a localized parenthetical gloss.
      // The UI localizes the canonical token already, so consume the redundant gloss only when
      // the token will actually be rendered as that entity. A context-gated plain-text token must
      // retain its user-visible parenthetical text.
      if (identity) {
        const gloss = text.slice(end).match(/^(\s*[（(]\s*)([^（）()]{1,80}?)(\s*[）)])/);
        if (gloss && entityIdentity(vocab, gloss[2]!.trim()) === identity) {
          const glossEnd = end + gloss[0].length;
          if (renderEntity || duplicate) end = glossEnd;
          else plainGlossEnd = glossEnd;
        }
      }

      if (!duplicate) {
        if (gap) parts.push(gap);
        if (renderEntity) {
          parts.push(renderToken(vocab, token, lang, t, k++));
          previousIdentity = identity;
        } else {
          parts.push(plainGlossEnd === null ? token : text.slice(at, plainGlossEnd));
          if (plainGlossEnd !== null) end = plainGlossEnd;
          previousIdentity = null;
        }
      }
      last = end;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts.length === 1 ? parts[0] : <>{parts}</>;
  }, [vocab, lang, t]);
}
