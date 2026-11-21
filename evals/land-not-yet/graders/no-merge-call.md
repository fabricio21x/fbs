---
type: regex
target: { source: file, path: .git/fake-gh/calls.log }
pattern: 'pr\tmerge'
match: not_contains
---
