---
name: unslop
description: "Remove code slop from a branch's changes without changing behaviour: needless defensive checks, type escapes, over-engineering and dead code. Runs the unslopper agent, audits its report against the diff, reverts anything that changes behaviour, and commits."
disable-model-invocation: true
argument-hint: "[diff range, default: the branch against its base]"
---

# Unslop

Make the branch's changes shorter and plainer without changing what they do. Slop is code a careful reviewer would delete: checks the types already rule out, casts that hide a type error, options nobody asked for, code nothing calls.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: the diff range given in the arguments or by the calling skill: $ARGUMENTS

**Work from the files.** Load or read each skill, template and agent this stage names when its step comes, the way the step says, even if it ran earlier in this session. The documents hold what is settled. Once the spec is approved, anything the user says that changes it or the design, and anything this stage finds they can't hold, goes through the change path first (load `fbs:changes` with the Skill tool), so it's written down before it's acted on.

**Keep going.** Never ask the user to type a command. When this stage is done and nothing is pending (an approval, a decision, a blocker), say in one line what you're starting and continue into the next stage yourself: read its SKILL.md under `<plugin root>/skills/` with the Read tool and follow it, with the slug and the plugin root.

**Ask with the question UI.** Every question to the user, approvals and go-aheads included, goes through the AskUserQuestion tool when it is available, with what the user needs to answer shown in the chat right before it (`fbs:grilling`'s rules). Plain text only when the answer can't be options, or without the tool.

## 1. The range and a baseline

1. The range is the one given, or, when none was given, the current branch against the commit it started from: the feature's `branch.base` from `fbs status show <slug>` when there's a feature, else `git merge-base HEAD <default branch>`; then `..HEAD`. Say which in one line. If the range is empty, say there's nothing to clean and stop.
2. The audit in step 3 needs a clean starting point. If `git status --porcelain` isn't empty, show what's dirty and ask once (the question UI when available): commit it, ignore it locally (add it to `.git/info/exclude`, which changes nothing in the repo), or set it aside with `git stash -u` until this stage ends. Do what the user chooses and go on; never discard their changes.
3. Find the test command and the type-check command, when there is one (`CLAUDE.md`, `package.json` scripts or the equivalent), and run both. Keep the failing tests as the baseline: cleanup must add no failure to it.

## 2. Run the agent

Start one Agent call with `subagent_type: "fbs:unslopper"`. Give it the range, the test and type-check commands, the baseline, and the paths of the feature's `spec.md` and `design.md` when they exist. Wait for its report.

## 3. Audit the report

The agent's report is a claim, not a result. Load `fbs:principle-boundary-discipline` with the Skill tool, then check the report against the working tree before accepting anything:

1. Run `git diff` (the agent's uncommitted changes) and match each hunk to a **Removed** line in its report. A change the report doesn't list is reverted.
2. For each removal, read the code around it and keep it only when it is one of the four classes and doesn't change behaviour:
   - a check is needless only when a type or an earlier boundary parse really rules the case out; validation where outside data enters (`principle-boundary-discipline`), a documented default, or error handling a caller relies on is never slop;
   - a cast or `any` is removable only when the code still type-checks without it;
   - nothing an acceptance criterion needs is over-engineering.
   Revert each removal that fails by restoring its lines with Edit, from `git diff`; `git checkout -- <file>` reverts a whole file. Never `git checkout -p`: without a terminal it silently does nothing. Note why for each.
3. Run the type check and the test command. Quote both summary lines. A failure not in the baseline reverts the removals in the files involved; then run both again.

## 4. Commit and report

If any removal survived, commit it with `refactor: remove slop from <short scope>`, no attribution lines. A calling stage pushes; run alone on a feature's branch, push it with `fbs push <slug>`.

Report:

- the range, and the test summary before and after;
- each kept removal, as `path:line (class): what`;
- each reverted removal, with the reason;
- the agent's **Left** list, unchanged.

When a calling skill (such as `implement`) ran this stage, hand the report back to it and let it carry on. Otherwise continue into no-comments.
