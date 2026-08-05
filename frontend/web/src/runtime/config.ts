/** Single load of runtime-config.json for the whole app: memoized so the SPA fetches it ONCE
 * (main + the RuntimeProvider used to fetch it independently, with divergent failure
 * handling), and the one place asset/projection bases are configured. */
import { configureAssets } from "../assets/images.ts";
import { fetchJson, type RuntimeConfig } from "./adapter.ts";
import { configureProjection } from "./projection.ts";

let cache: Promise<RuntimeConfig> | null = null;

export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  cache ??= fetchJson<Partial<RuntimeConfig>>("/runtime-config.json").then((raw) => {
    const cfg: RuntimeConfig = {
      runtime: raw.runtime === "online" ? "online" : "local",
      apiBase: raw.apiBase ?? "/api",
      projectionBase: raw.projectionBase ?? "/projection",
    };
    configureAssets(cfg.projectionBase);
    configureProjection(cfg.projectionBase);
    return cfg;
  });
  return cache;
}
