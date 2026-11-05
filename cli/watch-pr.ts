import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitCommonDir } from "./git";
import { type Check, type Comment, type GitHubReader, QueryError, type Snapshot } from "./github";
import { RecordError } from "./status";

/** What the last saved exit reported, so the next watch wakes only for what's new. */
export interface Cursor {
  pr: number;
  /** `<kind>:<id>` → the updatedAt last reported. */
  comments: Record<string, string>;
  head: string | null;
  /** Ids of the failing checks reported on `head`. */
  reported: string[];
  /** Names of the checks failing on `head`. */
  failing: string[];
  /** Names of the checks that failed on the head before `head`. */
  previousFailing: string[];
  /** The head a `waiting` verdict was last reported for, so it is reported once per head. */
  waitingReportedFor: string | null;
  /** Likewise for `approved-green`, so a camp that keeps watching after approval doesn't wake on it again. */
  approvedReportedFor: string | null;
}

export type Verdict = "approved-green" | "ready" | "waiting" | "conflict" | "activity" | "closed" | "timeout" | "query-error";

export const EXIT_CODES: Record<Verdict, number> = { "approved-green": 0, activity: 3, closed: 4, timeout: 5, conflict: 6, "query-error": 7, ready: 8, waiting: 9 };

/** Verdicts whose report the agent acts on in full; the others leave the cursor alone, so nothing is lost. */
const SAVING: readonly Verdict[] = ["approved-green", "ready", "waiting", "activity", "closed"];

export interface NewComment extends Comment {
  /** `<kind>:<id>`, what `fbs pr reply --comment` takes. */
  key: string;
  /** Reported before with an older updatedAt. */
  edited: boolean;
}

export interface FailingCheck {
  name: string;
  status: string;
  conclusion: string;
  failedOnPreviousHead: boolean;
  detailsUrl: string | null;
  /** The GitHub Actions run, for `gh run rerun`; null for other checks. */
  runId: number | null;
  rerunnable: boolean;
}

export interface Report {
  verdict: Exclude<Verdict, "query-error">;
  pr: number;
  state: Snapshot["state"];
  head: string;
  draft: boolean;
  mergeStateStatus: string;
  reviewDecision: string | null;
  truncated: boolean;
  newComments: NewComment[];
  failingChecks: FailingCheck[];
  unresolvedThreads: number;
}

export interface QueryErrorReport {
  verdict: "query-error";
  pr: number;
  error: string;
}

const REPORTED_FOR = ["waitingReportedFor", "approvedReportedFor"];

export function emptyCursor(pr: number): Cursor {
  return { pr, comments: {}, head: null, reported: [], failing: [], previousFailing: [], waitingReportedFor: null, approvedReportedFor: null };
}

export function cursorPath(cwd: string, slug: string): string {
  return join(gitCommonDir(cwd), "fbs", "pr", `${slug}.json`);
}

/** The cursor for `slug` on `pr`; a cursor left from another PR number starts over. */
export function readCursor(cwd: string, slug: string, pr: number): Cursor {
  const path = cursorPath(cwd, slug);
  if (!existsSync(path)) return emptyCursor(pr);
  const invalid = (reason: string) => new RecordError(`invalid cursor ${path}: ${reason}`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw invalid((e as Error).message.split("\n")[0]);
  }
  // A cursor saved before the reported-for fields existed has every other key.
  const keys = Object.keys(raw ?? {}).filter((key) => !REPORTED_FOR.includes(key)).sort().join();
  if (!isObject(raw) || keys !== "comments,failing,head,pr,previousFailing,reported") {
    throw invalid("expected { pr, comments, head, reported, failing, previousFailing, waitingReportedFor, approvedReportedFor }");
  }
  const [waitingReportedFor, approvedReportedFor] = REPORTED_FOR.map((key) => raw[key] ?? null);
  for (const key of REPORTED_FOR) {
    if (!(raw[key] === undefined || raw[key] === null || typeof raw[key] === "string")) throw invalid(`${key} must be null or a string`);
  }
  if (!Number.isInteger(raw.pr)) throw invalid("pr must be an integer");
  if (!isObject(raw.comments) || !Object.values(raw.comments).every((v) => typeof v === "string")) throw invalid("comments must map ids to strings");
  if (!(raw.head === null || typeof raw.head === "string")) throw invalid("head must be null or a string");
  for (const key of ["reported", "failing", "previousFailing"] as const) {
    if (!isStringList(raw[key])) throw invalid(`${key} must be a list of strings`);
  }
  if (raw.pr !== pr) return emptyCursor(pr);
  return {
    pr,
    comments: raw.comments as Record<string, string>,
    head: raw.head,
    reported: raw.reported as string[],
    failing: raw.failing as string[],
    previousFailing: raw.previousFailing as string[],
    waitingReportedFor: waitingReportedFor as string | null,
    approvedReportedFor: approvedReportedFor as string | null,
  };
}

/** Write the cursor, keeping the newest updatedAt per comment from what's on disk, such as a reply's own comment. */
export function saveCursor(cwd: string, slug: string, cursor: Cursor): void {
  const onDisk = readCursor(cwd, slug, cursor.pr);
  const comments = { ...onDisk.comments };
  for (const [key, updatedAt] of Object.entries(cursor.comments)) {
    if (comments[key] === undefined || Date.parse(updatedAt) > Date.parse(comments[key])) comments[key] = updatedAt;
  }
  const path = cursorPath(cwd, slug);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ ...cursor, comments }, null, 2)}\n`, { flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

const PASSING = ["SUCCESS", "NEUTRAL", "SKIPPED"];
// These wait on a person, not on CI, so the round counts as settled and the check as blocking.
const BLOCKED_STATUSES = ["WAITING", "ACTION_REQUIRED"];
const UNMERGEABLE = ["BLOCKED", "BEHIND", "DIRTY", "UNKNOWN"];

const isSettled = (check: Check) => check.status === "COMPLETED" || BLOCKED_STATUSES.includes(check.status);
const isFailing = (check: Check) => BLOCKED_STATUSES.includes(check.status) || (check.status === "COMPLETED" && !PASSING.includes(check.conclusion));
const commentKey = (comment: Pick<Comment, "kind" | "id">) => `${comment.kind}:${comment.id}`;

function unseenComments(snapshot: Snapshot, cursor: Cursor): NewComment[] {
  return snapshot.comments
    .filter((comment) => {
      const seen = cursor.comments[commentKey(comment)];
      return seen === undefined || Date.parse(comment.updatedAt) > Date.parse(seen);
    })
    .map((comment) => ({ ...comment, key: commentKey(comment), edited: cursor.comments[commentKey(comment)] !== undefined }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Failing checks on the head that the cursor hasn't reported, a re-run's failure included. */
function newFailures(snapshot: Snapshot, cursor: Cursor): Check[] {
  const reported = cursor.head === snapshot.head ? cursor.reported : [];
  return snapshot.checks.filter((check) => isFailing(check) && !reported.includes(check.id));
}

// Without required reviews GitHub leaves reviewDecision null, so the reviews decide.
function isApproved(snapshot: Snapshot): boolean {
  if (snapshot.reviewDecision !== null) return snapshot.reviewDecision === "APPROVED";
  const latest = new Map<string, string>();
  for (const review of snapshot.reviews) {
    if (review.state !== "COMMENTED") latest.set(review.author, review.state);
  }
  const states = [...latest.values()];
  return states.includes("APPROVED") && !states.includes("CHANGES_REQUESTED");
}

/** The verdict for one snapshot, or null to keep waiting. */
export function classify(snapshot: Snapshot, cursor: Cursor): Exclude<Verdict, "timeout" | "query-error"> | null {
  if (snapshot.state !== "OPEN") return "closed";
  if (snapshot.mergeable === "CONFLICTING") return "conflict";
  const unseen = unseenComments(snapshot, cursor);
  // A human is waiting on an answer; bots and CI wait for the round to settle.
  if (unseen.some((comment) => !comment.bot)) return "activity";
  // A truncated snapshot may hide comments or checks, so it never counts as settled.
  if (snapshot.truncated || !snapshot.checks.every(isSettled)) return null;
  if (unseen.length > 0 || newFailures(snapshot, cursor).length > 0) return "activity";
  if (snapshot.checks.some(isFailing)) return null;
  if (snapshot.draft) return "ready";
  if (isApproved(snapshot)) {
    if (UNMERGEABLE.includes(snapshot.mergeStateStatus) || cursor.approvedReportedFor === snapshot.head) return null;
    return "approved-green";
  }
  // Nothing left for camp to do but tell the user; once per head, so a re-watch doesn't loop on it.
  const quiet = snapshot.reviewDecision !== "APPROVED" && snapshot.mergeStateStatus !== "BLOCKED" && snapshot.threads.every((t) => t.isResolved);
  if (quiet && cursor.waitingReportedFor !== snapshot.head) return "waiting";
  return null;
}

function previousFailing(snapshot: Snapshot, cursor: Cursor): string[] {
  return cursor.head === null || cursor.head === snapshot.head ? cursor.previousFailing : cursor.failing;
}

export function report(verdict: Report["verdict"], snapshot: Snapshot, cursor: Cursor): Report {
  const before = previousFailing(snapshot, cursor);
  return {
    verdict,
    pr: cursor.pr,
    state: snapshot.state,
    head: snapshot.head,
    draft: snapshot.draft,
    mergeStateStatus: snapshot.mergeStateStatus,
    reviewDecision: snapshot.reviewDecision,
    truncated: snapshot.truncated,
    newComments: unseenComments(snapshot, cursor),
    failingChecks: snapshot.checks
      .filter(isFailing)
      .map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        failedOnPreviousHead: before.includes(check.name),
        detailsUrl: check.detailsUrl,
        runId: check.runId,
        rerunnable: check.rerunnable,
      })),
    unresolvedThreads: snapshot.threads.filter((thread) => !thread.isResolved).length,
  };
}

/** The cursor once everything in `snapshot` has been reported under `verdict`. */
export function advance(cursor: Cursor, snapshot: Snapshot, verdict?: Verdict): Cursor {
  const comments = { ...cursor.comments };
  for (const comment of snapshot.comments) comments[commentKey(comment)] = comment.updatedAt;
  const failing = snapshot.checks.filter(isFailing);
  const kept = cursor.head === snapshot.head ? cursor.reported : [];
  return {
    pr: cursor.pr,
    comments,
    head: snapshot.head,
    reported: [...new Set([...kept, ...failing.map((check) => check.id)])],
    failing: [...new Set(failing.map((check) => check.name))],
    previousFailing: previousFailing(snapshot, cursor),
    waitingReportedFor: verdict === "waiting" ? snapshot.head : cursor.waitingReportedFor,
    approvedReportedFor: verdict === "approved-green" ? snapshot.head : cursor.approvedReportedFor,
  };
}

/** Mark a comment fbs posted itself as seen, so its own reply doesn't wake the watcher. */
export function markSeen(cursor: Cursor, comment: Pick<Comment, "kind" | "id" | "updatedAt">): Cursor {
  return { ...cursor, comments: { ...cursor.comments, [commentKey(comment)]: comment.updatedAt } };
}

export interface Clock {
  now: () => number;
  sleep: (ms: number) => void;
}

export interface WatchOptions {
  intervalSeconds: number;
  /** null waits until a verdict; 0 takes one snapshot. */
  timeoutSeconds: number | null;
}

export const DEFAULT_INTERVAL_SECONDS = 60;
const MAX_WAIT_SECONDS = 300;
const RETRY_DELAY_SECONDS = 15;

/** `cursor` is what to save, or null to leave the saved one as it is. */
export type WatchResult = { report: Report; cursor: Cursor | null } | { report: QueryErrorReport; cursor: null };

/** Poll until a verdict. A GhError (gh missing, unauthenticated, no such PR) is not retried and propagates. */
export function watch(reader: GitHubReader, cursor: Cursor, options: WatchOptions, clock: Clock, progress: (line: string) => void): WatchResult {
  return watchAll([{ reader, cursor, label: {} }], options, clock, progress).result;
}

/** One PR of a watch: what reads it, its cursor, and what its progress lines carry to tell it apart. */
export interface WatchTarget {
  reader: GitHubReader;
  cursor: Cursor;
  label: Record<string, unknown>;
}

/**
 * Poll every target in order each interval until one has a verdict, and return the first that has; a timeout
 * reports the first target. A GhError is not retried and propagates.
 */
export function watchAll(targets: WatchTarget[], options: WatchOptions, clock: Clock, progress: (line: string) => void): { index: number; result: WatchResult } {
  const deadline = options.timeoutSeconds === null ? Number.POSITIVE_INFINITY : clock.now() + options.timeoutSeconds * 1000;
  const remaining = () => (deadline - clock.now()) / 1000;
  let wait = options.intervalSeconds;
  const lastHeads: (string | null)[] = targets.map(() => null);
  for (let poll = 1; ; poll++) {
    let first: Snapshot | null = null;
    for (const [index, { reader, cursor, label }] of targets.entries()) {
      const snapshot = readSnapshot(reader, cursor.pr, clock, remaining, (fields) => progress(JSON.stringify({ poll, ...label, ...fields })));
      if (snapshot instanceof QueryError) return { index, result: { report: { verdict: "query-error", pr: cursor.pr, error: snapshot.message }, cursor: null } };
      if (snapshot.head !== lastHeads[index]) wait = options.intervalSeconds;
      lastHeads[index] = snapshot.head;
      first ??= snapshot;

      const last = index === targets.length - 1;
      const left = remaining();
      const decided = classify(snapshot, cursor);
      const status = {
        poll,
        ...label,
        head: snapshot.head.slice(0, 7),
        pending: snapshot.checks.filter((c) => !isSettled(c)).length,
        failing: snapshot.checks.filter(isFailing).length,
        unseen: unseenComments(snapshot, cursor).length,
      };
      if (decided !== null) {
        progress(JSON.stringify({ ...status, verdict: decided }));
        return { index, result: { report: report(decided, snapshot, cursor), cursor: SAVING.includes(decided) ? advance(cursor, snapshot, decided) : null } };
      }
      if (last && left <= 0) {
        progress(JSON.stringify({ ...status, verdict: "timeout" }));
        return { index: 0, result: { report: report("timeout", first, targets[0].cursor), cursor: null } };
      }
      if (!last) {
        progress(JSON.stringify(status));
        continue;
      }
      const next = Math.min(wait, left);
      progress(JSON.stringify({ ...status, next }));
      clock.sleep(next * 1000);
      wait = Math.min(wait * 2, Math.max(MAX_WAIT_SECONDS, options.intervalSeconds));
    }
  }
}

/** Retry a transient failure with backoff until the deadline. */
function readSnapshot(reader: GitHubReader, pr: number, clock: Clock, remaining: () => number, progress: (fields: object) => void): Snapshot | QueryError {
  let delay = RETRY_DELAY_SECONDS;
  for (let attempt = 1; ; attempt++) {
    try {
      return reader.snapshot(pr);
    } catch (e) {
      if (!(e instanceof QueryError)) throw e;
      progress({ error: e.message, attempt });
      const left = remaining();
      if (left <= 0) return e;
      clock.sleep(Math.min(delay, left) * 1000);
      delay = Math.min(delay * 2, MAX_WAIT_SECONDS);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
