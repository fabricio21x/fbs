---
name: implement
description: "Build a feature whose design is approved: a task graph in plan.md, each task done test-first by an implementer agent and reviewed blind by a reviewer agent (two fix rounds at most, then escalate), cleanup with unslop and no-comments, then a final review of the whole change. Works on the feature's branch and pushes it as it goes; never opens a PR or merges."
disable-model-invocation: true
argument-hint: "[feature slug]"
allowed-tools: Bash(fbs *)
---

# Implement

Turn an approved design into reviewed, tested commits. You orchestrate: implementers write the code, reviewers judge it blind, and you keep the plan, the branch and the decisions. You write no product code yourself.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: the feature slug given in the arguments or by the calling skill: $ARGUMENTS

Run every `fbs` command as its own Bash call, with nothing chained, piped or redirected.

**Work from the files.** Load or read each skill, template and agent this stage names when its step comes, the way the step says, even if it ran earlier in this session. The documents hold what is settled. Once the spec is approved, anything the user says that changes it or the design, and anything this stage finds they can't hold, goes through the change path first (load `fbs:changes` with the Skill tool), so it's written down before it's acted on.

**Keep going.** Never ask the user to type a command. When this stage is done and nothing is pending (an approval, a decision, a blocker), say in one line what you're starting and continue into the next stage yourself: read its SKILL.md under `<plugin root>/skills/` with the Read tool and follow it, with the slug and the plugin root.

**Ask with the question UI.** Every question to the user, approvals and go-aheads included, goes through the AskUserQuestion tool when it is available, with what the user needs to answer shown in the chat right before it (`fbs:grilling`'s rules). Plain text only when the answer can't be options, or without the tool.

## 1. Precondition and resume

Run `fbs status show <slug>` and take `size`, `dir`, `docs` and `docsRoot`. The feature's documents (`plan.md`, `changes.md`) are written under `docsRoot`, the absolute path of `dir`, and every commit of them below is made only when `docs` is `tracked` (`local`: git ignores them).

- `error: missing` or no slug: there is no feature yet. Continue into plan with the user's input. Any other `error:` line or exit 2: report it and stop.
- **Big** needs `approvals.spec` and `approvals.design` both `current: true`; **Mid** needs `approvals.spec` `current: true`. Otherwise continue into architect (or plan, when the spec approval is what's missing); they come back here.
- **Tiny** or **bug:** this stage isn't for them. Tiny: implement directly, test-first. Bug: continue into tdd.
- **A feature with work units** (the record lists `units`): it ships as a stack, one unit at a time. Continue into assemble with the slug; it runs this stage on the lowest unit not built yet.
- **A work unit** (the record has `unitOf`): its approvals are the feature's (`status show` prints them) and its spec and design are the feature's (`fbs status show <unitOf>` gives the feature's `dir` and `docsRoot`); `dir` is the unit's own folder, for its `plan.md`. It builds only its part of the design: the criteria it `covers` (by position in the spec: `AC2` is the second criterion) and the files its `### U<n>` section lists. **Ranges** below written `<branch base>..HEAD` are `$(git merge-base HEAD <parent branch>)..HEAD` for a unit, so the units below are never reviewed again here.
- **A camp watcher running** (a unit below already has its PR open): when it wakes you mid-build, finish the task in progress, handle the round with camp-pr (from its step 3), then carry on here.

Load `fbs:principle-guard-the-context` and `fbs:principle-smallest-change` with the Skill tool. You keep reports and decisions in this thread; agents do the reading and the writing.

## 2. Branch, commands and baseline

1. If `git status --porcelain` isn't empty, show what's dirty and ask once (the question UI when available): commit it, ignore it locally (add it to `.git/info/exclude`, which changes nothing in the repo), or set it aside with `git stash -u` until this stage ends. Do what the user chooses and go on; never discard their changes.
2. Run `fbs branch <slug> --type feature`; say each `note:` in one line; on `refused:`, show it to the user and do what they choose, never discarding their changes. Its JSON gives the feature's branch (written `<branch>` below), its parent and the **branch base**. It switches to the branch plan created, or creates `feature/<slug>` from the remote's default branch for a feature that has none yet. When the spec or design says this feature builds on another feature's unmerged work and the recorded parent isn't that feature's branch, pass `--parent <that branch>`: it moves the unpushed branch onto it.
3. **Resume:** if `<dir>/plan.md` exists on this branch, read it and take the branch base, commands and baseline from it. Continue from the first task that isn't `done`; don't rewrite the plan. Tasks the change path added are already in it; when there are new ones, reopen the cleanup and the final review. Show section 3's overview with each row's status, then skip to section 4.
4. **Review round** (called from camp-pr with fixes from PR review): build and review only the new tasks (section 4); run cleanup (section 5) on `<round base>..HEAD` only; skip the final review (the PR's reviewers are it); then hand back to camp-pr, which verifies and pushes.
5. Find the test command and the type-check command (`CLAUDE.md`, `package.json` scripts or the equivalent). Ask once for what you can't find.
6. Run both, and record the tests that already fail as the baseline.

## 3. Plan

Read `${CLAUDE_SKILL_DIR}/plan-template.md` (if unexpanded: `<plugin root>/skills/implement/plan-template.md`) and write `<dir>/plan.md` from the design's file map and test seams (Mid: the spec's Design section; a unit: only its own section's files and the criteria it covers), replacing each guidance comment with its content. Every acceptance criterion (a unit: every one it covers) is served by at least one task, and every `open` or `planned` build-level entry in `<dir>/changes.md` becomes a task too.

**Scope check, then workers:**

- One at a time when the tasks form a chain, or are few and small: say so.
- Parallel batches only for tasks whose dependencies are all done and that share no file. Two tasks touching the same file never run in one batch, even when the graph says they're independent. UI tasks never run in a batch: they share one browser and one dev-server port, and a worktree has no installed dependencies.

Commit `plan.md` when tracked (`docs: implementation plan for <slug>`); with local documents there is no plan commit, so the `--fixup` commits below don't apply either. The plan needs no approval, but the user sees all of it before the first task starts: show this overview in the chat, every task a row, and go on.

```
**Plan: <slug>**: <n> tasks, <one at a time | up to N in parallel>, because <the scope check in a few words>

| # | Task | Serves | After | UI |
|---|------|--------|-------|----|
| T1 | <goal in a few words> | <criteria, short> | – | |
| T2 | <goal in a few words> | <criteria, short> | T1 | yes |
| – | Cleanup (unslop, no-comments), then the final review | all | every task | |
```

When a task-tracking tool is available (TaskCreate and TaskUpdate, or TodoWrite), also add one item per task, one for the cleanup and one for the final review, and mark each in progress when it starts and done when it ends. It is a live view only: `plan.md` stays the record you resume from.

## 4. Each task

Take tasks in dependency order. Agent calls run in the background: **wait for each report before the next step, and for a batch wait for every report; never act on a partial set.** A report is an agent's last message: nothing follows it. One that isn't a report (empty, `pending`, a progress note, no `**Task:**` line) means the agent stopped early: check `git log` for its commit, then ask it for its full report with SendMessage (it resumes with its context) and wait for that. Never end your turn waiting on an agent that already reported.

1. **Implement.** Record `HEAD` as the task's base. One Agent call with `subagent_type: "fbs:implementer"`, or `"fbs:ui-implementer"` for a task marked UI, which also gets the absolute evidence folder `$(git rev-parse --path-format=absolute --git-common-dir)/fbs/evidence/<slug>/ui/<task id>/`. Give it the task (id, goal, files, the criteria it serves, dependencies), the absolute paths of `spec.md` and `design.md` under `docsRoot` (a worktree agent has no copy of local documents), for a UI task also the absolute mockups folder `<docsRoot>/mockups/` (a unit: the feature's), the branch `<branch>`, and the test and type-check commands.
   - **Parallel batch:** record `git rev-parse HEAD` as the batch base, and make sure `.claude/worktrees/` is listed in `$(git rev-parse --git-common-dir)/info/exclude` (append it once if not), so worktrees never make this checkout dirty. Start one call per task in a single message, each with `isolation: "worktree"`, no branch, and the batch base: a worktree agent may start from the default branch, and resetting to the batch base gives it this branch's work. When all have reported, integrate them **one at a time, in plan order**: record `HEAD` as the task's base, `git merge --no-ff <its branch>`, then run steps 2 to 5 for that task here on `<branch>` before merging the next. On a conflict, `git merge --abort` and redo that task alone on the feature branch. After a task is settled, `git worktree remove <its path>` and `git branch -d <its branch>`.
2. **Blocked** report: restore the files it lists as uncommitted (`git restore` for tracked files, delete the new ones it names; for a worktree task, `git worktree remove --force <its path>`), stop the run, and show the decision it needs (the question UI when available). If the answer only settles how to build it, record it in `plan.md` and go on. If it changes the spec or the design, run the change path with it, then go on with the plan.
3. **Review.** One Agent call with `subagent_type: "fbs:reviewer"`. Give it the task, the criteria it serves, the absolute paths of `spec.md` and `design.md` under `docsRoot` (for a UI task, the mockups folder too), the range `<task base>..HEAD`, the repository root as the directory, the commands and the baseline. Never pass it the implementer's report; for a UI task, pass only its screenshot paths.
4. **`request-changes`:** a fresh implementer of the same kind gets everything step 1 gives plus the blocking findings and the task's commit (the one with its `Task:` trailer), then a fresh reviewer reviews `<task base>..HEAD` again. At most two fix rounds. If findings still block, mark the task `escalated`, list the findings under Escalations, skip the tasks that depend on it, and go on with the rest.
5. **`approve` or `approve-with-comments`:** mark the task `done`, with its verdict, rounds, non-blocking findings and deviations in `plan.md`. When it was built for a change, and that change's tasks are all done, mark its `changes.md` entry `done`.

**Progress in the chat** is one line per settled task, `✓ T<n> (<done>/<total>) <goal> · <verdict>, <rounds> fix rounds · <short sha>` (`✗` and `escalated` or `blocked` when it is), plus at most one line under it for a deviation or a finding the user should know. Nothing more while a task is running: the detail lives in `plan.md`, and what needs the user comes as a question.

Commit `plan.md` (when tracked) after each task as a fixup of the plan's first commit (`git commit --fixup=<that commit>`) while the PR isn't open yet, so organizing the branch folds it into the plan; once the PR is open, a plain commit. Then push it with `fbs push <slug>`: the feature's branch is pushed whenever it gets commits, so the work is backed up and visible. Say a `skipped:` or `refused:` from it in one line; it never blocks this stage. In a review round, don't push: camp-pr pushes once for the round.

**Changes while building.** When the user gives feedback, or building shows the spec or design can't hold (a spike result, a provider limit, a wrong assumption), load `fbs:changes` and follow it right there, then continue with the plan, new tasks included. A spike the plan includes runs in the background under your watch (Bash `run_in_background` or Monitor); ask the user only for steps only they can do, such as one in their own browser, and tell them what to look for.

When a task is escalated, ask the user what to do with its findings (the question UI when available): fix them another way, accept them, or drop the task. Their answers go through the change path when they change the spec or design. Skip steps 5 and 6 while anything is still escalated or blocked: the final review would otherwise ask for that work and bypass the stopping rule.

## 5. Cleanup

Read `<plugin root>/skills/unslop/SKILL.md` with the Read tool and follow it as its calling skill, with the range `<branch base>..HEAD`. Then do the same with `<plugin root>/skills/no-comments/SKILL.md`. Never call them through the Skill tool.

## 6. Final review

One fresh reviewer over `<branch base>..HEAD` (once the PR is open, the base is `git merge-base HEAD origin/<base>`), given every acceptance criterion in the spec (a unit: the ones it covers, and its `### U<n>` section), the design's absolute path under `docsRoot`, the repository root as the directory, the commands, the baseline, and any deviation the user approved in step 4. Fix rounds and escalation as in step 4, with the findings as a task called `final`: its first fix commit is a plain commit with a `Task: final` trailer, and later rounds fix that one up. Record the outcome under Final review.

## 7. End

**Project notes** (not in a review round). Look back over what building this feature taught about working in this repo that the next feature would trip on again: a test or tool quirk, a command that needs a flag, an environment limit, a convention the reviewers kept enforcing. Find them in `plan.md`'s notes, deviations and escalations, in blocked reports, and in changes driven by a technical limit. Keep only lasting, repo-wide lines that `CLAUDE.md` doesn't already say. Never a detail of this feature or a fact only one file cares about. A business fact goes to `.fbs/context.md` through `fbs:principle-check-the-facts`, and a launch or sign-in quirk goes to `.fbs/validation/README.md`. With nothing left, skip this.

Otherwise show the lines in the chat, each under the `CLAUDE.md` it goes in (the closest one to what it's about: the root's, or a package's own) and the section it fits, and in the same message ask with `fbs:grilling`'s approval question (`header`: `CLAUDE.md`). On approval, add them in that file's style, commit (`docs: project notes from <slug>`) and push with `fbs push <slug>`. Leave out any line the user rejects. With no human to answer, write nothing and list the lines in the report.

Commit `plan.md` (when tracked) as a fixup of the plan's first commit (`git commit --fixup=<that commit>`) while the PR isn't open yet, so organizing the branch folds it into the plan; once the PR is open, a plain commit, and push it with `fbs push <slug>` (not in a review round). Then report:

- the overview table again with an `Outcome` column (the verdict and fix rounds, or `escalated` or `blocked` with what it needs from the user), the final review its last row;
- the suite and type check on the final tree, quoted;
- non-blocking findings worth a look, at most five.

**A change that belongs to a unit below** (a reviewer or the user finds the bug or the gap in code a lower unit owns): it goes into that unit, never into this one. Run the change path for it with the lower unit's slug (`fbs branch <lower unit> --existing`, a task in its `plan.md`, built and reviewed there), then run `fbs stack sync <the feature>` to merge it forward into every unit above (a conflict it reports is a task for that unit), `fbs branch <this unit> --existing`, and carry on here.

For a unit, hand back to assemble with the feature's slug when nothing is escalated or blocked: it builds the next unit, and validates and verifies the stack once every unit is built.

When nothing is escalated or blocked, continue into validate when an acceptance criterion is a UI flow (it sets up validation first when `.fbs/validation/` is missing), otherwise into verify. Never open a PR or merge here, and never push the default branch.
