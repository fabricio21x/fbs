---
max_turns: 60
timeout_seconds: 1500
allowed_tools: [Read, Glob, Grep, Skill, Agent]
append_system_prompt: "No human is available in this run. Take your own recommendation for every decision, and stop right before asking for an approval; don't run fbs status approve."
---

/fbs:plan bill-split
