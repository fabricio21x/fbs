---
name: principle-model-the-domain
description: "Use before writing logic or designing modules: name the data shape first, and encode the domain in one structure (a typed model, a state machine, a table keyed by kind) instead of conditionals scattered across files."
user-invocable: false
---

# Model the domain

When the shape of the data is left implicit, every function guesses it again: a flag checked here, a string compared there, a case nobody listed. The bugs live between those guesses, and they show up when a new state or kind arrives.

## When it applies

Before you write logic or design modules. Also whenever you add a field, flag, status or kind to something that already exists.

## The rules

1. **Name the data shape first.** Write the core types, tables and their allowed values before any flow, handler or screen. Describe each flow in terms of that shape: which fields it reads, which it writes, which state it moves to.
2. **A state machine over scattered booleans.** When a thing moves through stages (trial, active, cancelled), model one status with named states and the allowed transitions between them. Two booleans that must never both be true are a state nobody named.
3. **A table or registry over branching.** When behaviour varies by kind (plan, role, provider), keep the per-kind values in one map keyed by the kind (`Record<Plan, number>`). Adding a kind is then one entry, and a missing one fails the type check instead of falling through an `if`.
4. **A typed model over repeated shape assumptions.** Parse outside data (a webhook body, an untyped database row, a request) once, at the boundary, into a named type. The code past that point uses the type, never the raw shape or string literals.
5. **Model only what the spec needs.** The smallest model that names every state and kind the acceptance criteria require wins; don't add states or kinds for later (see `principle-smallest-change`).

## The test

The design names its core types, with their allowed values and transitions, before it describes any flow. Every behaviour that depends on a kind or state points at one structure, not at conditionals spread across files.
