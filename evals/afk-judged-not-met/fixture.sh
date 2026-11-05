#!/usr/bin/env bash
# A Bun project with a running afk run, started here through the fbs CLI: a passing suite check and a judged rubric on page descriptions the code doesn't meet. In the eval sandbox the CLI can't start the judge, so the judged check fails closed whatever the agent writes.
set -euo pipefail

# scripts/eval.sh puts the eval copy's bin/ (fbs, and a bun the sandbox can read) first on PATH.
fbs_bin="$(command -v fbs || true)"
[ -n "$fbs_bin" ] || { echo "fixture: fbs is not on PATH; run this case through scripts/eval.sh" >&2; exit 1; }
bin_dir="$(dirname "$fbs_bin")"
if [ -x "$bin_dir/bun" ]; then bun_dir="$bin_dir"; else bun_dir="$(dirname "$(command -v bun)")"; fi

git init -q -b main
git config user.email eval@example.com
git config user.name eval
git config commit.gpgsign false
mkdir -p src/pages scripts

cat > CLAUDE.md <<'EOF'
# trailhead

A hiking club's site. TypeScript on Bun. Run the tests with `bun test`. Conventional commits.
EOF
cat > package.json <<'EOF'
{ "name": "trailhead", "private": true, "type": "module", "scripts": { "test": "bun test" } }
EOF
# The fbs CLI runs check commands with an empty environment inside the eval sandbox, so the script pins bun's directory.
cat > scripts/test.sh <<EOF
#!/bin/sh
PATH="$bun_dir:\${PATH:-/usr/bin:/bin}" exec bun test
EOF
cat > src/pages/home.ts <<'EOF'
export const meta = { title: "Trailhead hiking club", description: "Hikes." };
EOF
cat > src/pages/routes.ts <<'EOF'
export const meta = { title: "Routes", description: "Hikes." };
EOF
cat > src/pages/join.ts <<'EOF'
export const meta = { title: "Join the club", description: "" };
EOF
cat > src/pages.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { meta as home } from "./pages/home";
import { meta as join } from "./pages/join";
import { meta as routes } from "./pages/routes";

test("every page has a title", () => {
  for (const meta of [home, routes, join]) expect(meta.title.length).toBeGreaterThan(0);
});
EOF
git add -A
git commit -qm "chore: start the site"

slug=page-descriptions
fbs status init "$slug" --size tiny > /dev/null
dir="$(fbs status show "$slug" | sed -n 's/.*"dir": "\([^"]*\)".*/\1/p')"
fbs branch "$slug" --type feature > /dev/null
mkdir -p "$dir"
cat > "$dir/afk.json" <<JSON
{
  "goal": "Every page has a search description that says what the page offers.",
  "checks": [
    { "id": "suite", "kind": "command", "run": "sh scripts/test.sh" },
    { "id": "descriptions", "kind": "judged", "rubric": [
      "Every file under src/pages/ exports a meta whose description is 50 to 160 characters long.",
      "No two pages under src/pages/ share the same description.",
      "Each description names what that page offers (the club, the routes, joining), not generic filler."
    ] }
  ],
  "scope": ["src/pages/**"],
  "protect": ["src/**/*.test.ts", "scripts/**", "$dir/afk*"],
  "testBaseline": [],
  "budgets": { "maxIterations": 4, "maxDiscardsInRow": 2, "checkTimeoutSec": 120, "judgeUsdPerCall": 0.1 }
}
JSON
git add -A
git commit -qm "chore: afk finish line for $slug"
# Unbound, as if approved in a session that has since ended; the judge fails closed here too, so the fixture never spends on it.
env -u CLAUDE_CODE_SESSION_ID FBS_AFK_JUDGE_CMD=/usr/bin/false fbs afk start "$slug" --spec "$dir/afk.json" > /dev/null
