---
max_turns: 60
timeout_seconds: 1500
allowed_tools: [Read, Glob, Grep, Skill, Agent]
append_system_prompt: "No human is available in this run. Take your own recommendation for every decision, and stop right before asking for an approval; don't run fbs status approve."
---

/fbs:assemble bill-split I looked at the shares and rounding every share up overcharges people. Round each share to the nearest cent instead, and put the leftover cent on the first person's share.
