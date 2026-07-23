"""Output-text catalog (i18n) for the dex CLI — stdlib only, no gettext / no third party.

Localizes ONLY human-readable md labels and error prose. Canonical JSON fields (name, the smogon stat
keys, type VALUES, etc.) are NEVER localized — they are cross-skill join keys, so `--format json` output
is identical in every language. Language precedence: `--lang` flag > `POKEMON_CHAMPIONS_LANG` env >
default en.

Pattern (reused per skill): one self-contained `<skill>_i18n.py` = this tiny loader + a MESSAGES table.
Add a label: give it zh/ja/en; call `t("key")` at the emit site. A missing key fails soft (returns the
key) so a gap can never crash a query.
"""
from __future__ import annotations

import os

LANGS = ("zh", "ja", "en")
DEFAULT_LANG = "en"
_lang = DEFAULT_LANG


def resolve_lang(cli_lang: str | None = None) -> str:
    """flag > POKEMON_CHAMPIONS_LANG env > default; unknown values are ignored (fall through)."""
    for cand in (cli_lang, os.environ.get("POKEMON_CHAMPIONS_LANG")):
        if cand and cand.lower() in LANGS:
            return cand.lower()
    return DEFAULT_LANG


def set_lang(cli_lang: str | None = None) -> str:
    """Set the process language once (call after argparse, before any emit). Returns the resolved lang."""
    global _lang
    _lang = resolve_lang(cli_lang)
    return _lang


def lang() -> str:
    return _lang


def t(key: str, **fmt: object) -> str:
    """Localized text for `key` in the current language, with optional `{name}` interpolation. Falls back
    to the default language, then to the raw key — never raises on an unknown key (fail-soft)."""
    entry = MESSAGES.get(key)
    if not entry:
        return key
    s = entry.get(_lang) or entry.get(DEFAULT_LANG) or key
    return s.format(**fmt) if fmt else s


TYPE_NAMES = {
    "Normal": ("一般", "ノーマル"), "Fire": ("火", "ほのお"), "Water": ("水", "みず"),
    "Electric": ("电", "でんき"), "Grass": ("草", "くさ"), "Ice": ("冰", "こおり"),
    "Fighting": ("格斗", "かくとう"), "Poison": ("毒", "どく"), "Ground": ("地面", "じめん"),
    "Flying": ("飞行", "ひこう"), "Psychic": ("超能力", "エスパー"), "Bug": ("虫", "むし"),
    "Rock": ("岩石", "いわ"), "Ghost": ("幽灵", "ゴースト"), "Dragon": ("龙", "ドラゴン"),
    "Dark": ("恶", "あく"), "Steel": ("钢", "はがね"), "Fairy": ("妖精", "フェアリー"),
}
CATEGORY_NAMES = {
    "Physical": ("物理", "物理"), "Special": ("特殊", "特殊"), "Status": ("变化", "変化"),
}
STAT_NAMES = {
    "hp": ("HP", "HP"), "atk": ("攻击", "攻撃"), "def": ("防御", "防御"),
    "spa": ("特攻", "特攻"), "spd": ("特防", "特防"), "spe": ("速度", "素早さ"),
}


def value(kind: str, raw: str) -> str:
    """Localize a small closed vocabulary for human-readable Markdown only."""
    table = {"type": TYPE_NAMES, "category": CATEGORY_NAMES, "stat": STAT_NAMES}.get(kind, {})
    pair = table.get(raw)
    if not pair or _lang == "en":
        return raw
    return pair[0 if _lang == "zh" else 1]


def list_sep() -> str:
    return "，" if _lang == "zh" else "、" if _lang == "ja" else ", "


def parens(value: object) -> str:
    """A parenthesized suffix with language-appropriate spacing and glyphs."""
    return f" ({value})" if _lang == "en" else f"（{value}）"


MESSAGES: dict[str, dict[str, str]] = {
    # --- entity-panel field labels (the colon-prefixed md bullets) ---
    "types":         {"zh": "属性",     "ja": "タイプ",       "en": "Types"},
    "stats":         {"zh": "种族值",   "ja": "種族値",       "en": "Stats"},
    "abilities":     {"zh": "特性",     "ja": "特性",         "en": "Abilities"},
    "mega":          {"zh": "超级进化", "ja": "メガシンカ",   "en": "Mega"},
    "mega_forms":    {"zh": "可超级进化形态", "ja": "メガシンカ形態", "en": "Mega forms"},
    "required_item": {"zh": "携带道具", "ja": "必要道具",     "en": "Required item"},
    "cached_moves":  {"zh": "可用招式", "ja": "覚える技",     "en": "Cached moves"},
    "known_users":   {"zh": "可学宝可梦", "ja": "覚えるポケモン", "en": "Known users"},
    "required_by":   {"zh": "对应宝可梦", "ja": "対象ポケモン",   "en": "Required by"},
    # move-panel inline field labels (emitted dynamically by key)
    "type":          {"zh": "属性",     "ja": "タイプ",       "en": "Type"},
    "category":      {"zh": "分类",     "ja": "分類",         "en": "Category"},
    "power":         {"zh": "威力",     "ja": "威力",         "en": "Power"},
    "accuracy":      {"zh": "命中",     "ja": "命中",         "en": "Accuracy"},
    "pp":            {"zh": "PP",       "ja": "PP",           "en": "PP"},
    "priority":      {"zh": "优先度",   "ja": "優先度",       "en": "Priority"},
    "effect":        {"zh": "效果",     "ja": "効果",         "en": "Effect"},
    "nature_effect": {"zh": "性格修正", "ja": "性格補正",     "en": "Nature effect"},
    # --- find/reverse panel ---
    "conditions":    {"zh": "条件",     "ja": "条件",         "en": "Conditions"},
    "count":         {"zh": "数量",     "ja": "件数",         "en": "Count"},
    # --- phrases / notes ---
    "did_you_mean":  {"zh": "你是不是要找", "ja": "もしかして",   "en": "did you mean"},
    "possible_kinds": {"zh": "可能的实体类型", "ja": "候補の種類", "en": "possible kinds"},
    "resolved":      {"zh": "已解析",   "ja": "解決",         "en": "resolved"},
    "distance":      {"zh": "距离",     "ja": "距離",         "en": "distance"},
    "score":         {"zh": "得分",     "ja": "スコア",       "en": "score"},
    "fuzzy":         {"zh": "模糊匹配", "ja": "あいまい検索", "en": "fuzzy"},
    "none_cached":   {"zh": "（无缓存）", "ja": "（キャッシュなし）", "en": "(none cached)"},
    "none":          {"zh": "（无）",   "ja": "（なし）",     "en": "(none)"},
    "yes":           {"zh": "是",       "ja": "はい",         "en": "yes"},
    "no":            {"zh": "否",       "ja": "いいえ",       "en": "no"},
    "error_not_found": {"zh": "未找到：{query}", "ja": "見つかりません：{query}", "en": "not found: {query}"},
    "error_ambiguous": {"zh": "名称有多个可能结果：{query}", "ja": "候補を1つに絞れません：{query}", "en": "ambiguous name: {query}"},
    "error_bad_input": {"zh": "输入格式不正确，请检查参数。", "ja": "入力形式が正しくありません。引数を確認してください。", "en": "invalid input; check the arguments."},
    "note_unrecognized": {
        "zh": "注意：未识别的条件关键词——不是已知别名，按字面匹配（0 结果可能源于关键词而非数据）：{bad}",
        "ja": "注意：未認識の条件キーワード — 既知のエイリアスではなく字面一致（0 件はキーワードが原因かもしれません）：{bad}",
        "en": "Note: unrecognized condition keyword(s) — not a known alias, matched literally "
              "(a 0 count may be the keyword, not the data): {bad}",
    },
    "note_no_learnset": {
        "zh": "注意：没有找到可学招式数据；当前缓存可能未覆盖此宝可梦。",
        "ja": "注意：覚えるわざデータが見つかりません。現在のキャッシュではこのポケモンを網羅していない可能性があります。",
        "en": "Note: no learnset data was found. The current cache may not cover this Pokémon.",
    },
}
