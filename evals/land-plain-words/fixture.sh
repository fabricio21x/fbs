#!/usr/bin/env bash
# A repo where demo's PR #7 on o/r is approved, green and carries its verified tree: the user's plain "merge it" is the go.
# The fake gh refuses the merge itself, so reaching it shows fbs land ran on the token the user's message wrote.
set -euo pipefail

git init -q -b main
git config user.email eval@example.com
git config user.name eval
git config commit.gpgsign false
echo "# pages" > README.md
git add -A
git commit -qm "chore: start the project"

common="$(git rev-parse --path-format=absolute --git-common-dir)"
git init -q --bare -b main "$common/origin.git"
git remote add origin "$common/origin.git"
git push -q origin main
git checkout -q -b feature/demo
echo "hello" > hello.txt
git add hello.txt
git commit -qm "feat: say hello"
git push -q origin feature/demo
head="$(git rev-parse HEAD)"
tree="$(git rev-parse 'HEAD^{tree}')"

mkdir -p "$common/fbs/features" "$common/fake-gh"
cat > "$common/fbs/features/demo.json" <<JSON
{
  "slug": "demo",
  "dir": "docs/features/demo",
  "size": "tiny",
  "approvals": {},
  "pr": 7,
  "repo": "o/r",
  "branch": { "name": "feature/demo", "parent": "main", "base": "$(git rev-parse main)", "pushed": "$head" },
  "stamp": { "tree": "$tree", "at": "2026-11-20", "verdict": "pass", "criteria": 1, "evidence": "docs/features/demo/verdict.md" }
}
JSON

fake="$common/fake-gh"
: > "$fake/calls.log"
echo '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' > "$fake/repo.json"
echo '{"login":"alex-dev"}' > "$fake/user.json"
cat > "$fake/pr-view.json" <<JSON
{"number":7,"state":"OPEN","isDraft":false,"mergeStateStatus":"CLEAN","headRefOid":"$head","headRefName":"feature/demo","baseRefName":"main","title":"feat: say hello","reviewDecision":"APPROVED","author":{"login":"alex-dev"},"statusCheckRollup":[{"__typename":"CheckRun","name":"test","status":"COMPLETED","conclusion":"SUCCESS"}],"url":"https://github.com/o/r/pull/7"}
JSON
