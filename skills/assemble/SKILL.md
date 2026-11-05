---
name: assemble
description: "The one entry to fbs: start a new idea, or pick up a feature wherever it stands (planning, design, building, validating, verifying, or a change the user wants), and keep going stage by stage until an approval, a decision or the end."
disable-model-invocation: true
argument-hint: "[idea, or feature slug, optionally with what you want changed]"
allowed-tools: Bash(fbs *)
---

# Assemble

Take the user from where the work stands to the next thing that needs them, without making them name stages. Every stage continues into the next on its own; this skill only finds the starting point.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: an idea, or a feature slug with an optional request: $ARGUMENTS

Run every `fbs` command as its own Bash call, with nothing chained, piped or redirected.

## 1. Find the feature

- **No input:** run `fbs status list`. A work unit (`unit N of <feature>`) counts as its feature. With one feature in progress, take it; with several, ask which (the question UI when available); with none, ask what to work on.
- **A slug, alone or with a request:** run `fbs status show <slug>`. On `error: missing`, treat the whole input as a new idea. A work unit's slug (its record has `unitOf`) stands for its feature: take the feature's slug.
- **An idea:** it's new work. Go to step 3 with plan.

## 2. Read where it stands

From the record and the feature's folder (`dir`, read under `docsRoot`, which `fbs status show` prints with `docs`), in this order, the first that applies is the starting point:

1. **A running or met afk run with no PR yet:** `fbs afk show <slug>` prints a run whose `status` is `running` or `met`, and the record has no `pr`: afk, which resumes it. A stopped run falls through to the rules below.
2. **The input asks for a change**, or `changes.md` has an `open` entry: load `fbs:changes` with the Skill tool and follow it. The stage it hands back to is the starting point.
3. **Spec not approved** (Big), or not gated (Mid): plan.
4. **Big design not approved, or Mid spec gated but not approved:** architect. Also architect when the project has a tracker (`fbs tracker show` names one) and `<dir>/tracker.md` is missing or not `created` or `Skipped`: the tracker structure exists before any implementation.
5. **Bug or tiny:** tdd for a bug that has no fix yet; otherwise verify.
6. **`plan.md` missing, or with tasks that aren't `done`, or the final review not approved:** implement.
7. **A UI acceptance criterion with no validation evidence on the current tree:** validate.
8. **No current stamp** (`fbs stamp check <slug>` isn't `ok`): verify.
9. **Stamped, no PR yet:** open-pr.
10. **PR open:** camp-pr (it resumes from the record and the PR's state, and says when it's ready to land).

**A plain feature cut from another feature's branch** (its record's `branch.parent` is that feature's branch) runs `fbs stack sync <slug>` before each step, as a stack does: once the feature below has landed (through `fbs land` or outside it), its `restack` moves this branch onto the default branch (`null`: nothing was due). Read its `outside` and a restack with `done: false` as the stack paragraph below says.

**When the user asks to merge or land**, in plain words: follow "Landing on request" in `<plugin root>/skills/land/SKILL.md` (Read tool). Never land any other way: from the moment a PR is recorded, the guard denies `gh pr merge` and MCP merges. To land over red or cancelled checks the user asked to land despite, follow "Over red checks" there.

**A feature with work units** (its record lists `units`) ships as a stack of PRs, one per unit, worked bottom-up. Rules 1 to 4 apply to the feature as above (architect also creates the unit records and the tracker structure after the design approval: when the design has units the record doesn't list yet, or `<dir>/tracker.md` isn't `created` or `Skipped`, that's architect). After them, first run `fbs stack sync <slug>`. It keeps every unit holding the latest of the unit below (merging it forward) and fast-forwards from origin; it records a unit whose PR was merged outside `fbs land` as landed; and it restacks the unit above a landed one: a rebase onto the default branch, so its PR lists only its own commits, one force-push with a lease from inside the CLI, and its PR retargeted (a unit based on the default branch is only fast-forwarded: a moved base is camp's). With local documents (`docs: local`) every unit reads the same files, so it carries only code. Act on what it prints:

- Push each unit it reports with `pushNeeded` (`fbs push <unit>`).
- `outside` entries: `landed` is a landing like any other (the rules below verify what moved, and camp stops when every unit has landed); `closed`, `merged-elsewhere`, `gh-failed`, and a warning in any `reason` (commits that didn't land): tell the user, one line each.
- A unit with `done: false`, by `kind`: `conflict` is a build-level change for that unit (load `fbs:changes`, then implement resolves it on that unit, and sync runs again); `retarget-failed` or `push-rejected`, run sync once more and show the reason if it stops again; `dirty` (the checkout changed during the restack: the local branch stays at its old tip, and the reason says how to stash, reset and pop), `diverged`, `gone` or `missing-below`, show the reason to the user and do what they choose; `not-merged-yet`, sync again on the next step.

Whether a unit needs verifying again is never read from sync's output: the rules below check each unit's stamp. Camp starts with the first open PR, and its rounds come before building more. Then the first that applies, each stage run on the **lowest** unit not landed that it fits, by the unit's slug:

1. **A unit's PR is open and no watcher runs in this session, or one runs but started before the newest unit PR opened:** start the stack's camp, camp-pr's steps 1 and 2 with the feature's slug (`fbs camp start`, then `fbs watch-pr` in the background; a running watcher is stopped and started again, as step 2 says), even while later units are still to be built. Then, instead of ending your turn there, go on with these rules: the watcher wakes you when a round settles.
2. **The watcher woke:** handle its report with camp-pr (from its step 3) before anything else. During implement, finish the task in progress first. Once the round is handled and the watcher started again, come back to these rules rather than ending your turn.
3. A unit whose `plan.md` (in the unit's `dir`) is missing, has tasks that aren't `done`, or a final review not approved: implement. Units are built in order, each on top of the one below.
4. A unit with a UI acceptance criterion among those it covers and no validation evidence on its current tree: validate.
5. A unit with no current stamp: verify.
6. A unit with no PR: open-pr.
7. Every unlanded unit's PR open: camp-pr with the feature's slug works the whole stack (its watcher already running: end your turn and wait for it).
8. Every unit landed: say the feature is done.

A stage run on a unit hands back here when it's done, instead of continuing into its usual next stage: the stack decides what comes next.

## 3. Go

Say in one line where the feature stands and which stage you're starting (for example "Spec and design approved, 7 of 13 tasks done: continuing the build"). Then read `<plugin root>/skills/<stage>/SKILL.md` with the Read tool and follow it, passing the slug, the plugin root and the user's request. From there each stage continues into the next.

Never skip an approval the stage owns, and never repeat work a document already holds.
