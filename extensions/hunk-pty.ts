import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTerminal, type GhosttyVtTerminal, type SnapshotCell } from "@coder/libghostty-vt-node";

/** One saved user note, as written by hunk-ext/pi-notes.mjs. */
export type ReviewNote = { file: string; hunk: number; lines: string; text: string };

const NOTES_EXTENSION = fileURLToPath(new URL("../hunk-ext/pi-notes.mjs", import.meta.url));

// Kitty keyboard handshake (DESIGN.md j.4). hunk (OpenTUI) writes CSI ? u at startup; a
// kitty terminal answers CSI ? <flags> u. We answer "supported, nothing pushed yet" only when
// pi's own terminal speaks kitty, so hunk pushes CSI > 5 u and turns modifyOtherKeys off,
// matching the CSI-u bytes pi forwards. Otherwise silence: hunk stays legacy, like pi.
const KITTY_QUERY = "\x1b[?u";
const KITTY_REPLY = "\x1b[?0u";

// pty via macOS script(1), no native addon (node-pty rejected, DESIGN.md j.1).
// script refuses a socket stdin (node's pipes are socketpairs: "tcgetattr/ioctl: Operation not
// supported on socket"), so bash feeds it through `cat` in a process substitution; the node
// child *is* script, so its exit event is hunk's exit. The inner sh sizes the pty and records
// its path so resize() can `stty -f` it from outside (SIGWINCH reaches hunk).
// ponytail: macOS-only; Linux util-linux wants `script -qfec <cmd> /dev/null` + `stty -F`.
const WRAPPER = 'exec script -q /dev/null /bin/sh -c "$0" sh "$@" < <(exec cat)';
const INNER = 'stty cols "$1" rows "$2" && tty > "$3" && shift 3 && exec "$@"';

export type HunkSessionOptions = {
  cwd: string;
  cols: number;
  rows: number;
  /** Answer hunk's kitty keyboard query (pass pi-tui isKittyProtocolActive()). */
  kitty: boolean;
  /** Patch file to review, or patch text (written to the session dir as <title>.diff). */
  patchFile?: string;
  patchText?: string;
  title?: string;
  onUpdate: () => void;
  onExit: (code: number | null) => void;
  hunkBin?: string;
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

/** Real hunk TUI in a pty, parsed by libghostty-vt. Output is only ever fed to the VT grid. */
export class HunkSession {
  readonly dir: string;
  private readonly notesFile: string;
  private readonly child: ChildProcess;
  private term: GhosttyVtTerminal | null;
  private cols: number;
  private rows: number;
  private tty: string | null = null;
  private cursorVisible = true;
  private exited = false;
  private disposed = false;

  constructor(opts: HunkSessionOptions) {
    this.cols = Math.max(1, opts.cols);
    this.rows = Math.max(1, opts.rows);
    this.dir = mkdtempSync(join(tmpdir(), "pi-hunk-"));
    this.notesFile = join(this.dir, "notes.json");
    let patchFile = opts.patchFile;
    if (patchFile === undefined) {
      patchFile = join(this.dir, `${(opts.title ?? "review").replace(/[^\w.#-]+/g, "_")}.diff`);
      writeFileSync(patchFile, opts.patchText ?? "");
    }
    this.term = createTerminal({ cols: this.cols, rows: this.rows, scrollbackLimit: 0 });
    const hunkArgs = ["patch", "--extension", NOTES_EXTENSION, patchFile];
    this.child = spawn(
      "/bin/bash",
      ["-c", WRAPPER, INNER, String(this.cols), String(this.rows), join(this.dir, "tty"), opts.hunkBin ?? "hunk", ...hunkArgs],
      {
        cwd: opts.cwd,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", PI_HUNK_NOTES_FILE: this.notesFile },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.stdin?.on("error", () => {}); // EPIPE after exit
    this.child.stdout?.on("data", (data: Buffer) => {
      if (this.disposed || !this.term) return;
      const text = data.toString("latin1");
      if (opts.kitty && text.includes(KITTY_QUERY)) this.child.stdin?.write(KITTY_REPLY);
      const show = text.lastIndexOf("\x1b[?25h");
      const hide = text.lastIndexOf("\x1b[?25l");
      if (show !== hide) this.cursorVisible = show > hide;
      this.term.feed(data);
      opts.onUpdate();
    });
    this.child.stderr?.on("data", (data: Buffer) => this.term?.feed(data));
    const exit = (code: number | null) => {
      if (this.exited) return;
      this.exited = true;
      this.child.stdin?.destroy(); // lets the feeding `cat` exit
      if (!this.disposed) opts.onExit(code);
    };
    this.child.on("exit", exit);
    this.child.on("error", (error) => {
      this.term?.feed(`\r\n${error.message}\r\n`);
      exit(127);
    });
  }

  /** Raw bytes from pi, untouched. */
  write(data: string): void {
    if (!this.exited) this.child.stdin?.write(data);
  }

  /** Resize VT grid + pty. Returns false (retry later) until the pty path is known. */
  resize(cols: number, rows: number): boolean {
    cols = Math.max(1, cols);
    rows = Math.max(1, rows);
    if (cols === this.cols && rows === this.rows) return true;
    if (this.exited || !this.term) return false;
    if (!this.tty) {
      try {
        this.tty = readFileSync(join(this.dir, "tty"), "utf8").trim() || null;
      } catch {
        return false;
      }
      if (!this.tty) return false;
    }
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows); // VT first, so hunk's SIGWINCH redraw lands on the new grid
    execFile("stty", ["-f", this.tty, "cols", String(cols), "rows", String(rows)], () => {});
    return true;
  }

  /** Current screen as ANSI lines: one per VT row, exactly cols cells wide. */
  lines(): string[] {
    if (!this.term) return [];
    const snap = this.term.snapshot({ includeCells: true });
    const out: string[] = Array(snap.rows).fill("");
    const used: number[] = Array(snap.rows).fill(0);
    const style: string[] = Array(snap.rows).fill("");
    for (const c of snap.cells ?? []) {
      if (c.col > used[c.row]) {
        out[c.row] += "\x1b[0m" + " ".repeat(c.col - used[c.row]);
        style[c.row] = "";
      }
      const s = sgr(c, this.cursorVisible && c.row === snap.cursorRow && c.col === snap.cursorCol);
      if (s !== style[c.row]) {
        out[c.row] += s;
        style[c.row] = s;
      }
      out[c.row] += c.text || " ";
      used[c.row] = c.col + Math.max(1, c.width);
    }
    return out.map((line, row) => line + "\x1b[0m" + " ".repeat(Math.max(0, snap.cols - used[row])));
  }

  /** Plain visible text, one string per row. */
  text(): string[] {
    return this.term ? this.term.getVisibleText().split("\n") : [];
  }

  /** Saved user notes so far (valid during and after hunk's life, until dispose). */
  notes(): ReviewNote[] {
    try {
      return JSON.parse(readFileSync(this.notesFile, "utf8")) as ReviewNote[];
    } catch {
      return [];
    }
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** Kill hunk (if alive), free the VT, delete the session dir. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.exited) this.child.kill();
    this.child.stdin?.destroy();
    this.term?.dispose();
    this.term = null;
    rmSync(this.dir, { recursive: true, force: true });
  }
}
