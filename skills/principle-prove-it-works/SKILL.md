---
name: principle-prove-it-works
description: "Use before saying anything works, is fixed or is done: verify against the real artifact (the suite, the running app, the endpoint) and quote its output, never a proxy."
user-invocable: false
---

# Prove it works

"It compiles", "the test file exists" and "the change looks right" are proxies. Each has passed while the feature was broken. Only the real thing, run, shows that it works.

## When it applies

Before you report a task done, a bug fixed, a criterion met or a build ready, and whenever you review someone else's claim that it is.

## The rules

1. **Run the real thing.** The project's own test command, the app itself, the endpoint over HTTP, the page in a browser. Not a stub or mock standing in for the system; scripts that drive the real system are fine.
2. **Quote the output.** Paste the lines that show the result (the pass/fail summary, the response, the screenshot path), not a paraphrase.
3. **Same tree.** The evidence comes from the code as it is now. A run from before the last edit proves nothing about this one.
4. **Name what you ran:** the command, where, and against which build or URL.
5. **Say what you didn't check.** A criterion with no evidence is unverified, not "probably fine". Report it as unverified.
6. **A green suite isn't the whole proof.** It shows the tests pass; say which acceptance criteria those tests cover, and verify the rest another way.

## The test

Every "works" in your report points at output from the current tree that someone else could rerun and see the same, and every criterion without such output is listed as unverified.
