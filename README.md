# pi-hunk-island

Prototype: review a diff in the **real hunk TUI** inside a pi overlay. The extension runs
`hunk patch` in a pty (macOS `script(1)`), parses its output with Ghostty's VT engine
(`@coder/libghostty-vt-node`), and paints the grid full-screen. Keys and mouse go to hunk
untouched; when you quit hunk, your notes go back to the agent.

Status: prototype. Decisions and probe evidence: DESIGN.md section j (earlier sections are the
removed v1 island design).

## Use

- `/hunk-review <diff-file>` — review a patch file; notes arrive as a user message.
- `hunk_review` tool — the agent picks `pr` (GitHub PR), `base` (+`ref`, default HEAD), or
  neither (working tree), optional `paths`; notes come back as the tool result.

Inside the overlay everything is hunk (`c` note, Ctrl+S save, `E`/`R`/`D`, `?` help, F10 menus,
your `[keybindings]`). `q` (or Ctrl+C) quits hunk and returns the saved notes. **Ctrl+Q** is the
host escape hatch: kills hunk, discards notes.

## Requirements

macOS, `hunk` (>= 0.22) on PATH, Node >= 20.19. No native build: libghostty-vt-node ships a
prebuilt, and the pty is the system `script`.

```bash
npm install
node probe/pty-probe.mjs                    # headless: real hunk in the pty, 35 checks
expect probe/interactive.exp                # real pi TUI, legacy keyboard
expect probe/interactive.exp kitty          # real pi TUI, kitty keyboard protocol
pi -ne -e ./extensions/index.ts --list-models   # load smoke
```
