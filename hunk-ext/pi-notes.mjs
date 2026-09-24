// Loaded into hunk with --extension. Atomic saves survive hunk's exit.
import { execFile } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);
const query = async (...args) => JSON.parse((await exec("hunk", ["session", ...args, "--json"], {
  encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024 * 1024,
})).stdout);

export default function (hunk) {
  const file = process.env.PI_HUNK_NOTES_FILE;
  if (!file) return;
  const notes = new Map();
  const pending = new Map();
  const failures = new Map();
  let sessionId;
  const save = () => {
    const saved = [...notes.values()];
    // Never report an incomplete export as a successful empty review.
    const error = [...failures.values()].join("; ");
    writeFileSync(file + ".tmp", JSON.stringify(error ? { error, notes: saved } : saved));
    renameSync(file + ".tmp", file);
  };
  const put = ({ note }) => {
    if (note.draft) return;
    const range = (note.side === "old" ? note.oldRange : note.newRange) ?? [note.line, note.line];
    const lines = range[0] === range[1] ? String(range[0]) : range.join("-");
    notes.set(note.id, { file: note.filePath, hunk: note.hunkIndex, lines: `${note.side} ${lines}`, text: note.body });
    save();
  };
  hunk.on("note_created", put);
  hunk.on("note_edited", put);
  hunk.on("note_changed", ({ kind, note }) => {
    if (kind === "removed") {
      notes.delete(note.id);
      pending.delete(note.id);
      failures.delete(note.id);
      save();
      return;
    }
    if (note.source === "user") return; // richer UI events above preserve selected ranges
    // Agent comments emit only note_changed, whose fileKey is opaque. Resolve the path
    // through the public CLI asynchronously: a sync child can deadlock its own TUI.
    // Select by this process's session id, not --repo (several reviews may share a repo).
    failures.set(note.id, `Note ${note.id} has not finished exporting`);
    save();
    const task = (async () => {
      sessionId ??= (await query("list")).sessions.find((s) => s.pid === process.pid)?.sessionId;
      if (!sessionId) throw new Error("No daemon session for embedded hunk");
      const { comments } = await query("comment", "list", sessionId);
      if (pending.get(note.id) !== task) return; // removed or superseded during the read
      const comment = comments.find((c) => c.commentId === note.id);
      if (!comment) throw new Error(`Daemon did not return note ${note.id}`);
      const { preferred, oldRange, newRange, ownerHunkIndex } = note.anchor;
      const side = preferred?.side ?? (newRange ? "new" : "old");
      put({ note: { id: note.id, filePath: comment.filePath, hunkIndex: ownerHunkIndex ?? comment.hunkIndex,
        side, line: preferred?.line ?? comment.line, oldRange, newRange, body: note.summary } });
      failures.delete(note.id);
    })().catch((error) => {
      if (pending.get(note.id) === task) failures.set(note.id, `Could not export note ${note.id}: ${error.message}`);
    }).finally(() => {
      if (pending.get(note.id) === task) { pending.delete(note.id); save(); }
    });
    pending.set(note.id, task);
    return task;
  });
  // Hunk gives shutdown handlers a bounded window; unfinished exports remain explicit errors.
  hunk.on("shutdown", () => Promise.all(pending.values()));
}
