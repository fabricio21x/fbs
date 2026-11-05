---
name: afk
description: "Autopilot: work a well-defined task while the user is away, when its finish line can be stated as checks (a command and its target, or a judged rubric) and the work stays in code. Use when the user says afk, autopilot, or work on this while I'm away. Refuses migrations, new dependencies, infra, production and product decisions. One approval at the start, then keeps or discards each step against checks the fbs CLI runs, and ends in a reviewed, verified PR. Never merges, deploys or touches production."
argument-hint: "[the task, or the slug of a run to resume]"
allowed-tools: Bash(fbs *)
---

# Afk

Work a task to a finish line nobody has to watch. The user approves the run once. After that, the fbs CLI owns the finish line: it runs the checks, judges the rubric with a model of its own, keeps or discards each step, and decides when the run stops. You make the steps. You never decide the run is done, and you never make the finish line easier.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: the task, or the slug of an existing run with an optional message to it: $ARGUMENTS

Run every `fbs` command as its own Bash call, with nothing chained, piped or redirected. Quote a `--reason` in single quotes, so the shell can't expand anything in it. An `fbs afk` command that fails prints `error: <code>: <detail>`; act on the detail.

**Long checks run in the background.** `fbs afk start`, `fbs afk check`, `fbs afk final` and section 5's dry run of the checks can run for many minutes (a build, Lighthouse, two judge calls), past the Bash timeout. Run each with Bash `run_in_background` and wait for its completion notification; its JSON is the last line of its output. Never start the next step while one runs.

**Keep going.** Never ask the user to type a command. Once the run is approved, ask nothing until it stops.

**Ask with the question UI.** Every question to the user goes through the AskUserQuestion tool when it is available, with what the user needs to answer shown in the chat right before it (`fbs:grilling`'s rules). Plain text only when the answer can't be options, or without the tool.

## 1. Resume or new

When the input's first word could be a slug, run `fbs afk show <it>`. On `error: missing`, the whole input is a new task: go to section 2. Otherwise the rest of the input is the user's message to that run, and the JSON has `run` and `summary`; by `run.status`:

- **running:** run `fbs afk resume <slug>`. It logs the pickup and binds the run to this session. When the run it prints is `stopped`, go to section 9. Otherwise, when the tree isn't on `run.branch`, run `fbs branch <slug> --existing`. Then settle an interrupted step:
  - HEAD is a committed step that was never checked (neither `run.kept.sha` nor `run.lastChecked`): run the check first (section 8, step 3).
  - An uncommitted change: drop it with `git reset --hard`, then delete the untracked files `git status --porcelain` lists (the run started from a clean tree, so they came from the step). Only those; nothing else.
  
  A message goes through section 8's rules (a change to the goal or the checks stops the run and starts a new proposal). Then go on with the loop, section 8.
- **met:** go to section 10, skipping the steps already done: a `run.final` whose `sha` is HEAD and whose `met` is true means steps 1 and 2 are. When `fbs status show <slug>` has a `pr`, continue into camp-pr instead.
- **landed:** say the feature has landed, and stop.
- **stopped:** when the user asks for a new run on it (in the message, or when asked), go to section 2, keeping the slug, the feature and its branch (`fbs branch <slug> --existing` instead of section 4's first and third steps), and pass `--restart` to `fbs afk start`. Otherwise show the stop as section 9 does, and end.

## 2. Classify

The task is eligible only when both hold:

- its finish line can be stated as checks: a command with an exit code or a number to reach, or a rubric whose every criterion can be seen in the code or in a command's output;
- the work stays in code: a page, a screen, SEO, performance, a feature that needs few decisions, a rebase.

Refuse when it needs a data migration, a new dependency or technology, an infra, deploy or stack change, money or production data, or a product decision (more than one real choice only the user can make). Say why in one line and point to `/fbs:assemble`, which plans it with the user. When the task is too vague to state a finish line, ask for it once in plain text.

## 3. Preflight

Run `fbs afk preflight`. Its JSON says whether the user's Claude settings deny `gh pr merge` (`merge_denied`) and pushes to the default branch (`push_denied`), and whether GitHub protects that branch (`branch_protected`, `null` when it couldn't tell). Anything false or null is a warning for the approval: carry each one, with the exact lines from `suggest` as a `permissions.deny` snippet for `~/.claude/settings.json`, and "turn on branch protection for `<branch>`" when it isn't protected. It warns, it never blocks.

## 4. Feature and branch

1. Pick a short slug for the task (another one when it is taken). Run `fbs status init <slug> --size tiny` and take `dir`, `docs` and `docsRoot` from `fbs status show <slug>`. The run's files (`afk.json`, the check scripts) go under `docsRoot`, the absolute path of `dir`; when `docs` is `local` (git ignores them), they aren't committed, and the spec and check commands name them by that absolute path, since this checkout may be a linked worktree with no copy of them. The size is only the record's: the run's finish line replaces a spec.
2. If `git status --porcelain` isn't empty, show what's dirty and ask once: commit it where it is, or set it aside with `git stash push -u -m "fbs afk <slug>: set aside on <current branch>"`. It stays in the stash: popping it on the run's branch would put the user's work in the PR, so the report says where it is. Ignoring it locally doesn't work here: `fbs afk start` counts files hidden only by `.git/info/exclude` as dirty (implement's `.claude/worktrees/` excepted). Never discard the user's changes.
3. Run `fbs branch <slug> --type <feature, bugfix for a fix, or chore when no behaviour changes>`; say each `note:` in one line; on `refused:`, show it and do what the user chooses. Take `branch` and `base` (the **branch base**) from its JSON. The run works in this checkout on this branch, which is how every fbs stage works; the checkout is busy until the run stops. To keep their main checkout free, the user can start the session for afk in its own worktree (`claude -w`).
4. Find the test and type-check commands (`CLAUDE.md`, `package.json` scripts or the equivalent), run both, and record the names of the tests that already fail as the **test baseline**. The final review and verify need it; it goes into the spec's `testBaseline`.

## 5. Propose the run

Read the code the task touches first. Then draft:

- **Goal:** one sentence, the outcome.
- **Checks**, all of which must pass. A command check wherever one exists, a judged rubric for the rest.
  - *Command:* `run` is a shell command, run from the repo root. It passes on exit 0, or, with `metric`, when the number parsed from its stdout reaches `target` (`direction` `min`: at least; `max`: at most). `metric` is a regex whose first group is the number; the last match counts. A Lighthouse score, a lint count, a bundle size.
  - *Judged:* a `rubric` of criteria a model the CLI starts checks against the code and this iteration's command output. It can only read files (no shell, no browser) and sees the last 4000 characters of each command's output. Each criterion must be observable there: "every page under `app/(public)/` exports metadata with a unique title", never "looks good". What the running app shows needs a command that prints it (`curl` of the page, say). A judged check passes only on two votes on the same tree, and is skipped while a command check fails.
  - *The suite:* add the test command as a command check when it passes today, so no step can break it.
  - *A check on the running app:* build it from `.fbs/validation/README.md` (when it is missing, set it up first: read `<plugin root>/skills/setup-validation/SKILL.md` and follow it as its calling skill). Write a script `<dir>/afk-<check id>.sh` that:
    - makes a temp dir (`mktemp -d`) and writes everything there: the build, server and tool logs, and the tool's report (Lighthouse's `--output-path`). A file left in the repo stops the start and fails judged checks;
    - launches the app as Launch says, in the background, on a free port of its own, and fails at once when that port is taken, as validate does; keeps its PID and kills it on exit (`trap … EXIT`); waits for readiness with a timeout;
    - runs a pinned tool version (`npx -y lighthouse@<x.y.z>`). A tool run through `npx` is not a dependency; never add it to a manifest;
    - prints only what the checks need on stdout: the number on its own line (`seo=92`), and a short summary per page for the judge (title, meta description, the h1s, whether JSON-LD is there and parses), since the judge sees only the last 4000 characters.
    
    The CLI kills the command's process group afterwards, but the script cleans up itself.
- **Scope:** globs of the files the work may touch, new tests included. A changed file outside them stops the run.
- **Protected:** globs of what the run may never change: the existing tests, the check scripts and their config, and anything else the finish line rests on. They are resolved once, at the start: the files they match then are frozen, and new files matching them (a new test) are fine. Only tracked files are frozen, so with local documents `<dir>/afk*` protects nothing; the CLI keeps its own copy of the spec anyway. Search the tests for what the goal changes (a test asserting the old title, say): leave those out of the protected globs, and say so in the approval.
- **Budgets:** `maxIterations` (default 30), `maxDiscardsInRow` (5), `checkTimeoutSec` per command or judge call (600), `judgeUsdPerCall` (0.5).

Run each command check once now and note today's result. Then `git status --porcelain` must be empty: a check that writes or rewrites a file in the repo (`next-env.d.ts`, `tsconfig.json` from a build) is fixed in its script, or the file is committed the way the tool writes it, before the start. When every check already passes and there are no judged checks, there is nothing to do: say so and stop.

## 6. Approval

Show the whole run in the chat:

```
**afk: <slug>**: <goal>

| Check | How | Today | Target |
|---|---|---|---|
| <id> | `<command>` | <value or pass/fail> | <≥ target, or exit 0> |
| <id> | judged, <n> criteria (below) | – | all, on two votes |

**Rubric (<id>):** 1. <criterion> 2. …
**Scope:** <globs>
**Protected:** <globs>; left out on purpose: <tests the goal changes, or none>
**Budgets:** <n> iterations, stop after <n> discards in a row, <n> s per check, judge at most $<usd> a call (worst case $<judged checks × usd × (1 + 2 × maxIterations + 2)>: the baseline, two votes per iteration, two at the end)
**Safety:** <preflight is clean, or each warning with the lines to add>
**Never:** merge, deploy, touch production or its data, add dependencies or migrations, edit the protected files or the checks.
**While it runs:** this session keeps itself going (a Stop hook), and messages you send in it are folded back into the loop until the run stops. `/bg` moves it to the background. Your checkout stays on `<branch>` until then.
```

Then ask with `fbs:grilling`'s approval question (`header`: `Approve`, question "Start the afk run for `<slug>` with this finish line?"). Never start without an `Approve`. Requested changes go back to section 5 and a new approval. Without the tool, ask in plain text and wait for the user's reply; with no human to answer, don't start.

## 7. Start

1. Write the run as JSON to `<dir>/afk.json` with the Write tool, with exactly the approved content:

```json
{
  "goal": "…",
  "checks": [
    { "id": "seo", "kind": "command", "run": "sh <dir>/afk-seo.sh", "metric": "^seo=(\\d+)$", "target": 95, "direction": "min" },
    { "id": "suite", "kind": "command", "run": "bun test" },
    { "id": "meta", "kind": "judged", "rubric": ["…", "…"] }
  ],
  "scope": ["app/**"],
  "protect": ["<dir>/afk*", "…"],
  "testBaseline": ["<each test that failed in section 4>"],
  "budgets": { "maxIterations": 30, "maxDiscardsInRow": 5, "checkTimeoutSec": 600, "judgeUsdPerCall": 0.5 }
}
```

2. When `docs` is `tracked`, commit it with any check scripts (`chore: afk finish line for <slug>`): the run starts from a clean tree, and the PR shows its finish line.
3. Run `fbs afk start <slug> --spec <docsRoot>/afk.json` in the background (pass `--restart` for a new run on a stopped one). It measures the baseline (judged checks once) and prints the run. On `error: bad-spec`, fix the file (and commit it again when tracked). On `error: dirty`: files a check wrote are fixed in its script (section 5); only files the user had (hidden by `.git/info/exclude`, say) are shown to them with a question.
4. When every baseline result passes, there is nothing to do: `fbs afk stop <slug> --reason 'the finish line already passes at the start'`, say so, and stop.
5. Show the baseline in one line per check, and start the loop.

## 8. The loop

**On every wake** (a Stop-hook continuation, a resume, a message from the user, a compacted context), re-read this file (`${CLAUDE_SKILL_DIR}/SKILL.md`; if unexpanded, `<plugin root>/skills/afk/SKILL.md`) and run `fbs afk show <slug>`. The run record is the truth, not your memory of it.

Each iteration:

1. **Pick the smallest step the evidence justifies.** Read the last results: each command's `tail`, `value` and `error`, and each judged criterion's `pass` and `evidence`. Aim at the check furthest from its target.
2. **Make it and commit it**, one step per commit, staging only its files, with a conventional message. A big step may go to one `fbs:implementer` Agent call (no worktree isolation), given the step as its task, the branch, the scope and protected globs, and the test commands. You keep the loop.
3. **Run `fbs afk check <slug>`** in the background and wait for it. Its JSON has `iteration`, `decision` (`kept`, `discarded`, `held` or `stopped`), the `results`, `met`, `stop` (`rule` and `why`), `flags`, `warning` and `judgeError`. A step is kept only when a check moved toward its target and none moved away; a discarded step is already reset by the CLI, so don't reset anything yourself. `held` means the judge failed to answer (`judgeError`): the step stays as it is; run the check again on the same commit, and after three in a row the CLI stops the run.
4. **Say one line:** `✓ #<n> kept · <each check's result in a few words, e.g. seo 82→88/95, meta 3/5> · <short sha>`, or `✗ #<n> discarded · <results> · <what the step tried>`, or `… #<n> held · judge error, retrying`. Nothing more while it runs.
5. A `warning` names files the checks left in the repo: delete them, and stop the run if it happens again. When `stop` is set, go to section 9. Otherwise go on.

The rules:

- Never edit the protected files, the checks, `afk.json` or fbs's state, and never relax a check. The finish line is reached by changing the code. When the check itself is wrong, that's a dead end for the human.
- A plateau means change approach, not stop. After three discards in a row, step back: re-read the evidence and the code, and try a different idea, not a variation of the last one.
- Stop yourself only at a real dead end: `fbs afk stop <slug> --reason <what you tried and why it can't go further>`.
- Don't end your turn while the run is running, except to wait for a background check: the Stop hook sends you back, and a turn that ends twice without a new check pauses the run.
- A message from the user during the run gets a short answer, then the loop goes on. When they ask to stop, `fbs afk stop <slug> --reason 'stopped by the user'`. A change to the goal or the checks is never made to a running run: stop it and propose a new one (section 1's stopped case, which passes `--restart`).
- Don't push during the loop; the end pushes once.

## 9. Stops

- **met:** go to section 10.
- **Any other rule:** report it and end:
  - the rule and its `why`;
  - each check's baseline and last kept result, from `fbs afk show <slug>` (`run.start.results`, `run.kept.results`);
  - iterations, kept and discarded (`summary`), and the judge cost (`run.judgeCostUsd`);
  - what a human should look at. `guard-flag` and `protected-changed` leave the flagged commit in place for review: list each flag with its path and line, and say that flags marked heuristic may be false positives. `state-changed` means the run's own files were changed outside fbs: look at how before trusting anything it recorded. `max-iterations`, `discards-in-row` and `agent`: what was tried and what blocks the target.

The kept commits stay on the branch. When section 4 set the user's changes aside, the report names the stash entry and the branch to pop it on. A new run starts from a new proposal and approval.

## 10. The end

1. **Final review.** Read section 6 of `<plugin root>/skills/implement/SKILL.md` and follow it, with the range `<branch base>..HEAD`, the goal and every check (with its rubric) as the criteria, no design, and the test commands and test baseline from section 4. Tell the reviewer the checks, their scripts and `afk.json` are frozen: findings against them are out of bounds, and fixes never touch them. There is no `plan.md`: keep the outcome for the report. When findings are still blocking after its fix rounds, report them with section 9's report and end.
2. **Measure the final tree.** Run `fbs afk final <slug>` in the background and wait for it. It runs afk-guard and every check on HEAD (judged checks on two votes, free when HEAD is the kept tree), records the result, and writes the evidence index verify reads (its path is `evidence`). When `met` is false, a check failed or afk-guard flagged the review's fixes: fix it in the final review's fix rounds and run `fbs afk final` again; when it can't be fixed, report with section 9's report and end. Run `fbs afk show <slug>` for `run.start.results` and `summary`.
3. **Report**, then go on:

```
**afk: <slug>**: met in <n> iterations (<k> kept, <d> discarded) · judge $<cost>

| Check | Baseline | Final |
|---|---|---|
| <id> | <value or n/total criteria> | <value (target)> |

**Final review:** <verdict, fix rounds>
**Attention:**
- <each flag the run raised, each heuristic afk-guard note, each preflight warning>
- <judged criteria that passed narrowly: thin evidence, or failing until the last iterations>
- <what the human must check by eye: copy, layout, anything no check measures>
- <non-blocking review findings worth a look, at most five>
- <the user's changes set aside in section 4: the stash entry and the branch to pop it on, when there were any>
```

4. Continue into verify: read `<plugin root>/skills/verify/SKILL.md` and follow it with the slug. Its outcome to check is the run's goal, which the user approved at the start: pass it, so verify doesn't ask again. From there verify, open-pr and camp-pr run as usual; the guard keeps the run's deploy and production denials until `fbs land` marks the run landed (or `fbs afk stop <slug>` ends it). Never merge.
