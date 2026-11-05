# Linear

Linear is reached through its MCP server. Tool names depend on how it's connected (`mcp__claude_ai_Linear__save_issue`, `mcp__linear__save_issue`, …): find them with `ToolSearch` ("linear issue"). Without a Linear MCP, say the tracker can't be reached, and ask whether to go on without it for this feature or stop so the user can connect it.

- **Team:** the config's `team` key (`fbs tracker show`). To list teams for the first setting: `list_teams`.
- **Read a ticket:** `get_issue` with the identifier (`ACM-123`), including relations; its sub-issues with `list_issues` and `parentId`.
- **Find an existing item:** `list_issues` with `parentId` (sub-issues) or `query` with the exact title and the team.
- **Create the parent:** `save_issue` with `team`, `title`, `description` (Markdown with real newlines), and `links` holding the design link.
- **Create a sub-issue:** `save_issue` with `team`, `title`, `description`, `parentId: <parent identifier>`.
- **Relations:** `save_issue` on the blocked unit with `id` and `blockedBy: [<identifiers of the units it depends on>]`; it only adds.
- **A project** (really big features only): `save_project` with `name` and the team (`addTeams`), first; then pass `project` on each issue.
- **Ids:** the identifier (`ACM-124`) is the id fbs records and puts in branch names, lowercased by `fbs branch`. Linear's own `gitBranchName` is ignored: fbs names branches by the conventional branch spec, and Linear links a branch or PR by the identifier it contains.
- **In the PR body:** `Fixes ACM-124` on its own line, so Linear links the PR and closes the issue when it merges.
