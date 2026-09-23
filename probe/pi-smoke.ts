// Throwaway load smoke (NOT the real extension). Proves that under pi's own jiti runtime,
// with NO local @mariozechner/pi-tui installed, `opentui-island/pi-tui` resolves (pi aliases
// @mariozechner/pi-tui -> bundled @earendil-works/pi-tui) and the island renders.
// Run: PI_HUNK_SMOKE_OUT=$PWD/probe/pi-smoke-output.txt pi -e ./probe/pi-smoke.ts --list-models
// (the factory only does work when PI_HUNK_SMOKE_OUT is set; real extensions must not spawn in the factory.)
import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiTuiSurface } from "opentui-island/pi-tui";

export default async function (pi: ExtensionAPI) {
  pi.registerCommand("hunk-smoke", { description: "probe only", handler: async () => {} });
  const out = process.env.PI_HUNK_SMOKE_OUT;
  if (!out) return;
  const lines: string[] = [];
  try {
    const patch = readFileSync(new URL("./sample.diff", import.meta.url), "utf8");
    const surface = await createPiTuiSurface({
      height: 12,
      initialWidth: 90,
      island: { module: new URL("../islands/hunk-review.island.tsx", import.meta.url), props: { patch, title: "pi-smoke" } },
    });
    await surface.sync(90);
    lines.push("OK: rendered under pi jiti runtime");
    for (const l of surface.render(90)) lines.push("|" + l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd());
    await surface.destroy();
  } catch (e) {
    lines.push(`FAIL: ${e instanceof Error ? e.stack : String(e)}`);
  }
  writeFileSync(out, lines.join("\n") + "\n");
}
