# Autopilot: /fbs:afk

`/fbs:afk` works a well-defined task while you are away. You approve its finish line once. After that the agent makes the steps and the `fbs` CLI decides: it runs the checks, judges the rubric with a model of its own, keeps or discards each step, and decides when the run stops. The run ends in a reviewed, verified pull request. It never merges, deploys or touches production.

**Contents:** [Eligibility](#eligibility) · [The one approval](#the-one-approval) · [Checks](#checks) · [The CLI owns the finish line](#the-cli-owns-the-finish-line) · [Keep or discard](#keep-or-discard) · [afk-guard](#afk-guard) · [The guard and the Stop hook](#the-guard-and-the-stop-hook) · [The end](#the-end) · [Stops](#stops) · [Known limits](#known-limits)

## Eligibility

A task is eligible only when both hold:

- **Its finish line can be stated as checks:** a command with an exit code or a number to reach, or a rubric whose every criterion can be seen in the code or in a command's output.
- **The work stays in code:** a page, a screen, SEO, performance, a feature that needs few decisions, a rebase.

It refuses a data migration, a new dependency or technology, an infra, deploy or stack change, anything involving money or production data, and anything that needs a product decision. It says why in one line and points you to `/fbs:assemble`, which plans the work with you.

```
/fbs:afk get the Lighthouse SEO score of the public pages to 95 or more
/fbs:afk every page under app/(public)/ exports metadata with a unique title and description
```

## The one approval

Before asking anything, the run:

1. **Preflights your safety settings** (`fbs afk preflight`): whether your Claude Code settings deny `gh pr merge` and pushes to the default branch, and whether GitHub protects that branch. It warns, with the exact `permissions.deny` lines to add, and never blocks.
2. **Creates a record and a branch** for the task. If the checkout is dirty, it asks once whether to commit or stash your changes; it never discards them.
3. **Records the test baseline:** the tests that already fail, so they don't count against the run.
4. **Drafts the run:** the goal, the checks, the scope (globs the work may touch), the protected files (globs the run may never change: existing tests, the check scripts, anything the finish line rests on), and the budgets. It runs each command check once to show today's value.

Then it shows the whole run in one table and asks for one `Approve`. It never starts without it. Requested changes produce a new proposal and a new approval. Once approved, it asks nothing until the run stops.

| Budget | Default |
|---|---|
| `maxIterations` | 30 |
| `maxDiscardsInRow` | 5 |
| `checkTimeoutSec` (per command or judge call) | 600 |
| `judgeUsdPerCall` | 0.5 |

The approval shows the worst-case judge cost: one baseline vote, two votes per iteration and two at the end, per judged check.

## Checks

Every check must pass for the run to be met. A command check is used wherever one exists; a judged check covers the rest.

**Command checks.** A shell command run from the repo root. It passes on exit 0, or, with a `metric` regex and a `target`, when the number it prints reaches the target (`min`: at least, `max`: at most). A Lighthouse score, a lint count, a bundle size, the test suite. When the suite passes today, it is added as a check so no step can break it. A check on the running app is a script that launches the app on a free port, runs a pinned tool version, writes everything to a temp dir, and prints only what the checks need.

**Judged checks.** A rubric of criteria that a model started by the CLI checks against the code and this iteration's command output. Each criterion must be observable: "every page under `app/(public)/` exports metadata with a unique title", never "looks good". The judge:

- can only read files (no shell, no browser, no MCP);
- sees the last 4000 characters of each command's output, so anything about the running app needs a command that prints it;
- runs only while every command check passes;
- passes only on two votes on the same tree.

## The CLI owns the finish line

The working agent never writes a verdict.

- **The CLI spawns the judge.** `fbs afk check` runs `claude -p` itself, in the worktree, with read-only tools, a JSON schema, a cost cap per call and its own process group.
- **Verdicts are cached per tree.** Each vote is stored by check, tree hash and vote number, and bound to the rubric. Checking the same tree again reuses them, and the final measurement of the kept tree costs nothing.
- **Two votes.** Vote 1 runs when the command checks pass. Vote 2, a fresh independent call, runs only when everything else passes on vote 1. A judged check is met only when both pass.
- **A judge error holds.** When a judge call fails (a timeout, an answer that doesn't fit the schema, a judge that can't start), that is not a verdict. The step is `held`: nothing is kept, discarded or reset, and the same commit is checked again. Three holds in a row stop the run.
- **The spec is frozen.** The CLI keeps its own copy of the approved run. The run's state lives outside the tree, the guard denies writes to it, and a change made outside fbs stops the run (`state-changed`).
- **Checks can't write state.** A check that leaves a file in the repo produces a warning, and the next check refuses a dirty tree.

## Keep or discard

Each iteration the agent makes the smallest step the evidence justifies, commits it, and runs `fbs afk check`. The decision is the CLI's:

| Decision | Meaning |
|---|---|
| `kept` | A check moved toward its target and none moved away |
| `discarded` | Otherwise. The CLI resets the branch to the last kept commit itself |
| `held` | A judge call failed. Nothing changes; check the same commit again |
| `stopped` | A stop rule fired |

A plateau means change approach, not stop: after three discards in a row the agent steps back and tries a different idea. It never edits the protected files, the checks or the run's spec, and never relaxes a check. Messages you send during the run get a short answer, then the loop goes on; a change to the goal or the checks stops the run and starts a new proposal.

## afk-guard

`fbs afk-guard` runs on the run's diff since its start before every check. Any flag stops the run and leaves the flagged commit in place for you to review.

| Flag | Raised when |
|---|---|
| `out-of-scope` | A file outside the run's scope changed |
| `protected` | A protected file changed |
| `migration` | A migration or schema file changed |
| `infra` | Infrastructure or deploy config changed |
| `check-config` | Test, lint or check config changed, in a file or in a manifest |
| `dependency` | A manifest adds a dependency, a lockfile or submodule changed, or a manifest doesn't parse |
| `test-weakening` | A test file was deleted, renamed out of the test patterns or emptied of readable changes; or, heuristically, assertions or test cases were removed or skipped |

Heuristic flags say so and may be false positives. Projects add their own globs with `afk.migrations`, `afk.infra` and `afk.checkConfig` in `.fbs/config.json`.

## The guard and the Stop hook

**The guard.** From the run's start until `fbs land` marks it landed or it is stopped, the `PreToolUse` guard is on for the repo. For every call it denies writes to the run's protected files, to the autopilot state under `<git common dir>/fbs/afk/`, and to Claude Code's settings and hooks. For the run's own calls it also denies merges, pushes to the default branch and force pushes, deploy and production CLIs and deploy-named package scripts, the commands in `afk.deny`, and, while the run is running, history rewrites: amend, rebase, stash, switching branches, resets.

**The Stop hook.** The run is bound to the session that started it. At the end of every turn, the Stop hook blocks that session from stopping and tells it how to go on, unless something will wake it: a scheduled wakeup, a background agent or workflow, or fbs's own background commands. When a block already let the session continue and no check ran since, it lets the stop through and records the run as paused; `/fbs:afk <slug>` or `/fbs:assemble` resumes it. With no running run it exits at once. Any failure lets the session stop.

You can move the session to the background with `/bg`. Your checkout stays on the run's branch until the run stops; to keep your main checkout free, start the autopilot session in its own worktree (`claude -w`).

## The end

When every check is met:

1. **Final review.** A fresh blind reviewer reviews the whole branch against the goal and the checks, with implement's fix rounds. Findings against the frozen checks are out of bounds.
2. **Final measurement.** `fbs afk final` runs afk-guard and every check on the reviewed tree, judged checks on both votes, and writes an evidence index that verify reads.
3. **Report.** Each check's baseline and final value, iterations kept and discarded, the judge cost, and an attention list: flags, heuristic notes, preflight warnings, criteria that passed narrowly, and what only a human can check by eye.
4. **Verify, open-pr, camp-pr** run as usual. Verify takes the approved goal as the outcome, so it doesn't ask again. If a review fix changes the code, verify re-runs `fbs afk final` for fresh evidence.

The run never merges. You land it with `/fbs:land` like any other PR.

## Stops

| Rule | Why it stopped |
|---|---|
| `met` | Every check passed; the run goes on to the end |
| `max-iterations` | The iteration budget ran out |
| `discards-in-row` | Too many discarded steps in a row |
| `protected-changed` | A protected file changed |
| `guard-flag` | afk-guard flagged the diff |
| `judge-error` | Three judge calls in a row failed |
| `state-changed` | The run's own files were changed outside fbs |
| `agent` | The agent reached a real dead end and said why, or you asked it to stop |

On any stop but `met`, the report gives the rule, each check's baseline and last kept result, the iterations and judge cost, and what a human should look at. Kept commits stay on the branch.

## Known limits

- **The threat model is careless output, not a hostile process.** A process running as you that escapes the check's process group and rewrites both the run state and its seal could still forge a verdict. Stopping that would need an OS sandbox.
- **The guard stops the agent, not your credentials.** It inspects tool calls. Turn on branch protection and the `permissions.deny` lines preflight suggests; they are the backstop.
- **Checks run in your checkout.** Changes outside the tracked tree, such as edits inside `node_modules`, can influence a check.
- **Judged checks are only as good as their rubric.** The judge can't run code or open a browser; a criterion it can't observe in files or command output can't be judged.
- **The Stop hook needs a session id.** In environments where none reaches the CLI (some sandboxed or headless runs), it never fires, and the run continues only while the agent keeps working.
- **One run per checkout.** The run owns the checkout's branch until it stops.
