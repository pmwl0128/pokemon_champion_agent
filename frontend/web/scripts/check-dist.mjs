import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../dist");
const forbidden = ["runtime-config.json", "projection"];
const leaked = forbidden.filter((name) => existsSync(resolve(dist, name)));

if (!existsSync(resolve(dist, "index.html"))) {
  throw new Error(`web build did not produce ${resolve(dist, "index.html")}`);
}
if (leaked.length > 0) {
  throw new Error(
    `deployment-owned files leaked into the shared SPA dist: ${leaked.join(", ")}`,
  );
}

console.log("dist boundary: shared SPA only (runtime config and projection stay deployment-owned)");

// Raw emitted JS bytes per chunk; workers do not run on the UI thread and contain the vendored
// damage engine, so they have a separate ceiling. These are failures, not Vite warning hints.
for (const name of readdirSync(resolve(dist, "assets"))) {
  if (!name.endsWith(".js")) continue;
  const budget = name.startsWith("worker-") ? 1_000_000 : 300_000;
  const size = statSync(resolve(dist, "assets", name)).size;
  if (size > budget) throw new Error(`${name}: ${size} bytes exceeds the ${budget}-byte JS chunk budget`);
}
console.log("JS budget: main-thread chunks <= 300 kB; worker chunks <= 1000 kB (uncompressed)");
