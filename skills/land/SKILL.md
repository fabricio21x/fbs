---
name: land
description: "Merge a feature's PR, only on the user's go: they type this command, or answer the agent's land request with a bare `land`. The PR must be approved (or, on their own solo repo, their go is the approval), green (or red only on checks they confirmed landing over), clean to merge, based on the default branch, and carry exactly the verified tree. Squash-merges with the head pinned, then restacks what was stacked on it. The agent can never land on its own."
disable-model-invocation: true
argument-hint: "[feature slug]"
allowed-tools: Bash(fbs *)
---

# Land

The one way fbs merges anything. The user's go for this PR is a one-time land token, written by a hook when they type `/fbs:land`, or when they answer a land request with a bare `land`; the `fbs land` command refuses without it. Everything else about whether the PR may merge is checked by the command, not by judgement.

Input: the feature slug given in the arguments: $ARGUMENTS

Run every `fbs` command as its own Bash call, with nothing chained, piped or redirected.

Never `gh pr merge`, the GitHub MCP's merge, or any other merge path: from the moment a PR is recorded, the guard denies them, and any force-push to its branch.

## Landing on request

When the user asks in plain words to merge or land a PR (another stage sends you here), they haven't typed the command, so ask for their go first:

1. Find the PR as step 1 says.
2. Run `fbs land request <slug>`. On `refused:` (no session, another feature's request waiting, no PR or no stamp), say why in one line and ask them to type `/fbs:land <slug>` at the start of a message.
3. Ask in plain text, last and alone in your message: "Land PR #<pr> (<slug>)? Reply `land` (or `land #<pr>`) to land it." Never through the question UI (its answer never reaches the hook) and never "reply yes". End your turn.
4. Their reply arrives with a note. "its land token is written": run step 2. A reply that isn't a bare `land` leaves the request waiting (10 minutes): if they still mean to land, repeat "Reply `land` to land it." A note that the request expired, went stale or named another PR, or a `refused:` from `fbs land`: nothing lands; say so in one line and ask them to type `/fbs:land <slug>` at the start of a message.

**Over red checks.** Only when the user asked to land despite failing or cancelled checks, run `fbs land request <slug> --over-failing` in step 2 instead. A reason (they ran them locally, CI credits ran out, flaky infra) or a plain "land anyway" both count: their ask is the reason. Never decide on your own to land over a red check. It prints `over`, each check with its `workflow` (when it has one) and `state`: `failed`, `cancelled`, or `missing` (required by the base branch, never ran). Ask with every one of them, the same way as step 3, last and alone in plain text, never through the question UI: "Land PR #<pr> (<slug>) over these checks: `CI / e2e` (cancelled), `deploy` (didn't run)? Reply `land` to land it." A `note` that none is failing: ask the plain question of step 3. `refused: wait for … to finish`: say which checks still run and ask again once they finish. A `refused:` about a waiting request with fewer checks: say so and wait for it to be answered or expire. `fbs land` then ignores only those checks; another that fails meanwhile, or a branch rule it doesn't merge past with `--admin` (anything beyond checks, reviews it verified, linear history and push rules), refuses it: show the rule. Post nothing about it on the PR.

## 1. Find the PR

The arguments may carry the user's own words after the command ("it's ready, merge it"): their first word is the slug only when `fbs status show <it>` finds that feature. Run `fbs status show <slug>` and take `pr`. No slug given: run `fbs status list` and take the one feature whose PR is open (work units count as their feature); with several, ask which. No `pr`: say there's nothing to land and stop. A feature with work units (its record lists `units`) lands one unit per go, bottom-up: `fbs land <feature>` takes its lowest unit with an open PR.

## 2. Land it

Run `fbs land <slug>` once.

- **It prints the merge** (one JSON line): say the PR is merged, with the merge commit. For a work unit, say which unit of how many landed. Then read `restack` (the branch right above) and `stacked` (units further up, and plain features cut from the landed branch). Each `done: true` was rebased onto the default branch, so its PR lists only its own commits, force-pushed once with a lease and retargeted; `treeChanged` means its stamp no longer holds, and camp verifies it again. Each `done: false` is left as it was: say its slug, `kind` and reason in one line; camp's `fbs stack sync <feature>` retries it (`not-merged-yet`, `push-rejected`, `retarget-failed`, `error`) or turns a `conflict` into a fix round for that unit. The feature is done only when its last unit lands.
- **`refused:` lines:** show each one in plain words and what would clear it: a check still running or failing (camp keeps working on it), not approved, a draft, the branch behind its base, or a head that isn't the verified tree (it needs verifying again). Never work around a refusal: no other merge path, no second try with changed arguments.
- **An error** (`gh` or git failing): report it and stop.

## 3. After

When the feature's last (or only) PR merged, the camp is over: the watcher, if one is still running, exits on its own. Say so in one line. A unit with more above it: camp keeps working the stack.
