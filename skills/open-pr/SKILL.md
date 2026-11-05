---
name: open-pr
description: "Open the PR for a verified feature: check the stamp, fold the commits per task, push the feature branch with a lease, open a draft PR whose description comes from the spec, the verdict's evidence and the design's risks, record it, and continue into camp-pr. Never pushes another branch, never merges."
disable-model-invocation: true
argument-hint: "[feature slug]"
allowed-tools: Bash(fbs *)
---

# Open PR

Put a verified feature in front of reviewers, with everything they need to judge it in the description. Only a verified tree goes up, and only to the feature's own branch.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: the feature slug given in the arguments or by the calling skill: $ARGUMENTS

Run every `fbs` command as its own Bash call, with nothing chained, piped or redirected.

**Keep going.** Never ask the user to type a command. When this stage is done, say in one line what you're starting and continue into camp-pr yourself: read `<plugin root>/skills/camp-pr/SKILL.md` with the Read tool and follow it, with the slug and the plugin root.

**Ask with the question UI.** Every question to the user, approvals and go-aheads included, goes through the AskUserQuestion tool when it is available, with what the user needs to answer shown in the chat right before it (`fbs:grilling`'s rules). Plain text only when the answer can't be options, or without the tool.

## 1. Check

1. Run `fbs status show <slug>` and take `dir`, `docs`, `docsRoot` and `pr`; read the feature's documents under `docsRoot`. When `pr` is already set, the PR exists: continue into camp-pr.
2. `fbs stamp check <slug>` must print `ok`. Otherwise the tree isn't verified: continue into verify (it comes back here on a pass).
3. The repo needs a GitHub remote (`git remote get-url origin`) and `gh` signed in (`gh auth status`). Without them, say the feature is verified and ready to push, and stop. Take the owner/repo and the default branch from `gh repo view --json nameWithOwner,defaultBranchRef`.
4. **Its branch, its parent and only its own work:** run `fbs branch <slug> --existing` and take `branch` (written `<branch>` below) and `parent` from its JSON (on `refused:`, report it and stop); with no recorded parent, the parent is the one `plan.md` records (`Branch: … from <parent>`), else the default branch. When `<branch>` is the default branch (the user chose to work there), there is no PR to open: say the work is committed there, unpushed, and stop. When the parent is another feature's branch (a work unit's included), run `fbs stack sync <slug>` first: when that feature has landed meanwhile, through `fbs land` or outside it, sync rebases this branch onto the default branch, and the parent is the default branch again (take it again from `fbs branch <slug> --existing`). Its `outside` and a restack or unit with `done: false` are handled as assemble says; when it moved the branch, run `fbs stamp check <slug>` again: anything but `ok` continues into verify. Then list `git log --oneline origin/<parent>..HEAD`. When it holds commits that aren't this feature's (another feature's work, commits the local default branch carried), stop and ask the user: split them onto their own branch, or ship them together and say so in the PR description. Never open a PR whose title hides what's in it. A work unit's parent is the branch of the unit below (unit 1: its feature's parent, usually the default branch), and unit 1 also carries its feature's documents (spec, design, tracker) when they're tracked: they belong to it.

## 2. Organize

Read `<plugin root>/skills/organize-commits/SKILL.md` with the Read tool and follow it as its calling skill. Then confirm `fbs stamp check <slug>` still prints `ok`.

## 3. Push

Run `fbs push <slug>`. Organizing may have rewritten commits the stages pushed before, so before the PR exists it pushes with a lease on fbs's own last push: it overwrites only what fbs pushed. A `refused:` (origin has commits fbs didn't push) is reported and stops here, never forced past.

## 4. The description

Read `${CLAUDE_SKILL_DIR}/pr-body-template.md` (if unexpanded: `<plugin root>/skills/open-pr/pr-body-template.md`), and the project's `.github/pull_request_template.md` and any PR rules in `CLAUDE.md` when they exist (they win). Write the body from `spec.md`, `design.md`, `verdict.md` and the branch's commits into `$(git rev-parse --path-format=absolute --git-common-dir)/fbs/pr/<slug>.md`, outside the repo, replacing every guidance comment. Links point at the head commit: `https://github.com/<owner>/<repo>/blob/<head sha>/<path>`.

When `docs` is `local`, the PR carries no spec, design or verdict: leave out the document links, and make the description hold what a reviewer needs from them, every acceptance criterion with its evidence and the suite's summary line.

When the record has a `ticket`, the body ends with `Fixes <id>` on its own line (the adapter's form: `Fixes ACM-124`, `Fixes #45`), and, when a Big feature ships as one PR (no unit records), one such line for each unit id in `<dir>/tracker.md` too. A unit's PR fixes only its own ticket.

The title is a conventional commit subject, whatever the project's PR rules say about the rest: `<type>[(<scope>)]: <the feature in a few words>` (`feat: booking sync`, `fix: …` for a bug; a work unit names its own part: `feat: booking sync reminders`, never the feature's title alone, since each unit's title becomes its own commit on the default branch). Land squash-merges under it, so the title becomes the commit on the default branch. Check it with `fbs commits title '<the title>'` (each `'` inside written as `'\''`) and fix it until it prints `ok`.

## 5. Open it

Put the title in a shell variable first (`title=…`), then `gh pr create --draft --base <the parent branch, without origin/> --head <branch> --title "$title" --body-file <the file>`. Record it with `fbs status pr <slug> <the PR URL it printed>`. Show the URL in one line.

It opens as a draft: camp-pr marks it ready once CI and bot review are green. A work unit's description starts with its place in the stack (`Part <n> of <N> of <the feature>`, the PR below it linked), and its criteria and evidence are only the ones it covers. A PR on another feature's branch is part of a stack: say so in its description, linking the parent PR; it lands after its parent, once GitHub has retargeted it to the default branch.

## 6. Carry on

Continue into camp-pr. For a work unit, hand back to assemble with the feature's slug instead: it starts the stack's camp right away, with this PR, and keeps building and opening the units above.
