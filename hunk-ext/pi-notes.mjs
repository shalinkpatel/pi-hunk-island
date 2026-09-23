// Loaded into the embedded hunk with `--extension` (runs without a trust prompt).
// Mirrors the user's saved review notes into $PI_HUNK_NOTES_FILE on every change, so they
// outlive hunk's exit. `hunk session comment list` was the alternative; see DESIGN.md j.3.
import { writeFileSync } from "node:fs";

export default function (hunk) {
  const file = process.env.PI_HUNK_NOTES_FILE;
  if (!file) return;
  const notes = new Map();
  const save = () => writeFileSync(file, JSON.stringify([...notes.values()]));
  // note_created / note_edited carry filePath + hunkIndex; note_changed (store-level) only
  // carries an opaque fileKey, so it is used just for deletes (same note id).
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
    if (kind === "removed" && notes.delete(note.id)) save();
  });
}
