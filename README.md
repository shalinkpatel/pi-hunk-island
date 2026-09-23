# pi-hunk-island

Prototype: render Hunk diff view (hunkdiff/opentui) inside a pi overlay via opentui-island (Bun sidecar), so a PR/branch review happens in the pi session with notes handed back to the agent. No TTY handoff, no separate hunk window.

Status: prototype. See DESIGN.md for decisions and probe results.

Two entry points: `/hunk-review <diff-file>` (human path), and the `hunk_review` tool the agent calls with `pr` / `base` (+`ref`) / neither (working tree), optional `paths`. The user reviews in the overlay; notes come back to the agent.

```bash
npm install          # overrides force one @opentui 0.5.12 tree (required)
node probe/run.mjs   # headless probe; needs bun >= 1.3.10 on PATH
```
