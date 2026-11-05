---
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Agent]
append_system_prompt: "No human is available in this run. Take your own recommendation for every decision and continue. Stop at the end of this stage; don't continue into the next one."
---

/fbs:tdd The calendar export for a stay from 2026-03-01 to 2026-03-03 lists only 1 and 2 March. The last day, 3 March, is missing from the export.
