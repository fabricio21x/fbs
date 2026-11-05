# Changelog

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
