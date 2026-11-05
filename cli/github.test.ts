import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GhError, type GhResult, type GhRunner, ghReader, NotOnPrError, parseSnapshot, QueryError, replyToComment, repoName, resolveThread } from "./github";
import { isolatedGitEnv } from "./test-env";

// The reply body file is written inside the git dir, so gh calls run from a real repo.
const REPO = realpathSync(mkdtempSync(join(tmpdir(), "fbs-github-")));
Bun.spawnSync(["git", "init", "-q"], { cwd: REPO, env: isolatedGitEnv() });
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const HEAD = "c".repeat(40);
const author = (login: string, typename = "User") => ({ login, __typename: typename });

function graphqlPr(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          state: "OPEN",
          isDraft: true,
          mergeable: "MERGEABLE",
          mergeStateStatus: "BLOCKED",
          baseRefName: "main",
          headRefOid: HEAD,
          reviewDecision: null,
          reviews: {
            pageInfo: { hasPreviousPage: false },
            nodes: [
              { databaseId: 50, author: author("copilot-pull-request-reviewer", "Bot"), state: "COMMENTED", body: "Overview: looks fine", submittedAt: "2026-10-25T09:00:00Z", createdAt: "2026-10-25T09:00:00Z", updatedAt: "2026-10-25T09:00:00Z" },
              { databaseId: 51, author: author("ana"), state: "APPROVED", body: "", submittedAt: "2026-10-25T09:30:00Z", createdAt: "2026-10-25T09:30:00Z", updatedAt: "2026-10-25T09:30:00Z" },
              { databaseId: 52, author: author("me"), state: "PENDING", body: "draft", submittedAt: null, createdAt: "2026-10-25T09:40:00Z", updatedAt: "2026-10-25T09:40:00Z" },
            ],
          },
          reviewThreads: {
            pageInfo: { hasPreviousPage: false },
            nodes: [
              {
                id: "PRRT_1",
                isResolved: false,
                path: "src/a.ts",
                line: 12,
                comments: { pageInfo: { hasPreviousPage: false }, nodes: [{ databaseId: 100, author: author("ana"), body: "Why?", createdAt: "2026-10-25T10:00:00Z", updatedAt: "2026-10-25T10:05:00Z" }] },
              },
              { id: "PRRT_2", isResolved: true, path: "src/b.ts", line: null, comments: { pageInfo: { hasPreviousPage: false }, nodes: [{ databaseId: 101, author: null, body: "old", createdAt: "2026-10-24T10:00:00Z", updatedAt: "2026-10-24T10:00:00Z" }] } },
            ],
          },
          comments: { pageInfo: { hasPreviousPage: false }, nodes: [{ databaseId: 200, author: author("codex", "Bot"), body: "Bot summary", createdAt: "2026-10-25T08:00:00Z", updatedAt: "2026-10-25T08:00:00Z" }] },
          commits: {
            nodes: [
              {
                commit: {
                  oid: HEAD,
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: { hasNextPage: false },
                      nodes: [
                        { __typename: "CheckRun", databaseId: 9, name: "test", status: "IN_PROGRESS", conclusion: null, detailsUrl: "https://github.com/acme/app/actions/runs/77/job/9", checkSuite: { app: { slug: "github-actions" }, workflowRun: { databaseId: 77 } } },
                        { __typename: "CheckRun", databaseId: 10, name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://lint.example.com/10", checkSuite: { app: { slug: "some-ci" }, workflowRun: null } },
                        { __typename: "StatusContext", context: "deploy", state: "PENDING", createdAt: "2026-10-25T10:00:00Z", targetUrl: null },
                        { __typename: "StatusContext", context: "legacy", state: "SUCCESS", createdAt: "2026-10-25T10:01:00Z", targetUrl: "https://ci.example.com/1" },
                      ],
                    },
                  },
                },
              },
            ],
          },
          ...overrides,
        },
      },
    },
  };
}

describe("parseSnapshot", () => {
  test("turns the GraphQL answer into a snapshot", () => {
    const s = parseSnapshot(graphqlPr());
    expect(s).toMatchObject({ state: "OPEN", draft: true, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", baseRefName: "main", head: HEAD, reviewDecision: null });
    expect(s.reviews).toEqual([
      { author: "copilot-pull-request-reviewer", state: "COMMENTED", submittedAt: "2026-10-25T09:00:00Z" },
      { author: "ana", state: "APPROVED", submittedAt: "2026-10-25T09:30:00Z" },
    ]);
    expect(s.threads).toEqual([
      { id: "PRRT_1", isResolved: false, path: "src/a.ts", line: 12 },
      { id: "PRRT_2", isResolved: true, path: "src/b.ts", line: null },
    ]);
    expect(s.comments).toEqual([
      { id: 100, kind: "thread", threadId: "PRRT_1", author: "ana", bot: false, path: "src/a.ts", line: 12, body: "Why?", createdAt: "2026-10-25T10:00:00Z", updatedAt: "2026-10-25T10:05:00Z" },
      { id: 101, kind: "thread", threadId: "PRRT_2", author: "ghost", bot: false, path: "src/b.ts", line: null, body: "old", createdAt: "2026-10-24T10:00:00Z", updatedAt: "2026-10-24T10:00:00Z" },
      { id: 200, kind: "issue", threadId: null, author: "codex", bot: true, path: null, line: null, body: "Bot summary", createdAt: "2026-10-25T08:00:00Z", updatedAt: "2026-10-25T08:00:00Z" },
      { id: 50, kind: "review", threadId: null, author: "copilot-pull-request-reviewer", bot: true, path: null, line: null, body: "Overview: looks fine", createdAt: "2026-10-25T09:00:00Z", updatedAt: "2026-10-25T09:00:00Z" },
    ]);
    expect(s.checks).toEqual([
      { id: "run:9", name: "test", status: "IN_PROGRESS", conclusion: "", detailsUrl: "https://github.com/acme/app/actions/runs/77/job/9", runId: 77, rerunnable: true },
      { id: "run:10", name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://lint.example.com/10", runId: null, rerunnable: false },
      { id: "status:deploy:2026-10-25T10:00:00Z", name: "deploy", status: "PENDING", conclusion: "", detailsUrl: null, runId: null, rerunnable: false },
      { id: "status:legacy:2026-10-25T10:01:00Z", name: "legacy", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci.example.com/1", runId: null, rerunnable: false },
    ]);
  });

  test("the snapshot is not truncated when every list fits one page", () => {
    expect(parseSnapshot(graphqlPr()).truncated).toBe(false);
  });

  test("a list with more than one page marks the snapshot truncated", () => {
    const more = { hasPreviousPage: true };
    const pr = graphqlPr().data.repository.pullRequest;
    expect(parseSnapshot(graphqlPr({ comments: { ...pr.comments, pageInfo: more } })).truncated).toBe(true);
    expect(parseSnapshot(graphqlPr({ reviews: { ...pr.reviews, pageInfo: more } })).truncated).toBe(true);
    const thread = { ...pr.reviewThreads.nodes[0], comments: { ...pr.reviewThreads.nodes[0].comments, pageInfo: more } };
    expect(parseSnapshot(graphqlPr({ reviewThreads: { pageInfo: { hasPreviousPage: false }, nodes: [thread] } })).truncated).toBe(true);
    const commit = pr.commits.nodes[0].commit;
    const contexts = { ...commit.statusCheckRollup.contexts, pageInfo: { hasNextPage: true } };
    expect(parseSnapshot(graphqlPr({ commits: { nodes: [{ commit: { ...commit, statusCheckRollup: { contexts } } }] } })).truncated).toBe(true);
  });

  test("any author that isn't a User is a bot", () => {
    const pr = graphqlPr().data.repository.pullRequest;
    const node = (typename: string) => ({ ...pr.comments.nodes[0], author: author("x", typename) });
    const answer = graphqlPr({ comments: { pageInfo: { hasPreviousPage: false }, nodes: [node("Mannequin"), node("EnterpriseUserAccount"), node("User")] } });
    expect(parseSnapshot(answer).comments.filter((c) => c.kind === "issue").map((c) => c.bot)).toEqual([true, true, false]);
  });

  test("a head with no checks has an empty rollup", () => {
    expect(parseSnapshot(graphqlPr({ commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: null } }] } })).checks).toEqual([]);
  });

  test("an unexpected shape is a permanent gh error; a head that moved mid-read is worth a retry", () => {
    expect(() => parseSnapshot({ data: { repository: { pullRequest: null } } })).toThrow(GhError);
    expect(() => parseSnapshot(graphqlPr({ state: "DRAFT" }))).toThrow(GhError);
    expect(() => parseSnapshot(graphqlPr({ isDraft: "yes" }))).toThrow(GhError);
    expect(() => parseSnapshot(graphqlPr({ commits: { nodes: [{ commit: { oid: "d".repeat(40), statusCheckRollup: null } }] } }))).toThrow(QueryError);
  });
});

interface Call {
  args: string[];
  input: string | null;
}

/** A gh that answers by the first matching argument and records each call, with any --input file's content. */
function fakeGh(answers: [match: string, result: Partial<GhResult>][]): { gh: GhRunner; calls: Call[] } {
  const calls: Call[] = [];
  const gh: GhRunner = (args, cwd) => {
    expect(cwd).toBe(REPO);
    const inputAt = args.indexOf("--input");
    calls.push({ args, input: inputAt === -1 ? null : readFileSync(args[inputAt + 1], "utf8") });
    const answer = answers.find(([match]) => args.some((arg) => arg === match || arg.startsWith(match)));
    return { code: 0, stdout: "", stderr: "", ...(answer?.[1] ?? { code: 1, stderr: `unexpected gh ${args.join(" ")}` }) };
  };
  return { gh, calls };
}

const REPO_VIEW: [string, Partial<GhResult>] = ["nameWithOwner", { stdout: "acme/app\n" }];
const NOT_FOUND: Partial<GhResult> = { code: 1, stderr: "gh: Not Found (HTTP 404)\n" };
const BODY = "Fixed in abc123.\n$(rm -rf ~) `whoami` \"quotes\" 'single'";

describe("ghReader", () => {
  test("reads the recorded repo, passing it and the PR number as variables", () => {
    const { gh, calls } = fakeGh([["graphql", { stdout: JSON.stringify(graphqlPr()) }]]);
    expect(ghReader(gh, REPO, "acme/app").snapshot(7).head).toBe(HEAD);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(calls[0].args.slice(-6)).toEqual(["-f", "owner=acme", "-f", "repo=app", "-F", "pr=7"]);
  });

  test("a network or server failure is a query error worth retrying", () => {
    const { gh } = fakeGh([["graphql", { code: 1, stderr: "HTTP 502: Bad Gateway\n" }]]);
    expect(() => ghReader(gh, REPO, "acme/app").snapshot(7)).toThrow(QueryError);
  });

  test.each([
    [{ code: 127, stderr: "cannot run gh: ENOENT" }, "gh is missing"],
    [{ code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login\n" }, "not authenticated"],
    [{ code: 1, stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)\n" }, "not authenticated"],
    [{ code: 1, stderr: "GraphQL: Could not resolve to a PullRequest with the number of 7. (repository.pullRequest)\n" }, "not found"],
    [{ code: 1, stderr: "GraphQL: Could not resolve to a Repository with the name 'acme/app'. (repository)\n" }, "not found"],
  ])("a permanent failure %p is a gh error", (result, message) => {
    const { gh } = fakeGh([["graphql", result]]);
    expect(() => ghReader(gh, REPO, "acme/app").snapshot(7)).toThrow(new RegExp(message));
    expect(() => ghReader(gh, REPO, "acme/app").snapshot(7)).toThrow(GhError);
  });
});

describe("repoName", () => {
  test("asks gh which repo cwd is in", () => {
    const { gh, calls } = fakeGh([REPO_VIEW]);
    expect(repoName(gh, REPO)).toBe("acme/app");
    expect(calls[0].args).toEqual(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    const { gh: none } = fakeGh([["nameWithOwner", { code: 1, stderr: "no git remotes found\n" }]]);
    expect(() => repoName(none, REPO)).toThrow(GhError);
  });
});

const ON_PR_7 = "https://api.github.com/repos/acme/app/pulls/7";

describe("replyToComment", () => {
  test("replies to thread:<id> in its thread through --input, never with the body on the command line", () => {
    const { gh, calls } = fakeGh([
      ["repos/acme/app/pulls/comments/100", { stdout: JSON.stringify({ id: 100, pull_request_url: ON_PR_7 }) }],
      ["repos/acme/app/pulls/7/comments/100/replies", { stdout: JSON.stringify({ id: 300, updated_at: "2026-10-25T11:00:00Z", html_url: "https://github.com/x" }) }],
    ]);
    expect(replyToComment(gh, REPO, "acme/app", 7, { kind: "thread", id: 100 }, BODY)).toEqual({ kind: "thread", id: 300, updatedAt: "2026-10-25T11:00:00Z", url: "https://github.com/x" });
    expect(calls).toHaveLength(2);
    const post = calls[1];
    expect(post.args.slice(0, 5)).toEqual(["api", "--method", "POST", "repos/acme/app/pulls/7/comments/100/replies", "--input"]);
    expect(post.args).toHaveLength(6);
    expect(JSON.parse(post.input ?? "")).toEqual({ body: BODY });
    for (const call of calls) expect(call.args.join(" ")).not.toContain("Fixed in");
    expect(post.args[5].startsWith(join(REPO, ".git", "fbs"))).toBe(true);
    expect(existsSync(post.args[5])).toBe(false);
    expect(readdirSync(join(REPO, ".git", "fbs"))).toEqual([]);
  });

  test("a reply to a reply goes to the thread's first comment", () => {
    const { gh, calls } = fakeGh([
      ["repos/acme/app/pulls/comments/101", { stdout: JSON.stringify({ id: 101, in_reply_to_id: 100, pull_request_url: ON_PR_7 }) }],
      ["repos/acme/app/pulls/7/comments/100/replies", { stdout: JSON.stringify({ id: 301, updated_at: "2026-10-25T11:00:00Z" }) }],
    ]);
    expect(replyToComment(gh, REPO, "acme/app", 7, { kind: "thread", id: 101 }, "ok").id).toBe(301);
    expect(calls[1].args[3]).toBe("repos/acme/app/pulls/7/comments/100/replies");
  });

  test("issue:<id> goes straight to the issue comment and gets a PR comment quoting it", () => {
    const original = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6";
    const { gh, calls } = fakeGh([
      ["repos/acme/app/issues/comments/200", { stdout: JSON.stringify({ id: 200, body: original, html_url: "https://github.com/c/200", issue_url: "https://api.github.com/repos/acme/app/issues/7" }) }],
      ["repos/acme/app/issues/7/comments", { stdout: JSON.stringify({ id: 400, updated_at: "2026-10-25T12:00:00Z" }) }],
    ]);
    expect(replyToComment(gh, REPO, "acme/app", 7, { kind: "issue", id: 200 }, BODY)).toMatchObject({ kind: "issue", id: 400 });
    expect(calls.map((c) => c.args[c.args[1] === "--method" ? 3 : 1])).toEqual(["repos/acme/app/issues/comments/200", "repos/acme/app/issues/7/comments"]);
    expect(JSON.parse(calls[1].input ?? "").body).toBe(`In reply to https://github.com/c/200:\n> Line 1\n> Line 2\n> Line 3\n> Line 4\n> Line 5\n> …\n\n${BODY}`);
  });

  test("review:<id> goes straight to the review and gets a PR comment quoting it", () => {
    const { gh, calls } = fakeGh([
      ["repos/acme/app/pulls/7/reviews/50", { stdout: JSON.stringify({ id: 50, body: "Overview", html_url: "https://github.com/r/50" }) }],
      ["repos/acme/app/issues/7/comments", { stdout: JSON.stringify({ id: 401, updated_at: "2026-10-25T12:00:00Z" }) }],
    ]);
    expect(replyToComment(gh, REPO, "acme/app", 7, { kind: "review", id: 50 }, "Thanks")).toMatchObject({ kind: "issue", id: 401 });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].input ?? "").body).toBe("In reply to https://github.com/r/50:\n> Overview\n\nThanks");
  });

  test("a comment on another PR, or no such comment, is refused without posting", () => {
    const other = fakeGh([["repos/acme/app/pulls/comments/100", { stdout: JSON.stringify({ id: 100, pull_request_url: "https://api.github.com/repos/acme/app/pulls/70" }) }]]);
    expect(() => replyToComment(other.gh, REPO, "acme/app", 7, { kind: "thread", id: 100 }, "x")).toThrow(NotOnPrError);
    const none = fakeGh([["repos/acme/app/", NOT_FOUND]]);
    expect(() => replyToComment(none.gh, REPO, "acme/app", 7, { kind: "issue", id: 100 }, "x")).toThrow("no issue comment 100 on PR #7");
    for (const call of [...other.calls, ...none.calls]) expect(call.args).not.toContain("POST");
    expect(none.calls).toHaveLength(1);
  });

  test("a gh failure other than 404 is a gh error", () => {
    const { gh } = fakeGh([["repos/acme/app/pulls/comments/100", { code: 1, stderr: "HTTP 401: Bad credentials\n" }]]);
    expect(() => replyToComment(gh, REPO, "acme/app", 7, { kind: "thread", id: 100 }, "x")).toThrow(GhError);
  });
});

const threadOn = (number: number, nameWithOwner = "acme/app") => ({ stdout: JSON.stringify({ data: { node: { pullRequest: { number, repository: { nameWithOwner } } } } }) });

describe("resolveThread", () => {
  test("checks the thread is on the PR, then resolves it with the id as a raw-string variable", () => {
    const { gh, calls } = fakeGh([
      ["query=query", threadOn(7)],
      ["query=mutation", { stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }) }],
    ]);
    resolveThread(gh, REPO, "acme/app", 7, "PRRT_kwDOabc");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args.slice(0, 3)).toEqual(["api", "graphql", "-f"]);
      expect(call.args.slice(-2)).toEqual(["-f", "id=PRRT_kwDOabc"]);
      expect(call.args[3]).not.toContain("PRRT_kwDOabc");
    }
    expect(calls[1].args[3]).toContain("resolveReviewThread(input: { threadId: $id })");
  });

  test("a thread on another PR or repo, or no thread, is refused without resolving", () => {
    for (const answer of [threadOn(70), threadOn(7, "other/repo")]) {
      const other = fakeGh([["query=query", answer]]);
      expect(() => resolveThread(other.gh, REPO, "acme/app", 7, "PRRT_x")).toThrow(NotOnPrError);
      expect(other.calls).toHaveLength(1);
    }
    const none = fakeGh([["query=query", { code: 1, stderr: "GraphQL: Could not resolve to a node with the global id of 'x'\n" }]]);
    expect(() => resolveThread(none.gh, REPO, "acme/app", 7, "x")).toThrow(NotOnPrError);
  });
});
