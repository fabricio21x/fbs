---
max_turns: 150
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
append_system_prompt: "No human is available in this run. Take your own recommendation for every decision and continue. Stop at the end of this stage; don't continue into the next one. Once the PR is ready to land, report it and stop: don't start the watcher again."
---

/fbs:camp-pr demo
