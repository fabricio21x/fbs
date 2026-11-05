---
type: llm
focus: { source: file, path: docs/features/2026-10-21-paid-plans/design.md }
---

This is the design for paid plans in Deskly (Stripe subscriptions plus control of each space's plan), a Big feature whose spec has several acceptance criteria. Look at its `## Work units` section and at the spec's acceptance criteria if the design quotes them.

PASS if the section splits the feature into at least two units (`### U1: …`, `### U2: …`), each with a `- Covers:` line citing criteria as `AC<i>` (or `none` for a setup unit) and a `- Depends on:` line that only points at lower units, every criterion number appears in exactly one unit's Covers, and each unit is something a reviewer could judge on its own (cut by feature, not "types" or "tests" alone).
FAIL if the section is missing or `None`, a criterion is missing or covered twice, or a unit is a bare layer (only types, only tests, only a migration with nothing using it).
