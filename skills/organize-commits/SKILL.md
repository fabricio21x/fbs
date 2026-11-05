---
name: organize-commits
description: "Fold a feature branch's fix rounds and plan-status commits into their task commits, so a reviewer reads one commit per task, and make every subject a conventional commit. Non-interactive autosquash, then the stamp proves the code didn't change; on any doubt it keeps the history as it was. Never touches another branch."
disable-model-invocation: true
argument-hint: "[feature slug]"
allowed-tools: Bash(fbs *)
---

# Organize commits

A reviewer should read the branch one task at a time, not through every fix round. Implement already wrote the history so it can fold itself: each task's commit carries a `Task:` trailer, fix rounds are `fixup!` commits of it, and plan-status updates are `fixup!` commits of the plan. This stage folds them, and rewords any subject that isn't a conventional commit. It is cosmetic: when anything doesn't go cleanly, the history stays as it was.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: the feature slug given in the arguments or by the calling skill: $ARGUMENTS

Run every `fbs` command as its own Bash call, with nothing chained, piped or redirected.

## A stack of work units

A work unit (its record has `unitOf`) is never organized alone: folding a unit rewrites the commits the units above it were built on. The whole stack is organized once, bottom-up, before any of its PRs opens.

1. Run `fbs status show <the feature>` and take its `units`. When any unit has a `pr`, the stack was organized before its first PR opened: say so and hand back.
2. Every unit must print `ok` from `fbs stamp check <unit>`; otherwise hand back (open-pr continues into verify).
3. Record each unit's branch and tip (`git rev-parse <branch>`), and the branch you're on.
4. Unit 1: `fbs branch <unit 1> --existing`, then sections 2 to 4 below with its slug, its base being the record's `branch.base`.
5. Each unit above, in order: `fbs branch <unit> --existing`, then fold it onto the folded unit below: `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash --onto <the unit below's new tip> <the unit below's recorded tip>`. That moves only this unit's own commits (merges from below drop out). Then section 3 with its slug, folding with `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <the unit below's new tip>`, and section 4: `fbs stamp check <unit>` must print `ok`, since the tree below didn't change.
6. On any conflict, failure, stamp that isn't `ok`, or a section that resets its unit (a failed reword included): `git rebase --abort` when one is running, put every unit back on its recorded tip (`git reset --hard <tip>` on the checked-out one, `git branch -f <branch> <tip>` for the others), and say the stack's history stays as it was.
7. Switch back to the recorded branch (`fbs branch <its slug> --existing`) and hand back.

## 1. Check

For a work unit, follow the stack section above; it comes here for each unit's steps.

1. Run `fbs status show <slug>` and take `dir` and `pr`. When `pr` is set, the PR is open and its history is never rewritten: say so and hand back. The current branch must be the feature's branch (the record's `branch.name`; `fbs/<slug>` in the oldest records); if not, say so and stop.
2. `fbs stamp check <slug>` must print `ok`: folding is only safe on a verified tree, because the stamp is how this stage proves the code didn't change. If it doesn't, say so and hand back (open-pr continues into verify).
3. The branch base is the record's `branch.base` (also for a branch adopted with `--use`); in older records, the one `<dir>/plan.md` records (`Branch: … branch base <sha>`), else `git merge-base HEAD <default branch>`.
4. Record the current head: `git rev-parse HEAD`.
5. If `git log --format=%s <base>..HEAD` has no `fixup!` subject, there is nothing to fold: skip to section 3.

## 2. Fold

Run `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <base>`. It is non-interactive: the editor accepts the autosquash order as is. Merge commits from parallel batches are flattened, which is fine: the tree is what counts.

- **Conflict or failure:** `git rebase --abort`, then confirm `git rev-parse HEAD` is the recorded head. Say the history stays as it was, and why, in one line, and skip to section 4: subjects are only reworded on a folded branch.

## 3. Conventional subjects

Every commit follows Conventional Commits 1.0, whatever the project's history looks like. Run `fbs commits check <slug>`. On `ok`, go on. Otherwise, for each `<sha> <subject>` line it prints, write the subject it should have had (`<type>[(<scope>)]: <description>`, the type from what the commit does, its body kept) and reword it with an empty commit that the fold applies:

`git commit --allow-empty -m 'amend! <its sha>' -m '<the new subject>' -m '<the old body, if any, trailers included>'`, writing each `'` inside as `'\''`

Then fold again (`GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <base>`) and run `fbs commits check <slug>` once more. On a failed fold, `git rebase --abort`; on a failed fold or anything but `ok`, `git reset --hard <recorded head>` and say which subjects stay unconventional. That never blocks the PR: land squash-merges under the PR's title, so only the title reaches the default branch.

## 4. Prove the code didn't change

Run `fbs stamp check <slug>`.

- `ok`: the folded branch has exactly the verified tree. Show the new history in a few lines (`git log --oneline <base>..HEAD`).
- Anything else: the tree changed, which must never ship as "the same code". Run `git reset --hard <recorded head>`, confirm `fbs stamp check <slug>` is `ok` again, and say the history stays as it was.

Never push here; open-pr pushes. Never rewrite any branch but the feature's.

## 5. End

When a calling skill (open-pr) ran this stage, hand back to it and let it carry on. Otherwise say the branch is organised and continue into open-pr: read `<plugin root>/skills/open-pr/SKILL.md` with the Read tool and follow it, with the slug and the plugin root.
