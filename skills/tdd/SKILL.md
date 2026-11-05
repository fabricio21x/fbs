---
name: tdd
description: "Fix a reported bug test-first: reproduce it with the smallest failing test, quote the real failure, trace the root cause with path:line, fix the cause, and prove it with the test and the full suite. Creates a bug record so /fbs:verify can stamp the fix."
disable-model-invocation: true
argument-hint: "[the bug: what happens, what should happen, how to trigger it]"
allowed-tools: Bash(fbs *)
---

# TDD

Fix one reported defect so it stays fixed. A fix without a failing test first is a guess, and a guess at the place the symptom showed usually moves the bug instead of removing it.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: the bug report given in the arguments or by the calling skill: $ARGUMENTS

Run every `fbs` command as its own Bash call, with nothing chained, piped or redirected: only a bare `fbs …` call is pre-approved.

**Work from the files.** Load or read each skill, template and agent this stage names when its step comes, the way the step says, even if it ran earlier in this session. The documents hold what is settled. Once the spec is approved, anything the user says that changes it or the design, and anything this stage finds they can't hold, goes through the change path first (load `fbs:changes` with the Skill tool), so it's written down before it's acted on.

**Keep going.** Never ask the user to type a command. When this stage is done and nothing is pending (an approval, a decision, a blocker), say in one line what you're starting and continue into the next stage yourself: read its SKILL.md under `<plugin root>/skills/` with the Read tool and follow it, with the slug and the plugin root.

**Ask with the question UI.** Every question to the user, approvals and go-aheads included, goes through the AskUserQuestion tool when it is available, with what the user needs to answer shown in the chat right before it (`fbs:grilling`'s rules). Plain text only when the answer can't be options, or without the tool.

## 1. Load the principles and read the report

Load `fbs:principle-fix-root-causes` and `fbs:principle-test-behavior` with the Skill tool, and follow them for the rest of this stage.

Restate the bug in one line each: what happens, what should happen, how to trigger it. If the report doesn't say how to trigger it, or what should happen instead, ask once (grilling's rules: the question UI when available) and wait. Never guess the expected behaviour.

## 2. A clean start, the test command and a baseline

1. If `git status --porcelain` isn't empty, show what's dirty and ask once (the question UI when available): commit it, ignore it locally (add it to `.git/info/exclude`, which changes nothing in the repo), or set it aside with `git stash -u` until this stage ends. Do what the user chooses and go on; never discard their changes.
2. Find the project's test command in `CLAUDE.md`, the `package.json` scripts or the equivalent. If you can't find one, ask once.
3. Run the whole suite before changing anything and keep its summary line. Failures that exist now are not yours: list them, and don't fix them here.

## 3. Reproduce

1. Write the smallest test that triggers the bug through the code's public surface, next to the project's existing tests and in their style. Its name says the expected behaviour.
2. Run it with the test command. It must fail, and fail because of the bug: quote the actual failure output (the received and expected values, the error), not just the test name.
3. If it passes, the bug isn't reproduced. Say so, check the trigger against the report, and try once more. If it still passes, stop: report what you tried, and don't fix anything.

## 4. The record and the branch

Pick a slug for the bug: lowercase words joined by `-`, at most four words. Run `fbs status init <slug> --size bug` and take `dir` from its JSON; on `error: exists`, ask whether to continue that record or pick another slug. Then `fbs status show <slug>` gives `docs` and `docsRoot`: `bug.md` is written under `docsRoot`, and committed only when `docs` is `tracked` (`local`: git ignores it).

When the bug comes from a tracker ticket, record it first: `fbs status ticket <slug> '<id>' --url <its url>`. Then run `fbs branch <slug> --type bugfix` (`--type hotfix` when the user calls it an urgent production fix; it takes the ticket from the record): the fix goes on its own branch, cut from the remote's default branch, so it ships on its own; the reproduction test comes along uncommitted. Pass `--parent <the current branch>` when the code the test exercises exists only on that unmerged feature branch (`git diff origin/<default branch>...HEAD` touches it): the fix then stacks on it. Pass `--use <branch>` only when the user explicitly asked to fix it on that branch. Say each `note:` in one line; on `refused:`, show it to the user and do what they choose, never discarding their changes.

Then the ticket, when the bug has none yet: load `fbs:tracker` with the Skill tool (its setting step first); with a tracker, propose one issue for the bug and create it on the user's one-line go-ahead; it renames the branch to carry the id. Commit a tracker setting it wrote, unless git ignores it (`git check-ignore -q .fbs/config.json` exits 0).

Run the reproduction test again on the branch. It must still fail for the same reason; if it passes, the bug isn't in the code this branch started from: say so and stop.

## 5. Trace the root cause

Follow the wrong value back to where it is first produced, one `path:line` per step, reading the code rather than inferring from names. Write the chain as a short list that ends at the cause. Then search for siblings: other places that make the same mistake. List them; fix only those inside this bug's scope.

## 6. Fix the cause

Make the smallest change at the place the trace ended. No catch-and-ignore and no special case for the one failing input. When the cause is a provider you can't change, handle it at the boundary.

Then run the new test, quote its passing output, and run the whole suite and quote its summary line. Anything that passed in the baseline and fails now is yours: fix it before going on. If two fixes for the same failure don't work, stop and name the assumption they shared (principle rule 5).

## 7. Record and commit

1. Write `<dir>/bug.md`: the report in one line each (what happens, what should happen, the trigger); the test command and the baseline (tests that failed before any change, or None); the reproduction test's name and path; the root cause chain; the fix in one line; the siblings found; and one acceptance criterion as a `- [ ]` line: `- [ ] <the reproduction test> passes, and the suite has no new failure.`
2. Stage the test, the fix and `bug.md` (when `docs` is `tracked`) by path, never `git add -A`, and commit them together with a `fix:` message, no attribution lines. Then push it with `fbs push <slug>`: the feature's branch is pushed whenever it gets commits, so the work is backed up and visible. Say a `skipped:` or `refused:` from it in one line; it never blocks this stage.

## 8. End

Show the root cause in one line, the quoted red and green output, and the suite result. Then continue into verify.
