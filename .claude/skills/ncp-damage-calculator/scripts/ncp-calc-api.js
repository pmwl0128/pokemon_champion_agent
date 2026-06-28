#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function jqueryStub(val) {
  const stub = {
    is: () => false,
    text: () => stub,
    val: () => val,
    prop: () => false,
    find: () => stub,
    show: () => stub,
    hide: () => stub,
    trigger: () => stub,
    not: () => stub,
  };
  return stub;
}

function deepExtend(target, ...sources) {
  for (const src of sources) {
    if (!src) continue;
    for (const [key, value] of Object.entries(src)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        target[key] = deepExtend(target[key] && typeof target[key] === 'object' ? target[key] : {}, value);
      } else if (Array.isArray(value)) {
        target[key] = value.slice();
      } else {
        target[key] = value;
      }
    }
  }
  return target;
}

function createContext() {
  // Aura abilities (Fairy/Dark Aura, Aura Break) are field-wide effects the NCP UI exposes as
  // checkboxes; headless we derive them per-calc from the on-field abilities (see calculate()) and
  // answer the calculator's checkbox probes from this state instead of always reporting "unchecked".
  const auraState = { auras: new Set(), auraBreak: false };
  const $ = function (selector) {
    if (typeof selector === 'string') {
      const aura = selector.match(/id='([a-z]+)-aura'/);
      if (aura) return jqueryStub(auraState.auras.has(aura[1]) ? 'on' : undefined);
      if (selector.includes("id='aura-break'")) return jqueryStub(auraState.auraBreak ? 'on' : undefined);
    }
    return jqueryStub();
  };
  $.extend = function (...args) {
    let deep = false;
    if (typeof args[0] === 'boolean') {
      deep = args.shift();
    }
    const target = args.shift() || {};
    if (!deep) return Object.assign(target, ...args);
    return deepExtend(target, ...args);
  };
  $.isEmptyObject = obj => !obj || Object.keys(obj).length === 0;

  const context = {
    console,
    Math,
    JSON,
    $,
    window: {},
    document: { getElementById: () => ({ value: 'light' }) },
    localStorage: { getItem: key => (key === 'dex' ? '' : null), setItem: () => {} },
    mechanicsTests: {},
    isCustomMods: false,
    transformSpecies: { p1: '', p2: '' },
    autoLevel: 50,
    resultDisplayMode: 'SPs',
    _auraState: auraState,
    // The UI defines this global; additionalDamageCalcs (Parental Bond, etc.) deep-copies a Pokémon
    // — losing its methods — then restores hasType from it. Mirror buildPokemon's hasType exactly.
    setHasTypeFunc(type) {
      return this.type1 === type || this.type2 === type || (this.isTerastalize && this.tera_type === type);
    },
  };
  context.window = context;
  return vm.createContext(context);
}

function runFile(context, relPath) {
  const fullPath = path.join(ROOT, relPath);
  const code = fs.readFileSync(fullPath, 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}

function loadCalculator() {
  const ctx = createContext();
  [
    'script_res/stat_data.js',
    'script_res/nature_data.js',
    'script_res/type_data.js',
    'script_res/ability_data.js',
    'script_res/item_data.js',
    'script_res/move_data.js',
    'script_res/move_data_za.js',
    'script_res/pokedex.js',
    'script_res/ko_chance.js',
    'script_res/damage_MASTER.js',
    'script_res/damage_rby.js',
    'script_res/damage_gsc.js',
    'script_res/damage_rse.js',
    'script_res/damage_dpp.js',
    'script_res/damage_xy.js',
    'script_res/damage_SV.js',
  ].forEach(file => runFile(ctx, file));

  ctx.gen = 10;
  ctx.pokedex = ctx.POKEDEX_CHAMPIONS;
  ctx.typeChart = ctx.TYPE_CHART_SV;
  ctx.moves = ctx.MOVES_CHAMPIONS;
  ctx.items = ctx.ITEMS_CHAMPIONS;
  ctx.abilities = ctx.ABILITIES_CHAMPIONS;
  ctx.STATS = ctx.STATS_GSC;
  ctx.calcHP = ctx.CALC_HP_CHAMP;
  ctx.calcStat = ctx.CALC_STAT_CHAMP;
  return ctx;
}

function champStat(base, points, nature, stat, ctx) {
  const mods = ctx.NATURES[nature || 'Serious'] || ['', ''];
  const natureMod = mods[0] === stat ? 1.1 : mods[1] === stat ? 0.9 : 1;
  return Math.floor((Math.floor((base * 2 + 31) * 50 / 100) + 5 + (points || 0)) * natureMod);
}

function champHP(base, points) {
  if (base === 1) return 1;
  return Math.floor((base * 2 + 31) * 50 / 100) + 60 + (points || 0);
}

// --- Canonical I/O contract boundary (dev/contracts/conventions.md) --------------------------------
// Callers send smogon stat keys (hp/atk/def/spa/spd/spe), `power`, and lower-case format; the vendored
// NCP engine is native short-key / Title-case, so normalize HERE (still accepting the legacy short keys
// for safety). Damage output carries no stat keys; errors use the uniform {ok,error:{code,message}}.
const SPS_SOURCES = { hp: ['hp'], at: ['atk', 'at'], df: ['def', 'df'], sa: ['spa', 'sa'], sd: ['spd', 'sd'], sp: ['spe', 'sp'] };

function toShortStats(obj, includeHp) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  // Case-insensitive key match: AI/users routinely write Atk/HP/Spe (Title-case). The SPS_SOURCES keys
  // are lower-case, so without folding, obj['atk'] misses an 'Atk' key and the SP silently reads as 0 —
  // a 32-SP build calc'd as a 0-SP blank, with no warning (audit 2026-06-28). Fold input keys to lower.
  const lower = {};
  for (const key of Object.keys(obj)) lower[key.toLowerCase()] = obj[key];
  for (const short of Object.keys(SPS_SOURCES)) {
    if (!includeHp && short === 'hp') continue;
    for (const k of SPS_SOURCES[short]) {
      if (lower[k] != null) { out[short] = lower[k]; break; }
    }
  }
  return out;
}

function normFormat(f) {
  return String(f || '').toLowerCase().startsWith('double') ? 'Doubles' : 'Singles';
}

// A readable echo of the OFFENDING input for the error `query` field (conventions.md error shape).
// `message` (when supplied) lets the echo follow the actual fault: an unknown-Pokémon error must not
// anchor on the move (which parsed fine) — it echoes the Pokémon the engine rejected, named in the
// message — otherwise a batch caller can't see WHICH input failed (audit 2026-06-28).
function queryOf(item, message) {
  if (!item || typeof item !== 'object') return undefined;
  if (message && /unknown pok/i.test(message)) {
    const m = /:\s*(.+?)\s*$/.exec(message);     // "Unknown Pokémon: garchomp" -> "garchomp"
    if (m) return m[1];
    return (item.attacker && item.attacker.name) || (item.defender && item.defender.name) || undefined;
  }
  return item.move || (item.attacker && item.attacker.name) || (item.defender && item.defender.name) || undefined;
}

function errorObj(message, index, query) {
  let code = 'bad_input';
  if (/unknown move/i.test(message)) code = 'unknown_move';
  else if (/unknown pok/i.test(message)) code = 'unknown_pokemon';
  const out = { ok: false };
  if (query != null) out.query = query;          // echo the offending input (conventions.md error shape)
  if (index != null) out.index = index;
  out.error = { code, message };
  return out;
}

// Expected hit count for a variable multi-hit move (design "分情况按期望"): the standard 2-5 move
// distribution (37.5% 2, 37.5% 3, 12.5% 4, 12.5% 5) has mean exactly 3.0, so default to 3 instead of
// the old min-hits (2), which underestimated damage and mis-called KOs — dangerously so on the
// them->us threat side, where fewer hits reads as "you survive" (audit 2026-06-24). Fixed-count and
// rarer ranges fall back to the rounded midpoint. A max-hit ability (Skill Link) overrides this in
// calculate(), where the attacker's ability is known.
function expectedHits(hitRange) {
  if (hitRange == null) return 1;
  if (!Array.isArray(hitRange)) return hitRange || 1;
  const lo = hitRange[0], hi = hitRange[1] ?? hitRange[0];
  if (lo === hi) return lo;
  if (lo === 2 && hi === 5) return 3;        // standard 2-5 distribution: E[hits] ~= 3.1 -> 3
  return Math.round((lo + hi) / 2);          // other variable ranges (rare): midpoint
}

// Resolve a move's hit count using attacker context: a CENTRAL estimate (move.hits, used for the
// headline damage band) plus a realistic [lo,hi] ENVELOPE (move.hitsBand) that consumers widen the
// possible/guaranteed range over. Don't report a single deceptive count — surface the spread, the
// same way the 16 damage rolls are surfaced (audit 2026-06-24). Explicit caller hits collapses both.
function resolveMultiHit(move, attacker) {
  const hr = move.hitRange;
  // Explicit caller count, or no/scalar hitRange (fixed move, or ability-driven like Parental Bond):
  // the realistic band is [hits,hits]. For Parental Bond move.hits is still 1 here and the HANDLER
  // bumps it to 2, so leave the band null -> calculate() defaults it to [final hits, final hits].
  if (move.hitsExplicit) { move.hitsBand = [move.hits, move.hits]; return; }
  if (!Array.isArray(hr)) { move.hitsBand = null; return; }   // scalar (Surging Strikes:3) / none
  const lo = hr[0], hi = hr[1] ?? hr[0];
  if (lo === hi) { move.hits = lo; move.hitsBand = [lo, hi]; return; }
  const skillLink = attacker.abilityOn !== false && attacker.ability === 'Skill Link';
  if (move.isTripleHit) {
    // Escalating per-hit BP (Triple Axel/Kick: 20/40/60). It always ATTEMPTS the max; fewer hits only
    // on an in-game miss (the calc ignores accuracy), so the headline is the full count and the
    // realistic floor is hitRange[0]. calculate() builds the envelope from the real escalating per-hit
    // damage — a linear ratio would be wrong here (that was the audit 2026-06-24 finding).
    move.hits = hi; move.hitsBand = [lo, hi]; return;
  }
  if (move.name === 'Population Bomb') {
    // Item-conditioned CENTRAL (expected) count from the per-hit accuracy distribution (NOT simulated):
    // ~5.9 hits bare, ~9.5 with Wide Lens (+10% accuracy -> 99%). Maushold is a doubles staple. The
    // realistic band is the TRUE [1,10] — low counts genuinely happen (it whiffs per hit), so the
    // envelope floor must be 1, never a fabricated 2/8 that invents a false 'guaranteed' (audit
    // 2026-06-24). Wide Lens (こうかくレンズ) is the accuracy item, NOT Scope Lens (焦点镜, crit).
    move.hits = (skillLink ? hi : attacker.item === 'Wide Lens' ? 9 : 6);
    move.hitsBand = [lo, hi];
    return;
  }
  if (skillLink) { move.hits = hi; move.hitsBand = [hi, hi]; return; }   // Skill Link -> always max
  move.hits = expectedHits(hr);
  move.hitsBand = [lo, hi];
}

// Parse the vendored engine's human KO-chance string into structured fields. The engine (ko_chance.js)
// models between-turn recovery (Sitrus/Leftovers/berries), hazards and end-of-turn chip — so for N>=2
// it is far more accurate than a static N x roll band (audit 2026-06-24, e.g. a Sitrus defender that
// survives a "static 2HKO"). Returns {text, n, guaranteed, chance_pct} or null for status/no-damage.
function parseKoChance(txt) {
  if (typeof txt !== 'string' || !txt) return null;
  const nOf = s => /OHKO/i.test(s) ? 1 : (/(\d+)HKO/i.test(s) ? +RegExp.$1 : null);
  let g = txt.match(/guaranteed\s+(\w*HKO)/i);
  if (g) return { text: txt, n: nOf(g[1]), guaranteed: true, chance_pct: 100 };
  let c = txt.match(/([\d.]+)%\s*chance to\s+(\w*HKO)/i);
  if (c) return { text: txt, n: nOf(c[2]), guaranteed: false, chance_pct: +c[1] };
  let p = txt.match(/(\w*HKO)/i);
  if (p) return { text: txt, n: nOf(p[1]), guaranteed: false, chance_pct: null };
  return null;                                   // "No damage for you" / "It's a status move" / etc.
}

// Static-KO reliability FLAGS (audit 2026-06-24). We do NOT recompute a multi-turn trajectory — that
// crosses from calculator into simulator and has no bounded whitelist (self-buff/drop, Stamina, Sash,
// Disguise, Metronome, Knock Off, Contrary/Simple/White Herb modifiers, speed-BP moves ... all share
// the same logic basis and interact combinatorially). Instead, by INSPECTING THIS ONE SNAPSHOT, we tag
// the known effects that make the static N-hit projection unreliable, with a DIRECTION — so an AI
// reader knows to chain explicit-state snapshots or caveat. Detecting is cheap and near-complete where
// modelling is not: we don't model Contrary x Overheat, we just flag "stat-change interaction present".
// `direction` is relative to the static NHKO: 'overstates' = static is too optimistic (real KO harder),
// 'understates' = too pessimistic (real easier), 'unclear' = depends.
const _ITEM_REMOVAL_MOVES = new Set(['Knock Off', 'Thief', 'Covet', 'Trick', 'Switcheroo',
  'Bug Bite', 'Pluck', 'Incinerate', 'Corrosive Gas']);
const _SPEED_BP_MOVES = new Set(['Electro Ball', 'Gyro Ball']);
const _HP_HALVE_ABIL = new Set(['Multiscale', 'Shadow Shield']);
const _ONE_TIME_SURVIVE_ABIL = new Set(['Sturdy', 'Disguise']);
const _ONE_TIME_SURVIVE_ITEM = new Set(['Focus Sash', 'Focus Band']);
const _STAT_MOD_ABIL = new Set(['Contrary', 'Simple', 'Clear Body', 'Full Metal Body', 'White Smoke',
  'Hyper Cutter', 'Big Pecks', 'Mirror Armor', 'Defiant', 'Competitive']);

function detectKoCaveats(ctx, attacker, defender, move) {
  const out = [];
  const add = (code, direction, cause) => out.push({ code, direction, cause });
  const dAb = defender.abilityOn === false ? '' : (defender.ability || '');
  const aAb = attacker.abilityOn === false ? '' : (attacker.ability || '');
  // 1. the move's own deterministic stat change (Draco Meteor/Overheat self -SpA, Torch Song +SpA,
  //    Power-Up Punch +Atk, Acid Spray/Apple Acid target -SpD, ...). Read generically from statChange.
  const sc = (ctx.moves[move.name] || {}).statChange;            // [stat, stages, target]
  if (Array.isArray(sc) && sc[1]) {
    const stat = sc[0], stages = sc[1], self = sc[2] === 'user';
    const off = stat === 'attack' || stat === 'special attack';
    const def = stat === 'defense' || stat === 'special defense';
    if (self && off) add(stages < 0 ? 'self_offense_drop' : 'self_offense_buff',
      stages < 0 ? 'overstates' : 'understates', `${move.name}: ${stages > 0 ? '+' : ''}${stages} ${stat} on the user per use`);
    else if (!self && def) add(stages < 0 ? 'target_defense_drop' : 'target_defense_buff',
      stages < 0 ? 'understates' : 'overstates', `${move.name}: ${stages > 0 ? '+' : ''}${stages} ${stat} on the target per use`);
  }
  // 2. defender abilities that change incoming damage across hits
  if (dAb === 'Stamina') add('defender_stamina', 'overstates', 'Stamina: +1 Def per hit (tankier each turn)');
  if (dAb === 'Weak Armor' && move.category === 'Physical') add('defender_weak_armor', 'understates', 'Weak Armor: -1 Def per physical hit (softer each turn)');
  if (_HP_HALVE_ABIL.has(dAb)) add('defender_hp_halve', 'understates', `${dAb}: halves damage ONLY at full HP — this static number over-applies it past turn 1`);
  if (_ONE_TIME_SURVIVE_ABIL.has(dAb)) add('defender_one_time_survive', 'overstates', `${dAb}: survives a lethal hit once (turn-1 OHKO/2HKO claims can be wrong)`);
  // 3. items: one-time survive, ramp; (Sitrus/Leftovers recovery is already modelled in ko_chance)
  if (_ONE_TIME_SURVIVE_ITEM.has(defender.item)) add('defender_one_time_survive', 'overstates', `${defender.item}: survives a OHKO from full HP once`);
  if (attacker.item === 'Metronome') add('attacker_ramp', 'understates', 'Metronome: damage ramps on consecutive same-move use');
  // 4. move-driven downstream change / state-dependent BP
  if (_ITEM_REMOVAL_MOVES.has(move.name)) add('item_removal', 'unclear', `${move.name} removes the target's item — downstream recovery/berry/Sash/Multiscale assumptions change`);
  if (_SPEED_BP_MOVES.has(move.name)) add('speed_bp', 'unclear', `${move.name} BP depends on the speed ratio — changes with paralysis / speed boosts`);
  // 5. stat-change MODIFIER abilities/items — only relevant when a stat change is actually in play
  //    (Contrary flips Overheat's drop to a +2 buff; White Herb resets it). Gated to that, so a mon's
  //    Clear Body with no stat change in the matchup doesn't add noise.
  if (out.some(c => /_offense_|_defense_|stamina|weak_armor/.test(c.code))) {
    if (_STAT_MOD_ABIL.has(aAb)) add('stat_change_modifier', 'unclear', `attacker ${aAb} can alter how those stat changes apply`);
    if (_STAT_MOD_ABIL.has(dAb)) add('stat_change_modifier', 'unclear', `defender ${dAb} can alter how those stat changes apply`);
    if (attacker.item === 'White Herb' || defender.item === 'White Herb') add('white_herb', 'unclear', 'White Herb resets a stat drop once');
  }
  return out.length ? out : null;
}

function moveDetails(name, ctx, overrides = {}) {
  const base = ctx.moves[name];
  if (!base) throw new Error(`Unknown move: ${name}`);
  return Object.assign({}, base, {
    name,
    bp: overrides.power ?? overrides.bp ?? base.bp ?? 0,
    type: overrides.type ?? base.type,
    category: overrides.category ?? base.category,
    isCrit: !!overrides.isCrit,
    isZ: false,
    hits: overrides.hits ?? expectedHits(base.hitRange),
    hitRange: base.hitRange ?? null,          // kept so calculate() can apply a max-hit ability
    hitsExplicit: overrides.hits != null,     // an explicit caller count wins over ability adjustment
    isDouble: 0,
    combinePledge: 0,
    timesAffected: overrides.timesAffected || 0,
    usedOppMoveIndex: 0,
    getsStellarBoost: false,
    isPlusMove: false,
  });
}

function buildPokemon(input, ctx) {
  const name = input.name;
  const dex = ctx.pokedex[name];
  if (!dex) throw new Error(`Unknown Pokémon: ${name}`);
  const sps = Object.assign({ hp: 0, at: 0, df: 0, sa: 0, sd: 0, sp: 0 }, toShortStats(input.sps, true));
  const boosts = Object.assign({ at: 0, df: 0, sa: 0, sd: 0, sp: 0 }, toShortStats(input.boosts, false));
  const rawStats = {
    at: champStat(dex.bs.at, sps.at, input.nature, 'at', ctx),
    df: champStat(dex.bs.df, sps.df, input.nature, 'df', ctx),
    sa: champStat(dex.bs.sa, sps.sa, input.nature, 'sa', ctx),
    sd: champStat(dex.bs.sd, sps.sd, input.nature, 'sd', ctx),
    sp: champStat(dex.bs.sp, sps.sp, input.nature, 'sp', ctx),
  };
  const maxHP = champHP(dex.bs.hp, sps.hp);
  const moves = (input.moves || ['(No Move)', '(No Move)', '(No Move)', '(No Move)'])
    .slice(0, 4)
    .map(m => typeof m === 'string' ? moveDetails(m, ctx) : moveDetails(m.name, ctx, m));
  while (moves.length < 4) moves.push(moveDetails('(No Move)', ctx));
  return {
    name,
    type1: input.type1 || dex.t1,
    type2: input.type2 || dex.t2,
    tera_type: input.teraType || input.type1 || dex.t1,
    level: 50,
    maxHP,
    curHP: input.curHP || maxHP,
    HPSPs: sps.hp,
    HPEVs: sps.hp,
    HPIVs: 31,
    HPraw: maxHP,
    isDynamax: false,
    gmax_factor: false,
    isTerastalize: !!input.tera,
    rawStats,
    boosts,
    stats: Object.assign({}, rawStats),
    sps,
    evs: sps,
    ivs: { hp: 31, at: 31, df: 31, sa: 31, sd: 31, sp: 31 },
    nature: input.nature || 'Serious',
    ability: input.ability !== undefined ? input.ability : dex.ab || '',
    abilityOn: input.abilityOn !== false,
    supremeOverlord: input.supremeOverlord || 0,
    rivalryGender: '',
    highestStat: input.highestStat ?? -1,
    item: input.item || '',
    status: input.status || 'Healthy',
    toxicCounter: 0,
    moves,
    glaiveRushMod: false,
    weight: input.weight || dex.w || 0,
    canEvolve: !!dex.canEvolve,
    isTransformed: false,
    hasType(type) { return this.type1 === type || this.type2 === type || (this.isTerastalize && this.tera_type === type); },
  };
}

function side(rawInput = {}, shared = {}) {
  // Canonical contract uses snake_case side flags (helping_hand / light_screen / aurora_veil); accept
  // those AND the legacy camelCase by folding snake_case keys to camelCase before reading (audit 2026-06-23).
  const input = {};
  for (const [k, v] of Object.entries(rawInput)) {
    input[k] = v;
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (camel !== k && !(camel in rawInput)) input[camel] = v;
  }
  return {
    format: shared.format || 'Singles',
    terrain: shared.terrain || '',
    weather: shared.weather || '',
    isGravity: !!shared.gravity,
    isReflect: !!input.reflect,
    isLightScreen: !!input.lightScreen,
    isAuroraVeil: !!input.auroraVeil,
    isForesight: !!input.foresight,
    isHelpingHand: !!input.helpingHand,
    isFriendGuard: !!input.friendGuard,
    isBattery: !!input.battery,
    isPowerSpot: !!input.powerSpot,
    isSteelySpirit: !!input.steelySpirit,
    isFlowerGiftAtk: !!input.flowerGiftAtk,
    isFlowerGiftSpD: !!input.flowerGiftSpD,
    isTailwind: !!input.tailwind,
    isSwamp: !!input.swamp,
    isSeaFire: !!input.seaFire,
    isRedItem: !!input.redItem,
    isBlueItem: !!input.blueItem,
    isCharge: !!input.charge,
    spikes: input.spikes || 0,
    steelsurge: !!input.steelsurge,
    vinelash: !!input.vinelash,
    wildfire: !!input.wildfire,
    cannonade: !!input.cannonade,
    volcalith: !!input.volcalith,
    isSR: !!input.stealthRock,
    isSeeded: !!input.seeded,
    isProtected: !!input.protect,
    isNeutralizingGas: false,
    isGMaxField: false,
    isSaltCure: false,
  };
}

function field(input = {}) {
  const shared = {
    format: normFormat(input.format),
    terrain: input.terrain || '',
    weather: input.weather || '',
    gravity: !!input.gravity,
  };
  const sides = [side(input.attackerSide, shared), side(input.defenderSide, shared)];
  return {
    format: normFormat(input.format),
    weather: input.weather || '',
    terrain: input.terrain || '',
    isGravity: !!input.gravity,
    isForesight: !!input.foresight,
    isMagicRoom: !!input.magicRoom,
    isWonderRoom: !!input.wonderRoom,
    isBeadsOfRuin: !!input.beadsOfRuin,
    isSwordOfRuin: !!input.swordOfRuin,
    isTabletsOfRuin: !!input.tabletsOfRuin,
    isVesselOfRuin: !!input.vesselOfRuin,
    getWeather() { return this.weather; },
    getTerrain() { return this.terrain; },
    getNeutralGas() { return false; },
    getTailwind(i) { return sides[i]?.isTailwind || false; },
    getSwamp(i) { return sides[i]?.isSwamp || false; },
    getSide(i) { return sides[i] || side(); },
  };
}

function calculate(input, ctx) {
  // ctx (the loaded calculator: pokedex/moves/type data + handlers) is reusable across calcs.
  // Loading it parses ~15 data files and dominates per-call cost, so batch mode loads it ONCE
  // and threads it through here; a single call still loads its own on demand.
  ctx = ctx || loadCalculator();
  const attacker = buildPokemon(input.attacker, ctx);
  const defender = buildPokemon(input.defender, ctx);
  const f = field(input.field || {});
  const moveName = input.move || attacker.moves[0].name;
  const move = attacker.moves.find(m => m.name === moveName) || moveDetails(moveName, ctx);
  resolveMultiHit(move, attacker);   // sets move.hits (central) + move.hitsBand ([lo,hi] envelope)
  // GET_DAMAGE_HANDLER expects stats to already carry stat-stage boosts — the upstream UI applies
  // them in CALCULATE_ALL_MOVES_SV before dispatching, which we bypass by calling the handler
  // directly. Replicate that here so boosts (Swords Dance, Choice... -1, etc.) actually affect damage.
  const applyBoosts = (p) => {
    const s = Object.assign({}, p.rawStats);
    // Speed ('sp') is included so speed-stage boosts feed the speed-ratio variable-BP moves
    // (Electro Ball: faster = stronger; Gyro Ball: slower = stronger). Without it those moves were
    // computed off bare Speed regardless of Agility/Icy Wind/etc. (audit 2026-06-24). Every other
    // move ignores Speed in the damage formula, so this only affects Electro/Gyro BP.
    for (const k of ['at', 'df', 'sa', 'sd', 'sp']) {
      if (p.boosts && p.boosts[k]) s[k] = ctx.getModifiedStat(p.rawStats[k], p.boosts[k]);
    }
    p.stats = s;
  };
  applyBoosts(attacker);
  applyBoosts(defender);
  // Auras are field-wide ability effects the UI gates behind checkboxes; headless, activate them from
  // the on-field abilities so e.g. an attacking Fairy Aura mon gets the 1.33x on its Fairy moves.
  if (ctx._auraState) {
    ctx._auraState.auras.clear();
    ctx._auraState.auraBreak = false;
    for (const p of [attacker, defender]) {
      if (p.abilityOn === false || !p.ability) continue;
      if (p.ability === 'Aura Break') ctx._auraState.auraBreak = true;
      else if (p.ability.endsWith(' Aura')) ctx._auraState.auras.add(p.ability.slice(0, -5).toLowerCase());
    }
  }
  // The handler reads BOTH offensive (Helping Hand / Battery / ...) and defensive (Reflect /
  // Light Screen / ...) flags off the single side it receives. Offensive flags belong to the
  // attacker's side and defensive ones to the defender's, so merge them: defender side as the base
  // (defensive + shared weather/terrain), with the attacker side's offensive flags overlaid.
  const OFFENSIVE_SIDE_FLAGS = ['isHelpingHand', 'isBattery', 'isPowerSpot', 'isSteelySpirit',
                                'isFlowerGiftAtk', 'isCharge', 'isRedItem', 'isBlueItem'];
  const attackerSide = f.getSide(0);
  const handlerSide = Object.assign({}, f.getSide(1));
  for (const k of OFFENSIVE_SIDE_FLAGS) handlerSide[k] = attackerSide[k];
  const result = ctx.GET_DAMAGE_HANDLER(attacker, defender, move, handlerSide);
  // Multi-hit damage: build the CENTRAL band (the headline rolls) AND a TRUE damage envelope
  // [envLo, envHi] computed from the real per-hit damage — never a linear ratio. The realistic
  // hit-count band is move.hitsBand ([lo,hi]); ability-driven counts (Parental Bond) set move.hits in
  // the handler, so default the band to [hits,hits] when resolveMultiHit couldn't (no hitRange).
  const rawDamage = result.damage;
  const band = move.hitsBand || [move.hits, move.hits];
  const lo = band[0], hi = band[1];
  let central, envLo, envHi;
  if (Array.isArray(rawDamage) && Array.isArray(rawDamage[0])) {
    // Per-hit arrays: escalating moves (Triple Axel/Kick 20/40/60), Parental Bond, ability variance.
    // The damage at k hits is the CUMULATIVE sum of the first k sub-arrays — so the envelope uses real
    // partial sums (a linear ratio would be wrong for escalating BP; audit 2026-06-24).
    const perHit = rawDamage, n = perHit[0].length, m = perHit.length;
    const partial = (k, i) => perHit.slice(0, k).reduce((s, h) => s + (h[i] || 0), 0);
    central = Array.from({ length: n }, (_, i) => partial(m, i));
    const loHits = Math.max(1, Math.min(lo, m)), hiHits = Math.min(hi, m);
    envLo = Math.min(...Array.from({ length: n }, (_, i) => partial(loHits, i)));
    envHi = Math.max(...Array.from({ length: n }, (_, i) => partial(hiHits, i)));
  } else if (Array.isArray(rawDamage) && move.hits > 1) {
    // Uniform multi-hit (Scale Shot / Bullet Seed / Population Bomb ...): the handler returns ONE hit's
    // rolls; an N-hit total is N x that. Envelope ENDPOINTS are exact: lo hits x worst roll .. hi hits
    // x best roll (the interior distribution is approximate — independent rolls aren't convolved).
    const single = rawDamage, minS = Math.min(...single), maxS = Math.max(...single);
    central = single.map(d => d * move.hits);
    envLo = lo * minS; envHi = hi * maxS;
  } else {
    central = Array.isArray(rawDamage) ? rawDamage.slice() : [];
    envLo = central.length ? Math.min(...central) : 0;
    envHi = central.length ? Math.max(...central) : 0;
  }
  const damage = central.slice().sort((a, b) => a - b);
  const hp = defender.maxHP;
  const pct = d => +(d * 100 / hp).toFixed(1);
  // Engine-accurate KO chance (models Sitrus/Leftovers/hazards/end-of-turn recovery). Feed the RAW
  // handler damage + the move: getKOChanceText convolves the single-hit rolls move.hits times itself,
  // so passing our already-multiplied central band would double-count. handlerSide carries the field
  // (weather/terrain/hazards). Best-effort: any engine hiccup leaves ko_chance null, never fails the calc.
  let koChance = null;
  if (move.category !== 'Status' && Array.isArray(rawDamage) && rawDamage.length) {
    try {
      koChance = parseKoChance(ctx.getKOChanceText(rawDamage, move, defender, handlerSide, false, !attacker.item));
    } catch (e) { koChance = null; }
  }
  // Static-KO reliability flags: DETECT (don't model) the effects that make this snapshot's multi-turn
  // KO unreliable, with a direction. Single-snapshot inspection — stays a calculator (audit 2026-06-24).
  let koCaveats = null;
  if (move.category !== 'Status' && Array.isArray(rawDamage) && rawDamage.length) {
    try { koCaveats = detectKoCaveats(ctx, attacker, defender, move); } catch (e) { koCaveats = null; }
  }
  const description = typeof result.description === 'string'
    ? result.description
    : result.description
      ? ctx.buildDescription(result.description)
      : `${attacker.name} ${moveName} vs. ${defender.name}`;
  return {
    description,
    damage,
    damagePercent: damage.map(pct),
    min: damage[0] ?? null,
    max: damage[damage.length - 1] ?? null,
    minPercent: damage.length ? pct(damage[0]) : null,
    maxPercent: damage.length ? pct(damage[damage.length - 1]) : null,
    defenderHP: hp,
    hits: move.hits,                          // central hit count the headline band reflects
    hits_range: band,                         // [lo,hi] realistic hit-count band
    // TRUE damage envelope over hits_range (real per-hit damage, not a ratio): floor = fewest hits x
    // worst roll, ceiling = most hits x best roll. Consumers widen KO over this instead of rebuilding it.
    min_env: damage.length ? envLo : null,
    max_env: damage.length ? envHi : null,
    min_env_percent: damage.length ? pct(envLo) : null,
    max_env_percent: damage.length ? pct(envHi) : null,
    ko_chance: koChance,        // engine KO verdict (recovery-aware); null for status/no-damage
    ko_caveats: koCaveats,      // [{code,direction,cause}] effects that make the STATIC multi-turn KO
    //                            unreliable (DETECTED, not modelled); null when none apply
    move: moveName,
    attacker: attacker.name,
    defender: defender.name,
  };
}

function runCommand(command, input, ctx) {
  if (command === 'batch') {
    // One loaded calculator reused for every request; each item fault-isolated.
    return input.map((item, i) => {
      try {
        return calculate(item, ctx);
      } catch (e) {
        const msg = String(e && e.message || e);
        return errorObj(msg, i, queryOf(item, msg));
      }
    });
  }
  return calculate(input, ctx);
}

function serve() {
  // Persistent worker (perf: amortize node startup + calculator load across a session). Reads
  // NDJSON requests {"argv":[cmd],"stdin":<payload-json>} on stdin, replies one line
  // {"ok":true,"stdout":<result-json>} — reusing ONE loaded calculator. Exits on EOF/_shutdown.
  const ctx = loadCalculator();
  const rl = require('readline').createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let req;
    try { req = JSON.parse(line); } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: 'bad request' }) + '\n'); return;
    }
    const argv = req.argv || [];
    if (argv[0] === '_shutdown') { rl.close(); return; }
    try {
      const input = JSON.parse(req.stdin || 'null');
      const result = runCommand(argv[0] || 'one', input, ctx);
      process.stdout.write(JSON.stringify({ ok: true, stdout: JSON.stringify(result) }) + '\n');
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }) + '\n');
    }
  });
  rl.on('close', () => process.exit(0));
}

// Machine-readable I/O contract (dev/contracts/conventions.md), emitted by `schema`. Side flags accept
// canonical snake_case (helping_hand/light_screen/aurora_veil); legacy camelCase is still accepted.
const SCHEMA = {
  skill: 'ncp-damage-calculator', cli: 'ncp-calc-api.js',
  contract: 'dev/contracts/conventions.md',
  stat_keys: ['hp', 'atk', 'def', 'spa', 'spd', 'spe'],
  commands: { one: 'single calc object on stdin', batch: 'array on stdin -> array (faults isolated per item)',
    serve: 'NDJSON resident worker', schema: 'this contract' },
  input: {
    'attacker/defender': { name: 'str', ability: 'str', item: 'str', nature: 'str',
      sps: '{hp,atk,def,spa,spd,spe:int}  (smogon; legacy at/df/sa/sd/sp still accepted)',
      boosts: '{atk,def,spa,spd,spe:-6..6}', moves: '[name | {name,power,type,category}]',
      status: 'Healthy|Burned|Paralyzed|Poisoned|Badly Poisoned|Asleep|Frozen', curHP: 'int' },
    move: 'str (move name)',
    field: { format: 'single|double', weather: 'Rain|Sun|Sand|Snow|""',
      terrain: 'Electric|Grassy|Psychic|Misty|""', attackerSide: '{helping_hand,battery,...}',
      defenderSide: '{reflect,light_screen,aurora_veil,stealth_rock}  (snake_case; camelCase also accepted; stealth_rock chips the defender, affecting ko_chance only)' },
  },
  output: { description: 'str', damage: '[int] sorted (16 rolls; [0] if type-immune)', min: 'int', max: 'int',
    minPercent: 'float', maxPercent: 'float', defenderHP: 'int',
    hits: 'int (central hit count the headline band reflects; expected for variable multi-hit)',
    hits_range: '[lo,hi] realistic hit-count band (collapses to [n,n] for fixed/explicit)',
    min_env: 'int  | TRUE damage envelope over hits_range (real per-hit damage, not a ratio): fewest hits x worst roll',
    max_env: 'int  | ...most hits x best roll. With min/max_env_percent. Consumers widen KO over this, not the central band',
    ko_chance: '{text,n,guaranteed,chance_pct} | engine KO verdict modelling Sitrus/Leftovers/hazards (recovery-aware; null for status/no-damage)',
    ko_caveats: '[{code,direction,cause}] | DETECTED effects making the static multi-turn KO unreliable (self/target stat-change, Stamina/Weak Armor, Multiscale, Sash/Sturdy/Disguise, Metronome, Knock Off, speed-BP, Contrary/Simple/White Herb...). direction = static overstates|understates|unclear the KO. NOT modelled — chain explicit-state snapshots to resolve. null when none apply',
    move: 'str', attacker: 'str', defender: 'str' },
  error_shape: { ok: false, query: '<input echo: move or attacker name>', index: 'int (batch only)',
    error: { code: 'unknown_move|unknown_pokemon|bad_input', message: 'str' } },
};

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'one';
  if (command === 'serve') return serve();
  if (command === 'schema') { process.stdout.write(JSON.stringify(SCHEMA, null, 2) + '\n'); return; }
  const fileArg = args.find(a => a === '--input' || a === '-i');
  const file = fileArg ? args[args.indexOf(fileArg) + 1] : null;
  const payload = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  // One-shot: load the calculator once for this process and run the requested command. Batch
  // fault-isolates per item; a single/one calc surfaces a failure as the uniform error shape + exit 1.
  let input;
  try {
    input = JSON.parse(payload);
    const output = runCommand(command, input, loadCalculator());
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } catch (e) {
    const msg = String(e && e.message || e);
    process.stdout.write(JSON.stringify(
      errorObj(msg, undefined, queryOf(input, msg)), null, 2) + '\n');
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { calculate, loadCalculator, buildPokemon, champStat, champHP, toShortStats, errorObj, normFormat };
