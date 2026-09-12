#!/usr/bin/env python
"""Assembly front-door (UEP P4.5): hand the AI a DATA-GROUNDED skeleton before it assembles, so the
one uncovered creative step — `[assemble candidates]` — cannot be hand-waved from the training prior.

Why this exists (the observed failure, design §19.2.C):
A capable AI's dominant failure is NOT an illegal team (validate/diagnose catch those) — it is
MODE-COLLAPSE at assembly: it consults the anchor's repset, then hand-writes the other five members
from its prior (a real session gave Crabominable @ Life Orb while 9/9 real teams run @ Crabominite).
landscape EXPOSES the real structural distribution but the AI can read it and ignore it — exposure is
passive. `frame` makes grounding LOAD-BEARING: it extracts, from real joint teams (repset primary),
the recurring core + its real (item,ability) sets, and the slate gate later binds each candidate's
core-bearer sets against that repset evidence (design §19.10, the third anti-mode-collapse leg after
① the convergence scaffold and ② landscape exposure).

What it is NOT (hard boundaries — same as every library operator, pinned by tests):
- NOT a team retriever. A skeleton is an AGGREGATE (co-occurrence within a structural group + per-species
  repset), never a verbatim stored team; it always leaves >= 1 flex slot open. If the AI's finished team
  happens to reproduce a stored one, the EXISTING library guardrail (libsearch.library_copy_index +
  answer-audit observed_provenance) is what fires — frame does not re-solve netdecking.
- NO composite score, NO winner, NO "best archetype". Skeletons carry counts/share/confidence and are
  ordered by PREVALENCE (a view ordering under the meta_conformance knob, exactly like landscape.order),
  never scored. The banned-vocabulary guard (best_*/recommended_*/*_score/strength/fit) walks the tree.
- Meta is AUXILIARY only (design §19.3 two populations): grounded sets come ONLY from repset (real
  joint). A member with no repset is left ungrounded (set null) + honest disclosure — frame NEVER
  stitches a joint set out of meta item/move/nature marginals.
- Structural facts are FACTS: `structural_profile` reports the group's speed_control modes / role norms
  through the shared profile vocabulary; it never names a team type. `frame_id` is a mechanical hash,
  not a team-name template.

Anti-mediocrity (design §19.10, the subtle one): frame emits EVERY structural group clearing MIN_SAMPLE,
ordered by the knob (proven=common-first / off_meta=rare-first over the SAME facts); a display cap only
trims the generic popular tail, and any group carrying a constraint member (anchor/prefer/locked) is
retained regardless — so an expressive / off-meta anchor's low-support-but-real frame is never
suppressed (that suppression would re-manufacture the very mode-collapse this operator exists to break).

Tier 1 (current): a shallow partition by the profile's speed_control signature + repset attachment —
mostly orchestration of landscape/repset/team_profile. Tier 2 (profile-vector clustering) lands only if
Tier-1 groups prove to blend distinct archetypes.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from typing import Any, Callable

import team_profile
import team_i18n as i18n
from canonhash import content_hash as _content_hash
from landscape import THIN_BAR, _matches, _team_species, _filter_label
from mega_facts import OBSERVED_NORM_MIN_SAMPLE, mega_slot_distribution
from repset import MIN_SAMPLE, representative_sets_from_teams

# A species must co-occur in at least this share of a structural GROUP's teams to be a core candidate
# (the recurring backbone), AND clear MIN_SAMPLE in absolute count. Tunable; 0.5 = "a majority of the
# archetype's real teams run it". Below it a species is a flex-slot FILLER (observed_facts), not core.
CORE_SUPPORT = 0.5
# Cap core candidates so a skeleton always leaves >= 1 open flex slot (never a full-6 skeleton — that
# would be a verbatim-team by the back door; the library guardrail is the netdeck backstop, not frame).
MAX_CORE = 5
# Display cap for the generic (no-anchor) case where the whole library partitions into many groups.
# Anchor frames are never capped below constraint-relevant retention (see module docstring).
MAX_FRAMES = 8


def frame_fingerprint(audit_fp: str | None, skeletons: list[dict[str, Any]],
                      anchor: list[str] | None, fmt: str) -> str:
    """The frame_receipt fingerprint: audit fp (chain continuity) + a content digest of the emitted
    skeletons + anchor + format. Extracted so the slate gate RECOMPUTES the same construction from the
    saved frame output (tamper-evident: an edited skeleton — e.g. a widened core cluster to sneak an
    ungrounded set past the binding — will not reproduce this fingerprint)."""
    return _content_hash({"audit": audit_fp,
                          "skeletons": [_content_hash(s, 16) for s in skeletons],
                          "anchor": sorted(anchor or []), "format": fmt}, 24)


def make_receipt(audit_fp: str | None, skeletons: list[dict[str, Any]],
                 anchor: list[str] | None, fmt: str) -> dict[str, Any]:
    """The frame_receipt the slate gate consumes (extends the chain: audit -> frame -> slate). The
    fingerprint is tamper-evident (recomputed by slate from the saved frame output)."""
    return {
        "kind": "frame_receipt",
        "fingerprint": frame_fingerprint(audit_fp, skeletons, anchor, fmt),
        "framed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "audit_fingerprint": audit_fp,
        "format": fmt,
    }


# The archetype-DEFINING speed-control axes. `soft` (Icy Wind / Thunder Wave foe-side slowdown) is
# deliberately excluded from the group KEY — it is supplementary, carried by many teams across every
# archetype, so keying on it fragments the pool into combinatorial noise (soft+tailwind, soft+trickroom…)
# without separating real archetypes. It is still reported in each frame's structural_profile.
_DEFINING_MODES = ("trickroom", "tailwind", "ability", "scarf")


def _mode_signature(profile: dict[str, Any]) -> tuple[str, ...]:
    """The team's structural GROUP key: its DEFINING speed-control modes (Trick Room / Tailwind /
    weather-ability / scarf), sorted; ('none',) when it carries none of them. Tier-1 shallow partition
    — the full profile vector is the Tier-2 clustering key if these groups prove to blend archetypes
    (e.g. sun vs rain both fold to 'ability' here; that is the documented Tier-1 boundary)."""
    modes = set((profile.get("speed_control_mode") or {}).get("modes") or [])
    defining = tuple(sorted(m for m in modes if m in _DEFINING_MODES))
    return defining or ("none",)


def _cooccurrence(teams: list[dict[str, Any]], exclude: set[str]) -> dict[str, int]:
    """{species: # teams in the group that carry it}, excluding the anchor species (which is core by
    construction). Presence per team (deduped), the same yardstick landscape's observed_cores uses."""
    co: Counter = Counter()
    for t in teams:
        for sp in _team_species(t):
            if sp and sp not in exclude:
                co[sp] += 1
    return dict(co)


def _grounding_for(species: str, fmt: str, group_teams: list[dict[str, Any]],
                   all_teams: list[dict[str, Any]], item: str | None) -> dict[str, Any] | None:
    """Attach the species' REAL repset archetypes as the grounded set + the valid (item,ability)
    clusters the slate binding checks against. Prefer the GROUP-specific archetype (faithful to this
    frame's structure); fall back to the species' library-wide archetype when the group is too thin
    (template-eligible < MIN_SAMPLE), tagged `set_source` for honesty. None when neither clears the bar
    (truly off-meta / thin) — the caller leaves the set ungrounded and discloses it (meta is NEVER
    stitched into a joint set here)."""
    for teams, src in ((group_teams, "group"), (all_teams, "species-overall")):
        reps = representative_sets_from_teams(species, fmt, teams, item=item)
        if reps:
            primary = reps[0]
            clusters = [r["cluster"] for r in reps if r.get("cluster")]
            if not clusters and primary.get("item") is not None:  # fragmented fallback: single global modal
                clusters = [{"item": primary.get("item"), "ability": primary.get("ability")}]
            ref = f"repset:{species}:{fmt}" + (f":{src}" if src != "group" else "")
            return {
                "primary": {k: primary.get(k) for k in
                            ("item", "ability", "nature", "moves", "sps", "spread_origin",
                             "share", "coverage", "confidence")},
                "clusters": clusters,               # the (item,ability) pairs the binding accepts as grounded
                "set_source": src,
                "grounding_ref": ref,
                "fragmented": bool(primary.get("fragmented")),
            }
    return None


def _skeleton(sig: tuple[str, ...], group: list[tuple[dict, dict]], *, fmt: str,
              pool_size: int, pool_cooccur: dict[str, int],
              pool_mega_distribution: dict[str, Any],
              anchor_members: list[dict[str, Any]], all_teams: list[dict[str, Any]],
              meta_fn: Callable[[str], dict | None] | None) -> dict[str, Any]:
    """Build one grounded skeleton over a structural group. `group` = [(team, profile), ...]; `sig` is
    the group's speed_control signature (or ('__all__',) for the unpartitioned single frame)."""
    g_teams = [t for t, _ in group]
    g_profs = [p for _, p in group]
    n = len(g_teams)
    anchor_species = [m["species"] for m in anchor_members]
    anchor_item = {m["species"]: m.get("item") for m in anchor_members}
    cooccur = _cooccurrence(g_teams, set(anchor_species))

    # --- structural_profile: the group's structure through the shared profile vocabulary (FACTS) ----
    mode_presence: Counter = Counter()
    role_presence: Counter = Counter()
    role_hists: dict[str, Counter] = {}
    for p in g_profs:
        for mode in (p.get("speed_control_mode") or {}).get("modes") or []:
            mode_presence[mode] += 1
        for tag, rc in (p.get("role_composition") or {}).items():
            if rc.get("count", 0) > 0:
                role_presence[tag] += 1
            role_hists.setdefault(tag, Counter())[rc.get("count", 0)] += 1
    structural_profile = {
        "speed_control_modes": {m: {"count": c, "share": round(c / n, 3)}
                                for m, c in sorted(mode_presence.items(), key=lambda kv: (-kv[1], kv[0]))},
        "structural_signals": {t: {"count": c, "share": round(c / n, 3)}
                               for t, c in sorted(role_presence.items(), key=lambda kv: (-kv[1], kv[0]))},
        "role_composition_norms": {tag: {str(k): v for k, v in sorted(h.items())}
                                   for tag, h in sorted(role_hists.items())},
    }

    # --- core candidates: anchor first, then within-group recurring backbone (share >= CORE_SUPPORT) --
    ranked = sorted(((sp, c) for sp, c in cooccur.items()
                     if c >= MIN_SAMPLE and c / n >= CORE_SUPPORT),
                    key=lambda kv: (-kv[1], kv[0]))
    core_list: list[tuple[str, str, str | None]] = [   # (species, role, item_filter)
        (sp, "anchor", anchor_item.get(sp)) for sp in anchor_species]
    for sp, _c in ranked:
        if len(core_list) >= MAX_CORE:
            break
        core_list.append((sp, "core-partner", None))

    core_candidates = []
    for sp, role, item in core_list:
        c = cooccur.get(sp, n if role == "anchor" else 0)
        grounding = _grounding_for(sp, fmt, g_teams, all_teams, item)
        prim = (grounding or {}).get("primary") or {}
        core_candidates.append({
            "species": sp,
            "role": role,
            "within_group_share": round(c / n, 3),
            "within_group_count": c,
            # Two explicit views (glue vs archetype-defining), NEVER folded into a distinctiveness score:
            # a member high on both is glue; high within-group but low pool-wide is what defines this frame.
            # The anchor is in every pool team by construction (pool_cooccur excludes it), so its pool_share
            # is 1.0 — not the group/pool fallback that would shadow prevalence.share.
            "pool_share": 1.0 if role == "anchor" else (
                round(pool_cooccur.get(sp, c) / pool_size, 3) if pool_size else None),
            "grounding": grounding,
            "set_guidance": ({"moves": prim.get("moves"), "nature": prim.get("nature"),
                              "sps": prim.get("sps")} if grounding else None),
            "confidence": prim.get("confidence") if grounding else "low",
            "meta_auxiliary": (meta_fn(sp) if meta_fn else None),
        })

    # --- observed facts (DESCRIPTIVE — "how real teams in this group vary", NOT a to-fill checklist;
    # observed_mega_slots is a fact, not a reserved second-Mega slot) --------------------------------
    core_species = {sp for sp, _, _ in core_list}
    fillers = sorted(((sp, c) for sp, c in cooccur.items()
                      if c >= MIN_SAMPLE and sp not in core_species),
                     key=lambda kv: (-kv[1], kv[0]))
    group_mega_distribution = mega_slot_distribution(g_profs)
    use_group_mega = group_mega_distribution["sample_count"] >= OBSERVED_NORM_MIN_SAMPLE
    mega_reference_distribution = (group_mega_distribution if use_group_mega
                                   else pool_mega_distribution)
    observed_facts = {
        "observed_mega_slots": group_mega_distribution,
        # The local structural group is the first authority.  A thin group falls back to the whole
        # frame pool (same anchor/format) instead of asking the AI to infer a norm from anecdotes.
        # This object lives inside the fingerprinted skeleton, so slate can trust it as a gate input.
        "mega_registration_reference": {
            "basis": "frame_group" if use_group_mega else "frame_pool",
            "distribution": mega_reference_distribution,
            "confidence": ("medium" if mega_reference_distribution["sample_count"]
                            >= OBSERVED_NORM_MIN_SAMPLE else "low"),
        },
        "observed_fillers": [{"species": sp, "count": c, "within_group_share": round(c / n, 3)}
                             for sp, c in fillers],
        "role_composition_norms": structural_profile["role_composition_norms"],
    }

    thin = n < THIN_BAR
    skeleton = {
        "structural_profile": structural_profile,
        "prevalence": {"count": n, "share": round(n / pool_size, 3) if pool_size else 0.0},
        "core_candidates": core_candidates,
        "flex_slots": {"open_count": max(0, 6 - len(core_candidates))},
        "observed_facts": observed_facts,
        "thin": thin,
        "confidence": "low" if thin else "medium",
        "confidence_reason": "thin-observed-sample" if thin else "observed-sample",
        "notes": [
            "core_candidates = within-group co-occurrence (share >= %.2f) + each member's REAL repset "
            "(item,ability) joint — an aggregate over the group, NOT a verbatim team and NOT a mandated "
            "roster: substitute freely, but a substitute needs its OWN repset basis or an off_meta "
            "declaration (the slate binding checks this)." % CORE_SUPPORT,
            "set_guidance (moves/nature/sps) is a REFERENCE, not a hard lock; only a core-bearer's "
            "(item,ability) leaving its repset clusters WITHOUT an acknowledged deviation is a red flag.",
            "observed_facts is DESCRIPTIVE — how real teams in this group vary at the open slots; "
            "observed_mega_slots is a fact about registered Mega counts, NOT a reserved second-Mega "
            "slot. Second Mega / coverage / utility are the AI's independent calls (flex_slots).",
        ],
    }
    # frame_id is a mechanical content hash (NOT a team-name template): structure + core species + fmt.
    skeleton["frame_id"] = "f" + _content_hash(
        {"sig": list(sig), "core": sorted(core_species), "fmt": fmt}, 10)
    # id first for readability in md/json without reordering the dict build above.
    return {"frame_id": skeleton.pop("frame_id"), **skeleton}


def frame_from_teams(teams: list[dict[str, Any]], *, fmt: str,
                     dex_fn: Callable, move_fn: Callable, item_fn: Callable,
                     filter_members: list[dict[str, Any]] | None = None,
                     order: str = "common_first", max_frames: int = MAX_FRAMES,
                     meta_fn: Callable[[str], dict | None] | None = None) -> dict[str, Any]:
    """Build grounded skeletons over `teams` (one format's real library). Pure given the injected fact
    tables + optional `meta_fn` (auxiliary marginals only). `filter_members` ({species, item?} — item =
    the doubles-Mega stone isolation, landscape's rule) narrows to the anchor pool; empty = the generic
    (whole-library) build. `order` = the meta_conformance knob (common_first | rare_first)."""
    filter_members = [f for f in (filter_members or []) if f.get("species")]
    anchor_labels = [_filter_label(f) for f in filter_members]
    anchor_species = {f["species"] for f in filter_members}

    structural_teams = list(teams)
    pool = ([t for t in structural_teams if all(_matches(t, f) for f in filter_members)]
            if filter_members else structural_teams)
    pool_size = len(pool)
    profiles = [team_profile.profile(t, dex_fn=dex_fn, move_fn=move_fn, item_fn=item_fn) for t in pool]
    pool_mega_distribution = mega_slot_distribution(profiles)
    pool_cooccur = _cooccurrence(pool, anchor_species)

    # Partition by speed_control signature; a group qualifies at MIN_SAMPLE. >=2 qualifying groups ->
    # partition; else ONE unpartitioned frame over the whole pool (honest: a pool that does not separate
    # structurally is one frame, not fabricated sub-archetypes).
    groups: dict[tuple, list[tuple[dict, dict]]] = {}
    for t, p in zip(pool, profiles):
        groups.setdefault(_mode_signature(p), []).append((t, p))
    qual = {sig: g for sig, g in groups.items() if len(g) >= MIN_SAMPLE}
    partitioned = len(qual) >= 2
    residual = sum(len(g) for sig, g in groups.items() if sig not in qual) if partitioned else 0

    if partitioned:
        frame_groups = list(qual.items())
    elif pool:
        frame_groups = [(("__all__",), list(zip(pool, profiles)))]
    else:
        frame_groups = []

    # Anti-mediocrity ordering (design §19.10): order ALL groups by prevalence under the knob; the
    # display cap only trims the generic popular/rare tail and NEVER a group carrying a constraint
    # member — in an anchor build the anchor is in every group, so nothing is trimmed (an off-meta
    # anchor's rare frame survives). frames_total vs frames_shown is disclosed.
    frame_groups.sort(key=lambda kv: (len(kv[1]), sorted(kv[0]))
                      if order == "rare_first" else (-len(kv[1]), sorted(kv[0])))
    frames_total = len(frame_groups)
    anchor_members = [{"species": f["species"], "item": f.get("item")} for f in filter_members]
    if filter_members:
        shown = frame_groups                                   # every anchor frame is constraint-relevant
    else:
        shown = frame_groups[:max_frames]

    skeletons = [_skeleton(sig, g, fmt=fmt, pool_size=pool_size, pool_cooccur=pool_cooccur,
                           pool_mega_distribution=pool_mega_distribution,
                           anchor_members=anchor_members, all_teams=teams, meta_fn=meta_fn)
                 for sig, g in shown]

    thin = pool_size < THIN_BAR
    meta_fallback = pool_size == 0 or not any(
        cc.get("grounding") for s in skeletons for cc in s["core_candidates"])
    notes = [
        "frame HANDS the AI a data-grounded starting skeleton so `[assemble]` is not built from the "
        "training prior; it is a scaffold, NOT a retriever — build YOUR team on it, deviate with a "
        "declared basis. The slate gate binds each candidate's core-bearer sets against this evidence.",
        "skeletons are ordered by PREVALENCE (a view under the meta_conformance knob: common_first / "
        "rare_first) — never a strength ranking; frames_total is every group above support, frames_shown "
        "the displayed subset (an anchor build shows them ALL so an off-meta frame is never dropped).",
        "grounded sets come ONLY from repset (real joint teams); a core candidate with grounding=null "
        "has no real joint set (thin/off-meta) — build it yourself and disclose, NEVER stitch one from "
        "meta marginals. meta_auxiliary (when present) is commonness context only.",
    ]
    if thin:
        notes.append(f"THIN anchor pool ({pool_size} < {THIN_BAR} teams): low CONFIDENCE = thin "
                     "EVIDENCE, not a weak team — read the skeleton as anecdotal, ground per-member "
                     "via repset/search before relying on it.")
    if meta_fallback:
        notes.append("META_FALLBACK: no real joint grammar for this anchor (empty pool or no core "
                     "candidate cleared repset) — this is the data-gated boundary (design §19.8), "
                     "stated honestly; assemble from meta + dex facts and disclose the low confidence.")
    transitioned = sum(1 for t in pool if t.get("target_rule"))
    if transitioned:
        notes.append(
            f"HANDOVER: {transitioned}/{pool_size} structural rows retain their evidence_rule and "
            "were revalidated for the target rule; both evidence pools contribute until the "
            "receipt expires, regardless of native sample count.")
    if residual:
        notes.append(f"{residual} pool team(s) fell in structural groups below MIN_SAMPLE (no frame "
                     "emitted for them) — not silently merged into a shown frame.")
    return {
        "kind": "frame",
        "format": fmt,
        "anchor": anchor_labels or None,
        "order": order,
        "pool_size": pool_size,
        "partitioned": partitioned,
        "residual_teams": residual,
        "frames_total": frames_total,
        "frames_shown": len(skeletons),
        "skeletons": skeletons,
        "thin": thin,
        "meta_fallback": meta_fallback,
        "handover": ({"rows": transitioned,
                       "evidence_rules": sorted({t.get("evidence_rule") for t in pool
                                                 if t.get("evidence_rule")}),
                       "target_rules": sorted({t.get("target_rule") for t in pool
                                               if t.get("target_rule")}),
                       "expires_at": sorted({t.get("expires_at") for t in pool
                                             if t.get("expires_at")})}
                      if transitioned else None),
        "confidence": "low" if thin else "medium",
        "confidence_reason": "thin-observed-sample" if thin else "observed-sample",
        "notes": notes,
    }


def format_frame_md(d: dict[str, Any]) -> str:
    """Human-readable skeleton report. FACTS only — prevalence/share/counts are provenance, never a
    strength score; core candidates are listed by real-team prevalence, not 'best'."""
    anchor = ", ".join(d.get("anchor") or []) or i18n.t('frame_no_anchor')
    lines = [i18n.t('frame_header', anchor=anchor, fmt=d["format"], n=d["pool_size"],
                    conf=d["confidence"]),
             "_" + i18n.t('frame_subtitle', total=d["frames_total"], shown=d["frames_shown"],
                          order=d["order"]) + "_"]
    if d.get("thin"):
        lines.append("> ⚠️ " + i18n.t('frame_thin', n=d["pool_size"], bar=THIN_BAR))
    if d.get("meta_fallback"):
        lines.append("> ⚠️ " + i18n.t('frame_meta_fallback'))
    for i, s in enumerate(d.get("skeletons") or [], 1):
        modes = ", ".join(s["structural_profile"]["speed_control_modes"].keys()) or "—"
        prev = s["prevalence"]
        lines.append(f"\n## #{i} `{s['frame_id']}` — {i18n.t('frame_structure')}: {modes} "
                     f"· {i18n.t('frame_prevalence')} {prev['count']} ({prev['share']}) "
                     f"· {i18n.t('confidence')} **{s['confidence']}**")
        lines.append(f"**{i18n.t('frame_core')}** ({i18n.t('frame_open_slots')}: "
                     f"{s['flex_slots']['open_count']})")
        for cc in s["core_candidates"]:
            g = cc.get("grounding")
            if g:
                prim = g["primary"]
                gset = f"@ `{prim.get('item')}` · {prim.get('ability')} · {prim.get('nature')}"
                src = "" if g.get("set_source") == "group" else f" _[{g.get('set_source')}]_"
                moves = ", ".join(prim.get("moves") or []) or "—"
                sps = prim.get("sps")
                sp_s = f" · SP {sps}" if sps else ""
                lines.append(f"- **{cc['species']}** ({cc['role']}, "
                             f"{i18n.t('frame_within_group')} {cc['within_group_share']}) {gset}{src}")
                lines.append(f"    - {i18n.t('frame_set_guidance')}: {moves}{sp_s} · "
                             f"{i18n.t('confidence')} {cc['confidence']}")
            else:
                lines.append(f"- **{cc['species']}** ({cc['role']}, "
                             f"{i18n.t('frame_within_group')} {cc['within_group_share']}) — "
                             f"⚠️ {i18n.t('frame_ungrounded')}")
        of = s["observed_facts"]
        mega = of.get("observed_mega_slots") or {}
        lines.append(f"_{i18n.t('frame_observed_mega')}: avg "
                     f"{mega.get('average_registered_mega_slots')}_ "
                     f"({i18n.t('frame_mega_is_fact')})")
        fillers = of.get("observed_fillers") or []
        if fillers:
            fs = ", ".join(f"{f['species']} ({f['within_group_share']})" for f in fillers[:8])
            lines.append(f"_{i18n.t('frame_observed_fillers')}: {fs}_")
    if d.get("notes"):
        lines.append(f"\n## {i18n.t('notes')}")
        lines += [f"- {n}" for n in d["notes"]]
    return "\n".join(lines)
