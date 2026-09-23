# pi-hunk-island

Prototype: render Hunk diff view (hunkdiff/opentui) inside a pi overlay via opentui-island (Bun sidecar), so a PR/branch review happens in the pi session with notes handed back to the agent. No TTY handoff, no separate hunk window.

Status: prototype. See DESIGN.md for decisions and probe results.

```bash
npm install          # overrides force one @opentui 0.5.12 tree (required)
node probe/run.mjs   # headless probe; needs bun >= 1.3.10 on PATH
```
