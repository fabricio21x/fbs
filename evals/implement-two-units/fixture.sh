#!/usr/bin/env bash
# A Big feature with an approved design split into two work units, each with its record, so assemble must build them in order on stacked branches, each with its own plan.
set -euo pipefail

git init -q -b main
git config user.email eval@example.com
git config user.name eval
dir="docs/features/bill-split"
mkdir -p src "$dir"

cat > CLAUDE.md <<'EOF'
# tabs

Splits restaurant bills. TypeScript on Bun. Run the tests with `bun test`. Comments only for a non-obvious why.
EOF
cat > package.json <<'EOF'
{ "name": "tabs", "private": true, "type": "module", "scripts": { "test": "bun test" } }
EOF
cat > src/money.ts <<'EOF'
export type Cents = number;

export function toCents(amount: number): Cents {
  return Math.round(amount * 100);
}
EOF
cat > src/money.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { toCents } from "./money";

test("converts an amount to whole cents", () => {
  expect(toCents(12.345)).toBe(1235);
});
EOF

cat > "$dir/spec.md" <<'MD'
# Bill split

- Size: big
- Feature: bill-split

## Problem
Friends splitting a restaurant bill work out each share and the tip by hand, and get the cents wrong.

## Goal and success measure
Goal: the app computes each person's share and the tip in cents. Success: both functions are used by the checkout screen without manual rounding.

## Users affected
- Diners splitting a bill.

## Scope
- Split a total in cents between a number of people.
- Compute a tip in cents from a total and a percentage.

## Out of scope
- Currency conversion: one currency only.

## Acceptance criteria
- [ ] Splitting a total between N people gives each person the total divided by N, rounded up to the next cent, so the shares never add up to less than the total.
- [ ] Splitting between zero or fewer people is rejected with an error.
- [ ] A tip is the total times the percentage, rounded to the nearest cent.

## Facts
- Amounts are handled in cents (CLAUDE.md)

## Assumptions
None

## Open questions
None

## Design
(Mid only; written by /fbs:architect)

## Decision log
- 2026-10-23: Round shares up, not to nearest. Why: the restaurant must never be short.
MD

cat > "$dir/design.md" <<'MD'
# Design: Bill split

- Feature: bill-split
- Spec: docs/features/bill-split/spec.md

## Impact
None: two new pure functions next to `src/money.ts`.

## Constraints
- Amounts are `Cents` (`src/money.ts`).

## Options considered
One option: two pure functions. Nothing else competes for two calculations.

## Decisions
1. `splitBill` throws a `RangeError` for fewer than one person. Why: a programming error, not user input.

## Data shapes
- `splitBill(total: Cents, people: number): Cents`
- `tipAmount(total: Cents, percent: number): Cents`

## Module boundaries
Both are pure functions with no imports beyond `src/money.ts`.

## File map
```
src/
  split.ts       splitBill
  split.test.ts  its tests
  tip.ts         tipAmount
  tip.test.ts    its tests
```

## Test seams
- Criteria 1 and 2: `src/split.test.ts`.
- Criterion 3: `src/tip.test.ts`.

## Work units
### U1: Split shares
- Covers: AC1, AC2
- Depends on: none
- Ships: `splitBill` and its tests.
- Files: `src/split.ts`, `src/split.test.ts`
### U2: Tip amount
- Covers: AC3
- Depends on: U1
- Ships: `tipAmount` and its tests.
- Files: `src/tip.ts`, `src/tip.test.ts`

## Risks
None

## Rollout
Merged and used by the checkout screen in a later change.

## Facts
- Amounts are handled in cents (CLAUDE.md)

## Assumptions
None

## Open questions
None

## Gulag outcome
**Panel:** skipped for this fixture.

## Decision log
- 2026-10-23: Two pure functions. Why: nothing else competes.
MD

git add -A
git commit -qm "docs: bill-split spec and design"

spec_sha="$(shasum -a 256 "$dir/spec.md" | cut -d ' ' -f 1)"
design_sha="$(shasum -a 256 "$dir/design.md" | cut -d ' ' -f 1)"
mkdir -p .git/fbs/features
cat > .git/fbs/features/bill-split.json <<JSON
{
  "slug": "bill-split",
  "dir": "$dir",
  "size": "big",
  "approvals": {
    "spec": { "at": "$(date +%F)", "quote": "approved", "sha256": "$spec_sha" },
    "design": { "at": "$(date +%F)", "quote": "approved", "sha256": "$design_sha" }
  },
  "pr": null
}
JSON

fbs branch bill-split --type feature > /dev/null
fbs status init split-shares --unit-of bill-split > /dev/null
fbs status init tip-amount --unit-of bill-split > /dev/null
