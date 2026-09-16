"""Output-text catalog (i18n) for the meta CLI — stdlib only, no gettext / no third party.

Localizes ONLY the human-readable md table headers / field labels / panel-section names / error prose.
The canonical JSON contract is NEVER localized (name / slug / panel keys are cross-skill join keys), so
`--output json` is identical in every language. Precedence: `--lang` flag > `POKEMON_CHAMPIONS_LANG`
env > default en. Same one-file pattern as dex_i18n.py (unique module name avoids cross-skill collision).

The xlsx export uses its own trilingual workbook catalog in meta_query.py. Internal data-sheet keys
remain language-invariant.
"""
from __future__ import annotations

import os

LANGS = ("zh", "ja", "en")
DEFAULT_LANG = "en"
_lang = DEFAULT_LANG


def resolve_lang(cli_lang: str | None = None) -> str:
    for cand in (cli_lang, os.environ.get("POKEMON_CHAMPIONS_LANG")):
        if cand and cand.lower() in LANGS:
            return cand.lower()
    return DEFAULT_LANG


def set_lang(cli_lang: str | None = None) -> str:
    global _lang
    _lang = resolve_lang(cli_lang)
    return _lang


def lang() -> str:
    return _lang


def t(key: str, **fmt: object) -> str:
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
CATEGORY_NAMES = {"Physical": ("物理", "物理"), "Special": ("特殊", "特殊"),
                  "Status": ("变化", "変化")}
FORMAT_NAMES = {"single": ("单打", "シングル"), "double": ("双打", "ダブル"),
                "both": ("单打／双打", "シングル／ダブル")}
STAT_NAMES = {
    "hp": ("HP", "HP", "HP"), "atk": ("攻击", "攻撃", "Atk"),
    "def": ("防御", "防御", "Def"), "spa": ("特攻", "特攻", "SpA"),
    "spd": ("特防", "特防", "SpD"), "spe": ("速度", "素早さ", "Spe"),
}


def value(kind: str, raw: str) -> str:
    table = {"type": TYPE_NAMES, "category": CATEGORY_NAMES, "format": FORMAT_NAMES}.get(kind, {})
    key = next((k for k in table if k.lower() == str(raw).lower()), raw)
    pair = table.get(key)
    if not pair or _lang == "en":
        return key
    return pair[0 if _lang == "zh" else 1]


def spread(entry: dict[str, object]) -> str:
    """Human-readable SP row; the JSON continues to expose six invariant fields."""
    lang_i = {"zh": 0, "ja": 1, "en": 2}[_lang]
    return " / ".join(
        f"{STAT_NAMES[k][lang_i]} {entry.get(k, 0)}"
        for k in ("hp", "atk", "def", "spa", "spd", "spe")
        if isinstance(entry.get(k), (int, float)) and entry.get(k) != 0
    ) or "—"


def list_sep() -> str:
    return "，" if _lang == "zh" else "、" if _lang == "ja" else ", "


def parens(value: object) -> str:
    """A parenthesized suffix with language-appropriate spacing and glyphs."""
    return f" ({value})" if _lang == "en" else f"（{value}）"


MESSAGES: dict[str, dict[str, str]] = {
    # --- report command ---
    "report_update":    {"zh": "更新报告", "ja": "更新レポート", "en": "update report"},
    "report_generated": {"zh": "生成于",   "ja": "生成日時",     "en": "generated"},
    "report_missing":   {"zh": "无报告的格式：{fmts}", "ja": "レポートなし：{fmts}", "en": "no report for: {fmts}"},
    # --- search name auto-correction (non-silent, stderr) ---
    "search_name_corrected": {"zh": "search 名称已自动纠正：{frm} → {to}（模糊匹配，距离 {distance}）",
                              "ja": "search 名称を自動補正：{frm} → {to}（あいまい一致・距離 {distance}）",
                              "en": "search auto-corrected name: {frm} -> {to} (fuzzy, distance {distance})"},
    # --- table column headers / field labels ---
    "rank":         {"zh": "排名",     "ja": "順位",       "en": "rank"},
    "pokemon":      {"zh": "宝可梦",   "ja": "ポケモン",   "en": "pokemon"},
    "slug":         {"zh": "slug",     "ja": "slug",       "en": "slug"},
    "en":           {"zh": "英文名",   "ja": "英語名",     "en": "en"},
    "name":         {"zh": "名称",     "ja": "名前",       "en": "name"},
    "ja_key":       {"zh": "日文名/键", "ja": "日本語/キー", "en": "ja/key"},
    "usage":        {"zh": "使用率",   "ja": "使用率",     "en": "usage"},
    "extra":        {"zh": "详情",     "ja": "詳細",       "en": "details"},
    "type":         {"zh": "属性",     "ja": "タイプ",     "en": "type"},
    "category":     {"zh": "分类",     "ja": "分類",       "en": "category"},
    "power":        {"zh": "威力",     "ja": "威力",       "en": "power"},
    "accuracy":     {"zh": "命中",     "ja": "命中",       "en": "accuracy"},
    "format":       {"zh": "赛制",     "ja": "フォーマット", "en": "format"},
    "panel":        {"zh": "面板",     "ja": "パネル",     "en": "panel"},
    "pokemon_rank": {"zh": "宝可梦名次", "ja": "ポケモン順位", "en": "pokemon_rank"},
    "entry_rank":   {"zh": "项内名次", "ja": "項目順位",   "en": "entry_rank"},
    # --- phrases ---
    "resolved":     {"zh": "已解析",   "ja": "解決",       "en": "resolved"},
    "distance":     {"zh": "距离",     "ja": "距離",       "en": "distance"},
    "fuzzy":        {"zh": "模糊匹配", "ja": "あいまい検索", "en": "fuzzy"},
    "not_found":    {"zh": "未找到：{query}（{context}）",
                     "ja": "見つかりません：{query}（{context}）",
                     "en": "not found: {query} in {context}"},
    "nf":           {"zh": "未找到",   "ja": "見つかりません", "en": "not found"},
    # --- panel section names (the `## ...` headers; data keys stay canonical) ---
    "panel_moves":     {"zh": "招式",   "ja": "わざ",       "en": "moves"},
    "panel_items":     {"zh": "道具",   "ja": "持ち物",     "en": "items"},
    "panel_abilities": {"zh": "特性",   "ja": "特性",       "en": "abilities"},
    "panel_natures":   {"zh": "性格",   "ja": "性格",       "en": "natures"},
    "panel_partners":  {"zh": "队友",   "ja": "パートナー", "en": "partners"},
    "panel_spreads":   {"zh": "SP 分配", "ja": "SP配分",     "en": "SP spreads"},
    # --- KO panels (a separate data axis; subject-relative names) ---
    "panel_ko_targets":    {"zh": "常击倒对象",   "ja": "よく倒す相手",   "en": "most KOs"},
    "panel_koed_by":       {"zh": "常被击倒于",   "ja": "よく倒される相手", "en": "most KO'd by"},
    "panel_ko_moves":      {"zh": "击倒所用招式", "ja": "倒すときのわざ", "en": "KO moves"},
    "panel_koed_by_moves": {"zh": "被击倒的招式", "ja": "倒されたわざ",   "en": "KO'd by moves"},
    # --- KO coverage prose ---
    "ko_snapshot":      {"zh": "KO 快照", "ja": "KOスナップショット", "en": "KO snapshot"},
    "ko_no_pct":        {"zh": "对象列表只有顺序，来源不提供占比",
                         "ja": "相手一覧は順位のみ。出典に比率はありません",
                         "en": "opponent lists are an ordering only; the source publishes no share"},
    "ko_species_level": {"zh": "对象为种族级（全国图鉴编号），不区分形态",
                         "ja": "相手は species 単位（全国図鑑番号）で、フォルムは区別しません",
                         "en": "opponents are species-level (national dex no), not per-form"},
    "ko_moves_absent":  {"zh": "招式占比尚未采集",
                         "ja": "わざの比率は未取得です",
                         "en": "move shares are not collected yet"},
    "ko_form_collapsed": {"zh": "同编号多形态，来源未区分",
                          "ja": "同番号の複数フォルム、出典は未区別",
                          "en": "same dex no, form not distinguished upstream"},
    "ko_missing":       {"zh": "本快照没有 KO 数据：{context}",
                         "ja": "このスナップショットにKOデータはありません：{context}",
                         "en": "no KO data for {context}"},
}


def panel_label(key: str) -> str:
    """Localized section name for a canonical panel key (moves/items/...); falls back to the key."""
    return t("panel_" + key)
