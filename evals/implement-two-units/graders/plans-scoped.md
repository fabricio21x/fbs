---
type: llm
focus: { source: file, path: docs/features/bill-split/units/tip-amount/plan.md }
---

This is the implementation plan of work unit 2 ("Tip amount") of a feature whose unit 1 ("Split shares", `splitBill`) was built before it on the branch below.

PASS if every task in this plan is about the tip (`tipAmount`, `src/tip.ts`, its tests) and none rebuilds or re-plans `splitBill`.
FAIL if it plans splitting work, or has no tasks.
