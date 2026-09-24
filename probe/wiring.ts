// Loaded by pi itself: exercise public registrations/contracts and the real overlay factory.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../extensions/index.ts";

export default async function () {
  let command: any, tool: any, sent: any;
  const notices: string[] = [];
  extension({
    registerCommand(name, spec) { assert.equal(name, "hunk-review"); command = spec; },
    registerTool(spec) { assert.equal(spec.name, "hunk_review"); tool = spec; },
    sendUserMessage(...args) { sent = args; },
  } as any);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["pr", "base", "ref", "paths", "notes"]);
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const note = { file: "x", hunk: 0, lines: "new 1", text: "first\nsecond" };
  let result: any = { kind: "exit", code: 0, screen: "", notes: [note] };
  const ctx: any = { cwd, mode: "tui", isIdle: () => false,
    ui: { notify: (s: string) => notices.push(s), custom: async () => result } };
  const run = async (params = {}) => (await tool.execute("test", params, undefined, undefined, ctx)).content[0].text;
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
    assert.match(await run(), /Review notes on working tree \(1\):\n- `x` hunk 1 \(new 1\): first\n  second/);
    assert.equal(readFileSync(fixture + "/args", "utf8"), "diff\nHEAD\n");
    assert.match(await run({ base: "main", ref: "topic", paths: "space name" }), /main\.\.\.topic/);
    assert.equal(readFileSync(fixture + "/args", "utf8"), "diff\nmain...topic\n--\nspace name\n");
    assert.match(await run({ base: "main" }), /main\.\.\.HEAD/);
    assert.equal(readFileSync(fixture + "/args", "utf8"), "diff\nmain...HEAD\n");
    assert.match(await run({ pr: 123 }), /PR #123/);
    assert.equal(readFileSync(fixture + "/args", "utf8"), "pr\ndiff\n123\n");
    result = { kind: "cancel" };
    assert.equal(await run(), "User cancelled the review.");
    result = { kind: "exit", code: 0, screen: "", notes: [] };
    assert.equal(await run(), "Review notes on working tree (0):\nnone");
    result = { kind: "exit", code: 7, screen: "failed", notes: [] };
    assert.equal(await run(), "hunk exited with code 7: failed");
    result.notes = [note];
    assert.match(await run(), /Review notes on working tree/); // retain notes even on abnormal exit
    writeFileSync(fixture + "/git", "#!/bin/sh\nexit 0\n");
    assert.equal(await run(), "No changes to review (working tree).");
    writeFileSync(fixture + "/git", "#!/bin/sh\necho broken >&2\nexit 7\n");
    assert.equal(await run({ base: "main" }), "git diff main...HEAD failed: broken");
  } finally {
    process.env.PATH = path;
    rmSync(fixture, { recursive: true, force: true });
  }
  result = { kind: "exit", code: 0, screen: "", notes: [note] };
  await command.handler("probe/sample.diff", ctx);
  assert.match(sent[0], /Review notes on sample\.diff/);
  assert.deepEqual(sent[1], { deliverAs: "followUp" });
  result.notes = [];
  await command.handler("probe/sample.diff", ctx);
  assert.equal(notices.pop(), "No review notes.");

  // Real overlay, mocked outer terminal: check mouse symmetry, raw input, and all close paths.
  for (const action of ["cancel", "kitty-cancel", "dispose", "corrupt", "exit"]) {
    const writes: string[] = [], inputs: string[] = [];
    let component: any, doneCount = 0;
    const tui: any = { terminal: { columns: 100, rows: 30, write: (s: string) => writes.push(s) }, requestRender() {} };
    ctx.ui.custom = (factory: any) => new Promise((resolve) => {
      component = factory(tui, null, null, (value: any) => { doneCount++; resolve(value); });
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
    if (action === "corrupt") await assert.rejects(command.handler("probe/sample.diff", ctx), /Invalid review notes/);
    else await command.handler("probe/sample.diff", ctx);
    if (action.endsWith("cancel")) assert.equal(notices.pop(), "Review cancelled.");
    component.dispose(); component.handleInput("\x11");
    assert.equal(doneCount, action === "dispose" ? 0 : 1);
    assert.deepEqual(writes, ["\x1b[?1000h\x1b[?1002h\x1b[?1006h", "\x1b[?1006l\x1b[?1002l\x1b[?1000l"]);
    const lines = component.render(80);
    assert.equal(lines.length, 30);
    assert.ok(lines.every((l: string) => visibleWidth(l) === 80));
  }
  console.log("WIRING_OK");
}
