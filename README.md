# pi-hunk-island

Prototype: review a diff in the **real hunk TUI** inside a pi overlay. The extension runs
`hunk diff`, `hunk show`, or `hunk patch` in a pty (macOS `script(1)`), parses its output with Ghostty's VT engine
(`@coder/libghostty-vt-node`), and paints the grid full-screen. Keys and mouse go to hunk
untouched; reviews are non-blocking and notes go back to the agent.

Status: prototype. Decisions and probe evidence: DESIGN.md section j (earlier sections are the
removed v1 island design).

## Use

- `/hunk-review <diff-file>` — opens the review; when you quit hunk, your notes go to the agent
  as a user message.
- `hunk_review` tool — the agent opens a review the same way and gets a session id back
  immediately (it never blocks); optional `cwd` picks the repository directory to diff,
  optional `notes` seed the review as agent annotations beside the diff lines (new or old side;
  any markup opts into `--experimental`).
- `hunk_notes` tool — the agent collects the outcome by session id: live status (with notes so
  far) while you review, your notes after you quit hunk. Repeated reads are safe; the latest
  20 finished results stay available until pi restarts. Quit with zero notes, cancellation,
  export failure, and unknown/expired ids have distinct results.

Tool sources:
- `hunk_review({cwd, base: "main", ref: "HEAD"})` runs `hunk diff main HEAD` (direct endpoints).
  Without a base it reviews tracked changes against HEAD, including staged changes.
- `hunk_review({cwd, mode: "show", ref: "HEAD"})` reviews one commit.
- `hunk_review({patch: "diff --git ...", title: "Review"})` reviews supplied unified diff text.
- `pr` uses `gh pr diff` and patch mode. Explicit `mode: "patch"` retains the old
  `base...ref` merge-base comparison.

Diff/show sessions support live `hunk session` navigation and comments. Use `hunk session list
--json` to get hunk's UUID (different from pi's `hunk-N` id), then `hunk session comment add
<uuid> --file <path> --new-line <n> --summary <text>`. Saved user notes and daemon comments
both return through `hunk_notes`; seeded sidecar annotations are not echoed back.

Inside the overlay everything is hunk (`c` note, Ctrl+S save, `E`/`R`/`D`, `?` help, F10 menus,
your `[keybindings]`). `q` (or Ctrl+C) quits hunk and returns the saved notes. **Ctrl+Q** is the
host escape hatch: kills hunk, discards notes.

## Requirements

macOS, `hunk` (>= 0.22) on PATH, Node >= 20.19. No native build: libghostty-vt-node ships a
prebuilt, and the pty is the system `script`.

```bash
npm install
node probe/pty-probe.mjs                    # real hunk, fault probes, command/tool contracts
expect probe/interactive.exp                # real pi TUI, legacy keyboard
expect probe/interactive.exp kitty          # real pi TUI, kitty keyboard protocol
timeout 90 pi -e ./extensions/index.ts --list-models  # load smoke
```
