# pi-hunk-island — design decisions

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
