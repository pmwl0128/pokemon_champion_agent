#!/usr/bin/env node
const fs = require('fs');
const { loadCalculator, buildPokemon, toShortStats, errorObj } = require('./ncp-calc-api.js');

function natureMod(ctx, nature, stat) {
  const mods = ctx.NATURES[nature || 'Timid'] || ['', ''];
  return mods[0] === stat ? 1.1 : mods[1] === stat ? 0.9 : 1;
}

function defaultAbility(dex) {
  if (!dex) return '';
  if (typeof dex.ab === 'string') return dex.ab;
  if (Array.isArray(dex.ab)) return dex.ab.find(Boolean) || '';
  if (dex.ab && typeof dex.ab === 'object') {
    return Object.keys(dex.ab).sort().map(k => dex.ab[k]).find(Boolean) || '';
  }
  return '';
}

function champSpeed(base, input, ctx) {
  const sps = Object.assign({ sp: 32 }, input.sps || {});
  const ivs = Object.assign({ sp: input.iv ?? 31 }, input.ivs || {});
  const iv = ivs.sp ?? 31;
  const nature = input.nature || 'Timid';
  return Math.floor((Math.floor((base * 2 + iv) * 50 / 100) + 5 + (sps.sp || 0)) * natureMod(ctx, nature, 'sp'));
}

function speedOne(input, ctx = loadCalculator()) {
  const name = input.name || input.pokemon;
  const dex = ctx.pokedex[name];
  if (!dex) throw new Error(`Unknown Pokemon: ${name}`);

  // Canonical contract: callers send smogon stat keys; normalize to the engine's short keys here.
  const merged = Object.assign({}, input, {
    name,
    nature: input.nature || 'Timid',
    sps: Object.assign({ hp: 0, at: 0, df: 0, sa: 0, sd: 0, sp: 32 }, toShortStats(input.sps, true)),
    ivs: Object.assign({ sp: input.iv ?? 31 }, toShortStats(input.ivs, true)),
    boosts: Object.assign({ at: 0, df: 0, sa: 0, sd: 0, sp: 0 }, toShortStats(input.boosts, false)),
    ability: input.ability ?? (input.useDefaultAbility ? defaultAbility(dex) : ''),
    item: input.item || '',
    status: input.status || 'Healthy',
  });
  const pokemon = buildPokemon(merged, ctx);
  const rawSpeed = champSpeed(dex.bs.sp, merged, ctx);
  pokemon.rawStats.sp = rawSpeed;
  pokemon.stats.sp = rawSpeed;
  pokemon.boosts.sp = merged.boosts.sp || 0;

  const field = input.field || {};
  const tailwind = !!(field.tailwind || field.attackerSide?.tailwind || field.side?.tailwind);
  const swamp = !!(field.swamp || field.attackerSide?.swamp || field.side?.swamp);
  const weather = field.weather || '';
  const terrain = field.terrain || '';
  const finalSpeed = ctx.getFinalSpeed(pokemon, weather, tailwind, swamp, terrain);
  const boostedSpeed = ctx.getModifiedStat(rawSpeed, pokemon.boosts.sp);

  return {
    name,
    types: [dex.t1, dex.t2].filter(Boolean),
    baseSpeed: dex.bs.sp,
    nature: merged.nature,
    speedSPs: merged.sps.sp,
    speedIV: (merged.ivs && merged.ivs.sp) ?? merged.iv ?? 31,
    speedBoost: pokemon.boosts.sp,
    rawSpeed,
    boostedSpeed,
    finalSpeed,
    ability: pokemon.ability,
    item: pokemon.item,
    status: pokemon.status,
    field: { weather, terrain, tailwind, swamp },
  };
}

function normalizeType(type) {
  if (!type) return '';
  const aliases = {
    normal: 'Normal', fire: 'Fire', water: 'Water', electric: 'Electric', grass: 'Grass',
    ice: 'Ice', fighting: 'Fighting', poison: 'Poison', ground: 'Ground', flying: 'Flying',
    psychic: 'Psychic', bug: 'Bug', rock: 'Rock', ghost: 'Ghost', dragon: 'Dragon',
    dark: 'Dark', steel: 'Steel', fairy: 'Fairy',
  };
  return aliases[String(type).toLowerCase()] || type;
}

function includeByFilters(row, filters = {}) {
  if (filters.mega !== undefined && row.name.startsWith('Mega ') !== !!filters.mega) return false;
  if (filters.baseSpeedMin !== undefined && row.baseSpeed < filters.baseSpeedMin) return false;
  if (filters.baseSpeedMax !== undefined && row.baseSpeed > filters.baseSpeedMax) return false;
  if (filters.speedMin !== undefined && row.finalSpeed < filters.speedMin) return false;
  if (filters.speedMax !== undefined && row.finalSpeed > filters.speedMax) return false;
  if (filters.type) {
    const types = Array.isArray(filters.type) ? filters.type : [filters.type];
    for (const t of types.map(normalizeType)) {
      if (!row.types.includes(t)) return false;
    }
  }
  if (filters.types) {
    const types = Array.isArray(filters.types) ? filters.types : [filters.types];
    for (const t of types.map(normalizeType)) {
      if (!row.types.includes(t)) return false;
    }
  }
  return true;
}

function speedTable(input, ctx = loadCalculator()) {
  const defaults = input.defaults || {};
  const names = input.pokemon || input.names || Object.keys(ctx.pokedex);
  const rows = [];
  for (const name of names) {
    if (!ctx.pokedex[name]) continue;
    const dex = ctx.pokedex[name];
    const row = speedOne(Object.assign({}, defaults, {
      name,
      ability: defaults.ability ?? (defaults.useDefaultAbility ? defaultAbility(dex) : ''),
      field: input.field || defaults.field || {},
    }), ctx);
    if (includeByFilters(row, input.filters || {})) rows.push(row);
  }
  const sort = input.sort || 'desc';
  rows.sort((a, b) => sort === 'asc'
    ? a.finalSpeed - b.finalSpeed || a.name.localeCompare(b.name)
    : b.finalSpeed - a.finalSpeed || a.name.localeCompare(b.name));
  const limit = input.limit ? Math.max(0, input.limit) : 0;
  return {
    defaults: Object.assign({ nature: 'Timid', sps: { sp: 32 } }, defaults),
    field: input.field || defaults.field || {},
    filters: input.filters || {},
    count: rows.length,
    rows: limit ? rows.slice(0, limit) : rows,
  };
}

// --- Name resolution (cross-skill key alignment; shares the pokedex with the calc CLI) -------------
// The pokedex is keyed by exact English NCP names, so a name differing only in case/spacing/hyphenation
// silently fails. `resolve` aligns any name to the real pokedex key (or returns did-you-mean candidates)
// so a caller never hand-scans script_res/pokedex.js.
function normName(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[\s._'’\-]/g, '');
}
function nameIndex(ctx) {
  if (ctx._nameIndex) return ctx._nameIndex;
  const m = new Map();
  for (const k of Object.keys(ctx.pokedex)) m.set(normName(k), k);
  ctx._nameIndex = m;
  return m;
}
function resolveNames(input, ctx) {
  const names = Array.isArray(input) ? input : (input && (input.names || input.pokemon)) || [];
  const idx = nameIndex(ctx);
  return names.map((q) => {
    const key = String(q);
    if (Object.prototype.hasOwnProperty.call(ctx.pokedex, key)) return { query: key, ok: true, name: key, match: 'exact' };
    const hit = idx.get(normName(key));
    if (hit) return { query: key, ok: true, name: hit, match: 'normalized' };
    const nk = normName(key);
    const suggestions = nk ? Object.keys(ctx.pokedex).filter((k) => normName(k).includes(nk)).slice(0, 5) : [];
    return { query: key, ok: false, name: null,
      error: { code: 'unknown_pokemon', message: `unknown Pokemon: ${key}` }, suggestions };
  });
}

// --- Speed comparison / outspeed verdict ----------------------------------------------------------
// SKILL.md advertises "does X outspeed Y"; `compare` gives the verdict directly instead of making the
// caller run two `one` queries and eyeball the numbers. Each side is a full speed input (nature/item/
// ability/boosts/status/field), so Choice Scarf / Tailwind / paralysis all fold into finalSpeed. `faster`
// is the raw-speed verdict; `moves_first` also honors Trick Room (slower acts first) when set.
function compareSpeed(input, ctx) {
  const tr = !!(input && (input.trick_room || (input.field && input.field.trickroom)));
  if (Array.isArray(input)) {
    const rows = input.map((p) => { const r = speedOne(p, ctx); return { name: r.name, finalSpeed: r.finalSpeed }; });
    const order = [...rows].sort((x, y) => (tr ? x.finalSpeed - y.finalSpeed : y.finalSpeed - x.finalSpeed));
    const top = order.length ? order[0].finalSpeed : null;
    const movesFirst = order.filter((r) => r.finalSpeed === top).map((r) => r.name);
    return { trick_room: tr, rows, order, moves_first: movesFirst };
  }
  const a = speedOne(input.a, ctx), b = speedOne(input.b, ctx);
  const da = a.finalSpeed, db = b.finalSpeed, tie = da === db;
  const aFirst = tr ? da < db : da > db;
  return {
    trick_room: tr,
    a: { name: a.name, finalSpeed: da }, b: { name: b.name, finalSpeed: db },
    faster: tie ? 'tie' : (da > db ? 'a' : 'b'),
    margin: Math.abs(da - db),
    moves_first: tie ? 'tie' : (aFirst ? 'a' : 'b'),
  };
}

// Machine-readable I/O contract (dev/conventions.md), emitted by `schema`.
const SCHEMA = {
  skill: 'ncp-damage-calculator', cli: 'ncp-speedline-api.js',
  contract: 'dev/conventions.md',
  commands: { one: 'single speed query on stdin', batch: 'array -> array (faults isolated)',
    table: '{defaults,filters,sort,limit,pokemon} -> {rows:[...]}',
    compare: '{a:<speed input>, b:<speed input>, trick_room?:bool} (or an array of inputs) -> the outspeed verdict: {a,b,faster:a|b|tie, margin, moves_first} (array -> {rows, order, moves_first[]}). Each side is a full speed input, so Scarf/Tailwind/paralysis fold into finalSpeed; moves_first honors Trick Room',
    resolve: 'names on stdin ([names] or {names:[...]}) -> [{query,ok,name,match|error,suggestions}]; aligns any name to the exact NCP pokedex key',
    schema: 'this contract' },
  input: { name: 'str', nature: 'str',
    sps: '{spe:int}  (smogon; legacy sp still accepted)', ivs: '{spe:int}',
    boosts: '{spe:-6..6}', ability: 'str', item: 'str', status: 'str',
    field: '{weather,terrain,tailwind,swamp}' },
  output: { name: 'str', types: ['Type'], baseSpeed: 'int', nature: 'str', speedSPs: 'int',
    speedIV: 'int', speedBoost: 'int', rawSpeed: 'int', boostedSpeed: 'int', finalSpeed: 'int' },
  // query echoes the offending Pokémon name (conventions.md uniform error shape — calc carries it too).
  error_shape: { ok: false, query: 'str (echo of input.name)', index: 'int (batch only)', error: { code: 'unknown_pokemon|bad_input', message: 'str' } },
};

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'one';
  if (command === 'schema') { process.stdout.write(JSON.stringify(SCHEMA, null, 2) + '\n'); return; }
  if (!['one', 'batch', 'table', 'compare', 'resolve'].includes(command)) {
    process.stdout.write(JSON.stringify({ ok: false, query: command,
      error: { code: 'bad_input', message: `unknown command '${command}'; expected one|batch|table|compare|resolve|schema` } }, null, 2) + '\n');
    process.exit(1);
  }
  const fileArg = args.find(a => a === '--input' || a === '-i');
  const file = fileArg ? args[args.indexOf(fileArg) + 1] : null;
  const payload = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  let input;
  try {
    input = payload.trim() ? JSON.parse(payload) : {};
    const ctx = loadCalculator();
    let output;
    if (command === 'resolve') {
      output = resolveNames(input, ctx);
    } else if (command === 'compare') {
      output = compareSpeed(input, ctx);
    } else if (command === 'batch') {
      output = input.map((i, idx) => {           // fault-isolate per item (uniform error shape)
        try { return speedOne(i, ctx); }
        // carry `query` (the item's name) like calc does — conventions.md requires it (audit 2026-06-28)
        catch (e) { return errorObj(String(e && e.message || e), idx, i && i.name); }
      });
    } else if (command === 'table') {
      output = speedTable(input, ctx);
    } else {
      output = speedOne(input, ctx);
    }
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } catch (e) {
    const q = (input && !Array.isArray(input)) ? input.name : undefined;
    process.stdout.write(JSON.stringify(errorObj(String(e && e.message || e), undefined, q), null, 2) + '\n');
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { speedOne, speedTable, champSpeed };
