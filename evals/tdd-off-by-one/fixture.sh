#!/usr/bin/env bash
# A small Bun project whose date-range helper drops the last day; the existing tests never cover a multi-day range.
set -euo pipefail

git init -q -b main
git config user.email eval@example.com
git config user.name eval
mkdir -p src

cat > CLAUDE.md <<'EOF'
# stays

Exports guest stays as calendar days. Run the tests with `bun test`.
EOF

cat > package.json <<'EOF'
{ "name": "stays", "private": true, "type": "module", "scripts": { "test": "bun test" } }
EOF

cat > src/range.ts <<'EOF'
const DAY_MS = 24 * 60 * 60 * 1000;

function parse(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function format(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function daysInRange(start: string, end: string): string[] {
  const days: string[] = [];
  for (let ms = parse(start); ms < parse(end); ms += DAY_MS) days.push(format(ms));
  return days;
}
EOF

cat > src/export.ts <<'EOF'
import { daysInRange } from "./range";

export interface Stay {
  guest: string;
  from: string;
  to: string;
}

export function exportStay(stay: Stay): string[] {
  return daysInRange(stay.from, stay.to).map((day) => `${day} ${stay.guest}`);
}
EOF

cat > src/range.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { daysInRange } from "./range";

// A stay's range is inclusive: it lists every calendar day from the first to the last.
test("a range that ends before it starts has no days", () => {
  expect(daysInRange("2026-03-01", "2026-02-28")).toEqual([]);
});
EOF

cat > src/export.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { exportStay } from "./export";

test("each exported line names the guest", () => {
  for (const line of exportStay({ guest: "Ana", from: "2026-03-01", to: "2026-03-05" })) expect(line).toContain("Ana");
});
EOF

git add -A
git commit -qm "initial"
