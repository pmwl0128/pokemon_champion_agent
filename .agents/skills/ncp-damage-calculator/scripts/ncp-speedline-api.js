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

// Machine-readable I/O contract (dev/contracts/conventions.md), emitted by `schema`.
const SCHEMA = {
  skill: 'ncp-damage-calculator', cli: 'ncp-speedline-api.js',
  contract: 'dev/contracts/conventions.md',
  commands: { one: 'single speed query on stdin', batch: 'array -> array (faults isolated)',
    table: '{defaults,filters,sort,limit,pokemon} -> {rows:[...]}', schema: 'this contract' },
  input: { name: 'str', nature: 'str',
    sps: '{spe:int}  (smogon; legacy sp still accepted)', ivs: '{spe:int}',
    boosts: '{spe:-6..6}', ability: 'str', item: 'str', status: 'str',
    field: '{weather,terrain,tailwind,swamp}' },
  output: { name: 'str', types: ['Type'], baseSpeed: 'int', nature: 'str', speedSPs: 'int',
    speedIV: 'int', speedBoost: 'int', rawSpeed: 'int', boostedSpeed: 'int', finalSpeed: 'int' },
  // query echoes the offending Pokémon name (conventions.md uniform error shape — calc carries it too).
  error_shape: { ok: false, query: 'str (echo of input.name)', index: 'int (batch only)', error: { code: 'str', message: 'str' } },
};

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'one';
  if (command === 'schema') { process.stdout.write(JSON.stringify(SCHEMA, null, 2) + '\n'); return; }
  const fileArg = args.find(a => a === '--input' || a === '-i');
  const file = fileArg ? args[args.indexOf(fileArg) + 1] : null;
  const payload = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  let input;
  try {
    input = payload.trim() ? JSON.parse(payload) : {};
    const ctx = loadCalculator();
    let output;
    if (command === 'batch') {
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
