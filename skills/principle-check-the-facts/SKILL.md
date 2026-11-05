---
name: principle-check-the-facts
description: "Use before writing assumptions, a spec, a design or a rollout plan: never build on a business fact nobody confirmed. Lists the business facts a decision rests on and sources each from CLAUDE.md, .fbs/context.md or the user; asks the missing or stale ones."
user-invocable: false
---

# Check the facts

Every step after a wrong fact can be reasonable and still waste the work. A design once assumed many production clients when there were two in a closed beta, and built a phased rollout nobody needed.

## When it applies

Before you write assumptions, a spec, a design, or a rollout or migration plan. Also whenever a decision depends on how the business works: who the users are, how many there are, what stage the product is in, which providers it has chosen, what it charges.

## The rules

1. **List the business facts each decision rests on.** A business fact is something about the product, its users or the company that the code can't prove: user or client count, stage (prototype, closed beta, production), market, pricing, providers, legal limits.
2. **Source each one** from `CLAUDE.md`, `.fbs/context.md`, or the user. Name the file, or the user and the date they said it.
3. **A missing or stale fact is asked.** Stale means dated more than `context.staleDays` days ago (default 30) or flagged by `fbs context check`. Only a fact no decision rests on may stay `unconfirmed` without asking. An unsourced fact never silently becomes a design input.
4. **Never infer a business fact from code.** Code shows only what is built today: not who uses it, how many there are, what stage the product is in, which providers the business has chosen or what it charges. Tables, seeds, flags, admin screens, plan files and migrations are not evidence of any of these.
5. **Rollout and migration plans cite the project's real stage.** Phased releases, feature flags, backfills and admin tooling need a sourced fact that justifies them, not habit.
6. **Code facts are different.** Look them up yourself; never ask the user for them.

## The test

Every business fact in the output has a source or an `unconfirmed` mark. No decision rests on an `unconfirmed` fact unless the user was asked and didn't know; that decision says so, so the user sees it before approving.
