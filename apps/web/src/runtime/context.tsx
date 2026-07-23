/** Runtime bootstrap: runtime-config.json -> adapter -> capabilities handshake
 * (checkCompatibility gates the whole UI; a version mismatch renders the incompatibility
 * screen instead of half-working pages). */
import {
  checkCompatibility, hasCapability,
  type Capabilities, type KnownCapability,
} from "@pokemon-champions/protocol";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useT } from "../i18n.ts";
import { HttpError, setProjectionVersion, type RuntimeAdapter } from "./adapter.ts";
import { loadRuntimeConfig } from "./config.ts";
import { LocalAdapter } from "./local.ts";
import { OnlineAdapter } from "./online.ts";

/** design §7.1 atomic version binding: the static projection and the backend it pairs with
 * share a deploymentId. If a projection built at a different time is being served alongside a
 * newer bridge, refuse to render mixed data. No manifest (headless/API-only bridge) or a
 * flaky fetch is not a mismatch — only a present-and-different id blocks boot. */
// Build-time constant (vite.config `define`): SHA-256 of the calc engine sources THIS SPA embedded in
// its worker chunk. Compared to the projection's manifest.calcEngineDigest below.
declare const __ENGINE_DIGEST__: string;

async function projectionDeploymentMismatch(
  projectionBase: string, deploymentId: string, engineDigest?: string): Promise<string | null> {
  try {
    // no-store: the manifest is an IDENTITY file, not content. Served with only last-modified/etag,
    // a plain fetch lets the browser heuristically cache it, so after a projection rebuild a plain
    // reload keeps comparing the STALE deploymentId and wrongly reports drift until a hard refresh.
    const resp = await fetch(`${projectionBase}/manifest.json`, { cache: "no-store" });
    if (!resp.ok) return null;
    const manifest = (await resp.json()) as { deploymentId?: string; calcEngineDigest?: string };
    if (manifest.deploymentId && manifest.deploymentId !== deploymentId)
      return `projection ${manifest.deploymentId} ≠ backend ${deploymentId} — rebuild the projection`;
    // Online only: the SPA computes with its EMBEDDED engine, so a projection built from a DIFFERENT
    // engine snapshot than this SPA carries would silently disagree with the advertised data version.
    // Bind them — a mismatch means the SPA and projection weren't built together (external audit 2026-07-14).
    if (engineDigest && manifest.calcEngineDigest && manifest.calcEngineDigest !== engineDigest)
      return "calc engine mismatch — this SPA embeds a different engine than the projection was built "
        + "from; rebuild the SPA (npm run build) together with the projection";
    return null;
  } catch {
    return null;
  }
}

interface RuntimeState {
  adapter: RuntimeAdapter;
  capabilities: Capabilities;
  can: (id: KnownCapability) => boolean;
}

const RuntimeContext = createContext<RuntimeState | null>(null);

export function useRuntime(): RuntimeState {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error("useRuntime outside RuntimeProvider");
  return ctx;
}

type Boot =
  | { phase: "loading" }
  | { phase: "incompatible"; reasons: string[] }
  | { phase: "error"; kind: "auth" | "generic" }
  | { phase: "ready"; state: RuntimeState };

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });
  const t = useT();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await loadRuntimeConfig();
        let adapter: RuntimeAdapter;
        if (cfg.runtime === "local") {
          const local = new LocalAdapter(cfg);
          await local.init();
          adapter = local;
        } else {
          adapter = new OnlineAdapter(cfg);
        }
        const result = checkCompatibility(await adapter.capabilities());
        if (cancelled) return;
        if (!result.ok) {
          console.error("Incompatible backend capabilities:", result.reasons);
          setBoot({ phase: "incompatible", reasons: result.reasons });
          return;
        }
        const capabilities = result.capabilities;
        // Stamp projection CONTENT requests with the deployment id so a new deployment busts any
        // long-cached ranking/detail/cards/matchup (audit 2026-07-14). Set before any content fetch;
        // the identity files above were already fetched no-store, so they never carry it.
        setProjectionVersion(capabilities.deploymentId);
        const drift = await projectionDeploymentMismatch(
          cfg.projectionBase, capabilities.deploymentId,
          cfg.runtime === "online" ? __ENGINE_DIGEST__ : undefined);
        if (cancelled) return;
        if (drift) {
          console.error("Incompatible projection:", drift);
          setBoot({ phase: "incompatible", reasons: [drift] });
          return;
        }
        setBoot({
          phase: "ready",
          state: { adapter, capabilities, can: (id) => hasCapability(capabilities, id) },
        });
      } catch (e) {
        if (!cancelled) {
          // A 401 here means the bootstrap token was already spent or expired (e.g. a reopened
          // launch link) — give the actionable message instead of a raw "401 /api/capabilities".
          console.error("Runtime bootstrap failed:", e);
          const kind = e instanceof HttpError && e.status === 401 ? "auth" : "generic";
          setBoot({ phase: "error", kind });
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (boot.phase === "loading") return <div className="spinner">{t("state.loading")}</div>;
  if (boot.phase === "incompatible") {
    return (
      <div className="error-box">
        <h1>{t("incompat.title")}</h1>
        <p>{t("incompat.body")}</p>
      </div>
    );
  }
  if (boot.phase === "error") {
    return (
      <div className="error-box">
        <h1>{t("state.error")}</h1>
        <p>{t(boot.kind === "auth" ? "auth.expired" : "runtime.error")}</p>
      </div>
    );
  }
  return <RuntimeContext.Provider value={boot.state}>{children}</RuntimeContext.Provider>;
}
