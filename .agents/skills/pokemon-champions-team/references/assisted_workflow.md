# Assisted team building — the Universal Evaluation Protocol (UEP)

This document is the working discipline for **every** build / diagnose / evaluate / rework / tune
request that goes through this skill — not just beginner hand-holding. The skill is a passive CLI:
it cannot force you (the orchestrating AI) to follow this protocol. These rules are the prose tier
of enforcement; the machine gates (the context-audit → slate-evaluate → answer-audit receipt
chain) are **live end-to-end** and harden the core of the same rules — the receipts prove the
gates ran, not that you acted well on what they surfaced, so **treat every MUST below as binding**.

## Contents

- [Failure mode](#why-this-exists-the-observed-failure-mode)
- [Six mandates](#the-six-mandates-prose-tier--follow-on-every-request)
- [Red flags](#red-flags--thoughts-that-mean-youre-rationalizing-a-skip)
- [End-to-end protocol](#one-protocol-every-entry-point)
- [Intent model](#intent-two-axes-no-categories)
- [Guided walk vs refinement](#when-to-run-the-guided-walk-vs-the-refinement-menu-trigger-discipline)
- [Ask vs default](#ask-vs-default-when-intent-is-vague)
- [Hard boundaries](#hard-boundaries-unchanged-from-the-skills-principles)
- [Pre-answer audit](#pre-answer-the-draft-contract--residual-prose-checks)

## Why this exists (the observed failure mode)

A capable AI's dominant failure in team building is NOT building an illegal or obviously broken team
(`validate`/`diagnose` catch those). It is **mode-collapse**: with no data anchor, it regresses to
the most common "generic balanced team" from its training prior, ignores the user's actual intent,
and builds from marginal statistics stitched together (partner lists, usage rows) instead of real
co-occurring structures. The protocol counters this by making the data-grounded path explicit,
auditable, and cheaper to follow than an ungrounded shortcut. **The value is not in any single
operator; it is in running the whole grounded path.**

Two standing assumptions (do not relax them):

- **No user prior**: do not assume the user can supply or verify structural/strength conclusions
  (default non-expert). The only exception: an explicitly stated building philosophy/preference is
  translated into build-context and respected as a first-class constraint.
- **No AI prior**: do not trust your own training prior for structure. Correctness comes from
  data-derived grammar (joint real teams, never stitched marginals) + the audits below.

## The six mandates (prose tier — follow on every request)

1. **Validate before presenting.** Never show the user a team (new, modified, or filled) without a
   passing `team.py validate` run — with `--context` when a build-context exists. A recommendation
   that was never validated is not a recommendation.
2. **Ground before assembling.** Before you assemble or modify candidates, consult in order:
   - `meta_query.py ranking` (current season/rule, correct format) — the environment;
   - `team.py landscape --game-format …` — how real successful teams are structurally laid out
     (speed-control modes, signal frequencies, role norms, observed cores; add
     `--aspects offense defense` for the full type-presence layout when coverage questions
     matter); this is the anti-mediocrity distribution your candidates are built AGAINST, not
     copied from;
   - `team.py repset <anchor/core species>` and/or `team.py search` / `team.py observed
     --game-format … --context …` (the constraint-shaped retrieval: explicit overlap vs your
     locked/prefer/owned, evidence-tier ordered) — the real-team joint archetypes for the anchor
     and intended cores (read them as **evidence to decompose**, never echo a stored team verbatim
     to the user as the answer);
   - doubles: `team.py oppmatrix` — the standard-set reference grid for the top-K.
   Build YOUR team from what the distributions show; never stitch a team out of partner/usage
   marginals (that is the marginal-stitch trap at team scale).
   **`frame` MECHANIZES this mandate for BUILD flows**: after grounding, run
   `team.py frame --game-format … --context ctx.json --audit-receipt <context-audit output>`. It
   hands you DATA-GROUNDED skeletons — `core_candidates` each carrying their REAL repset
   `(item,ability)` joint + `set_guidance` — so you assemble ON grounded evidence instead of
   hand-writing member sets from your prior (the Crabominable @ Life Orb failure). Tag each candidate
   with the `frame_id` it builds on and pass `--frame-output` to slate: a core-bearer whose
   `(item,ability)` leaves its repset clusters with no `off_meta`/`deviations` declaration is RED and
   is eliminated in the funnel. `core_candidates` is a starting point, NOT a roster — substitute
   freely, but a substitute needs its OWN repset basis or an off_meta declaration; the flex slots
   (second Mega / coverage / utility) are assembled by you. Frame's `observed_facts` never reserves a
   slot, but its reliable `mega_registration_reference` is load-bearing at slate time: under the
   default `mega_posture:environment`, observed minority/rare registration counts need a declared
   `mega_deviation`, and the surviving candidate set retains at least one candidate that is modal
   relative to its own frame. An explicit `mega_posture:none|single|multi` replaces that prior with a
   hard composition constraint;
   `meta_conformance:off_meta` disables the observed-lane deviation gate. Skipping frame on a build
   leaves the one uncovered creative step ungrounded — the exact place mode-collapse lives. Mark build
   contexts/slates with `frame_required:true`; then `slate-evaluate` refuses a missing `--frame-output`
   and `answer-audit` backstops any old/manual slate output with no frame fingerprint.
3. **Team-level matchup claims need the full table.** Any claim about how a team trades against the
   meta must come from `team.py matchup` (full top-K, both directions), not from hand-picked single
   `ncp` calcs. Bare `ncp` calls are for single-point thresholds only.
   **The tune-vs-bare-ncp line is ADJUSTMENT INTENT, not keywords.** When the user wants the team
   (or a member's spread/nature/item) CHANGED to meet thresholds — "针对 X 微调"、"让它能抗住/
   快过/确一 Y" — translate the intent into `build-context.benchmarks[]` and run `team.py tune
   --context`: it is the operator built for exactly this (discrete SP cliffs, nature lanes, 66-SP
   feasibility). Hand-running ncp calcs and eyeballing percentages is not tuning. A pure FACT
   question with no adjustment intent ("does X survive Y's Earthquake as-is?") stays a single-point
   threshold — bare `ncp` is the right tool there, and for spot-checking a tune result.
4. **Six-member evaluation needs the actual selection object.** Singles is 6-pick-3 and doubles is
   6-pick-4; a registered six is a preview toolbox, not the battle lineup. `slate-evaluate` attaches
   `select` facts to every survivor, including each Mega option's exclusive/shared lineup routes and
   zero-or-one active-Mega states. Read those facts before making role/coverage or Mega-route claims.
5. **Multi-operator runs go through `session`.** One process, siblings resident (~70% wall-clock
   saved). Cost is a skip incentive — remove it.
6. **Diagnose before advising.** For "fix/review/improve my team" requests, run `diagnose` (and
   `matchup` when the complaint is matchup-shaped) before proposing changes; look for an answer
   already on the team before reaching for a replacement, and never "fix away" the user's anchor.

Not mandated (use judgment): `fill`/`replace` (you decide when a candidate pool or an impact diff
is needed), dex `find`/`find-move`/`reverse`, meta `compare`/`export-excel`, speedline `table`.

## Red flags — thoughts that mean you're rationalizing a skip

Each row is a moment you'll be tempted to shortcut. The thought is the tell; the Reality is why the
phase stays. When one of these crosses your mind, that IS the signal to run the phase, not skip it.

| Thought (you're rationalizing a skip) | Reality |
|---|---|
| "I know this meta, I can skip grounding" | `landscape` is the distribution your candidates are built AGAINST your training prior; the more you trust your own read, the harder you mode-collapse to a generic balanced team. Run it. |
| "I grounded the anchor with repset — I'll hand-write the rest" | That is still mode-collapse: the anchor is grounded while the remaining members come from prior assumptions. `frame` grounds every core candidate's real `(item, ability)` set and slate red-eliminates an ungrounded core-bearer. Run frame and build on it. |
| "The team's clearly legal / has no real problems — skip slate" | `slate-evaluate` doesn't check legality (`validate` does) — it is the candidate fact-matrix + survivor battery, and the only source of the `evidence_id`s you quote when you converge. |
| "checkpoint is a beginner pause, just push on" | It is the build-flow post-slate pause contract, deriving `pause` from candidate-frame / missing modal Mega-registration coverage / low-confidence / observed-overlap decisions. Multi-Mega by itself is not a pause reason: the slate already carries selection routes. Unless the context already encoded `direct_final` / `skip_checkpoint`, a `pause:true` must be surfaced. |
| "There's a stored team that fits perfectly — just hand it over" | Adopting an observed team is legitimate (as the library grows it often IS the best-fitting answer) — but only WITH `observed_provenance` (the overlap fact + why it fits this intent) and, for an exact joint-set copy, `adoption_review` (what reasonable forks were considered). Silent verbatim netdecking is the banned thing; answer-audit flags it as a violation. |
| "It's one swap / a tiny change — no need to re-run answer-audit" | `answer-audit` re-binds the whole receipt chain and recomputes every number; even a small change can stop an old `evidence_id` from reproducing. Run it. |
| "I'll validate everything at the end" | It is validate BEFORE presenting, not a wrap-up step — a team you haven't validated is not a recommendation. |
| "The user didn't say how many — I'll just give one final team" | Default is 2–3 distinct teams; converging to one needs an explicit `single_team_requested`. Fewer is a declared choice, not the low-effort default. |
| "They want the team tuned against a threat — a few hand-run ncp calcs will do" | `tune` is the operator built for adjustment intent: benchmarks[] → cliff cards (survive/outspeed/ohko/2hko, nature lanes, unused-SP/reallocation funding). Hand-read percentages skip cliff detection and the budget math. Bare ncp answers "does it, as-is?" fact questions and spot-checks tune output — it never replaces the tune run when the ask is to CHANGE the team. |

**Spirit over letter**: rephrasing a phase away — "this isn't really a build", "it's just a quick
tweak" — doesn't exempt it. If the request assembles or changes a team the user will act on, the
full chain applies.

## One protocol, every entry point

```
any build/diagnose/evaluate/rework/tune request
  ▼
[commit]          announce the phases THIS request will run and track one checklist item per phase
                  with the host's available planning tool;
                  if you later drop a committed phase, say so and why. Silent last-mile skips
                  (slate / checkpoint / answer-audit) are the failure this guards.
  ▼
  ├─ diagnose/tune/evaluate an EXISTING pasted team (no new team being built) → assemble
  │                   build-context directly (analysis, not a guided walk)
  └─ BUILD a team (produce/complete one — any open-ended build whose intent you have NOT yet
                      elicited, whatever surface signal it carries) → run the new-build guided walk.
                      `intake --onboarding [--context <so-far>]` = the OVERVIEW (base SET minus
                      `already_answered`); DRIVE it with `intake --next --context <ctx> --answered <ids>`
                      one batch of 1-3 related questions at a time (numbered menu; loop until done —
                      `--answered` = resolved ids, incl. draft/answer-shape ones --context can't show;
                      unknown -> rc2). --onboarding does not itself pace; ask via --next, never a wall
                      of text. Little signal → a full walk; an expert who self-supplied
                      the knobs → it prunes to near-empty, so you assemble directly. Complete the set,
                      never truncate to <=3. Fires PER BUILD TASK (a later, distinct build in the same
                      session gets its own walk). Residual gaps/conflicts AFTER the walk use the
                      steady-state menu (`team.py intake`, <=3 PER ROUND + iterate).
                      → assemble build-context
  ▼
[context check]   `team.py context-audit [team] --context ctx.json` — field_status, three-level
                  gaps (blocking / safe_default+info_value / conflict+ambiguity), audit_receipt.
                  Run it BEFORE assembling; act on the levels (ask / default+disclose / one
                  targeted question) — the audit surfaces, YOU decide.
  ▼
fact base         ranking · landscape · repset/search/observed · oppmatrix · fill · validate   (mandates 1–2)
  ▼
[front door]      `team.py frame --game-format … --context ctx.json --audit-receipt <ctx-audit out>`
                  (BUILD flows) — grounded skeletons you assemble ON: core_candidates with their real
                  repset (item,ability) joint + set_guidance, structural_profile, observed_facts.
                  Consumes audit_receipt, emits frame_receipt. SAVE the output JSON (slate binds it).
  ▼
[assemble 2–5 candidates]   the ONLY creative step — yours, built ON the frame's grounded evidence
                  (deviate from a core_candidate only with a declared repset/off_meta basis); flex
                  slots (2nd Mega / coverage / utility) are yours, but under the environment posture
                  carry at least one candidate modal relative to its frame; tag deliberate
                  minority/rare lanes with mega_deviation. Tag each candidate with its frame_id.
  ▼
[pressure test]   `team.py slate-evaluate slate.json [--frame-output frame_out.json]` — {context
                  (include `frame_required:true` for BUILD flows),
                  audit_receipt, teams:[2–5 candidates], frame_bindings:[{frame_id, off_meta?,
                  deviations?, mega_deviation?}]}. REFUSES without a receipt matching this context / a broken
                  frame_receipt / a build-flow `frame_required:true` missing `--frame-output`
                  (the chain is live). Cheap funnel for all (a RED core-bearer
                  deviation eliminates here); reliable Mega-registration conformance at candidate and
                  candidate-set level; matchup battery plus 6-pick-N selection/activation facts for
                  survivors; order-preserving no-winner grid; quantitative extremes carry re-runnable evidence_ids — quote
                  them when you converge. SAVE the output JSON (answer-audit re-binds it).
                  Never present a candidate that was never slated.
  ▼
[checkpoint]      `team.py checkpoint out.json --slate slate.json` — REQUIRED post-slate,
                  pre-tune pause contract for BUILD flows. Always run it after `slate-evaluate`;
                  the command returns `pause:true|false`. Pause when it says true unless the
                  slate context already encoded an explicit delegation (`direct_final:true`) or
                  explicit no-pause request (`skip_checkpoint:true`). Missing benchmarks alone do
                  not force a pause; disclose `not_run` in tuning_summary if no targeted tuning
                  happens. Survivor selection facts are already present. Multiple registered Mega
                  options alone do not pause; missing observed modal registration coverage does.
  ▼
[converge transparently]    trade-offs per candidate, against the user's stated intent
  ▼
[answer-audit]    initialize the structured draft with
                  `team.py draft-init --slate slate.json --slate-output out.json [--recommended …]`,
                  fill the empty substantive fields, then
                  `team.py answer-audit draft.json --slate slate.json --slate-output out.json`.
                  REFUSES on a broken/stale receipt chain; violations name what is missing
                  (structure/disclosure) or what didn't reproduce (claim recompute). Fix and
                  re-audit until pass — then the residual prose checks below.
  ▼
answer            2–3 distinct candidates by default; ONE team only if explicitly requested
```

All six request shapes ride this same spine — beginner "stable starter team", "build around X",
"owned only", "give me one solid team", expert "diagnose/tune this", "evaluate my candidates". They
differ only in how the build-context is filled and where they enter.

## Intent: two axes, no categories

- **Purpose posture** (knobs, never categories): `anchor` (hard self-expression — a must-keep pick
  or gimmick; for expressive requests a missing anchor is a **blocking** question, because
  defaulting it erases the intent), `meta_conformance` (proven ↔ deliberately off-meta; view
  ordering only), `viability_floor` (expressed as explicit `benchmarks`, height chosen by the
  user), `style_lean` (the structural-posture trichotomy in professional vocabulary —
  offense=主动进攻 / balance=平衡轮换 / defense=稳健防守. A USER lens: you read the axis-2 facts
  below through it when composing and when arguing trade-offs; no operator filters or orders by
  it, and the skill still never labels a team).
- **Structural shape** (emergent facts): speed control, roles, offense lean, weakness stacking —
  read from diagnose/profile facts. Never label a team "balance/stall/hyper-offense" as if the
  label were data.

"Fun" and "solid" are knob settings, not team types; an offensive fun team and an offensive solid
team are both coherent. When a user says "稳" they usually mean a `style_lean` posture
(balance/defense) plus a high `viability_floor` — translate the word into knobs, never into a
template.

## When to run the guided walk vs. the refinement menu (trigger discipline)

`intake` has two modes: the new-build guided walk (`--onboarding`, complete the base
set once, fired per build task) and the steady-state refinement menu (`intake`, <=3 gaps per round +
iterate). Route every incoming message first:

0. **Explicit trigger keyword** — 「建队流程」 (aliases: 开始建队 / 执行建队流程; en "team
   building flow"; ja 「チーム構築フロー」 — THIS list is the single authoritative home; other
   docs point here) → enter the FULL guided flow unconditionally, skipping the vagueness judgment:
   bare keyword = start from the new-build guided walk (`intake --onboarding`); keyword + prose =
   treat the prose as initial intent, run the walk with `--context <that intent>` so it prunes what
   is already answered, then ask what the walk still surfaces.
0a. **Natural-language build trigger** — route by the whole utterance, not isolated words. A zh/en/ja
   message is a BUILD request when it asks for a team to be produced/completed/changed OR asks for an
   existing team to be reviewed/evaluated, and the object is clearly a Pokémon Champions team, roster,
   format, candidate list, or Pokémon-centered constraint. Language-specific examples:
   - zh: "帮我组一队", "配一套双打", "带X组一队", "围绕X做一队", "这队怎么改", "这队怎么选".
   - en: "build me a team", "make a doubles team", "team around X", "include X in the team",
     "rework this team", "review/evaluate my team".
   - ja: "チームを組んで", "ダブルの構築を作って", "X入りで組んで", "Xを軸にした構築",
     "この構築を直して", "選出を見て".
   Constraint words and field names are NOT triggers by themselves; they only become build-context
   fields after the sentence is already a team-production/review request. Translate every supplied
   signal into build-context fields, resolve names through dex, then route as branch 3. Do not wait for
   the user to say the explicit keyword.
1. **Pure fact question** ("does Gengar learn Shadow Ball?") → answer via dex/meta/calc. No intake.
2. **Diagnose/tune/evaluate an EXISTING pasted team** (analysis, no new team built) → build the
   context from the message, run `context-audit`; ask ONLY if it reports blocking/conflict gaps.
   No onboarding walk (they have a team and want facts, not a build).
3. **BUILD a team** (produce or complete one — any open-ended build whose intent you have not yet
   elicited, whatever surface signal it carries) → assemble whatever the message already gives into a
   partial context, then run the new-build guided walk. `intake --onboarding --context <that partial>`
   is the overview (`guided_walk` = base set minus `already_answered`); DRIVE it with `intake --next
   --context <ctx> --answered <resolved ids so far>` — the next batch of 1-3 related questions (numbered
   menu), one step at a time, looped until `done` (apply each answer's maps_to, append its ids to
   --answered; --answered also carries dims the request resolved via draft/answer-shape, unknown -> rc2).
   A casual "give me one team" / "给我来一队" can pre-resolve `answer_shape`, but it is NOT
   `direct_final:true` and NOT a completed onboarding walk; continue the walk for the remaining
   base dimensions unless the context genuinely covers them.
   Render options as a numbered menu (universal) or clickable UI where the host has it (enhancement).
   Complete the set (purpose first), never truncate to <=3. Little signal → a full walk; an expert who self-supplied
   format+anchor+posture+floor → it prunes to near-empty, so you assemble directly. This is the
   restored onboarding flow — do NOT regress it to "pick <=3 by gaps". It fires PER BUILD TASK, not
   per session: if the user already built one team here and now asks for another (a different format
   or theme), that new team is its OWN open-ended build → run the walk again on its fresh intent.
   Carry only DURABLE user preferences (e.g. beginner-ness, an offense lean they stated) into
   `--context` so the walk prunes them; team-SPECIFIC choices from the previous build do not carry,
   so this team's anchor/purpose still get asked.
4. **Refinement round** (a build-context already exists — the residual after a walk, or a later
   iteration) → audit the context; its `gaps[].trigger` tokens join the intake catalog's
   `triggers_on` — pick <=3 questions PER ROUND (purpose first), ask, re-audit, iterate. <=3 is a
   per-round batch, never a total cap.

The machine half: context-audit CLASSIFIES (blocking / safe_default+info_value / conflict) and
stamps each gap with a `trigger` token; the catalog maps token → wording/options/mappings; the
onboarding walk maps the base SET → what to complete once; answer-audit later checks that anything
you answered OVER was disclosed. The judgment half — "is this a build (→ walk) or an analysis
(→ menu)? is asking worth it?" — is deliberately yours (surface + verify, never compel).

## Ask vs. default (when intent is vague)

Ask **only** when guessing is expensive or intent-erasing; otherwise apply a disclosed default:

- **Blocking → ask, targeted**: format unknown and not inferable; `owned_only` but owned unknown;
  a benchmark target that doesn't resolve; an expressive request with no anchor.
- **Safe default → proceed + disclose**: candidate count (2–3), standard-meta assumption, level of
  tuning detail. State the assumption in the answer so the user can react.
- **Conflict → one precise question**: `prefer` ∩ `avoid`, locked ⊄ owned, an ambiguous name with
  ≥2 canonical readings (the dex already refuses to auto-pick).

Checkpoint delegation is a separate context fact, not a guess after the slate: if the user explicitly
asks for one final answer and delegates tie-breaking ("你定", "直接给最终队伍", "不用问我"), encode
`direct_final:true` before context-audit/slate so the checkpoint can suppress candidate-frame pauses.
If the user asks not to pause, encode `skip_checkpoint:true`. Otherwise run checkpoint and surface
`pause:true`.

Question style for beginners: purpose first, no jargon (map "hazards/pivot/stall" internally),
confirm ambiguities proactively when echoing intent back. On a NEW open-ended build, complete the
`--onboarding` guided walk (the base set minus what the request already answers) — that is the
onboarding flow, not a <=3 subset; you may split it across a couple of messages but finish the set
before assembling. Only the steady-state REFINEMENT menu is the "<=3 per round" case. The wording,
mappings and fallbacks live in the `intake` catalog (triggers_on = which audit gap makes each
question worth asking; tier = onboarding base vs conflict template).

## Hard boundaries (unchanged, from the skill's principles)

- **No composite scores, no winners**: never merge facts into a strength number or auto-crown one
  team/Pokémon; the only permitted ordering is the evidence tier of real-team provenance.
- **Library guardrail (transparency, not prohibition)**: real stored teams are AI-facing
  evidence — decompose them into facts and trade-offs. ADOPTING an observed build as a
  recommendation is legitimate (as the library grows it often IS the best-fitting answer) — but
  only through the full chain and WITH provenance: slate surfaces `library_overlap`, and
  answer-audit makes a verbatim recommendation without `observed_provenance` a violation.
  Silent netdecking is the banned thing, not convergence.
- **Two populations stay separate**: meta marginals ⊕ real-team joints; divergence is signal,
  never blended into one figure.
- **Every claim traceable**: quantitative claims (KO, outspeed, survival) come from an operator
  output you actually ran, in the current environment (season/rule stamped).

## Pre-answer: the draft contract + residual prose checks

Much of the old self-audit checklist is now MACHINE-CHECKED by `answer-audit` — but only over
what you put in the draft. The draft (full shape: `team.py schema` → `context_specs.draft_spec`)
is the structured skeleton of your answer. Machine-enforced (violations):

- `recommended[]` — `slate_index` + the exact team-json you present (hash-matched to the slated
  team; re-validated; must be a battery survivor) + `tradeoffs[]` (≥1 each). Entries must be
  DISTINCT teams — repeating one team is a violation and still counts as a single-team answer,
  which needs `single_team_requested: true` (boolean, typed) or `alternatives_omitted_reason`.
- `convergence_rationale{}` — for EVERY battery survivor (recommended or passed over):
  `worst_matchup` / `accepted_by_constraint` / `opportunity_cost`. The checker verifies FILLED,
  never whether the reasoning is good — that discipline is the point.
- Blocking-gap disclosure — every blocking gap you answered over anyway needs an `assumptions`
  entry naming it (a string containing the field token, or the language-independent
  `{gap: <field>, note: …}` form — use the structured form for zh/ja drafts).
- Low-confidence disclosure — a low-confidence candidate must be NAMED in `confidence_notes`
  (one of its species, or `candidate <i>`); a generic note does not count.
- `claims[]` — every quantitative claim with its `evidence_id` + structured `expect`; the audit
  recomputes the coordinates and flags numbers that don't reproduce. Copy damage ids verbatim
  from the slate output (the audit re-binds member/modal direction from it); the `spd` opponent
  side is always the MODAL set.
- Library transparency — a recommended team whose joint set verbatim-matches a stored observed
  team needs `observed_provenance` on its entry (the overlap fact + why the facts fit this
  intent); composition-only convergence needs nothing.
- Verbatim-adoption review — when a recommended team is an exact joint-set copy of a stored observed
  team, it also needs `adoption_review`: the modification types considered (`moves` / `item` /
  `spread` / `nature` / `member`), the reason/evidence for accepting the final shape, and any
  attempted fork. This is a transparency gate, not a must-change gate: keeping the original team is
  allowed when the review says why.
- Build-front-door completion — build-flow drafts (`frame_required:true`) need
  `onboarding_summary:{status:"completed", answered:[...], note:...}`. The audit checks that every
  base onboarding dimension is either covered by context or listed as answered. A one-team request
  can pre-answer `answer_shape`; it cannot silently skip the rest of the initial walk.
- Multi-Mega transparency — a recommended candidate whose slate `mega_plan` registers multiple
  Mega options needs `mega_registration_rationale` on its entry:
  `{primary, alternative_plan, opportunity_cost}`. `primary` may be a canonical string or a
  language-independent object such as `{form: "Mega Blastoise"}`; pure English strings are checked
  against the candidate's registered Mega options, while non-English prose should use the object form
  when mechanical matching matters. The checker also verifies that all three fields are filled.
- Mega-registration conformance — under the default environment posture, reliable frame samples are
  descriptive but load-bearing: the slate must retain a modal registration-count lane. A recommended
  set must include at least one of the slate's modal survivors; selecting only nonmodal survivors
  requires an explicit posture/off-meta intent upstream and a fresh receipt chain. A recommended
  survivor on an acknowledged minority/rare lane also needs
  `mega_registration_deviation:{reason,evidence,opportunity_cost}`. Sample <30 is thin and cannot gate;
  with a reliable sample, >=20% is common, at least 5% but below 20% is minority, and <5% is rare. This is not a claim that
  common is stronger; it prevents the AI's prior from silently replacing the observed team structure.
- Replacement transparency — when you change a previously user-visible/checkpointed candidate frame,
  run `replace` (or an equivalent before/after fact diff) and add `replacement_rationale` to the
  affected recommended entry: `{out, in, reason, benefit, cost, evidence}`. The checker validates
  completeness when this field is present; because the skill is stateless and does not see the
  conversation history, omitting the field is still an orchestrator breach that the machine checker
  cannot always detect.
- `tuning_summary` — REQUIRED. If targeted benchmark tuning was run/proposed, name the benchmark
  facts and concrete nature/SP/item/set decisions. If no benchmark tuning was run, say so with
  `status: "not_run"` (or `"not_applicable"`) and a reason; silence is a violation.
- `single_team_requested` / `alternatives_omitted_reason` when you present one team;
  `request_expressive: true` when the request is self-expression (escalates a missing anchor).

Residual prose checks the machine cannot see (still yours):

- [ ] Grounding ran before assembly (mandate 2) and the candidates reflect it.
- [ ] Every quantitative claim written in your PROSE also appears in `draft.claims` — the audit
      only recomputes what you declared.
- [ ] Conflicts and ambiguous names context-audit surfaced were resolved in conversation (one
      targeted question) or explicitly disclosed — the machine checks blocking gaps only.
- [ ] Every safe default you applied is stated in `assumptions` (the machine enforces this only
      for blocking-tier gaps; the apply-and-disclose duty covers ALL defaults).
- [ ] The draft faithfully transcribes the conversation (intent, constraints, promises).
- [ ] The user's anchor survived every fix.
