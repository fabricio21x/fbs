---
type: regex
target: { source: file, path: .git/fake-gh/calls.log }
pattern: 'pr\tcreate'
match: not_contains
---
