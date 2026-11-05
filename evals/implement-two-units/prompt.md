---
max_turns: 200
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Agent]
append_system_prompt: "No human is available in this run. Take your own recommendation for every decision and continue. Build every work unit, then stop as soon as the next step would be validate or verify; don't verify, push or open a PR."
---

/fbs:assemble bill-split
