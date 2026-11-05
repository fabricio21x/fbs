---
name: polish
description: "On demand, once a feature is verified: run ponytail's review and Cursor's thermo-nuclear code-quality review on the branch, settle them into one table, apply the findings the user picks without changing behaviour, and verify again. Refuses to run, with the install commands, when either plugin is missing."
disable-model-invocation: true
argument-hint: "[feature slug]"
---

# Polish

Make a verified feature simpler without changing what it does. Two third-party rubrics do the looking: ponytail's review, which asks whether each line needs to exist, and Cursor's thermo-nuclear code-quality review, which looks for the restructure that deletes a layer. You settle them, the user picks, and the change is proved again.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: the feature slug given in the arguments or by the calling skill: $ARGUMENTS

Run every `fbs` command as its own Bash call, with nothing chained, piped or redirected.

**Work from the files.** Load or read each skill, template and agent this stage names when its step comes, the way the step says, even if it ran earlier in this session. The documents hold what is settled. Once the spec is approved, anything the user says that changes it or the design, and anything this stage finds they can't hold, goes through the change path first (load `fbs:changes` with the Skill tool), so it's written down before it's acted on.

**Keep going.** Never ask the user to type a command, except the plugin installs in step 1, which only the user can run. When this stage is done and nothing is pending (an approval, a decision, a blocker), say in one line what you're starting and continue into the next stage yourself: read its SKILL.md under `<plugin root>/skills/` with the Read tool and follow it, with the slug and the plugin root.

**Ask with the question UI.** Every question to the user, approvals and go-aheads included, goes through the AskUserQuestion tool when it is available, with what the user needs to answer shown in the chat right before it (`fbs:grilling`'s rules). Plain text only when the answer can't be options, or without the tool.

## 1. Preflight

1. Run `fbs polish check`.
   - Exit 1: show its output verbatim, say polish needs both plugins and only the user can install them, and stop. Never install or enable a plugin yourself.
   - Exit 2: report the error and stop.
   - Exit 0: take the two rubric paths from its JSON. Show a `warning:` line once, and go on.
2. The slug is the one given. With none, take the feature whose recorded branch is the current branch: for each slug `fbs status list` prints, `fbs status show <slug>` gives `branch.name` (a work unit is its own slug here). With none or several, ask which.
3. Run `fbs status show <slug>` and take `docsRoot`, `pr` and `repo`. When the record has `landed`, or it has a `pr` and `gh pr view <pr> --repo <repo> --json state` says `MERGED` (a merge outside `fbs land` isn't recorded), say that PR #<pr> is already merged and polish runs only before a feature lands, and stop. Run `fbs branch <slug> --existing` and take `branch` and `parent` (no parent: the default branch). When the current branch isn't `<branch>`, switch to it.
4. `fbs stamp check <slug>` must print `ok`.
   - A lone `dirty:` line: show the files and ask once: ignore them locally (add them to `.git/info/exclude`) or set them aside (`git stash -u`, popped before this stage hands on). Then check again.
   - Anything else: say the feature has to pass verify before it's polished, and stop. Polish works only on a tree verify proved.
5. The range is `$(git merge-base HEAD origin/<parent>)..HEAD`, or against the local `<parent>` when the repo has no remote. Say it in one line.
6. Find the test command and the type-check command, when there is one (`CLAUDE.md`, `package.json` scripts or the equivalent), and run both. Keep the failing tests as the baseline and quote both summary lines.

## 2. Review

Start two Agent calls in one message, both with `subagent_type: "fbs:polish-reviewer"`, one per rubric path. Give each the range, the repository root, its rubric path, and the absolute paths of `spec.md` and `design.md` under `docsRoot` that exist (a tiny feature or a bug may have neither). Wait for both reports.

Save both reports, unedited, to `<git common dir>/fbs/evidence/<slug>/polish/<n>/` (`git rev-parse --path-format=absolute --git-common-dir`; `<n>` is the next free number): `ponytail.md` and `thermo.md`. They stay outside the tree, so the stamp holds.

## 3. Settle

Load `fbs:principle-smallest-change` with the Skill tool. Then:

1. **Duplicates:** two findings on the same lines with the same change become one, from `both`.
2. **Check:** re-read the cited lines of every finding. Drop one whose evidence isn't there or whose change would alter behaviour, and note why.
3. **Conflicts:** when the two rubrics pull apart, the change that deletes wins. A restructure is recommended only when it deletes something (branches, layers, wrappers, lines), or when it splits a file the range pushed past 1000 lines by responsibility. A refactor that moves complexity without removing any is recommended as skip.
4. **Proportion:** a finding whose change touches code outside the range for a small gain is recommended as skip.
5. **Design:** mark a finding that changes what `design.md` (Mid: the spec's Design section) states, such as a data shape, a module boundary or the file map. Without a design, nothing is marked.

Show the result in this shape, in plain words, so the user can decide from it alone:

```
**Polish: <slug>** · `<range>` · baseline: <step 1.6's summary lines, short>

**Simplifications.** These don't change behaviour. I recommend <k> of <n>, about <lines> fewer lines.

| # | Finding | From | Change | Lines | Call |
|---|---|---|---|---|---|
| 1 | <path:line>: <what's wrong> | <ponytail, thermo or both> | <the change> | <net> | <apply or skip>: <one-line reason> |

**Dropped:** <each finding the check dropped, with why>

**Problems the reviewers found.** Polish won't fix these itself, because fixing them changes behaviour. For each one you mark "fix", I record it as a change to this feature and build it test-first as a new task. Then <what gets verified again>.

- **A. <what goes wrong, in a few plain words>** (<bug | security | data loss | missing test | slow>, <from>). <path:line>: <the concrete case: what someone does and what happens>. → I recommend **fix** | **leave**: <why>.

Reply like "1-3, fix A, leave B", or "the recommended ones".
```

- A finding step 5 marked gets `design change` in its Call, and one line under the table: a design change is applied like a fix, so the design is amended before the code.
- Leave out **Dropped** when nothing was dropped. With no problems, write `**Problems the reviewers found:** none.` and drop the fix-or-leave part of the reply line.
- Say what gets verified again: this feature, or, for a work unit whose documents are tracked, every unit not landed (the change is recorded on the lowest one, which changes every unit above it).

Nothing is applied before the answer.

## 4. Apply

Picks that change the design aren't applied here: they go through the change path with the problems marked fix (section 5), so the design is amended before the code. With nothing else picked, skip to step 6: the stamp still holds.

1. Write the other picks as one task, id `polish`: the goal "behaviour unchanged", each finding with its change, the files they touch; a new test only when a restructure leaves new logic without one.
2. Record `HEAD` as the base. One Agent call with `subagent_type: "fbs:implementer"`: the task, the absolute paths of `spec.md` and `design.md` that exist (with neither, say so: the task is the whole requirement), the branch `<branch>`, and the test and type-check commands. It commits.
3. One Agent call with `subagent_type: "fbs:reviewer"`: the task and the requirement that behaviour is unchanged, the picks as design deviations the user approved, the spec and design paths that exist (with neither, say so), the range `<base>..HEAD`, the repository root, the commands and the baseline. Never pass it the implementer's report.
4. `request-changes`: a fresh implementer gets what step 2 gave plus the blocking findings and the task's commit, then a fresh reviewer reviews `<base>..HEAD`. At most two fix rounds. When findings still block, or the implementer reports itself blocked, show them and ask once: drop the polish (`git reset --hard <base>`; nothing since the base is pushed) or keep it and fix it by hand. Dropped: go on to step 6.
5. Fold the commits since the base into one, when there are any: `git reset --soft <base>`, then commit with `refactor: polish <short scope>`, no attribution lines.
6. Pop a stash step 1.4 made. Report: the range, the test summary before and after, each applied finding as `path:line: what`, each skipped one with its reason, the design picks and the problems marked fix and where they go, and the evidence folder.

## 5. Hand on

- **Design picks or problems marked fix:** take each there now (load `fbs:changes` with the Skill tool; the user's pick is the go-ahead it asks for), then continue into implement: it builds them, and verify and the PR follow from it.
- **A work unit:** with a polish commit, read `<plugin root>/skills/verify/SKILL.md` and follow it; it hands back to assemble, which keeps the stack in order. Without one, hand back to assemble with the feature's slug.
- **Otherwise:** with a polish commit the stamp is stale, so read `<plugin root>/skills/verify/SKILL.md` with the Read tool and follow it as its calling stage; on a pass it hands back here. Then:
  - **No PR yet** (`pr` is `null`): continue into open-pr.
  - **A PR is open:** with a polish commit, run `fbs push <slug>` (on `skipped:` or `refused:`, say it in one line). If a camp watcher runs in this session, it picks the push up; otherwise continue into camp-pr.
