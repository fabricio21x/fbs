---
max_turns: 60
timeout_seconds: 1500
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
append_system_prompt: "No human is available in this run. Take your own recommendation for every decision and continue. Stop at the end of this stage; don't continue into the next one."
---

/fbs:open-pr demo
