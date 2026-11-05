---
name: principle-fix-root-causes
description: "Use when fixing a bug or a test that fails unexpectedly: reproduce it first, trace the symptom to its cause, and fix the cause rather than the place the symptom appeared."
user-invocable: false
---

# Fix root causes

A fix at the place the symptom shows usually moves the bug instead of removing it. The second report of the same bug, in a new shape, costs more than finding the cause the first time.

## When it applies

Whenever you fix a defect, a failing test, a crash or a wrong result, and when a review finding says something is broken.

## The rules

1. **Reproduce first.** Write a failing test, or record exact steps that show the defect, before you change any code. If you can't reproduce it, say so, add the check or log that would catch it next time, and don't call a guess a fix.
2. **Quote the actual failure.** The full output that matters: the error, the stack, the received and expected values. Not just the assertion line.
3. **Trace, don't guess.** Follow the wrong value back to where it is first wrong, with `path:line` at each step. Read the code; don't infer from names.
4. **Fix the cause.** Change the place where the wrong value is produced, not the place it is noticed. No catch-and-ignore, no special case for the one input that failed. When the cause is a provider you can't change, handle it at the boundary (`principle-boundary-discipline`).
5. **Two strikes, then question the premise.** When two fixes for the same symptom fail, stop. Name the assumption both fixes shared and test that assumption before trying a third.
6. **Look for siblings.** Search for other places that make the same mistake. Report them; fix only those inside your task's scope.

## The test

The reproduction fails before the fix and passes after it, the fix's diff touches the place the trace ended, and no try/catch or special case hides the symptom.
