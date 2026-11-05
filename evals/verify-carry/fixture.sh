#!/usr/bin/env bash
# A verified Mid feature, stamped, then one change-log entry committed after the stamp: only documents verify doesn't read moved.
set -euo pipefail

git init -q -b main
git config user.email eval@example.com
git config user.name eval
git commit -q --allow-empty -m "chore: start the project"
base="$(git rev-parse HEAD)"
git checkout -q -b fbs/receipt-total
dir="docs/features/receipt-total"
mkdir -p src "$dir"
cat > CLAUDE.md <<'EOF'
# receipts

Run the tests with `bun test`.
EOF
cat > package.json <<'EOF'
{ "name": "receipts", "private": true, "type": "module", "scripts": { "test": "bun test" } }
EOF
cat > src/total.ts <<'EOF'
export function formatTotal(cents: number): string {
  if (cents < 0) throw new RangeError("a total can't be negative");
  return `$${(cents / 100).toFixed(2)}`;
}
EOF
cat > src/total.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { formatTotal } from "./total";

test("formats a total in cents as dollars with two decimals", () => {
  expect(formatTotal(1235)).toBe("$12.35");
});

test("rejects a negative total", () => {
  expect(() => formatTotal(-1)).toThrow(RangeError);
});

test("formats a zero total as $0.00", () => {
  expect(formatTotal(0)).toBe("$0.00");
});
EOF
cat > "$dir/spec.md" <<'MD'
# Receipt total

- Size: mid
- Feature: receipt-total

## Problem
Receipts show totals in raw cents.

## Goal and success measure
Receipts show totals as dollars.

## Users affected
- Customers reading a receipt.

## Scope
- Format a total in cents as dollars.

## Out of scope
- Other currencies: one currency only.

## Acceptance criteria
- [ ] A total of 1235 cents is shown as `$12.35`.
- [ ] A negative total is rejected with an error.
- [ ] A zero total is shown as `$0.00`.

## Facts
- Amounts are stored in cents (CLAUDE.md)

## Assumptions
None

## Open questions
None

## Design
### Data shapes
`formatTotal(cents: number): string` in `src/total.ts`.

## Decision log
- 2026-10-23: Format with two decimals. Why: dollars and cents.
MD
git add -A
git commit -qm "feat: format receipt totals"
sha="$(shasum -a 256 "$dir/spec.md" | cut -d ' ' -f 1)"
mkdir -p .git/fbs/features
cat > "$dir/verdict.md" <<MD
# Verdict: Receipt total

- Feature: receipt-total
- Tree: $(git rev-parse 'HEAD^{tree}')
- Date: $(date +%F)

## Suite
\`bun test\`: 3 pass, 0 fail.

## Criteria
- [x] 1235 cents shows as \$12.35 — src/total.test.ts:4 "formats a total in cents as dollars with two decimals"
- [x] A negative total is rejected — src/total.test.ts:8 "rejects a negative total"
- [x] Zero shows as \$0.00 — src/total.test.ts:12 "formats a zero total as \$0.00"

## Open issues
None

## Verdict
Verdict: pass
Every criterion has a green test and nothing is open.
MD
git add -A
git commit -qm "docs: verify receipt-total"
tree="$(git rev-parse 'HEAD^{tree}')"
cat > .git/fbs/features/receipt-total.json <<JSON
{
  "slug": "receipt-total",
  "dir": "$dir",
  "size": "mid",
  "approvals": {
    "spec": { "at": "$(date +%F)", "quote": "approved", "sha256": "$sha" }
  },
  "branch": { "name": "fbs/receipt-total", "parent": "main", "base": "$base" },
  "pr": null,
  "stamp": { "tree": "$tree", "at": "$(date +%F)", "verdict": "pass", "criteria": 3, "evidence": "$dir/verdict.md" }
}
JSON
cat > "$dir/changes.md" <<'MD'
# Changes: receipt-total

## C1
- Date: 2026-11-04
- Source: user
- Words: "Note for later: other currencies may come next year."
- Status: done
- Outcome: nothing to build; recorded for the next feature.
MD
git add "$dir/changes.md"
git commit -qm "docs: record change 1 for receipt-total"
