# GitHub Issues

GitHub Issues is reached with `gh`, in the repo of `origin` (`gh repo view --json nameWithOwner`). Write each body with the Write tool to a file under `$(git rev-parse --path-format=absolute --git-common-dir)/fbs/tracker/` and pass it with `--body-file`, never inline.

- **Read a ticket:** `gh issue view <n> --json number,title,body,url,state`; its sub-issues with `gh api repos/<owner>/<repo>/issues/<n>/sub_issues`.
- **Find an existing item:** `gh issue list --state all --search '"<exact title>" in:title' --json number,title,url`, writing each `'` in the title as `'\''`.
- **Create an issue:** `gh issue create --title '<title>' --body-file <file>`; it prints the URL, whose last part is the number.
- **Make it a sub-issue:** take its database id (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`), then `gh api -X POST repos/<owner>/<repo>/issues/<parent n>/sub_issues -F sub_issue_id=<that id>`. When the repo doesn't support sub-issues (the call fails), list the units as a task list in the parent's body instead (`- [ ] #<n>`), and say so.
- **Relations:** a `Blocked by #<n>` line in the blocked unit's body, written at creation (the units below exist first, since units are created in order).
- **Ids:** `#<n>` is the id fbs records, always quoted on the command line (`fbs status ticket <slug> '#45'`); `fbs branch` turns it into `issue-<n>` in branch names.
- **In the PR body:** `Fixes #<n>` on its own line, so GitHub closes the issue when the PR merges into the default branch.
