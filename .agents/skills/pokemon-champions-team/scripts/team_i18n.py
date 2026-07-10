"""Output-text catalog (i18n) for the team CLI — stdlib only, no gettext / no third party.

Localizes the human-readable md report's STRUCTURAL surface — section headers, table/field labels and the
short error/warning one-liners — across zh/ja/en. Precedence: `--lang` flag > `POKEMON_CHAMPIONS_LANG`
env > default en. Same one-file pattern as dex_i18n.py / meta_i18n.py (unique module name avoids a
cross-skill `import champdex` collision); set_lang() is called once in team.py main() and the module
global is shared by every helper that `import team_i18n as i18n`.

DELIBERATELY OUT OF SCOPE (left English): the long narrative `notes` / `assumptions` caveat blocks (they
are technical annotations the assistant consumes, not user-read prose) and data-embedded labels that
come from the dex naming authority (Pokemon / move / item / ability names, role + coverage labels). The
canonical JSON contract (`--format json`) is NEVER localized — `name` / slug / stat keys are join keys.
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


def render(_key: str, _in_lang: str, **fmt: object) -> str:
    """Localized text for `_key` in an EXPLICIT language (no global state). Fail-soft: unknown key ->
    the raw key; missing language -> the default. Params are `_key`/`_in_lang` (not `key`/`lang`) because
    several catalog values interpolate a `{key}` placeholder passed via **fmt (e.g. ct_string_or_list),
    which would collide with a positional named `key`."""
    entry = MESSAGES.get(_key)
    if not entry:
        return _key
    s = entry.get(_in_lang) or entry.get(DEFAULT_LANG) or _key
    return s.format(**fmt) if fmt else s


def t(_key: str, **fmt: object) -> str:
    # Render `_key` in the current process language (set once by set_lang in team.py main()).
    return render(_key, _lang, **fmt)


class Msg(str):
    """A localized string that ALSO remembers its catalog key, so the same value can be re-rendered in
    the canonical language for JSON. Its str VALUE is the current-language text (used verbatim in the md
    report); `.en()` returns the canonical English. Use it for any error/warning that flows into BOTH the
    md report AND `--format json`: the md path reads the localized value, while `jsonify()` (called at
    every JSON emit boundary) swaps in `.en()` so `--format json` stays byte-identical across languages.
    A plain `i18n.t(...)` string is fine for md-only or stderr-only text."""
    def __new__(cls, _key: str, _prefix: str = "", **fmt: object) -> "Msg":
        obj = super().__new__(cls, _prefix + t(_key, **fmt))
        obj._key = _key
        obj._fmt = fmt
        obj._prefix = _prefix
        return obj

    def en(self) -> str:
        return self._prefix + render(self._key, "en", **self._fmt)


def jsonify(obj: object) -> object:
    """Deep-copy `obj` for JSON emission, rendering every embedded `Msg` in canonical English. This is the
    single choke point that keeps `--format json` byte-identical across languages (the framework's
    canonical/JSON-never-localized contract): each command wraps its payload in `i18n.jsonify(...)` right
    before `json.dumps`. Plain strings / numbers / None pass through unchanged."""
    if isinstance(obj, Msg):
        return obj.en()
    if isinstance(obj, dict):
        return {k: jsonify(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [jsonify(v) for v in obj]
    return obj


MESSAGES: dict[str, dict[str, str]] = {
    'confidence': {"zh": '置信度', "ja": '信頼度', "en": 'confidence'},
    'partial': {"zh": '部分', "ja": '部分的', "en": 'partial'},
    'notes': {"zh": '注释', "ja": '注記', "en": 'Notes'},
    'per_member': {"zh": '各成员', "ja": '各メンバー', "en": 'Per member'},
    'def_title': {"zh": '防御', "ja": '防御', "en": 'Defense'},
    'def_weak_conc': {"zh": '弱点集中（共享弱点才是真正的风险）', "ja": '弱点の集中（共有する弱点こそ本当のリスク）', "en": 'Weakness concentration (shared weaknesses are the real risk)'},
    'def_weak': {"zh": '弱点', "ja": '弱点', "en": 'weak'},
    'def_immune': {"zh": '免疫', "ja": '無効', "en": 'immune'},
    'def_spread': {"zh": '没有任何攻击属性能对2只以上的成员造成效果拔群。防御面较为分散。', "ja": '2体以上のメンバーに効果抜群となる攻撃タイプはなし。防御面は分散している。', "en": 'No attacking type hits 2+ members for super-effective. Defensively spread.'},
    'off_title': {"zh": '进攻', "ja": '攻撃', "en": 'Offense'},
    'off_intro': {"zh": '下列属性为你的队伍能打出效果拔群的防御方属性。', "ja": '以下のタイプは、あなたのチームが効果抜群で攻撃できる防御側タイプです。', "en": 'Types below are defending types your team hits super-effectively.'},
    'off_gaps_unconfirmed_warn': {"zh": '缺口未确认——未计入招式不完整的成员', "ja": '穴は未確定——技構成が不完全なメンバーは未集計', "en": 'Gaps NOT confirmed — incomplete movesets not counted'},
    'off_hard_gaps': {"zh": '硬性缺口', "ja": '明確な穴', "en": 'Hard gaps'},
    'off_possible_gaps': {"zh": '可能的缺口（未确认）', "ja": '可能性のある穴（未確定）', "en": 'Possible gaps (unconfirmed)'},
    'off_gaps_suffix': {"zh": '对这些防御方属性没有效果拔群的应对手段', "ja": 'これらの防御側タイプに対し効果抜群の打点なし', "en": 'no super-effective answer vs these defending types'},
    'off_thin': {"zh": '薄弱——仅有非本系（non-STAB）打点（火力可能偏软）', "ja": '手薄——非タイプ一致（non-STAB）の打点のみ（火力は軟弱な可能性）', "en": 'Thin — only non-STAB coverage (firepower likely soft)'},
    'off_centralized': {"zh": '集中——仅由单一攻击手覆盖此防御方属性', "ja": '一極集中——単一のアタッカーがこの防御側タイプをカバー', "en": 'Centralized — a single attacker covers this defending type'},
    'off_covered': {"zh": '已覆盖——存在本系（STAB）效果拔群打点，针对：', "ja": 'カバー済み——タイプ一致（STAB）の効果抜群打点が存在、対象：', "en": 'Covered — a STAB super-effective source exists vs:'},
    'off_luck_lines': {"zh": '运气线（命中率 < 100%，可能落空）', "ja": '運要素（命中率 < 100%、外れる可能性）', "en": 'Luck lines (accuracy < 100%, can miss)'},
    'spd_title': {"zh": '速度', "ja": 'すばやさ', "en": 'Speed'},
    'spd_order': {"zh": '速度顺序（中性，最快在前）', "ja": '素早さ順（中立、速い順）', "en": 'Speed order (neutral, fastest first)'},
    'spd_base_unknown': {"zh": '（种族速度未知，未参与排序）：', "ja": '（種族すばやさ不明、ランク外）：', "en": '(base Speed unknown, not ranked):'},
    'spd_priority': {"zh": '先制攻击招式（可先于更快的对手出手）', "ja": '先制攻撃技（より速い相手より先に攻撃できる）', "en": 'Priority attacking moves (can strike before a faster foe)'},
    'spd_control': {"zh": '队伍的速度控制', "ja": 'チームの素早さ操作', "en": 'Speed control on the team'},
    'spd_control_none': {"zh": '未检测到（没有顺风/戏法空间/降速招式、围巾或天气加速特性）', "ja": '検出なし（追い風／トリックルーム／素早さ低下技、こだわりスカーフ、天候による素早さ特性なし）', "en": 'none detected (no Tailwind/Trick Room/speed-drop moves, scarf, or weather-speed abilities)'},
    'role_title': {"zh": '定位', "ja": '役割', "en": 'Roles'},
    'role_intro': {"zh": '仅为客观信号——实际定位由模型判断；此处的内容均非建议。', "ja": '客観的シグナルのみ——実際の役割はモデルが判断する。ここに記載の内容はいずれも推奨ではない。', "en": 'Objective signals only — the model decides actual roles; nothing here is a recommendation.'},
    'role_moves_uncounted_warn': {"zh": '未计入招式信号（无权威招式组）', "ja": '技シグナルは未集計（確かな技構成なし）', "en": 'Move signals not counted (no authoritative moveset)'},
    'role_ability_unspecified': {"zh": '特性：未指定（2个以上合法；已省略特性信号）', "ja": '特性：未指定（合法な特性が2つ以上；特性シグナルは省略）', "en": 'ability: unspecified (2+ legal; ability signals omitted)'},
    'role_no_signals': {"zh": '未检测到功能性信号', "ja": '機能的シグナルは検出なし', "en": 'no functional signals detected'},
    'role_coverage': {"zh": '队伍功能覆盖（招式＋道具＋特性；具备／未检测到——中性事实）', "ja": 'チームの機能カバー（技＋道具＋特性；あり／検出なし——中立的事実）', "en": 'Team functional coverage (moves + items + abilities; present / not detected — neutral facts)'},
    'role_not_detected': {"zh": '未检测到', "ja": '未検出', "en": 'not detected'},
    'role_compression': {"zh": '压缩（同时承担多种功能信号的成员）', "ja": '圧縮（複数の機能的シグナルを担うメンバー）', "en": 'Compression (members carrying multiple functional signals)'},
    'mu_header': {"zh": '对位 meta top-{top_k}（{fmt}）— 客观事实，无排名（对手配置 = meta 众数，{conf} {confidence}；非评分）', "ja": '対面 meta top-{top_k}（{fmt}）— 客観的事実、ランキングなし（相手配置 = meta 最頻、{conf} {confidence}；スコアではない）', "en": 'Matchup vs meta top-{top_k} ({fmt}) — objective facts, unranked (opponent sets = meta modal, {conf} {confidence}; not a score)'},
    'mu_member_header': {"zh": '（种族速度 {base}，配置速度 {spe}；属性 {types}）', "ja": '（種族すばやさ {base}，配置すばやさ {spe}；タイプ {types}）', "en": '(base Spe {base}, set Spe {spe}; types {types})'},
    'mu_clears': {"zh": '越过 {clears}', "ja": '{clears} を超える', "en": 'clears {clears}'},
    'mu_infeasible': {"zh": ' [不可行：总计 {total}>66 SP]', "ja": ' [実現不可：合計 {total}>66 SP]', "en": ' [INFEASIBLE: total {total}>66 SP]'},
    'mu_next_jumps': {"zh": '；后续跳点：{jt}', "ja": '；次のジャンプ：{jt}', "en": '; next jumps: {jt}'},
    'mu_already_clears': {"zh": '；已越过区间内最高集群', "ja": '；すでに帯の最上位クラスタを超えている', "en": "; already clears the field's top cluster"},
    'mu_no_jump': {"zh": '；在上限内没有速度 SP 跳点能越过下一集群', "ja": '；上限内で次のクラスタを超える素早さ SP ジャンプはない', "en": '; no Spe-SP jump clears the next cluster within the cap'},
    'mu_worst_case': {"zh": '；最坏情况 **{n}/{of}** 对高速变体', "ja": '；最悪ケース **{n}/{of}** 対高速型', "en": '; worst-case **{n}/{of}** vs fast variants'},
    'mu_flip': {"zh": '（{flips} 反转）', "ja": '（{flips} 逆転）', "en": ' ({flips} flip)'},
    'mu_speed_field': {"zh": '速度区间：压速 **{out}/{of}**（{percent}%）于众数', "ja": '素早さ帯：抜く **{out}/{of}**（{percent}%）最頻時', "en": 'speed field: outspeeds **{out}/{of}** ({percent}%) at modal'},
    'mu_ties': {"zh": '，同速 {ties}', "ja": '，同速 {ties}', "en": ', ties {ties}'},
    'mu_cmp_outspeeds': {"zh": '压速', "ja": '抜く', "en": 'outspeeds'},
    'mu_cmp_slower': {"zh": '慢于', "ja": 'より遅い', "en": 'slower than'},
    'mu_cmp_tie': {"zh": '同速', "ja": '同速', "en": 'speed-ties'},
    'mu_cmp_unknown': {"zh": '速度 ?', "ja": '素早さ ?', "en": 'speed ?'},
    'mu_we_them': {"zh": '；我方→对方：{move} {min}–{max}%', "ja": '；自分→相手：{move} {min}–{max}%', "en": '; we→them: {move} {min}–{max}%'},
    'mu_them_us': {"zh": '；对方→我方：{move} {min}–{max}%', "ja": '；相手→自分：{move} {min}–{max}%', "en": '; them→us: {move} {min}–{max}%'},
    'mu_used': {"zh": '，{pct}% 使用', "ja": '，{pct}% 採用', "en": ', {pct}% used'},
    'mu_more': {"zh": '（另 +{n} 个）', "ja": '（他 +{n} 件）', "en": ' (+{n} more)'},
    'mu_their_stab': {"zh": '；对方 STAB {types} ×{x} 对我方', "ja": '；相手の STAB {types} ×{x} 対自分', "en": '; their STAB {types} ×{x} vs us'},
    'sel_header': {"zh": '选择（{format}：携带 {bring}，选出 {pick}）— {count} 个选出子集，未排序（{leg}）', "ja": '選出（{format}：持ち込み {bring}、選出 {pick}）— {count} 件の選出サブセット、順位なし（{leg}）', "en": 'Selection ({format}: bring {bring}, pick {pick}) — {count} pick subset(s), unranked ({leg})'},
    'sel_mega_prefix': {"zh": '；超进化：', "ja": '；メガ進化：', "en": '; Mega:'},
    'sel_no_mega': {"zh": '；无超进化', "ja": '；メガ進化なし', "en": '; no Mega'},
    'sel_multi_mega': {"zh": '（携带多块超进化石——每场仅一只可超进化）', "ja": '（複数のメガストーンを持ち込み——メガ進化できるのは1体のみ）', "en": ' (multiple stones brought — only one may Mega)'},
    'sel_speed_order': {"zh": '种族速度顺序（超进化前）：', "ja": '種族すばやさ順（メガ進化前）：', "en": 'base-Speed order (pre-Mega):'},
    'sel_types': {"zh": '属性（超进化前）：', "ja": 'タイプ（メガ進化前）：', "en": 'types (pre-Mega):'},
    # --- derived CHECK coverage (facts-only; grade tokens C2/C1/C0 + "strict"/"contested" stay literal) ---
    'sel_chk_label': {"zh": 'check 覆盖（事实，非排名）：', "ja": 'check 網羅（事実、順位ではない）：', "en": 'check coverage (facts, not a rank):'},
    'sel_chk_holes': {"zh": '漏洞 →', "ja": '穴 →', "en": 'holes →'},
    'sel_chk_holes_none': {"zh": '无（每个 top-K 对手都有换入 check）', "ja": 'なし（top-K の全相手に受け出しチェックあり）', "en": 'none (every top-K opponent switch-in checked)'},
    'chk_cov_label': {"zh": 'check 覆盖：', "ja": 'check 網羅：', "en": 'check coverage:'},
    'chk_cov_na': {"zh": '不适用', "ja": 'なし', "en": 'n/a'},
    'chk_cov_none': {"zh": '无 ncp 支撑的 check 覆盖（已跳过伤害计算）', "ja": 'ncp 由来の check 網羅なし（ダメージ計算スキップ）', "en": 'no ncp-grounded check coverage (damage skipped)'},
    'chk_cov_skipped': {"zh": 'check 覆盖已跳过 — {kind}：{e}', "ja": 'check 網羅をスキップ — {kind}：{e}', "en": 'check coverage skipped — {kind}: {e}'},
    'chk_cov_lineup_none': {"zh": '各阵容 check 覆盖已跳过（伤害不可用）', "ja": '各構成の check 網羅をスキップ（ダメージ利用不可）', "en": 'per-lineup check coverage skipped (damage unavailable)'},
    'chk_cov_lineup_skipped': {"zh": '各阵容 check 覆盖已跳过 — {kind}：{e}', "ja": '各構成の check 網羅をスキップ — {kind}：{e}', "en": 'per-lineup check coverage skipped — {kind}: {e}'},
    'chkcov_title': {"zh": 'Check 覆盖 — {fmt} top-{top_k}（{conf}）', "ja": 'Check 網羅 — {fmt} top-{top_k}（{conf}）', "en": 'Check coverage — {fmt} top-{top_k} ({conf})'},
    'chkcov_none': {"zh": '无 check 覆盖（伤害不可用）', "ja": 'check 網羅なし（ダメージ利用不可）', "en": 'no check coverage (damage unavailable)'},
    'chkcov_legend': {"zh": 'C2 安全换入 / C1 仅同场 revenge / C0 无 — 分布 C2:{c2} C1:{c1} C0:{c0}（标签＋计数，绝非队伍评分）', "ja": 'C2 安全な受け出し / C1 同場 revenge のみ / C0 なし — 分布 C2:{c2} C1:{c1} C0:{c0}（ラベル＋件数、チームスコアではない）', "en": 'C2 safe switch-in / C1 same-field revenge only / C0 none — distribution C2:{c2} C1:{c1} C0:{c0} (a label + count, never a team score)'},
    'chkcov_header': {"zh": '| # | 对手 | 最佳（strict） | 换入者 | modal-headline 者 | 脆弱 | contested |', "ja": '| # | 相手 | 最良（strict） | 受け出し | modal-headline | 脆弱 | contested |', "en": '| # | opponent | best (strict) | switch-in by | modal-headline by | fragile | contested |'},
    'chkcov_contested_title': {"zh": 'Contested（正面判读被 DETECTED 强化/回复削弱）', "ja": 'Contested（肯定的な読みが DETECTED の積み/回復で崩れる）', "en": 'Contested (positive read undermined by DETECTED setup/recovery)'},
    'chkcov_contested_suffix': {"zh": '该档假设无强化/回复；能反制它的成员（纯朴/黑雾/吼叫/挑衅）在此不作标注', "ja": 'この評価は積み/回復なしを前提；それを無効化するメンバー（てんねん/くろいきり/phaze/ちょうはつ）はここでは示されない', "en": 'the grade assumes no setup/recovery; a member that negates it (Unaware / Haze / phaze / Taunt) is NOT flagged here'},
    'chkcov_holes_title': {"zh": '漏洞（无安全换入 check）', "ja": '穴（安全な受け出しチェックなし）', "en": 'Holes (no safe switch-in check)'},
    'chkcov_hole_line': {"zh": 'best strict {best_strict}，best modal-headline {best_modal}', "ja": 'best strict {best_strict}、best modal-headline {best_modal}', "en": 'best strict {best_strict}, best modal-headline {best_modal}'},
    'chkcov_by': {"zh": '由 {who}', "ja": '{who} による', "en": 'by {who}'},
    'chkcov_walled': {"zh": '墙住（无法 KO）由 {who}', "ja": '受け切る（KO 不可）by {who}', "en": 'walled (no KO) by {who}'},
    'chkcov_holes_none': {"zh": '无 — 每个 top-K 对手至少有一个 C2 换入 check', "ja": 'なし — top-K の全相手に少なくとも1つの C2 受け出しチェックあり', "en": 'none — every top-K opponent has at least one C2 switch-in check'},
    'fill_header': {"zh": '补位候选 — 需求：{need}（{fmt}）— 客观事实，多视图，未排序', "ja": '補完候補 — ニーズ：{need}（{fmt}）— 客観的事実、複数ビュー、順位なし', "en": 'Fill candidates — need: {need} ({fmt}) — objective facts, multiple views, unranked'},
    'fill_no_candidates': {"zh": '使用池中没有候选满足该需求', "ja": '使用プールにこのニーズを満たす候補なし', "en": 'No candidates in the usage pool address this need.'},
    'fill_summary': {"zh": '{pool} 个使用池物种中有 {n} 个满足该需求。视图（每个为独立排序，并非综合评分）：', "ja": '使用プール {pool} 種のうち {n} 種がニーズを満たす。ビュー（各々が独立した並び順であり、合成スコアではない）：', "en": '{n} of {pool} pool species address it. Views (each a separate ordering, NOT a combined score):'},
    'fill_resists': {"zh": '抵抗', "ja": '半減', "en": 'resists'},
    'fill_via': {"zh": '经由', "ja": '経由', "en": 'via'},
    'fill_typing': {"zh": '属性', "ja": 'タイプ相性', "en": 'typing'},
    'fill_coverage': {"zh": '打点', "ja": '打点', "en": 'coverage'},
    'fill_owned': {"zh": '已拥有', "ja": '所持', "en": 'owned'},
    'fill_usage': {"zh": '使用率', "ja": '使用率', "en": 'usage'},
    'fill_cooc': {"zh": '共现', "ja": '共起', "en": 'co-occ'},
    'fill_sample': {"zh": '样本', "ja": 'サンプル', "en": 'sample'},
    'fill_views': {"zh": '视图', "ja": 'ビュー', "en": 'Views'},
    'fill_stab_proxy': {"zh": 'STAB（属性近似——未实际检查招式组）', "ja": 'STAB（タイプ相性による近似——実際の技構成は未確認）', "en": 'STAB (typing proxy — actual moveset not checked)'},
    'rep_skip_header': {"zh": '替换影响 — 跳过', "ja": '交代インパクト — スキップ', "en": 'Replace-impact — skipped'},
    'rep_main_header': {"zh": '替换影响：{out} → {in_} — 客观前后差异（非结论）', "ja": '交代インパクト：{out} → {in_} — 客観的な前後差分（判定ではない）', "en": 'Replace-impact: {out} → {in_} — objective before/after diff (not a verdict)'},
    'rep_illegal': {"zh": '⚠️ **替换后队伍非法** — ', "ja": '⚠️ **交代後チームは違法** — ', "en": '⚠️ **after-team is ILLEGAL** — '},
    'rep_legality_unknown': {"zh": '替换后队伍的合法性**未知**（dex 无法完全验证）', "ja": '交代後チームの合法性は**不明**（dex が完全に検証できず）', "en": "the after-team's legality is **unknown** (dex couldn't fully verify)"},
    'rep_defense_worsened': {"zh": '防御 — 共享弱点恶化', "ja": '防御 — 共有弱点が悪化', "en": 'Defense — shared weaknesses WORSENED'},
    'rep_defense_eased': {"zh": '防御 — 共享弱点缓解', "ja": '防御 — 共有弱点が緩和', "en": 'Defense — shared weaknesses EASED'},
    'rep_offense_roles': {"zh": '进攻 / 定位', "ja": '攻撃 / 役割', "en": 'Offense / Roles'},
    'rep_skipped': {"zh": '跳过：', "ja": 'スキップ：', "en": 'skipped:'},
    'rep_offense_coverage': {"zh": '进攻打点', "ja": '攻撃打点', "en": 'Offense coverage'},
    'rep_speed': {"zh": '速度', "ja": 'すばやさ', "en": 'Speed'},
    'rep_roles': {"zh": '定位', "ja": '役割', "en": 'Roles'},
    'rep_weak': {"zh": '弱点', "ja": '弱点', "en": 'weak'},
    'rep_on_the_team': {"zh": '队伍中', "ja": 'チーム内', "en": 'on the team'},
    'rep_gaps_removed': {"zh": '缺口消除（已覆盖）', "ja": '穴を解消（カバー）', "en": 'gaps removed (now covered)'},
    'rep_gaps_added': {"zh": '新增缺口（新未覆盖）', "ja": '穴が追加（新たに未カバー）', "en": 'gaps added (newly uncovered)'},
    'rep_now_thin': {"zh": '现仅非本系打点（薄弱）', "ja": '本系統以外のみの打点（手薄）', "en": 'now only-non-STAB (thin)'},
    'rep_no_longer_thin': {"zh": '不再薄弱', "ja": '手薄を解消', "en": 'no longer thin'},
    'rep_now_centralized': {"zh": '现单一承担者（集中）', "ja": '単独保持（一極集中）', "en": 'now single-bearer (centralized)'},
    'rep_no_longer_centralized': {"zh": '不再集中', "ja": '一極集中を解消', "en": 'no longer centralized'},
    'rep_role_lost': {"zh": '丢失（无承担者）', "ja": '喪失（保持者なし）', "en": 'LOST (no carrier left)'},
    'rep_role_gained': {"zh": '获得', "ja": '獲得', "en": 'gained'},
    'rep_role_thinner': {"zh": '更薄弱', "ja": 'より手薄', "en": 'thinner'},
    'rep_role_more_redundant': {"zh": '更冗余', "ja": 'より冗長', "en": 'more redundant'},
    'rep_bearers': {"zh": '承担者', "ja": '保持者', "en": 'bearers'},
    'val_title': {"zh": '队伍合法性校验', "ja": 'チーム合法性検証', "en": 'Team validation'},
    'val_errors': {"zh": '错误', "ja": 'エラー', "en": 'Errors'},
    'val_not_checked': {"zh": '未检查（合法性无法确立）', "ja": '未チェック（合法性を確立できず）', "en": 'Not checked (legality could not be established)'},
    'val_warnings': {"zh": '警告', "ja": '警告', "en": 'Warnings'},
    'val_no_issues': {"zh": '未发现合法性问题（所有检查均已执行）。', "ja": '合法性の問題は見つかりませんでした（全チェック実行済み）。', "en": 'No legality issues found (all checks ran).'},
    'val_team_size': {"zh": '队伍有 {n} 只 Pokemon；Champions 队伍需注册 {min}-{max} 只。', "ja": 'チームに {n} 体の Pokemon がいます；Champions のチームは {min}-{max} 体を登録します。', "en": 'Team has {n} Pokemon; Champions teams register {min}-{max}.'},
    'val_not_in_dex': {"zh": '`{sp}` 不在 Champions 图鉴中（非法 / 未进化 / 名称错误）。', "ja": '`{sp}` は Champions 図鑑にありません（非合法 / 進化前 / 名前違い）。', "en": '`{sp}` is not in the Champions dex (illegal / pre-evolution / wrong name).'},
    'val_move_illegal': {"zh": '`{sp}` 无法学会 `{mv}`（不在 Champions 招式池中）。', "ja": '`{sp}` は `{mv}` を覚えられません（Champions の技マシン覚えにありません）。', "en": '`{sp}` cannot learn `{mv}` (not in Champions learnset).'},
    'val_ability_illegal': {"zh": '`{sp}` 不能拥有特性 `{ability}`。', "ja": '`{sp}` は特性 `{ability}` を持てません。', "en": '`{sp}` cannot have ability `{ability}`.'},
    'val_mega_item': {"zh": '`{sp}`（Mega）需要道具 `{req}`，但找到的是 `{item}`。', "ja": '`{sp}`（Mega）には持ち物 `{req}` が必要ですが、`{item}` が見つかりました。', "en": '`{sp}` (Mega) requires item `{req}`, found `{item}`.'},
    'val_move_count': {"zh": '`{sp}` 有 {n} 个招式；上限 {cap}。', "ja": '`{sp}` は技を {n} 個持っています；最大 {cap}。', "en": '`{sp}` has {n} moves; max {cap}.'},
    'val_dup_moves': {"zh": '`{sp}` 携带重复招式：{dups}（每个招式至多一次）。', "ja": '`{sp}` は重複した技を持っています：{dups}（各技は最大一度まで）。', "en": '`{sp}` carries duplicate move(s): {dups} (each move at most once).'},
    'val_sp_over': {"zh": '`{sp}` 以下数值的 SP 超过 {cap}：{over}。', "ja": '`{sp}` の SP が {cap} を超えています：{over}。', "en": '`{sp}` SP over {cap} on: {over}.'},
    'val_sp_total': {"zh": '`{sp}` SP 总和 {total} 超过上限 {cap}。', "ja": '`{sp}` の SP 合計 {total} が上限 {cap} を超えています。', "en": '`{sp}` SP total {total} exceeds cap {cap}.'},
    'val_item_pool': {"zh": '道具 `{it}` 不在 Champions 道具池中。', "ja": '持ち物 `{it}` は Champions の道具プールにありません。', "en": 'Item `{it}` is not in the Champions item pool.'},
    'val_skip_roster': {"zh": '名册/招式/特性/Mega/同种限制合法性 — dex 不可用（{e}）', "ja": 'ロスター/技/特性/Mega/同種条項の合法性 — dex 利用不可（{e}）', "en": 'roster/move/ability/Mega/Species-Clause legality — dex unavailable ({e})'},
    'val_skip_learnset_empty': {"zh": '`{sp}` 的 dex 招式池为空 — 无法验证招式合法性。', "ja": '`{sp}` の dex 技リストが空です — 技の合法性を検証できません。', "en": '`{sp}` has an empty dex learnset — move legality not verifiable.'},
    'val_skip_itempool': {"zh": '道具池合法性 — dex 不可用（{e}）', "ja": '道具プールの合法性 — dex 利用不可（{e}）', "en": 'item-pool legality — dex unavailable ({e})'},
    'val_skip_owned_empty': {"zh": '请求了仅限拥有，但拥有列表为空 — 无法验证拥有情况。', "ja": '所持限定が要求されましたが、所持リストが空です — 所持を検証できません。', "en": 'owned-only requested but the owned list is empty — ownership not verifiable.'},
    'val_not_owned': {"zh": '`{species}` 不在你的拥有列表中（owned_only）。', "ja": '`{species}` はあなたの所持リストにありません（owned_only）。', "en": '`{species}` is not in your owned list (owned_only).'},
    'val_skip_owned': {"zh": '仅限拥有检查 — dex 不可用（{e}）', "ja": '所持限定チェック — dex 利用不可（{e}）', "en": 'owned-only check — dex unavailable ({e})'},
    'val_species_clause': {"zh": '同种限制：{owners} 共享同一基础种族；至多保留一只。', "ja": '同種条項：{owners} が同じベース種を共有しています；最大一体まで。', "en": 'Species Clause: {owners} share a base species; keep at most one.'},
    'val_item_clause': {"zh": '同道具限制：道具被 {owners} 持有；每个道具至多一次。', "ja": '同アイテム条項：持ち物を {owners} が所持しています；各アイテムは最大一度まで。', "en": 'Item Clause: item held by {owners}; each item at most once.'},
    'val_incomplete': {"zh": '合法性仅部分可认证 — 不完整（仅物种或缺失关键字段）的配置，缺失部分未知，未认证为合法：{incomplete}。', "ja": '合法性は部分的にしか認証できません — 不完全（種族のみ、または重要フィールドが欠けた）構成は、欠落部分が不明であり合法と認証されていません：{incomplete}。', "en": 'legality only partially certifiable — incomplete species-only or critical-field-missing sets have unknown absent parts, not certified legal: {incomplete}.'},
    'ct_schema_version': {"zh": '不支持的 schema_version {v!r}；本技能支持 {supported}', "ja": 'サポート外の schema_version {v!r}；本スキルがサポートするのは {supported} です', "en": 'unsupported schema_version {v!r}; this skill supports {supported}'},
    'ct_team_object': {"zh": 'team-json 必须是 JSON 对象', "ja": 'team-json は JSON オブジェクトである必要があります', "en": 'team-json must be a JSON object'},
    'ct_format_enum': {"zh": 'format 必须是 {allowed} 其一；得到 {got!r}', "ja": 'format は {allowed} のいずれかである必要があります；実際は {got!r}', "en": 'format must be one of {allowed}; got {got!r}'},
    'ct_pokemon_list': {"zh": 'team-json 需要一个非空的 `pokemon` 列表', "ja": 'team-json には空でない `pokemon` リストが必要です', "en": 'team-json needs a non-empty `pokemon` list'},
    'ct_member_object': {"zh": 'member 必须是 JSON 对象', "ja": 'member は JSON オブジェクトである必要があります', "en": 'member must be a JSON object'},
    'ct_member_species': {"zh": 'member 需要一个非空的 `species`', "ja": 'member には空でない `species` が必要です', "en": 'member needs a non-empty `species`'},
    'ct_string_or_null': {"zh": '`{key}` 必须是字符串或 null', "ja": '`{key}` は文字列または null である必要があります', "en": '`{key}` must be a string or null'},
    'ct_moves_list': {"zh": '`moves` 必须是字符串列表', "ja": '`moves` は文字列のリストである必要があります', "en": '`moves` must be a list of strings'},
    'ct_spread_object': {"zh": '`spread` 必须是 stat -> SP 的对象', "ja": '`spread` は stat -> SP のオブジェクトである必要があります', "en": '`spread` must be an object of stat -> SP'},
    'ct_unknown_stat': {"zh": '未知能力值 `{k}`', "ja": '不明なステータス `{k}`', "en": 'unknown stat `{k}`'},
    'ct_sp_int': {"zh": 'SP 必须是整数', "ja": 'SP は整数である必要があります', "en": 'SP must be an integer'},
    'ct_sp_nonneg': {"zh": 'SP 必须是非负整数', "ja": 'SP は非負整数である必要があります', "en": 'SP must be a non-negative integer'},
    'ct_completeness_enum': {"zh": 'completeness 必须是 {allowed} 其一', "ja": 'completeness は {allowed} のいずれかである必要があります', "en": 'completeness must be one of {allowed}'},
    'ct_tera_null': {"zh": '该作没有太晶化；`tera` 应为 null', "ja": '本作にはテラスタルがありません；`tera` は null である必要があります', "en": 'Champions has no Terastallization; `tera` should be null'},
    'ct_context_object': {"zh": 'build-context 必须是 JSON 对象', "ja": 'build-context は JSON オブジェクトである必要があります', "en": 'build-context must be a JSON object'},
    'ct_input_unreadable': {"zh": '无法读取输入文件 {path!r}: {e}', "ja": '入力ファイル {path!r} を読み込めません: {e}', "en": 'cannot read input file {path!r}: {e}'},
    'ct_owned_only_bool': {"zh": '`owned_only` 必须是布尔值', "ja": '`owned_only` は真偽値である必要があります', "en": '`owned_only` must be a boolean'},
    'ct_keep_mega_str': {"zh": '`keep_mega` 必须是物种/Mega 形态名字符串', "ja": '`keep_mega` は種族/メガフォルム名の文字列である必要があります', "en": '`keep_mega` must be a species / Mega form name string'},
    'val_sp_shape': {"zh": '{sp} 的 SP 配点条目非法（未知键/非整数/负值）：{bad}——键限 {keys}，值须为非负整数', "ja": '{sp} の SP 配分に不正な項目（不明キー/非整数/負値）：{bad}——キーは {keys}、値は非負整数のみ', "en": '{sp} has illegal SP spread entries (unknown key / non-int / negative): {bad} — keys must be {keys}, values non-negative ints'},
    'team_ctx_audit_needs_context': {"zh": 'context-audit 需要 --context <build-context.json>（team 文件可选）', "ja": 'context-audit には --context <build-context.json> が必要です（team ファイルは任意）', "en": 'context-audit requires --context <build-context.json> (the team file is optional)'},
    'ctx_audit_header': {"zh": '# 意图审计（context-audit）— 缺口 {n_gaps} 项', "ja": '# 意図監査（context-audit）— ギャップ {n_gaps} 件', "en": '# Context audit — {n_gaps} gap(s)'},
    'ctx_audit_contract_errors': {"zh": '结构契约问题（照实报告，未拒绝）', "ja": '構造契約の問題（報告のみ、拒否せず）', "en": 'Contract findings (reported, not refused)'},
    'ctx_audit_blocking': {"zh": '必问（blocking — 无安全默认）', "ja": '要確認（blocking — 安全なデフォルトなし）', "en": 'Blocking (no safe default — ask first)'},
    'ctx_audit_conflicts': {"zh": '冲突/歧义（定向单问）', "ja": '矛盾/曖昧（的を絞った一問）', "en": 'Conflicts / ambiguity (one targeted question)'},
    'ctx_audit_defaults': {"zh": '可默认（应用后必须披露；info_value=high 表示问了很增益）', "ja": 'デフォルト可（適用時は開示必須；info_value=high は質問の価値が高い）', "en": 'Safe defaults (apply + DISCLOSE; info_value=high = asking buys a lot)'},
    'ctx_audit_not_enforced': {"zh": '仅 AI 侧生效的在场字段（skill 不机械过滤）', "ja": 'AI 側でのみ有効な指定（skill は機械的に強制しない）', "en": 'Present fields enforced AI-side only'},
    'ctx_audit_clean': {"zh": '（无）', "ja": '（なし）', "en": '(none)'},
    'ctx_audit_receipt': {"zh": '回执', "ja": 'レシート', "en": 'Receipt'},
    'ctx_audit_receipt_hint': {"zh": 'slate-evaluate 需要 --format json 输出里完整的 audit_receipt 对象，不是这串指纹', "ja": 'slate-evaluate には --format json 出力の audit_receipt オブジェクト全体を渡すこと（この指紋文字列ではない）', "en": 'slate-evaluate needs the FULL audit_receipt object from the --format json output, not this fingerprint string'},
    'team_landscape_needs_format': {"zh": 'landscape 需要 --game-format single|double（绝不混用两个环境）', "ja": 'landscape には --game-format single|double が必要です（環境は混在しません）', "en": 'landscape requires --game-format single|double (metagames are never mixed)'},
    'team_refuse_landscape': {"zh": 'build-context 未通过契约检查——landscape 已拒绝（修正上述错误后重试）', "ja": 'build-context が契約検査に失敗——landscape は拒否しました（上記エラーを修正して再試行）', "en": 'build-context failed the contract check — landscape refused (fix the errors above and retry)'},
    'team_refuse_slate': {"zh": 'slate 的 context 未通过契约检查——slate-evaluate 已拒绝', "ja": 'slate の context が契約検査に失敗——slate-evaluate は拒否しました', "en": "the slate's context failed the contract check — slate-evaluate refused"},
    'team_slate_refused': {"zh": 'slate-evaluate 拒绝：{code}（详见输出 JSON 的 refused 字段）', "ja": 'slate-evaluate は拒否：{code}（出力 JSON の refused を参照）', "en": 'slate-evaluate refused: {code} (see the refused field in the JSON output)'},
    'team_slate_needs_battle_format': {"zh": 'slate 的 context 或候选队都未声明 format——两个环境绝不混用，请在 context.format 写明 single|double', "ja": 'slate の context にも候補チームにも format がありません——環境は混在しません。context.format に single|double を指定してください', "en": "neither the slate's context nor any candidate declares a format — metagames are never mixed; set context.format to single|double"},
    'team_answer_needs_inputs': {"zh": 'answer-audit 需要 --slate <原始 slate.json> 与 --slate-output <已保存的 slate-evaluate 输出>——回执链靠这两个文件重算绑定', "ja": 'answer-audit には --slate <元の slate.json> と --slate-output <保存済み slate-evaluate 出力> が必要です——receipt チェーンはこの 2 ファイルで再計算・結合されます', "en": 'answer-audit requires --slate <the original slate.json> and --slate-output <the saved slate-evaluate output> — the receipt chain is recomputed and re-bound from these two files'},
    'team_checkpoint_needs_inputs': {"zh": 'checkpoint 需要 <已保存的 slate-evaluate 输出> 与 --slate <原始 slate.json>。', "ja": 'checkpoint には <保存済み slate-evaluate 出力> と --slate <元の slate.json> が必要です。', "en": 'checkpoint requires <saved slate-evaluate output> and --slate <original slate.json>.'},
    'team_refuse_checkpoint': {"zh": 'slate 的 context 未通过契约检查——checkpoint 已拒绝', "ja": 'slate の context が契約検査に失敗——checkpoint は拒否しました', "en": "the slate's context failed the contract check — checkpoint refused"},
    'team_answer_refused': {"zh": 'answer-audit 拒绝：{code}（详见输出 JSON 的 refused 字段）', "ja": 'answer-audit は拒否：{code}（出力 JSON の refused を参照）', "en": 'answer-audit refused: {code} (see the refused field in the JSON output)'},
    'team_refuse_answer': {"zh": 'slate 的 context 未通过契约检查——answer-audit 已拒绝', "ja": 'slate の context が契約検査に失敗——answer-audit は拒否しました', "en": "the slate's context failed the contract check — answer-audit refused"},
    'team_observed_needs_format': {"zh": 'observed 需要 --game-format single|double（绝不混用两个环境）', "ja": 'observed には --game-format single|double が必要です（環境は混在しません）', "en": 'observed requires --game-format single|double (metagames are never mixed)'},
    'team_refuse_observed': {"zh": 'build-context 未通过契约检查——observed 已拒绝（修正上述错误后重试）', "ja": 'build-context が契約検査に失敗——observed は拒否しました（上記エラーを修正して再試行）', "en": 'build-context failed the contract check — observed refused (fix the errors above and retry)'},
    'team_intake_bad_format': {"zh": 'intake 的 game_format 必须是 single|double（或省略取全目录），得到 {got}', "ja": 'intake の game_format は single|double（省略で全カタログ）である必要があります。指定値: {got}', "en": 'intake game_format must be single|double (or omitted for the full catalog), got {got}'},
    'team_intake_unknown_answered': {"zh": 'intake --next 的 --answered 含未知题 id：{ids}（必须是基础题 id）。未知 id 会让步进器重问已解决维度——已拒绝', "ja": 'intake --next の --answered に未知の質問 id が含まれます：{ids}（基本質問の id である必要があります）。未知 id は解決済みの項目を再質問させるため拒否しました', "en": 'intake --next --answered has unknown question id(s): {ids} (must be base-question ids). Unknown ids would re-ask a resolved dimension — refused'},
    'team_observed_bad_limit': {"zh": 'observed 的 --limit 必须 >= 0（0 = 只要计数），得到 {limit}', "ja": 'observed の --limit は 0 以上が必要です（0 = 件数のみ）。指定値: {limit}', "en": 'observed --limit must be >= 0 (0 = counts only), got {limit}'},
    'team_observed_empty_partition': {"zh": '{season}/{fmt} 分区没有任何队——请检查 season 写法（如 M-3）；0 行不代表"无证据"', "ja": '{season}/{fmt} パーティションにチームがありません——season の表記（例: M-3）を確認してください。0 行は「証拠なし」を意味しません', "en": 'no teams in the {season}/{fmt} partition — check the season string (e.g. M-3); zero rows does not mean "no evidence exists"'},
    'team_context_format_mismatch': {"zh": 'build-context 声明 format={ctx}，但 --game-format={cli}——以命令行为准，请确认没跑错环境', "ja": 'build-context は format={ctx} を宣言していますが --game-format={cli} です——コマンドラインを優先します。環境の取り違えにご注意', "en": "build-context declares format={ctx} but --game-format={cli} — the command line wins; make sure you are not reading the wrong metagame"},
    'land_header': {"zh": '# 环境结构分布（{fmt}，{n} 支真实队）— 置信 {conf}', "ja": '# 環境構造分布（{fmt}、実チーム {n} 件）— 信頼度 {conf}', "en": '# Environment structural landscape ({fmt}, {n} observed teams) — confidence {conf}'},
    'land_thin': {"zh": '库薄（{n} < {bar} 支）：分布稀疏，谨慎解读', "ja": 'ライブラリが薄い（{n} < {bar} 件）：分布は疎、慎重に解釈', "en": 'THIN library ({n} < {bar} teams): sparse distributions, read with caution'},
    'land_modes': {"zh": '速度控制模式（队伍级出现次数/占比）', "ja": 'スピードコントロール様式（チーム単位の出現数/割合）', "en": 'Speed-control modes (team-level count / share)'},
    'land_mega_slots': {"zh": '登记 Mega 候选槽位分布（队伍级出现次数/占比）', "ja": '登録メガ候補枠の分布（チーム単位の出現数/割合）', "en": 'Registered Mega-option slot distribution (team-level count / share)'},
    'land_signals': {"zh": '结构信号出现频率', "ja": '構造シグナルの出現頻度', "en": 'Structural signal frequencies'},
    'land_cores': {"zh": '观测共现核心（order={order}，计数非排名）', "ja": '観測された共起コア（order={order}、カウントでありランキングではない）', "en": 'Observed co-occurring cores (order={order}; counts, not a ranking)'},
    'land_filter': {"zh": '过滤：包含 {filt} 的 {n} 支队', "ja": 'フィルタ：{filt} を含む {n} チーム', "en": 'filter: {n} teams containing {filt}'},
    'land_offense': {"zh": '进攻画像（aspects=offense；各类型出现队数/占比）', "ja": '攻撃プロファイル（aspects=offense；タイプ別の出現チーム数/割合）', "en": 'Offense profile (aspects=offense; team-presence count / share per type)'},
    'land_defense': {"zh": '防守画像（aspects=defense；各类型出现队数/占比）', "ja": '防御プロファイル（aspects=defense；タイプ別の出現チーム数/割合）', "en": 'Defense profile (aspects=defense; team-presence count / share per type)'},
    'team_landscape_bad_aspect': {"zh": '未知 aspects 值 `{bad}`；允许：{allowed}', "ja": '不明な aspects 値 `{bad}`；許可値：{allowed}', "en": 'unknown aspects value `{bad}`; allowed: {allowed}'},
    'frame_no_anchor': {"zh": '无锚点（全库泛化建队）', "ja": 'アンカーなし（ライブラリ全体の汎用構築）', "en": 'no anchor (generic whole-library build)'},
    'frame_header': {"zh": '# 接地骨架（锚点：{anchor}；{fmt}，{n} 支锚点池真实队）— 置信 {conf}', "ja": '# 接地スケルトン（アンカー：{anchor}；{fmt}、アンカープール {n} 件）— 信頼度 {conf}', "en": '# Grounded skeletons (anchor: {anchor}; {fmt}, {n} anchor-pool teams) — confidence {conf}'},
    'frame_subtitle': {"zh": '共 {total} 个结构框架，展示 {shown}（order={order}，按流行度排序、非强度）', "ja": '構造フレーム {total} 件中 {shown} 件を表示（order={order}、流行度順、強さではない）', "en": '{total} structural frames, {shown} shown (order={order}; by prevalence, not strength)'},
    'frame_thin': {"zh": '锚点池薄（{n} < {bar} 支）：低置信=证据薄非队弱，逐成员用 repset/search 接地后再依赖', "ja": 'アンカープールが薄い（{n} < {bar} 件）：低信頼度は証拠が薄いだけでチームが弱い訳ではない。repset/search で各メンバーを接地してから使用', "en": 'THIN anchor pool ({n} < {bar} teams): low confidence = thin EVIDENCE not a weak team; ground per-member via repset/search before relying on it'},
    'frame_meta_fallback': {"zh": 'META_FALLBACK：该锚点无真实联合语法（数据门边界）——从 meta+dex 事实自建并披露低置信', "ja": 'META_FALLBACK：このアンカーに実チームの結合文法なし（データ境界）——meta+dex から自作し低信頼度を開示', "en": 'META_FALLBACK: no real joint grammar for this anchor (data-gated boundary) — assemble from meta+dex facts and disclose low confidence'},
    'frame_structure': {"zh": '结构', "ja": '構造', "en": 'structure'},
    'frame_prevalence': {"zh": '流行度', "ja": '流行度', "en": 'prevalence'},
    'frame_core': {"zh": '核心候选（主轴）', "ja": 'コア候補（主軸）', "en": 'core candidates (main axis)'},
    'frame_open_slots': {"zh": '开放位', "ja": '空き枠', "en": 'open slots'},
    'frame_within_group': {"zh": '组内共现', "ja": 'グループ内共起', "en": 'within-group'},
    'frame_set_guidance': {"zh": '配置参考（非硬锁）', "ja": '型の参考（固定ではない）', "en": 'set guidance (reference, not a lock)'},
    'frame_ungrounded': {"zh": '无 repset 接地（薄/离群）——自建并披露，勿用 meta 拼 set', "ja": 'repset 接地なし（薄い/離群）——自作し開示、meta で型を継ぎ接ぎしない', "en": 'no repset grounding (thin/off-meta) — build it yourself and disclose, do not stitch from meta'},
    'frame_observed_mega': {"zh": '观测 Mega 槽位', "ja": '観測メガ枠', "en": 'observed Mega slots'},
    'frame_mega_is_fact': {"zh": '一条事实，非预留的第二 Mega 位', "ja": '事実であり、予約された二枚目メガ枠ではない', "en": 'a fact, not a reserved second-Mega slot'},
    'frame_observed_fillers': {"zh": '观测开放位填充（描述真实队怎么变化，非待填清单）', "ja": '観測された空き枠の埋め方（実チームの変化の記述であり、埋めるべきリストではない）', "en": 'observed open-slot fillers (how real teams vary here, not a to-fill checklist)'},
    'team_refuse_frame': {"zh": '拒绝：build-context 结构错误，frame 不在半损上下文上运行', "ja": '拒否：build-context の構造エラー。frame は破損したコンテキストでは実行しません', "en": 'refused: malformed build-context; frame does not run on a half-broken context'},
    'team_frame_needs_format': {"zh": 'frame 需要 --game-format single|double（两个环境不混合）', "ja": 'frame には --game-format single|double が必要です（2 つの環境は混在させません）', "en": 'frame needs --game-format single|double (the two metagames are never mixed)'},
    'team_frame_bad_audit_receipt': {"zh": 'frame 需要 context-audit 的完整 audit_receipt 对象（--audit-receipt），不是裸指纹字符串', "ja": 'frame には context-audit の完全な audit_receipt オブジェクト（--audit-receipt）が必要です。指紋の文字列だけではいけません', "en": 'frame needs context-audit\'s FULL audit_receipt object (--audit-receipt), not a bare fingerprint string'},
    'team_frame_audit_mismatch': {"zh": 'audit_receipt 与本 context 的 context-audit 重算不符——context 已改动或回执张冠李戴，请重跑 context-audit', "ja": 'audit_receipt がこの context の context-audit 再計算と一致しません——context が変更されたか、別の回執です。context-audit を再実行してください', "en": 'the audit_receipt does not match a context-audit recompute of THIS context — re-run context-audit'},
    'ct_list_of_strings': {"zh": '`{key}` 必须是字符串列表', "ja": '`{key}` は文字列のリストである必要があります', "en": '`{key}` must be a list of strings'},
    'ct_exclude_tactics_enum': {"zh": '未知战术 `{tok}`；`exclude_tactics` 允许：{allowed}', "ja": '不明な戦術 `{tok}`；`exclude_tactics` の許可値：{allowed}', "en": 'unknown tactic `{tok}`; `exclude_tactics` allows: {allowed}'},
    'ct_style_lean_enum': {"zh": 'style_lean 取值应为 {allowed}（主动进攻/平衡轮换/稳健防守），得到 {got}', "ja": 'style_lean は {allowed} のいずれかが必要です（攻め/バランス/受け）。指定値: {got}', "en": 'style_lean must be one of {allowed} (proactive offense / balanced pivot / solid defense), got {got}'},
    'ct_meta_conformance_enum': {"zh": '`meta_conformance` 必须是 {allowed} 其一（得到 `{got}`）', "ja": '`meta_conformance` は {allowed} のいずれかである必要があります（`{got}` を受領）', "en": '`meta_conformance` must be one of {allowed} (got `{got}`)'},
    'ct_variance_tolerance_enum': {"zh": '`variance_tolerance` 必须是 {allowed} 其一（averse=少运气线 / tolerant=可接受；得到 `{got}`）', "ja": '`variance_tolerance` は {allowed} のいずれかである必要があります（averse=運要素を減らす / tolerant=許容；`{got}` を受領）', "en": '`variance_tolerance` must be one of {allowed} (averse=fewer luck lines / tolerant=fine with them; got `{got}`)'},
    'ct_benchmarks_list': {"zh": '`benchmarks` 必须是列表', "ja": '`benchmarks` はリストである必要があります', "en": '`benchmarks` must be a list'},
    'ct_replace_object': {"zh": '`replace` 必须是对象', "ja": '`replace` はオブジェクトである必要があります', "en": '`replace` must be an object'},
    'ct_replace_member_req': {"zh": '`replace.member`（要移除的 species）为必填', "ja": '`replace.member`（削除する species）は必須です', "en": '`replace.member` (the species to remove) is required'},
    'ct_replace_with_req': {"zh": '`replace.with`（候选 member）为必填', "ja": '`replace.with`（候補 member）は必須です', "en": '`replace.with` (the candidate member) is required'},
    'ct_replace_with_shape': {"zh": '`replace.with` 必须是完整的 member 对象，例如 {"species": "Mimikyu"}，而不是裸名字符串', "ja": '`replace.with` は完全な member オブジェクトである必要があります。例：{"species": "Mimikyu"}。単なる名前の文字列ではありません', "en": '`replace.with` must be a full member object, e.g. {"species": "Mimikyu"}, not a bare name string'},
    'ct_need_object': {"zh": '`need` 必须是对象', "ja": '`need` はオブジェクトである必要があります', "en": '`need` must be an object'},
    'ct_string_or_list': {"zh": '`{key}` 必须是字符串或字符串列表', "ja": '`{key}` は文字列または文字列のリストである必要があります', "en": '`{key}` must be a string or list of strings'},
    'ct_min_speed_int': {"zh": '`min_speed` 必须是整数', "ja": '`min_speed` は整数である必要があります', "en": '`min_speed` must be an integer'},
    'ct_benchmark_object': {"zh": 'benchmark 必须是 JSON 对象', "ja": 'benchmark は JSON オブジェクトである必要があります', "en": 'benchmark must be a JSON object'},
    'ct_benchmark_member': {"zh": 'benchmark 需要一个 `member`', "ja": 'benchmark には `member` が必要です', "en": 'benchmark needs a `member`'},
    'ct_kind_enum': {"zh": 'kind 必须是 {allowed} 其一；得到 {got!r}', "ja": 'kind は {allowed} のいずれかである必要があります；実際は {got!r}', "en": 'kind must be one of {allowed}; got {got!r}'},
    'ct_vs_type': {"zh": '`vs` 必须是 species 名称（或用于 outspeed 的原始 Speed 数值）', "ja": '`vs` は species 名（または outspeed 用の生の Speed 数値）である必要があります', "en": '`vs` must be a species name (or a raw Speed number for outspeed)'},
    'ct_vs_outspeed_only': {"zh": '原始 Speed 的 `vs` 仅对 kind=outspeed 有效，而非 {kind!r}', "ja": '生の Speed の `vs` は kind=outspeed のときのみ有効で、{kind!r} では使えません', "en": 'a raw-Speed `vs` is only valid for kind=outspeed, not {kind!r}'},
    'ct_kind_needs_move': {"zh": 'kind={kind} 需要一个 `move`', "ja": 'kind={kind} には `move` が必要です', "en": 'kind={kind} needs a `move`'},
    'ct_probability_enum': {"zh": 'probability 必须是 {allowed} 其一', "ja": 'probability は {allowed} のいずれかである必要があります', "en": 'probability must be one of {allowed}'},
    'ct_conditions_object': {"zh": '`conditions` 必须是对象', "ja": '`conditions` はオブジェクトである必要があります', "en": '`conditions` must be an object'},
    'ct_unknown_condition': {"zh": '未知条件 `{k}`；允许：{allowed}', "ja": '不明な条件 `{k}`；許可：{allowed}', "en": 'unknown condition `{k}`; allowed: {allowed}'},
    'ct_weather_type': {"zh": '`weather` 必须是字符串或布尔值', "ja": '`weather` は文字列または真偽値である必要があります', "en": '`weather` must be a string or boolean'},
    'ct_terrain_type': {"zh": '`terrain` 必须是命名场地的字符串（例如用于 Surge Surfer 的 "electric"）', "ja": '`terrain` はフィールドを表す文字列である必要があります（例：Surge Surfer 用の "electric"）', "en": '`terrain` must be a string naming the field (e.g. "electric" for Surge Surfer)'},
    'ct_screens_enum': {"zh": '`screens` 必须为 true 或 {allowed} 其一', "ja": '`screens` は true または {allowed} のいずれかである必要があります', "en": '`screens` must be true or one of {allowed}'},
    'ct_bool': {"zh": '`{k}` 必须是布尔值', "ja": '`{k}` は真偽値である必要があります', "en": '`{k}` must be a boolean'},
    'ct_spikes_type': {"zh": '`spikes` 必须是 true/false 或 0..3 的撒菱层数', "ja": '`spikes` は true/false または 0..3 のまきびし段数である必要があります', "en": '`spikes` must be true/false or a Spikes layer count from 0 to 3'},
    'ct_condition_ignored_for_kind': {"zh": '条件 `{k}` 不会被 kind={kind} 消费；它会被忽略', "ja": '条件 `{k}` は kind={kind} では消費されず、無視されます', "en": 'condition `{k}` is not consumed by kind={kind}; it will be ignored'},
    'ct_evidence_object': {"zh": 'evidence 必须是 JSON 对象', "ja": 'evidence は JSON オブジェクトである必要があります', "en": 'evidence must be a JSON object'},
    'ct_facts_list': {"zh": '`facts` 必须是列表', "ja": '`facts` はリストである必要があります', "en": '`facts` must be a list'},
    'ct_confidence_enum': {"zh": 'confidence 必须是 {allowed} 其一', "ja": 'confidence は {allowed} のいずれかである必要があります', "en": 'confidence must be one of {allowed}'},
    'ct_header': {"zh": '契约检查', "ja": 'コントラクトチェック', "en": 'Contract check'},
    'team_name_corrected': {"zh": '⚠ 已将 "{frm}" 识别为 {to}（模糊匹配 d={distance}，置信={score}）— 如不对请改用准确名', "ja": '⚠ "{frm}" を {to} と認識しました（あいまい一致 d={distance}、信頼度={score}）— 誤りの場合は正確な名前を指定してください', "en": '⚠ Recognized "{frm}" as {to} (fuzzy match d={distance}, confidence={score}) — use the exact name if this is wrong'},
    'team_season_mismatch': {"zh": '队伍声明赛季 {team_season}，但 build-context 指定 {ctx_season}；已采用 {ctx_season}（context 覆盖队伍的声明）。', "ja": 'チームはシーズン {team_season} を宣言していますが、build-context は {ctx_season} を指定しています。{ctx_season} を採用しました（context がチームの宣言を上書きします）。', "en": "team declares season {team_season} but build-context says {ctx_season}; used {ctx_season} (context overrides the team's declaration)."},
    'team_rule_mismatch': {"zh": '队伍声明规则 {team_rule}，但 build-context 指定 {ctx_rule}；已采用 {ctx_rule}（context 覆盖队伍的声明）。', "ja": 'チームはルール {team_rule} を宣言していますが、build-context は {ctx_rule} を指定しています。{ctx_rule} を採用しました（context がチームの宣言を上書きします）。', "en": "team declares rule {team_rule} but build-context says {ctx_rule}; used {ctx_rule} (context overrides the team's declaration)."},
    'team_env': {"zh": '环境', "ja": '環境', "en": 'Environment'},
    'team_env_dex': {"zh": 'dex', "ja": 'dex', "en": 'dex'},
    'team_env_meta': {"zh": 'meta', "ja": 'meta', "en": 'meta'},
    'team_data_partition': {"zh": '数据分区', "ja": 'データ区分', "en": 'Data partition'},
    'team_parse_header': {"zh": '队伍（{fmt}，{n} 只 Pokemon）', "ja": 'チーム（{fmt}、{n} 体の Pokemon）', "en": 'Team ({fmt}, {n} Pokemon)'},
    'team_refuse_validate': {"zh": '拒绝校验格式错误的 team-json（请先修正上方的契约错误）。', "ja": '不正な形式の team-json の検証を拒否します（上記の契約エラーを修正してください）。', "en": 'Refusing to validate a malformed team-json (fix the contract errors above).'},
    'team_refuse_diagnose': {"zh": '拒绝诊断格式错误的输入（参见契约错误）。', "ja": '不正な形式の入力の診断を拒否します（契約エラーを参照）。', "en": 'Refusing to diagnose malformed input (see contract errors).'},
    'team_dex_unavailable': {"zh": 'Dex 不可用：{e}', "ja": 'Dex 利用不可：{e}', "en": 'Dex unavailable: {e}'},
    'team_tune_needs_context': {"zh": 'tune 需要带有 `benchmarks` 列表的 --context（schema.md §7）。', "ja": 'tune には `benchmarks` リストを含む --context が必要です（schema.md §7）。', "en": 'tune needs --context with a `benchmarks` list (schema.md §7).'},
    'team_refuse_tune': {"zh": '拒绝在格式错误的输入上执行 tune（参见契约错误）。', "ja": '不正な形式の入力での tune を拒否します（契約エラーを参照）。', "en": 'refusing to tune on malformed input (see contract errors).'},
    'team_no_benchmarks': {"zh": 'build-context 中没有基准；无可调整项。', "ja": 'build-context にベンチマークがありません。調整対象なし。', "en": 'no benchmarks in build-context; nothing to tune.'},
    'team_ncp_rejected_benchmark': {"zh": 'ncp 拒绝了某个基准输入（非阵容内 Pokemon / 未知招式？）：{e}', "ja": 'ncp がベンチマーク入力を拒否しました（ロスター外の Pokemon / 不明な技？）：{e}', "en": 'ncp rejected a benchmark input (off-roster Pokemon / unknown move?): {e}'},
    'team_sibling_unavailable': {"zh": '同级技能不可用：{e}', "ja": '兄弟スキルが利用不可：{e}', "en": 'sibling skill unavailable: {e}'},
    'team_refuse_select': {"zh": '拒绝在格式错误的输入上执行 select（参见契约错误）。', "ja": '不正な形式の入力での select を拒否します（契約エラーを参照）。', "en": 'refusing to select on malformed input (see contract errors).'},
    'team_sibling_dex_unavailable': {"zh": '同级 dex 技能不可用：{e}', "ja": '兄弟 dex スキルが利用不可：{e}', "en": 'sibling dex unavailable: {e}'},
    'team_refuse_matchup': {"zh": '拒绝在格式错误的输入上运行 matchup（参见契约错误）。', "ja": '不正な形式の入力での matchup の実行を拒否します（契約エラーを参照）。', "en": 'refusing to run matchup on malformed input (see contract errors).'},
    'team_meta_unavailable_matchup': {"zh": 'meta 不可用（matchup 需要使用率排名）：{e}', "ja": 'meta 利用不可（matchup には使用率ランキングが必要）：{e}', "en": 'meta unavailable (matchup needs the usage ranking): {e}'},
    'team_ncp_unavailable_damage_skipped': {"zh": 'ncp 不可用，已跳过伤害计算：{e}', "ja": 'ncp 利用不可、ダメージ計算をスキップしました：{e}', "en": 'ncp unavailable, damage skipped: {e}'},
    'team_sibling_meta_unavailable': {"zh": '同级 meta 技能不可用：{e}', "ja": '兄弟 meta スキルが利用不可：{e}', "en": 'sibling meta unavailable: {e}'},
    'team_refuse_replace': {"zh": '拒绝在格式错误的输入上运行 replace（参见契约错误）。', "ja": '不正な形式の入力での replace の実行を拒否します（契約エラーを参照）。', "en": 'refusing to run replace on malformed input (see contract errors).'},
    'team_replace_needs_context': {"zh": 'replace 需要带有 `replace: {member, with: <candidate member>}` 的 --context（schema §7）。', "ja": 'replace には `replace: {member, with: <candidate member>}` を含む --context が必要です（schema §7）。', "en": 'replace needs --context with `replace: {member, with: <candidate member>}` (schema §7).'},
    'team_refuse_fill': {"zh": '拒绝在格式错误的输入上运行 fill（参见契约错误）。', "ja": '不正な形式の入力での fill の実行を拒否します（契約エラーを参照）。', "en": 'refusing to run fill on malformed input (see contract errors).'},
    'team_fill_needs_context': {"zh": 'fill 需要带有 `need` 规格的 --context（resist/offense_type/coverage_move_type/role/min_speed；schema §7）。', "ja": 'fill には `need` 仕様を含む --context が必要です（resist/offense_type/coverage_move_type/role/min_speed；schema §7）。', "en": 'fill needs --context with a `need` spec (resist/offense_type/coverage_move_type/role/min_speed; schema §7).'},
    'team_meta_unavailable_fill': {"zh": 'meta 不可用（fill 需要使用率排名）：{e}', "ja": 'meta 利用不可（fill には使用率ランキングが必要）：{e}', "en": 'meta unavailable (fill needs the usage ranking): {e}'},
    'team_session_unreadable': {"zh": '无法读取会话脚本：{e}', "ja": 'セッション仕様を読み込めません：{e}', "en": 'cannot read session spec: {e}'},
    'team_session_not_list': {"zh": '会话脚本必须是由 {op, ...} 命令组成的 JSON 列表', "ja": 'セッション仕様は {op, ...} コマンドの JSON リストである必要があります', "en": 'session spec must be a JSON list of {op, ...} commands'},
    'team_session_cmd_not_object': {"zh": '命令必须是 JSON 对象，实际得到 {type}', "ja": 'コマンドは JSON オブジェクトである必要がありますが、{type} を受け取りました', "en": 'command must be a JSON object, got {type}'},
    'team_dex_down_query_library': {"zh": 'dex 不可用 — 将按原始名称查询样本库（别名/Mega 未解析）。', "ja": 'dex 利用不可 — 生の名前でライブラリを照会します（別名/Mega は未解決）。', "en": 'dex unavailable — querying the library by the raw name (aliases/Mega unresolved).'},
    'team_dex_unresolved_library': {"zh": 'dex 未能解析 {species} — 将按原始名称查询样本库（非规范别名可能返回空结果）。', "ja": 'dex が {species} を解決できませんでした — 生の名前でライブラリを照会します（非正規の別名は空の結果になる場合があります）。', "en": 'dex did not resolve {species} — querying the library by the raw name (a non-canonical alias may return an empty result).'},
    'team_anchor_form_reconciled': {"zh": '锚点 {query} 未匹配到任何真实队；已改用其在样本库中的存储形态 {resolved}（{n} 支队）——该宝可梦在库中仅以此形态出现。', "ja": 'アンカー {query} は実チームに一致せず；ライブラリでの保存形態 {resolved}（{n} チーム）に切り替えました——このポケモンはライブラリ内でこの形態のみで出現します。', "en": 'anchor {query} matched no real teams; switched to its stored library form {resolved} ({n} teams) — this mon appears in the library only under that form.'},
    'team_anchor_form_ambiguous': {"zh": '锚点 {query} 未匹配到任何真实队；库中存在多个对应形态：{options}——请指定具体形态。', "ja": 'アンカー {query} は実チームに一致せず；ライブラリに複数の対応形態があります：{options}——具体的な形態を指定してください。', "en": 'anchor {query} matched no real teams; the library has multiple matching forms: {options} — specify the exact form.'},
    'team_repset_none': {"zh": '**{title}**（{fmt}）没有真实队伍代表集：使用它的真实队伍数量低于最小样本量。请改用 meta 回退解析对手配置。', "ja": '**{title}**（{fmt}）の実チーム代表セットがありません：これを採用する実チームが最小サンプル数を下回っています。代わりに meta フォールバックで相手のセットを解決してください。', "en": 'No real-team representative set for **{title}** ({fmt}): fewer than the minimum sample of real teams run it. Resolve opponent sets via meta fallback instead.'},
    'team_repset_archetypes_title': {"zh": '真实队伍原型（{fmt}）', "ja": '実チームのアーキタイプ（{fmt}）', "en": 'real-team archetypes ({fmt})'},
    'team_repset_subtitle': {"zh": '来自真实队伍样本库的共现配置，按出现率排列。仅为事实，非排名。', "ja": '実チームライブラリからの共起ビルドを出現率順に表示。ランキングではなく事実です。', "en": 'Co-occurring builds from the real-team library, by prevalence. Facts, not a ranking.'},
    'team_repset_pool_filtered': {"zh": '样本池已按 `{item_filter}` 过滤：{total} 支 {resolved} 真实队伍中有 {pool} 支持有它 — 下方的覆盖率/样本均基于此过滤后的池。', "ja": 'プールを `{item_filter}` で絞り込み：{resolved} の実チーム {total} 支のうち {pool} 支が保持 — 以下のカバレッジ/サンプルはこの絞り込み済みプール内のものです。', "en": 'Pool filtered to `{item_filter}`: {pool} of {total} {resolved} real teams hold it — coverage/sample below are within this filtered pool.'},
    'team_repset_pool_word_filtered': {"zh": ' 占该 {pool_n} 支 {item_filter} 池队伍', "ja": ' （{pool_n} 支の {item_filter} プールチーム中）', "en": ' of the {pool_n} {item_filter}-pool teams'},
    'team_repset_pool_word': {"zh": ' 占全部队伍', "ja": ' （全チーム中）', "en": ' of teams'},
    'team_repset_covers': {"zh": '覆盖 {cov}', "ja": 'カバー {cov}', "en": 'covers {cov}'},
    'team_repset_fragmented': {"zh": '碎片化 — 无主导的道具/特性原型（池 {sample} 支队伍）', "ja": '断片的 — 支配的なアイテム/特性アーキタイプなし（プール {sample} チーム）', "en": 'fragmented — no dominant item/ability archetype (pool {sample} teams)'},
    'team_repset_modal_set': {"zh": '众数配置', "ja": '最頻セット', "en": 'modal set'},
    'team_repset_share': {"zh": '占比', "ja": '占有率', "en": 'share'},
    'team_repset_moves': {"zh": '招式', "ja": '技', "en": 'moves'},
    'team_repset_sp_real': {"zh": 'SP 配点（真实共现）：{sps}', "ja": 'SP 配分（実共起）：{sps}', "en": 'SP spread (real co-occurring): {sps}'},
    'team_repset_sp_none': {"zh": 'SP 配点：来源中无（请使用 meta 配点）', "ja": 'SP 配分：ソースになし（meta 配分を使用）', "en": 'SP spread: not in source (use meta spread)'},
    'team_repset_needs_format': {"zh": 'repset 需要 --game-format single|double（不同 metagame 永不混用）。', "ja": 'repset には --game-format single|double が必要です（metagame は決して混在させません）。', "en": 'repset requires --game-format single|double (metagames are never mixed).'},
    'team_repset_max_clusters': {"zh": 'repset --max-clusters 必须 >= 1。', "ja": 'repset --max-clusters は >= 1 である必要があります。', "en": 'repset --max-clusters must be >= 1.'},
    'team_repset_failed': {"zh": 'repset 失败：{e}', "ja": 'repset が失敗しました：{e}', "en": 'repset failed: {e}'},
    'team_oppmatrix_needs_format': {"zh": 'oppmatrix 需要 --game-format single|double（不同 metagame 永不混用）。', "ja": 'oppmatrix には --game-format single|double が必要です（metagame は決して混在させません）。', "en": 'oppmatrix requires --game-format single|double (metagames are never mixed).'},
    'team_oppmatrix_no_cache': {"zh": '{season}/{fmt} 没有对手缓存 — 用 `python dev/update/update.py team-cache --format {fmt}` 构建它。', "ja": '{season}/{fmt} の相手キャッシュがありません — `python dev/update/update.py team-cache --format {fmt}` で構築してください。', "en": 'No opponent-cache for {season}/{fmt} — build it with `python dev/update/update.py team-cache --format {fmt}`.'},
    'team_oppmatrix_vs_needs_attacker': {"zh": 'oppmatrix --vs 还需要一个攻击方 species。', "ja": 'oppmatrix --vs には攻撃側の species も必要です。', "en": 'oppmatrix --vs needs an attacker species too.'},
    'team_dex_down_query_cache': {"zh": 'dex 不可用 — 将按原始名称查询缓存（别名/Mega 未解析）。', "ja": 'dex 利用不可 — 生の名前でキャッシュを照会します（別名/Mega は未解決）。', "en": 'dex unavailable — querying the cache by the raw name (aliases/Mega unresolved).'},
    'team_dex_unresolved_cache': {"zh": 'dex 未能解析 {name} — 将按原始名称查询缓存。', "ja": 'dex が {name} を解決できませんでした — 生の名前でキャッシュを照会します。', "en": 'dex did not resolve {name} — querying the cache by the raw name.'},
    'team_search_title': {"zh": '样本库检索（{fmt}）', "ja": 'サンプルライブラリ検索（{fmt}）', "en": 'Sample-library search ({fmt})'},
    'team_search_summary': {"zh": '命中 {match} / 扫描 {scanned} 支队伍。', "ja": '{scanned} 件中 {match} 件が一致。', "en": '{match} of {scanned} teams matched.'},
    'team_search_unresolved': {"zh": '未解析的条件（按字面过滤，0 结果可能是关键词而非数据）：{u}', "ja": '未解決の条件（文字通りに絞り込み。0 件はデータではなくキーワードの可能性）：{u}', "en": 'Unresolved conditions (filtered literally; a 0 result may be the keyword, not the data): {u}'},
    'team_search_variants': {"zh": '{n} 个变体', "ja": '{n} バリアント', "en": '{n} variants'},
    'team_search_cross_season': {"zh": '_跨赛季检索（含旧规则）——每支队伍以自身 `season` 标注_', "ja": '_全シーズン横断検索（旧レギュ含む）——各チームは自身の `season` で識別_', "en": '_Cross-season search (incl. old regulations) — each team labeled by its own `season`_'},
    'team_show_not_found': {"zh": '未找到 id 为 {id} 的队伍（库刷新后内容变化会改变 id）。', "ja": 'id {id} のチームが見つかりません（ライブラリ更新で内容が変わると id も変わります）。', "en": 'No team with id {id} (a library refresh that changes content changes the id).'},
    'team_search_bad_input': {"zh": '检索请求无效：{e}', "ja": '検索リクエストが不正です：{e}', "en": 'Invalid search request: {e}'},
    'team_observed_disclosure': {"zh": 'AI 面向的真实观测队原始数据——请先聚合/归纳再示人，勿逐字回显整队（库护栏）；面向用户的聚合视图用 repset。',
                                 "ja": 'AI 向けの実観測チーム生データ——提示前に集約/要約を。実チームをそのまま丸ごとユーザーへ出さないこと（ライブラリガードレール）；ユーザー向け集約は repset。',
                                 "en": 'AI-facing raw observed-team data — summarize/aggregate before presenting; do not echo whole real teams verbatim (library guardrail). Use repset for a user-facing aggregate.'},
    'team_cli_description': {"zh": 'Pokemon Champions 队伍 CLI。', "ja": 'Pokemon Champions チーム CLI。', "en": 'Pokemon Champions team CLI.'},
    'vocab_title': {"zh": '词表 + 字段消费状态', "ja": '語彙 + フィールド消費状態', "en": 'Vocabulary + field consumption'},
    'vocab_roles': {"zh": '功能角色词表', "ja": '機能ロール語彙', "en": 'Functional role vocabulary'},
    'vocab_field_status': {"zh": '字段消费状态（哪个字段被谁机械消费）', "ja": 'フィールド消費状態（どのフィールドが何に消費されるか）', "en": 'Field status (which field is mechanically consumed by what)'},
    'team_select_legality_warn': {"zh": '已注册队伍的合法性为 **{status}**（未认证为合法）；请运行 `validate` — 下方的选出均假设队伍合法。', "ja": '登録チームの合法性は **{status}**（合法と認証されていません）；`validate` を実行してください — 以下の選出は合法なチームを前提としています。', "en": 'registered team legality is **{status}** (not certified valid); run `validate` — picks below assume a legal team.'},
    'opp_matrix_head': {"zh": '# 对手标准配置对位矩阵（{fmt}）— top-{top_k}，{conf} 置信度（{reason}）；仅为事实，非评分', "ja": '# 相手の標準構成対面マトリクス（{fmt}）— top-{top_k}、{conf} 信頼度（{reason}）；スコアではなく事実', "en": '# Opponent standard-set matrix ({fmt}) — top-{top_k}, {conf} confidence ({reason}); facts, not a score'},
    'opp_built_for': {"zh": '_built_for {season}/{rule} @ {built_at} — 标准配置对标准配置的参考；请用你的真实队伍实时对位。_', "ja": '_built_for {season}/{rule} @ {built_at} — 標準構成対標準構成の参考；実際のチームでリアルタイムに対面すること。_', "en": '_built_for {season}/{rule} @ {built_at} — standard-vs-standard reference; match your real team live._'},
    'opp_no_attacker_row': {"zh": '## {ai}\n- 无攻击方行：{why}。', "ja": '## {ai}\n- 攻撃側の行なし：{why}。', "en": '## {ai}\n- no attacker row: {why}.'},
    'opp_why_meta_only': {"zh": '非真实队伍支撑（仅 meta — 无真实联合招式组，仅作防守方）', "ja": '実チーム裏付けなし（meta のみ — 実際の技セットなし、防御側のみ）', "en": 'not real-team-backed (meta-only — no real joint move set, defender only)'},
    'opp_why_not_topk': {"zh": '不在缓存的 top-K 内', "ja": 'キャッシュされた top-K に含まれない', "en": 'not in the cached top-K'},
    'opp_attacker_head': {"zh": '## {ai} — {item} / {ability} / {nature}（标准配置 {conf}，{source}）', "ja": '## {ai} — {item} / {ability} / {nature}（標準構成 {conf}、{source}）', "en": '## {ai} — {item} / {ability} / {nature} (set {conf}, {source})'},
    'opp_moves': {"zh": '招式', "ja": '技', "en": 'moves'},
    'opp_not_in_matrix': {"zh": '- 对位 **{dj}**：不在矩阵中', "ja": '- 対面 **{dj}**：マトリクスにない', "en": '- vs **{dj}**: not in matrix'},
    'opp_arrow_outspeeds': {"zh": '速度更快', "ja": '素早さ上', "en": 'outspeeds'},
    'opp_arrow_slower': {"zh": '速度更慢', "ja": '素早さ下', "en": 'slower than'},
    'opp_arrow_tie': {"zh": '速度持平', "ja": '素早さ同速', "en": 'speed-ties'},
    'opp_arrow_unknown': {"zh": '速度未知', "ja": '素早さ不明', "en": 'speed ?'},
    'opp_vs_line': {"zh": '- 对位 **{dj}**：{arrow}（{a_spe} vs {d_spe}）；我方→对方：{ko}', "ja": '- 対面 **{dj}**：{arrow}（{a_spe} vs {d_spe}）；自分→相手：{ko}', "en": '- vs **{dj}**: {arrow} ({a_spe} vs {d_spe}); we→them: {ko}'},
    'opp_empty_matrix': {"zh": '\n（空矩阵 — 当前样本库中没有真实队伍支撑的攻击方。）', "ja": '\n（空のマトリクス — 現在のライブラリに実チーム裏付けの攻撃側がない。）', "en": '\n(empty matrix — no real-team-backed attacker in the current library.)'},
    'env_season_mismatch': {"zh": '构建上下文 season {season!r} != 当前基准 {base!r}；按当前基准计算（该 skill 仅服务当前环境）。', "ja": 'ビルドコンテキスト season {season!r} != 現在の基準 {base!r}；現在の基準で計算（この skill は現在の環境のみを対象とする）。', "en": 'build-context season {season!r} != current base {base!r}; computed against the current base (the skill only serves the current environment).'},
    'env_rule_mismatch': {"zh": '构建上下文 rule {rule!r} != 当前基准 {base!r}；按当前基准计算。', "ja": 'ビルドコンテキスト rule {rule!r} != 現在の基準 {base!r}；現在の基準で計算。', "en": 'build-context rule {rule!r} != current base {base!r}; computed against the current base.'},
    # === tune.py (format_tune_md) ================================================================
    'tn_title': {"zh": 'Tune — SP 微调悬崖（{fmt}）', "ja": 'Tune — SP 微調整クリフ（{fmt}）', "en": 'Tune — SP fine-tuning cliffs ({fmt})'},
    'tn_no_cards': {"zh": '没有悬崖卡片（无可解析的基准）。', "ja": 'クリフカードなし（解決できたベンチマークなし）。', "en": 'No cliff cards (no benchmarks resolved).'},
    'tn_nature_unlock_tag': {"zh": '[某条性格路线可解锁此项]', "ja": '[性格レーンでこれを解放できる]', "en": '[a nature lane can UNLOCK this]'},
    'tn_guaranteed': {"zh": '确定', "ja": '確定', "en": 'guaranteed'},
    'tn_not_guaranteed': {"zh": '{pct}%（不保证）', "ja": '{pct}%（保証なし）', "en": '{pct}% (NOT guaranteed)'},
    'tn_recovery_note': {"zh": '回复（树果/吃剩的东西）可化解静态 KO；以此为准', "ja": '回復（きのみ／たべのこし）で静的 KO を防げる；これを信頼', "en": 'recovery (berry/Leftovers) can deny the static KO; trust this'},
    'tn_engine_ko': {"zh": '引擎 KO%（考虑回复）于悬崖处', "ja": 'エンジン KO%（回復考慮）クリフ地点', "en": 'engine KO% (recovery-aware) at the cliff'},
    'tn_unlocks': {"zh": '解锁', "ja": '解放', "en": 'UNLOCKS'},
    'tn_saves_sp': {"zh": '节省 {n} SP', "ja": '{n} SP 節約', "en": 'saves {n} SP'},
    'tn_need_to': {"zh": ' 至 {total}', "ja": ' {total} まで', "en": ' to {total}'},
    'tn_nature_lane': {"zh": '性格路线', "ja": '性格レーン', "en": 'nature lane'},
    'tn_opportunity_cost': {"zh": '机会成本', "ja": '機会コスト', "en": 'opportunity cost'},
    'tn_nature_note': {"zh": '性格备注', "ja": '性格メモ', "en": 'nature note'},
    'tn_intimidate_lane': {"zh": '威吓路线（-1 攻）', "ja": 'いかくレーン（-1 こうげき）', "en": 'Intimidate lane (-1 Atk)'},
    'tn_tailwind_lane': {"zh": '顺风路线（速度 x2）', "ja": 'おいかぜレーン（素早さ x2）', "en": 'Tailwind lane (x2 Speed)'},
    'tn_sr_lane': {"zh": '无隐形岩路线', "ja": 'ステルスロックなしレーン', "en": 'no-Stealth-Rock lane'},
}
