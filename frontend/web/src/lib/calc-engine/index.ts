/** Main-thread client for the calc-engine worker (frontend/design.md §7.1).
 *
 * Lazily spins up ONE worker on first use (its ~840KB engine chunk loads only when the calc page
 * actually computes), pairs requests to replies by id, and maps the vendored wrapper's raw output to
 * the Web DTO shapes — the browser twin of the bridge's mappers.map_damage / map_speedline, so the
 * OnlineAdapter returns byte-identical DTOs to what `pcui serve` would. */

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: EngineReply) => void; reject: (e: Error) => void }>();

interface EngineReply {
  output: unknown;
  exit: number;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<{ id: number; result?: EngineReply; error?: string }>) => {
    const { id, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error !== undefined) p.reject(new Error(error));
    else p.resolve(result as EngineReply);
  };
  // A worker-level failure (parse/eval blowup) rejects everything in flight rather than hanging the
  // page forever; the next call re-creates the worker so a transient failure isn't terminal.
  w.onerror = (e) => {
    const err = new Error(`calc-engine worker error: ${e.message}`);
    for (const [, p] of pending) p.reject(err);
    pending.clear();
    worker = null;
  };
  worker = w;
  return w;
}

function call(engine: "calc" | "speed", command: string, input: unknown, kind?: string): Promise<EngineReply> {
  const w = ensureWorker();
  const id = ++seq;
  const inputJson = JSON.stringify(input);
  return new Promise<EngineReply>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, engine, command, inputJson, kind });
  });
}

// --- wrapper -> Web DTO mapping (parity with frontend/bridge/pcui/mappers.py) -----------------------

const isErr = (v: unknown): boolean =>
  typeof v === "object" && v !== null && "error" in (v as Record<string, unknown>);

/** map_damage: the wrapper is native snake_case (hits_range/min_env/ko_chance/chance_pct); the DTO is
 * camelCase and drops damagePercent. Optional env fields only appear when non-null. */
function mapDamage(raw: any): Record<string, unknown> {
  const out: Record<string, unknown> = {
    description: raw.description,
    damage: raw.damage,
    min: raw.min, max: raw.max,
    minPercent: raw.minPercent, maxPercent: raw.maxPercent,
    defenderHP: raw.defenderHP,
    hits: raw.hits, hitsRange: raw.hits_range,
    koChance: null, category: raw.category,
    move: raw.move, attacker: raw.attacker, defender: raw.defender,
  };
  for (const [src, dst] of [["min_env", "minEnv"], ["max_env", "maxEnv"],
    ["min_env_percent", "minEnvPercent"], ["max_env_percent", "maxEnvPercent"]] as const) {
    if (raw[src] != null) out[dst] = raw[src];
  }
  if (raw.ko_chance) {
    const k = raw.ko_chance;
    const ko: Record<string, unknown> = { text: k.text };
    // `n` can be null (parseKoChance returns n=null for a non-standard KO string), but KoChanceDto.n is
    // optional-NOT-nullable — a null would fail DamageResultDtoSchema.parse, and in a batch one bad cell
    // sinks the whole matrix. Guard it like the env fields above (parity with mappers.map_damage).
    if (k.n != null) ko.n = k.n;
    if ("guaranteed" in k) ko.guaranteed = k.guaranteed;
    if ("chance_pct" in k) ko.chancePct = k.chance_pct;
    out.koChance = ko;
  }
  if (raw.ko_caveats) {
    out.koCaveats = raw.ko_caveats.map((c: any) => ({
      code: c.code, direction: c.direction, ...(c.cause ? { cause: c.cause } : {}),
    }));
  }
  return out;
}

const SPEEDLINE_KEYS = ["name", "types", "baseSpeed", "nature", "speedSPs", "speedIV",
  "speedBoost", "rawSpeed", "boostedSpeed", "finalSpeed"] as const;

function mapSpeedline(raw: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SPEEDLINE_KEYS) out[k] = raw[k];
  return out;
}

// --- high-level ops the OnlineAdapter consumes --------------------------------------------------

/** Single damage calc. A request-level failure (unknown mon/move) throws, matching the bridge's
 * `_raw_or_error` on /api/calc/damage; the caller Zod-parses the returned object. */
export async function engineDamage(req: unknown): Promise<Record<string, unknown>> {
  const { output } = await call("calc", "one", req);
  if (isErr(output)) {
    const e = output as { error: { message?: string } };
    throw new Error(e.error?.message ?? "calc failed");
  }
  return mapDamage(output);
}

/** Batch calc. The wrapper's `batch` command is input.map(), so results align 1:1 with items and a
 * bad cell is an error object in place — never a dropped/shifted slot. Each cell is passed through
 * (error shape) or mapped (success). */
export async function engineDamageBatch(items: unknown[]): Promise<unknown[]> {
  const { output } = await call("calc", "batch", items);
  if (!Array.isArray(output)) throw new Error("calc batch produced a non-array");
  return output.map((r) => (isErr(r) ? r : mapDamage(r)));
}

export async function engineSpeedBatch(items: unknown[]): Promise<unknown[]> {
  const { output } = await call("speed", "batch", items);
  if (!Array.isArray(output)) throw new Error("speed batch produced a non-array");
  return output.map((r) => (isErr(r) ? r : mapSpeedline(r)));
}
