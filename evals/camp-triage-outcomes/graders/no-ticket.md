---
type: regex
target: { source: file, path: .git/fake-gh/calls.log }
pattern: '^issue\tcreate|repos/[^\t]*/issues\t|createIssue'
flags: m
match: not_contains
---
