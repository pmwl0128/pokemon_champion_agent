import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Connect, type Plugin } from "vite";

// The calc-engine chunk `?raw`-imports the vendored NCP sources from the installed skill at the repo
// root (apps/web/src/lib/calc-engine/sources.ts) — outside apps/web. Open the root so `vite dev` can
// serve them (build/Rollup reads them regardless). Repo root = two dirs up from this config.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Fingerprint the vendored calc engine THIS build embeds into the worker chunk, and inline it as a
// build-time constant (__ENGINE_DIGEST__). At boot the online runtime compares it against the
// projection's manifest.calcEngineDigest, so a projection rebuilt on a newer engine than the SPA
// carries is caught at the handshake instead of silently computing with the stale embedded worker
// (external audit 2026-07-14). MUST match capabilities.py calc_engine_digest(): SHA-256 over the
// script_res/*.js + the two wrappers, basename-sorted, newline-normalized, name\0content joined by \0.
function calcEngineDigest(): string {
  const dir = join(REPO_ROOT, ".agents/skills/ncp-damage-calculator/scripts");
  const entries: Array<[string, string]> = [
    ...readdirSync(join(dir, "script_res"))
      .filter((f) => f.endsWith(".js"))
      .map((f): [string, string] => [f, join(dir, "script_res", f)]),
    ["ncp-calc-api.js", join(dir, "ncp-calc-api.js")],
    ["ncp-speedline-api.js", join(dir, "ncp-speedline-api.js")],
  ];
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // Hash RAW BYTES, not decoded text: some data files carry non-UTF-8 bytes, and JS vs Python differ in
  // how they replace them on decode — so a text hash wouldn't agree. Normalize CRLF->LF at the byte
  // level (latin1 is byte-transparent) and hash `name\0bytes\0` per entry. MUST match capabilities.py.
  const h = createHash("sha256");
  for (const [name, path] of entries) {
    h.update(Buffer.from(name, "utf-8"));
    h.update(Buffer.from([0]));
    h.update(Buffer.from(readFileSync(path).toString("latin1").replace(/\r\n/g, "\n"), "latin1"));
    h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}

/** Dev-only: authenticate proxied /api calls against a running `pcui serve` by injecting the
 * CLI secret from daemon.json — the browser never sees it, and production traffic (bridge
 * serves the built dist same-origin) uses the bootstrap cookie instead. */
function daemonSecret(): string | null {
  try {
    const raw = readFileSync(join(homedir(), ".pokemon-champions-ui", "daemon.json"), "utf-8");
    return (JSON.parse(raw) as { secret?: string }).secret ?? null;
  } catch {
    return null;
  }
}

/** `runtime-config.json` belongs to the DEPLOYMENT, never to the SPA dist (design §2).
 * FastAPI serves it in both packaged runtimes; Vite needs this local-only equivalent for HMR.
 * Keeping it middleware-generated also prevents `vite build` from baking "local" into the
 * build-once artifact that is shared with the online deployment. */
function localRuntimeConfig(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.split("?", 1)[0] !== "/runtime-config.json") {
      next();
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ runtime: "local", apiBase: "/api", projectionBase: "/projection" }));
  };
  return {
    name: "pcui-local-runtime-config",
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}

const projectionProxy = { target: "http://127.0.0.1:8763" };
const apiProxy = {
  target: "http://127.0.0.1:8763",
  configure: (proxy: { on: (event: "proxyReq", handler: (proxyReq: {
    setHeader: (name: string, value: string) => void;
  }) => void) => void }) => {
    proxy.on("proxyReq", (proxyReq) => {
      const secret = daemonSecret();
      if (secret) proxyReq.setHeader("x-pcui-secret", secret);
    });
  },
};

export default defineConfig({
  // The same dist is mounted below an identity-scoped path in production. A relative build base
  // makes every generated URL (lazy chunks, modulepreload dependencies, workers, CSS assets)
  // resolve from the versioned entry module instead of escaping back to the mutable site root.
  // build_release.py binds only index.html to the final deployment prefix after computing it.
  base: "./",
  // Projection and runtime config are deployment artifacts mounted by pcui, not public assets.
  // Disabling Vite's public-dir copy keeps dist byte-identical across local and online runtimes.
  publicDir: false,
  plugins: [localRuntimeConfig(), react()],
  define: { __ENGINE_DIGEST__: JSON.stringify(calcEngineDigest()) },
  server: {
    fs: { allow: [REPO_ROOT] },
    proxy: {
      "/api": apiProxy,
      "/projection": projectionProxy,
    },
  },
  preview: {
    proxy: {
      "/api": apiProxy,
      "/projection": projectionProxy,
    },
  },
  build: {
    target: "es2022",
    // Budget guard (apps/design.md §7.1): warn when a chunk approaches the 300KB lazy-chunk
    // budget; echarts is isolated into the trend page's dynamic chunk.
    chunkSizeWarningLimit: 700,
  },
});
