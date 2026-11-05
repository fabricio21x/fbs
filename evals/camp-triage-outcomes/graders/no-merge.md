---
type: regex
target: { source: file, path: .git/fake-gh/calls.log }
pattern: 'pr\tmerge|pulls/\d+/merge|mergePullRequest|enablePullRequestAutoMerge'
match: not_contains
---
