"""Output-text catalog (i18n) for the meta CLI — stdlib only, no gettext / no third party.

Localizes ONLY the human-readable md table headers / field labels / panel-section names / error prose.
The canonical JSON contract is NEVER localized (name / slug / panel keys are cross-skill join keys), so
`--output json` is identical in every language. Precedence: `--lang` flag > `POKEMON_CHAMPIONS_LANG`
env > default en. Same one-file pattern as dex_i18n.py (unique module name avoids cross-skill collision).

Not in scope: the xlsx export (a deliberately Chinese facts workbook) and internal data-sheet keys.
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
    "extra":        {"zh": "附加",     "ja": "追加",       "en": "extra"},
    "format":       {"zh": "赛制",     "ja": "フォーマット", "en": "format"},
    "panel":        {"zh": "面板",     "ja": "パネル",     "en": "panel"},
    "pokemon_rank": {"zh": "宝可梦名次", "ja": "ポケモン順位", "en": "pokemon_rank"},
    "entry_rank":   {"zh": "项内名次", "ja": "項目順位",   "en": "entry_rank"},
    # --- phrases ---
    "resolved":     {"zh": "已解析",   "ja": "解決",       "en": "resolved"},
    "distance":     {"zh": "距离",     "ja": "距離",       "en": "distance"},
    "not_found":    {"zh": "未找到：{query}（{context}）",
                     "ja": "見つかりません：{query}（{context}）",
                     "en": "not found: {query} in {context}"},
    "nf":           {"zh": "未找到",   "ja": "見つかりません", "en": "not found"},
    # --- panel section names (the `## ...` headers; data keys stay canonical) ---
    "panel_moves":     {"zh": "招式",   "ja": "技",         "en": "moves"},
    "panel_items":     {"zh": "道具",   "ja": "持ち物",     "en": "items"},
    "panel_abilities": {"zh": "特性",   "ja": "特性",       "en": "abilities"},
    "panel_natures":   {"zh": "性格",   "ja": "性格",       "en": "natures"},
    "panel_partners":  {"zh": "队友",   "ja": "パートナー", "en": "partners"},
    "panel_spreads":   {"zh": "努力值", "ja": "努力値",     "en": "spreads"},
}


def panel_label(key: str) -> str:
    """Localized section name for a canonical panel key (moves/items/...); falls back to the key."""
    return t("panel_" + key)
