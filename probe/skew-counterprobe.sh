#!/usr/bin/env bash
# Counter-probe: what happens if opentui-island keeps its declared @opentui 0.1.97 and hunkdiff
# gets its own nested 0.5.12 (two OpenTUI instances in one sidecar)?
# Builds a throwaway tree in probe/skew.tmp (gitignored), renders the same island, prints result.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
D=skew.tmp
rm -rf "$D"; mkdir -p "$D/islands" "$D/probe"
cat > "$D/package.json" <<'EOF'
{ "name": "skew", "private": true, "type": "module",
  "dependencies": { "opentui-island": "0.4.0", "@opentui/core": "0.1.97", "@opentui/react": "0.1.97",
    "react": "^19.2.4", "hunkdiff": "0.22.0", "@pierre/diffs": "1.3.5" } }
EOF
# npm cannot nest a second peer copy (plain install = ERESOLVE), so install with legacy peers and
# hand-place 0.5.12 under hunkdiff/node_modules (copied from the main tree).
(cd "$D" && npm install --legacy-peer-deps --no-audit --no-fund >/dev/null 2>&1)
H="$D/node_modules/hunkdiff/node_modules"; M="$ROOT/node_modules"
mkdir -p "$H/@opentui"
cp -R "$M/@opentui/core" "$M/@opentui/react" "$M/@opentui/core-darwin-arm64" "$H/@opentui/"
cp -R "$M/react-reconciler" "$M/bun-ffi-structs" "$H/"
cp "$ROOT/islands/hunk-review.island.tsx" "$D/islands/"
cp sample.diff resolve.ts "$D/probe/"

echo "## resolution in skewed tree"
(cd "$D" && bun probe/resolve.ts)

cat > "$D/probe/run.mjs" <<'EOF'
import { readFileSync } from "node:fs";
import { createOpenTuiIslandController, hostFrameToAnsiLines } from "opentui-island";
const patch = readFileSync(new URL("sample.diff", import.meta.url), "utf8");
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd();
try {
  const c = await createOpenTuiIslandController({
    size: { width: 90, height: 12 },
    island: { module: new URL("../islands/hunk-review.island.tsx", import.meta.url), props: { patch } },
  });
  const frame = await c.syncFrame({ width: 90, height: 12 });
  console.log("## rendered frame");
  for (const l of hostFrameToAnsiLines(frame)) console.log("|" + strip(l));
  await c.destroy();
} catch (e) {
  console.log("## FAILED:", String(e?.message ?? e).split("\n").slice(0, 12).join("\n"));
}
process.exit(0);
EOF
(cd "$D" && node probe/run.mjs)
