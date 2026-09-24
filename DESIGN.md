# pi-hunk-island — design decisions

> **Current design: section j (v2, real hunk TUI in a pty).** Sections a–i and the handoff are
> the v1 (opentui-island) history; that implementation and its probes are removed.

Prototype: `/hunk-review <diff-file>` opens a full-screen pi overlay. The overlay hosts a
`hunkdiff/opentui` diff view. `opentui-island` renders that view in a Bun sidecar and streams
frames back. The user attaches notes to hunks. When the overlay closes, the notes go to the
agent as a user message.

Evidence lives in `probe/` and was captured on macOS arm64 with node v26.9.0, bun 1.4.2, and
pi 0.87.1:

| File | What it proves |
|---|---|
| `probe/run.mjs` → `probe/output.txt` | Main headless probe. Drives the real `opentui-island/pi-tui` surface: render, keys, notes, submit, cancel, resize, failure paths. |
| `probe/resolve.ts` | Prints which `@opentui/*`/`react` copy each importer resolves (run by `run.mjs`). |
| `probe/pi-smoke.ts` → `probe/pi-smoke-output.txt` | The same island renders inside pi's own jiti runtime, with no local `@mariozechner/pi-tui`. |
| `probe/skew-counterprobe.sh` → `probe/skew-output.txt` | Counter-probe: two OpenTUI versions in one sidecar crash (see a). |

Reproduce the main probe with `npm install && node probe/run.mjs`.

---

## a. Dependency strategy for the @opentui skew

**Decision: use one OpenTUI tree, `@opentui/core` + `@opentui/react` pinned to exactly
`0.5.12`, and use npm `overrides` to force opentui-island's `^0.1.97` peer onto that copy.**
The sidecar, the island, and hunkdiff all load the same instance.

Verified `package.json` dependency block:

```json
"dependencies": {
  "@opentui/core": "0.5.12",
  "@opentui/react": "0.5.12",
  "@pierre/diffs": "1.3.5",
  "hunkdiff": "0.22.0",
  "opentui-island": "0.4.0",
  "react": "^19.2.4"
},
"overrides": {
  "opentui-island": { "@opentui/core": "$@opentui/core", "@opentui/react": "$@opentui/react" }
},
"devDependencies": {
  "@mariozechner/pi-tui": "npm:@earendil-works/pi-tui@^0.87.1"
}
```

Evidence:

- **Resolution** (`probe/output.txt`, top): the sidecar (`opentui-island/dist/sidecar`),
  `hunkdiff/opentui`, and `islands/*.tsx` all resolve `@opentui/core@0.5.12`,
  `@opentui/react@0.5.12`, and `react@19.3.0` from the same `node_modules/...` directories.
  `npm ls` shows every copy as `deduped`.
- **Sidecar renderer works on 0.5.12.** The 0.5.12 `@opentui/core/testing` still exports
  `createTestRenderer` with the fields the sidecar uses: `renderOnce`, `captureSpans`,
  `resize`, `mockMouse`, and `renderer.stdin`/`getCursorState`. The probe renders full
  styled frames (24-bit ANSI, syntax colours). The following all work: mount, `renderFrame`,
  `resize` (width 100→80), `sendKey`, bridge events, and `destroy`.
- **The overrides block is required.** Without it, `npm install` fails:
  `ERESOLVE unable to resolve dependency tree ... peer @opentui/core@"^0.1.97" from
  opentui-island@0.4.0`. This is verified with `--package-lock-only` on a copy without
  `overrides`.
- **Two instances are fatal.** The counter-probe keeps the island and sidecar on 0.1.97 and
  nests 0.5.12 under hunkdiff (hand-placed, because npm cannot nest peers). Mounting fails:
  `OpenTUI sidecar mount failed: Environment variable "OTUI_TREE_SITTER_WORKER_PATH" is
  already registered with different configuration.` The two cores cannot coexist in one Bun
  process. Separately, hunkdiff's hooks and contexts would not bind to a foreign reconciler.
  So opentui-island has to move up to 0.5.x; hunkdiff cannot move down to 0.1.x.
- **`@mariozechner/pi-tui`.** `opentui-island/pi-tui` imports `truncateToWidth` from
  `@mariozechner/pi-tui` at runtime. Under pi 0.87.1 this resolves without any install:
  pi's extension loader aliases `@mariozechner/pi-tui` to its bundled `@earendil-works/pi-tui`
  (`dist/core/extensions/loader.js` alias map and `virtual-modules.js`). termdraw relies on
  the same alias; its `overlay.ts` imports `opentui-island/pi-tui` directly with no shim.
  `probe/pi-smoke-output.txt` verifies this with `node_modules/@mariozechner` moved aside:
  the island rendered under `pi -e`. The devDependency alias exists only so the plain-Node
  probe can import the adapter.
- **Bun:** `>=1.3.10` (opentui-island `engines`). 1.4.2 works.

Not verified, and unused by the prototype:
- `sendMouse`/`mockMouse` on 0.5.12 (we use keyboard only).
- `kittyKeyboard`/`otherModifiersMode`.
- Linux/Windows native `@opentui/core-*` binaries.

If opentui-island ships a 0.5-compatible release, drop `overrides`.

## b. Island module interface

- **File:** `islands/hunk-review.island.tsx`. Default export `HunkReviewIsland`. It starts with
  `/** @jsxImportSource @opentui/react */`. Bun transpiles it, so there is no build step.
- **Props (JSON only; they cross the stdio protocol):**
  `{ patch: string; title?: string }`. `patch` is the raw unified diff text. `title` is shown
  in the header (use the file basename).
- **Bridge events (island → host):**
  - `submit` `{ notes: ReviewNote[] }` on Ctrl+S (may be empty).
  - `cancel` `{ reason: "user" }` on Esc when no note is being composed.
- **No `ready` event (decision, from evidence).** The island first emitted `ready` from a
  mount effect, but the host never received it (`ready event: undefined` in probe v1). The
  event is written during `mount`, before `createPiTuiSurface()` resolves and the host can
  call `onEvent`. Treat the resolution of `await createPiTuiSurface(...)` (plus `sync`) as
  "ready"; `surface.ready === true` then. termdraw's `ready` handling has the same race.
- **Host → island commands:** none.
- **Keys, all owned by the island:**
  - `j`/`k`/`↑`/`↓`: scroll 1 line
  - `PgDn`/`Space`/`PgUp`: scroll a page
  - `n`/`p`: select next/previous hunk
  - `Tab`/`Shift+Tab`/`]`/`[`: next/previous file
  - `c`: compose a note on the selected hunk (`<input>`; Enter adds it, Esc discards it)
  - `Ctrl+S`: submit
  - `Esc`: cancel
- **Keys owned by the host overlay:** `Ctrl+C`/`Ctrl+Q` cancel without asking the island.

`ReviewNote` (exported type in the island file):

```ts
type ReviewNote = { file: string; hunk: number; lines: string; text: string };
// e.g. { file: "src/math.ts", hunk: 1, lines: "21-26", text: "VERSION bump should be minor?" }
```

- `hunk` is 0-based.
- `lines` is the hunk's new-side range: `additionStart` to `additionStart + additionCount - 1`.
- For deleted files the range is `0-0`. That is acceptable for the prototype.

**Note format returned on close.** The extension formats it and sends it as a user message:

```
Review notes on <title> (2):

- `src/math.ts` hunk 2 (new lines 21-26): VERSION bump should be minor?
- `README.md` hunk 1 (new lines 1-5): doc ok
```

Hunk numbers are shown 1-based to match the island header.

## c. Note/comment capture

The installed `hunkdiff@0.22.0` exposes these `hunkdiff/opentui` `.d.ts` exports:
- **Components:** `HunkDiffView`, `HunkDiffBody`, `HunkDiffFileHeader`, `HunkReviewStream`,
  `HunkFileNav`
- **Model helpers:** `createHunkDiffFile`, `createHunkDiffFilesFromPatch`,
  `countHunkDiffStats`, `parseDiffFromFile`, `parsePatchFiles`
- **Themes:** `HUNK_DIFF_THEME_NAMES`

**None of them has a comment, annotation, or line-click callback.** The only callbacks are
`HunkDiffFileHeader.onSelect()`, `HunkReviewStream.onSelectionChange({fileId, hunkIndex})`,
and `HunkFileNav.onSelectFile(fileId)`. Row models are not exported.

**Decision (explicit fallback): the island owns hunk-level selection and note entry.**
- Selection is island state `(fileIndex, hunkIndex)`, rendered through
  `HunkDiffView selectedHunkIndex={hunk}` (hunk draws the highlight).
- Note text comes from a plain OpenTUI `<input>` in the island's footer row.
- Notes accumulate in island state and leave once, in the `submit` payload.
- Granularity is hunk plus new-side line range, not individual lines. That is enough to
  demonstrate the loop. The probe drives it end to end with raw input (`n`, `c`, text, `\r`,
  `\t`, `c`, text, `\r`, `\x13`) and receives both notes in `submit`.

Other implementation choices:
- **One file at a time:** `HunkDiffView scrollable={false}` inside the island's own
  `<scrollbox ref>`. HunkDiffView's built-in scrollbox is hard-coded `focused:false` and has
  no ref, so it cannot be scrolled by key. The island calls `scrollBy`/`scrollTop` itself.
- **Layout:** `canonicalLayout` is `split` when the width is at least 140 columns, otherwise
  `unified`.
- **Language (pitfall found):** `createHunkDiffFilesFromPatch` leaves `language` undefined,
  so hunk highlights everything as `text`. The island fills it in with
  `getFiletypeFromFileName(path)` from `@pierre/diffs`. The probe then shows 8 distinct
  colours on a code line instead of 4.
- **Known ceiling (`ponytail:` comment in the island):** `n`/`p` move the highlight but do
  not scroll to the hunk, because hunk row offsets are not exported. The upgrade is
  `HunkReviewStream` plus the hunk index → row mapping, or line-level anchors if hunkdiff
  exports them.

## d. Diff input and command UX

- **Command:** `/hunk-review <diff-file>`, a single required path argument. Produce the diff
  first:
  - `gh pr diff 123 > /tmp/pr.diff`
  - `git diff main...HEAD > /tmp/branch.diff`
- **Reading the file:**
  - Resolve the path with `path.resolve(ctx.cwd, arg.trim())`.
  - Read it with `fs.promises.readFile(p, "utf8")` in the extension (Node side).
  - A missing argument, a read error, or an empty file triggers `ctx.ui.notify(..., "error")`
    and returns before any overlay opens.
- **Passing it to the island:** as the `patch` prop, text rather than a path. That avoids
  sidecar cwd and permission questions, and the island parses it with
  `createHunkDiffFilesFromPatch`. The props travel as one JSON line over the sidecar's stdio.
  That is fine for PR-sized diffs, but it has not been measured for multi-MB diffs. If that
  matters, pass the path instead.
- **No-files diff:** the island shows "No files in diff … Esc closes."
- **Guard:** run only when `ctx.mode === "tui"`, since custom components are TUI-only.
  Otherwise notify and return.

## e. Extension wiring

This follows the termdraw `overlay.ts` structure, with the fixes the probes showed are needed.

1. **Overlay factory:**

   ```ts
   ctx.ui.custom<Result>((tui, theme, _kb, done) => new HunkReviewOverlay(tui, theme, patch, title, done),
     { overlay: true, overlayOptions: { row: 0, col: 0, width: "100%", maxHeight: "100%", margin: 0 } })
   ```

   `Result` is `{ kind: "submit"; notes: ReviewNote[] } | { kind: "cancel" }`.
2. **Surface creation:** happens in an async `initialize()` called from the constructor.

   ```ts
   createPiTuiSurface({ height, initialWidth: width, requestRender: () => tui.requestRender(),
     island: { module: new URL("../islands/hunk-review.island.tsx", import.meta.url), props: { patch, title } } })
   ```

   - `width` is `tui.terminal.columns` and `height` is `tui.terminal.rows`. The island draws
     its own header and footer, so no host footer row is needed.
   - After creation: `surface.onEvent(...)`, `surface.focused = true`, and
     `await surface.sync(width)`.
   - Measured startup is about 180–220 ms warm. The client startup timeout defaults to 5 s.
3. **Input forwarding:**
   - `ctrl+c`/`ctrl+q` (`matchesKey`): `close({kind: "cancel"})`.
   - When an error is showing, `escape` also closes.
   - Otherwise call `this.surface?.sendInput(data).catch(this.fail)`. **Do not use
     `surface.handleInput(data)`.** It does `void this.sendInput(data)` with no catch. After a
     sidecar death that becomes an unhandled rejection (probe:
     `surface.handleInput("j") -> unhandledRejection: ["OpenTUI sidecar has already been
     closed."]`). pi 0.87.1 installs no `unhandledRejection` handler (grep of `dist/`), so
     Node's default would crash pi.
   - No mouse: don't enable SGR mouse mode (YAGNI; `sendMouse` is unverified on 0.5.12).
4. **Render:**
   - `render(width)` returns `surface.render(width)` once the surface exists.
   - Width changes are handled by the surface, which re-syncs at the new width (probe: 100→80).
   - Before the surface exists, render a loading line padded to `height`. On error, render
     the error lines.
   - Pad and truncate host lines with `truncateToWidth`/`visibleWidth`, as termdraw's
     `padLine` does.
5. **Async repaint (pitfall found):** frames are pull-based. The sidecar only renders on
   `sync`, which runs after input or a width change. Async island updates are invisible until
   the next keypress; the probe showed syntax highlight arriving after the first frame
   (4 → 8 colours with no input).
   - Run `setInterval(() => this.surface?.sync().catch(this.fail), 500)` while the overlay is
     open.
   - `applyFrame` calls `requestRender` only when lines changed, so this is cheap.
   - The interval also detects a sidecar crash without any input.
   - `// ponytail: 500ms poll; push-based frames if opentui-island adds them.`
6. **Resize:** width is handled (point 4). **Height is fixed when the overlay opens.**
   `PiTuiOpenTuiSurface` takes `height` in its constructor and exposes no height setter.
   UNVERIFIED: what pi does when the terminal shrinks below the captured row count. Check by
   opening `/hunk-review`, shrinking the terminal, and watching for clipping or scroll
   artefacts. If it is bad, recreate the surface when `tui.terminal.rows` changes.
7. **Teardown:** `close(result)` must be idempotent (`closing` flag). It:
   - clears the interval
   - unsubscribes from events
   - runs `await surface?.destroy().catch(() => {})`
   - calls `done(result)`

   Also implement `dispose()`, which pi calls for custom components, to do the same cleanup
   without calling `done`. If pi exits, the sidecar's stdin closes and `server.js` exits on
   stdin `end`.
8. **Error surface.** `fail(e)` sets `this.error` and calls `requestRender`. The overlay then
   shows the error, a hint ("Needs Bun >= 1.3.10 on PATH (or OPENTUI_ISLAND_BUN)"), and
   "Esc closes". Exact messages from the probe:
   - Bun missing: `Failed to start the OpenTUI sidecar because '<bun>' was not found. Install
     Bun or pass 'bunCommand'.`
   - Bad island path: `OpenTUI sidecar mount failed: Cannot find module '<path>' ...`
   - Sidecar died:
     - `OpenTUI sidecar has already been closed.` after the fact
     - `OpenTUI sidecar exited unexpectedly while waiting for <method> (code=…, signal=…).`
       plus the stderr tail, if a request was in flight
9. **Result delivery** in the command handler, after `await ctx.ui.custom(...)`:
   - `cancel` → `ctx.ui.notify("Review cancelled.", "info")`
   - `submit` with 0 notes → `notify("No review notes.")`
   - `submit` with notes → `pi.sendUserMessage(formatNotes(title, notes), ctx.isIdle() ?
     undefined : { deliverAs: "followUp" })`. This starts or queues an agent turn with the
     notes (format in b).
   - `pasteToEditor` (termdraw's choice) would be an alternative if the user wanted to edit
     the notes first. That is out of scope: the goal says the notes return to the agent.

## f. Repo / package shape

```
package.json              pi.extensions: ["./extensions/index.ts"]  (explicit file, see pitfall)
extensions/index.ts       TO BE WRITTEN: command + overlay component (single file)
islands/hunk-review.island.tsx   done (used by the probe)
probe/                    evidence; not shipped (`files` omits it)
```

- **Local use:**
  - `npm install` in this directory (it must be npm, or another tool that honours
    `overrides`).
  - Then `pi install ./path/to/pi-hunk-island`, or a one-off `pi -e ./extensions/index.ts`.
  - pi loads local paths in place and does **not** install their dependencies.
- **Git source:** pi installs dependencies for git sources. UNVERIFIED: that pi's git install
  runs npm and honours `overrides`. Check with `pi install git:<repo>`, then
  `npm ls @opentui/core` in the checkout (expect a single `0.5.12`).
- **Pi packages:**
  - `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are optional
    `peerDependencies` (`*`), per pi's packages doc.
  - Never add `@earendil-works/pi-tui` as a runtime dependency; pi supplies it.
- **Manifest points at the file:** `pi.extensions` names `./extensions/index.ts` rather than
  the directory, so a helper `.ts` placed in `extensions/` is not auto-loaded as a second
  extension.

---

## g. Agent-driven review (added after the handoff)

The agent in the session picks the review arguments; the user does the reviewing; the notes
come back to the model. `extensions/index.ts` registers a tool alongside the command:

- `hunk_review` — parameters: `pr` (GitHub PR number, `gh pr diff <n>`), or `base` (+ optional
  `ref`, default HEAD, `git diff <base>...<ref>`), or neither (working tree vs HEAD). Optional
  `paths` pathspec (git only). Exactly one of pr/base.
- Execute guards `ctx.mode === "tui"`, computes the diff with `execFile` in `ctx.cwd`
  (64 MB maxBuffer), and opens the same overlay. Empty diff returns "No changes to review"
  without opening anything.
- Result is the tool result, not a user message: submit → `formatNotes` output; cancel →
  "User cancelled the review."; zero notes → formatNotes with count 0. The turn continues with
  the notes in context.
- UNVERIFIED (needs a real terminal): that pi renders the overlay while a tool is executing,
  and that Ctrl+S/Esc reach the island in that state. The overlay itself is identical to the
  command path, so the open questions in the handoff list cover both.

## h. Post-handoff fixes (first live use)

- **Layout:** split panels padded short lines into dead space and unwrapped prose overflowed
  both panels (markdown diffs were unreadable). The island now renders
  `canonicalLayout="unified"` with `wrapLines={true}`.
- **Resize:** the overlay now mirrors termdraw: `setScreenBounds` on every render plus a
  `sync(width)` when pi's render width changes, so the island re-renders at the new width
  instead of being padded/truncated.
- **Kitty terminals:** if pi negotiated the kitty keyboard protocol (Ghostty and friends),
  forwarded keys arrive CSI-u encoded and the sidecar parser must be told. The overlay now
  passes `kittyKeyboard: isKittyProtocolActive()` from `@earendil-works/pi-tui`. Suspected
  cause of "nothing responds" on the first live try.
- **End-to-end verification:** `probe/interactive.exp` drives the real pi TUI in a pty
  (slave forced to raw mode — expect's default line-buffered discipline eats Enter) and
  asserts: overlay opens, `c` compose row appears, note lands (`notes 1`), Ctrl+Q cancels
  with "Review cancelled.". All pass. Ctrl+S through pi is still unverified end to end
  (it would start an agent turn); the island-side submit path is covered by `probe/run.mjs`.

## i. Mouse and hunk keymap (second live-use round)

- **Mouse:** the overlay now enables SGR mouse mode while open and attaches
  `attachPiTuiMouseSupport(tui, surface)`; events inside the surface bounds are translated
  to island coordinates and consumed, and both are torn down on close. Wheel scrolling
  verified headlessly: `surface.sendMouse({type:"scroll",direction:"down",…})` changes the
  rendered frame (`probe/run.mjs`). `HunkDiffView` rows carry `onMouseUp`/`onMouseMove`
  handlers, so clicks inside the diff reach hunkdiff's row actions; what those do inside the
  island is unverified.
- **Keymap:** island keys now mirror hunk's review-surface defaults
  (`docs/keybindings.md`) wherever the island has the concept: `]`/`[` hunk stepping,
  `.`/`,` file stepping, `b`/`space`/`f` page, `u`/`d` half page, `g`/`G` ends, `q` quit.
  `c` (compose) and Ctrl+S (submit) remain island additions.
- **Ceiling, restated:** hunk's sidebar, menus (F10), note E/R/D actions, search, filter,
  and session store are the CLI app shell, not exported by `hunkdiff/opentui`. The island
  can never be the full hunk TUI. Full parity in-overlay means embedding the real hunk
  process (pty + terminal emulation inside the overlay), or hunk upstream exporting an
  embeddable app shell. The handoff-style TTY swap (pi-hunk) remains the zero-build path.

## Handoff to implementer

**Create exactly one file: `extensions/index.ts`.** The `package.json` manifest already points
at it (`"pi": { "extensions": ["./extensions/index.ts"] }`). Do not touch the dependency block.

Contents of `extensions/index.ts`:
- `export default function (pi: ExtensionAPI)` registering `hunk-review` (description "Review a
  unified diff file with hunk"). The handler does the following:
  - checks `ctx.mode === "tui"`
  - resolves and reads the file (section d)
  - awaits `ctx.ui.custom` (section e.1)
  - delivers the result (section e.9)
- `class HunkReviewOverlay implements Component`, modelled on termdraw's `TermDrawOverlay`
  (`~/.pi/agent/npm/node_modules/@termdraw/pi/extensions/overlay.ts`), with the deltas below.
- `formatNotes(title, notes)`, producing the format in section b.
- Imports:
  - `@earendil-works/pi-coding-agent` (types)
  - `@earendil-works/pi-tui` (`matchesKey`, `truncateToWidth`, `visibleWidth`, types)
  - `opentui-island/pi-tui` (`createPiTuiSurface`, `PiTuiSurface`)
  - `opentui-island` (`OpenTuiBridgeEvent` type)
  - `node:fs/promises` and `node:path`
  - Import the `ReviewNote` type with `import type` from `../islands/hunk-review.island.tsx`,
    or redeclare it. A value import would pull React/OpenTUI into pi's process.

Pitfalls, all backed by the probes above:

1. **Keep `overrides` and the exact `0.5.12` pins.** Removing `overrides` gives ERESOLVE.
   Letting opentui-island keep 0.1.x crashes the sidecar at mount with the
   `OTUI_TREE_SITTER_WORKER_PATH` error.
2. **Use `surface.sendInput(data).catch(fail)`, not `surface.handleInput(data)`.** The latter
   leaks an unhandled rejection after a sidecar crash, and pi has no handler for it.
3. **Don't wait for a `ready` bridge event.** It is emitted before you can subscribe.
   `await createPiTuiSurface()` plus `await surface.sync(width)` is "ready".
4. **Poll `surface.sync()` every 500 ms while open.** Frames are pull-based, and async
   highlight results otherwise stay invisible until the next key.
5. **Surface height is fixed at construction.** Pass `tui.terminal.rows` and return exactly
   that many lines from `render()` in every state (loading, error, live).
6. **Island props must be JSON.** Pass the diff text, not objects or URLs. The island
   module URL must be absolute: `new URL("../islands/hunk-review.island.tsx",
   import.meta.url)`, as termdraw does.
7. **Never spawn the sidecar in the extension factory.** Only do it in the command handler,
   because extensions also load for `--list-models` and print mode.
8. **Make `close()` idempotent,** since `submit`, `Ctrl+Q`, and `dispose()` can race. Swallow
   `destroy()` errors after a crash. Always call `done()` exactly once.
9. **Smoke-test the load** with `pi -e ./extensions/index.ts --list-models` (it should load
   without errors). The overlay itself can only be verified interactively. UNVERIFIED:
   - the real overlay paint
   - Ctrl+S passing through pi to the island
   - Esc not being consumed by pi before `handleInput`

   To check, run `/hunk-review probe/sample.diff`, then press `n c`, type text, press Enter,
   then Ctrl+S. Expect a user message listing one note.

---

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
