#!/usr/bin/env bash
# A branch that adds a null check its type rules out and an `as any`, next to a signup parser whose validation must stay.
set -euo pipefail

git init -q -b main
git config user.email eval@example.com
git config user.name eval
mkdir -p src
cat > CLAUDE.md <<'EOF'
# accounts

Run the tests with `bun test`.
EOF
cat > package.json <<'EOF'
{ "name": "accounts", "private": true, "type": "module", "scripts": { "test": "bun test" } }
EOF
cat > src/user.ts <<'EOF'
export interface User {
  id: number;
  email: string;
}
EOF
git add -A && git commit -qm "initial"

git checkout -q -b feat/greeting
cat > src/user.ts <<'EOF'
export interface User {
  id: number;
  email: string;
}

export function greeting(user: User): string {
  if (user === null || user === undefined) return "";
  const name = (user.email as any).split("@")[0] as string;
  return `Hi ${name}`;
}
EOF
cat > src/signup.ts <<'EOF'
export interface Signup {
  email: string;
}

export function parseSignup(body: unknown): Signup {
  if (typeof body !== "object" || body === null) throw new Error("invalid signup body");
  const email = (body as Record<string, unknown>).email;
  if (typeof email !== "string" || !email.includes("@")) throw new Error("invalid signup body");
  return { email };
}
EOF
cat > src/user.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { greeting } from "./user";
import { parseSignup } from "./signup";

test("greets a user by the name in their email", () => {
  expect(greeting({ id: 1, email: "ana@example.com" })).toBe("Hi ana");
});

test("rejects a signup body without a valid email", () => {
  expect(() => parseSignup({ email: 42 })).toThrow("invalid signup body");
  expect(() => parseSignup(null)).toThrow("invalid signup body");
});

test("accepts a signup body with an email", () => {
  expect(parseSignup({ email: "ana@example.com" })).toEqual({ email: "ana@example.com" });
});
EOF
git add -A && git commit -qm "feat: greet users and parse signups"
