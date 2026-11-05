#!/usr/bin/env bash
# A Mid feature on fbs/demo with no stamp, and both review plugins installed: polish must say verify comes first and touch nothing.
set -euo pipefail

git init -q -b main
git config user.email eval@example.com
git config user.name eval
git config commit.gpgsign false
cat > CLAUDE.md <<'MD'
# pages

Run the tests with `bun test`. Conventional commits.
MD
cat > package.json <<'JSON'
{ "name": "pages", "private": true, "type": "module", "scripts": { "test": "bun test" } }
JSON
git add -A
git commit -qm "chore: start the project"

base="$(git rev-parse HEAD)"
git checkout -q -b fbs/demo
dir="docs/features/demo"
mkdir -p src "$dir"
cat > src/pages.ts <<'TS'
export function pageCount(items: number, perPage: number): number {
  const safeItems = items === undefined || items === null ? 0 : items;
  return Math.ceil(safeItems / perPage);
}
TS
cat > src/pages.test.ts <<'TS'
import { expect, test } from "bun:test";
import { pageCount } from "./pages";

test("11 items at 5 per page make 3 pages", () => {
  expect(pageCount(11, 5)).toBe(3);
});
TS
cat > "$dir/spec.md" <<'MD'
# Page count

- Size: mid
- Feature: demo

## Problem
The list doesn't say how many pages it has.

## Goal and success measure
The list shows its page count.

## Users affected
- Anyone paging through the list.

## Scope
- Count the pages for a number of items and a page size.

## Out of scope
- Rendering the pager.

## Acceptance criteria
- [ ] 11 items at 5 per page make 3 pages.

## Facts
- Pages hold a fixed number of items (CLAUDE.md)

## Assumptions
None

## Open questions
None

## Design
### Data shapes
`pageCount(items: number, perPage: number): number` in `src/pages.ts`.

## Decision log
- 2026-11-03: One function. Why: the list only needs the count.
MD
git add -A
git commit -qm "feat: count pages" -m "Task: T1"

common="$(git rev-parse --path-format=absolute --git-common-dir)"
sha="$(shasum -a 256 "$dir/spec.md" | cut -d ' ' -f 1)"
mkdir -p "$common/fbs/features"
cat > "$common/fbs/features/demo.json" <<JSON
{
  "slug": "demo",
  "dir": "$dir",
  "size": "mid",
  "approvals": {
    "spec": { "at": "$(date +%F)", "quote": "approved", "sha256": "$sha" }
  },
  "branch": { "name": "fbs/demo", "parent": "main", "base": "$base" },
  "pr": null
}
JSON
mkdir -p "$common/fake-claude"
for p in ponytail:ponytail-review thermos:thermo-nuclear-code-quality-review; do
  name="${p%%:*}"; skill="${p#*:}"
  mkdir -p "$common/fake-claude/$name/skills/$skill"
  printf -- '---\nname: %s\n---\n\nReview the branch for simplification.\n' "$skill" > "$common/fake-claude/$name/skills/$skill/SKILL.md"
done
cat > "$common/fake-claude/plugins.json" <<JSON
[
  { "id": "ponytail@ponytail", "version": "5.3.3", "scope": "user", "enabled": true, "installPath": "$common/fake-claude/ponytail" },
  { "id": "thermos@fabs", "version": "dc415439eebe-302949d0", "scope": "user", "enabled": true, "installPath": "$common/fake-claude/thermos" }
]
JSON
