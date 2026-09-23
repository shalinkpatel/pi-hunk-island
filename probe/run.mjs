// Headless probe: host the hunk-review island through opentui-island's pi-tui surface
// (the exact API overlay.ts uses), print frames, drive the note loop with raw input,
// then exercise the failure paths (Bun missing, bad island module, sidecar crash).
// Run: node probe/run.mjs   (needs bun on PATH; @mariozechner/pi-tui is a devDep alias
// of @earendil-works/pi-tui, which pi itself aliases at runtime).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createPiTuiSurface } from "opentui-island/pi-tui";

const here = new URL(".", import.meta.url);
const ISLAND = new URL("../islands/hunk-review.island.tsx", here);
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const WIDTH = 100, HEIGHT = 24;

log("## Versions");
log(`node ${process.version}, bun ${execFileSync("bun", ["--version"], { encoding: "utf8" }).trim()}`);
log("\n## Module resolution (Bun, from each importer)");
log(execFileSync("bun", [new URL("resolve.ts", here).pathname], { encoding: "utf8" }).trim());

const patch = readFileSync(new URL("sample.diff", here), "utf8");
const t0 = Date.now();
const surface = await createPiTuiSurface({
  height: HEIGHT,
  initialWidth: WIDTH,
  island: { module: ISLAND, props: { patch, title: "sample.diff" } },
});
const events = [];
surface.onEvent((e) => events.push(e));
surface.focused = true;
await surface.sync(WIDTH);
const firstColors = new Set(surface.render(WIDTH)[2].match(/38;2;[0-9;]+?m/g) ?? []).size;
log(`\n## createPiTuiSurface + first sync: ${Date.now() - t0} ms, ready=${surface.ready}, distinct fg colors on line 3: ${firstColors}`);

const frame = async (label, width = WIDTH, raw = false) => {
  await sleep(150); // let React commit + sidecar re-render
  await surface.sync(width);
  const lines = surface.render(width);
  log(`\n## ${label}  (${lines.length} lines @ width ${width})`);
  for (const l of lines) log("|" + strip(l));
  if (raw) log(`(raw ANSI sample, line 3): ${JSON.stringify(lines[2]).slice(0, 300)}`);
};
const type = async (s) => { for (const ch of s) await surface.sendInput(ch); };

await frame("initial frame", WIDTH, true);

// Frames are pull-based (sidecar renders only on sync/input). Does async syntax highlighting
// arrive later without input? Count distinct colors on the code line over time.
const colors = (l) => new Set(l.match(/38;2;[0-9;]+?m/g) ?? []).size;
const hl = [];
for (const ms of [0, 250, 500, 1000, 2000]) {
  await sleep(ms - (hl.at(-1)?.[0] ?? 0));
  await surface.sync(WIDTH);
  hl.push([ms, colors(surface.render(WIDTH)[2])]);
}
log("\n## distinct fg colors on line 3 after first sync, by ms:", JSON.stringify(hl));
log(`(raw ANSI sample, line 3, after 2s): ${JSON.stringify(surface.render(WIDTH)[2]).slice(0, 400)}`);

await type("n"); // select hunk 2 of src/math.ts
await type("c");
await frame("composing note (after n, c)");
await type("VERSION bump should be minor?");
await surface.sendInput("\r");
await type("\t"); // next file: README.md
await type("c");
await type("doc ok");
await surface.sendInput("\r");
await frame("after two notes, README.md", 80); // also exercises width change 100 -> 80

const submitted = surface.waitForEvent("submit", { timeoutMs: 5000 });
await surface.sendInput("\x13"); // Ctrl+S
log("\n## submit event:", JSON.stringify(await submitted, null, 2));
log("## events seen by onEvent:", events.map((e) => e.type).join(","));

await surface.destroy();
log("\n## destroyed cleanly");

// ---- failure paths -------------------------------------------------------
const attempt = async (label, fn) => {
  try { await fn(); log(`\n## ${label}: NO ERROR`); }
  catch (e) { log(`\n## ${label}:\n${String(e?.message ?? e).split("\n").slice(0, 4).join("\n")}`); }
};

await attempt("Bun missing (OPENTUI_ISLAND_BUN=/nonexistent/bun)", async () => {
  process.env.OPENTUI_ISLAND_BUN = "/nonexistent/bun";
  try {
    await createPiTuiSurface({ height: 5, initialWidth: 40, island: { module: ISLAND, props: { patch } } });
  } finally { delete process.env.OPENTUI_ISLAND_BUN; }
});

await attempt("bad island module", () =>
  createPiTuiSurface({ height: 5, initialWidth: 40, island: { module: new URL("../islands/nope.tsx", here) } }));

await attempt("sidecar killed mid-session (SIGKILL), then sync()", async () => {
  const s = await createPiTuiSurface({ height: 5, initialWidth: 40, island: { module: ISLAND, props: { patch } } });
  const ps = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  const child = ps.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === String(process.pid) && p.join(" ").includes("sidecar/server.js"));
  s.focused = true;
  process.kill(Number(child[0]), "SIGKILL");
  await sleep(200);
  // termdraw's overlay calls surface.handleInput(data), which does `void this.sendInput(data)`:
  // after a sidecar death that is an UNHANDLED REJECTION (kills a plain Node process).
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(String(e?.message ?? e));
  process.on("unhandledRejection", onUnhandled);
  s.handleInput("j");
  await sleep(100);
  process.off("unhandledRejection", onUnhandled);
  log(`\n## after kill, surface.handleInput("j") -> unhandledRejection: ${JSON.stringify(unhandled)}; readyState=${s.readyState}`);
  await s.sendInput("j").catch((e) => log(`## after kill, surface.sendInput("j").catch -> ${e.message}`));
  await s.sync(40); // explicit sync also surfaces it
});

process.exit(0);
