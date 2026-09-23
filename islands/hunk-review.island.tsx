/** @jsxImportSource @opentui/react */

// Island module loaded by the opentui-island Bun sidecar (default export).
// Props must be JSON-serializable: the host passes the raw unified diff text.
// Bridge events (island -> host). No "ready" event on purpose: it is emitted during mount,
// before the host can subscribe, so it is lost (see DESIGN.md). createPiTuiSurface() resolving
// is the ready signal.
//   submit { notes: ReviewNote[] }   (Ctrl+S)
//   cancel { reason: "user" }        (Esc while not typing a note)
import { useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useIslandBridge } from "opentui-island";
import { HunkDiffView, createHunkDiffFilesFromPatch } from "hunkdiff/opentui";
import { getFiletypeFromFileName } from "@pierre/diffs";

export type ReviewNote = {
  file: string; // new path (old path for deletions)
  hunk: number; // 0-based hunk index within the file
  lines: string; // new-side line range of the hunk, e.g. "21-26"
  text: string;
};

type Props = { patch?: string; title?: string };

export default function HunkReviewIsland({ patch = "", title = "diff" }: Props) {
  const bridge = useIslandBridge();
  const { width, height } = useTerminalDimensions();
  // Patch parsing leaves language unset => hunk highlights as "text". Infer from the path.
  const files = useMemo(
    () =>
      createHunkDiffFilesFromPatch(patch, "review").map((f) => ({
        ...f,
        language: f.language ?? getFiletypeFromFileName(f.path ?? f.metadata.name),
      })),
    [patch],
  );
  const [fileIndex, setFileIndex] = useState(0);
  const [hunk, setHunk] = useState(0);
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [draft, setDraft] = useState<string | null>(null); // null = not composing
  const scroll = useRef<ScrollBoxRenderable>(null);

  const file = files[fileIndex];
  const hunks = file?.metadata.hunks ?? [];
  const path = file?.path ?? file?.metadata.name ?? "?";

  const gotoFile = (delta: number) => {
    if (files.length === 0) return;
    setFileIndex((i) => (i + delta + files.length) % files.length);
    setHunk(0);
    if (scroll.current) scroll.current.scrollTop = 0;
  };

  useKeyboard((key) => {
    if (draft !== null) {
      if (key.name === "escape") setDraft(null);
      return; // the focused <input> owns every other key
    }
    if (key.ctrl && key.name === "s") return bridge.emit("submit", { notes });
    if (key.name === "escape") return bridge.emit("cancel", { reason: "user" });
    const page = Math.max(1, height - 3);
    switch (key.name) {
      case "down": case "j": return scroll.current?.scrollBy(1);
      case "up": case "k": return scroll.current?.scrollBy(-1);
      case "pagedown": case "space": return scroll.current?.scrollBy(page);
      case "pageup": return scroll.current?.scrollBy(-page);
      // ponytail: n/p only move the highlight; no auto-scroll to the hunk (row offsets are not exported by hunkdiff).
      case "n": return setHunk((h) => Math.min(h + 1, Math.max(0, hunks.length - 1)));
      case "p": return setHunk((h) => Math.max(0, h - 1));
      case "tab": return gotoFile(key.shift ? -1 : 1);
      case "]": return gotoFile(1);
      case "[": return gotoFile(-1);
      case "c": return file && hunks.length > 0 ? setDraft("") : undefined;
    }
  });

  const addNote = (text: string) => {
    const h = hunks[hunk];
    if (text.trim() && h) {
      const end = h.additionStart + Math.max(0, h.additionCount - 1);
      setNotes((n) => [...n, { file: path, hunk, lines: `${h.additionStart}-${end}`, text: text.trim() }]);
    }
    setDraft(null);
  };

  if (files.length === 0) {
    return <text>No files in diff ({title}). Esc closes.</text>;
  }

  const notesHere = notes.filter((n) => n.file === path).length;
  const header = ` ${title}  [${fileIndex + 1}/${files.length}] ${path}  hunk ${hunk + 1}/${hunks.length}  notes ${notes.length} (${notesHere} here)`;
  const footer = " j/k scroll  n/p hunk  Tab/[ ] file  c comment  Ctrl+S submit  Esc cancel";

  return (
    <box flexDirection="column" width="100%" height="100%">
      <text fg="#88c0d0">{header}</text>
      <scrollbox ref={scroll} flexGrow={1} scrollY focused={false}>
        <HunkDiffView
          diff={file}
          width={Math.max(20, width - 1)}
          // unified + wrapLines: split pads short lines into dead space and
          // unwrapped prose overflows both panels.
          canonicalLayout="unified"
          wrapLines={true}
          selectedHunkIndex={hunk}
          scrollable={false}
        />
      </scrollbox>
      {draft !== null ? (
        <box flexDirection="row" height={1}>
          <text fg="#ebcb8b">{` note on ${path} hunk ${hunk + 1}: `}</text>
          <input flexGrow={1} focused value={draft} onInput={setDraft} onSubmit={addNote} placeholder="type, Enter to add, Esc to discard" />
        </box>
      ) : (
        <text fg="#6b7280">{footer}</text>
      )}
    </box>
  );
}
