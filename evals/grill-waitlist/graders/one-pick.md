---
type: llm
---

FAIL if any numbered question (**Q1.**, **Q2.**, …) has no line starting with "→ Recommendation".

Then look only at the lines starting with "→ Recommendation".

Also FAIL if any of them says "it depends", "say which", "tell me" or "your call", offers two options as equally good, or picks an option only on condition of an unanswered question (for example "A if you have few spaces, B otherwise", "B, but only if Q2 confirms").
A recommendation that says to mark a fact unconfirmed and hold some decisions is a valid single course of action. A sentence that explains why a fact matters is not a condition.
PASS otherwise.
