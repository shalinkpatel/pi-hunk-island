---
name: hunk-review
description: Run a code review with the user inside pi through the hunk overlay (pi-hunk-island): open a diff or PR with seeded agent notes that give a reading order, watch the session so the user's notes wake the agent, reply in threads while the review is open, and collect the notes on quit. Use when the user asks to review a diff, PR, commit or stack in hunk, wants comments seeded, or asks you to watch a review and reply.
---

# hunk review from inside pi

The pi-hunk-island package provides two tools: `hunk_review` opens the hunk TUI as an overlay
and returns a review id without blocking; `hunk_notes` returns the user's saved notes for that
id (a live status while open, the final list after quit; a finished review is consumed on read).
With `mode: diff` or `mode: show` hunk runs inside the repository, so the hunk daemon knows the
session and `hunk session comment ...` works live from the shell. Never use `mode: patch` when
you intend to reply mid-review: patch mode has no repository identity for the daemon.

All three pieces live in this session: the overlay for the user, the daemon CLI for the agent,
and a detached watcher on the session's notes file so the agent is woken instead of polling.

## 1. Prepare notes: a reading order, not a summary of the diff

Before opening, decide what the reviewer must read and in what order. Seed one note per stop,
numbered in the summary (`1. START HERE: ...`, `2. ...`, `3a. ...`), anchored to the line where
that logic begins. Rationale: what the block decides and the question the reviewer should ask
there. Six to twelve notes; more is noise. Anchor lines come from the ref under review, not the
working copy:

    git -C <repo> show <ref>:<path> | grep -n 'def run_request'

Note shape (the tool schema): `{file, line, side?: new|old, summary, rationale?, markup?}`.
`file` is the path exactly as it appears in the diff.

## 2. Open the review in the repository

```ts
const opened = await extensions.hunk_review({
  mode: 'diff',                 // or 'show' for one commit with its message
  cwd: '<repo path relative to pi cwd or absolute>',
  base: '<base sha>', ref: '<head sha>',
  title: '#<pr> <short title>',
  notes,
});
// returns "Review hunk-N opened ..."; keep hunk-N for hunk_notes
```

For a GitHub PR without a local checkout use `pr: <number>`; that forces patch mode, so replies
are not possible, only collection on quit. `cwd` is required whenever pi is not running inside
the repository (jj workspaces without .git, a parent directory).

Then find the daemon session id, which is different from hunk-N:

    hunk session list --json

## 3. Arm a watcher that wakes the agent on the user's saves

The plugin mirrors every saved note into `<session dir>/notes.json` where the session dir is the
newest `$TMPDIR/pi-hunk-*`. Run `scripts/watch-notes.sh` (relative to this skill directory)
through `pi.bash` with a wake monitor; it prints `NOTES_CHANGED <time> <json>` on every change
and `REVIEW_CLOSED` when the directory disappears:

```ts
const dir = (await pi.bash('ls -td $TMPDIR/pi-hunk-* | head -1')).output.trim();
await pi.bash({
  cmd: `bash <skill dir>/scripts/watch-notes.sh ${dir}`,
  monitor: { delivery: 'wake', match: 'NOTES_CHANGED', timeoutMs: 1800000, intervalMs: 5000 },
});
```

The monitor cap is 30 minutes; re-arm it when it expires if the review is still open. End the
turn after arming. Each wake delivers the whole notes.json; ignore wakes where the only new
entries are your own replies (the mirror includes agent comments too) and the first wake, which
is the empty file.

## 4. Reply in threads, do not change code

On a wake with a new user note, list the session to get the note id, then reply to it:

    hunk session comment list --repo <repo> --type user --json     # noteId like user:1790295039906-2
    hunk session comment add --repo <repo> --reply-to <noteId> --author <you> \
        --summary "<one line>" --rationale "$(cat /tmp/reply.txt)"

`--reply-to` threads the reply under the user's note; a fresh `--file/--new-line` anchor at the
same line sits beside it instead. Write rationale text to a temp file and pass it with
`"$(cat ...)"`; no backticks in summary or rationale (the shell expands them). Do not edit code
during a review unless the user says so in a note; answer, and list the changes you would make.

## 5. Collect on quit

When the watcher prints `REVIEW_CLOSED` (the user pressed `q`), call
`extensions.hunk_notes({ id: 'hunk-N' })` once: it returns every saved note as
`{file, hunk, lines, text}`, yours included. Turn the user's notes into the follow-up work.

## Teardown

`q` in hunk closes the overlay and the daemon session; the plugin removes the session dir, which
ends the watcher. If a session lingers: `hunk session list`, then kill the `hunk diff|show|patch`
process; `hunk_notes` for a stale id reports that there is no such session. `Ctrl+Q` in hunk
force-cancels and discards notes.

## Gotchas

- The fabric_exec call cap is 15 minutes; never block on a review, always open, arm, end turn.
- Anchor numbers move when the ref changes; reload with `hunk session reload --repo <repo> -- show <ref>` or reopen, and re-seed.
- `gh pr diff` needs a git checkout in cwd; a jj workspace without `.git` is not one. Use a git worktree or the daemon path (`hunk show <sha>` in a zmx session) instead.
- One hunk per repository path at a time; the daemon keys sessions by repo root.
