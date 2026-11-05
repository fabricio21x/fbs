#!/usr/bin/env bash
# Writes a committed repo with a mid feature record whose spec approval is current and a passing verdict with two checked criteria.
set -euo pipefail

git init -q
dir=docs/features/demo
mkdir -p "$dir"
printf '# Demo\n\n## Facts\nNone\n\n## Assumptions\nNone\n\n## Open questions\nNone\n' > "$dir/spec.md"
printf '# Verify\n\n## Criteria\n- [x] The demo page loads\n- [x] The demo button works\n\n## Result\nVerdict: pass\n' > "$dir/verdict.md"
git add -A
git -c user.name=fbs -c user.email=fbs@example.com -c commit.gpgsign=false commit -q -m "demo"

sha="$(shasum -a 256 "$dir/spec.md" | cut -d ' ' -f 1)"
mkdir -p .git/fbs/features
cat > .git/fbs/features/demo.json <<JSON
{
  "slug": "demo",
  "dir": "$dir",
  "size": "mid",
  "approvals": {
    "spec": { "at": "$(date +%F)", "quote": "approved", "sha256": "$sha" }
  },
  "pr": null
}
JSON
