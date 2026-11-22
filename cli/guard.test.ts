import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AfkGuardRun, afkDenials, campDenials, campMarkerPath, commandDenials, denials, freshToken, type GuardContext, guardPrompt, guardReply, guardToolUse, landRequestPath, landTokenPath, afkRunsIn, MCP_REVIEW_TOOLS, REQUEST_TTL_MS, TOKEN_TTL_MS, writePendingRequest, writeLandToken } from "./guard";
import { REAL_AFK_DEPS } from "./afk";
import { run } from "./main";
import { updateFeature } from "./status";
import { isolatedGitEnv } from "./test-env";

const ctx = (overrides: Partial<GuardContext> = {}): GuardContext => ({
  protectedBranches: () => ["main", "master"],
  currentBranch: () => "feat/x",
  openPrs: () => [],
  hasFreshToken: () => false,
  isCommit: () => false,
  isStepAbove: () => false,
  onlyMessagesChanged: () => false,
  hasRewriteToken: () => false,
  ...overrides,
});

describe("commandDenials", () => {
  test("gh stack merge and the stack merge endpoint are the user's, like any merge", () => {
    expect(commandDenials("gh stack merge 22 --squash", ctx())[0]).toContain("only the user merges it");
    expect(commandDenials("gh stack merge --yes", ctx())[0]).toContain("only the user merges it");
    expect(commandDenials("gh api -X PUT repos/acme/app/stacks/5/merge", ctx())[0]).toContain("stack merge endpoint");
    expect(commandDenials("gh stack view --json", ctx())).toEqual([]);
  });

  test.each([
    "npm test",
    "git status && git log --oneline | head",
    "git push",
    "git push -u origin feat/x",
    "git push origin HEAD",
    "git push --force-with-lease origin feat/x",
    "git push --force-with-lease=feat/x:abc origin feat/x",
    "git -C ../other push origin feat/x",
    "gh pr view 7 --json state",
    "gh pr create --draft --title merge-things",
    "gh api repos/o/r/pulls/7/comments",
    "gh pr checks 7",
    "git merge main",
    "git commit -m 'merge main into feat'",
    "fbs watch-pr x --once",
    "git push origin feat/main-menu",
    "git push origin fbs/landing-page",
    "fbs branch landing-page --existing",
    "gh api repos/o/r/git/refs/heads/main",
    "gh api -X PATCH repos/o/r/git/refs/heads/feat -f sha=abc",
    "cat package.json",
  ])("allows %p", (command) => {
    expect(commandDenials(command, ctx())).toEqual([]);
  });

  test.each([
    ["gh pr merge 7 --squash", "gh pr merge"],
    ["gh --repo o/r pr merge 7", "gh pr merge"],
    ["/opt/homebrew/bin/gh pr merge 7", "gh pr merge"],
    ["echo hi && gh pr merge 7", "gh pr merge"],
    ["(cd /tmp; gh pr merge 7)", "gh pr merge"],
    ["bash -c 'gh pr merge 7'", "gh pr merge"],
    ['g"h" p"r" merge 7', "gh pr merge"],
    ["echo $(gh pr merge 7)", "gh pr merge"],
    ["gh api -X PUT repos/o/r/pulls/7/merge", "merge endpoint"],
    ["curl -X PUT https://api.github.com/repos/o/r/pulls/7/merge", "merge endpoint"],
    ["gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'", "merge mutation"],
    ["gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'", "merge mutation"],
    ["git push origin main", "default branch"],
    ["git push origin HEAD:main", "default branch"],
    ["git push origin feat/x:refs/heads/master", "default branch"],
    ["git push origin :main", "default branch"],
    ["git push --all", "--all/--mirror"],
    ["git push --force origin feat/x", "--force, -f or a + refspec"],
    ["git push -f origin feat/x", "--force, -f or a + refspec"],
    ["git push -uf origin feat/x", "--force, -f or a + refspec"],
    ["git push origin +feat/x", "--force, -f or a + refspec"],
    ["git push --force-with-lease -f origin feat/x", "--force, -f or a + refspec"],
    ["git push --force-with-lease --force origin feat/x", "--force, -f or a + refspec"],
    ["git push --force-with-lease origin +feat/x", "--force, -f or a + refspec"],
    ["gh api repos/o/r/merges -f base=main -f head=feat", "merges endpoint"],
    ["gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc", "default branch ref main"],
    ["gh api --method DELETE repos/o/r/git/refs/heads/master", "default branch ref master"],
    ["echo /fbs:land x", "runs only when the user types it"],
    ["claude -p '/FBS:LAND x'", "runs only when the user types it"],
    ["echo '{}' > .git/fbs/land/x.token", "land tokens"],
    ["cp t .git/FBS/./land//x.token", "land tokens"],
    ["cp t .git/fbs/LAND/x.TOKEN", "land tokens"],
    ["cd .git/fbs && echo {} > land/x.token", "land tokens"],
    ["git status; git push origin main", "default branch"],
    ["echo ok | git push origin main", "default branch"],
    ["touch .git/fbs/land/x.token", "land tokens"],
    ["fbs land x", "fresh land token"],
    ["bin/fbs land x", "fresh land token"],
    ["fbs land", "fresh land token"],
  ])("denies %p", (command, reason) => {
    const reasons = commandDenials(command, ctx());
    expect(reasons.join("\n")).toContain(reason);
  });

  test("a bare push denies only when the current branch is a default branch or unknown", () => {
    expect(commandDenials("git push", ctx({ currentBranch: () => "main" }))).toHaveLength(1);
    expect(commandDenials("git push origin HEAD", ctx({ currentBranch: () => null }))).toHaveLength(1);
    expect(commandDenials("git push", ctx({ currentBranch: () => { throw new Error("git broke"); } }))).toHaveLength(1);
  });

  test("the default branch from origin/HEAD is protected too", () => {
    expect(commandDenials("git push origin trunk", ctx({ protectedBranches: () => ["main", "master", "trunk"] }))).toHaveLength(1);
  });

  test("a lease push is denied to an open fbs PR's branch only, however the branch is named", () => {
    const open = ctx({ openPrs: () => [{ slug: "x", branch: "feat/x", pr: 7 }, { slug: "y", branch: null, pr: 8 }] });
    for (const command of ["git push --force-with-lease origin feat/x", "git push --force-with-lease", "git push --force-with-lease=feat/x:abc origin HEAD", "git push --force-if-includes --force-with-lease origin HEAD:feat/x"]) {
      expect(commandDenials(command, open).join("\n")).toContain("fbs stack sync x");
    }
    expect(commandDenials("git push --force-with-lease origin feat/other", open)).toEqual([]);
    expect(commandDenials("git push origin feat/x", open)).toEqual([]);
    expect(commandDenials("fbs push x", open)).toEqual([]);
    expect(commandDenials("git push --force-with-lease origin feat/x", ctx({ openPrs: () => { throw new Error("broken"); } }))).toEqual([]);
  });

  test("a lease push to an open PR's branch passes when the commit pushed has the tree origin's tip has", () => {
    const pushed: string[] = [];
    const sameTree = (source: string) => (src: string, branch: string) => {
      pushed.push(`${src} -> ${branch}`);
      return src === source && branch === "feat/x";
    };
    const open = (source: string) => ctx({ openPrs: () => [{ slug: "x", branch: "feat/x", pr: 7 }], onlyMessagesChanged: sameTree(source) });
    expect(commandDenials("git push --force-with-lease", open("HEAD"))).toEqual([]);
    expect(commandDenials("git push --force-with-lease origin feat/x", open("feat/x"))).toEqual([]);
    expect(commandDenials("git push --force-with-lease origin HEAD:feat/x", open("HEAD"))).toEqual([]);
    expect(commandDenials("git push --force-with-lease=feat/x origin abc123:refs/heads/feat/x", open("abc123"))).toEqual([]);
    expect(pushed).toEqual(["HEAD -> feat/x", "feat/x -> feat/x", "HEAD -> feat/x", "abc123 -> feat/x"]);
    expect(commandDenials("git push --force-with-lease origin HEAD:feat/x", open("feat/x")).join("\n")).toContain("rewrites feat/x");
  });

  test("with several refspecs, only the one to the PR's branch is checked, against its own source", () => {
    const seen: string[] = [];
    const open = ctx({ openPrs: () => [{ slug: "x", branch: "feat/x", pr: 7 }], onlyMessagesChanged: (src, branch) => (seen.push(`${src} -> ${branch}`), src === "fix" && branch === "feat/x") });
    expect(commandDenials("git push --force-with-lease origin HEAD:feat/other fix:feat/x", open)).toEqual([]);
    expect(seen).toEqual(["fix -> feat/x"]);
    expect(commandDenials("git push --force-with-lease origin fix:feat/other HEAD:feat/x", open).join("\n")).toContain("rewrites feat/x");
  });

  test("the messages-only pass needs the push alone in the command, on origin's tip, where the refs are read", () => {
    const same = ctx({ openPrs: () => [{ slug: "x", branch: "feat/x", pr: 7 }], onlyMessagesChanged: () => true });
    for (const command of [
      "git push --force-with-lease=feat/x:abc123 origin feat/x",
      "git -C ../other push --force-with-lease origin feat/x",
      "git --git-dir=../other/.git push --force-with-lease origin feat/x",
      "GIT_DIR=../other/.git git push --force-with-lease origin feat/x",
      "cd ../other && git push --force-with-lease origin feat/x",
      "git rebase origin/main && git push --force-with-lease origin feat/x",
      "git reset --soft origin/main; git commit -m squash; git push --force-with-lease",
      "(git push --force-with-lease origin feat/x)",
      "git push --force-with-lease origin $(git rev-parse HEAD):feat/x",
      "git push --force-with-lease origin HEAD:$BRANCH",
    ]) {
      expect(commandDenials(command, same).join("\n")).toContain("rewrites feat/x");
    }
  });

  test("push options that take a value don't shift the remote: the lease and default-branch rules still see the target", () => {
    const open = ctx({ openPrs: () => [{ slug: "x", branch: "feat/x", pr: 7 }], currentBranch: () => "feat/x" });
    for (const options of ["-o ci.skip", "--push-option ci.skip", "--repo origin", "--receive-pack git-receive-pack", "--exec git-receive-pack"]) {
      expect(commandDenials(`git push ${options} --force-with-lease origin`, open).join("\n")).toContain("rewrites feat/x");
      expect(commandDenials(`git push ${options} origin`, ctx({ currentBranch: () => "main" })).join("\n")).toContain("default branch (main)");
    }
    expect(commandDenials("git push -o ci.skip origin feat/y", ctx({ currentBranch: () => "main" }))).toEqual([]);
  });

  test("a rewrite token lets a lease push through; --force, -f and a + refspec stay denied with it or the same tree", () => {
    const allowed = ctx({ openPrs: () => [{ slug: "x", branch: "feat/x", pr: 7 }], hasRewriteToken: () => true, onlyMessagesChanged: () => true });
    expect(commandDenials("git push --force-with-lease origin feat/x", allowed)).toEqual([]);
    for (const command of ["git push --force origin feat/x", "git push -f origin feat/x", "git push origin +feat/x", "git push --force-with-lease --force origin feat/x", "git push --force-with-lease origin +HEAD:feat/x"]) {
      expect(commandDenials(command, allowed).join("\n")).toContain("use --force-with-lease alone");
    }
  });

  test("a lease push's denial names the two ways through: a messages-only amend, or the user's own words", () => {
    const reason = commandDenials("git push --force-with-lease origin feat/x", ctx({ openPrs: () => [{ slug: "x", branch: "feat/x", pr: 7 }] })).join("\n");
    expect(reason).toContain("only messages changed");
    expect(reason).toContain("run fbs rewrite request x and ask the user");
  });

  test("a nested claude run can't answer a land request: no resumed or continued session, no land prompt", () => {
    for (const command of [
      'claude -p --resume "$CLAUDE_CODE_SESSION_ID" land',
      "claude -p --resume=abc review",
      "claude -r abc -p hi",
      "claude -pc hi",
      "echo land | claude -p -c",
      "echo land | claude -p",
      "printf 'land it\\n' | env FOO=1 claude -p",
      "claude -p 'land #7'",
      "npx claude --continue",
      "command /usr/local/bin/claude -p land",
      "xargs claude -p < x; echo Land.",
    ]) {
      expect(commandDenials(command, ctx()).join("\n")).toContain("only the user answers it");
    }
    for (const command of ["claude --version", "claude -p 'review the landing page'", "claude mcp list", "echo land", "printf done | claude -p"]) {
      expect(commandDenials(command, ctx())).toEqual([]);
    }
  });

  test("a merge's denial says how to ask the user for a land", () => {
    expect(commandDenials("gh pr merge 7", ctx()).join("\n")).toContain("when they ask you to merge or land, their message writes a land token and you run fbs land <slug>; to ask them first, run fbs land request <slug>");
  });

  test("fbs land request is allowed; it writes a request, never a token", () => {
    expect(commandDenials("fbs land request x", ctx())).toEqual([]);
    expect(commandDenials("fbs land request", ctx())).toHaveLength(1);
    expect(commandDenials("cat .git/fbs/land/request.json", ctx())).toHaveLength(1);
  });

  test("fbs land is allowed with a fresh token for that slug only", () => {
    const tokens = ctx({ hasFreshToken: (slug) => slug === "x" });
    expect(commandDenials("fbs land x", tokens)).toEqual([]);
    expect(commandDenials("bin/fbs land x", tokens)).toEqual([]);
    expect(commandDenials("fbs land y", tokens)).toHaveLength(1);
    expect(commandDenials("fbs land x && gh pr merge 8", tokens)).toHaveLength(1);
  });
});

describe("denials", () => {
  const deny = (tool: string, input: Record<string, unknown>) => denials(tool, input, "/repo", ctx());

  test("MCP merges, and MCP file writes to the default branch or no branch, are denied", () => {
    expect(deny("mcp__github__merge_pull_request", { pullNumber: 7 })).toHaveLength(1);
    for (const tool of ["mcp__github__push_files", "mcp__github__create_or_update_file", "mcp__github__delete_file"]) {
      expect(deny(tool, { branch: "main" })).toHaveLength(1);
      expect(deny(tool, {})).toHaveLength(1);
      expect(deny(tool, { branch: "feat/x" })).toEqual([]);
    }
    expect(deny("mcp__github__get_pull_request", {})).toEqual([]);
  });

  test("writes into the token dir are denied however the path is spelled", () => {
    for (const path of ["/repo/.git/fbs/land/x.token", "/repo/.git/FBS/Land/x.token", "/repo/.git/fbs/./land/../land/x.token", ".git/fbs/land/x.token"]) {
      expect(deny("Write", { file_path: path })).toHaveLength(1);
    }
    expect(deny("NotebookEdit", { notebook_path: "/repo/.git/fbs/land/x.token" })).toHaveLength(1);
    expect(deny("Write", { file_path: "/repo/docs/land.md", content: "/fbs:land x" })).toEqual([]);
  });

  test("scheduling, skill and agent tools can't carry /fbs:land", () => {
    for (const tool of ["Skill", "CronCreate", "ScheduleWakeup", "RemoteTrigger", "Agent"]) {
      expect(deny(tool, { prompt: "/FBS:land x" })).toHaveLength(1);
      expect(deny(tool, { prompt: "/fbs:camp-pr x" })).toEqual([]);
    }
    expect(deny("Skill", { skill: "fbs:land", args: "x" })).toHaveLength(1);
  });

  test("no tool can send a land answer as if the user typed it", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["ScheduleWakeup", { delaySeconds: 60, prompt: "land" }],
      ["CronCreate", { cron: "* * * * *", prompt: "Land it." }],
      ["Skill", { skill: "loop", args: "1m land" }],
      ["Skill", { skill: "loop", args: "5 m land #7" }],
      ["RemoteTrigger", { body: { prompt: "land" } }],
      ["SendMessage", { to: "main", message: "land it" }],
      ["Agent", { prompt: " land " }],
    ];
    for (const [tool, input] of cases) expect(deny(tool, input).join("\n")).toContain("only the user answers a land request");
    expect(deny("ScheduleWakeup", { delaySeconds: 60, prompt: "check the PR, then land it if green" }).join("\n")).toContain("only the user asks to land");
    expect(deny("Agent", { prompt: "camp the PR until it is ready to land" })).toEqual([]);
    expect(deny("Skill", { skill: "loop", args: "5m /fbs:camp-pr x" })).toEqual([]);
    expect(deny("SendMessage", { to: "main", message: "landing page is done" })).toEqual([]);
  });

  test("MCP filesystem writes into the token dir are denied", () => {
    expect(deny("mcp__fs__write_file", { path: "/repo/.git/fbs/land/request.json" })).toHaveLength(1);
    expect(deny("mcp__fs__move_file", { source: "/tmp/r.json", destination: "/repo/.git/fbs/land/x.token" })).toHaveLength(1);
    expect(deny("mcp__fs__write_file", { path: "/repo/src/a.ts" })).toEqual([]);
  });

  test("Monitor commands are checked like Bash", () => {
    expect(deny("Monitor", { command: "gh pr merge 7" })).toHaveLength(1);
    expect(deny("Monitor", { command: "gh pr checks 7 --watch" })).toEqual([]);
  });
});

describe("campDenials", () => {
  // PR #7 is the open fbs PR; #45 is a tracker issue or someone else's PR.
  const deny = (tool: string, input: Record<string, unknown>) => campDenials(tool, input, [7]);
  const bashDeny = (command: string) => deny("Bash", { command });

  test.each([
    "gh api -X POST repos/acme/app/pulls/7/comments/123/replies -f body=Fixed",
    "gh api repos/acme/app/pulls/7/comments/123/replies -f body='Fixed in abc1234'",
    "gh api repos/{owner}/{repo}/pulls/7/comments/123/replies --input /tmp/r.json",
    "gh api --method POST repos/acme/app/pulls/7/comments --input c.json",
    "gh api repos/acme/app/pulls/7/comments/123/replies -fbody=x",
    "gh api repos/acme/app/issues/7/comments -F body=@r.md",
    "gh api repos/acme/app/issues/7/comments -Fbody=@r.md",
    "gh api repos/acme/app/issues/$PR/comments -F body=@r.md",
    "gh api repos/acme/app/issues/${PR}/comments -F body=@r.md",
    "gh api repos/acme/app/pulls/${PR}/comments/1/replies -f body=x",
    "gh api repos/acme/app/pulls/7/reviews -f event=COMMENT -f body=done",
    "gh api -X POST repos/acme/app/pulls/7/reviews/99/events -f event=COMMENT",
    `curl -X POST https://api.github.com/repos/acme/app/issues/7/comments -d '{"body":"x"}'`,
    "curl --data-binary @r.json https://api.github.com/repos/acme/app/issues/7/comments",
    `curl --json '{"body":"x"}' https://api.github.com/repos/acme/app/pulls/7/comments/1/replies`,
    "curl -d@r.json https://api.github.com/repos/acme/app/issues/7/comments",
    `gh api graphql -f query='mutation { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: "PRRT_a", body: "done"}) { comment { id } } }'`,
    `gh api graphql -f query='mutation($id: ID!) { addPullRequestReviewComment(input: {pullRequestReviewId: $id, body: "x"}) { comment { id } } }'`,
    `gh api graphql -f query='mutation { addPullRequestReview(input: {pullRequestId: "PR_a", event: COMMENT}) { pullRequestReview { id } } }'`,
    `gh api graphql -f query='mutation { addComment(input: {subjectId: "PR_a", body: "x"}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "PRRT_a"}) { thread { isResolved } } }'`,
    `gh api graphql -f query='\nmutation {\n  addComment(input: {subjectId: "PR_a", body: "x; y"}) { clientMutationId }\n}'`,
    "gh pr comment 7 --body done",
    "gh pr comment --body-file r.md",
    "gh pr comment https://github.com/acme/app/pull/7 -b done",
    "gh pr comment $PR -b done",
    "gh pr review 7 --approve",
    "gh pr review --comment -b looks good",
    "gh issue comment 7 --body-file r.md",
    "gh issue comment https://github.com/acme/app/pull/7 -b done",
    "gh issue comment $PR -b done",
    "cd /repo && gh pr comment 7 -b done",
    "GH_TOKEN=x command gh pr comment 7 -b done",
    "env GH_HOST=github.com gh pr comment 7 -b done",
    "echo $(gh pr comment 7 -b done)",
  ])("a raw comment, reply, review or resolve on the camp's PR is denied, pointing to fbs: %s", (command) => {
    const reasons = bashDeny(command);
    expect(reasons).toHaveLength(1);
    for (const way of ["fbs pr reply <slug>", "fbs pr comment <slug>", "fbs pr resolve <slug>", "ask the user to do it on GitHub"]) expect(reasons[0]).toContain(way);
  });

  test.each([
    "gh api repos/acme/app/pulls/7/comments",
    "gh api repos/acme/app/pulls/7/comments --paginate --jq '.[] | {id, body}'",
    "gh api -X GET repos/acme/app/pulls/7/comments -f per_page=100",
    "gh api repos/acme/app/issues/7/comments",
    "gh api repos/acme/app/pulls/7/reviews",
    "curl -fsSL https://api.github.com/repos/acme/app/issues/7/comments",
    `gh api graphql -f query='query { repository(owner: "acme", name: "app") { pullRequest(number: 7) { reviewThreads(first: 50) { nodes { id isResolved } } } } }'`,
    "gh pr view 7 --comments",
    "gh pr checks 7 --watch",
    "gh pr ready 7",
    "gh issue comment 45 --body-file /repo/.git/fbs/c.md",
    "gh api repos/acme/app/issues/45/comments -F body=@c.md",
    "gh api -X POST repos/acme/app/issues/45/sub_issues -F sub_issue_id=99",
    "gh pr comment 45 -b done",
    "gh pr review 45 --approve",
    "gh api -X POST repos/acme/app/pulls/45/comments/1/replies -f body=x",
    "gh api -X POST repos/acme/app/pulls/7/comments/1/reactions -f content=+1",
    "gh api -X POST repos/acme/app/issues/comments/9/reactions -f content=+1",
    "fbs pr reply x --comment thread:123 --body-file /repo/.git/fbs/pr/r.md",
    "fbs pr comment x --body-file /repo/.git/fbs/pr/c.md",
    "fbs pr resolve x --thread PRRT_abc",
    "grep -rn addComment src/graphql",
    "grep -rn 'gh pr comment' skills/",
    "git log --grep 'gh pr review'",
    "git commit -m 'fix: gh api graphql addComment -f body=x for issues/7/comments'",
    "rg addComment && gh api graphql -f query='query{viewer{login}}'",
  ])("reads, other numbers, other commands and fbs's own commands stay allowed: %s", (command) => {
    expect(bashDeny(command)).toEqual([]);
  });

  test("GitHub MCP tools that post a review, a reply or a comment on the PR are denied; reads and tracker comments are allowed", () => {
    for (const tool of ["pull_request_review_write", "add_reply_to_pull_request_comment", "create_and_submit_pull_request_review", ...MCP_REVIEW_TOOLS]) {
      expect(deny(`mcp__github__${tool}`, { owner: "acme", repo: "app", pullNumber: 7 }).join("\n")).toContain("fbs pr reply <slug>");
    }
    expect(deny("mcp__github__add_issue_comment", { owner: "acme", repo: "app", issue_number: 7, body: "x" })).toHaveLength(1);
    expect(deny("mcp__github__add_issue_comment", { owner: "acme", repo: "app", issue_number: "7", body: "x" })).toHaveLength(1);
    expect(deny("mcp__github__add_issue_comment", { owner: "acme", repo: "app", issue_number: 45, body: "x" })).toEqual([]);
    expect(deny("mcp__github__get_pull_request_comments", { owner: "acme", repo: "app", pullNumber: 7 })).toEqual([]);
  });

  test("Monitor commands are checked like Bash", () => {
    expect(deny("Monitor", { command: "gh pr comment 7 -b x" })).toHaveLength(1);
  });

  test("the guard's hook sees every MCP tool it denies during a camp", () => {
    const hooks = JSON.parse(readFileSync(join(import.meta.dir, "..", "hooks", "hooks.json"), "utf8")).hooks.PreToolUse as { matcher: string; hooks: { command: string }[] }[];
    const guard = hooks.filter((h) => h.hooks.some((hook) => hook.command.endsWith("/bin/fbs-guard")));
    for (const tool of ["pull_request_review_write", "add_reply_to_pull_request_comment", "add_issue_comment", ...MCP_REVIEW_TOOLS]) expect(guard.some((h) => new RegExp(h.matcher).test(`mcp__github__${tool}`))).toBe(true);
    expect(guard.some((h) => new RegExp(h.matcher).test("mcp__github__get_pull_request_comments"))).toBe(false);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fbs-guard-")));
  dirs.push(dir);
  return dir;
}

function repo(): string {
  const dir = tempDir();
  expect(Bun.spawnSync(["git", "init", "-q", "-b", "feat"], { cwd: dir, env: isolatedGitEnv() }).exitCode).toBe(0);
  return dir;
}

const TREE = "a".repeat(40);

function record(dir: string, slug: string, stamp = true): void {
  const rec = { slug, dir: `docs/features/2026-10-21-${slug}`, size: "tiny", approvals: {}, pr: null, ...(stamp && { stamp: { tree: TREE, at: "2026-10-25", verdict: "pass", criteria: 1, evidence: "v.md" } }) };
  mkdirSync(join(dir, ".git", "fbs", "features"), { recursive: true });
  writeFileSync(join(dir, ".git", "fbs", "features", `${slug}.json`), JSON.stringify(rec));
}

/** A record as fbs writes it, with an open PR on `branch`, or landed. */
function prRecord(dir: string, slug: string, options: { branch?: string; landed?: boolean; tree?: string; pr?: number; stamp?: boolean } = {}): void {
  const rec = {
    slug,
    dir: `docs/features/2026-10-21-${slug}`,
    size: "tiny",
    approvals: {},
    pr: options.pr ?? 7,
    repo: "acme/app",
    branch: { name: options.branch ?? `feat/${slug}`, parent: null, base: "b".repeat(40) },
    ...(options.stamp !== false && { stamp: { tree: options.tree ?? TREE, at: "2026-10-25", verdict: "pass", criteria: 1, evidence: "v.md" } }),
    ...(options.landed && { landed: { pr: 7, repo: "acme/app", commit: "c".repeat(40), at: "2026-10-25" } }),
  };
  mkdirSync(join(dir, ".git", "fbs", "features"), { recursive: true });
  writeFileSync(join(dir, ".git", "fbs", "features", `${slug}.json`), `${JSON.stringify(rec, null, 2)}\n`);
}

function mark(dir: string, slug = "x"): void {
  const path = campMarkerPath(join(dir, ".git"), slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
}

const NOW = 1_800_000_000_000;
const bash = (cwd: string, command: string) => JSON.stringify({ hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_input: { command } });

describe("guardToolUse", () => {
  test("outside a git repo it allows everything", () => {
    const dir = tempDir();
    expect(guardToolUse(bash(dir, "gh pr merge 7"), dir, NOW)).toEqual({ deny: [] });
  });

  test("without a camp marker it allows everything, merges included", () => {
    const dir = repo();
    expect(guardToolUse(bash(dir, "gh pr merge 7"), dir, NOW)).toEqual({ deny: [] });
    expect(guardToolUse(JSON.stringify({ cwd: dir, tool_name: "mcp__github__merge_pull_request", tool_input: {} }), dir, NOW)).toEqual({ deny: [] });
  });

  test("with a camp marker it denies merges, the MCP merge tool and token writes, and allows the rest", () => {
    const dir = repo();
    mark(dir);
    expect(guardToolUse(bash(dir, "gh pr merge 7"), dir, NOW).deny).toHaveLength(1);
    expect(guardToolUse(bash(dir, "git push origin main"), dir, NOW).deny).toHaveLength(1);
    expect(guardToolUse(bash(dir, "git push -u origin feat"), dir, NOW).deny).toEqual([]);
    expect(guardToolUse(JSON.stringify({ cwd: dir, tool_name: "mcp__github__merge_pull_request", tool_input: { pullNumber: 7 } }), dir, NOW).deny).toHaveLength(1);
    expect(guardToolUse(JSON.stringify({ cwd: dir, tool_name: "mcp__github__get_pull_request", tool_input: {} }), dir, NOW).deny).toEqual([]);
    expect(guardToolUse(JSON.stringify({ cwd: dir, tool_name: "Write", tool_input: { file_path: join(dir, ".git/fbs/land/x.token") } }), dir, NOW).deny).toHaveLength(1);
    expect(guardToolUse(JSON.stringify({ cwd: dir, tool_name: "Write", tool_input: { file_path: join(dir, "src/a.ts") } }), dir, NOW).deny).toEqual([]);
  });

  test("an open fbs PR switches the rules on without a camp: raw merges, the MCP merge, token and request writes", () => {
    const dir = repo();
    prRecord(dir, "x");
    const merge = guardToolUse(bash(dir, "gh pr merge 7 --squash"), dir, NOW).deny;
    expect(merge).toHaveLength(1);
    expect(merge[0]).toContain("fbs land request <slug>");
    expect(guardToolUse(JSON.stringify({ cwd: dir, tool_name: "mcp__github__merge_pull_request", tool_input: { pullNumber: 7 } }), dir, NOW).deny).toHaveLength(1);
    expect(guardToolUse(JSON.stringify({ cwd: dir, tool_name: "Write", tool_input: { file_path: landRequestPath(join(dir, ".git")) } }), dir, NOW).deny).toHaveLength(1);
    expect(guardToolUse(bash(dir, "fbs land request x"), dir, NOW).deny).toEqual([]);
    expect(guardToolUse(bash(dir, "git push -u origin feat/x"), dir, NOW).deny).toEqual([]);
  });

  test("a lease push is denied to the open PR's branch, with or without a camp, and allowed elsewhere", () => {
    const dir = repo();
    prRecord(dir, "x");
    expect(guardToolUse(bash(dir, "git push --force-with-lease origin feat/x"), dir, NOW).deny.join("\n")).toContain("fbs stack sync x");
    expect(guardToolUse(bash(dir, "git push --force-with-lease origin feat/y"), dir, NOW).deny).toEqual([]);
    mark(dir, "y");
    expect(guardToolUse(bash(dir, "git push --force-with-lease origin feat/x"), dir, NOW).deny).toHaveLength(1);
    expect(guardToolUse(bash(dir, "git push --force-with-lease origin feat/y"), dir, NOW).deny).toEqual([]);
  });

  test("a landed PR, or a record with no PR, switches nothing on", () => {
    const dir = repo();
    prRecord(dir, "x", { landed: true });
    record(dir, "y");
    expect(guardToolUse(bash(dir, "gh pr merge 7"), dir, NOW)).toEqual({ deny: [] });
    writeFileSync(join(dir, ".git", "fbs", "features", "broken.json"), "{");
    expect(guardToolUse(bash(dir, "gh pr merge 7"), dir, NOW)).toEqual({ deny: [] });
  });

  test("a hook cwd that doesn't exist falls back to the process cwd", () => {
    const dir = repo();
    mark(dir);
    expect(guardToolUse(bash(join(dir, "gone"), "gh pr merge 7"), dir, NOW).deny).toHaveLength(1);
  });

  test("the marker is found from a subdirectory through the hook's cwd", () => {
    const dir = repo();
    mark(dir);
    mkdirSync(join(dir, "sub"));
    expect(guardToolUse(bash(join(dir, "sub"), "gh pr merge 7"), tempDir(), NOW).deny).toHaveLength(1);
  });

  test("unparseable input allows without a marker and fails closed only on dangerous text with one", () => {
    const dir = repo();
    expect(guardToolUse("{not json gh pr merge 7", dir, NOW)).toEqual({ deny: [] });
    mark(dir);
    expect(guardToolUse('{"tool_input":{"command":"gh pr merge 7"', dir, NOW).deny).toHaveLength(1);
    expect(guardToolUse('{"tool_name":"mcp__gh__merge_pull_request"', dir, NOW).deny).toHaveLength(1);
    expect(guardToolUse("{not json npm test", dir, NOW)).toEqual({ deny: [] });
    expect(guardToolUse("", dir, NOW)).toEqual({ deny: [] });
  });

  test("fbs land passes only with a fresh token", () => {
    const dir = repo();
    mark(dir);
    expect(guardToolUse(bash(dir, "fbs land x"), dir, NOW).deny).toHaveLength(1);
    writeLandToken(join(dir, ".git"), { slug: "x", at: NOW - 60_000, tree: TREE });
    expect(guardToolUse(bash(dir, "fbs land x"), dir, NOW).deny).toEqual([]);
  });

  test("raw PR replies are denied only while a camp runs, against the open fbs PR's number", () => {
    const dir = repo();
    prRecord(dir, "x", { pr: 12 });
    const reply = "gh api repos/acme/app/pulls/12/comments/5/replies -f body=Fixed";
    const comment = (issue: number) => JSON.stringify({ cwd: dir, tool_name: "mcp__github__add_issue_comment", tool_input: { owner: "acme", repo: "app", issue_number: issue, body: "x" } });
    expect(guardToolUse(bash(dir, reply), dir, NOW).deny).toEqual([]);
    mark(dir);
    expect(guardToolUse(bash(dir, reply), dir, NOW).deny.join("\n")).toContain("fbs pr reply <slug>");
    expect(guardToolUse(bash(dir, "gh issue comment 12 -b done"), dir, NOW).deny).toHaveLength(1);
    expect(guardToolUse(bash(dir, "gh issue comment 45 -b done"), dir, NOW).deny).toEqual([]);
    expect(guardToolUse(comment(12), dir, NOW).deny).toHaveLength(1);
    expect(guardToolUse(comment(45), dir, NOW).deny).toEqual([]);
    expect(guardToolUse(bash(dir, "fbs pr reply x --comment thread:5 --body-file .git/fbs/pr/r.md"), dir, NOW).deny).toEqual([]);
  });
});

const expansion = (cwd: string, args: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: "fbs:land", command_args: args, command_source: "plugin", cwd, prompt: `/fbs:land ${args}`, ...extra });

describe("the land token", () => {
  test("/fbs:land <slug> typed by the user writes a fresh token bound to the stamp tree", () => {
    const dir = repo();
    record(dir, "paid-plans");
    expect(guardPrompt(expansion(dir, "paid-plans"), dir, NOW)).toBe("land token written for paid-plans");
    const common = join(dir, ".git");
    expect(freshToken(common, "paid-plans", NOW + TOKEN_TTL_MS - 1)).toEqual({ slug: "paid-plans", at: NOW, tree: TREE });
    expect(freshToken(common, "paid-plans", NOW + TOKEN_TTL_MS)).toBeNull();
    expect(freshToken(common, "paid-plans", NOW - 1)).toBeNull();
    expect(freshToken(common, "other", NOW)).toBeNull();
  });

  test("the command is recognised by command_name, land or fbs:land", () => {
    const dir = repo();
    record(dir, "x");
    expect(guardPrompt(expansion(dir, "x", { command_name: "land", prompt: "/land x" }), dir, NOW)).toBe("land token written for x");
    expect(guardPrompt(expansion(dir, "x", { command_name: "fbs:landing", prompt: "/fbs:land x" }), dir, NOW)).toBeNull();
  });

  test("a feature without a stamp gets no token", () => {
    const dir = repo();
    record(dir, "x", false);
    expect(guardPrompt(expansion(dir, "x"), dir, NOW)).toBe("no land token: x has no verify stamp");
    expect(existsSync(landTokenPath(join(dir, ".git"), "x"))).toBe(false);
  });

  test("with no slug it takes the single running PR flow's, and writes nothing when that's ambiguous", () => {
    const dir = repo();
    record(dir, "x");
    mark(dir, "x");
    expect(guardPrompt(expansion(dir, ""), dir, NOW)).toBe("land token written for x");
    mark(dir, "y");
    rmSync(landTokenPath(join(dir, ".git"), "x"));
    expect(guardPrompt(expansion(dir, ""), dir, NOW)).toContain("no land token");
    expect(existsSync(landTokenPath(join(dir, ".git"), "x"))).toBe(false);
  });

  test("text after the command is fine: the first word is the slug only when it names a feature", () => {
    const dir = repo();
    record(dir, "x");
    record(dir, "y");
    expect(guardPrompt(expansion(dir, "y it's ready, merge it"), dir, NOW)).toBe("land token written for y");
    expect(guardPrompt(expansion(dir, "it's ready\nlets merge"), dir, NOW)).toContain("no land token");
    mark(dir, "x");
    expect(guardPrompt(expansion(dir, "it's ready\nlets merge"), dir, NOW)).toBe("land token written for x");
    expect(guardPrompt(expansion(dir, "ready lets merge"), dir, NOW)).toBe("land token written for x");
    expect(existsSync(landTokenPath(join(dir, ".git"), "ready"))).toBe(false);
  });

  test("other events, other expansions and odd slugs write nothing", () => {
    const dir = repo();
    record(dir, "x");
    const none = [
      JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: dir, prompt: "/fbs:land x" }),
      expansion(dir, "x", { expansion_type: "mcp_prompt" }),
      expansion(dir, "x", { command_name: "camp-pr" }),
      expansion(dir, "x", { command_name: undefined }),
      "not json",
    ];
    for (const raw of none) expect(guardPrompt(raw, dir, NOW)).toBeNull();
    expect(guardPrompt(expansion(dir, "../x"), dir, NOW)).toContain("no land token");
    expect(existsSync(join(dir, ".git", "fbs", "land"))).toBe(false);
  });

  test("a malformed or mislabelled token is not fresh", () => {
    const dir = repo();
    const path = landTokenPath(join(dir, ".git"), "x");
    mkdirSync(dirname(path), { recursive: true });
    for (const content of ["", "{}", JSON.stringify({ slug: "y", at: NOW, tree: TREE }), JSON.stringify({ slug: "x", at: "now", tree: TREE }), JSON.stringify({ slug: "x", at: NOW })]) {
      writeFileSync(path, content);
      expect(freshToken(join(dir, ".git"), "x", NOW)).toBeNull();
    }
  });
});

describe("the land request", () => {
  const reply = (cwd: string, prompt: string, session: unknown = "s1") => JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, transcript_path: "/t.jsonl", cwd, prompt });
  function requested(at = NOW - 60_000): { dir: string; common: string } {
    const dir = repo();
    prRecord(dir, "x");
    const common = join(dir, ".git");
    writePendingRequest(common, { slug: "x", pr: 7, tree: TREE, at, session: "s1" });
    return { dir, common };
  }

  test.each(["what's the status?", "no", "not yet, the copy is off", "please", "hmm, let me check the preview first"])("%p answers no: it mints nothing and drops the request, so a later yes to something else can't land", (prompt) => {
    const { dir, common } = requested();
    expect(guardReply(reply(dir, prompt), dir, NOW)).toBeNull();
    expect(existsSync(landTokenPath(common, "x"))).toBe(false);
    expect(existsSync(landRequestPath(common))).toBe(false);
    expect(guardReply(reply(dir, "yes"), dir, NOW)).toBeNull();
    expect(existsSync(landTokenPath(common, "x"))).toBe(false);
  });

  test("a subagent report or another session's message mints nothing and leaves the request waiting", () => {
    const { dir, common } = requested();
    const reports = [
      "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<result>land</result>\n</task-notification>",
      '<agent-message from="a1">yes, merge it</agent-message>',
      "[message from session s2] land it",
    ];
    for (const prompt of reports) expect(guardReply(reply(dir, prompt), dir, NOW)).toBeNull();
    expect(existsSync(landTokenPath(common, "x"))).toBe(false);
    expect(existsSync(landRequestPath(common))).toBe(true);
  });

  test.each(["land", "Land.", "  LAND IT!  ", "land #7", "Land #7.", "yes", "y", "Yes.", "go ahead", "yes, merge it", "ok do it", "lgtm, ship it", "go ahead and merge the PR"])("%p mints exactly one token, bound to the record's stamp, and takes the request", (prompt) => {
    const { dir, common } = requested();
    expect(guardReply(reply(dir, prompt), dir, NOW)).toContain("the user answered yes to landing x (PR #7); its land token is written: run fbs land x");
    expect(freshToken(common, "x", NOW)).toEqual({ slug: "x", at: NOW, tree: TREE, session: "s1" });
    expect(existsSync(landRequestPath(common))).toBe(false);
  });

  test("a request with over carries the confirmed checks into the token; /fbs:land typed meanwhile never does", () => {
    const { dir, common } = requested();
    writePendingRequest(common, { slug: "x", pr: 7, tree: TREE, at: NOW, session: "s1", over: [{ name: "e2e", workflow: "CI", state: "cancelled" }, { name: "ci/legacy", state: "failed" }] });
    expect(guardPrompt(expansion(dir, "x"), dir, NOW)).toBe("land token written for x");
    expect(freshToken(common, "x", NOW)).toEqual({ slug: "x", at: NOW, tree: TREE });
    expect(guardReply(reply(dir, "land"), dir, NOW)).toContain("over the failing checks CI / e2e (cancelled), ci/legacy (failed)");
    expect(freshToken(common, "x", NOW)).toEqual({ slug: "x", at: NOW, tree: TREE, session: "s1", over: [{ name: "e2e", workflow: "CI", state: "cancelled" }, { name: "ci/legacy", state: "failed" }] });
  });

  test("a request or token whose over isn't a list of confirmed checks counts for nothing", () => {
    for (const over of [[], "e2e", ["e2e"], [{ name: "" , state: "failed" }], [{ name: "e2e", state: "passed" }], [{ name: "e2e", state: "failed", extra: 1 }]]) {
      const { dir, common } = requested();
      writeFileSync(landRequestPath(common), JSON.stringify({ slug: "x", pr: 7, tree: TREE, at: NOW, session: "s1", over }));
      expect(guardReply(reply(dir, "yes"), dir, NOW)).toContain("no land token");
      expect(existsSync(landTokenPath(common, "x"))).toBe(false);
      writeFileSync(landTokenPath(common, "x"), JSON.stringify({ slug: "x", at: NOW, tree: TREE, over }));
      expect(freshToken(common, "x", NOW)).toBeNull();
    }
  });

  test("a reply naming another PR mints nothing for the request and drops it, so a later yes can't land it", () => {
    const { dir, common } = requested();
    expect(guardReply(reply(dir, "yes #8"), dir, NOW)).toBe("the user named PR #8, but the land request was for PR #7 (x); no land token was written");
    expect(existsSync(landTokenPath(common, "x"))).toBe(false);
    expect(existsSync(landRequestPath(common))).toBe(false);
    expect(guardReply(reply(dir, "yes"), dir, NOW)).toBeNull();
    expect(existsSync(landTokenPath(common, "x"))).toBe(false);
  });

  test("a yes over red checks in the user's own words answers the request and keeps the checks they confirmed", () => {
    for (const prompt of ["yes, land it anyway", "go for it", "yep, merge it anyway", "ok, merge it despite the e2e"]) {
      const { dir, common } = requested();
      writePendingRequest(common, { slug: "x", pr: 7, tree: TREE, at: NOW, session: "s1", over: [{ name: "e2e", workflow: "CI", state: "cancelled" }] });
      expect(guardReply(reply(dir, prompt), dir, NOW)).toContain("over the failing checks CI / e2e (cancelled)");
      expect(freshToken(common, "x", NOW)?.over).toEqual([{ name: "e2e", workflow: "CI", state: "cancelled" }]);
    }
  });

  test("a yes after the request expired mints nothing and removes it; an ask to land then is a plain-words ask", () => {
    const { dir, common } = requested(NOW - REQUEST_TTL_MS);
    expect(guardReply(reply(dir, "yes"), dir, NOW)).toContain("no land token");
    expect(existsSync(landTokenPath(common, "x"))).toBe(false);
    expect(existsSync(landRequestPath(common))).toBe(false);
    const late = requested(NOW - REQUEST_TTL_MS);
    expect(guardReply(reply(late.dir, "land #7"), late.dir, NOW)).toContain("may ask to land x (PR #7)");
    expect(freshToken(late.common, "x", NOW)).toEqual({ slug: "x", at: NOW, tree: TREE, session: "s1" });
  });

  test("a request waits hours for the user's next message, and a token for the verified tree lasts the working day", () => {
    const { dir, common } = requested(NOW - 3 * 60 * 60 * 1000);
    expect(guardReply(reply(dir, "go ahead"), dir, NOW)).toContain("its land token is written");
    expect(freshToken(common, "x", NOW + 8 * 60 * 60 * 1000)).not.toBeNull();
  });

  test("an answer after the feature was stamped again, or its PR landed, mints nothing and removes the request", () => {
    const { dir, common } = requested();
    prRecord(dir, "x", { tree: "b".repeat(40) });
    expect(guardReply(reply(dir, "yes"), dir, NOW)).toContain("no land token");
    expect(existsSync(landTokenPath(common, "x"))).toBe(false);
    expect(existsSync(landRequestPath(common))).toBe(false);
    prRecord(dir, "x", { landed: true });
    writePendingRequest(common, { slug: "x", pr: 7, tree: TREE, at: NOW, session: "s1" });
    expect(guardReply(reply(dir, "yes"), dir, NOW)).toContain("no land token");
    expect(existsSync(landTokenPath(common, "x"))).toBe(false);
  });

  test("a forged request for another tree, PR or a missing feature mints nothing: the token only ever binds the record's stamp", () => {
    for (const forged of [{ slug: "x", pr: 7, tree: "b".repeat(40) }, { slug: "x", pr: 8, tree: TREE }, { slug: "y", pr: 7, tree: TREE }]) {
      const { dir, common } = requested();
      writePendingRequest(common, { ...forged, at: NOW, session: "s1" });
      expect(guardReply(reply(dir, "yes"), dir, NOW)).toContain("no land token");
      expect(existsSync(join(common, "fbs", "land", `${forged.slug}.token`))).toBe(false);
    }
    const { dir, common } = requested();
    writeFileSync(landRequestPath(common), "{");
    expect(guardReply(reply(dir, "yes"), dir, NOW)).toContain("no land token");
    expect(existsSync(landRequestPath(common))).toBe(false);
  });

  test("only an answer in the asking session counts; a missing session on either side is a mismatch", () => {
    const { dir, common } = requested();
    for (const session of [null, ""]) expect(guardReply(reply(dir, "land", session), dir, NOW)).toBeNull();
    expect(guardReply(JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: dir, prompt: "land" }), dir, NOW)).toBeNull();
    expect(guardReply(reply(dir, "yes", "s2"), dir, NOW)).toBeNull();
    expect(existsSync(landTokenPath(common, "x"))).toBe(false);
    expect(existsSync(landRequestPath(common))).toBe(true);
    expect(guardReply(reply(dir, "land", "s1"), dir, NOW)).toContain("run fbs land x");
    const sessionless = requested();
    writeFileSync(landRequestPath(sessionless.common), JSON.stringify({ slug: "x", pr: 7, tree: TREE, at: NOW }));
    expect(guardReply(reply(sessionless.dir, "yes", "s1"), sessionless.dir, NOW)).toContain("no land token");
    expect(existsSync(landTokenPath(sessionless.common, "x"))).toBe(false);
  });

  test("other events, no request, or no repo do nothing", () => {
    const { dir, common } = requested();
    expect(guardReply(JSON.stringify({ hook_event_name: "UserPromptExpansion", session_id: "s1", cwd: dir, prompt: "land" }), dir, NOW)).toBeNull();
    expect(guardReply("not json", dir, NOW)).toBeNull();
    expect(existsSync(landRequestPath(common))).toBe(true);
    expect(guardReply(reply(repo(), "land"), dir, NOW)).toBeNull();
    const outside = tempDir();
    expect(guardReply(reply(outside, "land"), outside, NOW)).toBeNull();
  });
});

describe("a plain-words request to land", () => {
  const say = (cwd: string, prompt: string, session: unknown = "s1") => guardReply(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, transcript_path: "/t.jsonl", cwd, prompt }), cwd, NOW);

  test.each(["go ahead and merge it", "Go ahead and land the PR", "merge it", "ok, land it now please", "ship it", "can you merge #7?", "squash-merge the PR", "looks good, land x"])("%p writes the open PR's token for this session and leaves the call to the agent", (prompt) => {
    const dir = repo();
    prRecord(dir, "x");
    const note = say(dir, prompt);
    expect(note).toContain("may ask to land x (PR #7)");
    expect(note).toContain("run fbs land x");
    expect(note).toContain("If not (a question, a condition, a later time, another PR), don't land");
    expect(freshToken(join(dir, ".git"), "x", NOW)).toEqual({ slug: "x", at: NOW, tree: TREE, session: "s1" });
  });

  test.each(["merge main into it", "fix the merge conflict first", "don't merge it yet", "we shouldn't land this today", "rewrite the landing page copy", "yes", "go ahead", "/fbs:land x", "<task-notification>merge it</task-notification>", `${"context ".repeat(60)}merge it`])("%p writes nothing", (prompt) => {
    const dir = repo();
    prRecord(dir, "x");
    expect(say(dir, prompt)).toBeNull();
    expect(existsSync(landTokenPath(join(dir, ".git"), "x"))).toBe(false);
  });

  test.each(["don’t merge it yet", "Don’t land it", "can't merge it yet", "we cannot land this", "not now, merge it later", "hold on, don't merge"])("the negation %p writes nothing", (prompt) => {
    const dir = repo();
    prRecord(dir, "x");
    expect(say(dir, prompt)).toBeNull();
    expect(existsSync(landTokenPath(join(dir, ".git"), "x"))).toBe(false);
  });

  test("Claude Code's image and paste placeholders don't hide an ask", () => {
    for (const prompt of ["[Image #1] looks good, merge it", "looks good [Image #1], merge it", "[Pasted text #1 +12 lines] ok, land it"]) {
      const dir = repo();
      prRecord(dir, "x");
      expect(say(dir, prompt)).toContain("may ask to land x (PR #7)");
    }
  });

  test("the go lasts until the user's next message that doesn't ask to land; watcher wakes and /fbs:land keep it", () => {
    const dir = repo();
    prRecord(dir, "x");
    const common = join(dir, ".git");
    expect(say(dir, "merge it once CI is green")).toContain("may ask to land x");
    expect(say(dir, "<task-notification><status>completed</status><summary>watcher: green</summary></task-notification>")).toBeNull();
    expect(say(dir, "also fix the typo", "s2")).toBeNull();
    expect(say(dir, "/fbs:land x")).toBeNull();
    expect(freshToken(common, "x", NOW)).not.toBeNull();
    expect(say(dir, "also delete the old branch?")).toBeNull();
    expect(freshToken(common, "x", NOW)).toBeNull();
    expect(say(dir, "yes")).toBeNull();
    expect(freshToken(common, "x", NOW)).toBeNull();
  });

  test("the guard lets fbs land run only from the session whose user gave the go", () => {
    const dir = repo();
    prRecord(dir, "x");
    say(dir, "go ahead and merge it");
    const landCall = (session: string) => guardToolUse(JSON.stringify({ hook_event_name: "PreToolUse", session_id: session, cwd: dir, tool_name: "Bash", tool_input: { command: "fbs land x" } }), dir, NOW).deny;
    expect(landCall("s2")).toEqual([expect.stringContaining("needs a fresh land token")]);
    expect(landCall("s1")).toEqual([]);
  });

  test("with several open PRs it takes the one named by number or slug, and writes none when the ask names none", () => {
    const dir = repo();
    prRecord(dir, "paid-plans", { pr: 7 });
    prRecord(dir, "search", { pr: 8 });
    expect(say(dir, "merge #8")).toContain("may ask to land search (PR #8)");
    expect(say(dir, "go ahead and land paid-plans")).toContain("may ask to land paid-plans (PR #7)");
    expect(say(dir, "land #9")).toBe("the user's message names PR #9, which isn't an open fbs PR; no land token was written");
    const common = join(dir, ".git");
    rmSync(join(common, "fbs", "land"), { recursive: true });
    expect(say(dir, "go ahead and merge it")).toBe("the user's message may ask to land a PR, but several fbs PRs are open (paid-plans (PR #7), search (PR #8)), so no land token was written. If they're asking to land one, ask which, then run fbs land request <slug>: their yes lands it");
    expect(existsSync(join(common, "fbs", "land"))).toBe(false);
  });

  test("a feature with work units lands its lowest open unit, or the unit named by number", () => {
    const dir = repo();
    record(dir, "f");
    const features = join(dir, ".git", "fbs", "features");
    for (const [slug, unit, pr] of [["f-api", 1, 21], ["f-ui", 2, 22]] as const) {
      prRecord(dir, slug, { pr });
      const path = join(features, `${slug}.json`);
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), unitOf: "f", unit }));
    }
    expect(say(dir, "merge the stack")).toContain("may ask to land f-api (PR #21)");
    expect(say(dir, "land #22")).toContain("may ask to land f-ui (PR #22)");
  });

  test("an unstamped PR, no session, no open PR or another repo writes nothing", () => {
    const unstamped = repo();
    prRecord(unstamped, "x", { stamp: false });
    expect(say(unstamped, "merge it")).toBe("the user's message may ask to land x (PR #7), but it has no verify stamp, so no land token was written: it needs verify first");
    expect(existsSync(landTokenPath(join(unstamped, ".git"), "x"))).toBe(false);
    const dir = repo();
    prRecord(dir, "x");
    for (const session of [null, "", 3]) expect(say(dir, "merge it", session)).toBeNull();
    const landed = repo();
    prRecord(landed, "x", { landed: true });
    expect(say(landed, "merge it")).toBeNull();
    expect(say(tempDir(), "merge it")).toBeNull();
  });

  test("a scheduled prompt that asks to merge is denied in an fbs repo before any PR opens, and allowed outside fbs", () => {
    const fbsRepo = repo();
    record(fbsRepo, "x", false);
    const schedule = (cwd: string) => guardToolUse(JSON.stringify({ hook_event_name: "PreToolUse", cwd, tool_name: "CronCreate", tool_input: { cron: "*/30 * * * *", prompt: "check the PR and merge it when approved" } }), cwd, NOW).deny;
    expect(schedule(fbsRepo).join("\n")).toContain("only the user asks to land");
    expect(schedule(repo())).toEqual([]);
  });

  test("a scheduled or sent prompt that asks to merge is denied while a PR flow runs; a subagent's brief that mentions landing isn't", () => {
    const dir = repo();
    prRecord(dir, "x");
    const tool = (tool_name: string, tool_input: Record<string, unknown>) => guardToolUse(JSON.stringify({ hook_event_name: "PreToolUse", cwd: dir, tool_name, tool_input }), dir, NOW).deny;
    expect(tool("CronCreate", { cron: "*/5 * * * *", prompt: "go ahead and merge it" }).join("\n")).toContain("only the user asks to land");
    expect(tool("ScheduleWakeup", { delaySeconds: 600, prompt: "/loop 5m merge the PR", reason: "r" }).join("\n")).toContain("only the user asks to land");
    expect(tool("Agent", { description: "Fix review comments", prompt: "Fix the two review comments on PR #7 so it is ready to land, then merge origin/main into the branch." })).toEqual([]);
    expect(tool("Skill", { skill: "loop", args: "5m merge it if green" }).join("\n")).toContain("only the user asks to land");
    expect(tool("CronCreate", { cron: "0 9 * * *", prompt: "yes" }).join("\n")).toContain("only the user asks to land");
    expect(tool("SendMessage", { to: "reviewer", message: "yes, go ahead" })).toEqual([]);
    expect(tool("Agent", { description: "Land the PR", prompt: "Check whether PR #7 can land and report back." })).toEqual([]);
    expect(tool("Skill", { skill: "fbs:camp-pr", args: "ok" })).toEqual([]);
    expect(tool("Bash", { command: "claude -p 'go ahead and merge it'" })[0]).toContain("claude run");
    expect(tool("Bash", { command: "echo merge it | claude -p" })[0]).toContain("claude run");
  });
});

describe("rewriting an open PR's branch", () => {
  const say = (cwd: string, prompt: string, session: unknown = "s1") => guardReply(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, transcript_path: "/t.jsonl", cwd, prompt }), cwd, NOW);
  const push = (cwd: string, command = "git push --force-with-lease origin feat/x", session = "s1") => guardToolUse(JSON.stringify({ hook_event_name: "PreToolUse", session_id: session, cwd, tool_name: "Bash", tool_input: { command } }), cwd, NOW).deny;

  const cli = (cwd: string, args: string[], session: string | null = "s1") => {
    const out: string[] = [];
    const deps = { gh: () => ({ code: 1, stdout: "", stderr: "no gh in this test" }), now: () => NOW, sleep: () => {}, stdin: () => "" };
    const code = run(args, { cwd, today: "2026-10-25", out: (l) => out.push(l), err: (l) => out.push(`err: ${l}`) }, deps, { ...REAL_AFK_DEPS, sessionId: () => session });
    return { code, out };
  };

  /** A repo on feat/x, the branch of x's open PR: two commits over origin's main, the tip origin has. */
  function prBranch(): { dir: string; git: (...args: string[]) => string } {
    const dir = repo();
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-c", "user.name=fbs", "-c", "user.email=fbs@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env: isolatedGitEnv(), stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    git("symbolic-ref", "HEAD", "refs/heads/main");
    writeFileSync(join(dir, "a.txt"), "zero\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "chore: start");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("switch", "-q", "-c", "feat/x");
    writeFileSync(join(dir, "b.txt"), "one\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "feat: add b");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("commit", "-q", "-a", "-m", `fix: a body line that is far too long\n\n${"x".repeat(120)}`);
    git("update-ref", "refs/remotes/origin/feat/x", "HEAD");
    prRecord(dir, "x");
    return { dir, git };
  }

  test("rewording any commit passes; squashing or re-parenting onto a new base, the tip's tree the same, needs the user's go", () => {
    const { dir, git } = prBranch();
    const base = git("rev-parse", "origin/main");
    const [first, second] = [git("rev-parse", "HEAD~1^{tree}"), git("rev-parse", "HEAD^{tree}")];
    const reworded = git("commit-tree", first, "-p", base, "-m", "feat: add the b file");
    git("reset", "-q", "--hard", git("commit-tree", second, "-p", reworded, "-m", "fix: a body line that fits"));
    expect(push(dir)).toEqual([]);
    git("reset", "-q", "--hard", git("commit-tree", second, "-p", base, "-m", "feat: add b, squashed"));
    expect(push(dir).join("\n")).toContain("rewrites feat/x");
    const moved = git("commit-tree", git("rev-parse", "origin/main^{tree}"), "-p", base, "-m", "chore: main moved");
    git("update-ref", "refs/remotes/origin/main", moved);
    const replayed = git("commit-tree", first, "-p", moved, "-m", "feat: add b");
    git("reset", "-q", "--hard", git("commit-tree", second, "-p", replayed, "-m", "fix: a body line that fits"));
    expect(push(dir).join("\n")).toContain("rewrites feat/x");
  });

  test("a rewrite chained before the push in the same command gets no pass, even with the branch in sync when the hook runs", () => {
    const { dir } = prBranch();
    expect(push(dir)).toEqual([]);
    expect(push(dir, "git rebase origin/main && git push --force-with-lease origin feat/x").join("\n")).toContain("rewrites feat/x");
    expect(push(dir, "git reset --soft origin/main; git commit -m squash; git push --force-with-lease").join("\n")).toContain("rewrites feat/x");
  });

  test("fbs rewrite request turns the user's yes, as their next message in the asking session, into the rewrite token", () => {
    const dir = rewritten();
    expect(cli(dir, ["rewrite", "request", "x"])).toEqual({ code: 0, out: [JSON.stringify({ requested: true, slug: "x", pr: 7, branch: "feat/x" })] });
    expect(say(dir, "yes", "s2")).toBeNull();
    expect(push(dir)).toHaveLength(1);
    expect(say(dir, "yes, go ahead")).toContain("answered yes to rewriting feat/x (PR #7)");
    expect(existsSync(landRequestPath(join(dir, ".git")))).toBe(false);
    expect(push(dir)).toEqual([]);
    expect(push(dir)).toHaveLength(1);
  });

  test("any other message drops a rewrite request, and a yes naming another PR writes nothing", () => {
    const dir = rewritten();
    expect(cli(dir, ["rewrite", "request", "x"]).code).toBe(0);
    expect(say(dir, "wait, fix the test first")).toBeNull();
    expect(say(dir, "yes")).toBeNull();
    expect(push(dir)).toHaveLength(1);
    expect(cli(dir, ["rewrite", "request", "x"]).code).toBe(0);
    expect(say(dir, "yes, #9")).toBe("the user named PR #9, but the rewrite request was for PR #7 (x); no rewrite token was written");
    expect(push(dir)).toHaveLength(1);
  });

  test("a rewrite request is refused with no open PR or no session, and while another feature's request waits; it holds back a land request too", () => {
    const dir = rewritten();
    expect(cli(dir, ["rewrite", "request", "x"], null).out[0]).toStartWith("refused: no Claude Code session");
    record(dir, "z");
    expect(cli(dir, ["rewrite", "request", "z"])).toEqual({ code: 1, out: ["refused: no PR recorded for z", "refused: no branch recorded for z"] });
    prRecord(dir, "y", { pr: 8 });
    writePendingRequest(join(dir, ".git"), { slug: "y", pr: 8, tree: TREE, at: NOW, session: "s1" });
    expect(cli(dir, ["rewrite", "request", "x"])).toEqual({ code: 1, out: ["refused: a land request for y (PR #8) is waiting for the user's answer; ask again after they reply"] });
    rmSync(landRequestPath(join(dir, ".git")));
    expect(cli(dir, ["rewrite", "request", "x"]).code).toBe(0);
    expect(cli(dir, ["land", "request", "y"]).out).toContain("refused: a rewrite request for x (PR #7) is waiting for the user's answer; ask again after they reply");
  });

  test.each(["autosquash the fixups", "fold the fixups in", "push -f", "force-push it", "amend the message, don't touch the code", "squash the fixups, no need to rebase"])("%p writes a rewrite token", (prompt) => {
    const dir = rewritten();
    expect(say(dir, prompt)).toContain("may ask to rewrite");
    expect(push(dir)).toEqual([]);
  });

  /** prBranch with the tip's tree changed under the same message: a rewrite only the user's go lets through. */
  function rewritten(): string {
    const { dir, git } = prBranch();
    writeFileSync(join(dir, "a.txt"), "two\n");
    git("commit", "-q", "--amend", "-a", "--no-edit");
    return dir;
  }

  test("a messages-only amend passes on its own; a change to the tree is denied", () => {
    const { dir, git } = prBranch();
    git("commit", "-q", "--amend", "-m", "fix: a body line that fits");
    expect(push(dir)).toEqual([]);
    expect(push(dir, "git push --force-with-lease")).toEqual([]);
    expect(push(dir, "git push --force origin feat/x").join("\n")).toContain("use --force-with-lease alone");
    writeFileSync(join(dir, "a.txt"), "two\n");
    git("commit", "-q", "--amend", "-a", "--no-edit");
    expect(push(dir).join("\n")).toContain("rewrites feat/x");
  });

  test.each(["go ahead and amend it", "force push it", "squash those commits", "rebase it onto main", "you can rewrite the history", "please do the amendment on the commit, I give you permission to execute it this time"])("%p lets one lease push through from this session", (prompt) => {
    const dir = rewritten();
    expect(push(dir)).toHaveLength(1);
    const note = say(dir, prompt);
    expect(note).toContain("may ask to rewrite");
    expect(note).toContain("--force-with-lease alone");
    expect(push(dir, "git push --force-with-lease origin feat/x", "s2")).toHaveLength(1);
    expect(push(dir)).toEqual([]);
    expect(push(dir)).toHaveLength(1);
  });

  test("a denied push leaves the token, and a push the tree or another branch lets through doesn't spend it", () => {
    const { dir, git } = prBranch();
    say(dir, "go ahead and force push it");
    expect(push(dir, "git push --force origin feat/x")).toHaveLength(1);
    expect(push(dir, "git push --force-with-lease origin feat/other")).toEqual([]);
    git("commit", "-q", "--amend", "-m", "fix: reworded");
    expect(push(dir)).toEqual([]);
    writeFileSync(join(dir, "a.txt"), "two\n");
    git("commit", "-q", "--amend", "-a", "--no-edit");
    expect(push(dir)).toEqual([]);
    expect(push(dir)).toHaveLength(1);
  });

  test("the go lasts until the user's next message that doesn't ask for it; notifications and other sessions keep it", () => {
    const dir = rewritten();
    say(dir, "rebase it onto main");
    expect(say(dir, "<task-notification><summary>watcher: green</summary></task-notification>")).toBeNull();
    expect(say(dir, "rename the button", "s2")).toBeNull();
    expect(push(dir)).toEqual([]);
    say(dir, "and squash it while you're at it");
    expect(say(dir, "also fix the typo")).toBeNull();
    expect(push(dir)).toHaveLength(1);
  });

  test.each(["don't force push", "do not rebase it", "never amend a pushed commit", "squash-merge the PR", "squash and merge it", "rewrite the landing page copy", "/fbs:camp-pr x", "<task-notification>force push it</task-notification>", `${"context ".repeat(60)}force push it`])("%p writes no rewrite token", (prompt) => {
    const dir = rewritten();
    expect(say(dir, prompt) ?? "").not.toContain("rewrite");
    expect(push(dir)).toHaveLength(1);
  });

  test("no open PR or no session writes nothing", () => {
    const dir = repo();
    record(dir, "x");
    expect(say(dir, "force push it")).toBeNull();
    expect(existsSync(join(dir, ".git", "fbs", "land"))).toBe(false);
    const open = rewritten();
    for (const session of [null, "", 3]) expect(say(open, "force push it", session)).toBeNull();
    expect(push(open)).toHaveLength(1);
  });

  test("a scheduled prompt that asks to rewrite is denied like a land ask, in an fbs repo before any PR opens", () => {
    const dir = repo();
    record(dir, "x", false);
    const tool = (tool_name: string, tool_input: Record<string, unknown>) => guardToolUse(JSON.stringify({ hook_event_name: "PreToolUse", cwd: dir, tool_name, tool_input }), dir, NOW).deny;
    expect(tool("CronCreate", { cron: "0 9 * * *", prompt: "rebase it onto main and force push it" }).join("\n")).toContain("only the user asks");
    expect(tool("Skill", { skill: "loop", args: "10m squash those commits" }).join("\n")).toContain("only the user asks");
    expect(tool("CronCreate", { cron: "0 9 * * *", prompt: "run the nightly report" })).toEqual([]);
    prRecord(dir, "y");
    expect(tool("Bash", { command: "claude -p 'go ahead and force push it'" })[0]).toContain("claude run");
  });
});

describe("afkDenials", () => {
  const RUN: AfkGuardRun = { slug: "seo", worktree: "/wt", branch: "fbs/seo", protectedFiles: ["e2e/home.spec.ts", "e2e/a.spec.ts", "e2e/x.ts", "e2e/n.ipynb", "src/app.test.ts"], deny: ["prod.db.internal"], kept: "k".repeat(40), status: "running", ownsCall: true };
  const deny = (tool: string, input: Record<string, unknown>, cwd = "/wt", run: Partial<AfkGuardRun> = {}, refs: string[] = [], above: string[] = []) =>
    afkDenials(tool, input, cwd, "/repo/.git", [{ ...RUN, ...run }], ctx({ isCommit: (ref) => refs.includes(ref), isStepAbove: (_, ref, kept) => kept === RUN.kept && above.includes(ref) }));
  const bash = (command: string, cwd = "/wt", run: Partial<AfkGuardRun> = {}, refs: string[] = [], above: string[] = []) => deny("Bash", { command }, cwd, run, refs, above);
  const STATE = "touches the afk run's state, which only fbs afk commands read and write; record a step with fbs afk check seo";

  test("nothing is denied without a running run", () => {
    expect(afkDenials("Bash", { command: "fly deploy" }, "/wt", "/repo/.git", [], ctx())).toEqual([]);
  });

  test("edits to protected files, relative to the run's worktree, are denied however the path is spelled", () => {
    for (const [tool, input] of [
      ["Write", { file_path: "/wt/e2e/home.spec.ts" }],
      ["Edit", { file_path: "src/app.test.ts" }],
      ["MultiEdit", { file_path: "/wt/./src/../E2E/x.ts" }],
      ["NotebookEdit", { notebook_path: "/wt/e2e/n.ipynb" }],
    ] as const) {
      const reasons = deny(tool, input);
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain("is protected in afk run seo; reach the finish line by changing the code");
    }
    expect(deny("Write", { file_path: "/wt/src/app.ts" })).toEqual([]);
    expect(deny("Write", { file_path: "/other/e2e/home.spec.ts" })).toEqual([]);
  });

  test("protected means the files protected at the start: a new test beside them is allowed", () => {
    expect(deny("Write", { file_path: "/wt/e2e/new.spec.ts" })).toEqual([]);
    expect(deny("Write", { file_path: "/wt/src/b.test.ts" })).toEqual([]);
    expect(bash("echo x > e2e/new.spec.ts")).toEqual([]);
  });

  test("edits to the afk state are denied; the rest of fbs's files are the rest of its flow", () => {
    for (const path of ["/repo/.git/fbs/afk/seo/run.json", "/repo/.git/FBS/afk/seo.seal", "/repo/.git/fbs/afk/seo.lock", "/repo/.git/fbs/afk/seo.stopblock", "/repo/.git/fbs/afk/seo.out-1/a.out"]) {
      expect(deny("Write", { file_path: path }).join("\n")).toContain("is the afk run's state, which only fbs afk commands write; record a step with fbs afk check seo");
    }
    expect(deny("mcp__fs__delete_directory", { path: "/repo/.git/fbs" })).toHaveLength(1);
    for (const path of ["/repo/.git/fbs/pr/seo.md", "/repo/.git/fbs/pr/x.camp", "/repo/.git/fbs/evidence/seo/2026-10-28-1200/index.md", "/repo/src/fbs/afk.ts"]) {
      expect(deny("Write", { file_path: path })).toEqual([]);
    }
  });

  test("while the run is met, the state message reads and the merged way out is named; the history rules are off", () => {
    const met = { status: "met" as const };
    const reasons = deny("Write", { file_path: "/repo/.git/fbs/afk/seo/run.json" }, "/wt", met);
    expect(reasons.join("\n")).toContain("is the afk run's state, which only fbs afk commands write; read it with fbs afk show seo");
    expect(reasons.join("\n")).not.toContain("fbs afk check");
    expect(reasons.join("\n")).toContain("if its PR is already merged, run fbs afk stop seo --reason merged");
    expect(bash("fly deploy", "/wt", met).join("\n")).toContain("fbs afk stop seo --reason merged");
    for (const command of ["git rebase -i --autosquash main", "git commit --amend --no-edit", "git reset --hard HEAD~3", "git stash", "git push --force-with-lease origin fbs/seo"]) {
      expect(bash(command, "/wt", met, ["main", "HEAD~3"])).toEqual([]);
    }
  });

  test.each([
    "cat .git/fbs/afk/seo/run.json",
    "cat /repo/.git/fbs/afk/seo/log.tsv",
    "ls /REPO/.git/fbs",
    "cp x $(git rev-parse --git-common-dir)/fbs/afk/seo/verdicts/meta-1.json",
    "cd .git/fbs && ls",
    "fbs afk show seo > .git/fbs/afk/seo/run.json",
    "rm -rf $(git rev-parse --git-common-dir)/fbs",
    "rm -rf \"$(git rev-parse --git-dir)/fbs\"",
    "cd .git && rm -rf fbs",
    "cd $(git rev-parse --git-common-dir) && ls",
    "rm -rf .git/fbs",
    "rm -rf /repo/.git/fbs/",
  ])("a command on the fbs state is denied, from any call: %p", (command) => {
    expect(bash(command, "/wt", { ownsCall: false }).join("\n")).toContain(STATE);
  });

  test.each([
    "fbs afk check seo",
    "fbs afk stop seo --reason 'run.json says the goal is unreachable'",
    "${CLAUDE_PLUGIN_ROOT}/bin/fbs afk show seo 2>&1",
    "bun cli/main.ts afk-guard seo",
    "FBS_TODAY=2026-10-28 fbs afk check seo",
    "bun run build && bun test",
    "git status",
    "git commit -m 'fix run.json parsing'",
    "cat log.tsv verdicts/a.json x.seal",
    "cat .gitignore && ls .github/workflows",
    "git -C /tmp/work/fbs rev-parse --git-common-dir",
    "cd /tmp/work/fbs && git status --git-dir",
    "git commit -m 'rm flaky skip in src/app.test.ts'",
    "git tag -a v1 -m 'mv e2e/a.spec.ts later'",
    "gh pr create --draft --title t --body-file /repo/.git/fbs/pr/seo.md",
    "fbs pr reply seo --comment thread:1 --body-file /repo/.git/fbs/pr/reply.md",
    "cat .git/fbs/pr/seo.md",
    "cp body.md $(git rev-parse --git-common-dir)/fbs/pr/seo.md",
    "ls .git/fbs/evidence/seo",
  ])("allowed: %p", (command) => {
    expect(bash(command)).toEqual([]);
  });

  test.each([
    ["vercel --prod", "vercel --prod"],
    ["npx vercel deploy --prod", "vercel --prod"],
    ["fly deploy -a app", "fly deploy"],
    ["flyctl deploy", "flyctl deploy"],
    ["railway up", "railway up"],
    ["terraform -chdir=infra apply -auto-approve", "terraform apply"],
    ["terraform destroy", "terraform destroy"],
    ["pulumi up --yes", "pulumi up"],
    ["kubectl apply -f k8s/", "kubectl apply"],
    ["kubectl delete pod x", "kubectl delete"],
    ["helm upgrade app ./chart", "helm upgrade"],
    ["gcloud run deploy api", "gcloud deploy"],
    ["aws cloudformation deploy --stack x", "aws deploy"],
    ["npm publish", "npm publish"],
    ["bun publish", "bun publish"],
    ["bunx prisma migrate deploy", "prisma migrate deploy"],
    ["supabase db push", "supabase db push"],
    ["wrangler deploy", "wrangler deploy"],
    ["heroku releases", "heroku"],
    ["echo ok && bash -c 'fly deploy'", "fly deploy"],
    ["bun run deploy", "bun run deploy"],
    ["npm run --silent release:prod", "npm run release:prod"],
    ["pnpm deploy", "pnpm run deploy"],
    ["yarn publish:docs", "yarn run publish:docs"],
    ["bun deploy", "bun run deploy"],
  ])("a deploy is denied: %p", (command, named) => {
    expect(bash(command).join("\n")).toContain(`${named} deploys or changes production, which an afk run never does; leave it for the PR and the human`);
  });

  test.each(["vercel", "vercel build", "terraform plan", "kubectl get pods", "helm template ./chart", "prisma migrate dev", "supabase start", "wrangler dev", "bun run dev", "npm run build", "yarn test", "pnpm install"])("not a deploy: %p", (command) => {
    expect(bash(command)).toEqual([]);
  });

  test("a call that isn't the run's gets only the path rules: no deploy, afk.deny or history rules", () => {
    const other = { ownsCall: false };
    // From another checkout, a relative path is that checkout's file, not the worktree's.
    expect(bash("echo x > src/app.test.ts", "/main", other)).toEqual([]);
    expect(bash("rm src/app.test.ts", "/main", other)).toEqual([]);
    expect(deny("Write", { file_path: "src/app.test.ts" }, "/main", other)).toEqual([]);
    expect(bash("fly deploy", "/main", other)).toEqual([]);
    expect(bash("psql postgres://prod.db.internal/app", "/main", other)).toEqual([]);
    expect(bash("git stash", "/main", other)).toEqual([]);
    expect(bash("echo x > /wt/e2e/a.spec.ts", "/main", other)).toHaveLength(1);
    expect(bash("cat /repo/.git/fbs/afk/seo/run.json", "/main", other)).toHaveLength(1);
    expect(deny("Write", { file_path: "/wt/e2e/a.spec.ts" }, "/main", other)).toHaveLength(1);
  });

  test.each([
    "sed -i '' s/a/b/ e2e/home.spec.ts",
    "echo x > e2e/home.spec.ts",
    "echo x >>/wt/src/app.test.ts",
    "echo x | tee e2e/a.spec.ts",
    "cp /tmp/x e2e/a.spec.ts",
    "mv e2e/a.spec.ts /tmp/",
    "rm -f e2e/a.spec.ts",
    "ln -sf /tmp/x e2e/a.spec.ts",
    "truncate -s 0 e2e/a.spec.ts",
    "perl -pi -e s/a/b/ src/app.test.ts",
    "git rm e2e/a.spec.ts",
  ])("a command writing a protected file is denied: %p", (command) => {
    expect(bash(command).join("\n")).toContain("is protected in afk run seo");
  });

  test.each(["cat e2e/home.spec.ts", "grep -n x src/app.test.ts", "bun test src/app.test.ts", "cp e2e/a.spec.ts /tmp/x", "sed -n 1,5p e2e/a.spec.ts", "echo x > src/app.ts 2>&1"])("reading a protected file is allowed: %p", (command) => {
    expect(bash(command)).toEqual([]);
  });

  test("writes to Claude Code's settings and hooks are denied, by tool or command", () => {
    for (const path of ["/wt/.claude/settings.json", "/Users/x/.claude/settings.local.json", "/wt/.claude/hooks/pre.sh"]) {
      expect(deny("Write", { file_path: path }).join("\n")).toContain("Claude Code's settings or hooks");
    }
    expect(bash("echo {} > .claude/settings.json").join("\n")).toContain("Claude Code's settings or hooks");
    expect(bash("cat .claude/settings.json")).toEqual([]);
    expect(deny("Write", { file_path: "/wt/docs/settings.json" })).toEqual([]);
  });

  test("MCP filesystem writes are checked like Write", () => {
    expect(deny("mcp__filesystem__write_file", { path: "/wt/e2e/a.spec.ts", content: "x" })).toHaveLength(1);
    expect(deny("mcp__fs__move_file", { source: "/wt/e2e/a.spec.ts", destination: "/tmp/x" })).toHaveLength(1);
    expect(deny("mcp__fs__create_directory", { path: "/repo/.git/fbs/afk/x" })).toHaveLength(1);
    expect(deny("mcp__fs__read_file", { path: "/wt/e2e/a.spec.ts" })).toEqual([]);
  });

  test("a Write through a symlink to a protected file is denied", () => {
    const real = tempDir();
    mkdirSync(join(real, "e2e"));
    const link = join(tempDir(), "link");
    symlinkSync(real, link);
    const reasons = afkDenials("Write", { file_path: join(link, "e2e", "a.spec.ts") }, link, "/repo/.git", [{ ...RUN, worktree: real }], ctx());
    expect(reasons.join("\n")).toContain("e2e/a.spec.ts is protected");
  });

  test("afk.deny entries are plain substrings, matched without case or quotes", () => {
    expect(bash("psql postgres://u@PROD.db.internal/app").join("\n")).toContain('matches "prod.db.internal" in .fbs/config.json afk.deny');
    expect(bash("psql 'postgres://u@prod.db.'\"internal/app\"")).toHaveLength(1);
    expect(bash("psql postgres://localhost/app")).toEqual([]);
    expect(bash("make release", "/wt", { deny: ["make release", " "] })).toHaveLength(1);
  });

  test.each([
    ["git commit --amend --no-edit", "git commit --amend rewrites a step the afk run already checked; make a new commit and run fbs afk check seo"],
    ["git rebase -i HEAD~3", "git rebase rewrites the steps afk run seo kept"],
    ["git stash", "git stash hides or brings back work"],
    ["git stash pop", "git stash hides or brings back work"],
    ["git switch main", "git switch leaves the afk run's branch fbs/seo"],
    ["git checkout -b other", "leaves the afk run's branch fbs/seo"],
    ["git checkout main", "git checkout main leaves the afk run's branch fbs/seo"],
    ["git reset --hard HEAD~1", "git reset HEAD~1 would drop or rewrite kept steps; the CLI discards steps itself when you run fbs afk check seo"],
    ["git reset --soft abc123", "git reset abc123 would drop or rewrite kept steps"],
    ["git push --force-with-lease origin fbs/seo", "git push --force* rewrites the afk run's remote branch"],
    ["git push -f origin fbs/seo", "git push --force* rewrites the afk run's remote branch"],
  ])("in the run's worktree, %p is denied", (command, reason) => {
    expect(bash(command, "/wt", {}, ["main", "HEAD~1", "fbs/seo"]).join("\n")).toContain(reason);
  });

  test.each(["git reset --hard", "git reset --hard HEAD", "git reset -- src/a.ts", "git reset", "git checkout -- src/a.ts", "git checkout .", "git checkout src/a.ts", "git checkout fbs/seo", "git checkout HEAD~1 -- src/a.ts", "git commit -m step", "git push -u origin fbs/seo", "git stash list", "git stash show"])(
    "in the run's worktree, %p is allowed",
    (command) => {
      expect(bash(command, "/wt", {}, ["main", "HEAD~1", "fbs/seo"])).toEqual([]);
    },
  );

  test("the history rules apply in the run's worktree, through -C, or from the run's session; not in another checkout", () => {
    expect(bash("git rebase main", "/main", { ownsCall: false })).toEqual([]);
    expect(bash("git stash", "/main", { ownsCall: false })).toEqual([]);
    expect(bash("git -C /wt rebase main", "/main", { ownsCall: false })).toHaveLength(1);
    expect(bash("cd /wt && git rebase main", "/main", { ownsCall: true })).toHaveLength(1);
  });

  test("a reset or amend that only drops unchecked steps above the last kept commit is allowed", () => {
    expect(bash("git reset --hard HEAD~1", "/wt", {}, [], ["HEAD~1"])).toEqual([]);
    expect(bash("git reset --hard HEAD~2", "/wt", {}, [], ["HEAD~1"])).toHaveLength(1);
    expect(bash("git commit --amend --no-edit", "/wt", {}, [], ["HEAD"])).toEqual([]);
    expect(bash("git commit --amend --no-edit", "/wt", {}, [], [])).toHaveLength(1);
  });
});

describe("guardToolUse during an afk run", () => {
  function afkRepo(status = "running", sessionId: string | null = "s1"): { dir: string; common: string } {
    const dir = repo();
    const run = (...args: string[]) => expect(Bun.spawnSync(["git", "-c", "user.name=fbs", "-c", "user.email=fbs@example.com", ...args], { cwd: dir, env: isolatedGitEnv() }).exitCode).toBe(0);
    mkdirSync(join(dir, ".fbs"));
    writeFileSync(join(dir, ".fbs", "config.json"), JSON.stringify({ afk: { deny: ["prod.db.internal"] } }));
    run("add", "-A");
    run("commit", "-q", "-m", "init");
    const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir, env: isolatedGitEnv() }).stdout.toString().trim();
    // The agent drops the deny entry after the start; the guard still reads the start commit's.
    writeFileSync(join(dir, ".fbs", "config.json"), "{}");
    const common = join(dir, ".git");
    mkdirSync(join(common, "fbs", "afk", "seo"), { recursive: true });
    const record = { slug: "seo", status, sessionId, goal: "g", worktree: dir, branch: "feat", protect: ["e2e/**"], protected: { "e2e/a.spec.ts": "0".repeat(64) }, start: { sha, at: "2026-10-28T00:00:00.000Z", results: [] }, kept: { sha, results: [], met: false } };
    writeFileSync(join(common, "fbs", "afk", "seo", "run.json"), `${JSON.stringify(record, null, 2)}\n`);
    return { dir, common };
  }
  const call = (cwd: string, tool: string, input: Record<string, unknown>, session = "s1") => guardToolUse(JSON.stringify({ hook_event_name: "PreToolUse", session_id: session, cwd, tool_name: tool, tool_input: input }), cwd, NOW).deny;

  test("with nothing running, the afk rules stay off", () => {
    const dir = repo();
    expect(call(dir, "Bash", { command: "fly deploy" })).toEqual([]);
    expect(call(dir, "Write", { file_path: join(dir, "e2e/a.spec.ts") })).toEqual([]);
  });

  test("a running run denies its protected files, its state, deploys, afk.deny at the start commit, history rewrites and the camp's merges", () => {
    const { dir, common } = afkRepo();
    expect(call(dir, "Write", { file_path: join(dir, "e2e/a.spec.ts") })).toHaveLength(1);
    expect(call(dir, "Edit", { file_path: join(common, "fbs", "afk", "seo", "run.json") })).toHaveLength(1);
    expect(call(dir, "Bash", { command: "cat .git/fbs/afk/seo/log.tsv" })).toHaveLength(1);
    expect(call(dir, "Bash", { command: "fly deploy" })).toHaveLength(1);
    expect(call(dir, "Monitor", { command: "psql postgres://prod.db.internal/app" })).toHaveLength(1);
    expect(call(dir, "Bash", { command: "git rebase main" })).toHaveLength(1);
    expect(call(dir, "Bash", { command: "gh pr merge 7" })).toHaveLength(1);
    expect(call(dir, "Bash", { command: "git push origin main" })).toHaveLength(1);
    expect(call(dir, "Bash", { command: "fbs afk check seo" })).toEqual([]);
    expect(call(dir, "Write", { file_path: join(dir, "src/a.ts") })).toEqual([]);
    expect(call(dir, "Bash", { command: "bun test" })).toEqual([]);
  });

  test("the run's command rules follow its session into another worktree and stay off there for other sessions; path rules hold for all", () => {
    const { dir, common } = afkRepo();
    const other = join(tempDir(), "other");
    expect(Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "other", other], { cwd: dir, env: isolatedGitEnv() }).exitCode).toBe(0);
    expect(call(other, "Bash", { command: "git stash" }, "s2")).toEqual([]);
    expect(call(other, "Bash", { command: "git stash" }, "s1")).toHaveLength(1);
    expect(call(other, "Bash", { command: `git -C ${dir} stash` }, "s2")).toHaveLength(1);
    expect(call(other, "Bash", { command: "fly deploy" }, "s2")).toEqual([]);
    expect(call(other, "Bash", { command: "fly deploy" }, "s1")).toHaveLength(1);
    expect(call(other, "Bash", { command: "gh pr merge 7" }, "s2")).toEqual([]);
    expect(call(other, "Bash", { command: "gh pr merge 7" }, "s1")).toHaveLength(1);
    expect(call(other, "Write", { file_path: join(dir, "e2e/a.spec.ts") }, "s2")).toHaveLength(1);
    expect(call(other, "Bash", { command: `cat ${join(common, "fbs", "afk", "seo", "run.json")}` }, "s2")).toHaveLength(1);
    mark(dir);
    expect(call(other, "Bash", { command: "gh pr merge 7" }, "s2")).toHaveLength(1);
  });

  test("a reset or amend is allowed only over unchecked commits above the kept one", () => {
    const { dir } = afkRepo();
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=fbs", "-c", "user.email=fbs@example.com", ...args], { cwd: dir, env: isolatedGitEnv() });
    const kept = git("rev-parse", "HEAD").stdout.toString().trim();
    expect(call(dir, "Bash", { command: "git commit --amend --no-edit" })).toHaveLength(1);
    for (const n of [1, 2]) {
      writeFileSync(join(dir, `s${n}.txt`), "x");
      git("add", "-A");
      git("commit", "-q", "-m", `step ${n}`);
    }
    expect(call(dir, "Bash", { command: "git reset --hard HEAD~1" })).toEqual([]);
    expect(call(dir, "Bash", { command: "git commit --amend --no-edit" })).toEqual([]);
    expect(call(dir, "Bash", { command: "git reset --hard HEAD~2" })).toHaveLength(1);
    expect(call(dir, "Bash", { command: `git reset --hard ${kept}` })).toHaveLength(1);
    expect(call(dir, "Bash", { command: `git reset --hard ${kept}~1` })).toHaveLength(1);
  });

  test("a met run keeps the afk rules until it is landed", () => {
    const { dir, common } = afkRepo("met");
    expect(afkRunsIn(common, ["running", "met"]).map((r) => r.slug)).toEqual(["seo"]);
    // Each denial, plus the way out when the PR was merged outside fbs land.
    expect(call(dir, "Bash", { command: "fly deploy" })).toHaveLength(2);
    expect(call(dir, "Write", { file_path: join(dir, "e2e/a.spec.ts") })).toHaveLength(2);
    expect(call(dir, "Bash", { command: "git rebase -i --autosquash main" })).toEqual([]);
  });

  test.each(["landed", "stopped"])("a %s run switches the afk rules off", (status) => {
    const { dir, common } = afkRepo(status);
    expect(afkRunsIn(common, ["running", "met"])).toEqual([]);
    expect(call(dir, "Bash", { command: "fly deploy" })).toEqual([]);
    expect(call(dir, "Bash", { command: "gh pr merge 7" })).toEqual([]);
    expect(call(dir, "Write", { file_path: join(dir, "e2e/a.spec.ts") })).toEqual([]);
  });

  test("an archived run dir and an unreadable record don't count as running", () => {
    const { common } = afkRepo();
    const root = join(common, "fbs", "afk");
    mkdirSync(join(root, "seo.2026-10-28T00-00-00-000Z"));
    writeFileSync(join(root, "seo.2026-10-28T00-00-00-000Z", "run.json"), JSON.stringify({ slug: "seo", status: "running" }));
    mkdirSync(join(root, "broken"));
    writeFileSync(join(root, "broken", "run.json"), "{");
    expect(afkRunsIn(common, ["running", "met"]).map((r) => r.slug)).toEqual(["seo"]);
  });

  test("unparseable input with a running run fails closed only on dangerous text", () => {
    const { dir } = afkRepo();
    expect(guardToolUse('{"tool_input":{"command":"fly deploy"', dir, NOW).deny).toHaveLength(1);
    expect(guardToolUse("{not json bun test", dir, NOW).deny).toEqual([]);
  });

  test("bin/fbs-guard starts the CLI for a camp marker, an open fbs PR or a running afk run only", () => {
    const bin = tempDir();
    copyFileSync(join(import.meta.dir, "..", "bin", "fbs-guard"), join(bin, "fbs-guard"));
    writeFileSync(join(bin, "fbs"), "#!/bin/sh\ncat >/dev/null\necho called >&2\nexit 2\n");
    chmodSync(join(bin, "fbs"), 0o755);
    const hook = (cwd: string) => Bun.spawnSync([join(bin, "fbs-guard")], { stdin: Buffer.from(JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command: "x" } })), env: isolatedGitEnv(), stderr: "pipe" }).exitCode;
    expect(hook(repo())).toBe(0);
    expect(hook(afkRepo("stopped").dir)).toBe(0);
    expect(hook(afkRepo("landed").dir)).toBe(0);
    expect(hook(afkRepo().dir)).toBe(2);
    expect(hook(afkRepo("met").dir)).toBe(2);
    const camp = repo();
    mark(camp);
    expect(hook(camp)).toBe(2);
    const open = repo();
    prRecord(open, "x");
    expect(hook(open)).toBe(2);
    const landed = repo();
    prRecord(landed, "x", { landed: true });
    record(landed, "y");
    expect(hook(landed)).toBe(0);
  });

  test("bin/fbs-guard's open-PR grep matches the records the CLI writes: an open PR, not a cleared or landed one", () => {
    const bin = tempDir();
    copyFileSync(join(import.meta.dir, "..", "bin", "fbs-guard"), join(bin, "fbs-guard"));
    writeFileSync(join(bin, "fbs"), "#!/bin/sh\ncat >/dev/null\nexit 2\n");
    chmodSync(join(bin, "fbs"), 0o755);
    const dir = repo();
    const hook = () => Bun.spawnSync([join(bin, "fbs-guard")], { stdin: Buffer.from(JSON.stringify({ cwd: dir, tool_name: "Bash", tool_input: { command: "x" } })), env: isolatedGitEnv(), stderr: "pipe" }).exitCode;
    const fbs = (...args: string[]) => expect(run(args, { cwd: dir, today: "2026-10-25", out: () => {}, err: () => {} })).toBe(0);
    fbs("status", "init", "x", "--size", "tiny");
    expect(hook()).toBe(0);
    fbs("status", "pr", "x", "https://github.com/acme/app/pull/7");
    expect(hook()).toBe(2);
    updateFeature(dir, "x", (rec) => ({ ...rec, landed: { pr: 7, repo: "acme/app", commit: "c".repeat(40), at: "2026-10-25" } }));
    expect(hook()).toBe(0);
    fbs("status", "init", "y", "--size", "tiny");
    fbs("status", "pr", "y", "https://github.com/acme/app/pull/8");
    fbs("status", "pr", "y", "none");
    expect(hook()).toBe(0);
  });

  test("bin/fbs-guard --reply starts the CLI for a pending request, or a prompt that mentions landing with an fbs PR open, and never blocks the prompt", () => {
    const bin = tempDir();
    copyFileSync(join(import.meta.dir, "..", "bin", "fbs-guard"), join(bin, "fbs-guard"));
    writeFileSync(join(bin, "fbs"), "#!/bin/sh\ncat >/dev/null\necho called\nexit 3\n");
    chmodSync(join(bin, "fbs"), 0o755);
    const hook = (cwd: string, prompt: string) => Bun.spawnSync([join(bin, "fbs-guard"), "--reply"], { stdin: Buffer.from(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd, prompt })), env: isolatedGitEnv(), stdout: "pipe", stderr: "pipe" });
    const outcome = (cwd: string, prompt: string) => {
      const result = hook(cwd, prompt);
      return [result.exitCode, result.stdout.toString(), result.stderr.toString()];
    };
    const none = repo();
    record(none, "x");
    expect(outcome(none, "go ahead and merge it")).toEqual([0, "", ""]);
    const dir = repo();
    prRecord(dir, "x");
    expect(outcome(dir, "yes")).toEqual([0, "", ""]);
    expect(outcome(dir, "rename the button")).toEqual([0, "", ""]);
    for (const prompt of ["go ahead and merge it", "Land #7", "ship it"]) expect(outcome(dir, prompt)).toEqual([0, "called\n", ""]);
    for (const prompt of ["go ahead and amend it", "do the amendment", "Force-push it", "squash those commits", "rebase it onto main", "you can rewrite the history", "autosquash the fixups", "fold the fixups in", "push -f"]) expect(outcome(dir, prompt)).toEqual([0, "called\n", ""]);
    expect(outcome(none, "force push it")).toEqual([0, "", ""]);
    writePendingRequest(join(dir, ".git"), { slug: "x", pr: 7, tree: TREE, at: NOW, session: "s1" });
    expect(outcome(dir, "yes")).toEqual([0, "called\n", ""]);
    // A token outstanding: any prompt may be the one that drops it.
    const held = repo();
    record(held, "x");
    writeLandToken(join(held, ".git"), { slug: "x", at: NOW, tree: TREE, session: "s1" });
    expect(outcome(held, "rename the button")).toEqual([0, "called\n", ""]);
  });

  test("bin/fbs-guard checks a scheduled prompt that may ask to land in an fbs repo with no PR flow, and nothing else there", () => {
    const bin = tempDir();
    copyFileSync(join(import.meta.dir, "..", "bin", "fbs-guard"), join(bin, "fbs-guard"));
    writeFileSync(join(bin, "fbs"), "#!/bin/sh\ncat >/dev/null\nexit 2\n");
    chmodSync(join(bin, "fbs"), 0o755);
    const hook = (cwd: string, tool_name: string, tool_input: Record<string, unknown>) => Bun.spawnSync([join(bin, "fbs-guard")], { stdin: Buffer.from(JSON.stringify({ cwd, tool_name, tool_input })), env: isolatedGitEnv(), stderr: "pipe" }).exitCode;
    const dir = repo();
    record(dir, "x", false);
    expect(hook(dir, "CronCreate", { cron: "0 * * * *", prompt: "merge it when approved" })).toBe(2);
    expect(hook(dir, "Skill", { skill: "loop", args: "5m land it" })).toBe(2);
    expect(hook(dir, "CronCreate", { cron: "0 * * * *", prompt: "rebasing onto main, then force-push it" })).toBe(2);
    expect(hook(dir, "Skill", { skill: "loop", args: "10m squash those commits" })).toBe(2);
    expect(hook(dir, "CronCreate", { cron: "0 * * * *", prompt: "run the nightly report" })).toBe(0);
    expect(hook(dir, "Bash", { command: "git merge main" })).toBe(0);
    expect(hook(repo(), "CronCreate", { cron: "0 * * * *", prompt: "merge it when approved" })).toBe(0);
  });
});
