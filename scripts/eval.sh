#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
tmp="${TMPDIR:-/tmp/}"
# One copy and one results dir per run, so parallel runs don't overwrite each other.
copy="$(mktemp -d "${tmp%/}/fbs-eval.XXXXXX")"
trap 'rm -rf "$copy"' EXIT
results="$repo/evals/results/$(basename "$copy")"

# The eval sandbox can't read $HOME, so runs load a copy and a compiled CLI that needs no Bun install.
rsync -a --delete --exclude .git --exclude node_modules --exclude evals/results --exclude notes --exclude CLAUDE.local.md "$repo/" "$copy/"
bun build --compile "$repo/cli/main.ts" --outfile "$copy/bin/fbs-bin"
# macOS /usr/bin/git is an xcrun shim that can't write its cache inside the sandbox; call the real binary.
real_git="$(xcrun -f git 2>/dev/null || command -v git)"
printf '#!/bin/sh\nexec "%s" "$@"\n' "$real_git" > "$copy/bin/git"
chmod +x "$copy/bin/git"
# PR cases answer gh from fixture files; bin/ is first on PATH, so fbs resolves this gh too.
cp "$repo/evals/_support/fake-gh" "$copy/bin/gh"
chmod +x "$copy/bin/gh"
# Polish cases answer `claude plugin list` from fixture files; every other call reaches the real claude.
real_claude="$(command -v claude)"
sed "s|REAL_CLAUDE|$real_claude|" "$repo/evals/_support/fake-claude" > "$copy/bin/claude"
chmod +x "$copy/bin/claude"
# The sandbox can't read $HOME, where bun lives; fixtures that run a test suite need it on PATH.
cp "$(command -v bun)" "$copy/bin/bun"
mkdir -p "$results"
ln -sfn "$results" "$repo/evals/results/latest" 2>/dev/null || true
echo "results: $results" >&2
# Eval runs keep the inherited PATH but do not add the plugin bin/ to it, so fbs would not resolve.
PATH="$copy/bin:$PATH" "$real_claude" plugin eval "$copy" --trust-plugin --no-publish --output-dir "$results" "$@"
