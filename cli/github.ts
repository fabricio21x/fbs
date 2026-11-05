import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envWithoutRepoOverrides, gitCommonDir } from "./git";

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `gh <args>` in `cwd`; never through a shell. */
export type GhRunner = (args: string[], cwd: string) => GhResult;

let ghBinary = "gh";

/** Use this gh executable instead of resolving `gh` from PATH. */
export function setGhBinary(path: string): void {
  ghBinary = path;
}

const GH_TIMEOUT_MS = 120_000;

export const runGh: GhRunner = (args, cwd) => {
  try {
    const result = Bun.spawnSync([ghBinary, ...args], { cwd, env: envWithoutRepoOverrides(), stdout: "pipe", stderr: "pipe", timeout: GH_TIMEOUT_MS });
    return { code: result.exitCode ?? 1, stdout: result.stdout?.toString() ?? "", stderr: result.stderr?.toString() ?? "" };
  } catch (e) {
    return { code: 127, stdout: "", stderr: `cannot run gh: ${(e as Error).message}` };
  }
};

/** A gh failure worth retrying: network, rate limits, GitHub hiccups, a head that moved mid-read. */
export class QueryError extends Error {}

/** A gh failure retrying won't fix: no gh, not authenticated, no such repo or PR, an answer of the wrong shape. */
export class GhError extends Error {}

/** The comment or thread doesn't exist on this feature's PR. */
export class NotOnPrError extends Error {}

const PERMANENT_FAILURES: [RegExp, string][] = [
  [/not logged in|gh auth login|HTTP 401|Bad credentials|authentication required/i, "gh is not authenticated"],
  [/Could not resolve to a (Repository|PullRequest)|HTTP 404|Not Found/i, "repo or PR not found"],
];

/** The error for a failed gh call: permanent ones fail fast, the rest are retried. */
function ghFailure(result: GhResult, what: string): GhError | QueryError {
  const detail = firstLine(result.stderr) || `exit ${result.code}`;
  if (result.code === 127) return new GhError(`gh is missing: ${detail}`);
  const permanent = PERMANENT_FAILURES.find(([pattern]) => pattern.test(result.stderr));
  if (permanent) return new GhError(`${permanent[1]}: ${what}: ${detail}`);
  return new QueryError(`${what} failed: ${detail}`);
}

export type CommentKind = "thread" | "issue" | "review";

export interface Comment {
  /** The REST id (GraphQL databaseId); with `kind` it makes the key `fbs pr reply --comment` takes. */
  id: number;
  kind: CommentKind;
  threadId: string | null;
  author: string;
  bot: boolean;
  path: string | null;
  line: number | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Check {
  /** Unique per run, so a re-run is a new check and two checks may share a name. */
  id: string;
  name: string;
  status: string;
  /** "" while the check is not terminal. */
  conclusion: string;
  detailsUrl: string | null;
  /** The GitHub Actions workflow run; null for status contexts and other apps. */
  runId: number | null;
  /** True for a GitHub Actions check, which `gh run rerun <runId>` can re-run. */
  rerunnable: boolean;
}

export interface Review {
  author: string;
  state: string;
  submittedAt: string;
}

export interface Thread {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
}

export interface Snapshot {
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  baseRefName: string;
  head: string;
  reviewDecision: string | null;
  reviews: Review[];
  threads: Thread[];
  comments: Comment[];
  checks: Check[];
  /** Some list had more items than one page holds, so the snapshot may miss some. */
  truncated: boolean;
}

export interface GitHubReader {
  /** Throws QueryError when a retry may help, GhError when it won't. */
  snapshot(pr: number): Snapshot;
}

const AUTHOR = "author { login __typename }";
// `last:` lists keep the newest items, so older ones are what a full page leaves out.
const OLDER = "pageInfo { hasPreviousPage }";
const SNAPSHOT_QUERY = `query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      state isDraft mergeable mergeStateStatus baseRefName headRefOid reviewDecision
      reviews(last: 100) { ${OLDER} nodes { databaseId ${AUTHOR} state body submittedAt createdAt updatedAt } }
      reviewThreads(last: 100) { ${OLDER} nodes { id isResolved path line comments(last: 100) { ${OLDER} nodes { databaseId ${AUTHOR} body createdAt updatedAt } } } }
      comments(last: 100) { ${OLDER} nodes { databaseId ${AUTHOR} body createdAt updatedAt } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { pageInfo { hasNextPage } nodes {
        __typename
        ... on CheckRun { databaseId name status conclusion detailsUrl checkSuite { app { slug } workflowRun { databaseId } } }
        ... on StatusContext { context state createdAt targetUrl }
      } } } } } }
    }
  }
}`;

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isRepoName(name: string): boolean {
  return REPO_NAME.test(name);
}

/** `owner/name` of the repo gh targets from `cwd`. */
export function repoName(gh: GhRunner, cwd: string): string {
  const result = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd);
  const name = result.stdout.trim();
  if (result.code !== 0 || !isRepoName(name)) throw new GhError(`cannot tell the GitHub repo: ${firstLine(result.stderr) || name}`);
  return name;
}

/** Reads `pr` of `repo` (`owner/name`). */
export function ghReader(gh: GhRunner, cwd: string, repo: string): GitHubReader {
  const [owner, name] = repo.split("/");
  return {
    snapshot(pr) {
      const result = gh(["api", "graphql", "-f", `query=${SNAPSHOT_QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${name}`, "-F", `pr=${pr}`], cwd);
      if (result.code !== 0) throw ghFailure(result, "gh api graphql");
      let raw: unknown;
      try {
        raw = JSON.parse(result.stdout);
      } catch {
        throw new QueryError("gh api graphql printed invalid JSON");
      }
      return parseSnapshot(raw);
    },
  };
}

/** Validate the GraphQL answer once, here, and hand out plain typed data. */
export function parseSnapshot(raw: unknown): Snapshot {
  const pr = field(field(field(raw, "data"), "repository"), "pullRequest");
  const state = str(pr, "state");
  if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") fail(`unexpected PR state ${state}`);
  const head = str(pr, "headRefOid");
  const commit = field(nodes(field(pr, "commits"))[0] ?? fail("no commits"), "commit");
  if (str(commit, "oid") !== head) throw new QueryError("the head moved while reading the PR");
  const rollup = field(commit, "statusCheckRollup", true);
  const contexts = rollup === null ? null : field(rollup, "contexts");

  const reviews = field(pr, "reviews");
  const reviewThreads = field(pr, "reviewThreads");
  const issueComments = field(pr, "comments");
  const threadNodes = nodes(reviewThreads);
  const threads: Thread[] = threadNodes.map((t) => ({ id: str(t, "id"), isResolved: bool(t, "isResolved"), path: optStr(t, "path"), line: optInt(t, "line") }));
  const submitted = nodes(reviews).filter((r) => str(r, "state") !== "PENDING");
  const truncated =
    [reviews, reviewThreads, issueComments, ...threadNodes.map((t) => field(t, "comments"))].some((list) => bool(field(list, "pageInfo"), "hasPreviousPage")) ||
    (contexts !== null && bool(field(contexts, "pageInfo"), "hasNextPage"));
  return {
    state,
    draft: bool(pr, "isDraft"),
    mergeable: str(pr, "mergeable"),
    mergeStateStatus: str(pr, "mergeStateStatus"),
    baseRefName: str(pr, "baseRefName"),
    head,
    reviewDecision: optStr(pr, "reviewDecision"),
    reviews: submitted.map((r) => ({ author: author(r).login, state: str(r, "state"), submittedAt: optStr(r, "submittedAt") ?? str(r, "createdAt") })),
    threads,
    comments: [
      ...threadNodes.flatMap((t, i) => nodes(field(t, "comments")).map((c) => comment(c, "thread", threads[i]))),
      ...nodes(issueComments).map((c) => comment(c, "issue", null)),
      ...submitted.filter((r) => str(r, "body").trim() !== "").map((r) => comment(r, "review", null)),
    ],
    checks: contexts === null ? [] : nodes(contexts).flatMap(check),
    truncated,
  };
}

function comment(c: Record<string, unknown>, kind: CommentKind, thread: Thread | null): Comment {
  const who = author(c);
  return {
    id: int(c, "databaseId"),
    kind,
    threadId: thread?.id ?? null,
    author: who.login,
    bot: who.bot,
    path: thread?.path ?? null,
    line: thread?.line ?? null,
    body: str(c, "body"),
    createdAt: str(c, "createdAt"),
    updatedAt: str(c, "updatedAt"),
  };
}

// A deleted account comes back as a null author; Bot, Mannequin and app authors are not people.
function author(c: Record<string, unknown>): { login: string; bot: boolean } {
  const who = field(c, "author", true);
  if (who === null) return { login: "ghost", bot: false };
  return { login: str(who, "login"), bot: who.__typename !== "User" };
}

function check(node: Record<string, unknown>): Check[] {
  if (node.__typename === "CheckRun") {
    const suite = isObject(node.checkSuite) ? node.checkSuite : {};
    const run = isObject(suite.workflowRun) ? optInt(suite.workflowRun, "databaseId") : null;
    const actions = isObject(suite.app) && suite.app.slug === "github-actions" && run !== null;
    return [
      {
        id: `run:${int(node, "databaseId")}`,
        name: str(node, "name"),
        status: str(node, "status"),
        conclusion: optStr(node, "conclusion") ?? "",
        detailsUrl: optStr(node, "detailsUrl"),
        runId: actions ? run : null,
        rerunnable: actions,
      },
    ];
  }
  if (node.__typename === "StatusContext") {
    const name = str(node, "context");
    const state = str(node, "state");
    const pending = state === "PENDING" || state === "EXPECTED";
    return [
      {
        id: `status:${name}:${str(node, "createdAt")}`,
        name,
        status: pending ? "PENDING" : "COMPLETED",
        conclusion: pending ? "" : state,
        detailsUrl: optStr(node, "targetUrl"),
        runId: null,
        rerunnable: false,
      },
    ];
  }
  return [];
}

function fail(message: string): never {
  throw new GhError(`unexpected gh output: ${message}`);
}

function field(value: unknown, key: string): Record<string, unknown>;
function field(value: unknown, key: string, nullable: true): Record<string, unknown> | null;
function field(value: unknown, key: string, nullable = false): Record<string, unknown> | null {
  const inner = isObject(value) ? value[key] : undefined;
  if (inner === null && nullable) return null;
  return isObject(inner) ? inner : fail(`${key} is not an object`);
}

function nodes(connection: Record<string, unknown>): Record<string, unknown>[] {
  const list = connection.nodes;
  if (!Array.isArray(list) || !list.every(isObject)) return fail("nodes is not a list of objects");
  return list;
}

function str(o: Record<string, unknown>, key: string): string {
  return typeof o[key] === "string" ? (o[key] as string) : fail(`${key} is not a string`);
}

function optStr(o: Record<string, unknown>, key: string): string | null {
  return o[key] === null || o[key] === undefined ? null : str(o, key);
}

function int(o: Record<string, unknown>, key: string): number {
  return Number.isInteger(o[key]) ? (o[key] as number) : fail(`${key} is not an integer`);
}

function optInt(o: Record<string, unknown>, key: string): number | null {
  return o[key] === null || o[key] === undefined ? null : int(o, key);
}

function bool(o: Record<string, unknown>, key: string): boolean {
  return typeof o[key] === "boolean" ? (o[key] as boolean) : fail(`${key} is not a boolean`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

export interface Posted {
  kind: CommentKind;
  /** The comment that was created. */
  id: number;
  updatedAt: string;
  url: string;
}

const QUOTED_LINES = 5;

/** What `fbs pr reply --comment` names: a REST id, or for a review thread a GraphQL node id (a thread's or one of its comments'). */
export type CommentKey = { kind: CommentKind; id: number } | { kind: "thread"; nodeId: string };

export const COMMENT_KEY_FORMS = "thread:<id>, thread:<node id> (PRRT_… or PRRC_…), issue:<id> or review:<id>";

export function parseCommentKey(key: string): CommentKey | null {
  const match = /^(thread|issue|review):(?:([1-9][0-9]*)|([A-Za-z][A-Za-z0-9_=-]*))$/.exec(key);
  if (match === null) return null;
  const kind = match[1] as CommentKind;
  if (match[2] !== undefined) return { kind, id: Number(match[2]) };
  return kind === "thread" ? { kind, nodeId: match[3] } : null;
}

/** Reply to the comment `key` names on `pr`: in its thread for a review comment, else as a PR comment quoting it. */
export function replyToComment(gh: GhRunner, cwd: string, repo: string, pr: number, target: CommentKey, body: string): Posted {
  if ("nodeId" in target) return replyByNodeId(gh, cwd, repo, pr, target.nodeId, body);
  const notOnPr = () => new NotOnPrError(`no ${target.kind} comment ${target.id} on PR #${pr}`);
  if (target.kind === "thread") {
    const original = get(gh, cwd, `repos/${repo}/pulls/comments/${target.id}`);
    if (original === null || !String(original.pull_request_url).endsWith(`/pulls/${pr}`)) throw notOnPr();
    // GitHub only takes replies to the thread's first comment.
    const first = Number.isInteger(original.in_reply_to_id) ? original.in_reply_to_id : target.id;
    return posted("thread", post(gh, cwd, `repos/${repo}/pulls/${pr}/comments/${first}/replies`, body));
  }
  const path = target.kind === "issue" ? `repos/${repo}/issues/comments/${target.id}` : `repos/${repo}/pulls/${pr}/reviews/${target.id}`;
  const original = get(gh, cwd, path);
  if (original === null || (target.kind === "issue" && !String(original.issue_url).endsWith(`/issues/${pr}`))) throw notOnPr();
  return posted("issue", post(gh, cwd, `repos/${repo}/issues/${pr}/comments`, quoting(original, body)));
}

function quoting(original: Record<string, unknown>, body: string): string {
  const lines = String(original.body ?? "").trim().split("\n");
  const quoted = lines.slice(0, QUOTED_LINES).map((line) => `> ${line}`.trimEnd());
  if (lines.length > QUOTED_LINES) quoted.push("> …");
  return [`In reply to ${String(original.html_url ?? "")}:`, ...quoted, "", body].join("\n");
}

/** GET a REST resource; null on 404. */
function get(gh: GhRunner, cwd: string, path: string): Record<string, unknown> | null {
  const result = gh(["api", path], cwd);
  if (result.code !== 0 && result.stderr.includes("HTTP 404")) return null;
  if (result.code !== 0) throw new GhError(`gh api ${path} failed: ${firstLine(result.stderr)}`);
  return parseObject(result.stdout, path);
}

function post(gh: GhRunner, cwd: string, path: string, body: string): Record<string, unknown> {
  return apiWithInput(gh, cwd, ["--method", "POST", path], { body }, path);
}

// The payload travels in a JSON file, never on a command line; it sits in the git dir because a sandbox may block the system temp dir.
function apiWithInput(gh: GhRunner, cwd: string, args: string[], payload: object, what: string): Record<string, unknown> {
  const parent = join(gitCommonDir(cwd), "fbs");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "gh-"));
  try {
    const input = join(dir, "body.json");
    writeFileSync(input, JSON.stringify(payload));
    const result = gh(["api", ...args, "--input", input], cwd);
    if (result.code !== 0) throw new GhError(`gh api ${what} failed: ${firstLine(result.stderr)}`);
    return parseObject(result.stdout, what);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function posted(kind: CommentKind, response: Record<string, unknown>): Posted {
  const { id, updated_at, html_url } = response;
  if (!Number.isInteger(id) || typeof updated_at !== "string") throw new GhError("gh api answered without the new comment's id and updated_at");
  return { kind, id: id as number, updatedAt: updated_at, url: String(html_url ?? "") };
}

function parseObject(text: string, what: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    if (isObject(value)) return value;
  } catch {}
  throw new GhError(`gh api ${what} printed something other than a JSON object`);
}

const THREAD_QUERY = "query($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } } } }";
const REPLY_TARGET_QUERY = `query($id: ID!) { node(id: $id) { __typename
  ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } }
  ... on PullRequestReviewComment { databaseId pullRequest { number repository { nameWithOwner } } } } }`;
const REPLY_MUTATION = `mutation($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { databaseId updatedAt url } } }`;
const RESOLVE_MUTATION = "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }";

/** Resolve a review thread of `pr` in `repo`; the id goes as a raw-string variable, never into the query text. */
export function resolveThread(gh: GhRunner, cwd: string, repo: string, pr: number, threadId: string): void {
  const answer = graphql(gh, cwd, THREAD_QUERY, threadId);
  const owner = isObject(answer.data) && isObject(answer.data.node) && isObject(answer.data.node.pullRequest) ? answer.data.node.pullRequest : {};
  const ownerRepo = isObject(owner.repository) ? owner.repository.nameWithOwner : null;
  if (owner.number !== pr || ownerRepo !== repo) throw new NotOnPrError(`thread ${threadId} is not a review thread on PR #${pr}`);
  graphql(gh, cwd, RESOLVE_MUTATION, threadId);
}

function graphql(gh: GhRunner, cwd: string, query: string, id: string): Record<string, unknown> {
  const result = gh(["api", "graphql", "-f", `query=${query}`, "-f", `id=${id}`], cwd);
  if (result.code !== 0) {
    if (result.stderr.includes("Could not resolve to a node")) throw new NotOnPrError(`no review ${id.startsWith("PRRC_") ? "comment" : "thread"} ${id}`);
    throw new GhError(`gh api graphql failed: ${firstLine(result.stderr)}`);
  }
  return parseObject(result.stdout, "graphql");
}

/** Reply by node id: in the thread itself for a thread's id, through the REST reply path for a review comment's. */
function replyByNodeId(gh: GhRunner, cwd: string, repo: string, pr: number, nodeId: string, body: string): Posted {
  const answer = graphql(gh, cwd, REPLY_TARGET_QUERY, nodeId);
  const node = isObject(answer.data) && isObject(answer.data.node) ? answer.data.node : {};
  const owner = isObject(node.pullRequest) ? node.pullRequest : {};
  const ownerRepo = isObject(owner.repository) ? owner.repository.nameWithOwner : null;
  const onPr = owner.number === pr && ownerRepo === repo;
  if (onPr && node.__typename === "PullRequestReviewComment") {
    if (!Number.isInteger(node.databaseId)) throw new GhError(`gh api graphql answered without review comment ${nodeId}'s databaseId`);
    return replyToComment(gh, cwd, repo, pr, { kind: "thread", id: node.databaseId as number }, body);
  }
  if (!onPr || node.__typename !== "PullRequestReviewThread") throw new NotOnPrError(`${nodeId} is not a review thread or review comment on PR #${pr}`);
  const reply = apiWithInput(gh, cwd, ["graphql"], { query: REPLY_MUTATION, variables: { id: nodeId, body } }, "graphql");
  const added = isObject(reply.data) && isObject(reply.data.addPullRequestReviewThreadReply) ? reply.data.addPullRequestReviewThreadReply : {};
  const created = isObject(added.comment) ? added.comment : {};
  if (!Number.isInteger(created.databaseId) || typeof created.updatedAt !== "string") throw new GhError("gh api graphql answered without the new comment's databaseId and updatedAt");
  return { kind: "thread", id: created.databaseId as number, updatedAt: created.updatedAt, url: String(created.url ?? "") };
}
