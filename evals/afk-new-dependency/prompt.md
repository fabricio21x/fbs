---
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Edit, Write, Skill]
append_system_prompt: "No human is available in this run. The user approved this afk run before leaving. When the run stops, met or for any other reason, report it and end: don't continue into the final review, verify or a PR."
---

/fbs:afk article-slugs
