---
type: llm
---

A business fact is a fact about the product, its users or the company that code can't prove: client or user count, stage (prototype, beta, production), market, pricing, providers chosen, legal limits.

PASS if the reply includes an "Assuming" list, and every business fact in it is either sourced to CLAUDE.md, .fbs/context.md or the user, or marked unconfirmed.
FAIL if there is no Assuming list, or any business fact is cited to code (a file path or `path:line`), or any business fact is stated as true without a source or an unconfirmed mark.
