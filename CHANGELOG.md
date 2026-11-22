# Changelog

## 0.5.0

**Landing**

- Land on plain words: "go ahead and merge it" works, not only `land`. The hook records the user's own words; scheduled prompts and "not yet" never land.
- Repos with no CI land when the base branch requires no checks.
- GitHub stacks: fbs recognizes a native stack, tells you the whole stack can be merged with `gh stack merge`, and records each merged PR afterwards.
- Rewriting an open PR's branch: a messages-only rewrite passes; anything else needs your words or `fbs rewrite request` and a yes.

**Camp**

- Only the newest run of each check counts, bot comment edits that change nothing are ignored, and quiet review comments are reported without waiting for every check.
- A camp belongs to its session; a second session takes over and says so. PRs merged outside fbs are recorded (`fbs status reconcile`).
- Raw PR comment, reply and review endpoints are denied during a camp; replies go through `fbs pr reply` and `fbs pr comment`.

**Branches, units and stacks**

- Conventional Commit branch types (`feat/`, `fix/`, `chore/`…) beside `feature/bugfix/hotfix`, following the repo's convention or `branches.types`.
- Independent work units can start from the default branch; `fbs status unit --move` renumbers units, and `fbs status move --to` moves a feature to another repo.
- A restack that conflicts falls back to one commit holding the unit's change (git 2.40 or later); a parent branch fbs doesn't know is followed once it's merged.

**Verifying**

- `(rollout)` acceptance criteria: verify passes without them, the PR lists them, and their outcome is recorded after the merge (`fbs status rollout`).
- The stamp carries over a change to another unit's section, a branch tip that isn't checked out, and plain `CLAUDE.md` or `AGENTS.md` edits.
- `verify.suite` for heavy suites, and `verify.ciEvidence` with `fbs ci evidence`: green CI on the exact head commit stands in for the local run.

**Documents**

- A user-level config (`$XDG_CONFIG_HOME/fbs/config.json`) with defaults for every repo or per GitHub owner; `fbs config show` and `fbs config set`.
- `docs.store`: feature documents tracked in the repo or kept local.
- `docs.publish`: the spec, the design and a short changes log mirrored to a documentation tool the session can reach (Notion has an adapter), updated in place after each approval.

**Flow**

- Grilling settles a design-deciding fact before the design instead of leaving it as an open call; questions go in plain text while background work runs.
- Implement runs its baseline in the foreground; the tracker assigns you and records what changed; `fbs push` works from any checkout; every command has `--help`.

## 0.4.0 — first public release

fbs is a Claude Code plugin that takes a feature from an idea to a reviewed, verified pull request in one conversation, with a small CLI that enforces approvals, the verify stamp and a never-merge guard.

**Planning and design**

- `/fbs:assemble`: one entry that starts an idea or resumes a feature wherever it stands.
- `/fbs:plan`: grills an idea into a spec with sourced business facts, accepted assumptions and acceptance criteria; sizes it tiny, bug, mid or big.
- `/fbs:architect`: impact map with `path:line` evidence, structurally different options, a design with data shapes, file map, test seams and rollout, a one-page overview and UI mockups for big features.
- `/fbs:gulag`: adversarial review by five reviewer agents and a judge that decides every finding.
- Project business facts in `.fbs/context.md`, dated, size-limited and rechecked when stale.

**Building**

- `/fbs:implement`: a task graph, each task built test-first by an implementer and reviewed blind, at most two fix rounds, parallel batches in worktrees, cleanup and a final review.
- `/fbs:tdd`: the bug route, from a failing test to a root-cause fix.
- `/fbs:unslop`, `/fbs:no-comments` and `/fbs:polish` for cleanup and simplification.
- The change path: feedback after approval is recorded verbatim, sized, amended in place, approved inline and turned into tasks.

**Verifying**

- `/fbs:setup-validation`, `/fbs:validate` and `/fbs:walkthrough`: drive the real app in a browser and keep evidence tied to the tree.
- `/fbs:verify`: evidence for every acceptance criterion, then a stamp bound to the tree hash; carried over changes to documents only.

**Shipping**

- `/fbs:organize-commits` and `/fbs:open-pr`: one commit per task, Conventional Commits, a draft PR described from the spec and the verdict.
- `/fbs:camp-pr`: works the PR round by round, triaging review comments and CI, with a fix budget and follow-ups proposed as tickets.
- `/fbs:land`: the only merge, typed by the user; landing over failing checks only on the user's explicit request.
- Big features can ship as a stack of PRs, one per work unit, kept in sync and landed bottom-up.
- Linear and GitHub Issues: tickets as input, the tracker structure created on the user's go-ahead.

**Autopilot**

- `/fbs:afk`: works a task with a checkable finish line while you are away. One approval, then the CLI runs command checks and a judged rubric on two votes, keeps or discards each step, and flags dependencies, migrations, infra, scope and test weakening. Ends in a reviewed, verified PR; never merges or deploys.

**Enforcement**

- The `fbs` CLI: feature records, the spec gate, hash-bound approvals, the verify stamp, branches and pushes, the PR watcher, landing and stacks.
- Hooks: a never-merge guard while a PR flow or autopilot run is active, the land token, a check that approval questions follow visible context, and a Stop hook that keeps an autopilot run going.
