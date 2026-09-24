# pi-hunk-island — design

v2: the real hunk TUI inside a pi overlay. pi spawns hunk in a pty, feeds its output
through Ghostty's VT engine (@coder/libghostty-vt-node), and paints the VT grid as
overlay lines. Input is raw byte passthrough; notes return to the agent via a hunk-side
extension that dumps them to JSON.

v1 (the opentui-island overlay) is removed; its design lives in git history up to `b8e8040`.
Everything below is the current architecture.
## j. v2: real hunk TUI in a pty via libghostty-vt

Sections a–i and the handoff above describe v1 (the opentui-island overlay). v1 is **removed**:
`islands/`, the island overlay, its probes (`probe/run.mjs`, `resolve.ts`, `pi-smoke.ts`,
`skew-*`) and the deps `opentui-island`, `hunkdiff`, `@opentui/core`, `@opentui/react`,
`@pierre/diffs`, `react` (and the `@mariozechner/pi-tui` dev alias only opentui-island needed).
They stay readable in git history up to `b8e8040`. The `/hunk-review` command, the `hunk_review`
tool and `computePatch` are reused unchanged in behaviour.

v2 runs the **real** `hunk` binary (0.22.0) in a pty, feeds its output into Ghostty's VT engine
(`@coder/libghostty-vt-node` 0.1.0-beta.0), and paints the VT grid as the overlay. Every hunk
feature (sidebar, menus/F10, search, note edit/reply/delete, user keybindings, user
extensions) is simply there.

| File | Role |
|---|---|
| `extensions/hunk-pty.ts` | `HunkSession`: pty spawn, kitty handshake, VT feed, resize, cell → ANSI serializer, notes read, teardown. Only node + libghostty imports, so the probe drives the exact code pi runs. |
| `extensions/index.ts` | pi wiring: overlay component, command, tool, `computePatch`, `formatNotes`. |
| `hunk-ext/pi-notes.mjs` | hunk-side extension (loaded with `--extension`) mirroring saved user notes to a JSON file. |
| `probe/pty-probe.mjs` → `probe/pty-output.txt` | Real-hunk checks plus `regressions.mjs` (stream/fault probes) and pi-loaded `wiring.ts` (command/tool/overlay contracts). |
| `probe/interactive.exp [kitty]` | Real pi TUI in an expect pty, both keyboard modes. |

Checks kept and run for this section (all pass): `node probe/pty-probe.mjs` (PROBE_OK),
`expect probe/interactive.exp` and `expect probe/interactive.exp kitty` (E2E_OK),
`timeout 90 pi -e ./extensions/index.ts --list-models` (loads, exit 0, no `Error` on either stream).

### j.1 pty: macOS `script(1)`, not node-pty

**Chosen: `script -q /dev/null <cmd>` via plain `child_process`.** No native pty addon.

Probe evidence:
- Spawned directly with node pipes, script dies: `script: tcgetattr/ioctl: Operation not supported
  on socket` — libuv stdio pipes are socketpairs, and script only tolerates `ENOTTY`. A real pipe
  works, so bash feeds it: `exec script -q /dev/null /bin/sh -c "$0" sh "$@" < <(cat; kill $$)`.
  After `exec` the node child **is** script. Its `exit` event closes stdin to release cat;
  `close` delivers the result only after stdout/stderr drain (exit code passed through).
- **Size:** with a non-tty stdin script opens a 0×0 pty and honours neither the parent nor
  `LINES`/`COLUMNS`; the inner sh runs `stty cols C rows R` before `exec hunk`. First hunk frame
  after ~170 ms.
- **Mid-session resize works** (not a dealbreaker): the inner sh writes `tty` to the session dir;
  `stty -f /dev/ttysNNN cols C rows R` from outside sets the winsize and the kernel SIGWINCHes
  hunk, which redraws (probe: rule becomes 78 cells at 80 cols; e2e: 88 cells at 90 cols after
  `stty` on pi's own pty). VT is resized *before* the stty so the redraw lands on the new grid.
- **Input/mouse:** bytes written to stdin arrive in hunk unchanged (keys, CSI-u, SGR mouse wheel
  `ESC[<65;40;10M` scrolls the diff).
- **Orphans:** script ignores stdin EOF, so a pi that dies without `dispose()` would leave script +
  hunk running (seen: a stray `hunk patch` after a failed expect run; negative control with
  `< <(exec cat)` leaves 2 processes after the host is SIGKILLed). With `(cat; kill $$)` the feeding
  cat's EOF kills script, hunk gets SIGHUP: probe check "host SIGKILLed without dispose" passes.
  ponytail: `$$` is killed a few ms after script may have exited already; pid reuse in that window
  is the ceiling.

**Rejected: node-pty.** The shipped darwin-arm64 prebuild fails every spawn (`posix_spawnp failed`,
no `spawn-helper`); it only works after `npm install-scripts approve node-pty` + `node-gyp rebuild`
in every consumer install. npm here blocks install scripts by default, so a pi package install
would ship a broken pty. It would buy Linux support and in-process resize, neither worth a
native build step for this prototype.

Delta: **macOS only.** `package.json` has `"os": ["darwin"]` and both entry points refuse other
platforms. Linux upgrade path: util-linux `script -qfec <cmd> /dev/null` and `stty -F`.

libghostty-vt-node: its prebuilt loads with install scripts blocked (npm warns
`install-scripts ... @coder/libghostty-vt-node`; nothing needs approving). Pinned exactly (beta).

### j.2 Rendering: snapshot cells → ANSI lines, push-based

- `render(width)`: `session.resize(width, tui.terminal.rows)` (no-op unless changed), then
  `snapshot({includeCells:true})`. Cells are flat, row-major, `{row,col,text,width,foreground,
  background,bold?,italic?,underline?}`, colours `#rrggbb`, default colour = field absent; the
  cell after a width-2 glyph is omitted (probed with `中`).
- Serializer: walk each row by cell width, synthesizing blank cells for gaps; emit a full SGR
  (`ESC[0;1;3;4;7;38;2;r;g;b;48;2;r;g;bm`, only set parts) whenever style changes, then text,
  with `ESC[0m` at row end. Blank cursor cells are included; wide glyphs advance two columns. Probe: 30 lines × 100 cells, 20 × 80 after resize,
  24-bit colours present. The overlay still runs each line through `truncateToWidth`/pad so a
  width disagreement between Ghostty and pi-tui can never overflow pi's line width.
- **Cursor:** hunk shows the terminal cursor in its note editor (`?25l…?25h` per frame, cursor
  at the typing position). `HunkSession` tracks the last `?25h`/`?25l` in the stream and draws the
  cursor cell with SGR 7 (inverse), including empty cells and wide-glyph continuation positions.
  A five-byte tail preserves controls split across output chunks; repeated kitty queries each
  receive one reply, only in kitty mode.
- **Delta: no poll timer.** v1 polled because island frames were pull-based. Here every pty data
  event calls `tui.requestRender()`, which pi-tui coalesces (nextTick + render throttle).

### j.3 Notes: a tiny hunk extension writing a JSON file

**Chosen:** `hunk patch --extension hunk-ext/pi-notes.mjs <file>` with `PI_HUNK_NOTES_FILE` in
the env. `--extension` paths run without a trust prompt (hunk docs, group 1). On
`note_created` / `note_edited` (`draft:false`) it stores `{file, hunk, lines, text}` by note id;
on `note_changed` `kind:"removed"` it deletes. Each save writes a sibling temporary file and
renames it atomically over the mirror. The session initializes the mirror to `[]`; readers
see complete saves. Malformed JSON or invalid note fields raise an error, not an empty review;
the overlay still disables mouse, disposes the session, and completes before surfacing it.

Why this is the simplest *reliable* path — probe evidence:
- `hunk session list --json` works while hunk runs (pid, tty, title), but
  `hunk session comment list --repo . [--type user] --json` returned `hunk: protocol-validation-failed`
  both while alive (with 2 saved notes) and on 5 polls right after `q`. Even if it worked, the
  daemon only knows live sessions, so reading notes means polling and racing the user's quit.
- Nothing hunk writes on disk holds notes (review notes are session-local; extension docs:
  "no backlog to replay").
- Extension payloads, captured: `note_created` = `{id, fileId, filePath, hunkIndex, side, line,
  newRange, body, draft:false}`; `note_changed` = `{kind, note:{id, fileKey:"file:<hash>",
  anchor, summary, ...}}` (no path, so used only for removes; same id). In event handlers
  `ctx.review` only has `requestReload` — `snapshot()` exists only for commands.
- The file is written synchronously at save time, so it is complete before hunk can exit. Probe:
  two notes saved, a third deleted with hunk's `D`, both remaining notes read after exit;
  kitty session note read after exit.

Delivery (unchanged contract): hunk quits → notes; command path `pi.sendUserMessage(formatNotes(...))`
(`followUp` when busy), "No review notes." when empty; tool path `formatNotes` as the tool result
(count 0 → "none"). Host cancel → "Review cancelled." / "User cancelled the review.". `lines` is
now `"<side> <a>[-<b>]"` (e.g. `new 21`), so `formatNotes` prints `hunk 2 (new 21): text`; multi-line
bodies are indented. Nonzero hunk exit with no notes → error with the last screen text (e.g.
`script: hunk: No such file or directory` when hunk is not on PATH).

### j.4 Kitty keyboard handshake: the child speaks kitty

hunk's startup output, captured byte-exact (OpenTUI capability probe):
`ESC[?2031h ESC]10;?BEL ESC]11;?BEL ESC[>0q ESC[?25l ESC[s ESC[6n ESC P+q4d73 ESC\ ESC[?1016$p
ESC[?2027$p ESC[?2031$p ESC[?1004$p ESC[?2004$p ESC[?2026$p **ESC[?u** ESC]99;…ESC\ ESC]1337;Capabilities
ESC\ ESC_Gi=31337,…ESC\ **ESC[c** …` then alt screen, `ESC[>4;1m` (modifyOtherKeys),
`?2027h ?2004h ?1000h ?1002h ?1003h ?1006h`.

- The VT engine never answers queries (the binding has no pty-response callback), so the
  extension is the terminal. `HunkSession` answers `ESC[?u` with **`ESC[?0u`** ("kitty supported,
  no flags pushed yet" — what a fresh kitty terminal says) only when
  `isKittyProtocolActive()` was true at open. hunk then pushes **`ESC[>5u`** (disambiguate +
  alternate keys) and sends **`ESC[>4;0m`** (modifyOtherKeys off). Unanswered it stays legacy:
  no push, `ESC[>4;1m`. All other queries stay unanswered; startup is not delayed (~170 ms).
- **Empirical delta from the design's expectation:** OpenTUI's input parser decodes CSI-u keys
  whether or not the query was answered (`ESC[99u` opens the note editor in both sessions), and
  legacy `ESC`/`^S` still work after the handshake. So the handshake does not decide *which keys
  work*; it makes hunk's declared keyboard mode match the bytes pi forwards (and turns
  modifyOtherKeys off, as a kitty terminal would). No key was found whose behaviour differs.
- Flags: pi pushes 7 to the real terminal, hunk asked for 5. The extra bit is event types: pi-tui
  drops release events before `handleInput` (`wantsKeyRelease` unset); repeats (`ESC[106;1:2u`)
  reach hunk and act as presses (probe: a repeat typed a character).
- End-to-end: `expect probe/interactive.exp kitty` answers pi's own `ESC[?u` with `ESC[?7u` and
  sends keys like a flags-7 terminal (plain text, `ESC[115;5u` Ctrl+S, `ESC[113;5u` Ctrl+Q,
  `ESC[27u`, release events). Passes. A one-off instrumented run (trace in `HunkSession`'s data
  handler, not committed) showed for all 3 overlays: `kitty:true`, query answered, hunk emitted
  `ESC[>5u` + `ESC[>4;0m`; the legacy e2e run showed `kitty:false`, no push, `ESC[>4;1m`.

### j.5 Input and mouse

- `handleInput(data)` → pty stdin, raw, no parsing. Only exception: **Ctrl+Q** (legacy or CSI-u,
  via `matchesKey`) is the host force-cancel (kills hunk, discards notes). Ctrl+C belongs to hunk,
  which quits normally with notes.
- SGR mouse: overlay writes `ESC[?1000h ESC[?1002h ESC[?1006h` to pi's terminal on open and the
  reverse on close. The overlay sits at (0,0) full-screen, so terminal coordinates are hunk's pty
  coordinates and SGR bytes pass through unchanged. Byte-level proof: wheel-down reports scroll
  hunk (probe). Delta: `?1003` (any-motion) is not enabled on pi's terminal although hunk asks for
  it; hover effects are lost, event floods avoided. Mouse through the whole pi stack is not
  covered by the expect test (pi forwarding SGR bytes to `handleInput` is the prior-round fact).

### j.6 Resize

`render(width)` reads `tui.terminal.rows` and calls `session.resize(width, rows)`: VT resize, then
synchronous `stty -f <tty>` (one-second timeout). No pending subprocess can apply an older size
after a newer one or after disposal. Lookup/ioctl failures restore the prior VT size and return
false, leaving the size retryable rather than caching false success. The path is reread each
resize. Unlike v1, height follows the terminal too.

ponytail: a synchronous subprocess briefly blocks pi on resize; use native ioctl if profiling
shows this matters. It narrows, but cannot eliminate, the tty-path reuse race (j.10).

### j.7 Exit and teardown

- hunk exits (`q`/Ctrl+C) → script exits → output pipes close → `onExit(code)` → overlay reads notes + last screen
  text → `close()`: mouse off, `session.dispose()`, `done(result)` exactly once.
- `session.dispose()` is idempotent: kill script if alive (hunk gets SIGHUP), destroy stdin (cat
  exits), dispose the VT, `rm -rf` the session dir (tty file, notes file, tool-path patch file).
  Probe: capture the actual descendant PIDs (script/bash/cat/hunk), then require all to disappear,
  including zombies, after disposal and host SIGKILL. `onExit` is not delivered after dispose;
  repeated disposal and rendering after disposal are safe. Constructor failures free VT/temp files.
- `dispose()` from pi tears down without `done()`, as before.
- Tool path writes the computed patch to `<sessiondir>/<title>.diff` (`PR #1` → `PR_#1.diff`), so
  hunk's title reads "Patch review: PR_#1.diff". Command path passes the user's file as-is.

### j.8 Deltas from the requested v2 design

1. pty = `script(1)` behind a bash process substitution (socket stdin), not a bare `script` spawn.
2. No render poll; push-based.
3. Handshake answered with `ESC[?0u`; proven effect is on hunk's mode/modifyOtherKeys, not on key
   decoding (OpenTUI decodes CSI-u regardless).
4. Notes via a hunk extension, the "last resort" candidate: the session CLI fails
   (`protocol-validation-failed`) and could only ever be a racy poll.
5. Mouse modes 1000/1002/1006 only (no 1003).
6. Cursor drawn as an inverse cell.
7. macOS only.

### j.9 Ceilings and unverified

- UNVERIFIED: the tool path during a live model turn. `probe/wiring.ts` now exercises the actual
  registered tool, argument vectors, results, and shared overlay with a mocked outer pi context;
  the command's real pi UI remains covered in both keyboard modes.
- UNVERIFIED: a manual run in a real kitty-protocol terminal (Ghostty). The e2e simulates one.
- hunk's own dialogs (e.g. the save-view-preferences prompt on quit after layout changes) appear
  as they would standalone; they are hunk's UI, not handled by the extension.
- `hunk session …` agents can still target the embedded session (it registers with the daemon
  like any hunk window).
- Snapshot + serialize runs per render (3000 cells at 100×30); fine so far, cache on a dirty flag
  if a profiler says otherwise.

### j.10 Correctness review (from 29f7b01)

Fixed and reproduced before editing: fragmented/repeated kitty queries; fragmented cursor
visibility; absent cursor on blank cells; failed stty cached as success; malformed notes silently
returned as `[]` (or `null` breaking exit cleanup). Also drain output before delivering exit,
clean up failed constructors, and atomically replace note mirrors. Probes cover native-binding,
script and hunk startup failures, final buffered diagnostics, a 1 MiB output burst, wide/combining
cells, note create/edit/draft/delete-last, mouse symmetry, cancel with saved notes, and dispose
without completion. Real hunk still decodes CSI-u text and Ctrl+S without the kitty handshake;
kitty repeat events still act as presses.

Minimality pass removes unused `hunkBin`, `alive`, and the `formatNotes` export, the redundant
disposed flag and tty cache, per-row serializer bookkeeping, duplicate git-diff branches, and
repeated tool-result envelopes. No extra dependency, transport, or generic terminal parser.

The old orphan test used invalid patch text, never proved hunk was alive, and searched command
strings (missing bare cat and zombies). It now waits for real hunk UI and tracks descendant PIDs.
The interactive test now fails on timeout/nonzero/signal exit instead of printing
`E2E_OK_NO_CLEAN_EXIT`. All four required checks passed before and after the retained changes.

Known limits / residual risks (not hidden by the checks):
- The native snapshot does not expose reverse-video attributes. Direct feed of
  `ESC[7mX ESC[0mY` yields identical unstyled X/Y cells. Fixing arbitrary SGR 7 rendering needs
  an upstream binding change; do not add a second terminal parser here. Explicit cursor inversion
  is handled locally. Other attributes absent from `SnapshotCell` have the same ceiling.
- A standalone ZWJ emoji probe (`👩‍💻`, default VT modes) yields two width-2 cells. Pi's width
  calculation can disagree with Ghostty; outer truncation/padding prevents overflow but cannot
  promise identical interior columns for every grapheme. No custom Unicode-width engine added.
- Between reading the tty path and stty opening it, hunk could exit and the device could be
  reused. Synchronous stty removes the async backlog window, not this cross-process TOCTOU.
  No wrong-device resize reproduced. Fully solving it needs a stronger pty handle/transport.
- EOF's `kill $$` still has the documented PID-reuse window. Real normal/dispose/SIGKILL process
  trees are reaped in probes; no evidence justifies replacing the working script transport.

## j.11 agent notes in (sidecar seeding)

Tool `hunk_review` takes optional `notes: [{file, line, side?, summary, rationale?, markup?}]`.
HunkSession maps them to hunk's `--agent-context` sidecar, schema per hunk
examples/3-agent-review-demo/agent-context.json: version 1, files[].path,
annotations[].newRange or oldRange as [line, line], summary (required), rationale?, markup?,
author "agent". Both new-side and old-side annotations render (probe asserts each).
`--agent-notes` rides along so they are visible on open; `--experimental` is added only when
a note carries markup, since plain summary/rationale render without it.

Patch mode stays: live comment add through the daemon remains unavailable (j.3), so seeding at
launch is the supported direction. Replies to agent notes are user notes anchored to the same
line and come back like any other user note. The tool description documents the return shape
{file, hunk (1-based), lines (new-side range), text} and the reply behavior.

## j.12 review cwd knob

`hunk_review` takes optional `cwd`: the directory whose git repo to diff (relative paths
resolve against the session cwd). Validated to exist, then used as the working directory for
`git diff` and `gh pr diff` — both resolve the repo from cwd — and as the hunk session cwd,
so file-relative hunk features like `e` (edit selected file) see the reviewed repo. Default
remains the pi session cwd. One knob instead of a `--repo` flag for gh, because it also
covers git diff and the session context; wiring.ts proves the knob with real git failing in a
non-repo cwd.

## j.13 non-blocking reviews (registry + hunk_notes)

hunk_review no longer waits for hunk: openReview registers the review (id hunk-N) and returns
immediately; the overlay keeps running under pi independent of the tool call. hunk_notes({id})
is the collector: while the review is open it returns a live status with the notes saved so far
(read straight from notes.json, which the pi-notes hunk extension writes on every save), and
once hunk quits it returns the final outcome - formatted notes, cancelled, or the failure text.
Finished sessions are consumed on read; unclosed open entries and finished ones trim at 20.

The command path is non-blocking too and auto-delivers on exit (notes as a user message,
followUp when the agent is busy), so both entry points share the registry and one exit path.
Spawn failures and corrupt notes land in the registry entry instead of throwing from the tool
and surface through hunk_notes or the command notify.
