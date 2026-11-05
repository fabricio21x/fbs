---
name: setup-validation
description: "Once per project: work out how an agent launches the app, checks it is healthy, signs in and drives its flows, write it to .fbs/validation/README.md, and prove it by running it end to end once. /fbs:validate and /fbs:walkthrough depend on it."
disable-model-invocation: true
argument-hint: "[optional: the feature whose flows to add]"
---

# Setup validation

Teach agents to run this project the way a person would: start it, see it's up, sign in, and use its features. A setup that was never run is a draft; this stage isn't done until it has run once and left evidence.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input, optional: a feature slug whose flows to add: $ARGUMENTS

**Work from the files.** Load or read each skill, template and agent this stage names when its step comes, the way the step says, even if it ran earlier in this session. The documents hold what is settled. Once the spec is approved, anything the user says that changes it or the design, and anything this stage finds they can't hold, goes through the change path first (load `fbs:changes` with the Skill tool), so it's written down before it's acted on.

**Keep going.** Never ask the user to type a command. When this stage is done and nothing is pending (an approval, a decision, a blocker), say in one line what you're starting and continue into the next stage yourself: read its SKILL.md under `<plugin root>/skills/` with the Read tool and follow it, with the slug and the plugin root.

**Ask with the question UI.** Every question to the user, approvals and go-aheads included, goes through the AskUserQuestion tool when it is available, with what the user needs to answer shown in the chat right before it (`fbs:grilling`'s rules). Plain text only when the answer can't be options, or without the tool.

## 1. What exists

- If `.fbs/validation/README.md` exists and a feature was given, this is an update: add that feature's flows (step 3), run them once (step 4), and keep the rest.
- If it exists and nothing was given, say it's set up, show its "Verified end to end" line, and stop.
- The setup is committed on the feature's branch, never on the default branch unless the user explicitly asked. A calling stage is already on it. Run alone for a feature: `fbs branch <slug> --existing`. Run alone with no feature, it's a tiny change of its own: `fbs status init validation-setup --size tiny`, then `fbs branch validation-setup --type chore`. Say each `note:` in one line; on `refused:`, show it to the user and do what they choose.
- Load `fbs:principle-prove-it-works` with the Skill tool.

## 2. Find out from the repo first

Read `CLAUDE.md`, the README, `package.json` scripts (or the equivalent), env examples (`.env.example`), and the app's entry points. Work out:

- the launch command, the port or URL, and a readiness signal;
- a health check;
- how sign-in works, and whether a test account or a dev-only bypass exists;
- the features worth driving: the ones the open feature specs under `docs/features/` name, at most five.

Ask the user only for what the repo can't tell you (a test account's credentials, which env var holds them), one question round with the question UI when available. Never ask for a secret's value in chat: ask for the env var or file that holds it.

## 3. Write the setup

Read `${CLAUDE_SKILL_DIR}/validation-template.md` (if unexpanded: `<plugin root>/skills/setup-validation/validation-template.md`) and write `.fbs/validation/README.md`, replacing each guidance comment with its content. Put any helper script in `.fbs/validation/` and make it executable. Selectors are stable ones (test ids, roles, labels), read from the code, not guessed.

## 4. Prove it once

1. Launch the app as Launch says, in the background, and wait for the readiness signal with its timeout. If the port is already taken, stop and say so.
2. Run the health check, and quote its result.
3. Drive one flow end to end with the browser tools: the Chrome DevTools MCP tools when they're available, otherwise the Playwright MCP tools. With neither, say so, prove launch and health only, and mark Flows as unverified.
4. Save a screenshot of the flow's end state to the evidence folder: `$(git rev-parse --path-format=absolute --git-common-dir)/fbs/evidence/setup/<YYYY-MM-DD-HHMM>/`.
5. Run Cleanup, on every exit including a failure: close every page you opened in the browser tools (Chrome DevTools `close_page`, which leaves a browser's last page; Playwright `browser_close`), then stop the app. Close and stop only what you opened.

Sign-in never types credentials into a form: use a helper script or a dev-only bypass, or ask the user to sign in and wait. Never write a secret's value into a file or chat. Files a browser tool writes under the repo (such as `.playwright-mcp/`) move to the evidence folder.

When a step fails, fix the setup and run it again, at most twice per step; then report what fails and stop without claiming the setup works.

## 5. Commit and end

Fill in "Verified end to end" with today's date and what ran. Commit `.fbs/validation/` (`chore: validation setup`, no attribution lines), unless git ignores it (`git check-ignore -q .fbs/validation/` exits 0): then it stays local. Report what ran and the evidence path. When a calling skill (such as `validate`) ran this stage, hand back to it and let it carry on. Otherwise, when a feature is waiting, continue into validate for it.
