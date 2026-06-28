from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Any

# Query-only helpers for the offline metagame cache.
# This module is intentionally read-only: it resolves paths, loads cached
# structured data, and normalizes names. It contains no remote endpoints or
# refresh logic. Cache (re)generation lives outside the skill.

SKILL_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = SKILL_DIR / "data"
CACHE_DIR = DATA_DIR
CURRENT_PATH = DATA_DIR / "current.json"

DEFAULT_SEASON = "M-3"
DEFAULT_RULE = "M-B"

PANEL_MAP = {
    "moves": "moves",
    "move": "moves",
    "招式": "moves",
    "桸宒": "moves",
    "items": "items",
    "item": "items",
    "道具": "items",
    "耋撿": "items",
    "abilities": "abilities",
    "ability": "abilities",
    "特性": "abilities",
    "杻俶": "abilities",
    "natures": "natures",
    "nature": "natures",
    "性格": "natures",
    "俶跡": "natures",
    "partners": "partners",
    "partner": "partners",
    "搭档": "partners",
    "勦衭": "partners",
    "spreads": "spreads",
    "spread": "spreads",
    "努力值": "spreads",
    "能力点": "spreads",
}


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def ranking_path(season: str, fmt: str) -> Path:
    return CACHE_DIR / f"ranking_{season}_{fmt}.json"


def details_path(season: str, fmt: str) -> Path:
    return CACHE_DIR / f"details_{season}_{fmt}.json"


def count_cjk(text: str) -> int:
    return len(re.findall(r"[一-鿿]", text or ""))


SUSPICIOUS_CN_CHARS = set(
    "瑈琍竤篽狦癨簑碉臦疨礙礥瞊蒩玦幢"
    "桸宒耋撿杻俶俶跡勦衭"
)


def maybe_repair_cn(text: str | None) -> str:
    if not text:
        return ""
    text = str(text)
    if any(ch in SUSPICIOUS_CN_CHARS for ch in text):
        for source, target in (("gbk", "big5"), ("gbk", "cp950"), ("gb18030", "big5"), ("gb18030", "cp950")):
            try:
                repaired = text.encode(source).decode(target)
            except Exception:
                continue
            if repaired != text and count_cjk(repaired) >= count_cjk(text):
                return repaired
    return text


def normalize(text: str) -> str:
    # NFKC folds full-width <-> half-width (JP sources vary, e.g. １０ vs 10) so names match regardless
    # of how they were typed. Mirrors champdex.normalize (the dex is the naming authority) — the extra
    # ·・ separators are meta-specific and harmless to fold out.
    text = unicodedata.normalize("NFKC", str(text))
    return re.sub(r"[\s\-_'’().:：/\\\[\]{}·・]+", "", text.strip().lower())


def norm_panel(panel: str) -> str:
    return PANEL_MAP.get(panel, PANEL_MAP.get(maybe_repair_cn(panel), panel.lower()))


def default_current_state() -> dict[str, Any]:
    return {
        "current": {"season": DEFAULT_SEASON, "rule": DEFAULT_RULE},
        "seasons": {
            DEFAULT_SEASON: {
                "rule": DEFAULT_RULE,
                "label": "Pokemon Champions M-3 / Regulation M-B",
            }
        },
    }


def current_state() -> dict[str, Any]:
    state = load_json(CURRENT_PATH, default_current_state())
    state.setdefault("current", {"season": DEFAULT_SEASON, "rule": DEFAULT_RULE})
    state.setdefault("seasons", {})
    cur = state["current"]
    season = cur.get("season") or DEFAULT_SEASON
    rule = cur.get("rule") or DEFAULT_RULE
    state["current"] = {"season": season, "rule": rule}
    state["seasons"].setdefault(season, {"rule": rule})
    return state


def resolve_season_rule(season: str | None = None, rule: str | None = None) -> tuple[str, str]:
    state = current_state()
    current = state.get("current", {})
    seasons = state.get("seasons", {})
    if season:
        resolved_rule = rule or seasons.get(season, {}).get("rule") or current.get("rule") or DEFAULT_RULE
        return season, resolved_rule
    if rule:
        current_season = current.get("season") or DEFAULT_SEASON
        if seasons.get(current_season, {}).get("rule") == rule or current.get("rule") == rule:
            return current_season, rule
        matches = [sid for sid, meta in seasons.items() if meta.get("rule") == rule]
        if matches:
            return matches[-1], rule
        return current_season, rule
    return current.get("season") or DEFAULT_SEASON, current.get("rule") or DEFAULT_RULE
