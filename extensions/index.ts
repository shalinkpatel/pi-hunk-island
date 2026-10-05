import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  isKittyProtocolActive,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { HunkSession, type AgentNote, type HunkSessionOptions, type ReviewNote } from "./hunk-pty.ts";

type Source = Omit<HunkSessionOptions, "cwd" | "cols" | "rows" | "kitty" | "onUpdate" | "onExit">;
type OverlayResult =
  | { kind: "exit"; code: number | null; notes: ReviewNote[]; screen: string }
  | { kind: "cancel" }
  | { kind: "error"; message: string };

// Buttons + drag, SGR encoding. The overlay covers the terminal from (1,1), so the reported
// coordinates are already hunk's pty coordinates: bytes pass through untouched.
const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

function padLine(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "", true);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function formatNotes(title: string, notes: ReviewNote[]): string {
  const lines = [`Review notes on ${title} (${notes.length}):`];
  if (notes.length === 0) lines.push("none");
  for (const note of notes) {
    lines.push(`- \`${note.file}\` hunk ${note.hunk + 1} (${note.lines}): ${note.text.replace(/\n/g, "\n  ")}`);
  }
  return lines.join("\n");
}

/** Non-null when hunk exited abnormally without leaving notes. */
function exitError(result: OverlayResult & { kind: "exit" }): string | null {
  if (result.code === 0 || result.notes.length > 0) return null;
  return `hunk exited with code ${result.code}${result.screen ? `: ${result.screen}` : ""}`;
}

function runCapture(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", failed: !!error });
    });
  });
}

/** Compute a unified diff. Returns [patch, title] or [null, error]. */
async function computePatch(
  cwd: string,
  args: { pr?: number; base?: string; ref?: string; paths?: string },
): Promise<[string, string] | [null, string]> {
  const paths = args.paths?.trim();
  const pathArgs = paths ? ["--", paths] : [];
  if (args.pr !== undefined) {
    const r = await runCapture("gh", ["pr", "diff", String(args.pr)], cwd);
    if (r.failed) return [null, `gh pr diff ${args.pr} failed: ${r.stderr.trim() || "unknown error"}`];
    return [r.stdout, `PR #${args.pr}`];
  }
  const range = args.base ? `${args.base}...${args.ref ?? "HEAD"}` : "HEAD";
  const r = await runCapture("git", ["diff", range, ...pathArgs], cwd);
  if (r.failed) return [null, `git diff ${range} failed: ${r.stderr.trim() || "unknown error"}`];
  return [r.stdout, args.base ? range : "working tree"];
}

/** Full-screen overlay showing the real hunk TUI (DESIGN.md j). */
class HunkReviewOverlay implements Component {
  readonly session: HunkSession;
  private closed = false;

  constructor(
    private readonly tui: TUI,
    cwd: string,
    source: Source,
    private readonly done: (value: OverlayResult) => void,
  ) {
    this.session = new HunkSession({
      cwd,
      cols: tui.terminal.columns,
      rows: tui.terminal.rows,
      kitty: isKittyProtocolActive(),
      ...source,
      // hunk output is push-based (pty data events); pi-tui coalesces render requests.
      onUpdate: () => tui.requestRender(),
      onExit: (code) => {
        let result: OverlayResult;
        try {
          const screen = this.session.text().map((l) => l.trim()).filter(Boolean).slice(-3).join(" ");
          result = { kind: "exit", code, notes: this.session.notes(), screen };
        } catch (error) {
          result = { kind: "error", message: formatError(error) };
        }
        this.close(result);
      },
    });
    tui.terminal.write(MOUSE_ON);
  }

  handleInput(data: string): void {
    // Host escape hatch; everything else (including Ctrl+C, hunk's own quit) goes to hunk raw.
    if (matchesKey(data, "ctrl+q")) {
      this.close({ kind: "cancel" });
      return;
    }
    this.session.write(data);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const w = Math.max(1, width);
    const rows = Math.max(1, this.tui.terminal.rows);
    this.session.resize(w, rows); // no-op unless pi's size changed
    const lines = this.session.lines();
    return Array.from({ length: rows }, (_, i) => padLine(lines[i] ?? "", w));
  }

  private teardown(): boolean {
    if (this.closed) return false;
    this.closed = true;
    this.tui.terminal.write(MOUSE_OFF);
    this.session.dispose();
    return true;
  }

  private close(result: OverlayResult): void {
    if (this.teardown()) this.done(result);
  }

  dispose(): void {
    this.close({ kind: "cancel" });
  }
}

function unsupported(): string | null {
    return process.platform === "darwin" || process.platform === "linux"
    ? null
    : "hunk review overlay needs macOS or Linux (script(1) pty, DESIGN.md j.1).";
}

/** One review, from open through collection. */
type ReviewEntry = {
  id: string;
  title: string;
  open: boolean;
  result?: OverlayResult;
  overlay?: HunkReviewOverlay;
};

const reviews = new Map<string, ReviewEntry>();
let reviewSeq = 0;

// Keep the latest 20 finished reviews readable; never evict an open review.
function trimReviews(): void {
  const finished = [...reviews.values()].filter((entry) => !entry.open);
  for (const entry of finished.slice(0, -20)) reviews.delete(entry.id);
}

/** Open the overlay and return its review id immediately; the caller never waits for hunk. */
function openReview(
  ctx: ExtensionContext,
  source: Source,
  repoDir: string,
  title: string,
  onExit?: (entry: ReviewEntry) => void,
): string {
  const entry: ReviewEntry = { id: "hunk-" + ++reviewSeq, title, open: true };
  reviews.set(entry.id, entry);
  trimReviews();
  void ctx.ui
    .custom<OverlayResult>(
      (tui, _theme, _keybindings, done) => {
        const overlay = new HunkReviewOverlay(tui, repoDir, source, (result) => {
          entry.open = false;
          entry.result = result;
          entry.overlay = undefined;
          reviews.delete(entry.id);
          reviews.set(entry.id, entry); // retention order is completion, not launch time
          trimReviews();
          done(result);
          onExit?.(entry);
        });
        entry.overlay = overlay;
        return overlay;
      },
      { overlay: true, overlayOptions: { row: 0, col: 0, width: "100%", maxHeight: "100%", margin: 0 } },
    )
    .catch((error: unknown) => {
      entry.open = false;
      entry.result = { kind: "error", message: formatError(error) };
      entry.overlay = undefined;
      reviews.delete(entry.id);
      reviews.set(entry.id, entry);
      trimReviews();
      onExit?.(entry);
    });
  return entry.id;
}

export default function (pi: ExtensionAPI) {
  // Human path: review a unified diff file that already exists.
  pi.registerCommand("hunk-review", {
    description: "Review a unified diff file with hunk (argument: path to .diff)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("hunk-review needs an interactive session.", "error");
        return;
      }
      const blocked = unsupported();
      if (blocked) {
        ctx.ui.notify(blocked, "error");
        return;
      }
      const arg = (args ?? "").trim();
      if (!arg) {
        ctx.ui.notify("Usage: /hunk-review <diff-file>", "error");
        return;
      }
      const file = path.resolve(ctx.cwd, arg);
      let patch: string;
      try {
        patch = await fs.readFile(file, "utf8");
      } catch (error) {
        ctx.ui.notify(`Could not read ${file}: ${formatError(error)}`, "error");
        return;
      }
      if (!patch.trim()) {
        ctx.ui.notify(`No diff content in ${file}.`, "error");
        return;
      }
      const title = path.basename(file);
      const id = openReview(ctx, { patchFile: file }, ctx.cwd, title, (entry) => {
        const result = entry.result;
        if (!result || result.kind === "cancel") {
          ctx.ui.notify("Review cancelled.", "info");
          return;
        }
        if (result.kind === "error") {
          ctx.ui.notify("hunk review failed: " + result.message, "error");
          return;
        }
        const failed = exitError(result);
        if (failed) {
          ctx.ui.notify(failed, "error");
          return;
        }
        if (result.notes.length === 0) {
          ctx.ui.notify("No review notes.", "info");
          return;
        }
        pi.sendUserMessage(
          formatNotes(entry.title, result.notes),
          ctx.isIdle() ? undefined : { deliverAs: "followUp" },
        );
      });
      ctx.ui.notify("Review " + id + " opened (" + title + "). Quit hunk (q) when done; notes go to the agent.", "info");
    },
  });

  // Agent path: the model chooses what to review; the user does the reviewing;
  // the notes come back as the tool result.
  pi.registerTool({
    name: "hunk_review",
    label: "Hunk review",
    description:
      "Open the real hunk diff review TUI in an overlay for the user. Returns immediately with a " +
      "review id; it does NOT wait for the review to finish. Modes: diff (default for base or " +
      "working tree) and show run hunk INSIDE the repository (cwd), so hunk session commands " +
      "(navigate, comment add, reload) work live from the shell mid-review; patch (default for " +
      "pr or a direct patch string) feeds a computed unified diff to hunk patch instead. Sources: " +
      "pr (GitHub PR number), base (+optional ref, default HEAD), or neither (working tree); " +
      "paths filters by pathspec. " +
      "Optional notes seed the review: they render beside the diff lines as agent annotations the user " +
      "sees on open and can reply to; replies and any other notes the user writes come back via hunk_notes. " +
      "After the user quits hunk (q), call hunk_notes with the returned id to collect their notes as " +
      "{file, hunk, lines, text}: hunk is the 1-based hunk index in that file, lines is the hunk's " +
      "side and line range. Ctrl+Q force-cancels and discards. " +
      "Interactive sessions only.",
    parameters: Type.Object({
      pr: Type.Optional(Type.Number({ description: "GitHub PR number to review (gh pr diff <n>)" })),
      base: Type.Optional(
        Type.String({ description: "Base ref; diff mode compares base to ref directly; patch mode uses base...ref (merge base). Exclusive with pr" }),
      ),
      ref: Type.Optional(Type.String({ description: "Head ref, default HEAD. Requires base, except in show mode" })),
      paths: Type.Optional(Type.String({ description: "Optional pathspec filter (git diff only)" })),
      mode: Type.Optional(
        Type.Union([Type.Literal("diff"), Type.Literal("patch"), Type.Literal("show")], {
          description: "Review mode: diff and show run in the repository (live session commands); patch feeds computed diff text",
        }),
      ),
      patch: Type.Optional(
        Type.String({ description: "Unified diff text to review directly (implies patch mode); exclusive with pr/base/ref/paths" }),
      ),
      title: Type.Optional(Type.String({ description: "Display title for the review" })),
      cwd: Type.Optional(
        Type.String({
          description: "Repository directory whose git repo to diff; git and gh resolve the repo from here. Default the session cwd; relative paths resolve against the session cwd.",
        }),
      ),
      notes: Type.Optional(
        Type.Array(
          Type.Object({
            file: Type.String({ description: "File path exactly as it appears in the diff" }),
            line: Type.Integer({ description: "Line number on the chosen side of the diff" }),
            side: Type.Optional(
              Type.Union([Type.Literal("new"), Type.Literal("old")], {
                description: "Which side of the diff the line is on; default new",
              }),
            ),
            summary: Type.String({ description: "Plain-text note body (always rendered)" }),
            rationale: Type.Optional(Type.String({ description: "Optional longer reasoning" })),
            markup: Type.Optional(
              Type.String({ description: "Optional STML markup; any markup present enables hunk --experimental" }),
            ),
          }),
          { description: "Agent notes to show beside the diff on open" },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
      if (ctx.mode !== "tui") return reply("hunk_review needs an interactive (tui) session.");
      const blocked = unsupported();
      if (blocked) return reply(blocked);
      if (params.pr !== undefined && params.base) return reply("Pass either pr or base, not both.");
      if (params.patch !== undefined && (params.pr !== undefined || params.base !== undefined || params.ref !== undefined || params.paths !== undefined)) {
        return reply("patch is exclusive: drop pr/base/ref/paths.");
      }
      if (params.patch !== undefined && params.mode !== undefined && params.mode !== "patch") return reply("patch requires patch mode.");
      const mode = params.mode ?? (params.patch !== undefined || params.pr !== undefined ? "patch" : "diff");
      if (mode === "show" && params.base !== undefined) return reply("show accepts ref, not base.");
      if (params.ref && !params.base && mode !== "show") return reply("ref requires base.");
      for (const ref of [params.base, params.ref]) {
        if (ref !== undefined && (!ref.trim() || ref.startsWith("-"))) return reply("Refs must be nonempty and must not start with '-'.");
      }
      let repoDir = ctx.cwd;
      if (params.cwd) {
        repoDir = path.resolve(ctx.cwd, params.cwd);
        if (!(await fs.stat(repoDir).catch(() => null))?.isDirectory()) {
          return reply(`cwd is not a directory: ${repoDir}`);
        }
      }
      if (mode !== "patch" && params.pr !== undefined) {
        return reply("pr reviews as a patch (no local refs); drop pr to review the repository with diff mode.");
      }
      let source: Source;
      let title: string;
      if (params.patch !== undefined) {
        if (!params.patch.trim()) return reply("No changes in the provided patch.");
        title = params.title ?? "patch";
        source = { patchText: params.patch, title, agentNotes: params.notes };
      } else if (mode === "patch") {
        const [patch, patchTitle] = await computePatch(repoDir, params);
        if (patch === null) return reply(patchTitle);
        if (!patch.trim()) return reply(`No changes to review (${patchTitle}).`);
        title = params.title ?? patchTitle;
        source = { patchText: patch, title: patchTitle, agentNotes: params.notes };
      } else if (mode === "show") {
        const ref = params.ref ?? "HEAD";
        const r = await runCapture("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], repoDir);
        if (r.failed) return reply(`git rev-parse ${ref} failed: ${r.stderr.trim() || "unknown error"}`);
        title = params.title ?? "show " + ref;
        source = { subcommand: "show", targets: [ref], paths: params.paths, agentNotes: params.notes };
      } else {
        const targets = params.base ? [params.base, params.ref ?? "HEAD"] : ["HEAD"];
        const r = await runCapture("git", ["diff", "--name-only", ...targets, ...(params.paths ? ["--", params.paths] : [])], repoDir);
        if (r.failed) return reply(`git diff ${targets.join(" ")} failed: ${r.stderr.trim() || "unknown error"}`);
        if (!r.stdout.trim()) return reply(`No changes to review (${params.base ? params.base + ".." + (params.ref ?? "HEAD") : "working tree"}).`);
        title = params.title ?? (params.base ? params.base + ".." + (params.ref ?? "HEAD") : "working tree");
        source = { subcommand: "diff", targets, paths: params.paths, agentNotes: params.notes };
      }
      const id = openReview(ctx, source, repoDir, title);
      const live = mode === "diff" || mode === "show" ? " The review runs in the repository: hunk session commands (navigate, comment add) work live from the shell. Use hunk session list --json for its UUID (not this hunk-N id)." : "";
      return reply(
        "Review " + id + " opened (" + title + "). Ask the user to review in the overlay and quit hunk (q) " +
        "when done, then call hunk_notes with id " + id + "." + live + " Ctrl+Q force-cancels and discards.",
      );
    },
  });

  // Collector: fetch (or poll) the outcome of a review hunk_review opened.
  pi.registerTool({
    name: "hunk_notes",
    label: "Hunk notes",
    description:
      "Collect the outcome of a hunk review session opened by hunk_review; pass the id it returned. " +
      "While the review is still open, returns a live status with the notes saved so far. " +
      "After the user quits hunk, returns their notes as {file, hunk, lines, text} (hunk 1-based, lines " +
      "the side and line range), or that they saved none, force-cancelled, or the review failed. Finished " +
      "sessions stay readable (latest 20): repeated reads return the same outcome, and a read can never eat a " +
      "result racing the quit.",
    parameters: Type.Object({
      id: Type.String({ description: "Session id returned by hunk_review" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
      const entry = reviews.get(params.id);
      if (!entry) {
        const known = [...reviews].map(([id, e]) => id + (e.open ? " (open)" : ""));
        return reply(
          "No review session " + params.id + ". Unknown or expired id (only the last 20 finished reviews are retained; pi restart resets ids)." +
            (known.length ? " Known: " + known.join(", ") + "." : ""),
        );
      }
      if (entry.open) {
        let soFar = 0;
        try {
          soFar = entry.overlay?.session.notes().length ?? 0;
        } catch {
          // corrupt mid-write reads just report the open state
        }
        return reply(
          "Review " + entry.id + " (" + entry.title + ") is still open; " + soFar +
            " note(s) saved so far. Ask the user to quit hunk (q) when done, then call again.",
        );
      }
      const result = entry.result;
      if (!result || result.kind === "cancel") return reply("User force-cancelled the review (Ctrl+Q); notes were discarded.");
      if (result.kind === "error") return reply("hunk review failed: " + result.message);
      const failed = exitError(result);
      if (failed) return reply(failed);
      if (result.notes.length === 0) return reply("User quit hunk on " + entry.title + " without saving any notes.");
      return reply(formatNotes(entry.title, result.notes));
    },
  });
}
