---
type: regex
target: { source: file, path: .git/index }
pattern: 'docs/'
match: not_contains
---
