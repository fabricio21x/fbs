#!/usr/bin/env bash
# A repo with no tracker setting whose remote branches carry Linear-style ids, so plan must propose Linear and ask before writing anything.
set -euo pipefail

git init -q -b main
git config user.email eval@example.com
git config user.name eval
mkdir -p src .fbs
cat > CLAUDE.md <<'EOF2'
# Deskly

Booking for small coworking spaces. TypeScript on Bun. Run the tests with `bun test`.
EOF2
echo '{ "featuresDir": "docs/features" }' > .fbs/config.json
echo 'export const slotMinutes = 30;' > src/slots.ts
git add -A
git commit -q -m "chore: init"
head=$(git rev-parse HEAD)
for name in feature/dsk-41-space-reviews bugfix/dsk-38-double-booking feature/dsk-44-sms-reminders; do
  git update-ref "refs/remotes/origin/$name" "$head"
done
