/** Client-side Showdown / pokepaste reader for the calculator's team import.
 *
 * This is deliberately NOT the bridge's team-text parser (`pcui/online/teamtext.py`): that one is a
 * server capability behind a quota, and the calculator has to work in the online runtime where the
 * whole calc is browser-side. What it needs is also narrower — a Showdown export block per mon, with
 * no name resolution (the caller owns that, against the dex index it already holds).
 *
 * Names are returned VERBATIM. A paste can be in any of the three languages, and the dex is the only
 * naming authority (design §2.1), so guessing here would put a second resolver in the app. */
import type { StatKey } from "@pokemon-champions/protocol";

export interface PastedMon {
  /** Species exactly as written — the caller resolves it through the dex. */
  species: string;
  nickname?: string;
  item?: string;
  ability?: string;
  nature?: string;
  /** Champions stat points, already on the 0–32 per-stat scale. */
  sps: Partial<Record<StatKey, number>>;
  moves: string[];
}

export interface PasteResult {
  mons: PastedMon[];
  /** A mainline EV line (a value above the 32 SP cap) was rescaled onto the Champions budget.
   * Surfaced so the import can say so — a silently rewritten spread is a wrong answer that looks
   * like the user's own. */
  rescaledEvs: boolean;
}

const STAT_LABELS: Record<string, StatKey> = {
  hp: "hp",
  atk: "atk", attack: "atk",
  def: "def", defense: "def", defence: "def",
  spa: "spa", spatk: "spa", specialattack: "spa",
  spd: "spd", spdef: "spd", specialdefense: "spd", specialdefence: "spd",
  spe: "spe", spd_: "spd", speed: "spe",
};

const SP_MAX = 32;          // Champions per-stat cap
const EV_MAX = 252;         // mainline per-stat cap, the scale a Showdown export is written on

/** Mainline EVs -> Champions SP. Both scales express the same thing (all-in on a stat), and the
 * budgets line up: a 252/252/4 export lands on 32/32/1 = 65 of the 66 points. Values already inside
 * the SP range are taken as-is — a Champions paste must round-trip unchanged. */
function toSp(value: number, rescale: boolean): number {
  const n = rescale ? Math.round((value * SP_MAX) / EV_MAX) : value;
  return Math.max(0, Math.min(SP_MAX, n));
}

function parseSpread(raw: string): Partial<Record<StatKey, number>> {
  const out: Partial<Record<StatKey, number>> = {};
  const values: Array<[StatKey, number]> = [];
  for (const part of raw.split("/")) {
    // Both orders occur in the wild: "252 Atk" (Showdown) and "Atk 252" (hand-written).
    const m = /^\s*(\d+)\s*([A-Za-z.]+)\s*$/.exec(part) ?? /^\s*([A-Za-z.]+)\s*(\d+)\s*$/.exec(part);
    if (!m) continue;
    const [numText, keyText] = /^\d/.test(m[1]!.trim()) ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
    const key = STAT_LABELS[keyText.toLowerCase().replace(/[.\s]/g, "")];
    const value = Number(numText);
    if (!key || !Number.isFinite(value)) continue;
    values.push([key, value]);
  }
  const rescale = values.some(([, value]) => value > SP_MAX);
  for (const [key, value] of values) out[key] = toSp(value, rescale);
  return out;
}

/** `Nickname (Species) (M) @ Item` and every shorter form of it. The gender tag and the nickname
 * parenthesis are ambiguous on their own — a single `(X)` is a species only when a nickname could
 * not be there, so resolve it the way Showdown does: `(M)`/`(F)` is always gender, anything else in
 * the LAST parenthesis group is the species. */
function parseHeader(line: string): { species: string; nickname?: string; item?: string } {
  const at = line.lastIndexOf("@");
  const item = at === -1 ? undefined : line.slice(at + 1).trim() || undefined;
  let head = (at === -1 ? line : line.slice(0, at)).trim();
  head = head.replace(/\((?:M|F)\)\s*$/i, "").trim();
  const paren = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(head);
  if (paren) return { species: paren[2]!.trim(), nickname: paren[1]!.trim() || undefined, item };
  return { species: head, item };
}

/** Lines that carry no calculator-relevant fact. `Tera Type` and `IVs` are listed on purpose:
 * Champions has neither, so a mainline paste's copy of them must be dropped, not misread. */
const IGNORED = /^(level|shiny|happiness|friendship|tera\s*type|ivs?|gigantamax|dynamax\s*level|ev\s*yield|hidden\s*power)\s*:/i;

function parseBlock(lines: string[]): { mon: PastedMon; rescaled: boolean } | null {
  const header = lines.find((l) => l.trim().length > 0);
  if (!header) return null;
  const { species, nickname, item } = parseHeader(header);
  if (!species) return null;
  const mon: PastedMon = { species, nickname, item, sps: {}, moves: [] };
  let rescaled = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === header.trim()) continue;
    if (line.startsWith("-") || line.startsWith("~")) {
      const move = line.slice(1).trim();
      // Showdown writes a Hidden Power's type in brackets; Champions has no such move, but a
      // pasted "Move [Type]" should still name a move rather than fail to resolve.
      if (move && mon.moves.length < 4) mon.moves.push(move.replace(/\s*\[[^\]]*\]\s*$/, "").trim());
      continue;
    }
    if (IGNORED.test(line)) continue;
    const ability = /^ability\s*:\s*(.+)$/i.exec(line);
    if (ability) { mon.ability = ability[1]!.trim(); continue; }
    const spread = /^(?:evs?|sps?|stat\s*points?)\s*:\s*(.+)$/i.exec(line);
    if (spread) {
      const before = spread[1]!;
      mon.sps = parseSpread(before);
      rescaled ||= /\d+/.test(before)
        && before.split("/").some((p) => Number((/\d+/.exec(p) ?? ["0"])[0]) > SP_MAX);
      continue;
    }
    const nature = /^(.+?)\s+nature\s*$/i.exec(line);
    if (nature) { mon.nature = nature[1]!.trim(); continue; }
  }
  return { mon, rescaled };
}

export function parsePokepaste(text: string): PasteResult {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim() === "") {
      if (current.length) blocks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current);
  const parsed = blocks.map(parseBlock).filter((b): b is NonNullable<typeof b> => b !== null);
  return {
    mons: parsed.map((b) => b.mon),
    rescaledEvs: parsed.some((b) => b.rescaled),
  };
}

/** One mon back out as a Showdown block, on the Champions SP scale (matching what this module
 * reads, so an export → import round-trip is lossless). */
export function formatPokepasteMon(mon: {
  species: string; item?: string; ability?: string; nature?: string;
  sps: Partial<Record<StatKey, number>>; moves: string[];
}): string {
  const labels: Array<[StatKey, string]> = [
    ["hp", "HP"], ["atk", "Atk"], ["def", "Def"], ["spa", "SpA"], ["spd", "SpD"], ["spe", "Spe"],
  ];
  const lines = [mon.item ? `${mon.species} @ ${mon.item}` : mon.species];
  if (mon.ability) lines.push(`Ability: ${mon.ability}`);
  if (mon.nature) lines.push(`${mon.nature} Nature`);
  const spread = labels.flatMap(([key, label]) =>
    mon.sps[key] ? [`${mon.sps[key]} ${label}`] : []);
  if (spread.length) lines.push(`SPs: ${spread.join(" / ")}`);
  lines.push(...mon.moves.filter(Boolean).slice(0, 4).map((m) => `- ${m}`));
  return lines.join("\n");
}
