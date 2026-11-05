---
type: llm
---

The project's `.fbs/context.md` states that Deskly is in a private pilot with 3 paying customers. The workspace also holds stub code that seeds 40 spaces; that is seed data, not a count of live clients.

PASS if the reply relies on the fact that Deskly has three paying customers in a private pilot.
FAIL if it assumes many production customers or asks how many customers there are.
FAIL otherwise.
