---
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Agent]
append_system_prompt: "No human is available in this run. When you reach the first question for the user, ask it and end your turn."
---

/fbs:plan Coworking spaces want a waitlist: when a day is fully booked, a member can join the waitlist and gets a text when a desk opens.
