# The fbs CLI and hooks

The `fbs` CLI holds the parts of the flow that must behave the same every time: feature records, the spec gate, approvals, the verify stamp, branches and pushes, the PR watcher, landing, and the autopilot's finish line. The skills call it; you rarely need to. It is TypeScript on Bun with no runtime dependencies, in [`cli/`](../cli/), exposed to Claude Code as `bin/fbs`.

**Contents:** [Conventions](#conventions) · [Commands](#commands) · [Hooks](#hooks) · [Where state lives](#where-state-lives)

## Conventions

- **Exit codes:** `0` ok; `1` refused, or a record error such as `error: missing` or `error: exists` (reasons on stdout); `2` a usage or environment error (on stderr), such as `--use needs a value` for an option given without one. `watch-pr` has its own codes, below.
- **Output:** most commands print one JSON line, or `ok`, or one line per problem.
- **One command per call.** Skills pre-approve `Bash(fbs *)`, which matches only a bare `fbs …` command, so they never chain, pipe or redirect it.
- `fbs help` prints the full usage; `fbs help <command>` or `fbs <command> --help` (or `-h`) prints that command's part of it; `fbs --version` the version.

## Commands

### Feature records

| Command | What it does |
|---|---|
| `status init <slug> --size tiny\|bug\|mid\|big` | Creates the feature's record and its documents folder |
| `status init <unit> --unit-of <feature> [--unit <n>]` | Records a work unit of a big feature whose design approval is current; its folder is `<feature dir>/units/<unit>`. A taken `--unit` inserts it there, shifting the units at and above it up one |
| `status unit <unit> --move <n>` | Renumbers a unit and shifts the units between; prints the units as `[{slug, unit}]`. `<n>` must be in the approved design. Like an insert, refused with `breaks-stack` when an unlanded unit whose branch is cut would get a different unit below it, or an independent unit would land on a design entry that doesn't let it stand apart, or below every unit of the stack |
| `status move <slug> --to <path> [--remove-source]` | Copies the feature's record and its units' records into another repo, without PR, branch, stamp, landing or independence, and its documents into that repo's features dir, local or tracked as its git ignores them. `--remove-source` then removes them here, and `deletionToCommit` names the tracked folder whose deletion is left to commit. Refused for a unit, an open PR (`open-pr`), any landed unit (`has-landed`: a half-shipped feature stays), an approved document missing from this checkout (`doc-missing`), or a slug the target has (`exists`) |
| `status show <slug>` | The record as JSON: size, folder, documents mode, branch, approvals and stamp (each with `current`), PR, ticket, rollout criteria with their outcomes, and `pendingRollout` for the ones still waiting (a feature's own and its units'); a feature lists its units (an independent one marked), a unit its `covers` and `dependsOn` |
| `status list` | One line per feature: slug, size, stage |
| `status reconcile` | Asks `gh` about every record with an open PR: one merged outside fbs is recorded as landed (`by: outside`), so the guard stops counting it open, and one closed without merging has its link cleared, as `status pr <slug> none` would. Restacks and pushes nothing: `stack sync` moves a feature cut from a landed branch at its next sync. Prints `{outside}`, each PR it found not open |
| `status gate <slug> spec\|design` | The gate: facts sourced, assumptions accepted, no open questions, every section present; a design's work units checked against the spec. A fact ends with its source in parentheses: `(user, YYYY-MM-DD)`, `(spec)`, a URL or a file path (optionally `:line`), then optionally `, <detail>` or `; <detail>`, as in `(user, 2026-11-18; replaces the old limit)`; an `unsourced:` line lists these forms |
| `status approve <slug> spec\|design --quote '<words>'` | Records your approval verbatim, bound to the document's sha256; runs the gate first |
| `status approve <slug> design --auto '<reason>'` | Records the agent's approval of a simple design amendment; refused for a spec |
| `status pr <slug> <number\|url\|none>` | Records the feature's PR, or clears it |
| `status ticket <slug> <id\|none> [--url <url>]` | Records the tracker issue the feature works on |
| `status rollout <slug> AC<n> pass\|fail [--note <text>]` | Records how a rollout criterion the record lists turned out after the deploy, beside its text; a later outcome replaces an earlier one, and a later approval doesn't erase the list |

### Project context, settings and tracker

| Command | What it does |
|---|---|
| `config show` | `.fbs/config.json` as one JSON line, validated, with the defaults filled in |
| `context check [--json]` | Checks `.fbs/context.md`: the size limit, that every fact is dated, which facts are stale |
| `tracker show` | The tracker from `.fbs/config.json` as one JSON line, or `unset` |
| `tracker detect` | Evidence for setting it: ticket prefixes in branch names, tracker links in recent merged PR bodies, issue count. Reads only |

### Branches, pushes and commits

| Command | What it does |
|---|---|
| `branch <slug> [--type <type>] [--ticket <id>] [--existing] [--parent <branch>]` | Puts the checkout on the feature's branch and records it. Creates `<type>/<ticket>-<slug>` from origin's default branch (or `--parent`, for a stack) when none is recorded; `--existing` never creates; `--ticket` renames a branch fbs cut that has no PR yet, into an allowed type when `branches.types` leaves out its own (`feature` to `feat`, `bugfix` or `hotfix` to `fix`, and back; else the first listed). `<type>` is `feature`, `bugfix`, `hotfix`, `chore` or another Conventional Commit type (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`); only those in `branches.types` in `.fbs/config.json` when it's set. A unit's parent comes from its stack; `--parent <default branch>` makes it independent (cut from, or moved onto, the default branch) when the approved design says it depends on no unit still to land and no later unit depends on it, and nothing is stacked on it; with tracked documents, unit 1 must have landed. `--parent <the branch of the unit below>` puts an independent unit with no PR back in the stack |
| `branch --types` | The types to pick `--type` from, as one JSON line: `{types, from, seen}`. `from` is `config` (`branches.types`), `branches` (the family, conventional branch or Conventional Commit, that the 50 most recently committed local and remote branches with a type prefix use more; a tie is `default`) or `default` (`feature`, `bugfix`, `hotfix`, `chore`); `seen` counts each type prefix found. Reads only |
| `branch <slug> --use <branch>` | Adopts a branch you named instead |
| `push <slug>` | Pushes the tip of the feature's recorded branch, from any worktree and whatever is checked out; never the default branch. Before the PR it overwrites only what fbs pushed last; after, it only adds commits. When this checkout is off that branch and its HEAD isn't in what was pushed, the JSON adds `headNotPushed` (`{head, on}`) with a `note:`, since commits made here didn't go. Refused while any worktree is rebasing the branch. Skipped without an origin |
| `commits check <slug>` | Lists the branch's commits whose subject isn't a Conventional Commit or whose message breaks commitlint config-conventional's rules: header and lines of 100 characters at most, no spaces around the header, a subject that doesn't start with a capital or end with a full stop. A missing blank line after the header is listed as a warning that doesn't fail the check. `fixup!`, `squash!` and `amend!` commits and the parent branch's are left out |
| `commits title <text>` | Checks a PR title the same way |

For `branch --types`, `test/`, `docs/`, `build/` and `style/` branches count as Conventional Commit evidence, like `feat/` and `fix/`; `chore/` counts for neither family.

### Verification

| Command | What it does |
|---|---|
| `stamp set <slug> --verdict <path>` | Binds a passing verdict to `HEAD^{tree}`, and records the spec's rollout criteria on the record, with their text (a unit: the ones it covers) |
| `stamp check <slug>` | `ok`, or why not: stale, dirty, missing. A record whose branch isn't the one checked out is judged on its branch's tip; a detached HEAD on itself |
| `ci evidence <slug> [--wait]` | Whether CI stands in for the local suite: the newest run of each `verify.ciWorkflows` workflow on HEAD's exact commit, once the PR exists. Prints the commit, the tree and each run's URL; exit 0 only when every one succeeded. `--wait` polls until none is running |
| `stamp carry <slug>` | Moves the stamp onto the current tree when only plain documents verify doesn't read, or a plain file named exactly `CLAUDE.md` or `AGENTS.md` that no other symlink reaches, changed since it was set; for a unit, also a feature spec or design change outside what the unit is verified on. Keeps the tree verify ran on |

### Pull requests

| Command | What it does |
|---|---|
| `watch-pr <slug> [--interval <s>] [--timeout <s>] [--once]` | Polls the PR through `gh` and exits once per round (not per event, and not always after every check has finished), reporting only what it hasn't reported before. For a stack, watches every unit's open PR |
| `pr reply <slug> --comment <thread\|issue\|review>:<id> --body-file <path>` | Replies to a comment without putting text on the command line |
| `pr comment <slug> --body-file <path>` | Posts a new top-level PR comment, marked seen so the watcher doesn't wake on it |
| `pr resolve <slug> --thread <id>` | Resolves a review thread |
| `camp start <slug> [--auto-fix-rounds <n>]` | Creates the PR camp's state, which switches on the guard, or keeps it on a resume. The camp is held by the Claude Code session that ran it; from another session it takes the camp over and prints `takenOverFrom`. Asks `gh` about each PR it camps first, as `status reconcile` does (`outside`) |
| `camp round <slug> --in <n> --fixed <n> --declined <n> --followups <n> --asked <n> [--note <text>] [--unit <unit>]` | Records a round and prints what comes next: continue, checkpoint or blockers-only. Refused with `error: camp held by <id>` when another session holds the camp |
| `camp checkpoint <slug> [--unit <unit>]` | Records that the checkpoint with you was held. Refused like `camp round` when another session holds the camp |
| `camp show <slug> [--unit <unit>]` | The camp's budget, rounds, follow-ups, and how the next round is handled |
| `camp stop <slug>` | Ends the camp; follow-ups stay. Asks `gh` about each PR it camps, as `status reconcile` does, and prints a `<kind>: <reason>` line after `stopped` for each PR found not open. When another session holds the camp, refused like `camp round` while a PR it camps is still open |
| `camp followup <slug> --thread <key> --summary <text> [--why <text>] [--unit <unit>]` | Records a valid out-of-scope finding for a ticket later. The key is a comment's, as `pr reply` takes it, or `check:<check name>` for a failing CI check |
| `camp followup <slug> --filed <n> --link <url>` / `--declined <n>` | Closes a follow-up |

`watch-pr` exit codes:

| Code | Meaning |
|---|---|
| `0` | Approved and green |
| `3` | New comments or failures: a human comment at once, bot comments once a poll brings no new one (checks may still run, counted in `pendingChecks`), failures on their own once every check has finished. An early wake carries the failures seen so far; a later failure on the same head still wakes, and so does a failure whose Actions run was still going (`runInProgress`) once that run finishes. Only the newest run of each check counts, as in `gh pr checks`, and a bot's edit counts only when it changes the comment's text, not just a link |
| `4` | Closed or merged |
| `5` | Timeout |
| `6` | Merge conflict |
| `7` | Query error |
| `8` | A green draft, ready to mark ready |
| `9` | Green, waiting on review |
| `10` | Taken over: another Claude Code session now holds the camp (`session` in the report), or the camp it started with is gone (`session: null`). Checked before each poll; nothing is marked seen. A watcher with no session id, or a camp that names none, never stops for this |

### Landing and stacks

| Command | What it does |
|---|---|
| `land <slug>` | Merges the feature's PR. Needs the one-time token your own message writes (asking to merge or land it, a yes to a land request, or `/fbs:land`), and refuses unless the PR is approved, green (or with no checks at all when the base branch requires none, printed as `checks: "none"`), clean, based on the default branch and carrying the stamped tree. Squash-merges with the head pinned, then restacks what was stacked on it. A feature with units lands its lowest unit with an open PR; an independent unit lands whenever it's ready, and restacks nothing, unless the design no longer lets it stand apart (it depends on a unit still to land, or a later unit depends on it). A PR in a GitHub stack with other open PRs merges nothing: it prints `merged: false` and the `stack`, each PR checked, with the `gh stack merge` command for you to run |
| `land request <slug> [--over-failing]` | Writes a pending land request, so your yes as your next message in the same session becomes the token; anything else you say drops it. `--over-failing` lists the failed, cancelled or missing checks your reply confirms landing over. In a GitHub stack it writes nothing and prints `requested: false` with the `stack` |
| `rewrite request <slug>` | Writes a pending request to rewrite the open PR's branch (a rebase, a squash, a changed commit), so your yes as your next message in the same session becomes the one-time rewrite token: one `--force-with-lease` push to an open PR's branch. Anything else you say drops it. Refused while another land or rewrite request waits for your answer |
| `stack sync <slug>` | Keeps a stack whole, bottom-up: fast-forwards each unit from origin, merges the unit below forward, records PRs merged outside fbs, and moves a unit whose parent landed onto the default branch. An independent unit is skipped in the chain and only fast-forwarded, in a pass of its own; one the design no longer lets stand apart is reported as `not-independent` and left alone. Stops at the first unit it can't sync |

### Autopilot

| Command | What it does |
|---|---|
| `afk preflight [--force]` | Whether merges and default-branch pushes are denied in your settings, and whether the branch is protected |
| `afk start <slug> --spec <file> [--session <id>] [--restart]` | Records a run from its JSON spec and measures the baseline; binds it to the session |
| `afk check <slug>` | Runs afk-guard and every check on HEAD; prints `kept`, `discarded` (and resets), `held` or `stopped` |
| `afk show <slug>` | The run and a summary, or `none` when the slug has no run |
| `afk resume <slug>` | Logs the resume and rebinds the run to this session |
| `afk stop <slug> --reason <text>` | Stops the run |
| `afk final <slug>` | Measures a met run's final tree on both votes and writes the evidence verify reads |
| `afk-guard <slug>` | Flags new dependencies, migrations, infra, out-of-scope or protected files and test weakening in the run's diff |

See [Autopilot](afk.md) for how these fit together.

### Other

| Command | What it does |
|---|---|
| `polish check` | Whether the two review plugins `/fbs:polish` needs are installed and enabled, with their rubric paths; otherwise the commands to install them |
| `guard [--prompt\|--reply]` | Hook entry for the guard (below) |
| `ask-check` | Hook entry on `AskUserQuestion` (below) |
| `afk stop-check` | Hook entry for the Stop hook (below) |

## Hooks

[`hooks/hooks.json`](../hooks/hooks.json) wires these up. The guard and the Stop hook start as small shell scripts that use only git and the shell, so in a repo with no PR flow and no autopilot run they allow everything at once, without starting Bun.

| Event | Runs | What it enforces |
|---|---|---|
| `PreToolUse` on Bash, file edits (Write, Edit, MultiEdit, NotebookEdit), Skill, Monitor, Agent, SendMessage, the scheduling tools (CronCreate, ScheduleWakeup, RemoteTrigger), MCP write, push and merge tools (`push_files`, `create_or_update_file`, `write_file`, `merge_pull_request` and similar) and MCP comment and review tools (`add_issue_comment`, `pull_request_review_write` and similar) | `bin/fbs-guard` | While a PR flow (a camp, or any feature with an open PR) or an autopilot run is active: denies merges (`gh pr merge`, `gh stack merge`, merge APIs, MCP merge tools), pushes to the default branch, force pushes (`--force`, `-f`, a `+` refspec, always), any attempt to write or trigger a land token, and scheduled prompts (`/loop`, CronCreate, ScheduleWakeup, RemoteTrigger) that ask to merge or rewrite, or say yes, which are denied in any fbs repo, PR open or not. `fbs land` passes only with the token your own message wrote. A `--force-with-lease` push that rewrites an open PR's branch passes when only messages changed: the same base on origin's default branch and the same tree for every commit, so reviews and the stamp still hold. That needs the push to be the whole command, run from the repo, with no explicit expected value. Otherwise it passes once with the rewrite token your own words or your yes to a rewrite request wrote, and is denied without it. While a camp runs it also denies raw ways to post on an open fbs PR: `gh` or `curl` REST writes to its comments, replies, reviews and issue comments, the GraphQL mutations that add a comment, reply or review or resolve a thread, `gh pr comment`, `gh pr review`, `gh issue comment`, and the MCP comment and review tools. Replies go through `fbs pr reply`, new comments through `fbs pr comment` and resolves through `fbs pr resolve`, which record what they post so the watcher doesn't wake on it; fbs never approves a PR or requests changes, so the agent asks you to do that on GitHub. Reads, other numbers (a tracker issue, someone else's PR) and commands that only mention these strings (`grep`, `git commit -m`) pass. During an autopilot run it adds the rules in [Autopilot](afk.md#the-guard-and-the-stop-hook). If the guard itself fails while it is on, the call is denied, never allowed silently |
| `PreToolUse` on `AskUserQuestion` | `fbs ask-check` | Denies an Assuming, Confirm or Approve question, or one that refers to something "above", when the agent wrote nothing in the chat before it |
| `UserPromptExpansion` on `/fbs:land` | `bin/fbs-guard --prompt` | Writes the one-time land token when you type `/fbs:land` |
| `UserPromptSubmit` | `bin/fbs-guard --reply` | While an fbs PR is open: a message that may ask to land ("go ahead and merge it", "land #12") writes the land token for the PR it names (else the one open PR flow's), bound to your session, and a note tells the agent to judge whether you're asking now; a yes to a pending land request writes that request's token. A token lasts until your next message that doesn't ask to land (watcher wakes don't count), so "merge it once CI is green" carries. A message that may ask to rewrite ("go ahead and amend it", "force push it", "squash those commits", "rebase it onto main") writes a one-time rewrite token the same way: bound to your session, good for one `--force-with-lease` push to an open PR's branch, until used or your next message that doesn't ask for it; a negation counts only in the clause that holds the ask. A yes to a pending rewrite request writes it too. Messages over 400 characters, notifications, subagent reports and negations ("don't merge it yet", "don't force push") write nothing. Never blocks your message |
| `Stop` | `bin/fbs-afk-stop` | Keeps the session bound to a running autopilot run going, unless something will wake it. Any failure lets the session stop |

The guard stops the agent, not your credentials. Branch protection on the default branch is the backstop.

If a guard failure ever locks you out, please open an issue; `/plugin disable fbs@fabs` switches every fbs hook off.

## Where state lives

Runtime state lives in `$(git rev-parse --git-common-dir)/fbs/`: shared by every worktree of the repo and never committed.

| Path | Holds |
|---|---|
| `features/<slug>.json` | The feature record: size, folder, branch, approvals, stamp, PR, ticket, units |
| `evidence/<slug>/` | Validate's and the UI implementer's screenshots and notes, polish reports, autopilot evidence indexes |
| `pr/<slug>.json` | The PR watcher's cursor: what it has already reported |
| `pr/<slug>.camp` | A running camp, the session holding it, and its rounds. Its existence switches on the guard |
| `pr/<slug>.followups.json` | Follow-ups recorded during the camp |
| `pr/<slug>.md` | The PR description |
| `land/` | The pending land or rewrite request, the one-time land tokens and the rewrite token |
| `afk/<slug>/` | An autopilot run: `run.json`, its log, its cached judge verdicts |

In the project itself, fbs writes only the feature's documents and `.fbs/`. See [What a feature leaves behind](how-it-works.md#what-a-feature-leaves-behind).
