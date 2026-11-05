import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REAL_AFK_DEPS } from "./afk";
import type { GhResult, GhRunner } from "./github";
import { afkRunsIn, campMarkerPath, freshToken, guardPrompt, guardToolUse, landRequestPath, landTokenPath, TOKEN_TTL_MS, writeLandToken } from "./guard";
import { land, LandRefusedError, requestLand } from "./land";
import { type PrDeps, run } from "./main";
import { type OverCheck, readFeature } from "./status";
import { isolatedGitEnv } from "./test-env";

const NOW = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const identity = ["-c", "user.name=fbs", "-c", "user.email=fbs@example.com", "-c", "commit.gpgsign=false"];
  const result = Bun.spawnSync(["git", ...identity, ...args], { cwd, env: isolatedGitEnv(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fbs-land-")));
  dirs.push(dir);
  return dir;
}

interface Setup {
  work: string;
  head: string;
  tree: string;
}

/** An origin with a pushed feature branch, a clone with the feature's record stamped at that tree, a camp marker and a fresh token. */
function setup(options: { stampTree?: string; token?: boolean; tokenTree?: string; over?: OverCheck[] } = {}): Setup {
  const origin = tempDir();
  git(origin, "init", "-q", "-b", "main");
  git(origin, "commit", "-q", "--allow-empty", "-m", "init");
  git(origin, "checkout", "-q", "-b", "feat");
  writeFileSync(join(origin, "a.txt"), "feature\n");
  git(origin, "add", "a.txt");
  git(origin, "commit", "-q", "-m", "feat");
  const head = git(origin, "rev-parse", "HEAD");
  const tree = git(origin, "rev-parse", "HEAD^{tree}");
  git(origin, "checkout", "-q", "main");

  const work = join(tempDir(), "work");
  git(dirname(work), "clone", "-q", origin, work);
  const common = join(work, ".git");
  const record = {
    slug: "x",
    dir: "docs/features/2026-10-21-x",
    size: "tiny",
    approvals: {},
    pr: 7,
    repo: "acme/app",
    stamp: { tree: options.stampTree ?? tree, at: "2026-10-25", verdict: "pass", criteria: 1, evidence: "docs/features/2026-10-21-x/verdict.md" },
  };
  mkdirSync(join(common, "fbs", "features"), { recursive: true });
  writeFileSync(join(common, "fbs", "features", "x.json"), JSON.stringify(record));
  mkdirSync(dirname(campMarkerPath(common, "x")), { recursive: true });
  writeFileSync(campMarkerPath(common, "x"), "");
  if (options.token !== false) writeLandToken(common, { slug: "x", at: NOW - 60_000, tree: options.tokenTree ?? options.stampTree ?? tree, ...(options.over && { over: options.over }) });
  return { work, head, tree };
}

interface PrView {
  state?: string;
  isDraft?: boolean;
  mergeStateStatus?: string;
  baseRefName?: string;
  title?: string;
  reviewDecision?: string;
  author?: string;
  statusCheckRollup?: unknown[];
}

const GREEN = [
  { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "StatusContext", context: "deploy", state: "SUCCESS" },
];

/** A gh that answers land's calls and records them. */
function fakeGh(s: Setup, view: PrView = {}, extra: { protection?: Partial<GhResult>; merge?: Partial<GhResult>; after?: unknown; viewer?: string; admin?: string; branchProtection?: unknown; rules?: unknown[] } = {}) {
  const calls: string[][] = [];
  const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: "" });
  const gh: GhRunner = (args) => {
    calls.push(args);
    const line = args.join(" ");
    if (line.startsWith("pr view 7 --repo acme/app --json state,isDraft")) {
      return ok(
        JSON.stringify({
          state: "OPEN",
          isDraft: false,
          mergeStateStatus: "CLEAN",
          headRefOid: s.head,
          headRefName: "feat",
          baseRefName: "main",
          title: "feat(booking): sync the booking window",
          reviewDecision: "APPROVED",
          author: { login: "alex" },
          statusCheckRollup: GREEN,
          ...view,
          ...(view.author !== undefined && { author: { login: view.author } }),
        }),
      );
    }
    if (line.startsWith("repo view acme/app")) return ok("main\n");
    if (line.includes("protection/required_pull_request_reviews")) return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)", ...extra.protection };
    if (line === "api user --jq .login") return ok(`${extra.viewer ?? "alex"}\n`);
    if (line === "api repos/acme/app --jq .permissions.admin") return ok(`${extra.admin ?? "false"}\n`);
    if (line === "api repos/acme/app/branches/main/protection") {
      return extra.branchProtection === undefined ? { code: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" } : ok(JSON.stringify(extra.branchProtection));
    }
    if (line === "api repos/acme/app/rules/branches/main") return ok(JSON.stringify(extra.rules ?? []));
    if (line.startsWith("pr merge")) return { code: 0, stdout: "", stderr: "", ...extra.merge };
    if (line.startsWith("pr view 7 --repo acme/app --json state,mergeCommit")) return ok(JSON.stringify(extra.after ?? { state: "MERGED", mergeCommit: { oid: "f".repeat(40) } }));
    return { code: 1, stdout: "", stderr: `unexpected gh ${line}` };
  };
  return { gh, calls };
}

function refusals(s: { work: string }, slug: string, gh: GhRunner): string[] {
  try {
    land(s.work, slug, gh, NOW, "2026-10-25");
  } catch (e) {
    if (e instanceof LandRefusedError) return e.reasons;
    throw e;
  }
  throw new Error("land did not refuse");
}

describe("land", () => {
  test("merges an approved, green PR whose head tree is the stamped tree, then clears the token and marker", () => {
    const s = setup();
    const { gh, calls } = fakeGh(s);
    expect(land(s.work, "x", gh, NOW, "2026-10-25")).toEqual({ pr: 7, mergeCommit: "f".repeat(40) });
    expect(readFeature(s.work, "x").landed).toEqual({ pr: 7, repo: "acme/app", commit: "f".repeat(40), at: "2026-10-25", head: s.head });
    expect(readFeature(s.work, "x").pr).toBe(7);
    expect(calls).toContainEqual(["pr", "merge", "7", "--repo", "acme/app", "--squash", "--subject", "feat(booking): sync the booking window (#7)", "--match-head-commit", s.head]);
    for (const call of calls) expect(call).not.toContain("--admin");
    for (const call of calls) expect(call).not.toContain("--auto");
    const common = join(s.work, ".git");
    expect(existsSync(landTokenPath(common, "x"))).toBe(false);
    expect(existsSync(campMarkerPath(common, "x"))).toBe(false);
  });

  test("landing marks the slug's met afk run landed, which switches its guard off", () => {
    const s = setup();
    const common = join(s.work, ".git");
    const dir = join(common, "fbs", "afk", "x");
    mkdirSync(dir, { recursive: true });
    const record = { slug: "x", status: "met", sessionId: null, checks: [], budgets: { checkTimeoutSec: 600 }, worktree: s.work, branch: "feat", iteration: 3, kept: { sha: s.head, results: [], met: true } };
    writeFileSync(join(dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
    writeFileSync(join(dir, "log.tsv"), "ts\tkind\titeration\tsha\tresults\tdecision\tcost\tnote\n");
    expect(afkRunsIn(common, ["running", "met"]).map((r) => r.slug)).toEqual(["x"]);
    land(s.work, "x", fakeGh(s).gh, NOW, "2026-10-25");
    expect(afkRunsIn(common, ["running", "met"])).toEqual([]);
    expect(readFileSync(join(dir, "run.json"), "utf8")).toContain('"status": "landed"');
    expect(readFileSync(join(dir, "log.tsv"), "utf8")).toContain("\tlanded\t\tPR #7 merged");
  });

  test("a check run again on the same head counts by its newest run", () => {
    const run = (conclusion: string, startedAt: string, status = "COMPLETED") => ({ __typename: "CheckRun", name: "e2e", workflowName: "CI", status, conclusion, startedAt });
    const superseded = setup();
    const cancelledThenPassed = [run("CANCELLED", "2026-11-04T14:07:36Z"), run("SUCCESS", "2026-11-04T14:09:11Z")];
    expect(land(superseded.work, "x", fakeGh(superseded, { statusCheckRollup: cancelledThenPassed }).gh, NOW, "2026-10-25").pr).toBe(7);
    const regressed = setup();
    expect(refusals(regressed, "x", fakeGh(regressed, { statusCheckRollup: [run("FAILURE", "2026-11-04T14:09:11Z"), run("SUCCESS", "2026-11-04T14:07:36Z")] }).gh)).toEqual(["checks not passed: CI / e2e"]);
    const queued = setup();
    expect(refusals(queued, "x", fakeGh(queued, { statusCheckRollup: [run("SUCCESS", "2026-11-04T14:07:36Z"), run("", "0001-01-01T00:00:00Z", "QUEUED")] }).gh)).toEqual(["checks not passed: CI / e2e"]);
  });

  test("a solo repo with no review requirement lands the user's own PR on their /fbs:land", () => {
    const s = setup();
    expect(land(s.work, "x", fakeGh(s, { reviewDecision: "" }).gh, NOW, "2026-10-25").pr).toBe(7);
  });

  test.each([
    ["no token", { token: false }, {}, {}, "no fresh land token"],
    ["a stale token", {}, {}, {}, "no fresh land token"],
    ["a closed PR", {}, { state: "CLOSED" }, {}, "PR #7 is closed"],
    ["a draft", {}, { isDraft: true }, {}, "PR #7 is a draft"],
    ["a failed check", {}, { statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" }] }, {}, "checks not passed: test"],
    ["a pending check", {}, { statusCheckRollup: [{ __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: "" }] }, {}, "checks not passed: e2e"],
    ["a pending status", {}, { statusCheckRollup: [{ __typename: "StatusContext", context: "ci/legacy", state: "PENDING" }] }, {}, "checks not passed: ci/legacy"],
    ["a blocked merge state", {}, { mergeStateStatus: "BLOCKED" }, {}, "merge state is BLOCKED"],
    ["an unstable merge state", {}, { mergeStateStatus: "UNSTABLE" }, {}, "merge state is UNSTABLE"],
    ["another base", {}, { baseRefName: "release" }, {}, "based on release, not the default branch main"],
    ["changes requested", {}, { reviewDecision: "CHANGES_REQUESTED" }, {}, "review decision is CHANGES_REQUESTED"],
    ["required reviews", {}, { reviewDecision: "" }, { protection: { code: 0, stdout: "1\n" } }, "requires 1 approving review"],
    ["someone else's PR", {}, { reviewDecision: "", author: "ana" }, {}, "is by ana, not alex"],
    ["a stale stamp", { stampTree: "0".repeat(40) }, {}, {}, "is not the stamped tree"],
    ["a re-stamp after /fbs:land", { tokenTree: "0".repeat(40) }, {}, {}, "stamped again after the user typed /fbs:land"],
    ["no registered checks", {}, { statusCheckRollup: [] }, {}, "no checks registered on the head of PR #7"],
  ])("refuses %p", (_, options, view, extra, reason) => {
    const s = setup(options as { token?: boolean; stampTree?: string });
    const now = _ === "a stale token" ? NOW + TOKEN_TTL_MS : NOW;
    const { gh, calls } = fakeGh(s, view as PrView, extra);
    let reasons: string[] = [];
    try {
      land(s.work, "x", gh, now, "2026-10-25");
    } catch (e) {
      if (!(e instanceof LandRefusedError)) throw e;
      reasons = e.reasons;
    }
    expect(reasons.join("\n")).toContain(reason);
    expect(calls.some((c) => c[1] === "merge")).toBe(false);
    expect(existsSync(campMarkerPath(join(s.work, ".git"), "x"))).toBe(true);
    expect(existsSync(landTokenPath(join(s.work, ".git"), "x"))).toBe(false);
  });

  test("a refused merge, or a PR not merged afterwards, is refused", () => {
    const s = setup();
    expect(refusals(s, "x", fakeGh(s, {}, { merge: { code: 1, stderr: "Head branch was modified" } }).gh)).toEqual(["gh pr merge failed: Head branch was modified"]);
    const t = setup();
    expect(refusals(t, "x", fakeGh(t, {}, { after: { state: "OPEN", mergeCommit: null } }).gh)).toEqual(["PR #7 is open after gh pr merge, not merged"]);
  });

  test("the token is single-use: a second attempt after a refusal has none", () => {
    const s = setup();
    expect(refusals(s, "x", fakeGh(s, { isDraft: true }).gh)).toContain("PR #7 is a draft");
    expect(refusals(s, "x", fakeGh(s).gh)).toEqual(["no fresh land token for x: the user types /fbs:land x"]);
  });

  test("no token refuses without asking GitHub", () => {
    const s = setup({ token: false });
    const { gh, calls } = fakeGh(s);
    expect(refusals(s, "x", gh)).toEqual(["no fresh land token for x: the user types /fbs:land x"]);
    expect(calls).toEqual([]);
  });
});

describe("landing over failing checks the user confirmed", () => {
  const RED = [
    { __typename: "CheckRun", name: "test", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "e2e", workflowName: "CI", status: "COMPLETED", conclusion: "CANCELLED" },
    { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
  ];
  const OVER: OverCheck[] = [
    { name: "e2e", workflow: "CI", state: "cancelled" },
    { name: "ci/legacy", state: "failed" },
  ];
  const DEPLOY: OverCheck = { name: "deploy", state: "missing" };
  const requires = (...contexts: string[]) => ({ required_status_checks: { contexts, checks: contexts.map((context) => ({ context, app_id: null })) } });
  const posts = (calls: string[][]) => calls.filter((c) => ["comment", "review"].includes(c[1]) || (c[0] === "api" && c.some((a) => a === "POST" || a.startsWith("-f") || a.startsWith("--field"))));
  const mergeCall = (s: Setup, ...flags: string[]) => ["pr", "merge", "7", "--repo", "acme/app", "--squash", ...flags, "--subject", "feat(booking): sync the booking window (#7)", "--match-head-commit", s.head];

  test("ignores the confirmed failing checks, accepts UNSTABLE, records over and posts nothing", () => {
    const s = setup({ over: OVER });
    const { gh, calls } = fakeGh(s, { statusCheckRollup: RED, mergeStateStatus: "UNSTABLE" });
    expect(land(s.work, "x", gh, NOW, "2026-10-25")).toEqual({ pr: 7, mergeCommit: "f".repeat(40) });
    expect(calls).toContainEqual(mergeCall(s));
    expect(calls.some((c) => c.includes("--admin") || c.some((a) => a.startsWith("repos/acme/app")))).toBe(false);
    expect(posts(calls)).toEqual([]);
    expect(readFeature(s.work, "x").landed).toEqual({ pr: 7, repo: "acme/app", commit: "f".repeat(40), at: "2026-10-25", head: s.head, over: OVER });
  });

  test("refuses a failure the user didn't confirm, and a check still running", () => {
    const s = setup({ over: [OVER[0]] });
    const late = [...RED, { __typename: "CheckRun", name: "lint", workflowName: "CI", status: "IN_PROGRESS", conclusion: "" }];
    const { gh, calls } = fakeGh(s, { statusCheckRollup: late, mergeStateStatus: "UNSTABLE" });
    expect(refusals(s, "x", gh)).toEqual(["checks not passed: CI / lint", "ci/legacy failed and isn't in the list the user confirmed; request again"]);
    expect(calls.some((c) => c[1] === "merge")).toBe(false);
  });

  test("a same-named check failing in another workflow isn't covered", () => {
    const s = setup({ over: OVER });
    const twins = [...RED, { __typename: "CheckRun", name: "e2e", workflowName: "Nightly", status: "COMPLETED", conclusion: "FAILURE" }];
    expect(refusals(s, "x", fakeGh(s, { statusCheckRollup: twins, mergeStateStatus: "UNSTABLE" }).gh)).toEqual(["Nightly / e2e failed and isn't in the list the user confirmed; request again"]);
  });

  test("on BLOCKED merges with --admin for a repo admin when every required check passed or was confirmed, a missing one included", () => {
    const s = setup({ over: [...OVER, DEPLOY] });
    const { gh, calls } = fakeGh(s, { statusCheckRollup: RED, mergeStateStatus: "BLOCKED" }, { admin: "true", branchProtection: requires("test", "e2e", "deploy") });
    expect(land(s.work, "x", gh, NOW, "2026-10-25").pr).toBe(7);
    expect(calls).toContainEqual(mergeCall(s, "--admin"));
    expect(posts(calls)).toEqual([]);
    expect(readFeature(s.work, "x").landed?.over).toEqual([...OVER, DEPLOY]);
  });

  test("on BLOCKED refuses --admin past a required check that didn't run unconfirmed, or a rule fbs never overrides", () => {
    const blocked = (over: OverCheck[], extra: Parameters<typeof fakeGh>[2]) => {
      const s = setup({ over });
      const { gh, calls } = fakeGh(s, { statusCheckRollup: RED, mergeStateStatus: "BLOCKED" }, { admin: "true", ...extra });
      const reasons = refusals(s, "x", gh);
      expect(calls.some((c) => c[1] === "merge")).toBe(false);
      return reasons;
    };
    expect(blocked(OVER, { branchProtection: requires("test", "deploy") })).toEqual(["required check deploy didn't run and isn't in the list the user confirmed; request again"]);
    expect(blocked(OVER, { rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "deploy" }] } }] })).toEqual([
      "required check deploy didn't run and isn't in the list the user confirmed; request again",
    ]);
    expect(blocked(OVER, { branchProtection: { ...requires("test"), required_conversation_resolution: { enabled: true }, lock_branch: { enabled: false }, restrictions: { users: [] } } })).toEqual([
      "main's branch protection has required_conversation_resolution on, which fbs doesn't merge past with --admin",
      "main's branch protection has restrictions on, which fbs doesn't merge past with --admin",
    ]);
    expect(blocked(OVER, { rules: [{ type: "pull_request", parameters: { required_review_thread_resolution: true } }, { type: "required_deployments", parameters: {} }] })).toEqual([
      "main's ruleset requires conversation resolution, which fbs doesn't merge past with --admin",
      "main's ruleset has the rule required_deployments, which fbs doesn't merge past with --admin",
    ]);
  });

  test("on BLOCKED --admin is an allow-list: a ruleset rule fbs doesn't know, or one --admin would skip unchecked, refuses", () => {
    const blocked = (rules: unknown[], view: PrView = {}) => {
      const s = setup({ over: OVER });
      const { gh, calls } = fakeGh(s, { statusCheckRollup: RED, mergeStateStatus: "BLOCKED", ...view }, { admin: "true", rules });
      const reasons = refusals(s, "x", gh);
      expect(calls.some((c) => c[1] === "merge")).toBe(false);
      return reasons;
    };
    expect(blocked([{ type: "code_scanning", parameters: {} }])).toEqual(["main's ruleset has the rule code_scanning, which fbs doesn't merge past with --admin"]);
    expect(blocked([{ type: "brand_new_rule" }])).toEqual(["main's ruleset has the rule brand_new_rule, which fbs doesn't merge past with --admin"]);
    expect(blocked([{ type: "pull_request", parameters: { require_code_owner_review: true } }], { reviewDecision: "REVIEW_REQUIRED" }).join("\n")).toContain("review decision is REVIEW_REQUIRED");
    // A solo repo: no review decision, and approvalProblem reads only classic protection.
    expect(blocked([{ type: "pull_request", parameters: { required_approving_review_count: 1 } }], { reviewDecision: "" })).toEqual(["main's ruleset requires approving reviews and the PR isn't approved"]);
    expect(blocked([{ type: "pull_request", parameters: { require_code_owner_review: true, require_last_push_approval: true } }], { reviewDecision: "" })).toEqual([
      "main's ruleset requires code owner review, approval of the last push and the PR isn't approved",
    ]);
  });

  test("on BLOCKED an admin merges past rules fbs understands, and a code-owner rule once the PR is approved", () => {
    const rules = [
      { type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }, { context: "e2e" }] } },
      { type: "required_linear_history" },
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "pull_request", parameters: { require_code_owner_review: true, required_approving_review_count: 1, require_last_push_approval: false, required_review_thread_resolution: false } },
    ];
    const s = setup({ over: OVER });
    const { gh, calls } = fakeGh(s, { statusCheckRollup: RED, mergeStateStatus: "BLOCKED" }, { admin: "true", rules, branchProtection: { ...requires("test"), enforce_admins: { enabled: false }, required_linear_history: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }, required_signatures: { enabled: false } } });
    expect(land(s.work, "x", gh, NOW, "2026-10-25").pr).toBe(7);
    expect(calls).toContainEqual(mergeCall(s, "--admin"));
  });

  test("on BLOCKED refuses a non-admin, and asks nothing about admin before fbs's own approval check holds", () => {
    const t = setup({ over: OVER });
    const notAdmin = fakeGh(t, { statusCheckRollup: RED, mergeStateStatus: "BLOCKED" });
    expect(refusals(t, "x", notAdmin.gh)).toEqual(["merge state is BLOCKED over the confirmed checks and the gh user is not an admin of acme/app, so it can't merge past them"]);
    expect(notAdmin.calls.some((c) => c[1] === "merge")).toBe(false);

    const u = setup({ over: OVER });
    const unapproved = fakeGh(u, { statusCheckRollup: RED, mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }, { admin: "true" });
    expect(refusals(u, "x", unapproved.gh)).toEqual(["review decision is REVIEW_REQUIRED, not APPROVED"]);
    expect(unapproved.calls.some((c) => c[1] === "merge" || c.includes(".permissions.admin"))).toBe(false);
  });

  test("without over, BLOCKED and UNSTABLE refuse and --admin is never used, even for an admin", () => {
    for (const mergeStateStatus of ["BLOCKED", "UNSTABLE"]) {
      const s = setup();
      const { gh, calls } = fakeGh(s, { mergeStateStatus }, { admin: "true" });
      expect(refusals(s, "x", gh)).toEqual([`merge state is ${mergeStateStatus}, not CLEAN or HAS_HOOKS`]);
      expect(calls.some((c) => c.includes("--admin") || c.includes(".permissions.admin"))).toBe(false);
    }
  });

  test("a confirmed check that passed since lands as a plain land, without over on the record", () => {
    const s = setup({ over: [OVER[0]] });
    const { gh, calls } = fakeGh(s, { mergeStateStatus: "BLOCKED" }, { admin: "true" });
    expect(refusals(s, "x", gh)).toEqual(["merge state is BLOCKED, not CLEAN or HAS_HOOKS"]);
    expect(calls.some((c) => c[1] === "merge")).toBe(false);
    const t = setup({ over: [OVER[0]] });
    expect(land(t.work, "x", fakeGh(t).gh, NOW, "2026-10-25").pr).toBe(7);
    expect(readFeature(t.work, "x").landed?.over).toBeUndefined();
  });
});

describe("fbs land", () => {
  const deps = (gh: GhRunner): PrDeps => ({ gh, now: () => NOW, sleep: () => {}, stdin: () => "" });
  const cli = (cwd: string, gh: GhRunner, ...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(["land", ...args], { cwd, today: "2026-10-25", out: (l) => out.push(l), err: (l) => err.push(l) }, deps(gh));
    return { code, out, err };
  };

  test("prints the merge as one JSON line and exits 0, then list shows it landed", () => {
    const s = setup();
    expect(cli(s.work, fakeGh(s).gh, "x")).toEqual({ code: 0, out: [JSON.stringify({ merged: true, pr: 7, mergeCommit: "f".repeat(40) })], err: [] });
    const out: string[] = [];
    expect(run(["status", "list"], { cwd: s.work, today: "2026-10-25", out: (l) => out.push(l), err: () => {} })).toBe(0);
    expect(out).toEqual(["x\ttiny\tlanded"]);
    const shown: string[] = [];
    run(["status", "show", "x"], { cwd: s.work, today: "2026-10-25", out: (l) => shown.push(l), err: () => {} });
    expect(JSON.parse(shown.join("\n")).landed).toEqual({ pr: 7, repo: "acme/app", commit: "f".repeat(40), at: "2026-10-25", head: s.head });
    const cleared: string[] = [];
    run(["status", "pr", "x", "none"], { cwd: s.work, today: "2026-10-25", out: (l) => cleared.push(l), err: () => {} });
    expect(JSON.parse(cleared.join("\n"))).toMatchObject({ pr: null, landed: { pr: 7 } });
  });

  test("prints one refused line per reason and exits 1", () => {
    const s = setup();
    const r = cli(s.work, fakeGh(s, { isDraft: true, mergeStateStatus: "DRAFT" }).gh, "x");
    expect(r.code).toBe(1);
    expect(r.out).toEqual(["refused: PR #7 is a draft", "refused: merge state is DRAFT, not CLEAN or HAS_HOOKS"]);
  });

  test("a gh that can't read the PR is an environment error; a bad call is a usage error", () => {
    const s = setup();
    const r = cli(s.work, () => ({ code: 4, stdout: "", stderr: "gh auth login" }), "x");
    expect(r.code).toBe(2);
    expect(r.err[0]).toContain("gh pr view failed");
    expect(cli(s.work, fakeGh(s).gh).code).toBe(2);
    expect(cli(s.work, fakeGh(s).gh, "x", "y").code).toBe(2);
    expect(cli(s.work, fakeGh(s).gh, "nope")).toEqual({ code: 1, out: ["error: missing: no feature nope"], err: [] });
  });
});

describe("fbs land request", () => {
  const io = (cwd: string, out: string[]) => ({ cwd, today: "2026-10-25", out: (l: string) => out.push(l), err: (l: string) => out.push(`err: ${l}`) });
  const cli = (cwd: string, args: string[], stdin = "", session: string | null = null, gh: GhRunner = () => ({ code: 1, stdout: "", stderr: "no gh in this test" })) => {
    const out: string[] = [];
    const deps = { gh, now: () => NOW, sleep: () => {}, stdin: () => stdin };
    const code = run(args, io(cwd, out), deps, { ...REAL_AFK_DEPS, sessionId: () => session });
    return { code, out };
  };
  const edit = (s: Setup, change: Record<string, unknown>) => {
    const path = join(s.work, ".git", "fbs", "features", "x.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...change }));
  };

  test("writes a pending request for the PR, stamp and session, prints it, and leaves the token to the user's answer", () => {
    const s = setup({ token: false });
    expect(cli(s.work, ["land", "request", "x"], "", "s1")).toEqual({ code: 0, out: [JSON.stringify({ requested: true, slug: "x", pr: 7 })] });
    expect(JSON.parse(readFileSync(landRequestPath(join(s.work, ".git")), "utf8"))).toEqual({ slug: "x", pr: 7, tree: s.tree, at: NOW, session: "s1" });
    expect(existsSync(landTokenPath(join(s.work, ".git"), "x"))).toBe(false);
  });

  test("the user's bare land answer in the asking session turns it into the token fbs land takes", () => {
    const s = setup({ token: false });
    expect(cli(s.work, ["land", "request", "x"], "", "s1").code).toBe(0);
    const reply = (prompt: string, session = "s1") => cli(s.work, ["guard", "--reply"], JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, cwd: s.work, prompt }));
    expect(reply("yes")).toEqual({ code: 0, out: [] });
    expect(reply("land it, after the copy fix")).toEqual({ code: 0, out: [] });
    expect(reply("land", "s2")).toEqual({ code: 0, out: [] });
    expect(reply("land #7")).toEqual({ code: 0, out: ["fbs: the user answered land for x (PR #7); its land token is written: run fbs land x"] });
    expect(freshToken(join(s.work, ".git"), "x", NOW)).toEqual({ slug: "x", at: NOW, tree: s.tree });
    expect(land(s.work, "x", fakeGh(s).gh, NOW, "2026-10-25")).toEqual({ pr: 7, mergeCommit: "f".repeat(40) });
    expect(reply("garbage")).toEqual({ code: 0, out: [] });
  });

  test("--over-failing names exactly the checks that completed without passing; the answer carries them into the token", () => {
    const s = setup({ token: false });
    const rollup = [
      { __typename: "CheckRun", name: "test", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "lint", workflowName: "CI", status: "COMPLETED", conclusion: "SKIPPED" },
      { __typename: "CheckRun", name: "e2e", workflowName: "CI", status: "COMPLETED", conclusion: "CANCELLED" },
      { __typename: "CheckRun", name: "unit", workflowName: "", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "CheckRun", name: "smoke", workflowName: "CI", status: "COMPLETED", conclusion: "TIMED_OUT" },
      { __typename: "StatusContext", context: "deploy", state: "SUCCESS" },
      { __typename: "StatusContext", context: "ci/legacy", state: "FAILURE" },
    ];
    const protection = { required_status_checks: { contexts: ["test", "e2e", "visual"], checks: [] } };
    const { gh, calls } = fakeGh(s, { statusCheckRollup: rollup }, { branchProtection: protection, rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "a11y" }, { context: "unit" }] } }] });
    const over: OverCheck[] = [
      { name: "e2e", workflow: "CI", state: "cancelled" },
      { name: "unit", state: "failed" },
      { name: "smoke", workflow: "CI", state: "failed" },
      { name: "ci/legacy", state: "failed" },
      { name: "visual", state: "missing" },
      { name: "a11y", state: "missing" },
    ];
    expect(cli(s.work, ["land", "request", "x", "--over-failing"], "", "s1", gh)).toEqual({ code: 0, out: [JSON.stringify({ requested: true, slug: "x", pr: 7, over })] });
    expect(JSON.parse(readFileSync(landRequestPath(join(s.work, ".git")), "utf8"))).toEqual({ slug: "x", pr: 7, tree: s.tree, at: NOW, session: "s1", over });
    const r = cli(s.work, ["guard", "--reply"], JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: s.work, prompt: "land" }));
    expect(r.out).toEqual(["fbs: the user answered land for x (PR #7) over the failing checks CI / e2e (cancelled), unit (failed), CI / smoke (failed), ci/legacy (failed), visual (didn't run), a11y (didn't run); its land token is written: run fbs land x"]);
    expect(freshToken(join(s.work, ".git"), "x", NOW)).toEqual({ slug: "x", at: NOW, tree: s.tree, over });
    expect(calls.every((c) => (c[0] === "pr" && c[1] === "view") || (c[0] === "api" && c.length === 2))).toBe(true);
  });

  test("a refresh of the waiting request may drop checks from its list but never add one", () => {
    const s = setup({ token: false });
    const failing = (...names: string[]) => names.map((name) => ({ __typename: "CheckRun", name, workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE" }));
    const request = (...names: string[]) => cli(s.work, ["land", "request", "x", "--over-failing"], "", "s1", fakeGh(s, { statusCheckRollup: failing(...names) }).gh);
    expect(request("e2e", "unit").code).toBe(0);
    expect(request("e2e").code).toBe(0);
    const refused = request("e2e", "unit");
    expect(refused.code).toBe(1);
    expect(refused.out).toEqual(["refused: a land request for x with fewer failing checks is waiting for the user's answer; let it be answered or expire in 10 min, then ask again"]);
    expect(JSON.parse(readFileSync(landRequestPath(join(s.work, ".git")), "utf8")).over).toEqual([{ name: "e2e", workflow: "CI", state: "failed" }]);
  });

  test("--over-failing refuses while a check still runs, and makes a plain request when none fails", () => {
    const s = setup({ token: false });
    const running = [
      { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "StatusContext", context: "ci/legacy", state: "PENDING" },
    ];
    expect(cli(s.work, ["land", "request", "x", "--over-failing"], "", "s1", fakeGh(s, { statusCheckRollup: running }).gh)).toEqual({ code: 1, out: ["refused: wait for e2e, ci/legacy to finish"] });
    expect(existsSync(landRequestPath(join(s.work, ".git")))).toBe(false);
    expect(cli(s.work, ["land", "request", "x", "--over-failing"], "", "s1", fakeGh(s).gh)).toEqual({ code: 0, out: [JSON.stringify({ requested: true, slug: "x", pr: 7, note: "no check is failing, so this is a plain land request" })] });
    expect(JSON.parse(readFileSync(landRequestPath(join(s.work, ".git")), "utf8")).over).toBeUndefined();
    expect(cli(s.work, ["land", "request", "x", "--over"], "", "s1").code).toBe(2);
  });

  test("refuses without a Claude Code session, since no answer could be matched to it", () => {
    const s = setup({ token: false });
    for (const session of [null, ""]) {
      const r = cli(s.work, ["land", "request", "x"], "", session);
      expect(r.code).toBe(1);
      expect(r.out).toEqual([expect.stringContaining("no Claude Code session")]);
    }
    expect(existsSync(landRequestPath(join(s.work, ".git")))).toBe(false);
  });

  test("refuses, as land would, with no PR or no stamp, and writes nothing", () => {
    const s = setup({ token: false });
    edit(s, { pr: null, repo: undefined, stamp: undefined });
    expect(cli(s.work, ["land", "request", "x"], "", "s1")).toEqual({ code: 1, out: ["refused: no PR recorded for x", "refused: x has no verify stamp"] });
    edit(s, { pr: 7, repo: "acme/app", landed: { pr: 7, repo: "acme/app", commit: "f".repeat(40), at: "2026-10-25" }, stamp: { tree: s.tree, at: "2026-10-25", verdict: "pass", criteria: 1, evidence: "v.md" } });
    expect(cli(s.work, ["land", "request", "x"], "", "s1")).toEqual({ code: 1, out: ["refused: x has landed already"] });
    expect(cli(s.work, ["land", "request", "nope"], "", "s1")).toEqual({ code: 1, out: ["error: missing: no feature nope"] });
    expect(cli(s.work, ["land", "request", "Bad"], "", "s1").code).toBe(1);
    expect(cli(s.work, ["land", "request", "x", "y"], "", "s1").code).toBe(2);
    expect(existsSync(landRequestPath(join(s.work, ".git")))).toBe(false);
  });
});

describe("fbs guard", () => {
  const cli = (stdin: string, ...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(["guard", ...args], { cwd: tmpdir(), today: "2026-10-25", out: (l) => out.push(l), err: (l) => err.push(l) }, {
      gh: () => ({ code: 1, stdout: "", stderr: "" }),
      now: () => NOW,
      sleep: () => {},
      stdin: () => stdin,
    });
    return { code, out, err };
  };

  test("exits 2 with the reason on stderr to deny, 0 silently to allow", () => {
    const s = setup();
    const merge = JSON.stringify({ cwd: s.work, tool_name: "Bash", tool_input: { command: "gh pr merge 7" } });
    const denied = cli(merge);
    expect(denied.code).toBe(2);
    expect(denied.out).toEqual([]);
    expect(denied.err[0]).toContain("gh pr merge");
    expect(cli(JSON.stringify({ cwd: s.work, tool_name: "Bash", tool_input: { command: "npm test" } }))).toEqual({ code: 0, out: [], err: [] });
    expect(cli("garbage")).toEqual({ code: 0, out: [], err: [] });
  });

  test("--prompt writes the token and never blocks the expansion", () => {
    const s = setup({ token: false });
    const r = cli(JSON.stringify({ hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", cwd: s.work, command_name: "fbs:land", prompt: "/fbs:land x", command_args: "x" }), "--prompt");
    expect(r.code).toBe(0);
    expect(existsSync(landTokenPath(join(s.work, ".git"), "x"))).toBe(true);
    expect(cli("garbage", "--prompt")).toEqual({ code: 0, out: [], err: [] });
    expect(cli("", "--nope").code).toBe(2);
  });
});

describe("landing a stack", () => {
  interface Stack {
    work: string;
    origin: string;
    common: string;
    trees: Record<string, string>;
  }

  const UNITS = { "f-api": { pr: 21, unit: 1, branch: "feature/f-api" }, "f-ui": { pr: 22, unit: 2, branch: "feature/f-ui" } } as const;
  type UnitSlug = keyof typeof UNITS;

  function commitFile(cwd: string, path: string, content: string, subject: string): string {
    writeFileSync(join(cwd, path), content);
    git(cwd, "add", path);
    git(cwd, "commit", "-q", "-m", subject);
    return git(cwd, "rev-parse", "HEAD");
  }

  /**
   * Feature f with units f-api (PR 21, on main) and f-ui (PR 22, on f-api's branch), pushed to a bare origin and
   * stamped, with camp markers for f and f-api and a fresh token for f-api. f-ui rewrites the line f-api changed
   * unless `uiEditsApiLine` is false, when it adds ui.txt instead; `mainMoves` names a file, holding "other", that main
   * gains before the land; `on` is the checkout.
   */
  function stack(options: { uiEditsApiLine?: boolean; mainMoves?: string; on?: string } = {}): Stack {
    const origin = join(tempDir(), "origin.git");
    git(dirname(origin), "init", "-q", "--bare", "-b", "main", origin);
    const work = join(tempDir(), "work");
    git(dirname(work), "init", "-q", "-b", "main", work);
    for (const [key, value] of [["user.name", "fbs"], ["user.email", "fbs@example.com"], ["commit.gpgsign", "false"]]) git(work, "config", key, value);
    git(work, "remote", "add", "origin", origin);
    const init = commitFile(work, "shared.txt", "a\nb\nc\n", "chore: init");
    git(work, "push", "-q", "origin", "main");
    git(work, "switch", "-q", "-c", "feature/f-api");
    const api = commitFile(work, "shared.txt", "a\nB1\nc\n", "feat: api");
    git(work, "switch", "-q", "-c", "feature/f-ui");
    const ui = options.uiEditsApiLine === false ? commitFile(work, "ui.txt", "ui\n", "feat: ui") : commitFile(work, "shared.txt", "a\nB2\nc\n", "feat: ui");
    git(work, "push", "-q", "origin", "feature/f-api", "feature/f-ui");
    if (options.mainMoves) {
      git(work, "switch", "-q", "main");
      commitFile(work, options.mainMoves, "other\n", "docs: other");
      git(work, "push", "-q", "origin", "main");
    }
    git(work, "switch", "-q", options.on ?? "feature/f-ui");

    const common = join(work, ".git");
    const trees = { "f-api": git(work, "rev-parse", `${api}^{tree}`), "f-ui": git(work, "rev-parse", `${ui}^{tree}`) };
    const dir = "docs/features/2026-10-21-f";
    const records: Record<string, object> = {
      f: { slug: "f", dir, size: "big", approvals: {}, pr: null },
      "f-api": { branch: { name: "feature/f-api", parent: "main", base: init, pushed: api } },
      "f-ui": { branch: { name: "feature/f-ui", parent: "feature/f-api", base: api, pushed: ui } },
    };
    mkdirSync(join(common, "fbs", "features"), { recursive: true });
    for (const [slug, record] of Object.entries(records)) {
      const unit = slug === "f" ? {} : { slug, dir: `${dir}/units/${slug}`, size: "big", approvals: {}, pr: UNITS[slug as UnitSlug].pr, repo: "acme/app", unitOf: "f", unit: UNITS[slug as UnitSlug].unit };
      const stamp = slug === "f" ? {} : { stamp: { tree: trees[slug as UnitSlug], at: "2026-10-25", verdict: "pass", criteria: 1, evidence: `${dir}/units/${slug}/verdict.md` } };
      writeFileSync(join(common, "fbs", "features", `${slug}.json`), JSON.stringify({ ...unit, ...record, ...stamp }));
    }
    mkdirSync(dirname(campMarkerPath(common, "f")), { recursive: true });
    for (const slug of ["f", "f-api"]) writeFileSync(campMarkerPath(common, slug), "");
    writeLandToken(common, { slug: "f-api", at: NOW - 60_000, tree: trees["f-api"] });
    return { work, origin, common, trees };
  }

  /** A gh that answers land's calls for `slug`'s PR, squash-merging its head into origin's main as GitHub would. */
  function stackGh(s: Stack, slug: UnitSlug, view: PrView = {}) {
    const calls: string[][] = [];
    const { pr, branch } = UNITS[slug];
    const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: "" });
    let squash: string | null = null;
    const gh: GhRunner = (args) => {
      calls.push(args);
      const line = args.join(" ");
      const head = git(s.origin, "rev-parse", `refs/heads/${branch}`);
      if (line.startsWith(`pr view ${pr} --repo acme/app --json state,isDraft`)) {
        const facts = { state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", headRefOid: head, headRefName: branch, baseRefName: "main", title: `feat: ${slug}`, reviewDecision: "APPROVED" };
        return ok(JSON.stringify({ ...facts, author: { login: "alex" }, statusCheckRollup: GREEN, ...view }));
      }
      if (line.startsWith("repo view acme/app")) return ok("main\n");
      if (line.startsWith(`pr merge ${pr}`)) {
        const tree = git(s.origin, "merge-tree", "--write-tree", "main", head).split("\n")[0];
        squash = git(s.origin, "commit-tree", tree, "-p", "main", "-m", `feat: ${slug} (#${pr})`);
        git(s.origin, "update-ref", "refs/heads/main", squash);
        return ok("");
      }
      if (line.startsWith(`pr view ${pr} --repo acme/app --json state,mergeCommit`)) return ok(JSON.stringify({ state: "MERGED", mergeCommit: { oid: squash } }));
      if (line.startsWith("pr edit")) return ok("");
      return { code: 1, stdout: "", stderr: `unexpected gh ${line}` };
    };
    return { gh, calls, squash: () => squash as string };
  }

  const exitCode = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: isolatedGitEnv(), stdout: "pipe", stderr: "pipe" }).exitCode;
  const worktrees = (cwd: string) => git(cwd, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));

  test("landing the bottom unit rebases the next onto the squash, so its PR lists only its own commit", () => {
    const s = stack();
    const oldUi = git(s.work, "rev-parse", "feature/f-ui");
    const { gh, calls, squash } = stackGh(s, "f-api");
    const result = land(s.work, "f", gh, NOW, "2026-10-25");
    expect(result).toEqual({ pr: 21, mergeCommit: squash(), slug: "f-api", unit: 1, restack: { slug: "f-ui", pr: 22, done: true, treeChanged: false } });

    // What a merge would hit: merging the squashed default branch conflicts on the line both units changed.
    expect(exitCode(s.work, "merge-tree", "--write-tree", "origin/main", oldUi)).toBe(1);
    const restacked = git(s.origin, "rev-parse", "refs/heads/feature/f-ui");
    expect(git(s.work, "rev-parse", `${restacked}^{tree}`)).toBe(s.trees["f-ui"]);
    expect(git(s.work, "rev-parse", `${restacked}^`)).toBe(squash());
    expect(git(s.work, "log", "--format=%s", `origin/main..${restacked}`)).toBe("feat: ui");
    expect(exitCode(s.work, "merge-base", "--is-ancestor", oldUi, restacked)).toBe(1);
    expect(readFeature(s.work, "f-ui").branch).toEqual({ name: "feature/f-ui", parent: "main", base: squash(), pushed: restacked });
    expect(calls).toContainEqual(["pr", "edit", "22", "--repo", "acme/app", "--base", "main"]);

    // The clean checkout of the next unit follows it, with the same files.
    expect(git(s.work, "symbolic-ref", "--short", "HEAD")).toBe("feature/f-ui");
    expect(git(s.work, "rev-parse", "HEAD")).toBe(restacked);
    expect(git(s.work, "status", "--porcelain")).toBe("");
    expect(worktrees(s.work)).toHaveLength(1);
    expect(existsSync(campMarkerPath(s.common, "f-api"))).toBe(false);
    expect(existsSync(campMarkerPath(s.common, "f"))).toBe(true);
  });

  test("fbs land on the feature prints the unit it landed and the restack as one JSON line", () => {
    const s = stack();
    const { gh, squash } = stackGh(s, "f-api");
    const out: string[] = [];
    const deps: PrDeps = { gh, now: () => NOW, sleep: () => {}, stdin: () => "" };
    expect(run(["land", "f"], { cwd: s.work, today: "2026-10-25", out: (l) => out.push(l), err: () => {} }, deps)).toBe(0);
    expect(out).toEqual([JSON.stringify({ merged: true, pr: 21, mergeCommit: squash(), slug: "f-api", unit: 1, restack: { slug: "f-ui", pr: 22, done: true, treeChanged: false } })]);
  });

  test("a conflict with what the default branch gained meanwhile leaves the next unit as it was, here and on origin", () => {
    const s = stack({ uiEditsApiLine: false, mainMoves: "ui.txt" });
    const before = readFeature(s.work, "f-ui");
    const local = git(s.work, "rev-parse", "feature/f-ui");
    const { gh, calls, squash } = stackGh(s, "f-api");
    const result = land(s.work, "f-api", gh, NOW, "2026-10-25");
    expect(result).toEqual({
      pr: 21,
      mergeCommit: squash(),
      slug: "f-api",
      unit: 1,
      restack: { slug: "f-ui", pr: 22, done: false, kind: "conflict", reason: "rebasing feature/f-ui onto origin/main conflicts; feature/f-ui is left as it was, rebase it by hand" },
    });
    expect(readFeature(s.work, "f-api").landed?.commit).toBe(squash());
    expect(git(s.origin, "rev-parse", "refs/heads/feature/f-ui")).toBe(before.branch?.pushed as string);
    expect(git(s.work, "rev-parse", "feature/f-ui")).toBe(local);
    expect(git(s.work, "status", "--porcelain")).toBe("");
    expect(readFeature(s.work, "f-ui")).toEqual(before);
    expect(calls.some((c) => c[1] === "edit")).toBe(false);
    expect(worktrees(s.work)).toHaveLength(1);
  });

  test("what the default branch gained meanwhile comes along, changing the next unit's tree, and its local branch moves when nothing has it checked out", () => {
    const s = stack({ mainMoves: "other.txt", uiEditsApiLine: false, on: "main" });
    const { gh } = stackGh(s, "f-api");
    const result = land(s.work, "f-api", gh, NOW, "2026-10-25");
    expect(result).toMatchObject({ restack: { slug: "f-ui", pr: 22, done: true, treeChanged: true } });
    const restacked = git(s.origin, "rev-parse", "refs/heads/feature/f-ui");
    expect(git(s.work, "rev-parse", "feature/f-ui")).toBe(restacked);
    expect(git(s.work, "show", `${restacked}:other.txt`)).toBe("other");
    expect(git(s.work, "show", `${restacked}:shared.txt`)).toBe("a\nB1\nc");
    expect(git(s.work, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  test("a next unit checked out with uncommitted changes isn't restacked, here or on origin", () => {
    const s = stack();
    writeFileSync(join(s.work, "scratch.txt"), "wip\n");
    const before = git(s.work, "rev-parse", "feature/f-ui");
    const result = land(s.work, "f-api", stackGh(s, "f-api").gh, NOW, "2026-10-25");
    expect(result).toMatchObject({ restack: { slug: "f-ui", done: false, kind: "dirty", reason: `feature/f-ui is checked out at ${s.work} with uncommitted changes; commit or stash them, then sync again` } });
    expect(git(s.origin, "rev-parse", "refs/heads/feature/f-ui")).toBe(before);
    expect(git(s.work, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(s.work, "scratch.txt"), "utf8")).toBe("wip\n");
  });

  test("/fbs:land on the feature writes the next unit's token, which fbs land takes by either slug, once", () => {
    const s = stack();
    rmSync(landTokenPath(s.common, "f-api"));
    const prompt = (args: string) => guardPrompt(JSON.stringify({ hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", cwd: s.work, command_name: "fbs:land", command_args: args }), s.work, NOW);
    expect(prompt("f")).toBe("land token written for f-api, the next unit of f to land");
    expect(existsSync(landTokenPath(s.common, "f"))).toBe(false);
    const bash = (command: string) => guardToolUse(JSON.stringify({ cwd: s.work, tool_name: "Bash", tool_input: { command } }), s.work, NOW).deny;
    expect(bash("fbs land f")).toEqual([]);
    expect(bash("fbs land f-api")).toEqual([]);
    expect(bash("fbs land f-ui")).toEqual([expect.stringContaining("needs a fresh land token")]);
    expect(bash("gh pr merge 21 --squash")).toEqual([expect.stringContaining("gh pr merge merges a PR")]);
    expect(bash("git push origin main")).toEqual([expect.stringContaining("default branch")]);
    expect(bash("gh pr edit 22 --repo acme/app --base main")).toEqual([]);
    // The restack's force push runs inside fbs land and fbs stack sync, out of the hook's sight; a typed one is still denied.
    expect(bash("fbs stack sync f")).toEqual([]);
    expect(bash("git push --force origin feature/f-ui")).toEqual([expect.stringContaining("--force, -f or a + refspec")]);

    expect(refusals(s, "f", stackGh(s, "f-api", { isDraft: true }).gh)).toEqual(["PR #21 is a draft"]);
    expect(bash("fbs land f-api")).toEqual([expect.stringContaining("needs a fresh land token")]);
    expect(refusals(s, "f-api", stackGh(s, "f-api").gh)).toEqual(["no fresh land token for f-api: the user types /fbs:land f-api"]);
  });

  const requestRefusals = (cwd: string, slug: string, now = NOW): string[] => {
    try {
      requestLand(cwd, slug, now, "s1");
    } catch (e) {
      if (e instanceof LandRefusedError) return e.reasons;
      throw e;
    }
    throw new Error("land request did not refuse");
  };

  test("a land request on the feature asks for its next unit; a unit above it is refused bottom-up", () => {
    const s = stack();
    expect(requestRefusals(s.work, "f-ui")).toEqual(["land bottom-up: unit 1 of f, f-api, lands before f-ui"]);
    expect(requestLand(s.work, "f", NOW, "s1")).toEqual({ slug: "f-api", pr: 21, tree: s.trees["f-api"], at: NOW, session: "s1" });
  });

  test("one live request at a time: another feature's is refused until it is answered or expires; the same one refreshes", () => {
    const s = stack();
    requestLand(s.work, "f-api", NOW, "s1");
    const path = landRequestPath(s.common);
    expect(requestRefusals(s.work, "f-ui", NOW + 60_000)).toContain("a land request for f-api (PR #21) is waiting for the user's answer; ask again after it is answered or expires in 9 min");
    expect(JSON.parse(readFileSync(path, "utf8")).slug).toBe("f-api");
    expect(requestLand(s.work, "f", NOW + 60_000, "s1")).toMatchObject({ slug: "f-api", at: NOW + 60_000 });
    expect(requestRefusals(s.work, "f-ui", NOW + 60_000 + 10 * 60_000)).not.toContain(expect.stringContaining("waiting for the user's answer"));
  });

  test("a unit lands only bottom-up, and a feature with no open unit PR has nothing to land", () => {
    const s = stack();
    writeLandToken(s.common, { slug: "f-ui", at: NOW - 60_000, tree: s.trees["f-ui"] });
    const { gh, calls } = stackGh(s, "f-ui");
    expect(refusals(s, "f-ui", gh)).toEqual(["land bottom-up: unit 1 of f, f-api, lands before f-ui"]);
    expect(calls).toEqual([]);
    expect(existsSync(landTokenPath(s.common, "f-ui"))).toBe(false);
    for (const slug of ["f-api", "f-ui"]) {
      const path = join(s.common, "fbs", "features", `${slug}.json`);
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), pr: null, repo: undefined }));
    }
    expect(refusals(s, "f", gh)).toEqual(["no unit of f has an open PR"]);
  });

  test("landing the last unit through the feature removes the feature's camp marker too, with nothing to restack", () => {
    const s = stack();
    land(s.work, "f", stackGh(s, "f-api").gh, NOW, "2026-10-25");
    writeFileSync(campMarkerPath(s.common, "f-ui"), "");
    const prompt = JSON.stringify({ hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", cwd: s.work, command_name: "fbs:land", command_args: "f" });
    expect(guardPrompt(prompt, s.work, NOW)).toBe("land token written for f-ui, the next unit of f to land");
    const { gh, squash } = stackGh(s, "f-ui");
    expect(land(s.work, "f", gh, NOW, "2026-10-25")).toEqual({ pr: 22, mergeCommit: squash(), slug: "f-ui", unit: 2, restack: null });
    for (const slug of ["f", "f-api", "f-ui"]) expect(existsSync(campMarkerPath(s.common, slug))).toBe(false);
    expect(git(s.origin, "rev-parse", "main^{tree}")).toBe(s.trees["f-ui"]);
  });
});
