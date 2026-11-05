#!/usr/bin/env bash
# A repo with docs, a manifest and a CLAUDE.md but no source code yet: the impact map has nothing for explorers to search.
set -euo pipefail

git init -q
mkdir -p docs/features/stock-monitor

cat > CLAUDE.md <<'EOF'
# stock-monitor

A small tool that watches a store's in-store stock and sends a Telegram alert. TypeScript on Node.
EOF

cat > package.json <<'EOF'
{ "name": "stock-monitor", "private": true, "type": "module" }
EOF

cat > README.md <<'EOF'
# stock-monitor

Nothing here yet. See docs/features/stock-monitor/spec.md.
EOF

cat > docs/features/stock-monitor/spec.md <<'EOF'
# Stock monitor

## Problem
In-store stock for a product appears at a store without warning and sells out before anyone notices.

## Scope
- Poll the store's `availability` endpoint every 60 s for the watched part numbers near one zip code.
- Send a Telegram message when a watched part becomes available at a nearby store.
- Keep the last state per part and store in SQLite so a restart does not re-alert.

## Acceptance criteria
- [ ] A part that becomes available at a store produces one Telegram message within one check.
- [ ] A restart sends no message for a part whose state didn't change.
EOF

cat > docs/features/stock-monitor/api-notes.md <<'EOF'
# Store API notes

- `GET /api/availability?part=<part>&zip=<zip>` returns `stores[].availability[<part>].status`.
- The endpoint needs a browser session cookie pair; without it the response is HTTP 403.
- Telegram: `POST https://api.telegram.org/bot<token>/sendMessage` with `chat_id` and `text`.
EOF
