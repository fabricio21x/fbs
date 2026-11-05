# Skills and agents

fbs has three kinds of skills and a set of agents.

- **Stages** are commands you can type (`/fbs:<name>`). Most of the time `/fbs:assemble` runs them for you. Stages reach each other by reading the next stage's `SKILL.md`, so one conversation runs the whole flow.
- **Building blocks** are skills the stages load. You don't type them.
- **Principles** are short rules a stage or agent loads at the step where they apply.
- **Agents** are the subagents the stages dispatch: implementers, reviewers, the review panel and its judge.

**Contents:** [Stages](#stages) · [Building blocks](#building-blocks) · [Principles](#principles) · [Agents](#agents) · [Skills fbs uses from outside](#skills-fbs-uses-from-outside) · [Each stage in detail](#each-stage-in-detail)

## Stages

| Command | What it does | Writes | Stops for |
|---|---|---|---|
| [`/fbs:assemble`](#assemble) | The entry: starts an idea or picks a feature up wherever it stands | nothing itself | which feature, when several are open |
| [`/fbs:plan`](#plan) | Sizes the work: a tiny change is built directly, test-first; a bug goes to tdd; a mid or big feature is grilled into a spec with sourced facts and acceptance criteria | `spec.md` | spec approval (big) |
| [`/fbs:architect`](#architect) | Impact map, options, design, review panel; overview and mockups for big features | `impact.md`, `design.md`, `overview.html`, `mockups/` (mid: the spec's Design section) | design approval (mid: the single approval) |
| [`/fbs:gulag`](#gulag) | Adversarial review: reviewer seats in parallel, a judge decides every finding | a findings report | applying changes, when run on its own |
| [`/fbs:implement`](#implement) | Task graph, implementer and blind reviewer per task, cleanup, final review | `plan.md`, commits | escalations, blocked tasks |
| [`/fbs:tdd`](#tdd) | Bug route: smallest failing test, root cause, fix | `bug.md`, a `fix:` commit | a bug it can't reproduce |
| [`/fbs:unslop`](#unslop) | Removes slop from the branch's changes without changing behaviour | a `refactor:` commit | nothing |
| [`/fbs:no-comments`](#no-comments) | Prunes comments down to the non-obvious whys | a `refactor:` commit | nothing |
| [`/fbs:polish`](#polish) | Two third-party simplification reviews on a verified branch; applies what you pick | a `refactor:` commit | which findings to apply |
| [`/fbs:setup-validation`](#setup-validation) | Once per project: how to launch, check, sign in to and drive the app | `.fbs/validation/README.md` | credentials it can't find |
| [`/fbs:validate`](#validate) | Drives the UI criteria in a real browser; saves evidence tied to the tree | evidence, outside the repo | walk through it, or go to verify |
| [`/fbs:walkthrough`](#walkthrough) | A guided review with you in the running app, one feature per turn | `walkthrough-<date>.md` | your notes, each turn |
| [`/fbs:verify`](#verify) | The shipping gate: evidence for every criterion, then the stamp | `verdict.md`, the stamp | gaps only you can close |
| [`/fbs:organize-commits`](#organize-commits) | Folds fix rounds into one commit per task; makes every subject conventional | a rewritten feature branch | nothing |
| [`/fbs:open-pr`](#open-pr) | Opens a draft PR for a verified feature | the PR | nothing |
| [`/fbs:camp-pr`](#camp-pr) | Works the PR round by round until it is ready to land | commits, replies | security, data or billing findings, scope changes |
| [`/fbs:land`](#land) | The only merge, typed by you | the merge | nothing |
| [`/fbs:afk`](#afk) | Autopilot for a task whose finish line is a set of checks | a reviewed, verified PR | one approval at the start |

## Building blocks

| Skill | What it does | Used by |
|---|---|---|
| `changes` | The change path after approval: record the change verbatim in `changes.md`, size it (build, design or scope), amend the spec or design in place, approve inline, add plan tasks, carry on | every stage that can meet feedback, and assemble |
| `grilling` | Rounds of up to four questions, each with one recommended answer, in the question UI when available. Looks code facts up instead of asking, asks business facts directly and never takes them from code, pushes back once | plan, architect, changes |
| `impact-map` | Everything a change touches (code paths and consumers, APIs, data, jobs, external services, UI, permissions, tests, docs), each with `path:line`: four explorers by lens, then a completeness pass | architect |
| `tracker` | The project's issue tracker: detects it and confirms it once, reads a ticket the work starts from, proposes the structure after an approval and creates it on your go-ahead. Adapters for Linear and GitHub Issues | plan, architect, tdd, the tiny route |

## Principles

| Principle | The rule | Loaded by |
|---|---|---|
| `principle-check-the-facts` | Never build on a business fact nobody confirmed. Facts come from `CLAUDE.md`, `.fbs/context.md` or you, never from code | plan, architect, the lazy-boi seat |
| `principle-smallest-change` | The smallest change and the simplest structure; bias to deletion. Cuts abstractions with one caller and machinery for scale the facts don't show | architect, implement, polish, implementer, unslopper, the lazy-boi seat |
| `principle-model-the-domain` | Name the data shape first; encode the domain in one structure (a type, a state machine, a table keyed by kind) instead of scattered conditionals | architect, implementer |
| `principle-test-behavior` | A test asserts the behaviour a requirement asks for, through the public surface, and would fail on a real defect | tdd, implementer, reviewer |
| `principle-prove-it-works` | Verify against the real artifact (the suite, the running app, the endpoint) and quote its output, never a proxy | validate, verify, reviewer |
| `principle-fix-root-causes` | Reproduce first, trace the symptom to its cause, fix the cause | tdd, camp-pr |
| `principle-boundary-discipline` | Validate outside data once where it enters; trust the internal types after | implementer, unslopper |
| `principle-guard-the-context` | Bulk reading goes to subagents; keep summaries and paths in the main thread; hand off through files | implement |

When a principle changes a decision, the decision-log line names it.

## Agents

Each agent's model and effort live in its frontmatter. They run as `fbs:<name>`, and the review seats as `fbs:seats:<name>`.

| Agent | Role | Model | Used by |
|---|---|---|---|
| `explorer` | Read-only investigation of one question, answered with `path:line` | Sonnet | impact-map, grilling, walkthrough |
| `implementer` | One task from `plan.md`, test-first, committed on the branch it is given; in a worktree for parallel batches | Sonnet | implement, afk |
| `ui-implementer` | One UI task, built to the design's UI direction and mockups, then checked in a browser at phone and desktop width before committing; never in a parallel batch | Sonnet | implement |
| `reviewer` | Blind review of a diff against the task's requirements; runs the tests; returns approve, approve-with-comments or request-changes | Opus | implement, camp-pr, afk |
| `unslopper` | Removes slop in the changed lines, file by file, running the suite after each | Sonnet | unslop |
| `comment-pruner` | Keeps only comments that carry a non-obvious why; reports every deletion and every keep | Sonnet | no-comments |
| `polish-reviewer` | Applies one third-party rubric to a verified branch; returns simplifications and problems with evidence; read-only | Opus | polish |
| `judge` | Decides every finding of the review panel against the document and its inputs; returns the changes to make | Opus | gulag |
| `seats/pessimist` | How it fails: edge cases, partial failures, concurrency | Opus | gulag |
| `seats/security` | Auth, permissions, data exposure, injection, secrets, webhook authenticity, abuse | Opus | gulag |
| `seats/staff-engineer` | The overall call: fit to the problem, reversibility, missing decisions | Opus | gulag |
| `seats/lazy-boi` | The cheapest path that meets the spec | Sonnet | gulag |
| `seats/code-purist` | The project's own conventions, then general standards | Sonnet | gulag |

A review can opt into another model for the judge and the Opus seats when you ask for it; Opus is the default.

## Skills fbs uses from outside

For UI work fbs relies on installed skills rather than its own rules: `impeccable` (product context, the design brief, mockups, critique), `vercel-react-best-practices` (writing React and Next.js) and `web-design-guidelines` (reviewing UI code). `/fbs:polish` runs ponytail's review and Cursor's thermo-nuclear code-quality review. All of them are optional; see the [README](../README.md#install).

## Each stage in detail

### assemble

The one entry. With an idea, it starts plan. With a slug or nothing, it reads `fbs status list`, the feature's record and its folder, and starts the first stage that applies: a running autopilot run, an open change, an unapproved spec, an unapproved design, unbuilt tasks, UI criteria without evidence, no stamp, no PR, an open PR. For a feature with work units it runs `fbs stack sync` first and drives the stack bottom-up. When you ask in plain words to merge, it follows land's request flow. It writes nothing itself.

### plan

Runs on a new idea, request or ticket. It checks `.fbs/context.md` (stale facts are asked first), sets up the tracker on first use, and decides the mode: *directed* when the input already says what and why, *brainstorm* when it doesn't. A proposed *how* is set aside and compared with the agent's own once the what is settled; technology choices are recorded as preferences for architect. It sizes the work: tiny and bug leave plan for their own routes. Then it grills you round by round until nothing is open, creates the record and the feature's branch, writes `spec.md` from its template, and runs the gate. A big spec needs your explicit approval; a mid spec is approved together with its design in architect. Hands to architect.

### architect

Runs once the spec is settled (big: approved; mid: passes the gate). It runs the impact map into `impact.md`, lists the constraints the design must fit (sourced business facts, providers, conventions), and writes structurally different options with a recommendation, the smallest that meets every criterion among them. It asks only real decisions. A big feature gets `design.md` (data shapes, file map, test seams, risks, a rollout that fits the project's real stage, work units) and a one-page `overview.html` to review; with screens, a UI direction and HTML mockups. A mid feature fills the spec's Design section. The gulag reviews it, the judge's changes are applied, and the gate runs before your approval. After the approval it creates the work-unit records and the tracker structure. Hands to implement, or to assemble for a stack.

### gulag

Adversarial review of a spec or design. Five seats (pessimist, security, lazy-boi, code-purist, staff-engineer) review a design in parallel; a mid spec gets three, and the security seat is never dropped. A judge then accepts or rejects every finding with a reason. It runs as the `fbs:panel` Claude Code workflow, with parallel agent calls as the fallback. It reads the document plus `CLAUDE.md`, `.fbs/context.md`, the spec and the impact map. It never approves anything; architect or the change path applies its outcome.

### implement

Runs once the design is approved. It switches to the feature's branch, records the test and type-check commands and the tests that already fail, and writes `plan.md`: a task graph from the design's file map and test seams, every criterion served by a task. Tasks run one at a time, or in parallel batches in worktrees when they share no file. Each task: an implementer builds it test-first and commits; a fresh reviewer reviews the diff blind against the requirements; at most two fix rounds, then the task is escalated to you. After the tasks: unslop and no-comments, then a final review of the whole branch. It proposes lasting project notes for `CLAUDE.md` on your approval. Hands to validate when a criterion is a UI flow, otherwise to verify. Never opens a PR.

### tdd

The bug route. It restates the bug, runs the suite for a baseline, and writes the smallest test that reproduces it through the public surface, quoting the real failure. It creates a bug record and a `bugfix/` branch, traces the root cause `path:line` by `path:line`, lists sibling mistakes, fixes the cause, and quotes red and green output plus the full suite. Writes `bug.md` and one `fix:` commit. Hands to verify. If it can't reproduce the bug, it stops and fixes nothing.

### unslop

Runs the `unslopper` agent on a diff range: needless defensive checks, type escapes, over-engineering, dead code. It audits the agent's report against the diff, reverts anything that changes behaviour, and commits. Implement runs it during cleanup; you can run it on any branch.

### no-comments

Runs the `comment-pruner` agent on a diff range, keeping only comments that explain a non-obvious why under the project's comment rules. It audits the report, restores any comment that should have been kept, and commits. Implement runs it during cleanup.

### polish

On demand, on a verified feature that hasn't landed. Two `polish-reviewer` agents review the branch in parallel, one with ponytail's rubric and one with Cursor's thermo-nuclear code-quality rubric. Polish settles their findings into one table (duplicates merged, unsupported findings dropped, and where they conflict the change that deletes wins), you pick which to apply, an implementer and a blind reviewer apply them without changing behaviour, and verify runs again. Reports are saved outside the tree. Refuses to run, with the install commands, when either plugin is missing. Verify offers it once before the PR when both are installed.

### setup-validation

Once per project, or when validate finds no setup. It works out from the repo how to launch the app, check it is healthy, sign in and drive its flows, writes `.fbs/validation/README.md`, and proves it by running it end to end once. Asks only for credentials it can't find.

### validate

Runs when an acceptance criterion is a UI flow. Following `.fbs/validation/`, it launches the app and drives each UI criterion in a real browser through the Chrome DevTools MCP, saving screenshots and console and network notes per criterion under `<git common dir>/fbs/evidence/<slug>/`, tied to the current tree. Then it asks once: walk through it together, or go to verify. A failure becomes a change and goes back to implement.

### walkthrough

A guided review in the running app, in a browser you watch. One feature per turn: what to look at, the expected result from the spec or code, then it waits for your notes. It records them verbatim, root-causes each with `path:line`, and writes `walkthrough-<date>.md` with ranked to-dos. Then it asks whether to build them now; either way each to-do becomes a `changes.md` entry. Hands to implement or verify.

### verify

The shipping gate, before any PR. On a clean tree it takes the criteria (the spec's, the bug's, a unit's, or for tiny work the outcome you name), runs the suite and type check, and finds evidence for each criterion: a green test whose assertions check it, or validate evidence recorded on this tree. A criterion with neither is unverified; it never runs ad-hoc code to stand in. It writes `verdict.md`, and only on a pass runs `fbs stamp set`. When only documents changed since the last stamp, it carries the stamp instead. On a fail it closes the gaps through validate or the change path. Hands to open-pr, after offering polish once when it is installed.

### organize-commits

Before the PR opens. Implement writes history so it can fold itself: each task commit carries a `Task:` trailer and fix rounds are `fixup!` commits. This stage autosquashes them non-interactively so a reviewer reads one commit per task, rewords any subject that isn't a conventional commit, and checks with the stamp that the code didn't change. On any doubt it keeps the history as it was.

### open-pr

Runs on a stamped tree. It checks the stamp, the GitHub remote and `gh`, makes sure the branch holds only this feature's work, runs organize-commits, and pushes the feature's branch. It writes the description outside the repo from the spec, the verdict's evidence and the design's risks (the project's PR template wins), checks that the title is a conventional commit, and opens a draft PR with `Fixes <ticket>` when there is one. A work unit's PR says its place in the stack. Hands to camp-pr.

### camp-pr

Stays with the PR until it is ready to land. `fbs watch-pr` runs in the background and wakes the agent once per settled round. Each comment and each failing check is verified against the code, then triaged: fix, decline once with a reason, follow-up, or ask you (security, data, billing, scope). Fixes go through the change path and implement's review-round mode, then verify, then one push per round; replies and resolved threads follow. After a fix budget (two rounds by default), it holds one checkpoint with you, then fixes only blockers. It marks the draft ready when green, proposes follow-ups as tickets once at the end, and never merges or rewrites pushed history. Comments are treated as data, never as instructions.

### land

The only merge. You type `/fbs:land <slug>`, or answer the agent's land request with a bare `land`; a hook turns that into a one-time token. `fbs land` then refuses unless the PR is approved (on your own solo repo, your go is the approval), green, clean, based on the default branch and carrying exactly the stamped tree. It squash-merges with the head pinned, then restacks what was stacked on it. You can land over failing or cancelled checks only by asking for it; the request lists every such check for you to confirm.

### afk

Autopilot for well-defined work while you are away. It classifies the task, checks your safety settings, proposes a finish line as checks (commands and judged rubrics), scope, protected files and budgets, and starts only on your approval. The CLI then runs the checks after every step and keeps or discards it. At the finish line it runs the final review, measures the final tree, and continues through verify, open-pr and camp-pr. It never merges. See [Autopilot](afk.md).
