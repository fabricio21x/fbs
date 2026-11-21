---
name: land
description: "Merge a feature's PR, only on the user's go: they ask in plain words (\"go ahead and merge it\", \"land the PR\"), answer the agent's land question with a yes, or type this command. The PR must be approved (or, on their own solo repo, their go is the approval), green (or with no checks at all when the base branch requires none, or red only on checks they confirmed landing over), clean to merge, based on the default branch, and carry exactly the verified tree. Squash-merges with the head pinned, then restacks what was stacked on it. A PR in a GitHub stack is merged by the user with GitHub's one command instead. The agent can never land on its own."
disable-model-invocation: true
argument-hint: "[feature slug]"
allowed-tools: Bash(fbs *)
---

# Land

The one way fbs merges anything. The user's go for this PR is a one-time land token that a hook writes from their own message: when they ask in plain words to merge or land it, when they answer your land question with a yes, or when they type `/fbs:land`. The `fbs land` command refuses without it. Everything else about whether the PR may merge is checked by the command, not by judgement.

Input: the feature slug given in the arguments, or the one the hook's note names: $ARGUMENTS

Run every `fbs` command as its own Bash call, with nothing chained, piped or redirected.

Never `gh pr merge`, `gh stack merge`, the GitHub MCP's merge, or any other merge path: from the moment a PR is recorded, the guard denies them, and any force-push to its branch.

## The user's go

- **They asked in plain words** ("go ahead and merge it", "land #12", "ship it"): their message arrives with a note from fbs. "a land token for it is written": decide whether they are asking you to land that PR. If now, go to step 2 with the slug the note names; don't ask again, their message is the go. If once something fbs land checks itself holds ("merge it once CI is green", "land it when it's approved"), the go stands: run step 2 now, and on a refusal for a check still running or a missing approval, run it again when camp's watcher reports green or approved, without asking. The token lasts until their next message that doesn't ask to land; if they've moved on since, ask as below. If not a go at all (a question about merging, "merge it after the copy fix", another PR), don't land: answer them, do what they asked first, then ask as below. A note that several PRs are open: ask which in one line, then ask as below for that one. A note that it has no verify stamp: say it needs verifying first (another stage sends you there). They asked to land and no note arrived, or the note says no token was written: ask as below.
- **To ask first** (you're unsure which PR they mean, they asked for a condition that now holds, or another stage wants their go): run `fbs land request <slug>`, then ask in plain text, last and alone in your message: "Land PR #<pr> (<slug>)?" Never through the question UI (its answer never reaches the hook). End your turn. Their yes ("yes", "go ahead", "yes, land it anyway") arrives with a note "its land token is written": go to step 2. Anything else they say drops the request; ask again later if it still applies, once, not on every watcher wake. On `refused:` from the request (no session, another feature's request waiting, no PR or no stamp), say why in one line. When it prints `requested: false` with a `stack`, read "A GitHub stack" below instead: there is nothing to ask.
- A note that the request expired, went stale or named another PR, or a `refused:` from `fbs land` about the token: nothing lands; say so in one line and ask again.

**Over red checks.** Only when the user asked to land despite failing or cancelled checks, run `fbs land request <slug> --over-failing`. A reason (they ran them locally, CI credits ran out, flaky infra) or a plain "land anyway" both count: their ask is the reason. Never decide on your own to land over a red check. It prints `over`, each check with its `workflow` (when it has one) and `state`: `failed`, `cancelled`, or `missing` (required by the base branch, never ran). Ask with every one of them, last and alone in plain text: "Land PR #<pr> (<slug>) over these checks: `CI / e2e` (cancelled), `deploy` (didn't run)?" A `note` that none is failing: ask the plain question. `refused: wait for … to finish`: say which checks still run and ask again once they finish. A `refused:` about a waiting request with fewer checks: say so and wait for it to be answered or expire. `fbs land` then ignores only those checks; another that fails meanwhile, or a branch rule it doesn't merge past with `--admin` (anything beyond checks, reviews it verified, linear history and push rules), refuses it: show the rule. Post nothing about it on the PR.

## 1. Find the PR

The arguments may carry the user's own words after the command ("it's ready, merge it"): their first word is the slug only when `fbs status show <it>` finds that feature. Run `fbs status show <slug>` and take `pr`. No slug given: run `fbs status list` and take the one feature whose PR is open (work units count as their feature); with several, ask which. No `pr`: say there's nothing to land and stop. A feature with work units (its record lists `units`) lands one unit per go, bottom-up: `fbs land <feature>` takes its lowest unit with an open PR.

## 2. Land it

Run `fbs land <slug>` once.

- **It prints the merge** (one JSON line, `merged: true`): say the PR is merged, with the merge commit. `checks: "none"`: add that no CI ran on it (the repo has none and the base branch requires none), so it landed on the local verify alone. For a work unit, say which unit of how many landed. Then read `restack` (the branch right above) and `stacked` (units further up, and plain features cut from the landed branch). Each `done: true` was rebased onto the default branch, so its PR lists only its own commits, force-pushed once with a lease and retargeted; `treeChanged` means its stamp no longer holds, and camp verifies it again. Each `done: false` is left as it was: say its slug, `kind` and reason in one line; camp's `fbs stack sync <feature>` retries it (`not-merged-yet`, `push-rejected`, `retarget-failed`, `error`) or turns a `conflict` into a fix round for that unit. The feature is done only when its last unit lands.
- **It prints `merged: false` with a `stack`:** the PR is in a GitHub stack, read "A GitHub stack" below.
- **`refused:` lines:** show each one in plain words and what would clear it: a check still running or failing (camp keeps working on it), not approved, a draft, the branch behind its base, required checks that never ran, or a head that isn't the verified tree (it needs verifying again). Never work around a refusal: no other merge path, no second try with changed arguments.
- **An error** (`gh` or git failing): report it and stop.

## A GitHub stack

When the PR is in a GitHub stack with other open PRs, fbs merges nothing: GitHub merges the stack in one step and restacks what's left, which landing PR by PR would only redo. `stack` holds its `number`, each open PR bottom-up (`pr`, `slug`, `ready`, and `reasons` when it isn't), `upTo` (the highest PR with only ready PRs below it) and `command`. Tell the user in a few lines: which PRs merge together (the lowest open one up to #`upTo`), each not-ready PR above with its reasons, and that they merge it themselves, with the command in a block they can run (`! <command>` in this chat, or in their terminal), or with the merge button on PR #`upTo` on GitHub, which brings every PR below it along. You never run it: the guard denies `gh stack merge`. Then end your turn.

When they say it's merged (or their `!` command's output shows it), run `fbs stack sync <slug>` for the feature (for plain features stacked on each other, each one's slug): it records every PR merged outside `fbs land` as landed and syncs what's left. Report what it recorded, then go on as step 3 says.

## 3. After

When the feature's last (or only) PR merged, the camp is over: the watcher, if one is still running, exits on its own. Say so in one line. A unit with more above it: camp keeps working the stack.
