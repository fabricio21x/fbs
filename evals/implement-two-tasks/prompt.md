---
max_turns: 120
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Agent]
append_system_prompt: "No human is available in this run. Take your own recommendation for every decision and continue. Stop at the end of this stage; don't continue into the next one."
---

/fbs:implement bill-split
