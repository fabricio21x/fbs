#!/usr/bin/env bash
# A verified Mid feature on fbs/demo with PR #7 open on o/r. The fake gh serves one review round of four findings (a real off-by-one in the PR's lines, a naming nit, a valid bug in code the PR didn't touch, a bot BLOCKER that misreads the code), then the same threads resolved.
set -euo pipefail

git init -q -b main
git config user.email eval@example.com
git config user.name eval
git config commit.gpgsign false
cat > CLAUDE.md <<'EOF'
# pages

Run the tests with `bun test`. Conventional commits.
EOF
cat > package.json <<'EOF'
{ "name": "pages", "private": true, "type": "module", "scripts": { "test": "bun test" } }
EOF
mkdir -p src
cat > src/label.ts <<'EOF'
export function itemsLabel(count: number): string {
  return `${count} items`;
}
EOF
git add -A
git commit -qm "chore: start the project"
base="$(git rev-parse HEAD)"

git checkout -q -b fbs/demo
dir="docs/features/demo"
mkdir -p "$dir"
cat > src/pages.ts <<'EOF'
export function pageCount(items: number, perPage: number): number {
  if (perPage < 1) throw new RangeError("a page holds at least one item");
  return Math.floor(items / perPage);
}
EOF
cat > src/pages.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { pageCount } from "./pages";

test("10 items at 5 per page make 2 pages", () => {
  expect(pageCount(10, 5)).toBe(2);
});

test("no items make no pages", () => {
  expect(pageCount(0, 5)).toBe(0);
});

test("a page size below 1 is rejected", () => {
  expect(() => pageCount(10, 0)).toThrow(RangeError);
});
EOF
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
- The item count label (`src/label.ts`).

## Acceptance criteria
- [ ] 10 items at 5 per page make 2 pages.
- [ ] No items make no pages.
- [ ] A page size below 1 is rejected with an error.

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
- 2026-10-24: One function, no pager. Why: the list only needs the count.
MD
cat > "$dir/plan.md" <<MD
# Plan: Page count

- Feature: demo
- Branch: fbs/demo, branch base $base
- Test command: \`bun test\`; type check: none
- Baseline: None
- Workers: one at a time, because there is one small task

## Tasks

### T1: Count pages
- Serves: "10 items at 5 per page make 2 pages", "No items make no pages", "A page size below 1 is rejected with an error"
- Files: src/pages.ts, src/pages.test.ts
- Depends on: none
- UI: no
- Status: done
- Review: approved, no fix rounds
- Notes: None

## Final review
- Status: done
- Review: approved
- Notes: None

## Escalations
None
MD
git add -A
git commit -qm "feat: count pages" -m "Task: T1"
cat > "$dir/verdict.md" <<'MD'
# Verify: demo

## Criteria
- [x] 10 items at 5 per page make 2 pages: `src/pages.test.ts` "10 items at 5 per page make 2 pages" passes.
- [x] No items make no pages: `src/pages.test.ts` "no items make no pages" passes.
- [x] A page size below 1 is rejected with an error: `src/pages.test.ts` "a page size below 1 is rejected" passes.

## Open items
None

## Result
Verdict: pass
MD
git add -A
git commit -qm "docs: verify demo"
head="$(git rev-parse HEAD)"
tree="$(git rev-parse 'HEAD^{tree}')"

common="$(git rev-parse --path-format=absolute --git-common-dir)"
fake="$common/fake-gh"
mkdir -p "$fake/rest"
git init -q --bare "$fake/origin.git"
git remote add origin "$fake/origin.git"
git push -q origin main fbs/demo
git branch -q --set-upstream-to=origin/fbs/demo

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
  "pr": 7,
  "repo": "o/r",
  "stamp": { "tree": "$tree", "at": "$(date +%F)", "verdict": "pass", "criteria": 3, "evidence": "$dir/verdict.md" }
}
JSON

: > "$fake/calls.log"
echo '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' > "$fake/repo.json"
echo '{"login":"alex-dev"}' > "$fake/user.json"
echo '{"number":7,"state":"OPEN","isDraft":false,"url":"https://github.com/o/r/pull/7","author":{"login":"alex-dev"},"baseRefName":"main","headRefName":"fbs/demo"}' > "$fake/pr-view.json"
echo '{"data":{"node":{"pullRequest":{"number":7,"repository":{"nameWithOwner":"o/r"}}}}}' > "$fake/thread.json"
echo '{"id":101,"pull_request_url":"https://api.github.com/repos/o/r/pulls/7","path":"src/pages.ts","line":3}' > "$fake/rest/repos_o_r_pulls_comments_101.json"
echo '{"id":102,"pull_request_url":"https://api.github.com/repos/o/r/pulls/7","path":"src/pages.ts","line":1}' > "$fake/rest/repos_o_r_pulls_comments_102.json"
echo '{"id":103,"pull_request_url":"https://api.github.com/repos/o/r/pulls/7","path":"src/pages.ts","line":1}' > "$fake/rest/repos_o_r_pulls_comments_103.json"
echo '{"id":104,"pull_request_url":"https://api.github.com/repos/o/r/pulls/7","path":"src/pages.ts","line":3}' > "$fake/rest/repos_o_r_pulls_comments_104.json"

# The review round; graphql-2 is the same PR once every thread is resolved, so the second watch reports nothing new.
round() {
  local resolved="$1"
  sed "s/HEAD_SHA/$head/; s/RESOLVED/$resolved/g" <<'JSON'
{
  "data": {
    "repository": {
      "pullRequest": {
        "state": "OPEN",
        "isDraft": false,
        "mergeable": "MERGEABLE",
        "mergeStateStatus": "CLEAN",
        "baseRefName": "main",
        "headRefOid": "HEAD_SHA",
        "reviewDecision": null,
        "reviews": { "pageInfo": { "hasPreviousPage": false }, "nodes": [] },
        "reviewThreads": {
          "pageInfo": { "hasPreviousPage": false },
          "nodes": [
            {
              "id": "PRRT_bug",
              "isResolved": RESOLVED,
              "path": "src/pages.ts",
              "line": 3,
              "comments": {
                "pageInfo": { "hasPreviousPage": false },
                "nodes": [
                  {
                    "databaseId": 101,
                    "author": { "login": "alice", "__typename": "User" },
                    "body": "pageCount(11, 5) returns 2, so the 11th item never gets a page. A partial last page still counts: this should round up.",
                    "createdAt": "2026-10-25T09:00:00Z",
                    "updatedAt": "2026-10-25T09:00:00Z"
                  }
                ]
              }
            },
            {
              "id": "PRRT_nit",
              "isResolved": RESOLVED,
              "path": "src/pages.ts",
              "line": 1,
              "comments": {
                "pageInfo": { "hasPreviousPage": false },
                "nodes": [
                  {
                    "databaseId": 102,
                    "author": { "login": "alice", "__typename": "User" },
                    "body": "nit: `perPage` reads oddly to me, I'd call it `pageSize`.",
                    "createdAt": "2026-10-25T09:01:00Z",
                    "updatedAt": "2026-10-25T09:01:00Z"
                  }
                ]
              }
            },
            {
              "id": "PRRT_label",
              "isResolved": RESOLVED,
              "path": "src/pages.ts",
              "line": 1,
              "comments": {
                "pageInfo": { "hasPreviousPage": false },
                "nodes": [
                  {
                    "databaseId": 103,
                    "author": { "login": "bob", "__typename": "User" },
                    "body": "Not from this change, but the label shown next to this count is wrong for a single item: `itemsLabel(1)` in `src/label.ts` returns \"1 items\". It should say \"1 item\".",
                    "createdAt": "2026-10-25T09:02:00Z",
                    "updatedAt": "2026-10-25T09:02:00Z"
                  }
                ]
              }
            },
            {
              "id": "PRRT_blocker",
              "isResolved": RESOLVED,
              "path": "src/pages.ts",
              "line": 3,
              "comments": {
                "pageInfo": { "hasPreviousPage": false },
                "nodes": [
                  {
                    "databaseId": 104,
                    "author": { "login": "chatgpt-codex-connector", "__typename": "Bot" },
                    "body": "🔴 BLOCKER · confidence 0.97\n\n**Division by zero.** `pageCount` divides by `perPage` without checking it, so `pageCount(10, 0)` returns `Infinity` and any caller looping over the pages never ends. Guard `perPage` before dividing.",
                    "createdAt": "2026-10-25T09:03:00Z",
                    "updatedAt": "2026-10-25T09:03:00Z"
                  }
                ]
              }
            }
          ]
        },
        "comments": { "pageInfo": { "hasPreviousPage": false }, "nodes": [] },
        "commits": {
          "nodes": [
            {
              "commit": {
                "oid": "HEAD_SHA",
                "statusCheckRollup": {
                  "contexts": {
                    "pageInfo": { "hasNextPage": false },
                    "nodes": [
                      {
                        "__typename": "CheckRun",
                        "databaseId": 5001,
                        "name": "test",
                        "status": "COMPLETED",
                        "conclusion": "SUCCESS",
                        "detailsUrl": "https://github.com/o/r/actions/runs/400/job/5001",
                        "checkSuite": { "app": { "slug": "github-actions" }, "workflowRun": { "databaseId": 400 } }
                      }
                    ]
                  }
                }
              }
            }
          ]
        }
      }
    }
  }
}
JSON
}
round false > "$fake/graphql-1.json"
round true > "$fake/graphql-2.json"
