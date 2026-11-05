# fbs: project instructions

fbs is a Claude Code plugin: an engineering harness that takes a feature from an idea to a reviewed, verified pull request. It is made of skills (`skills/`), subagents (`agents/`), one workflow (`workflows/panel.js`), hooks (`hooks/hooks.json`, `bin/`) and a TypeScript CLI on Bun (`cli/`). Start with `README.md` and `docs/how-it-works.md`; `CONTRIBUTING.md` has the details.

## Commands

- **Tests:** `bun test`
- **Typecheck:** `bun run typecheck`
- **Plugin validation:** `claude plugin validate .`
- **Evals:** always through `scripts/eval.sh`, never `claude plugin eval` directly (the sandbox can't read `$HOME`, doesn't put the plugin's `bin/` on `PATH`, and hides the environment from the compiled CLI). Keep runs light: `--runs 1` and a `--max-cost-usd` cap.
- **After editing** a skill, an agent or a hook in a local-path install, run `/reload-plugins`.

## Conventions

- Conventional Commits for every commit and PR title.
- Tests first: a failing test before the change, asserting behaviour through the public surface.
- Comments only for a non-obvious why, one line.
- Group by responsibility, not by layer. Prefer the simplest structure a cold reader can follow.
- Anything that must behave the same every time belongs in the CLI with tests, not in skill prose.
- Skill size targets: aim to keep a stage `SKILL.md` under 150 lines, a building block under 120 and a principle under 60; the longest skills run a little over.
- Build fbs from scratch: don't invoke other plugins' skills while building it, and don't copy their text. Plain subagents are fine.
- English everywhere.
