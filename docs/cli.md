# The fbs CLI and hooks

The `fbs` CLI holds the parts of the flow that must behave the same every time: feature records, the spec gate, approvals, the verify stamp, branches and pushes, the PR watcher, landing, and the autopilot's finish line. The skills call it; you rarely need to. It is TypeScript on Bun with no runtime dependencies, in [`cli/`](../cli/), exposed to Claude Code as `bin/fbs`.

**Contents:** [Conventions](#conventions) · [Commands](#commands) · [Hooks](#hooks) · [Where state lives](#where-state-lives)

## Conventions

- **Exit codes:** `0` ok; `1` refused, or a record error such as `error: missing` or `error: exists` (reasons on stdout); `2` a usage or environment error (on stderr). `watch-pr` has its own codes, below.
- **Output:** most commands print one JSON line, or `ok`, or one line per problem.
- **One command per call.** Skills pre-approve `Bash(fbs *)`, which matches only a bare `fbs …` command, so they never chain, pipe or redirect it.
- `fbs help` prints the full usage; `fbs --version` the version.

## Commands

### Feature records

| Command | What it does |
|---|---|
| `status init <slug> --size tiny\|bug\|mid\|big` | Creates the feature's record and its documents folder |
| `status init <unit> --unit-of <feature> [--unit <n>]` | Records a work unit of a big feature whose design approval is current; its folder is `<feature dir>/units/<unit>` |
| `status show <slug>` | The record as JSON: size, folder, documents mode, branch, approvals and stamp (each with `current`), PR, ticket; a feature lists its units, a unit its `covers` and `dependsOn` |
| `status list` | One line per feature: slug, size, stage |
| `status gate <slug> spec\|design` | The gate: facts sourced, assumptions accepted, no open questions, every section present; a design's work units checked against the spec |
| `status approve <slug> spec\|design --quote '<words>'` | Records your approval verbatim, bound to the document's sha256; runs the gate first |
| `status approve <slug> design --auto '<reason>'` | Records the agent's approval of a simple design amendment; refused for a spec |
| `status pr <slug> <number\|url\|none>` | Records the feature's PR, or clears it |
| `status ticket <slug> <id\|none> [--url <url>]` | Records the tracker issue the feature works on |

### Project context and tracker

| Command | What it does |
|---|---|
| `context check [--json]` | Checks `.fbs/context.md`: the size limit, that every fact is dated, which facts are stale |
| `tracker show` | The tracker from `.fbs/config.json` as one JSON line, or `unset` |
| `tracker detect` | Evidence for setting it: ticket prefixes in branch names, tracker links in recent merged PR bodies, issue count. Reads only |

### Branches, pushes and commits

| Command | What it does |
|---|---|
| `branch <slug> [--type feature\|bugfix\|hotfix\|chore] [--ticket <id>] [--existing] [--parent <branch>]` | Puts the checkout on the feature's branch and records it. Creates `<type>/<ticket>-<slug>` from origin's default branch (or `--parent`, for a stack) when none is recorded; `--existing` never creates; `--ticket` renames a branch fbs cut that has no PR yet |
| `branch <slug> --use <branch>` | Adopts a branch you named instead |
| `push <slug>` | Pushes the feature's branch, never the default branch. Before the PR it overwrites only what fbs pushed last; after, it only adds commits. Skipped without an origin |
| `commits check <slug>` | Lists the branch's commit subjects that aren't Conventional Commits, leaving out the parent branch's |
| `commits title <text>` | Checks a PR title the same way |

### Verification

| Command | What it does |
|---|---|
| `stamp set <slug> --verdict <path>` | Binds a passing verdict to `HEAD^{tree}` |
| `stamp check <slug>` | `ok`, or why not: stale, dirty, missing |
| `stamp carry <slug>` | Moves the stamp onto the current tree when only plain documents verify doesn't read changed since it was set; keeps the tree verify ran on |

### Pull requests

| Command | What it does |
|---|---|
| `watch-pr <slug> [--interval <s>] [--timeout <s>] [--once]` | Polls the PR through `gh` and exits once per settled round, reporting only what it hasn't reported before. For a stack, watches every unit's open PR |
| `pr reply <slug> --comment <thread\|issue\|review>:<id> --body-file <path>` | Replies to a comment without putting text on the command line |
| `pr resolve <slug> --thread <id>` | Resolves a review thread |
| `camp start <slug> [--auto-fix-rounds <n>]` | Creates the PR camp's state, which switches on the guard, or keeps it on a resume |
| `camp round <slug> --in <n> --fixed <n> --declined <n> --followups <n> --asked <n> [--note <text>] [--unit <unit>]` | Records a round and prints what comes next: continue, checkpoint or blockers-only |
| `camp checkpoint <slug> [--unit <unit>]` | Records that the checkpoint with you was held |
| `camp show <slug> [--unit <unit>]` | The camp's budget, rounds, follow-ups, and how the next round is handled |
| `camp stop <slug>` | Ends the camp; follow-ups stay |
| `camp followup <slug> --thread <key> --summary <text> [--why <text>] [--unit <unit>]` | Records a valid out-of-scope finding for a ticket later |
| `camp followup <slug> --filed <n> --link <url>` / `--declined <n>` | Closes a follow-up |

`watch-pr` exit codes:

| Code | Meaning |
|---|---|
| `0` | Approved and green |
| `3` | New comments or failures |
| `4` | Closed or merged |
| `5` | Timeout |
| `6` | Merge conflict |
| `7` | Query error |
| `8` | A green draft, ready to mark ready |
| `9` | Green, waiting on review |

### Landing and stacks

| Command | What it does |
|---|---|
| `land <slug>` | Merges the feature's PR. Needs the one-time token your `/fbs:land` writes, and refuses unless the PR is approved, green, clean, based on the default branch and carrying the stamped tree. Squash-merges with the head pinned, then restacks what was stacked on it. A feature with units lands its lowest unit with an open PR |
| `land request <slug> [--over-failing]` | Writes a pending land request, so your bare `land` reply within 10 minutes, in the same session, becomes the token. `--over-failing` lists the failed, cancelled or missing checks your reply confirms landing over |
| `stack sync <slug>` | Keeps a stack whole, bottom-up: fast-forwards each unit from origin, merges the unit below forward, records PRs merged outside fbs, and moves a unit whose parent landed onto the default branch. Stops at the first unit it can't sync |

### Autopilot

| Command | What it does |
|---|---|
| `afk preflight [--force]` | Whether merges and default-branch pushes are denied in your settings, and whether the branch is protected |
| `afk start <slug> --spec <file> [--session <id>] [--restart]` | Records a run from its JSON spec and measures the baseline; binds it to the session |
| `afk check <slug>` | Runs afk-guard and every check on HEAD; prints `kept`, `discarded` (and resets), `held` or `stopped` |
| `afk show <slug>` | The run and a summary |
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
| `PreToolUse` on Bash, file edits (Write, Edit, MultiEdit, NotebookEdit), Skill, Monitor, Agent, SendMessage, the scheduling tools (CronCreate, ScheduleWakeup, RemoteTrigger) and MCP write, push and merge tools (`push_files`, `create_or_update_file`, `write_file`, `merge_pull_request` and similar) | `bin/fbs-guard` | While a PR flow (a camp, or any feature with an open PR) or an autopilot run is active: denies merges (`gh pr merge`, merge APIs, MCP merge tools), pushes to the default branch, force pushes, and any attempt to write or trigger a land token. `fbs land` passes only with the token your own `/fbs:land` wrote. During an autopilot run it adds the rules in [Autopilot](afk.md#the-guard-and-the-stop-hook). If the guard itself fails while it is on, the call is denied, never allowed silently |
| `PreToolUse` on `AskUserQuestion` | `fbs ask-check` | Denies an Assuming, Confirm or Approve question, or one that refers to something "above", when the agent wrote nothing in the chat before it |
| `UserPromptExpansion` on `/fbs:land` | `bin/fbs-guard --prompt` | Writes the one-time land token when you type `/fbs:land` |
| `UserPromptSubmit` | `bin/fbs-guard --reply` | Writes the land token when you answer a pending land request with a bare `land`, `land it` or `land #<pr>`, in the session that asked. Never blocks your message |
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
| `pr/<slug>.camp` | A running camp and its rounds. Its existence switches on the guard |
| `pr/<slug>.followups.json` | Follow-ups recorded during the camp |
| `pr/<slug>.md` | The PR description |
| `land/` | The pending land request and the one-time land tokens |
| `afk/<slug>/` | An autopilot run: `run.json`, its log, its cached judge verdicts |

In the project itself, fbs writes only the feature's documents and `.fbs/`. See [What a feature leaves behind](how-it-works.md#what-a-feature-leaves-behind).
