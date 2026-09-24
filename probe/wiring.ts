// Loaded by pi itself: exercise public registrations/contracts and the real overlay factory.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../extensions/index.ts";

export default async function () {
  // pi -ne swallows factory rejections; surface them on stdout for the probe.
  try {
  let command: any, tool: any, notesTool: any, sent: any;
  const notices: string[] = [];
  extension({
    registerCommand(name, spec) { assert.equal(name, "hunk-review"); command = spec; },
    registerTool(spec) {
      if (spec.name === "hunk_review") tool = spec;
      else { assert.equal(spec.name, "hunk_notes"); notesTool = spec; }
    },
    sendUserMessage(...args) { sent = args; },
  } as any);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["pr", "base", "ref", "paths", "cwd", "notes"]);
  assert.deepEqual(Object.keys(notesTool.parameters.properties), ["id"]);
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const note = { file: "x", hunk: 0, lines: "new 1", text: "first\nsecond" };
  let component: any;
  // Arg-capture mode skips factory invocation (no real hunk spawn); round-trips enable it.
  let constructOverlay = false;
  const tui = () => ({ terminal: { columns: 100, rows: 30, write: () => {} }, requestRender() {} });
  const ctx: any = { cwd, mode: "tui", isIdle: () => false,
    ui: { notify: (s: string) => notices.push(s), custom: (factory: any) => new Promise((resolve) => {
      if (!constructOverlay) return resolve(undefined);
      component = factory(tui(), null, null, () => {});
      component.session.child.stdin.write = () => true;
      resolve(undefined);
    }) } };
  const run = async (params = {}) => (await tool.execute("test", params, undefined, undefined, ctx)).content[0].text;
  const collect = async (id: string) => (await notesTool.execute("t", { id }, undefined, undefined, ctx)).content[0].text;
  const idOf = (text: string) => { const m = text.match(/hunk-\d+/); assert.ok(m, text); return m![0]; };
  assert.equal(await run({ pr: 1, base: "main" }), "Pass either pr or base, not both.");
  assert.equal(await run({ ref: "topic" }), "ref requires base.");
  ctx.mode = "print";
  assert.match(await run(), /interactive/);
  ctx.mode = "tui";

  const fixture = mkdtempSync(tmpdir() + "/hunk-wiring-");
  const path = process.env.PATH;
  try {
    // Argument capture at the executable boundary, with no GitHub/network calls.
    const script = `#!/bin/sh\nprintf '%s\\n' "$@" > '${fixture}/args'\ncat '${cwd}probe/sample.diff'\n`;
    for (const bin of ["git", "gh"]) writeFileSync(`${fixture}/${bin}`, script, { mode: 0o755 });
    process.env.PATH = fixture + ":" + path;
    assert.match(await run(), /Review hunk-\d+ opened \(working tree\)/);
    assert.equal(readFileSync(fixture + "/args", "utf8"), "diff\nHEAD\n");
    assert.match(await run({ base: "main", ref: "topic", paths: "space name" }), /opened \(main\.\.\.topic\)/);
    assert.equal(readFileSync(fixture + "/args", "utf8"), "diff\nmain...topic\n--\nspace name\n");
    assert.match(await run({ base: "main" }), /opened \(main\.\.\.HEAD\)/);
    assert.match(await run({ pr: 123 }), /opened \(PR #123\)/);
    assert.equal(readFileSync(fixture + "/args", "utf8"), "pr\ndiff\n123\n");
    writeFileSync(fixture + "/git", "#!/bin/sh\nexit 0\n");
    assert.equal(await run(), "No changes to review (working tree).");
    writeFileSync(fixture + "/git", "#!/bin/sh\necho broken >&2\nexit 7\n");
    assert.equal(await run({ base: "main" }), "git diff main...HEAD failed: broken");
  } finally {
    process.env.PATH = path;
    rmSync(fixture, { recursive: true, force: true });
  }

  // Real git and real hunk from here.
  constructOverlay = true;
  assert.match(await run({ base: "main", cwd: "/tmp" }), /Not a git repository/);
  assert.equal(await run({ base: "main", cwd: "no-such-dir" }), "cwd is not a directory: " + cwd + "no-such-dir");
  assert.match(await collect("hunk-999"), /No review session hunk-999\. Known:/);

  const id1 = idOf(await run({ base: "HEAD~1" })); // deterministic in any clone, clean or dirty
  assert.match(await collect(id1), new RegExp("Review " + id1 + " \\(HEAD~1\\.\\.\\.HEAD\\) is still open; 0 note"));
  writeFileSync(component.session.dir + "/notes.json", JSON.stringify([note]));
  component.session.child.emit("close", 0);
  assert.equal(await collect(id1), "Review notes on HEAD~1...HEAD (1):\n- `x` hunk 1 (new 1): first\n  second");
  assert.match(await collect(id1), /No review session/); // finished sessions are consumed on read
  component.dispose();

  const id2 = idOf(await run({ base: "HEAD~1" }));
  writeFileSync(component.session.dir + "/notes.json", JSON.stringify([note]));
  component.handleInput("\x11");
  assert.equal(await collect(id2), "User cancelled the review.");
  component.dispose();

  const id3 = idOf(await run({ base: "HEAD~1" }));
  component.session.child.emit("close", 7);
  assert.match(await collect(id3), /hunk exited with code 7/);
  component.dispose();

  const id4 = idOf(await run({ base: "HEAD~1" }));
  writeFileSync(component.session.dir + "/notes.json", JSON.stringify([note]));
  component.session.child.emit("close", 7);
  assert.match(await collect(id4), /Review notes on HEAD~1...HEAD/); // notes retained on abnormal exit
  component.dispose();

  const id5 = idOf(await run({ base: "HEAD~1" }));
  writeFileSync(component.session.dir + "/notes.json", "null");
  component.session.child.emit("close", 0);
  assert.match(await collect(id5), /hunk review failed: Error: Invalid review notes/);
  component.dispose();

  // Command path: non-blocking open, delivery fires when hunk exits.
  await command.handler("probe/sample.diff", ctx);
  writeFileSync(component.session.dir + "/notes.json", JSON.stringify([note]));
  component.session.child.emit("close", 0);
  assert.match(sent[0], /Review notes on sample\.diff/);
  assert.deepEqual(sent[1], { deliverAs: "followUp" });
  await command.handler("probe/sample.diff", ctx);
  writeFileSync(component.session.dir + "/notes.json", "[]");
  component.session.child.emit("close", 0);
  assert.equal(notices.pop(), "No review notes.");
  assert.match(notices.pop() ?? "", /Review hunk-\d+ opened/);
  component.dispose();

  // Real overlay, mocked outer terminal: check mouse symmetry, raw input, and all close paths.
  for (const action of ["cancel", "kitty-cancel", "dispose", "corrupt", "exit"]) {
    const writes: string[] = [], inputs: string[] = [];
    let doneCount = 0;
    const tui2: any = { terminal: { columns: 100, rows: 30, write: (s: string) => writes.push(s) }, requestRender() {} };
    ctx.ui.custom = (factory: any) => new Promise((resolve) => {
      component = factory(tui2, null, null, (value: any) => { doneCount++; resolve(value); });
      component.session.child.stdin.write = (data: string) => { inputs.push(data); return true; };
      component.handleInput("\x03"); // Ctrl+C belongs to hunk, never to the host
      component.handleInput("\x1b[<65;40;10M");
      assert.deepEqual(inputs, ["\x03", "\x1b[<65;40;10M"]);
      if (action.endsWith("cancel")) {
        writeFileSync(component.session.dir + "/notes.json", JSON.stringify([note]));
        component.handleInput(action === "cancel" ? "\x11" : "\x1b[113;5u");
      }
      else if (action === "dispose") { component.dispose(); resolve(undefined); }
      else {
        if (action === "corrupt") writeFileSync(component.session.dir + "/notes.json", "null");
        component.session.child.emit("close", 0);
      }
    });
    await command.handler("probe/sample.diff", ctx);
    assert.match(notices.pop() ?? "", /Review hunk-\d+ opened/);
    if (action.endsWith("cancel")) assert.equal(notices.pop(), "Review cancelled.");
    if (action === "corrupt") assert.match(notices.pop() ?? "", /Invalid review notes/);
    component.dispose(); component.handleInput("\x11");
    assert.equal(doneCount, action === "dispose" ? 0 : 1);
    assert.deepEqual(writes, ["\x1b[?1000h\x1b[?1002h\x1b[?1006h", "\x1b[?1006l\x1b[?1002l\x1b[?1000l"]);
    const lines = component.render(80);
    assert.equal(lines.length, 30);
    assert.ok(lines.every((l: any) => visibleWidth(l) === 80));
  }
  console.log("WIRING_OK");
  } catch (e) { console.log("WIRING_FAIL:", e instanceof Error ? e.message : String(e)); throw e; }
}
