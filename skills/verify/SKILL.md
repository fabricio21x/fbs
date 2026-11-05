---
name: verify
description: "The shipping gate: check every acceptance criterion against evidence from the current tree (a green test that asserts it, or validate evidence captured on this tree), check nothing major is open, write verdict.md, and on a pass record a stamp with the fbs CLI. Never stamps a fail."
disable-model-invocation: true
argument-hint: "[feature slug]"
allowed-tools: Bash(fbs *)
---

# Verify

Decide whether this tree is ready to ship, from evidence only. A criterion nobody proved is unverified, however likely it is to work. A pass becomes a stamp the CLI checks; a fail says exactly what's missing.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: the feature slug given in the arguments or by the calling skill: $ARGUMENTS

Run every `fbs` command as its own Bash call, with nothing chained, piped or redirected.

**Work from the files.** Load or read each skill, template and agent this stage names when its step comes, the way the step says, even if it ran earlier in this session. The documents hold what is settled. Once the spec is approved, anything the user says that changes it or the design, and anything this stage finds they can't hold, goes through the change path first (load `fbs:changes` with the Skill tool), so it's written down before it's acted on.

**Keep going.** Never ask the user to type a command. When this stage is done and nothing is pending (an approval, a decision, a blocker), say in one line what you're starting and continue into the next stage yourself: read its SKILL.md under `<plugin root>/skills/` with the Read tool and follow it, with the slug and the plugin root.

**Ask with the question UI.** Every question to the user, approvals and go-aheads included, goes through the AskUserQuestion tool when it is available, with what the user needs to answer shown in the chat right before it (`fbs:grilling`'s rules). Plain text only when the answer can't be options, or without the tool.

## 1. Precondition

1. Run `fbs status show <slug>` and take `size` and `dir`. On `error: missing`, ask whether this is a tiny change (one or two files, no new data shape); if so, run `fbs status init <slug> --size tiny` and take `dir`; otherwise the work needs a feature first: continue into plan (or tdd, for a bug). No slug, any other `error:`, or exit 2: report it and stop. Also take `docs` and `docsRoot` from `fbs status show <slug>`: `docsRoot` is where the feature's documents are read and the verdict is written; `docs` is `local` when git ignores them.
   Then switch to the feature's branch: the tree to verify is that one. For the tiny record just made: when the change is committed on a branch other than the default, `fbs branch <slug> --use <that branch>`; when it is uncommitted, `fbs branch <slug> --type <feature, bugfix for a fix, or chore when no behaviour changes>` (it carries it onto a new branch); when it is committed on the default branch, ask the user. Otherwise run `fbs branch <slug> --existing`; `refused: no branch recorded` means the work predates branch records: when the current branch isn't the default branch and holds this feature's commits, run `fbs branch <slug> --use <it>`; otherwise ask the user which branch holds it. Say each `note:` in one line; on `refused:`, show it to the user and do what they choose, never discarding their changes.
2. Big needs current spec and design approvals; Mid a current spec approval; bug and tiny none. A missing approval is settled first: continue into the stage that owns it (plan for the spec, architect for the design); it comes back here.
3. If `git status --porcelain` isn't empty, show what's dirty and ask once (the question UI when available): commit it, or ignore it locally (add it to `.git/info/exclude`, which changes nothing in the repo). A stamp needs a clean tree, so setting it aside doesn't work here. Do what the user chooses and go on; never discard their changes. Then record `git rev-parse HEAD^{tree}` as **the tree**.
4. If `fbs stamp check <slug>` prints `ok`, this tree is already verified: say so, and go to the end (step 8) as on a pass. When it prints `stale: tree changed` and nothing else, run `fbs stamp carry <slug>`. `carried:` means only documents verify doesn't read changed since the stamped tree (a change log, another unit's verdict): quote that line and go to the end as on a pass, reporting the verdict's Suite and Criteria as they stand, never a fresh run. `refused:` or `error:` means it can't carry: verify in full from here.

Load `fbs:principle-prove-it-works` with the Skill tool and follow it for the rest of this stage.

## 2. The criteria

- **Big or Mid:** the acceptance criteria in `<dir>/spec.md`.
- **Bug:** the criterion in `<dir>/bug.md`.
- **A work unit** (its record has `unitOf`): the criteria it `covers` (its `status show` lists them by position: `AC2` is the second criterion of the feature's `spec.md`). A unit that covers none is setup: it has no criteria, and passes on the suite and its plan's final review.
- **Tiny:** ask the user, in one question, for the outcome to check; it becomes the only criterion. When the calling skill passes the outcome (afk passes the goal the user approved), take it instead of asking; for a feature with an afk run (`fbs afk show <slug>` prints one), the outcome is its `run.goal`, so a later verify (a camp fix round) doesn't ask either.

## 3. The suite

Find the test and type-check commands (the ones `<dir>/plan.md` or `<dir>/bug.md` records, otherwise `CLAUDE.md`, `package.json` scripts or the equivalent) and run both. Quote the summary lines. A failing test not in the baseline that `plan.md` or `bug.md` records (none when neither exists) is an open issue. For a feature with an afk run (`fbs afk show <slug>` prints one), the baseline is its `run.testBaseline`.

## 4. Each criterion

Find its evidence, in this order:

1. **A test** that ran green in step 3 and whose assertions check this criterion's outcome. Read the test: a name that matches isn't enough. Cite `path:line` and the test's name.
2. **Validate evidence**: a `[x]` entry for this criterion in an `index.md` under `<git common dir>/fbs/evidence/<slug>/` (find it with Glob and Read; `git rev-parse --path-format=absolute --git-common-dir` gives the path). It counts when its recorded tree equals **the tree**, or when `git diff --name-only <its recorded commit> HEAD` lists only files under `<dir>/` or `.fbs/`: documents changed, the product didn't. Otherwise it's stale; say so. For a feature with a met afk run whose evidence is stale (a camp fix round changed the code), refresh it instead of asking anyone: run `fbs afk final <slug>` with Bash `run_in_background` and wait for its completion notification (it can take many minutes), then use the index it writes. When its `met` is false, that's an open issue.

A criterion with neither is unverified. Never run code of your own to stand in for missing evidence: it stays unverified until validate or a real test covers it.

## 5. Open issues

From `<dir>/plan.md` when it exists: escalated or blocked tasks, and a final review whose verdict isn't `approve` or `approve-with-comments`. Plus failing tests from step 3. Each is an open issue.

## 6. The verdict

Read `${CLAUDE_SKILL_DIR}/verdict-template.md` (if unexpanded: `<plugin root>/skills/verify/verdict-template.md`) and write `verdict.md` under `docsRoot` (the stamp in step 7 still takes the repo-relative `<dir>/verdict.md`), replacing each guidance comment with its content. `Verdict: pass` only when every criterion is `[x]` and there are no open issues; otherwise `Verdict: fail`.

When `docs` is `tracked`, commit it (`docs: verify <slug>`, no attribution lines): the stamp needs a tracked verdict committed and the tree clean. When `local`, don't commit it: the stamp reads it from disk and binds its sha256, so editing it later makes the stamp stale.

## 7. Stamp

On a pass: run `fbs stamp set <slug> --verdict <dir>/verdict.md` (the repo-relative path, local or tracked), then `fbs stamp check <slug>`, and quote both.

- `refused:` lines: report each one and stop. Never edit the verdict or the code to get past a refusal.
- `ok` from check: the tree is verified.

On a fail: never run `fbs stamp set`.

## 8. End

Report the verdict, the suite line, and each criterion with its evidence or what's missing.

- **Pass:** continue into open-pr (it stops with "verified, ready to push" when the repo has no GitHub remote). When a calling stage (open-pr, camp-pr, polish) ran verify, hand back to it instead; for a work unit, hand back to assemble with the feature's slug. Any change to the tree from here on needs verifying again (one to documents only is carried, step 1.4).
  - Only when verify itself continues into open-pr (no calling stage), for a Mid or Big feature with no afk run and no `<git common dir>/fbs/evidence/<slug>/polish/` folder yet: run `fbs polish check`. On exit 0, ask once: polish first (read `<plugin root>/skills/polish/SKILL.md` and follow it; it reviews the branch for simplification and verifies again), or open the PR now. Any other exit: open the PR without asking.
- **Fail:** close the gaps rather than listing them: missing UI evidence continues into validate, unless validate already ran on this tree and recorded that criterion as not driven: then ask the user how to cover it (a walkthrough, a test, or accepting it as unverified); a missing test or an open issue goes through the change path and on into implement; then verify runs again. Stop and ask only when a gap needs the user's call.
