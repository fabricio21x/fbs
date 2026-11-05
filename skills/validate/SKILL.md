---
name: validate
description: "Drive a feature's UI flows end to end in a real browser against the local app, following .fbs/validation/, and save evidence (screenshots, console and network notes) per acceptance criterion, tied to the current tree so /fbs:verify can use it."
disable-model-invocation: true
argument-hint: "[feature slug]"
allowed-tools: Bash(fbs *)
---

# Validate

Prove the feature works the way a user meets it: in the running app, in a browser. Tests show the code does what they assert; this shows the product does what the spec says.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: the feature slug given in the arguments or by the calling skill: $ARGUMENTS

Run every `fbs` command as its own Bash call, with nothing chained, piped or redirected.

**Work from the files.** Load or read each skill, template and agent this stage names when its step comes, the way the step says, even if it ran earlier in this session. The documents hold what is settled. Once the spec is approved, anything the user says that changes it or the design, and anything this stage finds they can't hold, goes through the change path first (load `fbs:changes` with the Skill tool), so it's written down before it's acted on.

**Keep going.** Never ask the user to type a command. When this stage is done and nothing is pending (an approval, a decision, a blocker), say in one line what you're starting and continue into the next stage yourself: read its SKILL.md under `<plugin root>/skills/` with the Read tool and follow it, with the slug and the plugin root.

**Ask with the question UI.** Every question to the user, approvals and go-aheads included, goes through the AskUserQuestion tool when it is available, with what the user needs to answer shown in the chat right before it (`fbs:grilling`'s rules). Plain text only when the answer can't be options, or without the tool.

## 1. Precondition

1. Run `fbs status show <slug>` and take `dir` and `docsRoot` (the feature's documents are read under it). `error: missing` or no slug: there is no feature to validate; say so and ask which one. Then run `fbs branch <slug> --existing`, so you drive the feature's branch; `refused: no branch recorded` means the work predates branch records: when the current branch isn't the default branch and holds this feature's commits, run `fbs branch <slug> --use <it>`; otherwise ask the user which branch holds it; say each `note:` in one line; on `refused:`, show it to the user and do what they choose, never discarding their changes.
2. If `.fbs/validation/README.md` doesn't exist, set it up first: read `<plugin root>/skills/setup-validation/SKILL.md` with the Read tool, follow it as its calling skill, then continue here. If it has no flow for this feature, run the setup's update path: read `<plugin root>/skills/setup-validation/SKILL.md` with the Read tool and follow it for this slug, then continue here.
3. If `git status --porcelain` isn't empty, show what's dirty and ask once (the question UI when available): commit it, or ignore it locally (add it to `.git/info/exclude`, which changes nothing in the repo). A stamp needs a clean tree, so setting it aside doesn't work here. Do what the user chooses and go on; never discard their changes. Then record `git rev-parse HEAD^{tree}` as **the tree** and `git rev-parse --short HEAD` as the commit.
4. You need browser tools: the Chrome DevTools MCP tools, or the Playwright MCP tools. With neither, say so and stop.

Load `fbs:principle-prove-it-works` with the Skill tool.

## 2. The criteria to drive

Read the acceptance criteria in `spec.md` under `docsRoot` (bug: `bug.md`; a work unit: only the ones it `covers`, by position, in its feature's spec, under the feature's `docsRoot`). Pick the ones a user meets in the UI or over HTTP: a screen, a message, a flow, an alert. Criteria that are pure logic, already covered by tests, are listed as "covered by tests, not driven".

## 3. Drive

Create the evidence folder `$(git rev-parse --path-format=absolute --git-common-dir)/fbs/evidence/<slug>/<YYYY-MM-DD-HHMM>/`. It sits outside the working tree on purpose: evidence never changes the tree it describes.

1. Launch the app as `.fbs/validation/README.md` says. If its port is already taken, check the server there runs this checkout; if you can't tell, stop and say so. Wait for readiness, run the health check, and sign in as Auth says: with a helper script or a dev-only bypass, never by typing credentials into a sign-in form. When Auth says the user signs in, ask them to and wait.
2. For each criterion, follow its flow with stable selectors. At the end state, take a screenshot into the folder, and note the console errors and failed network requests seen during the flow.
3. A criterion **passes** when the observed end state is what the criterion says. A console error or failed request that the flow didn't expect is a finding, even when the end state looks right.
4. When a flow can't be driven (a selector is gone, a step needs a person), record it as **not driven**, with why. Never mark it passed.
5. Run Cleanup, on every exit including a failure: close every page you opened in the browser tools (Chrome DevTools `close_page`, which leaves a browser's last page; Playwright `browser_close`), then stop the app. Close and stop only what you opened.

Never write a secret's value into chat, `index.md` or a screenshot. Files a browser tool writes under the repo (such as `.playwright-mcp/`) are moved into the evidence folder; `git status --porcelain` must be empty when you finish.

## 4. The index

Write `index.md` in the evidence folder:

```
# Validation: <slug>
- Tree: <the tree>
- Commit: <the commit>
- Date: <YYYY-MM-DD HH:MM>

## Criteria
- [x] <criterion, short>: <what you saw> (<screenshot file>)
- [ ] <criterion, short>: failed | not driven, <what you saw or why>
- covered by tests, not driven: <criterion, short>

## Findings
- <console errors, failed requests, anything off, each with where it happened; or None>
```

## 5. End

Report the evidence folder's path and each criterion's result. If the setup was wrong (a selector, a launch step), fix `.fbs/validation/README.md` and commit it unless git ignores it: a commit changes the tree, so validate again before verifying.

When every driven criterion passed, ask once (the question UI when available) whether to walk through the feature together first or go straight to verify, and continue into the one chosen (for a work unit, verify comes next through assemble, with the feature's slug). A failure is a change this stage found: run the change path for it (usually build level), continue into implement to fix it, and validate again after.
