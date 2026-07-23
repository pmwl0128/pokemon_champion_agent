/** Vendored NCP calc engine sources, inlined at build time into the calc-engine worker chunk.
 *
 * These are the SAME files ncp_engine.py hosts in quickjs server-side — the 16 `script_res/**`
 * data/handler files plus the two CLI wrappers (`ncp-calc-api.js` / `ncp-speedline-api.js`), which
 * carry ZERO Node deps. Here they run in a browser Web Worker via indirect eval under a stubbed
 * require/fs/vm, so the OnlineAdapter computes damage/speed client-side with no backend at all
 * (apps/design.md §7.1). Kept as raw strings; worker.ts evals them.
 *
 * The path reaches out of apps/web to the installed skill (the single source — no copy that could
 * drift); Vite's `?raw` inlines the file contents into the bundle, and vite.config's server.fs.allow
 * opens the repo root so `vite dev` can read them too. */
import statData from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/stat_data.js?raw";
import natureData from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/nature_data.js?raw";
import typeData from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/type_data.js?raw";
import abilityData from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/ability_data.js?raw";
import itemData from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/item_data.js?raw";
import moveData from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/move_data.js?raw";
import moveDataZa from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/move_data_za.js?raw";
import pokedex from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/pokedex.js?raw";
import koChance from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/ko_chance.js?raw";
import damageMaster from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/damage_MASTER.js?raw";
import damageRby from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/damage_rby.js?raw";
import damageGsc from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/damage_gsc.js?raw";
import damageRse from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/damage_rse.js?raw";
import damageDpp from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/damage_dpp.js?raw";
import damageXy from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/damage_xy.js?raw";
import damageSv from "../../../../../.agents/skills/ncp-damage-calculator/scripts/script_res/damage_SV.js?raw";
import calcApiRaw from "../../../../../.agents/skills/ncp-damage-calculator/scripts/ncp-calc-api.js?raw";
import speedApiRaw from "../../../../../.agents/skills/ncp-damage-calculator/scripts/ncp-speedline-api.js?raw";

/** COLUMN-0 (top-level) const/let -> var. Node's vm shares ONE global lexical scope across a
 * context's scripts, so a top-level const in damage_MASTER.js (e.g. TYPE_CHANGE_BOOST_ABILITIES)
 * is visible in damage_SV.js. Browser indirect eval evals each file in its own scope where a
 * top-level const/let does NOT go global; normalizing to var makes it a global so cross-file refs
 * resolve — exactly _match_node_vm_scope in ncp_engine.py. Indented (in-function) decls untouched. */
const vmScope = (s: string): string => s.replace(/^(const|let)(\s)/gm, "var$2");

/** A shebang is tolerated as line 1 of a script file, but `eval` rejects it as a syntax error. */
const stripShebang = (s: string): string => (s.startsWith("#!") ? s.slice(s.indexOf("\n") + 1) : s);

/** Keyed by the path loadCalculator()'s runFile() asks for: path.join(ROOT, 'script_res/x.js') with
 * ROOT='' yields '/script_res/x.js', which the worker's __read_file strips to this key. */
export const SOURCES: Record<string, string> = {
  "script_res/stat_data.js": vmScope(statData),
  "script_res/nature_data.js": vmScope(natureData),
  "script_res/type_data.js": vmScope(typeData),
  "script_res/ability_data.js": vmScope(abilityData),
  "script_res/item_data.js": vmScope(itemData),
  "script_res/move_data.js": vmScope(moveData),
  "script_res/move_data_za.js": vmScope(moveDataZa),
  "script_res/pokedex.js": vmScope(pokedex),
  "script_res/ko_chance.js": vmScope(koChance),
  "script_res/damage_MASTER.js": vmScope(damageMaster),
  "script_res/damage_rby.js": vmScope(damageRby),
  "script_res/damage_gsc.js": vmScope(damageGsc),
  "script_res/damage_rse.js": vmScope(damageRse),
  "script_res/damage_dpp.js": vmScope(damageDpp),
  "script_res/damage_xy.js": vmScope(damageXy),
  "script_res/damage_SV.js": vmScope(damageSv),
};

/** The two wrappers are eval'd verbatim (their own top-level const/function stay in-scope for the
 * calc/speed entry glue) — NOT vm-scoped: only the cross-file data needs the var normalization. */
export const CALC_API = stripShebang(calcApiRaw);
export const SPEED_API = stripShebang(speedApiRaw);
