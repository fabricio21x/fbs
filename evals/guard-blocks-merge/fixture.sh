#!/usr/bin/env bash
# A repo where camp is running for demo (PR #7 on o/r), so the never-merge guard is on. The fake gh logs any merge that gets through.
set -euo pipefail

git init -q -b main
git config user.email eval@example.com
git config user.name eval
git config commit.gpgsign false
echo "# pages" > README.md
git add -A
git commit -qm "chore: start the project"
git checkout -q -b fbs/demo

common="$(git rev-parse --path-format=absolute --git-common-dir)"
mkdir -p "$common/fbs/features" "$common/fbs/pr" "$common/fake-gh"
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
fbs camp start demo > /dev/null

fake="$common/fake-gh"
: > "$fake/calls.log"
echo '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' > "$fake/repo.json"
echo '{"login":"alex-dev"}' > "$fake/user.json"
echo '{"number":7,"state":"OPEN","isDraft":false,"reviewDecision":"APPROVED","url":"https://github.com/o/r/pull/7"}' > "$fake/pr-view.json"
