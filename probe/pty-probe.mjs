// Headless v2 probe: real hunk in a script(1) pty, parsed by libghostty-vt, through the same
// HunkSession the pi overlay uses. Run: node probe/pty-probe.mjs  (evidence: probe/pty-output.txt)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HunkSession } from "../extensions/hunk-pty.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE = REPO + "probe/sample.diff";
const log = [];
const say = (s) => { log.push(s); console.log(s); };
let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; say(`${ok ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const until = async (pred, ms = 4000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await sleep(50); return pred(); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function descendants(pid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const pids = new Set([pid]);
  for (const parent of pids) for (const [child, ppid] of rows) if (ppid === parent) pids.add(child);
  return [...pids];
}
const sessions = [];
process.on("exit", () => { for (const s of sessions) s.dispose(); });

function open(opts) {
  const s = { raw: "", exitCode: undefined, updates: 0 };
  s.session = new HunkSession({ cwd: REPO, cols: 100, rows: 30, kitty: false, patchFile: SAMPLE, ...opts,
    onUpdate: () => s.updates++, onExit: (code) => { s.exitCode = code; } });
  s.session.child.stdout.on("data", (d) => { s.raw += d.toString("latin1"); }); // probe-only tap on hunk's output
  s.has = (re) => s.session.text().some((l) => re.test(l));
  s.until = until;
  sessions.push(s.session);
  return s;
}

// 1. Render: hunk UI in the VT grid, serialized lines exact size.
const a = open({ kitty: false });
await a.until(() => a.has(/@@ -1,7 \+1,8 @@/));
check("hunk menu bar in VT grid", a.has(/File {2}View {2}Navigate/));
check("hunk patch title", a.has(/Patch review: sample\.diff/));
check("@@ hunk header", a.has(/@@ -1,7 \+1,8 @@/));
const lines = a.session.lines();
check("lines(): one per row", lines.length === 30, `got ${lines.length}`);
check("lines(): each exactly 100 cells", lines.every((l) => [...strip(l)].length === 100));
check("lines(): 24-bit SGR colours", lines.some((l) => /\x1b\[0(;\d+)*;38;2;\d+;\d+;\d+;48;2;/.test(l)));
say("screen (unanswered/legacy session):");
for (const [i, l] of a.session.text().slice(0, 12).entries()) say(`  ${String(i).padStart(2)}|${l.trimEnd()}`);

// 2. Kitty handshake bytes.
check("hunk queries kitty flags (CSI ? u)", a.raw.includes("\x1b[?u"));
check("hunk also sends DA1 sentinel (CSI c)", a.raw.includes("\x1b[c"));
check("unanswered: hunk stays legacy (no CSI > flags u)", !/\x1b\[>\d+u/.test(a.raw));
check("unanswered: modifyOtherKeys on (CSI > 4;1 m)", a.raw.includes("\x1b[>4;1m"));

const k = open({ kitty: true });
await k.until(() => /\x1b\[>\d+u/.test(k.raw));
const pushed = k.raw.match(/\x1b\[>\d+u/)?.[0];
check("answered (CSI ? 0 u): hunk pushes kitty flags", pushed === "\x1b[>5u", JSON.stringify(pushed));
check("answered: hunk turns modifyOtherKeys off (CSI > 4;0 m)", k.raw.includes("\x1b[>4;0m"));

// 3. Raw keys reach hunk. CSI-u (kitty) bytes into the answered session, legacy into the other.
await k.until(() => k.has(/@@ -1,7/));
k.session.write("\x1b[99u"); // kitty "c" = start note
check("kitty session: CSI-u 'c' opens hunk note editor", await k.until(() => k.has(/Draft note/)));
k.session.write("\x1b[104u\x1b[105u"); // "hi"
check("kitty session: CSI-u text typed", await k.until(() => k.has(/│ hi /)));
k.session.write("\x1b[115;5u"); // kitty ctrl+s = save note
check("kitty session: CSI-u ctrl+s saves the note", await k.until(() => k.has(/Your note/)));
const kn = k.session.notes();
check("kitty session: note mirrored to file", kn.length === 1 && kn[0].text === "hi" && kn[0].file === "src/math.ts", JSON.stringify(kn));
k.session.write("\x1b[113u"); // kitty "q"
check("kitty session: CSI-u q quits hunk (exit 0)", await k.until(() => k.exitCode !== undefined) && k.exitCode === 0, `code ${k.exitCode}`);
check("kitty session: notes still readable after exit", k.session.notes().length === 1);
k.session.dispose();

// Counter-check: OpenTUI decodes CSI-u even with the query unanswered (handshake is not what
// makes keys work; it makes hunk's declared mode match the bytes pi forwards).
a.session.write("\x1b[99u");
check("legacy session: CSI-u 'c' also decoded (parser is protocol-agnostic)", await a.until(() => a.has(/Draft note/)));
a.session.write("\x1b"); // legacy Esc cancels the draft
check("legacy session: legacy Esc closes the draft", await a.until(() => !a.has(/Draft note/)));

// 4. Legacy keys + notes: two notes, one deleted.
a.session.write("c");
await a.until(() => a.has(/Draft note/));
a.session.write("first note");
await sleep(150);
a.session.write("\x13"); // ctrl+s
check("legacy: note saved", await a.until(() => a.session.notes().length === 1));
a.session.write("]");
await sleep(300);
a.session.write("c");
await a.until(() => a.has(/Draft note/));
a.session.write("second note");
await sleep(150);
a.session.write("\x13");
check("legacy: second note saved", await a.until(() => a.session.notes().length === 2), JSON.stringify(a.session.notes()));
a.session.write("c");
await a.until(() => a.has(/Draft note/));
a.session.write("doomed");
await sleep(150);
a.session.write("\x13");
await a.until(() => a.session.notes().length === 3);
a.session.write("D"); // hunk: delete active note
check("legacy: D deletes the note from the mirror", await a.until(() => a.session.notes().length === 2 && !a.session.notes().some((n) => n.text === "doomed")));

// 5. Resize mid-session: stty -f on the pty -> SIGWINCH -> hunk redraws at the new size.
check("resize accepted", a.session.resize(80, 20));
check("hunk redrew at 80 cols", await a.until(() => a.session.text().some((l) => /^ ─{78}\s*$/.test(l))));
check("lines(): 20 rows x 80 cells after resize", a.session.lines().length === 20 && a.session.lines().every((l) => [...strip(l)].length === 80));

// 6. Mouse: SGR wheel-down bytes, raw, scroll hunk's view.
await a.until(() => a.session.text().some((l) => /^ ─{78}/.test(l)));
await sleep(300);
const before = a.session.text().join("\n");
a.session.write("\x1b[<65;40;10M\x1b[<65;40;10M\x1b[<65;40;10M");
check("SGR mouse wheel bytes scroll the diff", await a.until(() => a.session.text().join("\n") !== before));
check("hunk enabled SGR mouse (?1006h) in its own pty", a.raw.includes("\x1b[?1006h"));

// 7. Quit through hunk's own q; notes survive exit.
a.session.write("q");
check("q quits hunk (exit 0)", await a.until(() => a.exitCode !== undefined) && a.exitCode === 0, `code ${a.exitCode}`);
const notes = a.session.notes();
say("notes after exit: " + JSON.stringify(notes));
check("notes after exit: both, with file/hunk/lines", notes.length === 2 && notes[0].file === "src/math.ts" && notes[1].hunk === 1 && /^new \d/.test(notes[1].lines));
const dir = a.session.dir;
a.session.dispose();
a.session.dispose();
check("dispose is idempotent and removes the session dir", !existsSync(dir));
check("disposed session renders safely", a.session.lines().length === 0);

// 8. Host force-kill while alive: no stray hunk/script/cat.
const b = open({ patchFile: undefined, patchText: readFileSync(SAMPLE, "utf8"), title: "PR #1" });
await b.until(() => b.has(/Patch review: PR_#1\.diff/));
check("patchText mode: title from <title>.diff", b.has(/Patch review: PR_#1\.diff/));
const tree = descendants(b.session.child.pid);
check("dispose probe captured script, bash, cat, hunk", tree.length >= 4, tree.join(","));
b.session.dispose();
check("dispose() reaps entire process tree (including cat/zombies)", await until(() => tree.every((pid) => !alive(pid))));
check("dispose() while alive: onExit not delivered", b.exitCode === undefined);

// 9. pi dies without dispose (SIGKILL): the feeding cat sees EOF and kills script -> no orphan hunk.
const orphanCode = `import { HunkSession } from ${JSON.stringify(REPO + "extensions/hunk-pty.ts")};
const s = new HunkSession({ cwd: ${JSON.stringify(REPO)}, cols: 80, rows: 20, kitty: false, patchFile: ${JSON.stringify(SAMPLE)}, onUpdate() {}, onExit() {} });
const timer = setInterval(() => {
  if (s.text().some(l => l.includes("Patch review: sample.diff"))) {
    console.log(s.dir); clearInterval(timer);
  }
}, 50);`;
const host = spawn(process.execPath, ["--input-type=module", "-e", orphanCode], { stdio: ["ignore", "pipe", "inherit"] });
let orphanDir = "";
host.stdout.on("data", (d) => { orphanDir += d; });
check("SIGKILL probe reached real hunk UI", await until(() => orphanDir.includes("\n")));
const orphanTree = descendants(host.pid);
check("SIGKILL probe captured host plus all four children", orphanTree.length >= 5, orphanTree.join(","));
host.kill("SIGKILL");
check("host SIGKILLed without dispose: entire tree reaped", await until(() => orphanTree.every((pid) => !alive(pid))));
if (orphanDir.trim()) rmSync(orphanDir.trim(), { recursive: true, force: true });

say(failed ? `PROBE_FAILED (${failed})` : "PROBE_OK");
writeFileSync(new URL("./pty-output.txt", import.meta.url), log.join("\n") + "\n");
process.exit(failed ? 1 : 0);
