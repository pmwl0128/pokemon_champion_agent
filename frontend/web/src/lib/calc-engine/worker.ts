/** Calc-engine Web Worker: hosts the vendored NCP calculator in the browser, the client-side twin of
 * ncp_engine.py's quickjs runtime. It stubs the Node builtins the wrappers require() (fs/path/vm/
 * require/module/process/__dirname), evals the two CLI wrappers + the 16 data files under those stubs,
 * and answers `calc`/`speed` commands over postMessage. Running off the UI thread keeps a 200-mon speed
 * table or an 8×12 damage grid from freezing the page. See frontend/design.md §7.1. */
import { CALC_API, SOURCES, SPEED_API } from "./sources.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;

// loadCalculator()'s runFile() reads each vendored file through this global (replaces ncp_engine.py's
// Python __read_file callback). ROOT='' so it asks for '/script_res/x.js'; strip to the SOURCES key.
g.__read_file = (p: string): string => {
  const rel = String(p).replace(/^\/+/, "");
  const src = SOURCES[rel];
  if (src === undefined) throw new Error("calc-engine: missing vendored file " + p);
  return src;
};

// Indirect eval runs in the GLOBAL scope in sloppy mode (regardless of this module's strict mode), so
// each wrapper's top-level function declarations (loadCalculator/runCommand/errorObj/queryOf/...)
// become globalThis properties — the browser equivalent of the shared-context eval ncp_engine.py gets
// from quickjs. Data files loaded inside loadCalculator() go through the vm.runInContext stub, which is
// (0,eval) the same way (their top-level const/let is already normalized to var in sources.ts).
const geval: (code: string) => unknown = eval;

const BOOTSTRAP = `
globalThis.__dirname = "";
globalThis.__filename = "/ncp-calc-api.js";
globalThis.module = { exports: {} };
var __MODULE_SENTINEL = {};
globalThis.process = { argv: [], stdout: { write: function(){} }, stderr: { write: function(){} }, exit: function(){}, stdin: 0 };
globalThis.require = function(name){
  if (name === 'fs') return { readFileSync: function(p, enc){ return __read_file(String(p)); } };
  if (name === 'path') return {
    join: function(){ return Array.prototype.slice.call(arguments).join('/'); },
    resolve: function(){ return Array.prototype.slice.call(arguments).join('/'); } };
  if (name === 'vm') return {
    createContext: function(o){ if (o) { for (var k in o) { try { globalThis[k] = o[k]; } catch(e){} } } globalThis.window = globalThis; return globalThis; },
    runInContext: function(code, ctx, opts){ return (0, eval)(code); } };
  if (name === 'readline') return { createInterface: function(){ return { on: function(){}, close: function(){} }; } };
  if (name.indexOf('ncp-calc-api') !== -1) return globalThis.__calc_exports || globalThis.module.exports;
  throw new Error('stub require: unknown module ' + name);
};
globalThis.require.main = __MODULE_SENTINEL;  // != module, so the wrappers' \`if (require.main===module) main()\` no-ops
`;

// Load the calculator ONCE (the wrapper's own 16-file load + Champions gen wiring), reuse per call, and
// expose a main()-equivalent returning {output, exit} — mirrors ncp_engine.py's _CALC_ENTRY.
const CALC_ENTRY = `
globalThis.__CTX = loadCalculator();
globalThis.__run_main = function(command, inputJson, kind){
  var input;
  try {
    input = JSON.parse(inputJson);
    var k = (kind === '' || kind == null) ? undefined : kind;
    var output = runCommand(command, input, globalThis.__CTX, k);
    var exit = (output && !Array.isArray(output) && output.ok === false) ? 1 : 0;
    return JSON.stringify({ output: output, exit: exit });
  } catch (e) {
    var msg = String(e && e.message || e);
    return JSON.stringify({ output: errorObj(msg, undefined, queryOf(input, msg)), exit: 1 });
  }
};
`;

const SPEED_ENTRY = `
globalThis.__run_speed_main = function(command, inputJson){
  var input;
  try {
    input = inputJson.trim() ? JSON.parse(inputJson) : {};
    var ctx = globalThis.__CTX;
    var S = globalThis.__speed_exports;
    var output;
    if (command === 'resolve') output = S.resolveNames(input, ctx);
    else if (command === 'compare') output = S.compareSpeed(input, ctx);
    else if (command === 'batch') output = input.map(function(i, idx){
        try { return S.speedOne(i, ctx); }
        catch(e){ return globalThis.__calc_exports.errorObj(String(e && e.message || e), idx, i && i.name); } });
    else if (command === 'table') output = S.speedTable(input, ctx);
    else output = S.speedOne(input, ctx);
    return JSON.stringify({ output: output, exit: 0 });
  } catch (e) {
    var msg = String(e && e.message || e);
    var q = (input && !Array.isArray(input)) ? input.name : undefined;
    return JSON.stringify({ output: globalThis.__calc_exports.errorObj(msg, undefined, q), exit: 1 });
  }
};
`;

/** speedline is a CommonJS module that require()s calc-api; wrap it in the standard CJS IIFE so its own
 * top-level const fs/SCHEMA/function resolveNames stay module-local (calc-api already put same-named
 * globals in place; a bare eval would collide), and expose the internals the entry needs
 * (compareSpeed/resolveNames aren't in module.exports) — mirrors ncp_engine.py's _wrap_speed_module. */
function wrapSpeed(src: string): string {
  return "globalThis.__speed_mod = { exports: {} };\n" +
    "(function(module, exports, require, __dirname, __filename){\n" + src +
    "\n; module.exports.speedOne = speedOne; module.exports.compareSpeed = compareSpeed;" +
    " module.exports.speedTable = speedTable; module.exports.resolveNames = resolveNames;" +
    " module.exports.SPEED_SCHEMA = SCHEMA;\n" +
    "})(globalThis.__speed_mod, globalThis.__speed_mod.exports, globalThis.require," +
    " globalThis.__dirname, globalThis.__filename);\n" +
    "globalThis.__speed_exports = globalThis.__speed_mod.exports;\n";
}

// Boot synchronously at worker load — the worker script finishes before any message is dispatched, so
// onmessage below is only reached once the engine is ready (or initError is set for a clean report).
let initError: string | null = null;
try {
  geval(BOOTSTRAP);
  geval(CALC_API);              // defines loadCalculator/runCommand/errorObj/queryOf as globals
  geval(CALC_ENTRY);            // runs loadCalculator() -> evals the 16 vendored files via __read_file
  geval("globalThis.__calc_exports = globalThis.module.exports;");
  geval(wrapSpeed(SPEED_API));
  geval(SPEED_ENTRY);
} catch (e) {
  initError = String((e as Error)?.message ?? e);
}

interface EngineReq {
  id: number;
  engine: "calc" | "speed";
  command: string;
  inputJson: string;
  kind?: string;
}

// Typed without the WebWorker lib (tsconfig ships DOM): `self` is the worker global; cast to the two
// members we use so this compiles under a DOM lib without a WebWorker/DOM `self` clash.
const ctx = self as unknown as {
  postMessage: (m: unknown) => void;
  onmessage: ((e: MessageEvent<EngineReq>) => void) | null;
};

ctx.onmessage = (e) => {
  const { id, engine, command, inputJson, kind } = e.data;
  if (initError !== null) {
    ctx.postMessage({ id, error: "calc-engine init failed: " + initError });
    return;
  }
  try {
    const raw = engine === "speed"
      ? (g.__run_speed_main as (c: string, i: string) => string)(command, inputJson)
      : (g.__run_main as (c: string, i: string, k: string) => string)(command, inputJson, kind ?? "");
    ctx.postMessage({ id, result: JSON.parse(raw) });
  } catch (err) {
    ctx.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
