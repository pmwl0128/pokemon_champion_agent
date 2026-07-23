"""Community team-share normalizers (design §2.1 free-input rule), each converting one
popular layout to the Showdown export text that team.py `parse` understands. Names stay
in their original language: parse/dexlink resolve zh/ja/en alike downstream.

1. Markdown team tables — the layout our own team reports use:

       | 位置 | 宝可梦 | 道具 | 特性 | 性格 | 能力点 |
       | 1 | 大嘴鸥 | 潮湿岩石 | 降雨 | 悠闲 | H32 / A0 / B32 / C0 / D2 / S0 |

   with moves either in a 招式/Moves column (slash-separated) or in per-member
   `### <species>` heading sections with bullet lists.

2. The compact share layout popular on Japanese team sites —

       メガマフォクシー@マフォクシナイト(おくびょう)ふゆう
       HP:1 / 防御:3 / 特攻:31 / 素早:31 かえんほうしゃ サイコキネシス ...

   (one header line `name@item(nature)ability`, then stat pairs and moves flowing on the
   following line(s), NO blank separators).

Detection is conservative: leading title/comment lines are allowed, but conversion only
starts when a table header / compact header is found (a real Showdown export's
`Name @ Item` header has spaces and no `(nature)` suffix, so it never matches)."""
from __future__ import annotations

import re

_HEADER = re.compile(
    r"^\s*(?P<name>[^@@\s]+)\s*[@@]\s*(?P<item>[^(())\s]+)\s*"
    r"[((](?P<nature>[^(())]+)[))]\s*(?P<ability>\S+)\s*$")
_STAT = re.compile(r"(HP|攻撃|攻击|防御|特攻|特防|素早さ|素早|速度|体力)\s*[::]\s*(\d+)")
_STAT_LABEL = {"HP": "HP", "体力": "HP", "攻撃": "Atk", "攻击": "Atk", "防御": "Def",
               "特攻": "SpA", "特防": "SpD", "素早さ": "Spe", "素早": "Spe", "速度": "Spe"}


# -- markdown team tables (tier 2a) ----------------------------------------------------------

# Header-cell aliases -> member field. Unknown columns (位置, 编号, #, …) are ignored.
_MD_FIELDS = {
    "species": {"宝可梦", "宝可梦名称", "成员", "名称", "pokemon", "member", "species",
                "ポケモン", "名前"},
    "item": {"道具", "持有物", "item", "items", "持ち物", "もちもの", "アイテム"},
    "ability": {"特性", "ability", "とくせい"},
    "nature": {"性格", "nature", "せいかく"},
    "moves": {"招式", "技能", "moves", "move", "わざ", "技", "技构成"},
    "sp": {"能力点", "sp", "evs", "ev", "努力值", "配点", "能力值", "sp分配", "努力値"},
}
# SP tokens: `H32 / A0 / …` (HABCDS letters), `HP30 SpA22 Spe14`, `攻击32 速度32`, with an
# optional colon. Longest labels first so `HP30` never reads as H + P30.
_SP_TOKEN = re.compile(
    r"(HP|SpA|SpD|Spe|Atk|Def|hp|spa|spd|spe|atk|def"
    r"|攻击|防御|特攻|特防|速度|体力|[HABCDS])\s*[:：]?\s*(\d+)")
_SP_LABEL = {"hp": "HP", "atk": "Atk", "def": "Def", "spa": "SpA", "spd": "SpD",
             "spe": "Spe", "体力": "HP", "攻击": "Atk", "防御": "Def", "特攻": "SpA",
             "特防": "SpD", "速度": "Spe", "H": "HP", "A": "Atk", "B": "Def", "C": "SpA",
             "D": "SpD", "S": "Spe"}
_MD_HEADING = re.compile(r"^#{1,6}\s*(.+?)\s*$")
_MD_BULLET = re.compile(r"^(?:[-*+]|\d+[.、)])\s*(.+?)\s*$")
_MOVE_SPLIT = re.compile(r"\s*[/／、,，;；]\s*")


def _md_cell_clean(s: str) -> str:
    """Strip md emphasis/backticks and a trailing parenthetical role note (`Primarina(锚)`)."""
    s = s.strip().strip("*_`").strip()
    return re.sub(r"\s*[（(][^（）()]*[)）]\s*$", "", s)


def _sp_pairs(cell: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for label, num in _SP_TOKEN.findall(cell):
        std = _SP_LABEL.get(label, label if label in ("HP", "SpA", "SpD", "Spe", "Atk",
                                                      "Def") else None)
        if std and int(num) > 0:
            out.append((std, num))
    return out


def _emit_members(members: list[dict]) -> str:
    """Member dicts -> the Showdown export text team.py parse understands. `sp` is
    (label, value) pairs; names stay in their input language (canonicalized downstream)."""
    out: list[str] = []
    for m in members[:6]:
        out.append(f"{m['species']} @ {m['item']}" if m.get("item") else m["species"])
        if m.get("ability"):
            out.append(f"Ability: {m['ability']}")
        if m.get("nature"):
            out.append(f"{m['nature']} Nature")
        if m.get("sp"):
            out.append("EVs: " + " / ".join(f"{n} {label}" for label, n in m["sp"]))
        out.extend(f"- {mv}" for mv in (m.get("moves") or [])[:4])
        out.append("")
    return "\n".join(out)


# The 25 nature names (EN — the classifier for UNLABELED single-line fields; zh/ja natures
# fall back to position order, and the dex resolver downstream absorbs either).
_EN_NATURES = {
    "Adamant", "Bashful", "Bold", "Brave", "Calm", "Careful", "Docile", "Gentle", "Hardy",
    "Hasty", "Impish", "Jolly", "Lax", "Lonely", "Mild", "Modest", "Naive", "Naughty",
    "Quiet", "Quirky", "Rash", "Relaxed", "Sassy", "Serious", "Timid",
}
_FIELD_SPLIT = re.compile(r"\s*[|｜·;；]\s*")
_LABELED = re.compile(    # ： = fullwidth colon, explicit so it can never be
    r"^\s*(?P<label>[^:：|｜]{1,10}?)\s*[:：]\s*(?P<value>.+)$",   # mistyped as two ASCII colons
    re.DOTALL)
_LATIN_RUN = re.compile(r"[A-Za-z][A-Za-z0-9'.%-]*(?:\s+[A-Za-z][A-Za-z0-9'.%-]*)*")
_SINGLE_MEMBER = re.compile(   # ＠ = fullwidth @
    r"^(?P<name>[^@＠|｜]+?)\s*[@＠]\s*(?P<item>[^|｜]+?)"
    r"\s*[|｜](?P<rest>.+)$")


def _strip_deco(sv: str) -> str:
    """md emphasis / ✨badge tails / a trailing parenthetical annotation."""
    sv = sv.strip().strip("*_`#").strip()
    sv = re.split(r"[✨★☆]", sv)[0].strip()
    sv = re.sub(r"\s*[（(][^（）()]*[)）]\s*$", "", sv)
    return sv.strip().strip("*_`").strip()


def _head_species(head: str) -> str:
    """A heading like `超级喷火龙X Mega Charizard X ✨Mega②（第二 Mega 位）` names the member in
    two languages — prefer the longest Latin run (either resolves, but a MIXED string
    resolves as neither)."""
    head = _strip_deco(head)
    runs = _LATIN_RUN.findall(head)
    if runs:
        best = max(runs, key=len).strip()
        if len(best) >= 3:
            return best
    return head


def _classify_segment(seg: str, m: dict) -> None:
    """Route one UNLABELED field segment (single-line member layout) by shape: a move list
    splits on slashes, an SP run parses to stat pairs, a nature matches the EN nature set,
    and the leftover single token is the ability (then nature, by community field order)."""
    seg = seg.strip()
    if not seg:
        return
    parts = [x for x in (_md_cell_clean(x) for x in _MOVE_SPLIT.split(seg)) if x]
    pairs = _sp_pairs(seg)
    if len(pairs) >= 2:
        m["sp"] = pairs
        return
    if len(parts) >= 2:
        m["moves"] = parts
        return
    value = _md_cell_clean(seg)
    if value in _EN_NATURES and not m.get("nature"):
        m["nature"] = value
    elif not m.get("ability"):
        m["ability"] = value
    elif not m.get("nature"):
        m["nature"] = value


def _apply_labeled(label: str, value: str, m: dict) -> bool:
    lab = label.strip().strip("*_`").lower()
    field = next((f for f, names in _MD_FIELDS.items() if lab in names), None)
    if field is None:
        return False
    value = value.strip()
    if field == "moves":
        m["moves"] = [_md_cell_clean(mv) for mv in _MOVE_SPLIT.split(value)
                      if _md_cell_clean(mv)]
    elif field == "sp":
        m["sp"] = _sp_pairs(value)
    else:
        m[field] = _md_cell_clean(value)
    return True


def _block_team(text: str) -> str | None:
    """Heading/bullet member blocks -> Showdown export. Two shapes, freely mixed:

      ### 超级大竺葵 Mega Meganium ✨Mega①          (a heading starts a member block)
      - 道具：大竺葵进化石 (Meganiumite)｜特性：超级日光 (Mega Sol)｜性格：内敛 (Modest)
      - SP：HP 32 / 特攻 32 / 特防 2
      - 招式：日光束 / 气象球 / 魔法闪耀 / 光合作用

      - **Froslass** @ Froslassite | Cursed Body | Timid | Aurora Veil / ... | SP: hp:18/...

    (labeled fields in any of the three languages; unlabeled single-line fields routed by
    shape). None when no member block is recognized."""
    members: list[dict] = []
    cur: dict | None = None

    def new_member(species: str) -> dict:
        m = {"species": species, "item": None, "ability": None, "nature": None,
             "moves": [], "sp": []}
        members.append(m)
        return m

    for raw in text.splitlines():
        ln = raw.strip()
        if not ln:
            continue
        h = re.match(r"^#{1,6}\s+(.+)$", ln)
        if h:
            sp = _head_species(h.group(1))
            cur = new_member(sp) if sp else None
            continue
        b = _MD_BULLET.match(ln)
        body = (b.group(1) if b else ln).strip()
        single = _SINGLE_MEMBER.match(body)
        if single and len(_FIELD_SPLIT.split(single.group("rest"))) >= 2:
            m = new_member(_md_cell_clean(_strip_deco(single.group("name"))))
            m["item"] = _md_cell_clean(single.group("item"))
            for seg in _FIELD_SPLIT.split(single.group("rest")):
                lm = _LABELED.match(seg)
                if not (lm and _apply_labeled(lm.group("label"), lm.group("value"), m)):
                    _classify_segment(seg, m)
            cur = None
            continue
        if cur is None or not b and not _LABELED.match(body):
            continue
        for seg in _FIELD_SPLIT.split(body):
            lm = _LABELED.match(seg)
            if lm and _apply_labeled(lm.group("label"), lm.group("value"), cur):
                continue
            # a bare bullet under a heading is a move line (the md-table tier's section
            # shape); other unlabeled text is ignored rather than guessed
            if b and " " not in seg and len(cur["moves"]) < 4:
                mv = _md_cell_clean(seg)
                if mv and mv not in cur["moves"]:
                    cur["moves"].append(mv)

    members = [m for m in members
               if m["species"] and (m["item"] or m["ability"] or m["moves"] or m["sp"])]
    return _emit_members(members) if members else None


def _md_team(text: str) -> str | None:
    """Markdown team table(s) + optional per-member move sections -> Showdown export.
    None when the text carries no table with a recognizable species column."""
    lines = text.splitlines()
    members: list[dict] = []
    fields: dict[int, str] | None = None
    for raw in lines:
        ln = raw.strip()
        # Outer pipes are optional in Markdown. Requiring a leading `|` also loses the
        # first row when chat copy adds a short label such as `诊断输入 | Primarina | ...`.
        if ln.count("|") < 3:
            fields = None
            continue
        cells = [c.strip() for c in ln.strip("|").split("|")]
        if all(re.fullmatch(r":?-{2,}:?", c or "-") for c in cells):
            continue        # the |---|---| separator row
        lowered = [c.strip().lower() for c in cells]
        header_map = {i: f for i, c in enumerate(lowered)
                      for f, names in _MD_FIELDS.items() if c in names}
        if "species" in header_map.values():
            fields = header_map
            continue
        # Headerless inline-set rows use the stable six-field tail
        # species|item|ability|nature|moves|SP. Looking at the tail also tolerates a numeric
        # position column and a short prose label before the first member. The combined
        # move-list + multi-stat signature is deliberately strict so arbitrary prose with
        # pipes is not reinterpreted as a team.
        tail = cells[-6:]
        move_parts = ([x for x in (_md_cell_clean(v)
                                   for v in _MOVE_SPLIT.split(tail[4])) if x]
                      if len(cells) >= 6 else [])
        if len(cells) >= 6 and len(move_parts) >= 2 and len(_sp_pairs(tail[5])) >= 2:
            members.append({
                "species": _md_cell_clean(tail[0]),
                "item": _md_cell_clean(tail[1]),
                "ability": _md_cell_clean(tail[2]),
                "nature": _md_cell_clean(tail[3]),
                "moves": move_parts[:4],
                "sp": _sp_pairs(tail[5]),
            })
            continue
        # A common copy shape drops the header/separator and keeps only our fixed report rows:
        # `| 1 | species | item | ability | nature | H2 / ... |`. Recognize that exact
        # six-cell signature conservatively (numeric position + multi-stat final cell); a
        # generic Markdown table must still provide named headers.
        if fields is None and len(cells) == 6 and re.fullmatch(r"#?\s*\d+", cells[0]) \
                and len(_sp_pairs(cells[5])) >= 2:
            members.append({
                "species": _md_cell_clean(cells[1]),
                "item": _md_cell_clean(cells[2]),
                "ability": _md_cell_clean(cells[3]),
                "nature": _md_cell_clean(cells[4]),
                "moves": [],
                "sp": _sp_pairs(cells[5]),
            })
            continue
        if fields is None:
            continue
        m: dict = {"species": None, "item": None, "ability": None, "nature": None,
                   "moves": [], "sp": []}
        for i, cell in enumerate(cells):
            f = fields.get(i)
            if not f or not cell or cell in ("—", "-"):
                continue
            if f == "moves":
                m["moves"] = [_md_cell_clean(mv) for mv in _MOVE_SPLIT.split(cell)
                              if _md_cell_clean(mv)]
            elif f == "sp":
                m["sp"] = _sp_pairs(cell)
            else:
                m[f] = _md_cell_clean(cell)
        if m["species"]:
            members.append(m)
    if not members:
        return None

    # Per-member move sections: `### <species>` heading + bullet list. Headings match a
    # member's species cell verbatim (both sides cleaned) — the table and the sections
    # come from the same document, so they use identical species strings.
    by_species = {m["species"]: m for m in members}
    current: dict | None = None
    for raw in lines:
        h = _MD_HEADING.match(raw.strip())
        if h:
            current = by_species.get(_md_cell_clean(h.group(1)))
            continue
        b = _MD_BULLET.match(raw.strip())
        if b and current is not None and len(current["moves"]) < 4:
            mv = _md_cell_clean(b.group(1))
            if mv and mv not in current["moves"]:
                current["moves"].append(mv)

    return _emit_members(members)


def normalize_team_text(text: str) -> str:
    """Known share layouts -> Showdown export; anything else returns unchanged. Markdown
    team tables are tried first (their `|` rows would confuse the compact parser); then
    the compact ja/zh layout. Leading non-matching lines (a title, a comment) are
    skipped — each layout starts at its first header line."""
    md = _md_team(text)
    if md is not None:
        return md
    block = _block_team(text)
    if block is not None:
        return block
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    start = next((i for i, ln in enumerate(lines) if _HEADER.match(ln)), None)
    if start is None:
        return text
    entries: list[dict] = []
    cur: dict | None = None
    for line in lines[start:]:
        m = _HEADER.match(line)
        if m:
            cur = {"head": m, "stats": [], "moves": []}
            entries.append(cur)
            continue
        if cur is None:
            return text
        # A body line carries stat pairs and/or moves (both may share one line: the stat
        # run ends and the move names simply follow). Strip the stat pairs, the slashes
        # and whatever separators remain — leftover tokens are move names (ja/zh move
        # names never contain spaces; this layout is not used for English).
        cur["stats"] += _STAT.findall(line)
        rest = _STAT.sub(" ", line).replace("/", " ").replace("／", " ")
        cur["moves"] += [t for t in rest.split() if t]
    out: list[str] = []
    for e in entries:
        head = e["head"]
        out.append(f"{head.group('name')} @ {head.group('item')}")
        out.append(f"Ability: {head.group('ability')}")
        out.append(f"{head.group('nature')} Nature")
        if e["stats"]:
            out.append("EVs: " + " / ".join(
                f"{n} {_STAT_LABEL[label]}" for label, n in e["stats"]))
        out.extend(f"- {mv}" for mv in e["moves"][:4])
        out.append("")
    return "\n".join(out)


# -- best-effort species extraction (the last parsing tier, design §7.5) --------------------

_SEGMENT_SPLIT = re.compile(r"[,,、;;・/／|\n\t]+")
_TRIM = " 　@@#*-·().。()「」【】[]::"


def _species_queries(text: str) -> list[str]:
    """Candidate species tokens from free-form text: strong-delimiter segments first, then
    (for segments that would obviously never resolve) space-split words and adjacent word
    pairs — 'Mega Gengar' style English names span two words. Order-preserving, capped."""
    queries: list[str] = []

    def add(q: str) -> None:
        q = q.strip(_TRIM)
        if 1 < len(q) <= 30 and q not in queries and not q.startswith("-"):
            queries.append(q)

    for seg in _SEGMENT_SPLIT.split(text):
        seg = seg.strip(_TRIM)
        if not seg:
            continue
        # Keep the complete segment before generating fallbacks.  Several canonical forms
        # contain three words (Mega Charizard X/Y, Mega Raichu X/Y); adjacent word pairs
        # alone silently lose the form suffix and can even fuzzy-resolve to the base form.
        if len(seg) <= 30:
            add(seg)
        if " " not in seg:
            continue
        words = [w for w in seg.split() if w]
        for i, w in enumerate(words):
            add(w)
            if i + 1 < len(words):
                add(f"{w} {words[i + 1]}")
    return queries[:80]


def resolve_species(pool, queries: list[str], timeout: float = 30.0) -> list[str]:
    """Resolve already-separated species names without tokenizing them again.

    Parsed team members have already crossed a structural boundary, so feeding their
    canonical names back through the free-text tokenizer is both unnecessary and lossy.
    """
    if not queries:
        return []
    species: list[str] = []
    for chunk in (queries[:60], queries[60:80]):
        if not chunk:
            continue
        try:
            doc = pool.request_json(
                "dex", ["resolve", *chunk, "--format", "json", "--kind", "pokemon"],
                timeout=timeout)
        except Exception:
            continue
        for e in doc if isinstance(doc, list) else []:
            if not (isinstance(e, dict) and e.get("ok") and e.get("canonical")):
                continue
            score = float(e.get("score") or 0)
            if e.get("match_type") == "exact" or score >= 0.75:
                name = str(e["canonical"])
                # A successful complete form query is emitted before its word fallbacks.
                # Do not let a later "Charizard" token add a phantom base-form member.
                if any(name != prior and name in prior for prior in species):
                    continue
                if name not in species:
                    species.append(name)
    return species


def extract_species(pool, text: str, timeout: float = 30.0) -> list[str]:
    """Best-effort species list from ANY text via the dex resolver (trilingual). Exact and
    high-confidence fuzzy matches only — a wrong member in the diagnosed team misleads more
    than a missing one, and the report's TeamCard discloses what was recognized."""
    return resolve_species(pool, _species_queries(text), timeout)
