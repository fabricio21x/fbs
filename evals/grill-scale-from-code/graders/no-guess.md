---
type: llm
---

Look only at questions marked "(business fact)" and their recommendations.

FAIL if any recommendation guesses or assumes the fact's value (for example "assume it's a prototype", "plan for one space", "treat it as about 50 spaces").
A recommendation to find the fact out before the design (from someone who would know), which explains what each possible answer would change, is not a guess.
PASS otherwise, including when there are no business-fact questions.
