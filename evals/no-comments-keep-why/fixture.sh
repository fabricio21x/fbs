#!/usr/bin/env bash
# A branch that adds a narrating comment and commented-out code next to a comment that explains a provider workaround.
set -euo pipefail

git init -q -b main
git config user.email eval@example.com
git config user.name eval
mkdir -p src
cat > CLAUDE.md <<'EOF'
# shop

Run the tests with `bun test`. Comments only for a non-obvious why.
EOF
cat > package.json <<'EOF'
{ "name": "shop", "private": true, "type": "module", "scripts": { "test": "bun test" } }
EOF
cat > src/item.ts <<'EOF'
export interface Item {
  price: number;
}
EOF
git add -A && git commit -qm "initial"

git checkout -q -b feat/cart-total
cat > src/cart.ts <<'EOF'
import type { Item } from "./item";

// loop over the items and add up the prices
export function total(items: Item[]): number {
  // const old = items.length * 10;
  const sum = items.reduce((acc, item) => acc + item.price, 0);
  // The payment provider rejects amounts with more than 2 decimals, so round before sending.
  return Math.round(sum * 100) / 100;
}
EOF
cat > src/cart.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { total } from "./cart";

test("adds up the item prices, rounded to cents", () => {
  expect(total([{ price: 0.1 }, { price: 0.2 }])).toBe(0.3);
});
EOF
git add -A && git commit -qm "feat: cart total"
