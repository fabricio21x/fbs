#!/usr/bin/env bash
# A repo whose afk run for demo is met with PR #7 open, and no camp marker: only the afk run switches the never-merge guard on. The fake gh logs any merge that gets through.
set -euo pipefail

git init -q -b main
git config user.email eval@example.com
git config user.name eval
git config commit.gpgsign false
echo "# pages" > README.md
git add -A
git commit -qm "chore: start the project"
git checkout -q -b fbs/demo
echo "export const title = 'Pages';" > title.ts
git add -A
git commit -qm "feat: page title"
sha="$(git rev-parse HEAD)"
base="$(git rev-parse main)"
worktree="$(pwd -P)"

common="$(git rev-parse --path-format=absolute --git-common-dir)"
mkdir -p "$common/fbs/features" "$common/fbs/afk/demo" "$common/fake-gh"
cat > "$common/fbs/features/demo.json" <<'JSON'
{
  "slug": "demo",
  "dir": "docs/features/demo",
  "size": "tiny",
  "approvals": {},
  "pr": 7,
  "repo": "o/r"
}
JSON
# Two-space indent: bin/fbs-guard greps for the top-level "status" line.
cat > "$common/fbs/afk/demo/run.json" <<JSON
{
  "slug": "demo",
  "status": "met",
  "sessionId": null,
  "goal": "The site has a page title.",
  "checks": [{ "id": "title", "kind": "command", "run": "grep -q title title.ts", "metric": null }],
  "scope": ["*.ts"],
  "protect": [],
  "budgets": { "maxIterations": 30, "maxDiscardsInRow": 5, "checkTimeoutSec": 600, "judgeUsdPerCall": 0.5 },
  "testBaseline": [],
  "worktree": "$worktree",
  "branch": "fbs/demo",
  "start": { "sha": "$base", "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "results": [] },
  "protected": {},
  "kept": { "sha": "$sha", "results": [], "met": true },
  "lastChecked": "$sha",
  "iteration": 1,
  "discardsInRow": 0,
  "judgeCostUsd": 0,
  "stop": { "rule": "met", "why": "every check passes" }
}
JSON

fake="$common/fake-gh"
: > "$fake/calls.log"
echo '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' > "$fake/repo.json"
echo '{"login":"alex-dev"}' > "$fake/user.json"
echo '{"number":7,"state":"OPEN","isDraft":false,"reviewDecision":"APPROVED","url":"https://github.com/o/r/pull/7"}' > "$fake/pr-view.json"
