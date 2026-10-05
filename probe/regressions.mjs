// Focused fault/stream probes against the same session as the real-hunk tests. No new test API.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createTerminal } from "@coder/libghostty-vt-node";
import { HunkSession } from "../extensions/hunk-pty.ts";
import notesExtension from "../hunk-ext/pi-notes.mjs";

export async function regressions({ open, check, until }) {
  // stty addresses the pty device by path: -f on macOS, -F on Linux (util-linux).
  const sttyDevice = process.platform === "darwin" ? "-f" : "-F";
  const s = open();
  check("fault probe reached hunk UI", await until(() => s.has(/Patch review/)));
  s.session.child.stdout.pause(); // inject deterministic chunks, without a concurrent hunk redraw
  const feed = (text) => s.session.child.stdout.emit("data", Buffer.from(text));
  const writes = [];
  const stdin = s.session.child.stdin;
  const write = stdin.write;
  stdin.write = (data) => { writes.push(data); return true; };
  feed("\x1b[?u");
  check("legacy mode never answers kitty", writes.length === 0);
  stdin.write = write;

  // Kitty session: every split position, consecutive queries, no duplicated tail matches.
  const k = open({ kitty: true });
  check("fragment probe reached hunk UI", await until(() => k.has(/Patch review/)));
  k.session.child.stdout.pause();
  const replies = [];
  const kwrite = k.session.child.stdin.write;
  k.session.child.stdin.write = (data) => { replies.push(data); return true; };
  const query = "\x1b[?u";
  for (let i = 1; i < query.length; i++) {
    k.session.child.stdout.emit("data", Buffer.from(query.slice(0, i)));
    k.session.child.stdout.emit("data", Buffer.from(query.slice(i)));
  }
  k.session.child.stdout.emit("data", Buffer.from(query + query + "abc"));
  k.session.child.stdout.emit("data", Buffer.from("def"));
  check("split/repeated kitty queries answered exactly once each", replies.length === 5 && replies.every(r => r === "\x1b[?0u"));
  k.session.child.stdin.write = kwrite;
  k.session.dispose();

  for (const visible of [false, true]) {
    const control = `\x1b[?25${visible ? "h" : "l"}`;
    for (let i = 1; i < control.length; i++) {
      feed(`\x1b[?25${visible ? "l" : "h"}`);
      feed(control.slice(0, i)); feed(control.slice(i));
      check(`cursor ${visible ? "show" : "hide"} split at ${i}`, s.session.cursorVisible === visible);
    }
  }
  feed("\x1b[0m\x1b[2J\x1b[H");
  check("blank cursor is inverted", s.session.lines()[0].startsWith("\x1b[0;7m "));
  feed("\x1b[?25l中é\x1b[38;2;1;2;3mAB\x1b[0m");
  const lines = s.session.lines();
  const roundtrip = createTerminal({ cols: 100, rows: 30 });
  lines.forEach((line, i) => roundtrip.feed(`\x1b[${i + 1};1H${line}`));
  const cells = roundtrip.snapshot({ includeCells: true }).cells;
  check("wide/combining cells keep columns and colour runs", cells.some(c => c.text === "中" && c.width === 2 && c.col === 0) &&
    cells.some(c => c.text === "é" && c.col === 2) && cells.some(c => c.text === "B" && c.col === 4 && c.foreground === "#010203"));
  check("serializer merges equal colour runs", lines[0].split("38;2;1;2;3").length === 2);
  check("blank rows retain exact dimensions", lines.length === 30 && lines.slice(1).every(l => l.replace(/\x1b\[[0-9;]*m/g, "").length === 100));
  roundtrip.dispose();
  feed("x".repeat(1024 * 1024) + "\r\nFLOOD_END");
  check("flood is fed in order without an output backlog", s.session.text().some(l => l.includes("FLOOD_END")));

  const ttyFile = s.session.dir + "/tty";
  const tty = readFileSync(ttyFile, "utf8");
  rmSync(ttyFile);
  check("missing tty lookup remains retryable", !s.session.resize(80, 20));
  writeFileSync(ttyFile, "/dev/no-such-tty");
  check("failed stty remains retryable", !s.session.resize(80, 20) && !s.session.resize(80, 20));
  writeFileSync(ttyFile, tty);
  check("restored tty resizes; successive resizes leave newest size", s.session.resize(80, 20) && s.session.resize(70, 18) && s.session.resize(90, 22) &&
    execFileSync("stty", [sttyDevice, tty.trim(), "size"], { encoding: "utf8" }).trim() === "22 90");

  const notesFile = s.session.dir + "/notes.json";
  check("zero notes is an empty array", s.session.notes().length === 0);
  for (const bad of ["{", "null", "{}", "[{}]", '[{"file":"x","hunk":0,"lines":"1","text":3}]']) {
    writeFileSync(notesFile, bad);
    let rejected = false;
    try { s.session.notes(); } catch { rejected = true; }
    check(`corrupt notes rejected: ${bad}`, rejected);
  }
  const oldNotesFile = process.env.PI_HUNK_NOTES_FILE;
  process.env.PI_HUNK_NOTES_FILE = notesFile;
  const handlers = {};
  notesExtension({ on: (event, fn) => { handlers[event] = fn; } });
  if (oldNotesFile === undefined) delete process.env.PI_HUNK_NOTES_FILE;
  else process.env.PI_HUNK_NOTES_FILE = oldNotesFile;
  const note = { id: "n", filePath: "x", hunkIndex: 0, side: "old", oldRange: [1, 2], body: "saved", draft: false };
  handlers.note_created({ note });
  handlers.note_edited({ note: { ...note, body: "draft", draft: true } });
  check("draft edits never replace saved notes", s.session.notes()[0].text === "saved");
  handlers.note_edited({ note: { ...note, body: "edited" } });
  check("saved edits replace notes and retain old-side ranges", s.session.notes()[0].text === "edited" && s.session.notes()[0].lines === "old 1-2");
  // This Node process owns no hunk session: failed agent export must not erase user notes
  // or pretend it completed with zero notes. Removing the failed note clears the error.
  const agent = { id: "agent-failure", source: "agent", fileKey: "opaque", anchor: {}, summary: "agent" };
  await handlers.note_changed({ kind: "created", note: agent });
  let exportError = "";
  try { s.session.notes(); } catch (e) { exportError = e.message; }
  check("failed daemon export is explicit, not an empty review", /No daemon session/.test(exportError));
  check("failed daemon export preserves saved UI notes", JSON.parse(readFileSync(notesFile, "utf8")).notes[0].text === "edited");
  handlers.note_changed({ kind: "removed", note: agent });
  check("removing failed agent note clears export error", s.session.notes()[0].text === "edited");
  handlers.note_changed({ kind: "removed", note });
  s.session.child.stdout.resume();
  s.session.write("q");
  check("delete last note then quit returns zero notes", await until(() => s.exitCode !== undefined) && s.session.notes().length === 0);
  s.session.dispose();

  const dirs = () => readdirSync(tmpdir()).filter(n => n.startsWith("pi-hunk-"));
  const before = dirs();
  let threw = false;
  try { new HunkSession({ cwd: process.cwd(), cols: 1.5, rows: 20, kitty: false, onUpdate() {}, onExit() {} }); } catch { threw = true; }
  check("constructor failure leaves no session directory", threw && JSON.stringify(dirs()) === JSON.stringify(before));

  const fixture = mkdtempSync(tmpdir() + "/hunk-fault-");
  const path = process.env.PATH;
  const nativeFailure = `
    import { createRequire } from 'node:module';
    import { readdirSync } from 'node:fs';
    import { HunkSession } from ${JSON.stringify(new URL('../extensions/hunk-pty.ts', import.meta.url).href)};
    createRequire(import.meta.url).extensions['.node'] = () => { throw new Error('probe: unavailable binding'); };
    try { new HunkSession({ cwd: process.cwd(), cols: 80, rows: 20, kitty: false, onUpdate() {}, onExit() {} }); process.exit(1); }
    catch (e) { if (!e.message.includes('Failed to load @coder/libghostty-vt-node native addon') || readdirSync(process.env.TMPDIR).length) throw e; }
    console.log('NATIVE_FAILURE_OK');`;
  check("missing native binding reports error and cleans up", execFileSync(process.execPath, ["--input-type=module", "-e", nativeFailure],
    { encoding: "utf8", env: { ...process.env, TMPDIR: fixture } }).includes("NATIVE_FAILURE_OK"));
  try {
    process.env.PATH = fixture;
    const missingScript = open();
    check("missing script surfaces diagnostic on exit", await until(() => missingScript.exitCode !== undefined) && missingScript.exitCode !== 0 && missingScript.has(/script.*not found/));
    missingScript.session.dispose();
    for (const [name, target] of Object.entries({ script: "/usr/bin/script", cat: "/bin/cat", stty: "/bin/stty", tty: "/usr/bin/tty" })) symlinkSync(target, `${fixture}/${name}`);
    const missingHunk = open();
    check("missing hunk surfaces diagnostic", await until(() => missingHunk.exitCode !== undefined) && missingHunk.exitCode !== 0 && missingHunk.has(/hunk.*not found/));
    missingHunk.session.dispose();
    writeFileSync(fixture + "/hunk", '#!/bin/sh\nprintf "FINAL_DIAGNOSTIC\\n"\nexit 7\n', { mode: 0o755 });
    const final = open();
    final.session.child.stdout.pause();
    check("final buffered output survives exit", await until(() => final.exitCode !== undefined) && final.exitCode === 7 && final.has(/FINAL_DIAGNOSTIC/));
    final.session.dispose();
  } finally {
    process.env.PATH = path;
    rmSync(fixture, { recursive: true, force: true });
  }
}
