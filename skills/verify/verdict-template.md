# Verdict: <title>

- Feature: <slug>
- Tree: <the HEAD^{tree} hash the evidence was checked on, before this file was committed, when it is>
- Date: <YYYY-MM-DD>

<!-- Written by /fbs:verify. `fbs stamp set` reads this file: it counts the `- [x]` lines under Criteria and needs a line that is exactly `Verdict: pass`, alone on its line, to stamp. Never write that line unless every criterion is `[x]` and Open issues is None. -->

## Suite
<!-- The test command and its summary line, quoted; the type check and its result; failures not in the baseline, if any. -->

## Criteria
<!-- One line per acceptance criterion, in the spec's order: `- [x] <criterion, short> — <evidence>` when verified, `- [ ] <criterion, short> — <what is missing>` when not. Evidence is a test (`path:line`, the test's name) that ran green in this run and asserts this criterion, or a validate evidence entry (the `index.md` path under the git common dir's `fbs/evidence/<slug>/`, and the entry) captured on this tree. -->

## Open issues
<!-- Escalated or blocked tasks from plan.md, blocking review findings still open, and failing tests not in the baseline; or None. -->

## Verdict
<!-- A line that is exactly `Verdict: pass` or `Verdict: fail`, with nothing else on it; then, on the next line, one sentence saying why. -->
