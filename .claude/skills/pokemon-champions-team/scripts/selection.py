#!/usr/bin/env python
"""Selection matrix (M2 core; design.md §6 L2, design audit point 7) — OBJECTIVE FACTS ONLY.

Champions is bring-6 / pick-3 (singles) or pick-4 (doubles), and only ONE member may Mega Evolve
per battle. This operator enumerates the legal pick subsets and reports objective facts for each —
who's in it, which member(s) could Mega (and into what), the base-Speed ordering, and the types
present — so the AI can reason about the 6vN choice. It assigns NO strength score and names NO single
best pick (design §0); it does not rank combos, only lists them in a stable, neutral order.

Deferred (need design / meta and are marked, not silently skipped): matchup vs a named opponent or
meta top-K, lead/back constraints, doubles partner synergy & speed-control semantics. See `notes`.

External lookups are injected (dex_fn / item_fn) so the logic is unit-testable offline.
"""
from __future__ import annotations

from itertools import combinations
from typing import Any, Callable

PICK_SIZE = {"single": 3, "double": 4}


def _base_of(form_name: str) -> str:
    """Bare base of a Mega form name, as a fallback when a form's dex fact isn't to hand."""
    n = form_name
    if n.startswith("Mega "):
        n = n[5:]
        if n.endswith((" X", " Y", " Z")):
            n = n[:-2]
    return n.split("-")[0] if "-" in n else n


def _mega_form_for(member: dict[str, Any], own_fact: dict[str, Any],
                   item_info: dict[str, dict], form_facts: dict[str, dict]) -> str | None:
    """The Mega form this member would become, or None. Given-as-Mega members resolve to themselves;
    otherwise a held Mega stone whose form's base matches the member's species resolves the form."""
    sp = member.get("species")
    if own_fact.get("is_mega"):
        return sp
    item = member.get("item")
    if not item:
        return None
    for form in (item_info.get(item, {}) or {}).get("required_by", []):
        base = (form_facts.get(form, {}) or {}).get("base_species") or _base_of(form)
        if base == sp:
            return form
    return None


def select(team: dict[str, Any], *, fmt: str | None = None,
           dex_fn: Callable, item_fn: Callable,
           legality_status: str | None = None) -> dict[str, Any]:
    members = [m for m in team.get("pokemon", []) if m.get("species")]
    fmt = (fmt or team.get("format") or "single").lower()
    pick = PICK_SIZE.get(fmt, 3)

    species = [m["species"] for m in members]
    items = sorted({m["item"] for m in members if m.get("item")})
    item_info = item_fn(items) if items else {}
    # Candidate Mega forms referenced by held stones, looked up so we can match form -> base species.
    candidate_forms = sorted({f for it in item_info.values() for f in (it.get("required_by") or [])})
    facts = dex_fn(species + candidate_forms) or {}

    # Per-member objective attributes computed once. When a member can Mega Evolve, the Mega form's
    # OWN types/speed are looked up too: a base form carrying a stone keeps its base type/speed until
    # it Megas, but Mega Evolution can change both (e.g. Mega Charizard X: Fire/Flying -> Fire/Dragon),
    # so reporting only base data would be a factual error (audit 2026-06-21). Base (as-brought) values
    # drive speed_order/types_present; the Mega delta is surfaced per mega_option.
    attrs: dict[str, dict[str, Any]] = {}
    for m in members:
        sp = m["species"]
        fact = facts.get(sp, {}) or {}
        mega_form = _mega_form_for(m, fact, item_info, facts)
        mfact = (facts.get(mega_form, {}) or {}) if mega_form else {}
        attrs[sp] = {
            "base_speed": (fact.get("stats") or {}).get("spe"),
            "types": list(fact.get("types") or []),
            "mega_form": mega_form,
            "mega_types": list(mfact.get("types") or []),
            "mega_base_speed": (mfact.get("stats") or {}).get("spe"),
        }

    idxs = list(range(len(members)))
    groups = list(combinations(idxs, pick)) if len(members) > pick else [tuple(idxs)]

    combos: list[dict[str, Any]] = []
    any_mega_changes = False
    for g in groups:
        sel = [members[i]["species"] for i in g]
        mega_options = []
        for s in sel:
            a = attrs[s]
            if not a["mega_form"]:
                continue
            opt = {"member": s, "form": a["mega_form"]}
            # Surface the objective Mega delta only when the form actually differs from the base.
            if a["mega_types"] and a["mega_types"] != a["types"]:
                opt["form_types"] = a["mega_types"]
                any_mega_changes = True
            if a["mega_base_speed"] is not None and a["mega_base_speed"] != a["base_speed"]:
                opt["form_base_speed"] = a["mega_base_speed"]
                any_mega_changes = True
            mega_options.append(opt)
        speed_order = sorted(
            [{"member": s, "base_speed": attrs[s]["base_speed"]} for s in sel],
            key=lambda x: (-(x["base_speed"] or -1), x["member"]),
        )
        types_present = sorted({t for s in sel for t in attrs[s]["types"]})
        combos.append({
            "members": sel,
            "mega_options": mega_options,
            "multiple_mega_brought": len(mega_options) > 1,   # legal to bring; only one may Mega in battle
            "speed_order": speed_order,        # as-brought (pre-Mega) base Speed
            "types_present": types_present,    # as-brought (pre-Mega) types
        })
    # Stable, neutral ordering (by member names) — explicitly NOT a quality ranking.
    combos.sort(key=lambda c: c["members"])

    # The legality note depends on whether a caller already ran `validate` and passed the verdict
    # in: the CLI does (so claiming "run validate first" would contradict the attached legality —
    # audit 2026-06-21); the bare library call does not, so it keeps the run-validate-first advice.
    if legality_status is None:
        legality_note = ("Legality is NOT re-checked by this operator: it enumerates pick subsets of the "
                         "registered team and assumes it already passed `validate`. Run validate first — "
                         "selection does not certify legality.")
    else:
        legality_note = (f"Registered-team legality was checked: status={legality_status!r} (see `legality`). "
                         "These are pick subsets of that team; selection itself certifies no legality.")
    notes = [
        f"{fmt}: bring {len(members)}, pick {pick}. Objective facts per pick subset — no strength score, "
        "no single best pick (design §0); combos are listed in a neutral order, not ranked.",
        legality_note,
        "Only ONE member may Mega Evolve per battle: a combo carrying multiple Mega stones is legal to "
        "bring (multiple_mega_brought=true), but you Mega at most one once in battle.",
        "speed_order and types_present are the as-brought (pre-Mega) values; if a member Mega Evolves, "
        "its post-Mega type/Speed are given on its mega_option (form_types / form_base_speed when they differ).",
        "DEFERRED (not modelled in v1): matchup vs a named opponent / meta top-K, lead vs back "
        "constraints, doubles partner synergy and speed-control (tailwind/trick-room) semantics.",
    ]
    if not any_mega_changes:
        # No Mega in any combo alters type/Speed, so the pre-Mega note above is moot — drop it.
        notes = [n for n in notes if not n.startswith("speed_order and types_present are the as-brought")]
    if len(members) <= pick:
        notes.append(f"team has {len(members)} <= pick {pick}; the whole team is the only selection.")

    return {"kind": "selection", "format": fmt, "pick_size": pick,
            "bring_size": len(members), "combos": combos, "notes": notes,
            "legality_checked": legality_status,
            "confidence": "high", "confidence_reason": None,
            "evidence": {"facts": [{"source": "dex", "ref": "types / base speed / Mega form+stone"}],
                         "assumptions": ["objective enumeration only; no matchup, no ranking"]}}


def _mega_label(o: dict[str, Any]) -> str:
    delta = []
    if o.get("form_types"):
        delta.append("type→" + "/".join(o["form_types"]))
    if o.get("form_base_speed") is not None:
        delta.append(f"Spe→{o['form_base_speed']}")
    return f"{o['member']}→{o['form']}" + (f" ({', '.join(delta)})" if delta else "")


def format_selection_md(d: dict[str, Any]) -> str:
    status = d.get("legality_checked")
    leg = (f"legality checked: {status}" if status else "legality assumed; run `validate` separately")
    lines = [f"# Selection ({d['format']}: bring {d['bring_size']}, pick {d['pick_size']}) — "
             f"{len(d['combos'])} pick subset(s), unranked ({leg})"]
    for c in d["combos"]:
        head = " + ".join(c["members"])
        mega = ("; Mega: " + ", ".join(_mega_label(o) for o in c["mega_options"])
                if c["mega_options"] else "; no Mega")
        if c["multiple_mega_brought"]:
            mega += " (multiple stones brought — only one may Mega)"
        spe = ", ".join(f"{s['member']} {s['base_speed']}" for s in c["speed_order"])
        lines.append(f"- **{head}**{mega}\n  - base-Speed order (pre-Mega): {spe}"
                     f"\n  - types (pre-Mega): {', '.join(c['types_present'])}")
    if d.get("notes"):
        lines.append("\n## Notes")
        lines += [f"- {n}" for n in d["notes"]]
    return "\n".join(lines)
