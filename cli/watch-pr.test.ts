import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Check, type Comment, GhError, type GitHubReader, QueryError, type Snapshot } from "./github";
import { RecordError } from "./status";
import { isolatedGitEnv } from "./test-env";
import { advance, classify, type Clock, type Cursor, cursorPath, emptyCursor, readCursor, saveCursor, watch } from "./watch-pr";

const PR = 7;
const HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    state: "OPEN",
    draft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    baseRefName: "main",
    head: HEAD,
    reviewDecision: null,
    reviews: [],
    threads: [],
    comments: [],
    checks: [],
    truncated: false,
    ...overrides,
  };
}

function comment(id: number, overrides: Partial<Comment> = {}): Comment {
  return { id, kind: "thread", threadId: "T1", author: "alex", bot: false, path: "a.ts", line: 3, body: `comment ${id}`, createdAt: "2026-10-25T10:00:00Z", updatedAt: "2026-10-25T10:00:00Z", ...overrides };
}

const botComment = (id: number, overrides: Partial<Comment> = {}) => comment(id, { author: "codex[bot]", bot: true, ...overrides });
const ACTIONS = { detailsUrl: null, runId: null, rerunnable: false };
const passed = (name: string, id = `run:${name}`): Check => ({ id, name, status: "COMPLETED", conclusion: "SUCCESS", ...ACTIONS });
const failed = (name: string, id = `run:${name}`): Check => ({ id, name, status: "COMPLETED", conclusion: "FAILURE", ...ACTIONS });
const pending = (name: string, id = `run:${name}`): Check => ({ id, name, status: "IN_PROGRESS", conclusion: "" , ...ACTIONS});
const approved = { reviewDecision: "APPROVED" };
const openThread = { threads: [{ id: "T1", isResolved: false, path: "a.ts", line: 3 }] };
const failure = (name: string, failedOnPreviousHead = false) => ({ name, status: "COMPLETED", conclusion: "FAILURE", failedOnPreviousHead, ...ACTIONS });

describe("classify", () => {
  test("approved and every check passing is approved-green", () => {
    expect(classify(snapshot({ ...approved, checks: [passed("ci"), { ...passed("lint"), conclusion: "SKIPPED" }] }), emptyCursor(PR))).toBe("approved-green");
  });

  test("approval without required reviews comes from each reviewer's latest review", () => {
    const review = (author: string, state: string) => ({ author, state, submittedAt: "2026-10-25T10:00:00Z" });
    expect(classify(snapshot({ reviews: [review("ana", "CHANGES_REQUESTED"), review("ana", "APPROVED"), review("bo", "COMMENTED")] }), emptyCursor(PR))).toBe("approved-green");
    expect(classify(snapshot({ reviews: [review("ana", "APPROVED"), review("bo", "CHANGES_REQUESTED")] }), emptyCursor(PR))).toBe("waiting");
    expect(classify(snapshot({ reviewDecision: "REVIEW_REQUIRED", reviews: [review("ana", "APPROVED")] }), emptyCursor(PR))).toBe("waiting");
  });

  test.each(["BLOCKED", "BEHIND", "DIRTY", "UNKNOWN"])("approved and green but %p is not approved-green", (mergeStateStatus) => {
    expect(classify(snapshot({ ...approved, mergeStateStatus, checks: [passed("ci")] }), emptyCursor(PR))).toBeNull();
  });

  test("a settled, green, unapproved PR with nothing open is waiting, once per head", () => {
    const quiet = snapshot({ checks: [passed("ci")] });
    expect(classify(quiet, emptyCursor(PR))).toBe("waiting");
    expect(classify(snapshot({ reviewDecision: "REVIEW_REQUIRED" }), emptyCursor(PR))).toBe("waiting");
    const reported = advance(emptyCursor(PR), quiet, "waiting");
    expect(reported.waitingReportedFor).toBe(HEAD);
    expect(classify(quiet, reported)).toBeNull();
    expect(classify(snapshot({ head: NEW_HEAD, checks: [passed("ci")] }), reported)).toBe("waiting");
  });

  test("waiting needs no unresolved threads, a settled green round and a non-draft", () => {
    expect(classify(snapshot({ threads: [{ id: "T1", isResolved: false, path: null, line: null }] }), emptyCursor(PR))).toBeNull();
    expect(classify(snapshot({ threads: [{ id: "T1", isResolved: true, path: null, line: null }] }), emptyCursor(PR))).toBe("waiting");
    expect(classify(snapshot({ checks: [pending("ci")] }), emptyCursor(PR))).toBeNull();
    expect(classify(snapshot({ mergeStateStatus: "BLOCKED", ...approved }), emptyCursor(PR))).toBeNull();
    expect(classify(snapshot({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }), emptyCursor(PR))).toBeNull();
    expect(classify(snapshot({ draft: true }), emptyCursor(PR))).toBe("ready");
  });

  test("approved-green is reported once per head; later runs on that head keep waiting", () => {
    const green = snapshot({ ...approved, checks: [passed("ci")] });
    const reported = advance(emptyCursor(PR), green, "approved-green");
    expect(reported.approvedReportedFor).toBe(HEAD);
    expect(classify(green, reported)).toBeNull();
    expect(classify(snapshot({ ...approved, head: NEW_HEAD, checks: [passed("ci")] }), reported)).toBe("approved-green");
    expect(classify(snapshot({ ...approved, checks: [passed("ci")], comments: [comment(1)] }), reported)).toBe("activity");
  });

  test("a watch on an approved head it already reported keeps waiting until something changes", () => {
    const green = snapshot({ ...approved, checks: [passed("ci")] });
    const first = runWatch([green]);
    expect(first.report.verdict).toBe("approved-green");
    const again = runWatch([green], first.cursor ?? undefined, ONCE);
    expect(again.report.verdict).toBe("timeout");
  });

  test("approved with a pending check keeps waiting", () => {
    expect(classify(snapshot({ ...approved, checks: [passed("ci"), pending("e2e")] }), emptyCursor(PR))).toBeNull();
  });

  test("a green, settled draft with nothing unseen is ready, approved or not", () => {
    expect(classify(snapshot({ draft: true, mergeStateStatus: "DRAFT", checks: [passed("ci")] }), emptyCursor(PR))).toBe("ready");
    expect(classify(snapshot({ draft: true, mergeStateStatus: "DRAFT", ...approved, checks: [passed("ci")] }), emptyCursor(PR))).toBe("ready");
    expect(classify(snapshot({ draft: true, checks: [pending("ci")] }), emptyCursor(PR))).toBeNull();
    expect(classify(snapshot({ draft: true, checks: [passed("ci")], comments: [botComment(1)] }), emptyCursor(PR))).toBe("activity");
    const seen = advance(emptyCursor(PR), snapshot({ draft: true, checks: [failed("ci")] }));
    expect(classify(snapshot({ draft: true, checks: [failed("ci")] }), seen)).toBeNull();
  });

  test("a closed or merged PR is closed, before anything else", () => {
    expect(classify(snapshot({ state: "CLOSED", mergeable: "CONFLICTING" }), emptyCursor(PR))).toBe("closed");
    expect(classify(snapshot({ state: "MERGED", comments: [comment(1)] }), emptyCursor(PR))).toBe("closed");
  });

  test("a conflicting PR is conflict", () => {
    expect(classify(snapshot({ mergeable: "CONFLICTING", comments: [comment(1)] }), emptyCursor(PR))).toBe("conflict");
  });

  test("a new human comment wakes it even while checks are pending", () => {
    expect(classify(snapshot({ checks: [pending("ci")], comments: [comment(1)] }), emptyCursor(PR))).toBe("activity");
  });

  test("a bot comment waits for the round to settle", () => {
    expect(classify(snapshot({ checks: [pending("ci")], comments: [botComment(1)] }), emptyCursor(PR))).toBeNull();
    expect(classify(snapshot({ checks: [passed("ci")], comments: [botComment(1)] }), emptyCursor(PR))).toBe("activity");
  });

  test("a failing check waits for the round to settle", () => {
    expect(classify(snapshot({ checks: [failed("ci"), pending("e2e")] }), emptyCursor(PR))).toBeNull();
    expect(classify(snapshot({ checks: [failed("ci"), passed("e2e")] }), emptyCursor(PR))).toBe("activity");
  });

  test("a check waiting on a person settles the round and blocks it", () => {
    const waiting: Check = { id: "run:9", name: "deploy", status: "WAITING", conclusion: "", ...ACTIONS };
    expect(classify(snapshot({ ...approved, checks: [passed("ci"), waiting] }), emptyCursor(PR))).toBe("activity");
    const seen = advance(emptyCursor(PR), snapshot({ checks: [waiting] }));
    expect(classify(snapshot({ ...approved, checks: [waiting] }), seen)).toBeNull();
  });

  test("a truncated snapshot never settles, but a human comment still wakes it", () => {
    expect(classify(snapshot({ truncated: true, ...approved, checks: [passed("ci")] }), emptyCursor(PR))).toBeNull();
    expect(classify(snapshot({ truncated: true, draft: true, comments: [botComment(1)] }), emptyCursor(PR))).toBeNull();
    expect(classify(snapshot({ truncated: true, comments: [comment(1)] }), emptyCursor(PR))).toBe("activity");
  });

  test("an unseen bot comment comes before approved-green", () => {
    expect(classify(snapshot({ ...approved, comments: [botComment(1)] }), emptyCursor(PR))).toBe("activity");
  });

  test("a reported comment is not reported again; an edited one is", () => {
    const seen = advance(emptyCursor(PR), snapshot({ ...openThread, comments: [comment(1), botComment(2)] }));
    expect(classify(snapshot({ ...openThread, comments: [comment(1), botComment(2)] }), seen)).toBeNull();
    expect(classify(snapshot({ ...openThread, comments: [comment(1, { updatedAt: "2026-10-25T11:00:00Z" })] }), seen)).toBe("activity");
  });

  test("a failure already reported on this head doesn't wake it again, but its re-run's failure does", () => {
    const seen = advance(emptyCursor(PR), snapshot({ checks: [failed("ci")] }));
    expect(classify(snapshot({ checks: [failed("ci")] }), seen)).toBeNull();
    expect(classify(snapshot({ checks: [failed("ci", "run:2")] }), seen)).toBe("activity");
    expect(classify(snapshot({ head: NEW_HEAD, checks: [failed("ci")] }), seen)).toBe("activity");
  });

  test("two failing checks sharing a name are both remembered, so they don't wake it forever", () => {
    const both = snapshot({ checks: [failed("build", "run:1"), failed("build", "run:2")] });
    expect(classify(both, advance(emptyCursor(PR), both))).toBeNull();
  });
});

class FakeReader implements GitHubReader {
  calls = 0;
  constructor(private readonly answers: (Snapshot | Error)[]) {}
  snapshot(pr: number): Snapshot {
    expect(pr).toBe(PR);
    const answer = this.answers[Math.min(this.calls++, this.answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  }
}

function fakeClock(): Clock & { sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms / 1000);
      now += ms;
    },
  };
}

function runWatch(answers: (Snapshot | Error)[], cursor: Cursor = emptyCursor(PR), options = { intervalSeconds: 60, timeoutSeconds: null as number | null }) {
  const reader = new FakeReader(answers);
  const clock = fakeClock();
  const progress: string[] = [];
  const result = watch(reader, cursor, options, clock, (line) => progress.push(line));
  return { ...result, sleeps: clock.sleeps, progress, calls: reader.calls };
}

const ONCE = { intervalSeconds: 60, timeoutSeconds: 0 };

describe("watch", () => {
  test("failing checks carry the Actions run to re-run, and only Actions checks are rerunnable", () => {
    const actions: Check = { ...failed("test", "run:5"), detailsUrl: "https://github.com/o/r/actions/runs/42/job/5", runId: 42, rerunnable: true };
    const status: Check = { ...failed("ci/legacy", "status:ci/legacy:t"), conclusion: "ERROR", detailsUrl: "https://ci.example.com/1" };
    const r = runWatch([snapshot({ checks: [actions, status] })]);
    if (r.report.verdict === "query-error") throw new Error("unexpected");
    expect(r.report.failingChecks).toEqual([
      { name: "test", status: "COMPLETED", conclusion: "FAILURE", failedOnPreviousHead: false, detailsUrl: "https://github.com/o/r/actions/runs/42/job/5", runId: 42, rerunnable: true },
      { name: "ci/legacy", status: "COMPLETED", conclusion: "ERROR", failedOnPreviousHead: false, detailsUrl: "https://ci.example.com/1", runId: null, rerunnable: false },
    ]);
  });

  test("exits with the verdict and the report on the first decisive snapshot", () => {
    const r = runWatch([snapshot({ ...approved, checks: [passed("ci")], threads: [{ id: "T1", isResolved: false, path: "a.ts", line: 1 }] })]);
    expect(r.report).toEqual({
      verdict: "approved-green",
      pr: PR,
      state: "OPEN",
      head: HEAD,
      draft: false,
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      truncated: false,
      newComments: [],
      failingChecks: [],
      unresolvedThreads: 1,
    });
    expect(r.sleeps).toEqual([]);
  });

  test("closed reports the PR's state", () => {
    const r = runWatch([snapshot({ state: "MERGED" })]);
    expect(r.report).toMatchObject({ verdict: "closed", state: "MERGED" });
  });

  test("backs off from the interval, doubling to 300 s", () => {
    const quiet = snapshot({ checks: [pending("ci")] });
    const r = runWatch([quiet, quiet, quiet, quiet, quiet, quiet, snapshot({ comments: [comment(1)] })]);
    expect(r.report.verdict).toBe("activity");
    expect(r.sleeps).toEqual([60, 120, 240, 300, 300, 300]);
  });

  test("a new head resets the backoff", () => {
    const quiet = snapshot({ checks: [pending("ci")] });
    const pushed = snapshot({ head: NEW_HEAD, checks: [pending("ci")] });
    const r = runWatch([quiet, quiet, quiet, pushed, pushed, snapshot({ head: NEW_HEAD, comments: [comment(1)] })]);
    expect(r.sleeps).toEqual([60, 120, 240, 60, 120]);
  });

  test("pending checks and a bot comment keep waiting until the round settles", () => {
    const r = runWatch([snapshot({ checks: [pending("ci")], comments: [botComment(1)] }), snapshot({ checks: [failed("ci")], comments: [botComment(1)] })]);
    expect(r.report.verdict).toBe("activity");
    expect(r.calls).toBe(2);
    if (r.report.verdict === "query-error") throw new Error("unexpected");
    expect(r.report.newComments.map((c) => [c.key, c.bot, c.edited])).toEqual([["thread:1", true, false]]);
    expect(r.report.failingChecks).toEqual([failure("ci")]);
  });

  test("times out with what it saw, and --once is a zero timeout", () => {
    const quiet = snapshot({ checks: [pending("ci")], comments: [botComment(1)] });
    const timedOut = runWatch([quiet], emptyCursor(PR), { intervalSeconds: 60, timeoutSeconds: 150 });
    expect(timedOut.report.verdict).toBe("timeout");
    expect(timedOut.sleeps).toEqual([60, 90]);
    const once = runWatch([quiet], emptyCursor(PR), ONCE);
    expect(once.report.verdict).toBe("timeout");
    expect(once.calls).toBe(1);
    expect(once.sleeps).toEqual([]);
    if (once.report.verdict === "query-error") throw new Error("unexpected");
    expect(once.report.newComments.map((c) => c.id)).toEqual([1]);
  });

  test.each([
    ["timeout", snapshot({ checks: [failed("ci"), pending("e2e")], comments: [botComment(1)] })],
    ["conflict", snapshot({ mergeable: "CONFLICTING", checks: [failed("ci")], comments: [comment(1)] })],
  ])("a %p exit leaves the cursor alone, so the next watch still reports what it saw", (verdict, seen) => {
    const r = runWatch([seen], emptyCursor(PR), ONCE);
    expect(r.report.verdict).toBe(verdict as "timeout");
    expect(r.cursor).toBeNull();
    const next = runWatch([snapshot({ checks: [failed("ci"), passed("e2e")], comments: [botComment(1)] })], r.cursor ?? emptyCursor(PR), ONCE);
    expect(next.report.verdict).toBe("activity");
  });

  test.each([
    ["activity", snapshot({ comments: [comment(1)] })],
    ["approved-green", snapshot({ ...approved })],
    ["ready", snapshot({ draft: true })],
    ["closed", snapshot({ state: "CLOSED" })],
    ["waiting", snapshot({ reviewDecision: "REVIEW_REQUIRED" })],
  ])("a %p exit returns the cursor to save", (verdict, seen) => {
    const r = runWatch([seen], emptyCursor(PR), ONCE);
    expect(r.report.verdict).toBe(verdict as "activity");
    expect(r.cursor).toMatchObject({ head: HEAD });
  });

  test("retries a transient query error, then recovers", () => {
    const r = runWatch([new QueryError("rate limited"), snapshot({ state: "MERGED" })]);
    expect(r.report.verdict).toBe("closed");
    expect(r.sleeps).toEqual([15]);
  });

  test("retries transient errors with backoff until the deadline, then reports query-error with no cursor", () => {
    const r = runWatch([new QueryError("HTTP 502")], emptyCursor(PR), { intervalSeconds: 60, timeoutSeconds: 100 });
    expect(r.report).toEqual({ verdict: "query-error", pr: PR, error: "HTTP 502" });
    expect(r.cursor).toBeNull();
    expect(r.calls).toBe(4);
    expect(r.sleeps).toEqual([15, 30, 55]);
  });

  test("a permanent gh failure is not retried", () => {
    const reader = new FakeReader([new GhError("gh is not authenticated")]);
    expect(() => watch(reader, emptyCursor(PR), { intervalSeconds: 60, timeoutSeconds: null }, fakeClock(), () => {})).toThrow(GhError);
    expect(reader.calls).toBe(1);
  });

  test("prints one short NDJSON progress line per poll", () => {
    const r = runWatch([snapshot({ checks: [pending("ci")] }), snapshot({ mergeable: "CONFLICTING" })]);
    expect(r.report.verdict).toBe("conflict");
    expect(r.progress.map((line) => JSON.parse(line))).toEqual([
      { poll: 1, head: "aaaaaaa", pending: 1, failing: 0, unseen: 0, next: 60 },
      { poll: 2, head: "aaaaaaa", pending: 0, failing: 0, unseen: 0, verdict: "conflict" },
    ]);
  });

  test("the saved cursor reports a comment once, and an edit again", () => {
    const first = runWatch([snapshot({ ...openThread, comments: [comment(1)] })]);
    expect(first.report.verdict).toBe("activity");
    const quiet = runWatch([snapshot({ ...openThread, comments: [comment(1)] })], first.cursor ?? undefined, ONCE);
    expect(quiet.report.verdict).toBe("timeout");
    if (quiet.report.verdict === "query-error") throw new Error("unexpected");
    expect(quiet.report.newComments).toEqual([]);
    const edited = runWatch([snapshot({ comments: [comment(1, { updatedAt: "2026-10-25T12:00:00Z", body: "edited" })] })], first.cursor ?? undefined);
    expect(edited.report.verdict).toBe("activity");
    if (edited.report.verdict === "query-error") throw new Error("unexpected");
    expect(edited.report.newComments.map((c) => [c.body, c.edited])).toEqual([["edited", true]]);
  });

  test("failedOnPreviousHead tells a check that failed on the last head from a new failure", () => {
    const first = runWatch([snapshot({ checks: [failed("ci"), passed("lint")] })]);
    expect(first.cursor).toMatchObject({ head: HEAD, reported: ["run:ci"], failing: ["ci"], previousFailing: [] });
    const pushed = runWatch([snapshot({ head: NEW_HEAD, checks: [failed("ci", "run:3"), failed("lint", "run:4")] })], first.cursor ?? undefined);
    if (pushed.report.verdict === "query-error") throw new Error("unexpected");
    expect(pushed.report.failingChecks).toEqual([failure("ci", true), failure("lint")]);
    expect(pushed.cursor).toMatchObject({ head: NEW_HEAD, reported: ["run:3", "run:4"], failing: ["ci", "lint"], previousFailing: ["ci"] });
    const again = runWatch([snapshot({ head: NEW_HEAD, state: "CLOSED", checks: [failed("ci", "run:3")] })], pushed.cursor ?? undefined);
    if (again.report.verdict === "query-error") throw new Error("unexpected");
    expect(again.report.failingChecks).toEqual([failure("ci", true)]);
  });
});

describe("the cursor file", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "fbs-cursor-"));
    dirs.push(dir);
    const result = Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: isolatedGitEnv() });
    expect(result.exitCode).toBe(0);
    return dir;
  }

  const CURSOR: Cursor = { pr: PR, comments: { "thread:1": "2026-10-25T10:00:00Z" }, head: HEAD, reported: ["run:1"], failing: ["ci"], previousFailing: ["lint"], waitingReportedFor: HEAD, approvedReportedFor: HEAD };

  test("lives in the git common dir and round-trips", () => {
    const dir = repo();
    expect(cursorPath(dir, "x")).toEndWith(join(".git", "fbs", "pr", "x.json"));
    expect(readCursor(dir, "x", PR)).toEqual(emptyCursor(PR));
    saveCursor(dir, "x", CURSOR);
    expect(readCursor(dir, "x", PR)).toEqual(CURSOR);
  });

  test("saving keeps comments only the file has and the newest updatedAt of each", () => {
    const dir = repo();
    saveCursor(dir, "x", { ...CURSOR, comments: { "issue:9": "2026-10-25T11:00:00Z", "thread:1": "2026-10-25T09:00:00Z", "thread:2": "2026-10-25T09:00:00Z" } });
    saveCursor(dir, "x", { ...CURSOR, comments: { "thread:1": "2026-10-25T10:00:00Z", "thread:2": "2026-10-25T08:00:00Z" } });
    expect(readCursor(dir, "x", PR).comments).toEqual({ "issue:9": "2026-10-25T11:00:00Z", "thread:1": "2026-10-25T10:00:00Z", "thread:2": "2026-10-25T09:00:00Z" });
  });

  test("a cursor written before waitingReportedFor and approvedReportedFor existed reads as never reported", () => {
    const dir = repo();
    const path = cursorPath(dir, "x");
    mkdirSync(dirname(path), { recursive: true });
    const { waitingReportedFor: _, approvedReportedFor: __, ...old } = CURSOR;
    writeFileSync(path, JSON.stringify(old));
    expect(readCursor(dir, "x", PR)).toEqual({ ...CURSOR, waitingReportedFor: null, approvedReportedFor: null });
  });

  test("a cursor left by another PR number starts over", () => {
    const dir = repo();
    saveCursor(dir, "x", { ...emptyCursor(3), head: HEAD });
    expect(readCursor(dir, "x", PR)).toEqual(emptyCursor(PR));
  });

  test("a malformed cursor is a record error", () => {
    const dir = repo();
    const path = cursorPath(dir, "x");
    mkdirSync(dirname(path), { recursive: true });
    const bad = [
      "{not json",
      "[]",
      JSON.stringify({ ...emptyCursor(PR), extra: 1 }),
      JSON.stringify({ ...emptyCursor(PR), comments: { "thread:1": 5 } }),
      JSON.stringify({ ...emptyCursor(PR), head: 1 }),
      JSON.stringify({ ...emptyCursor(PR), reported: { ci: "run:1" } }),
      JSON.stringify({ ...emptyCursor(PR), waitingReportedFor: 3 }),
      JSON.stringify({ ...emptyCursor(PR), approvedReportedFor: false }),
    ];
    for (const content of bad) {
      writeFileSync(path, content);
      expect(() => readCursor(dir, "x", PR)).toThrow(RecordError);
    }
  });
});
