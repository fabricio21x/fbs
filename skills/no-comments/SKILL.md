---
name: no-comments
description: "Prune the comments a branch added or changed down to non-obvious whys, under the project's comment rules. Runs the comment-pruner agent, audits its report against the diff, restores any comment in a keep class, and commits."
disable-model-invocation: true
argument-hint: "[diff range, default: the branch against its base]"
---

# No comments

Most comments narrate what the code already says, and they go stale the day the code changes. Keep only what a reader would miss: a why the code can't say, a workaround's cause, a link, a warning, a required header.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: the diff range given in the arguments or by the calling skill: $ARGUMENTS

**Work from the files.** Load or read each skill, template and agent this stage names when its step comes, the way the step says, even if it ran earlier in this session. The documents hold what is settled. Once the spec is approved, anything the user says that changes it or the design, and anything this stage finds they can't hold, goes through the change path first (load `fbs:changes` with the Skill tool), so it's written down before it's acted on.

**Keep going.** Never ask the user to type a command. When this stage is done and nothing is pending (an approval, a decision, a blocker), say in one line what you're starting and continue into the next stage yourself: read its SKILL.md under `<plugin root>/skills/` with the Read tool and follow it, with the slug and the plugin root.

**Ask with the question UI.** Every question to the user, approvals and go-aheads included, goes through the AskUserQuestion tool when it is available, with what the user needs to answer shown in the chat right before it (`fbs:grilling`'s rules). Plain text only when the answer can't be options, or without the tool.

## 1. The range

1. The range is the one given, or, when none was given, the current branch against the commit it started from: the feature's `branch.base` from `fbs status show <slug>` when there's a feature, else `git merge-base HEAD <default branch>`; then `..HEAD`. Say which in one line. If the range is empty, say there's nothing to prune and stop.
2. If `git status --porcelain` isn't empty, show what's dirty and ask once (the question UI when available): commit it, ignore it locally (add it to `.git/info/exclude`, which changes nothing in the repo), or set it aside with `git stash -u` until this stage ends. Do what the user chooses and go on; never discard their changes.
3. Run the project's test command and keep the failing tests as the baseline.

## 2. Run the agent

Start one Agent call with `subagent_type: "fbs:comment-pruner"`, giving it the range. Wait for its report.

## 3. Audit the report

1. Run `git diff` (the agent's uncommitted changes) and match each hunk to a **Deleted** or **Shortened** line in its report. A change the report doesn't list is reverted, and so is any change to code rather than comments.
2. Read each deleted comment where it stood. Restore it when it falls in a keep class: a why the code can't say, a workaround with its cause, a link to an issue or spec, a warning about a non-obvious consequence, or a required header or tooling directive. The project's comment rules in `CLAUDE.md` and `.claude/rules/` win over these classes.
3. Check each shortened comment still says its why.
4. Run the project's test command and quote the summary line: comment edits should change nothing, so a failure not in the baseline means code was touched. Revert the files involved with `git checkout -- <file>`.

## 4. Commit and report

If any change survived, commit it with `refactor: prune comments in <short scope>`, no attribution lines. A calling stage pushes; run alone on a feature's branch, push it with `fbs push <slug>`.

Report the range, then each deletion, each restore with its class and reason, and each kept comment with its class.

When a calling skill (such as `implement`) ran this stage, hand the report back to it and let it carry on. Otherwise the cleanup is done; say so in one line.
