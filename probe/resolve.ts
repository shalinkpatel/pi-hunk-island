// Prints which @opentui/* and react copy each importer resolves (run with bun).
import { realpathSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const importers = {
  "opentui-island sidecar": join(root, "node_modules/opentui-island/dist/sidecar/offscreen-host.js"),
  "hunkdiff/opentui": join(root, "node_modules/hunkdiff/dist/npm/opentui/index.js"),
  "islands/*.island.tsx": join(root, "islands/hunk-review.island.tsx"),
};
for (const [name, from] of Object.entries(importers)) {
  const out: string[] = [];
  for (const spec of ["@opentui/core", "@opentui/react", "react"]) {
    const file = realpathSync(Bun.resolveSync(spec, dirname(from)));
    let dir = dirname(file);
    while (!readFileSafe(join(dir, "package.json"))?.includes(`"name": "${spec}"`)) dir = dirname(dir);
    const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
    out.push(`${spec}@${version} (${dir.replace(root + "/", "")})`);
  }
  console.log(`${name}: ${out.join(", ")}`);
}
function readFileSafe(p: string) {
  try { return readFileSync(p, "utf8"); } catch { return undefined; }
}
