import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Theme,
  type TUI,
} from "@earendil-works/pi-tui";
import type { OpenTuiBridgeEvent } from "opentui-island";
import { createPiTuiSurface, type PiTuiSurface } from "opentui-island/pi-tui";

// Mirrors the island type. Redeclared here so importing the .tsx pulls no React
// into pi process (DESIGN.md handoff).
type ReviewNote = { file: string; hunk: number; lines: string; text: string };
type OverlayResult = { kind: "submit"; notes: ReviewNote[] } | { kind: "cancel" };

const ISLAND_URL = new URL("../islands/hunk-review.island.tsx", import.meta.url);
const LOADING_STATUS = "Starting hunk review in a Bun sidecar…";
const BUN_HINT = "Needs Bun >= 1.3.10 on PATH (or OPENTUI_ISLAND_BUN).";

function padLine(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "", true);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function formatNotes(title: string, notes: ReviewNote[]): string {
  const lines = [`Review notes on ${title} (${notes.length}):`];
  if (notes.length === 0) {
    lines.push("none");
    return lines.join("\n");
  }
  for (const note of notes) {
    lines.push(`- \`${note.file}\` hunk ${note.hunk + 1} (new lines ${note.lines}): ${note.text}`);
  }
  return lines.join("\n");
}

function runCapture(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", failed: !!error });
    });
  });
}

/** Compute a unified diff from agent-chosen args. Returns [patch, title, error]. */
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
  if (args.base) {
    const ref = args.ref ?? "HEAD";
    const r = await runCapture("git", ["diff", `${args.base}...${ref}`, ...pathArgs], cwd);
    if (r.failed) return [null, `git diff ${args.base}...${ref} failed: ${r.stderr.trim() || "unknown error"}`];
    return [r.stdout, `${args.base}...${ref}`];
  }
  const r = await runCapture("git", ["diff", "HEAD", ...pathArgs], cwd);
  if (r.failed) return [null, `git diff HEAD failed: ${r.stderr.trim() || "unknown error"}`];
  return [r.stdout, "working tree"];
}

class HunkReviewOverlay implements Component {
  private readonly height: number;
  private readonly width: number;
  private surface: PiTuiSurface | null = null;
  private unsubscribe: (() => void) | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private error: string | null = null;
  private closing = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly patch: string,
    private readonly title: string,
    private readonly done: (value: OverlayResult) => void,
  ) {
    this.width = Math.max(1, this.tui.terminal.columns);
    // Fixed at construction: PiTuiSurface exposes no height setter (DESIGN.md e.6).
    this.height = Math.max(1, this.tui.terminal.rows);
    void this.initialize();
  }

  private fail = (error: unknown): void => {
    this.error = formatError(error);
    this.tui.requestRender();
  };

  private async initialize(): Promise<void> {
    try {
      this.surface = await createPiTuiSurface({
        height: this.height,
        initialWidth: this.width,
        requestRender: () => this.tui.requestRender(),
        island: {
          module: ISLAND_URL,
          props: { patch: this.patch, title: this.title },
        },
      });
      this.unsubscribe = this.surface.onEvent((event: OpenTuiBridgeEvent) => {
        if (event.type === "submit" && event.payload && typeof event.payload === "object" && "notes" in event.payload) {
          void this.close({ kind: "submit", notes: (event.payload as { notes: ReviewNote[] }).notes });
        } else if (event.type === "cancel") {
          void this.close({ kind: "cancel" });
        }
      });
      this.surface.focused = true;
      await this.surface.sync(this.width);
      // Frames are pull-based: async island updates (syntax highlight) stay invisible
      // until the next sync. Poll while open.
      // ponytail: 500ms poll; push-based frames if opentui-island grows them.
      this.syncTimer = setInterval(() => {
        void this.surface?.sync().catch(this.fail);
      }, 500);
    } catch (error) {
      this.fail(error);
    }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+q") || matchesKey(data, "ctrl+c")) {
      void this.close({ kind: "cancel" });
      return;
    }
    if (this.error && matchesKey(data, "escape")) {
      void this.close({ kind: "cancel" });
      return;
    }
    // Not handleInput(): that one does void sendInput() and leaks an unhandled
    // rejection after a sidecar crash, which would take pi down (DESIGN.md e.3).
    void this.surface?.sendInput(data).catch(this.fail);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.surface?.invalidate();
  }

  private blanks(width: number): string {
    return " ".repeat(Math.max(1, width));
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    const rows = Array.from({ length: this.height }, () => this.blanks(w));

    if (this.error) {
      rows[0] = padLine(this.theme.fg("error", `hunk review failed: ${this.error}`), w);
      rows[1] = padLine(this.theme.fg("dim", BUN_HINT), w);
      rows[this.height - 1] = padLine(this.theme.fg("warning", "Esc closes."), w);
      return rows;
    }

    if (!this.surface) {
      rows[0] = padLine(this.theme.fg("accent", LOADING_STATUS), w);
      return rows;
    }

    const body = this.surface.render(w).slice(0, this.height);
    for (let i = 0; i < this.height; i++) {
      const line = body[i];
      rows[i] = line === undefined ? this.blanks(w) : padLine(line, w);
    }
    return rows;
  }

  private async close(result: OverlayResult): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.cleanup();
    try {
      await this.surface?.destroy();
    } catch {
      // Surface already dead; nothing to clean up further.
    } finally {
      this.done(result);
    }
  }

  private cleanup(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  dispose(): void {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.cleanup();
    void this.surface?.destroy().catch(() => {});
  }
}

function openReview(ctx: ExtensionContext, patch: string, title: string): Promise<OverlayResult> {
  return ctx.ui.custom<OverlayResult>(
    (tui, theme, _keybindings, done) => new HunkReviewOverlay(tui, theme, patch, title, done),
    {
      overlay: true,
      overlayOptions: { row: 0, col: 0, width: "100%", maxHeight: "100%", margin: 0 },
    },
  );
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
      const result = await openReview(ctx, patch, title);
      if (!result || result.kind === "cancel") {
        ctx.ui.notify("Review cancelled.", "info");
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
      "Open an interactive hunk diff review overlay for the user and wait for their notes. " +
      "Use when the user wants to review changes and leave comments. Picks the diff source from args: " +
      "pr (GitHub PR number), base (+optional ref, default HEAD) for git diff base...ref, " +
      "or neither for working-tree changes vs HEAD. Optionally paths filters by pathspec. " +
      "Returns the user hunk-level notes, or that the user cancelled or found nothing to note. " +
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
      if (ctx.mode !== "tui") {
        return {
          content: [{ type: "text", text: "hunk_review needs an interactive (tui) session." }],
          details: {} as Record<string, never>,
        };
      }
      if (params.pr !== undefined && params.base) {
        return {
          content: [{ type: "text", text: "Pass either pr or base, not both." }],
          details: {},
        };
      }
      if (params.ref && !params.base) {
        return {
          content: [{ type: "text", text: "ref requires base." }],
          details: {},
        };
      }
      const [patch, titleOrError] = await computePatch(ctx.cwd, params);
      if (patch === null) {
        return {
          content: [{ type: "text", text: titleOrError }],
          details: {},
        };
      }
      if (!patch.trim()) {
        return {
          content: [{ type: "text", text: `No changes to review (${titleOrError}).` }],
          details: {},
        };
      }
      const title = titleOrError;
      const result = await openReview(ctx, patch, title);
      if (!result || result.kind === "cancel") {
        return {
          content: [{ type: "text", text: "User cancelled the review." }],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: formatNotes(title, result.notes) }],
        details: {},
      };
    },
  });
}
