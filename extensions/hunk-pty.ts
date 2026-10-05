import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTerminal, type GhosttyVtTerminal, type SnapshotCell } from "@coder/libghostty-vt-node";

/** One saved user note, as written by hunk-ext/pi-notes.mjs. */
export type ReviewNote = { file: string; hunk: number; lines: string; text: string };

/** One agent note to seed the review with, mapped into the hunk agent-context sidecar. */
export type AgentNote = {
  file: string;
  /** Line in the diff file, on side (default "new"). */
  line: number;
  side?: "new" | "old";
  summary: string;
  rationale?: string;
  /** STML; any markup opt-in flips on --experimental. */
  markup?: string;
};

// Sidecar schema per hunk examples/3-agent-review-demo/agent-context.json (DESIGN.md j.11).
function agentContext(notes: AgentNote[]): string {
  const files = new Map<string, object[]>();
  for (const n of notes) {
    const range = n.side === "old" ? { oldRange: [n.line, n.line] } : { newRange: [n.line, n.line] };
    const annotations = files.get(n.file) ?? [];
    annotations.push({ ...range, author: "agent", summary: n.summary, ...pick({ rationale: n.rationale, markup: n.markup }) });
    files.set(n.file, annotations);
  }
  return JSON.stringify({ version: 1, files: [...files].map(([path, annotations]) => ({ path, annotations })) });
}

function pick(fields: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

const NOTES_EXTENSION = fileURLToPath(new URL("../hunk-ext/pi-notes.mjs", import.meta.url));

// script requires a real pipe, not node's socketpair. EOF must kill script (which ignores it)
// so hunk gets SIGHUP even if pi is SIGKILLed. $$ becomes script after exec. DESIGN.md j.1.
// script requires a real pipe, not node's socketpair. EOF must kill script (which ignores it)
// so hunk gets SIGHUP even if pi is SIGKILLed. $$ becomes script after exec. DESIGN.md j.1.
// ponytail: the EOF kill has a PID-reuse window.
// macOS script runs a command with its argv; util-linux script only takes -c with one command
// string, so Linux builds the inner script with hunk's argv shell-quoted in place.
const DARWIN = process.platform === "darwin";
const WRAPPER_MAC = 'exec script -q /dev/null /bin/sh -c "$0" sh "$@" < <(cat; kill $$ 2>/dev/null)';
const INNER_MAC = 'stty cols "$1" rows "$2" && tty > "$3" && shift 3 && exec "$@"';
// stty addresses the pty device by path: -f on macOS, -F on Linux (util-linux).
const STTY_DEVICE = [DARWIN ? "-f" : "-F"];

function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export type HunkSessionOptions = {
  cwd: string;
  cols: number;
  rows: number;
  /** Answer hunk's kitty query only when pi's terminal speaks kitty. */
  kitty: boolean;
  /** Patch file, or patch text written as <title>.diff in the session dir. */
  patchFile?: string;
  patchText?: string;
  title?: string;
  /** hunk subcommand. Default "patch" reviews patchFile/patchText; "diff" and "show" review the repository in cwd, so the daemon session has a repo and live session commands work. */
  subcommand?: "patch" | "diff" | "show";
  /** Positional targets for non-patch subcommands (e.g. ["main", "HEAD"] for diff, ["HEAD"] for show). */
  targets?: string[];
  /** Optional pathspec for non-patch subcommands. */
  paths?: string;
  /** Notes shown beside the diff on open, as agent annotations. */
  agentNotes?: AgentNote[];
  onUpdate: () => void;
  onExit: (code: number | null) => void;
};

function rgb(hex: string): string {
  return `${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`;
}

function sgr(c: SnapshotCell, inverse: boolean): string {
  let s = "\x1b[0";
  if (c.bold) s += ";1";
  if (c.italic) s += ";3";
  if (c.underline) s += ";4";
  if (inverse) s += ";7";
  if (c.foreground) s += ";38;2;" + rgb(c.foreground);
  if (c.background) s += ";48;2;" + rgb(c.background);
  return s + "m";
}

/** Real hunk TUI in a pty, parsed by libghostty-vt. */
export class HunkSession {
  readonly dir: string;
  private readonly notesFile: string;
  /** Linux only: hunk exit code written by the inner script; null on macOS. */
  private readonly exitFile: string | null;
  private readonly child: ChildProcess;
  private term: GhosttyVtTerminal | null = null;
  private cols: number;
  private rows: number;
  private cursorVisible = true;
  private exited = false;

  constructor(opts: HunkSessionOptions) {
    this.cols = Math.max(1, opts.cols);
    this.rows = Math.max(1, opts.rows);
    this.dir = mkdtempSync(join(tmpdir(), "pi-hunk-"));
    this.notesFile = join(this.dir, "notes.json");
    this.exitFile = DARWIN ? null : join(this.dir, "exit");
    try {
      writeFileSync(this.notesFile, "[]");
      const extraArgs: string[] = [];
      if (opts.agentNotes?.length) {
        const contextFile = join(this.dir, "agent-context.json");
        writeFileSync(contextFile, agentContext(opts.agentNotes));
        extraArgs.push("--agent-context", contextFile, "--agent-notes");
        if (opts.agentNotes.some((n) => n.markup)) extraArgs.push("--experimental");
      }
      const sub = opts.subcommand ?? "patch";
      if (sub === "diff") extraArgs.push("--exclude-untracked");
      let patchFile = opts.patchFile;
      if (sub === "patch" && patchFile === undefined) {
        patchFile = join(this.dir, `${(opts.title ?? "review").replace(/[^\w.#-]+/g, "_")}.diff`);
        writeFileSync(patchFile, opts.patchText ?? "");
      }
      const targets = sub === "patch"
        ? [patchFile!]
        : [...(opts.targets ?? []), ...(opts.paths ? ["--", opts.paths] : [])];
      this.term = createTerminal({ cols: this.cols, rows: this.rows, scrollbackLimit: 0 });
      const hunkArgv = ["hunk", sub, "--extension", NOTES_EXTENSION, ...extraArgs, ...targets];
      const ttyFile = join(this.dir, "tty");
      // util-linux script lingers until stdin EOF after the child exits (BSD script exits with
      // the child), so the Linux inner runs hunk without exec, writes its exit code to a file,
      // then SIGTERMs script; exitCodeOf() reads the file so the host sees hunk's real code.
      const innerLinux = `stty cols ${this.cols} rows ${this.rows} && tty > ${shq(ttyFile)} && ${hunkArgv.map(shq).join(" ")}; echo $? > ${shq(this.exitFile!)}; kill -TERM $PPID 2>/dev/null`;
      this.child = spawn("/bin/bash", DARWIN
        ? ["-c", WRAPPER_MAC, INNER_MAC, String(this.cols), String(this.rows), ttyFile, ...hunkArgv]
        : ["-c", `exec script -qfec ${shq(innerLinux)} /dev/null < <(cat; kill $$ 2>/dev/null)`], {
        cwd: opts.cwd,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", PI_HUNK_NOTES_FILE: this.notesFile },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.term?.dispose();
      rmSync(this.dir, { recursive: true, force: true });
      throw error;
    }
    this.child.stdin?.on("error", () => {}); // EPIPE after exit
    let tail = "";
    this.child.stdout?.on("data", (data: Buffer) => {
      if (!this.term) return;
      const text = tail + data.toString("latin1");
      for (const m of text.matchAll(/\x1b\[\?(u|25[hl])/g)) {
        if (m.index + m[0].length <= tail.length) continue; // already handled in the previous chunk
        if (m[1] === "u") {
          if (opts.kitty) this.write("\x1b[?0u");
        } else this.cursorVisible = m[1] === "25h";
      }
      tail = text.slice(-5); // longest control is six bytes; handles split and repeated queries
      this.term.feed(data);
      opts.onUpdate();
    });
    this.child.stderr?.on("data", (data: Buffer) => {
      if (!this.term) return;
      this.term.feed(data);
      opts.onUpdate();
    });
    let reported = false;
    const report = (code: number | null): void => {
      if (reported || !this.term) return;
      reported = true;
      opts.onExit(this.exitCodeOf(code));
    };
    this.child.on("exit", (code) => {
      this.exited = true;
      this.child.stdin?.destroy(); // let cat exit, closing its inherited output pipes
      // Feed bytes already buffered (read emits data), but never wait for inherited pipes.
      for (const stream of [this.child.stdout, this.child.stderr]) {
        while (stream && stream.read() !== null) { /* data handlers update the VT */ }
      }
      report(code); // overlay snapshots the VT and notes before disposing

    });
    this.child.on("error", (error) => this.term?.feed(`\r\n${error.message}\r\n`));
    this.child.on("close", (code) => {
      this.exited = true;
      report(code);
    });
  }

  /** script's death signal hides hunk's exit code (Linux); the inner wrote it to the exit file. */
  private exitCodeOf(code: number | null): number | null {
    if (this.exitFile === null) return code;
    try {
      const read = parseInt(readFileSync(this.exitFile, "utf8").trim(), 10);
      return Number.isInteger(read) ? read : code;
    } catch {
      return code; // no file (host killed script) keeps the raw code
    }
  }

  /** Raw bytes from pi, untouched. */
  write(data: string): void {
    if (this.term && !this.exited) this.child.stdin?.write(data);
  }

  /** VT first, then SIGWINCH. Failed lookups/ioctls remain retryable. */
  resize(cols: number, rows: number): boolean {
    cols = Math.max(1, cols);
    rows = Math.max(1, rows);
    if (this.exited || !this.term) return false;
    if (cols === this.cols && rows === this.rows) return true;
    try {
      const tty = readFileSync(join(this.dir, "tty"), "utf8").trim();
      this.term.resize(cols, rows);
      // Bounded synchronous stty avoids queued resizes landing out of order or after disposal.
      execFileSync("stty", [...STTY_DEVICE, tty, "cols", String(cols), "rows", String(rows)], { timeout: 1000, stdio: "ignore" });
    } catch {
      this.term.resize(this.cols, this.rows);
      return false;
    }
    this.cols = cols;
    this.rows = rows;
    return true;
  }

  /** Current screen as ANSI lines: one per VT row, including blank cursor cells. */
  lines(): string[] {
    if (!this.term) return [];
    const snap = this.term.snapshot({ includeCells: true });
    const cells = snap.cells ?? [];
    let i = 0;
    return Array.from({ length: snap.rows }, (_, row) => {
      let line = "", style = "";
      for (let col = 0; col < snap.cols;) {
        const c = cells[i]?.row === row && cells[i].col === col ? cells[i++] : { row, col, text: " ", width: 1 };
        const width = Math.max(1, c.width);
        const s = sgr(c, this.cursorVisible && row === snap.cursorRow && col <= snap.cursorCol && snap.cursorCol < col + width);
        if (s !== style) line += s;
        style = s;
        line += c.text || " ";
        col += width;
      }
      return line + "\x1b[0m";
    });
  }

  text(): string[] {
    return this.term ? this.term.getVisibleText().split("\n") : [];
  }

  /** Saved notes; corrupt data must not masquerade as an empty review. */
  notes(): ReviewNote[] {
    const notes = JSON.parse(readFileSync(this.notesFile, "utf8"));
    if (notes?.error) throw new Error(`Review note export failed: ${notes.error}` +
      (notes.notes?.length ? `\nRetained notes: ${JSON.stringify(notes.notes)}` : ""));
    if (!Array.isArray(notes) || !notes.every((n) => n && typeof n.file === "string" &&
      Number.isInteger(n.hunk) && n.hunk >= 0 && typeof n.lines === "string" && typeof n.text === "string")) {
      throw new Error(`Invalid review notes in ${this.notesFile}`);
    }
    return notes;
  }

  /** Kill hunk, free the VT, delete the session dir. Idempotent; does not call onExit. */
  dispose(): void {
    if (!this.term) return;
    const term = this.term;
    this.term = null;
    if (!this.exited) this.child.kill();
    this.child.stdin?.destroy();
    term.dispose();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
