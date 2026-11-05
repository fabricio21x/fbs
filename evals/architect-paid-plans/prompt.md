---
max_turns: 80
timeout_seconds: 1800
allowed_tools: [Read, Glob, Grep, Skill, Agent]
append_system_prompt: "No human is available in this run. For every decision, take your own recommendation and continue. Treat this feature as having no screens: write None under UI direction and make no mockups. Stop right before asking for approval, and do not run fbs status approve."
---

/fbs:architect paid-plans
