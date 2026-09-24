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
  assert.deepEqual(Object.keys(tool.parameters.properties), ["pr", "base", "ref", "paths", "mode", "patch", "title", "cwd", "notes"]);
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
  const finish = (code: number) => {
    component.session.child.kill(); // synthetic exit must not orphan the real test child
    component.session.child.emit("exit", code);
    component.session.child.emit("close", code); // duplicate completion must be harmless
  };
  assert.equal(await run({ pr: 1, base: "main" }), "Pass either pr or base, not both.");
  assert.equal(await run({ ref: "topic" }), "ref requires base.");
  for (const field of ["pr", "base", "ref", "paths"]) {
    assert.equal(await run({ patch: "x", [field]: field === "pr" ? 1 : "HEAD" }), "patch is exclusive: drop pr/base/ref/paths.");
  }
  assert.equal(await run({ patch: "x", mode: "show" }), "patch requires patch mode.");
  assert.equal(await run({ mode: "show", base: "HEAD" }), "show accepts ref, not base.");
  for (const ref of ["", " ", "--output=bad"]) {
    assert.equal(await run({ mode: "show", ref }), "Refs must be nonempty and must not start with '-'.");
    assert.equal(await run({ base: ref }), "Refs must be nonempty and must not start with '-'.");
  }
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
    assert.equal(readFileSync(fixture + "/args", "utf8"), "diff\n--name-only\nHEAD\n");
    assert.match(await run({ base: "main", ref: "topic", paths: "space name" }), /opened \(main\.\.topic\)/);
    assert.equal(readFileSync(fixture + "/args", "utf8"), "diff\n--name-only\nmain\ntopic\n--\nspace name\n");
    assert.match(await run({ base: "main" }), /opened \(main\.\.HEAD\)/);
    assert.equal(readFileSync(fixture + "/args", "utf8"), "diff\n--name-only\nmain\nHEAD\n");
    assert.equal(await run({ pr: 123, mode: "diff" }), "pr reviews as a patch (no local refs); drop pr to review the repository with diff mode.");
    assert.match(await run({ pr: 123 }), /opened \(PR #123\)/);
    assert.equal(readFileSync(fixture + "/args", "utf8"), "pr\ndiff\n123\n");
    writeFileSync(fixture + "/git", "#!/bin/sh\nexit 0\n");
    assert.equal(await run(), "No changes to review (working tree).");
    writeFileSync(fixture + "/git", "#!/bin/sh\necho broken >&2\nexit 7\n");
    assert.match(await run({ base: "main" }), /git diff main HEAD failed: broken/);
    assert.equal(await run({ patch: "x", base: "main" }), "patch is exclusive: drop pr/base/ref/paths.");
  } finally {
    process.env.PATH = path;
    rmSync(fixture, { recursive: true, force: true });
  }

  // Real git and real hunk from here.
  constructOverlay = true;
  assert.match(await run({ base: "main", cwd: "/tmp" }), /git diff main HEAD failed:/); // failed inside the requested cwd
  assert.equal(await run({ base: "main", cwd: "no-such-dir" }), "cwd is not a directory: " + cwd + "no-such-dir");
  assert.match(await collect("hunk-999"), /No review session hunk-999\. Unknown or expired.*Known:/);
  assert.match(await run({ mode: "show", ref: "no-such-ref" }), /git rev-parse no-such-ref failed/);

  const id1 = idOf(await run({ base: "HEAD~1" })); // deterministic in any clone, clean or dirty
  assert.match(await collect(id1), new RegExp("Review " + id1 + " \\(HEAD~1\\.\\.HEAD\\) is still open; 0 note"));
  writeFileSync(component.session.dir + "/notes.json", JSON.stringify([note]));
  finish(0);
  assert.equal(await collect(id1), "Review notes on HEAD~1..HEAD (1):\n- `x` hunk 1 (new 1): first\n  second");
  assert.equal(await collect(id1), "Review notes on HEAD~1..HEAD (1):\n- `x` hunk 1 (new 1): first\n  second"); // finished sessions stay readable
  component.dispose();

  const id2 = idOf(await run({ base: "HEAD~1" }));
  writeFileSync(component.session.dir + "/notes.json", JSON.stringify([note]));
  component.handleInput("\x11");
  assert.equal(await collect(id2), "User force-cancelled the review (Ctrl+Q); notes were discarded.");
  component.dispose();

  const id3 = idOf(await run({ base: "HEAD~1" }));
  finish(7);
  assert.match(await collect(id3), /hunk exited with code 7/);
  component.dispose();

  const id4 = idOf(await run({ base: "HEAD~1" }));
  writeFileSync(component.session.dir + "/notes.json", JSON.stringify([note]));
  finish(7);
  assert.match(await collect(id4), /Review notes on HEAD~1..HEAD/); // notes retained on abnormal exit
  component.dispose();

  const id5 = idOf(await run({ base: "HEAD~1" }));
  writeFileSync(component.session.dir + "/notes.json", "null");
  finish(0);
  assert.match(await collect(id5), /hunk review failed: Error: Invalid review notes/);
  component.dispose();

  // Repo modes: diff in the repository (live session hint) and show for a commit.
  const id6 = idOf(await run({ base: "HEAD~1", mode: "diff" }));
  assert.match(await collect(id6), /is still open; 0 note/);
  writeFileSync(component.session.dir + "/notes.json", JSON.stringify([note]));
  finish(0);
  assert.equal(await collect(id6), "Review notes on HEAD~1..HEAD (1):\n- `x` hunk 1 (new 1): first\n  second");
  component.dispose();

  const id7 = idOf(await run({ mode: "show" }));
  assert.match(await collect(id7), new RegExp("Review " + id7 + " \\(show HEAD\\) is still open"));
  component.dispose();

  const id8 = idOf(await run({ patch: readFileSync(cwd + "probe/sample.diff", "utf8"), title: "inline" }));
  assert.match(await collect(id8), new RegExp("Review " + id8 + " \\(inline\\) is still open"));
  writeFileSync(component.session.dir + "/notes.json", JSON.stringify([note]));
  finish(0);
  assert.equal(await collect(id8), "Review notes on inline (1):\n- `x` hunk 1 (new 1): first\n  second");
  component.dispose();

  const id9 = idOf(await run({ base: "HEAD~1", mode: "patch" })); // patch mode, quit with zero notes
  finish(0);
  assert.equal(await collect(id9), "User quit hunk on HEAD~1...HEAD without saving any notes.");
  component.dispose();

  // Command path: non-blocking open, delivery fires when hunk exits.
  await command.handler("probe/sample.diff", ctx);
  writeFileSync(component.session.dir + "/notes.json", JSON.stringify([note]));
  finish(0);
  assert.match(sent[0], /Review notes on sample\.diff/);
  assert.deepEqual(sent[1], { deliverAs: "followUp" });
  await command.handler("probe/sample.diff", ctx);
  writeFileSync(component.session.dir + "/notes.json", "[]");
  finish(0);
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
        finish(0);
      }
    });
    await command.handler("probe/sample.diff", ctx);
      // Every close path finishes synchronously, without waiting for pipe EOF.
    assert.match(notices.pop() ?? "", /Review hunk-\d+ opened/);
    if (action === "corrupt") assert.match(notices.pop() ?? "", /Invalid review notes/);
    else assert.equal(notices.pop(), action === "exit" ? "No review notes." : "Review cancelled.");
    component.dispose(); component.handleInput("\x11");
    assert.equal(doneCount, 1);
    assert.deepEqual(writes, ["\x1b[?1000h\x1b[?1002h\x1b[?1006h", "\x1b[?1006l\x1b[?1002l\x1b[?1000l"]);
    const lines = component.render(80);
    assert.equal(lines.length, 30);
    assert.ok(lines.every((l: any) => visibleWidth(l) === 80));
  }
  // A long-lived review must remain collectible after 21 newer reviews have finished.
  ctx.ui.custom = (factory: any) => new Promise((resolve) => {
    component = factory(tui(), null, null, resolve);
    component.session.child.stdin.write = () => true;
  });
  const longId = idOf(await run({ patch: readFileSync(cwd + "probe/sample.diff", "utf8"), title: "long review" }));
  // Finished results survive reads; only the oldest finished result expires at the cap.
  ctx.ui.custom = async () => { throw new Error("fixture spawn failure"); };
  const completed: string[] = [];
  for (let i = 0; i < 21; i++) completed.push(idOf(await run({ patch: "fixture" })));
  assert.match(await collect(completed[0]), /Unknown or expired/);
  assert.match(await collect(completed[1]), /fixture spawn failure/);
  assert.equal(await collect(completed[20]), await collect(completed[20]));
  assert.match(await collect(longId), /is still open/);
  finish(0);
  assert.equal(await collect(longId), "User quit hunk on long review without saving any notes.");
  assert.match(await collect(completed[1]), /Unknown or expired/);
  component.dispose();
  console.log("WIRING_OK");
  } catch (e) { console.log("WIRING_FAIL:", e instanceof Error ? e.message : String(e)); throw e; }
}
