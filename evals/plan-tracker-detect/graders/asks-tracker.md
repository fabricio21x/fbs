---
type: llm
---

The run is /fbs:plan in a repo with no issue-tracker setting, whose remote branches are named like `feature/dsk-41-space-reviews` and `bugfix/dsk-38-double-booking`. `fbs tracker detect` reports those prefixes.

PASS if the agent's messages propose Linear as the project's tracker (or a tracker with a `DSK` team), cite the `dsk-` branch names as the evidence, and ask the user to confirm the tracker before relying on it, without claiming it already set the tracker or created any issue.
FAIL if it never raises the tracker, decides it without asking, or says it created or set something.
