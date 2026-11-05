# Contributing to fbs

Thanks for helping. This page covers how to set up, check and release fbs, and the conventions a change should follow.

## Repo layout

```
.claude-plugin/      plugin.json and marketplace.json (the repo is its own marketplace)
agents/              subagents the stages dispatch; seats/ holds the review panel's reviewers
bin/                 shell entry points: fbs (the CLI), fbs-guard and fbs-afk-stop (hooks)
cli/                 the fbs CLI, TypeScript on Bun, no runtime dependencies, with its tests
docs/                user documentation
evals/               claude plugin eval cases; results/ is gitignored
hooks/hooks.json     the hooks
scripts/eval.sh      the only way to run evals
skills/              stages, building blocks and principles, one folder each, templates beside them
workflows/panel.js   the review panel as a Claude Code workflow
```

## Setup

Requires [Bun](https://bun.sh) 1.3 or newer, git, and Claude Code.

```bash
git clone https://github.com/fabricio21x/fbs.git
cd fbs
bun install
```

To try your working copy in Claude Code, add it as a local marketplace and install from it:

```
/plugin marketplace add /path/to/fbs
/plugin install fbs@fabs
```

A local-path plugin is read in place. Run `/reload-plugins` after editing a skill, an agent or a hook.

## Checks

Run all three before opening a PR:

```bash
bun test
bun run typecheck
claude plugin validate .
```

## Evals

Skills are tested with `claude plugin eval` cases in [`evals/`](evals/). Always run them through `scripts/eval.sh`, never `claude plugin eval` directly:

```bash
scripts/eval.sh --case cli-smoke --ablation none --runs 1 --max-cost-usd 1 --allow-tools "Bash(fbs *)"
```

Why the wrapper exists:

- **The eval sandbox can't read `$HOME`,** so the script copies the plugin to a temp dir and compiles the CLI into `bin/fbs-bin`, which needs no Bun install.
- **Eval runs don't put a plugin's `bin/` on `PATH`,** so the script puts the copy's `bin/` first.
- **macOS `/usr/bin/git` is an xcrun shim** that can't write its cache inside the sandbox, so the copy gets a `bin/git` wrapper for the real binary.
- **The compiled CLI sees an empty environment** inside the sandbox, so `bin/fbs` resolves `git`, `gh` and `claude` itself and passes their paths as leading flags. Environment variables such as `FBS_TODAY` don't reach the CLI in evals; fixtures write dates with `$(date +%F)`.
- **PR and polish cases** answer `gh` and `claude plugin list` from fixture files through fakes the script installs.

Each run gets its own copy and writes to `evals/results/<run>/`, printed as `results:` on stderr. `evals/results/latest` links to the most recently started run, so read the printed path when runs overlap.

**Keep runs light.** One `--runs 1` pass of the cases a change touches, always with a `--max-cost-usd` cap. Use `--scaffold` for cases with a fixture. Run the multi-run suite (`--runs 3 --threshold 0.8`) only before a release.

The eval sandbox has no browser, so `validate`, `setup-validation` and `walkthrough` have no eval cases; test them by hand on a real project.

## Conventions

- **Tests first.** Write the failing test, watch it fail, then make it pass. A test asserts behaviour through the public surface and would fail on a real defect.
- **Conventional Commits** for every commit and PR title: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:` and so on.
- **Comments only for a non-obvious why,** one line. The code says what it does.
- **Group by responsibility, not by layer.** Prefer the simplest structure a cold reader can follow.
- **The CLI decides, the skills describe.** Anything that must behave the same every time (a gate, a stamp, a guard rule) belongs in `cli/` with tests, not in skill prose.
- **Skill size targets:** aim to keep a stage `SKILL.md` under 150 lines, a building block under 120 and a principle under 60; the longest skills run a little over.
- **Write fresh.** Don't copy text from other plugins' skills, and don't use them while building fbs.
- **English everywhere.**

## Releasing

A release reaches installs only when the plugin's version goes up.

1. Bump `version` in `.claude-plugin/plugin.json`. The CLI reads its version from there.
2. Add a section to [CHANGELOG.md](CHANGELOG.md).
3. Commit (`chore: release <version>`), tag `v<version>`, and push the commit and the tag.

Users then pick it up with `claude plugin marketplace update fabs` and `claude plugin update fbs@fabs`.
