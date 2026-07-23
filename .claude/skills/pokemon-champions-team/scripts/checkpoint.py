#!/usr/bin/env python
"""Mid-build checkpoint for AI orchestration.

This is not a recommendation gate.  Slate already attaches neutral 6-pick-N selection facts; this
operator exposes unresolved user-steering decisions after viable frames are known and before tuning.
"""
from __future__ import annotations

from typing import Any


def _refuse(code: str, reason: str) -> dict[str, Any]:
    return {"kind": "checkpoint", "refused": {"code": code, "reason": reason}}


def _team_species(team: dict[str, Any]) -> list[str]:
    return [m.get("species") for m in team.get("pokemon", []) if isinstance(m, dict) and m.get("species")]


def _candidate(slate_output: dict[str, Any], i: int) -> dict[str, Any]:
    cs = slate_output.get("candidates") if isinstance(slate_output.get("candidates"), list) else []
    c = cs[i] if 0 <= i < len(cs) else {}
    return c if isinstance(c, dict) else {}


def _low_confidence(c: dict[str, Any]) -> bool:
    return ((c.get("legality") or {}).get("confidence") == "low"
            or (c.get("matchup_risk") or {}).get("confidence") == "low")


def _frame(team: dict[str, Any], c: dict[str, Any], survivor: bool, index: int) -> dict[str, Any]:
    mr = c.get("matchup_risk") or {}
    elim = c.get("eliminated")
    return {
        "index": c.get("index", index),
        "survivor": survivor,
        "team_species": _team_species(team),
        "legality": (c.get("legality") or {}).get("status"),
        "constraints": c.get("constraint_satisfaction"),
        "mega_plan": c.get("mega_plan"),
        "objective_flags": c.get("flags") or [],
        "matchup_snapshot": {
            "we_ohko_guaranteed": len(mr.get("opponents_we_ohko_guaranteed") or {}),
            "guaranteed_ohko_on_us": len(mr.get("opponents_with_guaranteed_ohko_on_us") or {}),
            "speed_pairs_member_faster": mr.get("speed_pairs_member_faster"),
            "speed_pairs_total": mr.get("speed_pairs_total"),
            "confidence": mr.get("confidence"),
        } if mr else None,
        "eliminated": elim,
        "library_overlap": c.get("library_overlap"),
    }


def build_checkpoint(slate_input: Any, slate_output: Any) -> dict[str, Any]:
    """Return the pause contract for a post-slate, pre-tune build step."""
    if not isinstance(slate_input, dict) or not isinstance(slate_input.get("teams"), list):
        return _refuse("bad_slate", "original slate input with teams is required")
    if not isinstance(slate_output, dict) or slate_output.get("kind") != "slate-evaluate":
        return _refuse("bad_slate_output", "saved slate-evaluate output is required")
    if slate_output.get("refused"):
        return _refuse("slate_refused", "checkpoint is only meaningful after a non-refused slate-evaluate")
    cands = slate_output.get("candidates")
    if not isinstance(cands, list) or len(cands) != len(slate_input["teams"]):
        return _refuse("slate_mismatch",
                       "the saved slate output does not describe this slate input (candidate count "
                       "!= team count) — pass the slate.json and the output.json from the SAME run")
    # checkpoint is an ADVISORY pause contract, NOT a link in the capability-chain (context-audit ->
    # slate-evaluate -> answer-audit): it does not recompute/re-bind the slate fingerprint — that hard
    # rebinding is answer-audit's job. It DOES require the output to carry a slate_receipt fingerprint,
    # so an output that never came from a real slate-evaluate is rejected rather than framed; a
    # same-count output from a DIFFERENT run is still only caught downstream by answer-audit's
    # fingerprint recompute (audit 2026-07-06).
    if not (slate_output.get("slate_receipt") or {}).get("fingerprint"):
        return _refuse("slate_unreceipted",
                       "the slate output has no slate_receipt fingerprint — it did not come from a real "
                       "slate-evaluate; pass the saved output of a genuine run")

    ctx = slate_input.get("context") if isinstance(slate_input.get("context"), dict) else {}
    survivors = [i for i in (slate_output.get("survivors") or []) if isinstance(i, int)]
    survivor_set = set(survivors)
    frames = [_frame(team, _candidate(slate_output, i), i in survivor_set, i)
              for i, team in enumerate(slate_input["teams"])]

    open_decisions: list[dict[str, Any]] = []
    if len(survivors) > 1:
        open_decisions.append({
            "kind": "candidate_frame",
            "candidate_indices": survivors,
            "reason": "multiple slate survivors remain; the user can steer which frame to tune further",
        })
    mega_slate = (slate_output.get("mega_registration_slate")
                  if isinstance(slate_output.get("mega_registration_slate"), dict) else {})
    if mega_slate.get("status") == "missing_modal_lane":
        open_decisions.append({
            "kind": "mega_registration_coverage",
            "candidate_indices": mega_slate.get("assessed_survivors") or survivors,
            "reason": "no survivor is modal relative to its bound frame's observed Mega-registration "
                      "distribution; add an observed-mainline lane or explicitly choose a "
                      "different mega_posture before finalizing",
        })
    if not ctx.get("benchmarks"):
        open_decisions.append({
            "kind": "tuning_benchmarks",
            "reason": "no explicit survival, speed, or KO benchmark is present; continuing means "
                      "tuning_summary must disclose that no cliff tuning was run",
        })
    low_conf = [f["index"] for f in frames if f["survivor"] and _low_confidence(_candidate(slate_output, f["index"]))]
    if low_conf:
        open_decisions.append({
            "kind": "low_confidence_facts",
            "candidate_indices": low_conf,
            "reason": "some surviving frames rely on low-confidence facts and need user-visible caveats",
        })
    copied = [f["index"] for f in frames if f["survivor"]
              and ((f.get("library_overlap") or {}).get("verbatim_ids"))]
    if copied:
        open_decisions.append({
            "kind": "observed_team_overlap",
            "candidate_indices": copied,
            "reason": "a surviving frame matches an observed stored team; final output needs provenance "
                      "if that frame is presented",
        })

    pause_decisions = [d for d in open_decisions if d.get("kind") != "tuning_benchmarks"]
    skip_requested = ctx.get("skip_checkpoint") is True or ctx.get("direct_final") is True
    pause = bool(survivors and pause_decisions and not skip_requested)

    # `text` ships zh/ja/en together (language-invariant JSON, same convention as the intake catalog):
    # these are the questions the AI poses to the user at the pause, so the reviewed wording must be
    # available in every language the skill answers in — a Chinese-only string forced the orchestrator
    # to ad-hoc-translate for en/ja users (audit 2026-07-06).
    questions = []
    if pause and any(d["kind"] == "candidate_frame" for d in open_decisions):
        questions.append({"id": "candidate_frame", "text": {
            "zh": "要继续推进哪些候选框架，还是先调整必须保留/避免的成员？",
            "ja": "どの候補フレームを進めますか？それとも先に必須／回避メンバーを調整しますか？",
            "en": "Which candidate frames should we carry forward, or adjust the must-keep / must-avoid members first?"}})
    if pause and any(d["kind"] == "mega_registration_coverage" for d in open_decisions):
        questions.append({"id": "mega_registration_coverage", "text": {
            "zh": "当前候选没有覆盖其框架中观察最常见的 Mega 登记数量；补一条该路线，还是明确选择单/多/无 Mega 的其他登记姿态？",
            "ja": "現在の候補には各フレームで最頻のメガ登録数が含まれていません。そのルートを追加しますか、それとも単一・複数・メガなしの別方針を明示しますか？",
            "en": "No survivor is modal relative to its bound frame's observed Mega-registration distribution. Add a modal lane, or explicitly choose a different single/multi/none Mega posture?"}})
    if pause and any(d["kind"] == "observed_team_overlap" for d in open_decisions):
        questions.append({"id": "observed_team_overlap", "text": {
            "zh": "有候选与库中某支真实队完全一致——直接采用（会标注来源出处），还是据此另作一支更贴合你需求的？",
            "ja": "ある候補がライブラリの実チームと完全一致します——出典を明記してそのまま採用しますか？それを土台に、より要望に合う別案を作りますか？",
            "en": "A candidate exactly matches a real team in the library — adopt it as-is (with source provenance shown), or build a variant that fits your needs better?"}})
    if pause and any(d["kind"] == "low_confidence_facts" for d in open_decisions):
        questions.append({"id": "low_confidence_facts", "text": {
            "zh": "有候选依赖低置信度的对战事实（模态对手集/降级数据）——接受并在答案中标注，还是换用更确定的框架？",
            "ja": "ある候補は信頼度の低い対戦事実（最頻の相手構成／劣化データ）に依存しています——回答で明記して受け入れますか？より確実なフレームに切り替えますか？",
            "en": "A candidate relies on low-confidence battle facts (modal opponent sets / degraded data) — accept and flag it in the answer, or switch to a more certain frame?"}})
    if pause and any(d["kind"] == "tuning_benchmarks" for d in open_decisions):
        questions.append({"id": "tuning_benchmarks", "text": {
            "zh": "是否要指定速度、耐久或击杀 benchmark；没有的话将只披露未运行针对性调参。",
            "ja": "素早さ・耐久・確定数（KO）のベンチマークを指定しますか？なければ、狙った調整は未実施である旨のみ開示します。",
            "en": "Set any speed, bulk, or KO benchmarks? Without them, the answer just discloses that no targeted tuning was run."}})

    return {
        "kind": "checkpoint",
        "consumer": "ai-orchestration",
        "stage": "post_slate_pre_tune",
        "pause": pause,
        "pause_reason": "open build decisions remain after slate-evaluate" if pause else None,
        "format": slate_output.get("format"),
        "survivors": survivors,
        "candidate_frames": frames,
        "open_decisions": open_decisions,
        "questions_to_ask": questions[:3],
        "trigger_policy": {
            "pause_when": [
                "a build request has one or more slate survivors and unresolved candidate-frame, "
                "Mega-registration coverage, confidence, or provenance decisions (missing tuning benchmarks "
                "ALONE do not pause — see do_not_pause_when; every pausing decision carries a matching "
                "questions_to_ask entry, so pause=true never comes back with an empty question list)",
                "run after context-audit/landscape or observed grounding/slate-evaluate and before "
                "tune or final answer",
            ],
            "do_not_pause_when": [
                "the context sets `skip_checkpoint` or `direct_final` (a diagnosis / validation / "
                "review / audit / final-output intent encodes that upstream; checkpoint itself no "
                "longer inspects a request-kind field — only these explicit flags suppress the pause)",
                "there are zero survivors; revise the slate instead of asking for frame confirmation",
                "there is exactly one survivor and the only open decision is absent tuning benchmarks "
                "(continue and disclose not_run in tuning_summary)",
                "neutral 6-pick-N selection facts are already attached to slate survivors; checkpoint "
                "does not pause merely because a team registers multiple Mega options",
            ],
        },
        "slate_receipt": slate_output.get("slate_receipt"),
    }
