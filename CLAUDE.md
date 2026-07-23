# CLAUDE.md

Optional project-level instructions for Claude Code using the four Pokémon Champions skills in this
distribution. The skills auto-trigger without this file; keep these rules when copying or adapting it.

## Language And Names

- Detect whether the user is writing in Simplified Chinese, Japanese, or English and answer in that
  language unless the user requests another one.
- Pass `--lang zh|ja|en` when requesting human-readable Markdown from dex, meta, or team CLIs. Prefer
  canonical JSON for orchestration; JSON fields, stat keys, types, and English `name` join keys are
  intentionally language-independent.
- Resolve every Pokémon, move, item, ability, and nature through `pokemon-champions-dex`. In Chinese
  answers render `中文名 (English)` on first use; in Japanese render `日本語名 (English)`; in English
  use the canonical English name. Do not translate names from memory.
- Keep technical terms understandable for the user's language. Explain SP as Champions Stat Points,
  not standard-game EVs.

## Current Environment

- Pokémon Champions rules and metagame data are versioned. Read the current season/rule from skill
  output or `pokemon-champions-meta/data/current.json`; never hardcode an older season.
- Meta data is a shipped snapshot. State its season/rule and `as_of`/update stamp when freshness
  matters. If it is stale, tell the user to update the skill package; do not pretend the snapshot is
  live.
- Call skills before relying on memory. Search the web only when the installed skills lack the fact,
  and distinguish web evidence from shipped skill data.

## Skill Routing

- `pokemon-champions-dex`: canonical battle facts, forms, trilingual names, types, stats, abilities,
  learnsets, items, Mega stones, and reverse search. Examples: `X能学Y吗`, `XはYを覚える？`,
  `can X learn Y?`.
- `pokemon-champions-meta`: rankings, usage distributions, common moves/items/abilities/natures,
  partners, SP spreads, format comparisons, and factual snapshot changes. Never stitch independent
  marginals into an asserted joint set.
- `ncp-damage-calculator`: concrete damage, KO/survival, and speed-order facts. A successful calculation
  is not a legality verdict.
- `pokemon-champions-team`: any request whose whole intent is to build, complete, validate, diagnose,
  tune, change, select from, review, or evaluate a team. Examples: `帮我组一队`, `这队怎么改`,
  `チームを組んで`, `この構築を直して`, `build me a team`, `review my team`.

Pure dex/meta/damage questions do not enter the team workflow. The explicit phrases `建队流程`,
`开始建队`, `执行建队流程`, `team building flow`, and `チーム構築フロー` always enter the full team
workflow.

## Team Skill: Mandatory Workflow

Before handling any build, diagnose, evaluate, rework, selection, or tuning request, read the team
skill's `references/assisted_workflow.md`. Its Universal Evaluation Protocol (UEP) is binding.

1. **Commit to the phases.** State which phases will run and track them with the host's planning tool.
   Do not silently skip grounding, slate evaluation, checkpoint, validation, or answer audit.
2. **Normalize user input.** Users may paste Showdown text, JSON, prose, screenshots, or any named file.
   There is no required source format. Resolve names with the dex, then construct canonical `team-json`
   and `build-context`; team scripts never parse conversation text.
3. **Audit intent first.** Run `team.py context-audit --context ctx.json`. Resolve blocking and conflict
   gaps; apply and disclose safe defaults. Preserve the returned `audit_receipt`.
4. **Use the correct intake route.** For an open-ended new build, drive `team.py intake --next` in
   batches until `done:true`. Existing-team analysis skips onboarding and asks only for blocking or
   conflicting information. If `owned_only:true`, populate the resolved `owned` list.
5. **Ground before assembling.** Consult current meta ranking plus `landscape`, `observed`, `search`,
   and `repset`; use doubles `oppmatrix` where relevant. Run `frame` with the audit receipt. Build on
   real joint evidence, never on independently combined usage marginals, and never silently copy a
   stored team.
6. **Evaluate a slate.** Unless the user explicitly requests one final team, assemble 2-5 structurally
   distinct candidates. Set `frame_required:true`, preserve `frame_bindings`, and run
   `slate-evaluate` with the saved frame output. Never present an unslated or eliminated candidate.
7. **Honor the checkpoint.** Run `checkpoint` after every build slate. Surface `pause:true` unless the
   user already delegated final convergence or explicitly requested no pause.
8. **Use the right calculations.** Team-level meta matchup claims require the full `matchup` top-K
   table. Doubles six-member evaluation requires `select` because the battle selection is 4-of-6.
   Adjustment intent such as "make X survive/outspeed/OHKO Y" requires `team.py tune` with structured
   benchmarks; isolated as-is questions may use the NCP calculator directly.
9. **Validate every presented team.** Run `validate` with context when available. Treat
   `valid/invalid/unknown` distinctly; never certify legality from incomplete data or a successful
   damage calculation.
10. **Audit the final answer.** Initialize with `draft-init`, fill all substantive fields, then run
    `answer-audit` against the original slate and saved slate output. Fix violations and present only a
    passing draft. Passing verifies structure and recomputable claims, not strategic perfection.

The receipt chain is `context-audit -> frame -> slate-evaluate -> answer-audit`. Save the exact JSON
artifacts so later gates can rebind them. Use `team.py session` for multiple operators on one team.

## Recommendation Boundaries

- Tools emit facts, legality results, evidence, and multiple explicit views. They never produce a
  composite strength score or an objective "best team". The agent may recommend transparently by
  explaining assumptions, trade-offs, confidence, opportunity costs, and alternatives.
- Keep singles and doubles evidence separate. Keep historical regulations labeled and out of the
  current evidence pool unless explicitly requested.
- Performance tags and usage are evidence, not proof of strength. Exact adoption of an observed team
  requires the provenance and adoption-review disclosures enforced by `answer-audit`.
- Quantitative prose claims must cite operator evidence IDs and reproduce the actual damage, survival,
  KO, or speed result. Surface low-confidence and standard-set assumptions.
