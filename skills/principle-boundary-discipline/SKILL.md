---
name: principle-boundary-discipline
description: "Use when code takes in outside data or when reviewing defensive checks: validate once where data enters the system, then trust the internal types instead of re-checking them everywhere."
user-invocable: false
---

# Boundary discipline

Checks scattered through internal code make every function guess what it might receive, and they still miss the input that was never parsed. One parse at the edge, and typed code behind it, is both safer and shorter.

## When it applies

When code reads anything from outside its own process (a request, a webhook, a provider's response, env vars, a file, a database row), and when you review or remove defensive checks.

## The rules

1. **Parse at the edge.** Turn outside data into a named type where it enters, once, with a schema or a parser. Reject what doesn't fit, with an error that says what was wrong, and ignore unknown fields so a provider adding one doesn't break you. A documented default for an optional field is part of the schema.
2. **Trust the type behind it.** Past the boundary, don't re-check what the type already guarantees: no null checks on non-nullable fields, no `typeof` on typed values, no try/catch around code that can't throw.
3. **Edge errors are typed and handled.** A boundary that can fail returns a typed result or raises a typed error the caller handles. Never swallow it and continue with an undocumented default.
4. **Know your boundaries.** Your own modules calling each other are not a boundary. A provider, the network and user input always are. A database row is a boundary when it arrives untyped (raw SQL, a JSON column, a table other systems write); a typed ORM result is already parsed.
5. **Secrets and config are boundaries too.** Read and validate env vars once at startup, and fail fast when one is missing.

This overlaps rule 4 of `principle-model-the-domain` on purpose: that rule names the shape, this one says where checking happens.

## The test

Every place outside data enters has exactly one parse, and the code behind it has no defensive check for a case its types rule out.
