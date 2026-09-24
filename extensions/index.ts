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
import { HunkSession, type ReviewNote } from "./hunk-pty.ts";

type Source = { patchFile: string } | { patchText: string; title: string };
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
  private readonly session: HunkSession;
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
    this.teardown();
  }
}

function unsupported(): string | null {
  return process.platform === "darwin" ? null : "hunk review overlay needs macOS (script(1) pty, DESIGN.md j.1).";
}

async function openReview(ctx: ExtensionContext, source: Source) {
  const result = await ctx.ui.custom<OverlayResult>(
    (tui, _theme, _keybindings, done) => new HunkReviewOverlay(tui, ctx.cwd, source, done),
    {
      overlay: true,
      overlayOptions: { row: 0, col: 0, width: "100%", maxHeight: "100%", margin: 0 },
    },
  );
  if (result?.kind === "error") throw new Error(result.message);
  return result;
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
      const result = await openReview(ctx, { patchFile: file });
      if (!result || result.kind === "cancel") {
        ctx.ui.notify("Review cancelled.", "info");
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
        formatNotes(title, result.notes),
        ctx.isIdle() ? undefined : { deliverAs: "followUp" },
      );
    },
  });

  // Agent path: the model chooses what to review; the user does the reviewing;
  // the notes come back as the tool result.
  pi.registerTool({
    name: "hunk_review",
    label: "Hunk review",
    description:
      "Open the real hunk diff review TUI in an overlay for the user and wait for their notes. " +
      "Use when the user wants to review changes and leave comments. Picks the diff source from args: " +
      "pr (GitHub PR number), base (+optional ref, default HEAD) for git diff base...ref, " +
      "or neither for working-tree changes vs HEAD. Optionally paths filters by pathspec. " +
      "Returns the user's hunk notes (file, hunk, line range, text) when they quit hunk, or that they cancelled. " +
      "Interactive sessions only.",
    parameters: Type.Object({
      pr: Type.Optional(Type.Number({ description: "GitHub PR number to review (gh pr diff <n>)" })),
      base: Type.Optional(
        Type.String({ description: "Base ref; reviews git diff <base>...<ref>. Mutually exclusive with pr" }),
      ),
      ref: Type.Optional(Type.String({ description: "Head ref, default HEAD. Requires base" })),
      paths: Type.Optional(Type.String({ description: "Optional pathspec filter (git diff only)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
      if (ctx.mode !== "tui") return reply("hunk_review needs an interactive (tui) session.");
      const blocked = unsupported();
      if (blocked) return reply(blocked);
      if (params.pr !== undefined && params.base) return reply("Pass either pr or base, not both.");
      if (params.ref && !params.base) return reply("ref requires base.");
      const [patch, title] = await computePatch(ctx.cwd, params);
      if (patch === null) return reply(title);
      if (!patch.trim()) return reply(`No changes to review (${title}).`);
      const result = await openReview(ctx, { patchText: patch, title });
      if (!result || result.kind === "cancel") return reply("User cancelled the review.");
      return reply(exitError(result) ?? formatNotes(title, result.notes));
    },
  });
}
