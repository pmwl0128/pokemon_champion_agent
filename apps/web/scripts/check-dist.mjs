import { existsSync } from "node:fs";
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
