---
name: principle-test-behavior
description: "Use when writing or reviewing tests: a test asserts the behaviour a requirement asks for, through the code's public surface, and would fail on a real defect."
user-invocable: false
---

# Test behaviour

A test that checks how the code is built instead of what it does breaks on every refactor and passes on real bugs. It costs time twice and protects nothing.

## When it applies

Whenever you write, change or review a test, and when you decide whether a task is covered.

## The rules

1. **Name what it proves.** Each test covers an acceptance criterion, a reported defect, or an edge case the design or a review names, and its name says which behaviour, in the words a user or caller would use.
2. **Go through the public surface.** Call what a caller calls: the exported function, the route, the command. Don't test private helpers or assert on internal calls; asserting what a faked boundary received ("one email sent, to this address") is fine.
3. **Fake only what you don't own.** The network, the clock, a provider's API, randomness. Never mock the unit under test or the module next to it. Use a real database (a test instance or in-memory) the way the project's existing tests do.
4. **New behaviour fails first.** A test for new behaviour or a defect fails before the change. A safety net for a refactor passes before and after. When a new test passes unexpectedly, the behaviour already exists or the test is wrong: find out which before moving on.
5. **Assert the outcome a user would notice:** the returned value, the stored row, the sent message, the rendered text. Not that "no error was thrown".
6. **One behaviour per test.** When it fails, its name alone says what broke.

## The test

Break the code on purpose, the way a real bug would (an off-by-one, a missing branch, a wrong state): at least one test fails and its name tells you which behaviour. Refactor without changing behaviour: no test fails.
