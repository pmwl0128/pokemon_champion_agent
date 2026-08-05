---
name: pokemon-champions-ui-session
description: Work on the active Pokémon Champions UI build session — read its intent and artifacts through the pcui CLI, run the normal UEP team-building flow, and submit each gate artifact back so the local web panel renders progress live. Trigger when the user asks to handle/process the current Pokémon UI session. Chinese examples include "处理当前 Pokémon UI 会话", "继续 UI 会话", "看看 UI 会话的决策". English examples include "work on the current Pokémon UI session", "continue the UI session", "pick up my UI session". Japanese examples include "現在の Pokémon UI セッションを処理して", "UI セッションを続けて". Requires the pokemon-champions-team skill (and its sibling data skills) — this skill only adds the session I/O, never replaces the UEP discipline.
---

# Pokémon Champions UI Session

The local web panel (`pcui serve`) and you collaborate through ONE shared session store:
the panel is the session's eyes and hands, you are the decision participant. This skill
adds exactly one thing to your normal workflow — reading session context and submitting
gate artifacts through `pcui`. The team-building discipline itself is unchanged: follow
`pokemon-champions-team`'s assisted workflow (UEP) exactly as you always do.

## CLI

The pcui command for this machine: `{{PCUI_CMD}}`
(bridge directory: `{{BRIDGE_DIR}}`)

```
{{PCUI_CMD}} session list                              # newest first
{{PCUI_CMD}} session show --id <S>                     # meta.intent + heads + ledger
{{PCUI_CMD}} artifact get --session <S> --kind <kind>  # latest artifact of that kind (verbatim)
{{PCUI_CMD}} artifact put --session <S> --kind <kind> --file out.json   # or pipe via stdin
{{PCUI_CMD}} run <op> [--file team.json] [--context ctx.json] [--args '<json>']
                                                       # one whitelisted team operator in the daemon
```

## Workflow

1. **Find the session**: `session list`, pick the one the user means (usually the newest,
   or the id they name). `session show --id <S>` gives `meta.intent` (the user's build
   intent typed in the panel), `heads` (latest artifact per kind), and the ledger.
2. **Read what exists**: `artifact get` every kind in `heads` that matters — `context`,
   `decision` if present (the user's checkpoint answer made in the panel:
   `chooseCandidate` + `candidateIndex` into your slate's teams, `requestChanges` + note,
   or `proceed`), and `tune-request` if present — see the tune loop below.

## The tune loop (`tune-request` → `tune-result`)

A `tune-request` artifact is the user's PLAIN-LANGUAGE tuning ask, written on the calc
page against a recommended team: `{note, member?, member_set?, team?, form_benchmarks?}`.
The note may name things the form cannot express — several members or the whole team,
environment-filtered goals ("survive every top-50 Ground hit": resolve via meta ranking +
dex reverse/type lookups, then benchmark against the concrete threats), or fuzzy targets.
TRANSLATING it is your job (the skill never parses free text): turn the note into concrete
`build-context.benchmarks[]` per the team skill's adjustment-intent rule, auto-fill
opponent sets from repset/meta modal where unspecified, run `team.py tune --context` on
the team (take it from the `draft` artifact; if the session has no `draft` — a request from
the standalone tune page — use the request's own `team` snapshot, and `member_set` for the
member's exact edited item/ability/nature/SP), and `artifact put` the
operator's FULL output as kind `tune-result` — the panel renders its `cards` as cliff
cards. `form_benchmarks` are the explicit rows the user already ran in the form; reuse or
extend them, don't silently drop them. If the ask implies changing the team (not just SP),
say so to the user instead of silently editing members.
3. **Work the UEP flow normally** (context-audit → grounding → frame → assemble →
   slate-evaluate → checkpoint → answer-audit), using the four skills as always. **Prefer the
   daemon path**: `run <op>` executes one team operator inside the daemon's resident workers, and a
   `session` spec runs several ops in one process — both amortize the per-op sibling-subprocess spawn
   (dex/meta/calc) that dominates the wall-clock of a COLD `team.py <op>` call (the Python import
   itself is cheap; the repeated worker spawns are the tax). Batch related reads (ranking/landscape/
   repset/validate) into one `session` instead of many shell-outs; fall back to a raw `team.py` only
   when the daemon is down. When you run an intake question
   batch (`intake --next`), also `artifact put` its output as kind `intake` so the panel
   shows the user your current questions live (answers still come through conversation or
   the panel's decision/intent fields).
4. **Draft prose: narrate in the USER'S language, but name every ENTITY by English
   canonical.** In `tradeoffs`, `assumptions[].note`, `confidence_notes`,
   `convergence_rationale`, `context_summary`: species, moves, items and abilities are
   written EXACTLY as they appear in operator output ("Whimsicott", "Last Respects") —
   never hand-translated. A hand-written localized name is a hallucination vector nothing
   downstream can catch; the panel localizes canonical names with dex authority (portrait
   chips, official names) at render time.
5. **Submit each gate artifact as you produce it** with `artifact put`. Kind vocabulary
   (the panel labels and orders these): `context` (the build-context you assembled),
   `audit` (context-audit receipt), `frame`, `slate` (slate-evaluate output),
   `checkpoint` (checkpoint output), `draft`, `answer-audit`. Submit the artifact's raw
   JSON exactly as produced — the store keeps it verbatim. `decision` is PANEL-authored;
   you only ever read it.
   **Artifact size**: the daemon rejects a body over ~2 MiB. Only one artifact risks that — `slate`
   (the full per-cell battery + 6-pick-N combos can be several MB). Emit the compact **summary** for
   the panel: `slate-evaluate … --slate-view summary` (or `run slate-evaluate` with `view:"summary"`).
   It keeps survivors, each candidate's legality/mega/structural facts, the CHECK grade counts the card
   renders, and `slate_receipt`, while dropping the grid, per-opponent evidence lists and combos the
   panel never reads. Keep the FULL slate output for your own reasoning and for `answer-audit` (its
   claim recompute re-hashes the untrimmed `matchup_risk`) — only the panel artifact is the summary.
6. **Checkpoint pause**: when the checkpoint output says `pause:true` (and the context did
   not encode `direct_final`/`skip_checkpoint`), put the checkpoint artifact, tell the
   user to decide in the panel, and stop this turn. Next time you are invoked, read the
   `decision` artifact first and continue from it.
7. **Conflicts**: `artifact put` re-reads the current revision before writing; if it still
   reports a 409 the panel wrote concurrently — re-run the same put once.

The panel renders every artifact you put in real time (SSE). Do not wait to submit them in
a batch at the end; put each gate's output when the gate completes.
