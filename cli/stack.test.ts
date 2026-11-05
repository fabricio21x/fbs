import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GhResult, GhRunner } from "./github";
import { campMarkerPath, writeLandToken } from "./guard";
import { land } from "./land";
import { run } from "./main";
import { syncStack } from "./stack";
import { readFeature, updateFeature } from "./status";
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fbs-stack-test-")));
  dirs.push(dir);
  return dir;
}

function commitFile(cwd: string, path: string, content: string, subject: string): string {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
  git(cwd, "add", path);
  git(cwd, "commit", "-q", "-m", subject);
  return git(cwd, "rev-parse", "HEAD");
}

const UNITS = [
  { slug: "f-a", unit: 1, pr: 31, branch: "feature/f-a", line: "B1" },
  { slug: "f-b", unit: 2, pr: 32, branch: "feature/f-b", line: "B2" },
  { slug: "f-c", unit: 3, pr: 33, branch: "feature/f-c", line: "B3" },
] as const;
type Slug = (typeof UNITS)[number]["slug"];
const unitOf = (slug: string) => UNITS.find((u) => u.slug === slug) as (typeof UNITS)[number];

interface Stack {
  work: string;
  origin: string;
  common: string;
}

/**
 * Feature f with units f-a, f-b and f-c stacked in order, each rewriting the same line of shared.txt, pushed to a bare
 * origin with their PRs recorded and stamped. `verdict` commits a verdict on f-a after the units above were cut.
 */
function stack(options: { verdict?: boolean; on?: string } = {}): Stack {
  const origin = join(tempDir(), "origin.git");
  git(dirname(origin), "init", "-q", "--bare", "-b", "main", origin);
  const work = join(tempDir(), "work");
  git(dirname(work), "init", "-q", "-b", "main", work);
  for (const [key, value] of [["user.name", "fbs"], ["user.email", "fbs@example.com"], ["commit.gpgsign", "false"]]) git(work, "config", key, value);
  git(work, "remote", "add", "origin", origin);
  let base = commitFile(work, "shared.txt", "a\nb\nc\n", "chore: init");
  git(work, "push", "-q", "origin", "main");
  const common = join(work, ".git");
  const dir = "docs/features/2026-10-21-f";
  mkdirSync(join(common, "fbs", "features"), { recursive: true });
  writeFileSync(join(common, "fbs", "features", "f.json"), JSON.stringify({ slug: "f", dir, size: "big", approvals: {}, pr: null }));
  let parent = "main";
  for (const u of UNITS) {
    git(work, "switch", "-q", "-c", u.branch);
    const tip = commitFile(work, "shared.txt", `a\n${u.line}\nc\n`, `feat: ${u.slug}`);
    const record = { slug: u.slug, dir: `${dir}/units/${u.slug}`, size: "big", approvals: {}, pr: u.pr, repo: "acme/app", unitOf: "f", unit: u.unit, branch: { name: u.branch, parent, base } };
    writeFileSync(join(common, "fbs", "features", `${u.slug}.json`), JSON.stringify(record));
    parent = u.branch;
    base = tip;
  }
  if (options.verdict) {
    git(work, "switch", "-q", "feature/f-a");
    commitFile(work, `${dir}/units/f-a/verdict.md`, "Verdict: pass\n", "docs: verify f-a");
  }
  git(work, "push", "-q", "origin", ...UNITS.map((u) => u.branch));
  for (const u of UNITS) restamp({ work, origin, common }, u.slug, true);
  git(work, "switch", "-q", options.on ?? "main");
  return { work, origin, common };
}

/** Stamp the unit at its PR head's tree and record that head as pushed, as verify and fbs push would. */
function restamp(s: Stack, slug: Slug, pushed = false): void {
  const path = join(s.common, "fbs", "features", `${slug}.json`);
  const record = JSON.parse(readFileSync(path, "utf8"));
  const head = git(s.origin, "rev-parse", `refs/heads/${unitOf(slug).branch}`);
  const stamp = { tree: git(s.origin, "rev-parse", `${head}^{tree}`), at: "2026-10-25", verdict: "pass", criteria: 1, evidence: `${record.dir}/verdict.md` };
  writeFileSync(path, JSON.stringify({ ...record, stamp, ...(pushed && { branch: { ...record.branch, pushed: head } }) }));
}

/** A gh that answers land's calls for every unit's PR, squash-merging the head into origin's main as GitHub would. */
function fakeGh(s: Stack) {
  const calls: string[][] = [];
  const squashes: Record<number, string> = {};
  const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: "" });
  const gh: GhRunner = (args) => {
    calls.push(args);
    const [, verb, number] = args;
    const u = UNITS.find((unit) => String(unit.pr) === number);
    const line = args.join(" ");
    if (line.startsWith("repo view acme/app")) return ok("main\n");
    if (verb === "edit") return ok("");
    if (u === undefined) return { code: 1, stdout: "", stderr: `unexpected gh ${line}` };
    const head = git(s.origin, "rev-parse", `refs/heads/${u.branch}`);
    if (verb === "view" && line.includes("state,isDraft")) {
      const facts = { state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", headRefOid: head, headRefName: u.branch, baseRefName: "main", title: `feat: ${u.slug}`, reviewDecision: "APPROVED" };
      return ok(JSON.stringify({ ...facts, author: { login: "alex" }, statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] }));
    }
    if (verb === "merge") {
      const tree = git(s.origin, "merge-tree", "--write-tree", "main", head).split("\n")[0];
      squashes[u.pr] = git(s.origin, "commit-tree", tree, "-p", "main", "-m", `feat: ${u.slug} (#${u.pr})`);
      git(s.origin, "update-ref", "refs/heads/main", squashes[u.pr]);
      return ok("");
    }
    if (verb === "view" && line.includes("headRefOid,mergeCommit")) {
      const merged = squashes[u.pr] !== undefined;
      return ok(JSON.stringify({ state: merged ? "MERGED" : "OPEN", headRefOid: head, mergeCommit: merged ? { oid: squashes[u.pr] } : null, baseRefName: "main" }));
    }
    if (verb === "view") return ok(JSON.stringify({ state: "MERGED", mergeCommit: { oid: squashes[u.pr] } }));
    return { code: 1, stdout: "", stderr: `unexpected gh ${line}` };
  };
  return { gh, calls };
}

const sync = (cwd: string, slug: string, gh: GhRunner) => syncStack(cwd, slug, gh, "2026-10-25").units;
/** The gh calls besides sync's PR state queries. */
const besidesViews = (calls: string[][]) => calls.filter((call) => call[1] !== "view");

/** Land `slug` as the user would: stamped at its PR head, with a fresh token. */
function landUnit(s: Stack, gh: GhRunner, slug: Slug) {
  restamp(s, slug);
  writeLandToken(s.common, { slug, at: NOW - 60_000, tree: readFeature(s.work, slug).stamp?.tree as string });
  return land(s.work, slug, gh, NOW, "2026-10-25");
}

const originTip = (s: Stack, slug: Slug) => git(s.origin, "rev-parse", `refs/heads/${unitOf(slug).branch}`);
const show = (s: Stack, rev: string, path: string) => git(s.origin, "show", `${rev}:${path}`);
/** The subjects of the commits origin's `branch` has beyond origin's main, oldest first: what its PR lists. */
const ownCommits = (s: Stack, branch: string) => git(s.origin, "log", "--reverse", "--format=%s", `main..refs/heads/${branch}`).split("\n").filter((l) => l !== "");

describe("land restacks the unit above", () => {
  test("a three-unit stack lands bottom-up, each restack keeping the trees and leaving each PR only its own commits", () => {
    const s = stack();
    const { gh } = fakeGh(s);
    const trees = () => UNITS.map((u) => git(s.origin, "rev-parse", `refs/heads/${u.branch}^{tree}`));
    const before = trees();
    expect(landUnit(s, gh, "f-a")).toMatchObject({ restack: { slug: "f-b", done: true, treeChanged: false }, stacked: [{ slug: "f-c", pr: 33, done: true, treeChanged: false }] });
    expect(trees()).toEqual(before);
    expect(ownCommits(s, "feature/f-b")).toEqual(["feat: f-b"]);
    expect(ownCommits(s, "feature/f-c")).toEqual(["feat: f-b", "feat: f-c"]);
    expect(readFeature(s.work, "f-b").branch).toMatchObject({ parent: "main" });
    expect(readFeature(s.work, "f-c").branch).toMatchObject({ parent: "feature/f-b", base: originTip(s, "f-b") });
    expect(landUnit(s, gh, "f-b")).toMatchObject({ restack: { slug: "f-c", done: true, treeChanged: false } });
    expect(ownCommits(s, "feature/f-c")).toEqual(["feat: f-c"]);
    expect(readFeature(s.work, "f-c").branch).toMatchObject({ parent: "main" });
    expect(landUnit(s, gh, "f-c")).toMatchObject({ slug: "f-c", restack: null });
    expect(show(s, git(s.origin, "rev-parse", "main"), "shared.txt")).toBe("a\nB3\nc");
  });

  test("a commit on the lower unit after the upper one was cut ships in its squash, and the restack carries it", () => {
    const s = stack({ verdict: true });
    const { gh } = fakeGh(s);
    expect(landUnit(s, gh, "f-a")).toMatchObject({ restack: { slug: "f-b", done: true, treeChanged: true } });
    const restacked = originTip(s, "f-b");
    expect(show(s, restacked, "docs/features/2026-10-21-f/units/f-a/verdict.md")).toBe("Verdict: pass");
    expect(show(s, restacked, "shared.txt")).toBe("a\nB2\nc");
    expect(landUnit(s, gh, "f-b")).toMatchObject({ restack: { slug: "f-c", done: true, treeChanged: true } });
    expect(show(s, originTip(s, "f-c"), "shared.txt")).toBe("a\nB3\nc");
  });
});

test("a restack that carries a local commit nobody stamped reports the tree changed", () => {
  const s = stack();
  git(s.work, "switch", "-q", "feature/f-b");
  commitFile(s.work, "wip.txt", "wip\n", "feat: unstamped");
  git(s.work, "switch", "-q", "main");
  expect(landUnit(s, fakeGh(s).gh, "f-a")).toMatchObject({ restack: { slug: "f-b", done: true, treeChanged: true } });
  expect(show(s, originTip(s, "f-b"), "wip.txt")).toBe("wip");
});

test("land leaves a unit above alone when it isn't stacked on the landed unit", () => {
  const s = stack();
  updateFeature(s.work, "f-b", (rec) => ({ ...rec, branch: { ...(rec.branch as NonNullable<typeof rec.branch>), parent: "main" } }));
  const before = originTip(s, "f-b");
  const { gh, calls } = fakeGh(s);
  expect(landUnit(s, gh, "f-a")).toMatchObject({ slug: "f-a", restack: null });
  expect(originTip(s, "f-b")).toBe(before);
  expect(calls.some((call) => call[1] === "edit")).toBe(false);
});

describe("fbs stack sync", () => {
  const local = (s: Stack, slug: Slug) => git(s.work, "rev-parse", unitOf(slug).branch);
  const tips = (s: Stack) => UNITS.map((u) => [local(s, u.slug), originTip(s, u.slug)]);
  const quiet = { fastForwarded: false, merged: null, treeChanged: false, retargeted: false, done: true };

  /** Squash `slug`'s PR into origin's main and record it landed, without restacking anything. */
  function landedWithoutRestack(s: Stack, slug: Slug): string {
    const head = originTip(s, slug);
    const tree = git(s.origin, "merge-tree", "--write-tree", "main", head).split("\n")[0];
    const squash = git(s.origin, "commit-tree", tree, "-p", "main", "-m", `feat: ${slug} (#${unitOf(slug).pr})`);
    git(s.origin, "update-ref", "refs/heads/main", squash);
    updateFeature(s.work, slug, (rec) => ({ ...rec, landed: { pr: unitOf(slug).pr, repo: "acme/app", commit: squash, at: "2026-10-25", head } }));
    return squash;
  }

  test("after the bottom unit landed, the next is rebased onto main, pushed and retargeted, and the one above is rebased onto it", () => {
    const s = stack();
    const squash = landedWithoutRestack(s, "f-a");
    const { gh, calls } = fakeGh(s);
    const synced = sync(s.work, "f", gh);
    expect(synced).toEqual([
      { slug: "f-b", unit: 2, ...quiet, merged: "origin/main", retargeted: true, pushNeeded: false },
      { slug: "f-c", unit: 3, ...quiet, merged: "feature/f-b", pushNeeded: false },
    ]);
    expect(besidesViews(calls)).toEqual([["pr", "edit", "32", "--repo", "acme/app", "--base", "main"]]);
    expect(tips(s).slice(1).every(([here, there]) => here === there)).toBe(true);
    expect(readFeature(s.work, "f-b").branch).toEqual({ name: "feature/f-b", parent: "main", base: squash, pushed: local(s, "f-b") });
    expect(readFeature(s.work, "f-c").branch).toMatchObject({ parent: "feature/f-b", base: local(s, "f-b"), pushed: local(s, "f-c") });
    expect(ownCommits(s, "feature/f-b")).toEqual(["feat: f-b"]);
    expect(ownCommits(s, "feature/f-c")).toEqual(["feat: f-b", "feat: f-c"]);
    expect(landUnit(s, gh, "f-b")).toMatchObject({ restack: { slug: "f-c", done: true, treeChanged: false } });
  });

  test("a verdict committed on the lower unit after the upper ones were cut is merged up the stack, and a second run merges nothing", () => {
    const s = stack({ verdict: true });
    const verdict = "docs/features/2026-10-21-f/units/f-a/verdict.md";
    const first = sync(s.work, "f-b", fakeGh(s).gh);
    expect(first).toEqual([
      { slug: "f-a", unit: 1, ...quiet, pushNeeded: false },
      { slug: "f-b", unit: 2, ...quiet, merged: "feature/f-a", treeChanged: true, pushNeeded: true },
      { slug: "f-c", unit: 3, ...quiet, merged: "feature/f-b", treeChanged: true, pushNeeded: true },
    ]);
    expect(git(s.work, "show", `${local(s, "f-c")}:${verdict}`)).toBe("Verdict: pass");
    expect(git(s.work, "show", `${local(s, "f-c")}:shared.txt`)).toBe("a\nB3\nc");
    const before = tips(s);
    expect(sync(s.work, "f", fakeGh(s).gh)).toEqual(first.map((unit) => ({ ...unit, merged: null })));
    expect(tips(s)).toEqual(before);
  });

  test("after land restacked units 2 and 3, sync has nothing left to do", () => {
    const s = stack();
    const { gh } = fakeGh(s);
    landUnit(s, gh, "f-a");
    const before = tips(s);
    expect(sync(s.work, "f", gh)).toEqual([
      { slug: "f-b", unit: 2, ...quiet, pushNeeded: false },
      { slug: "f-c", unit: 3, ...quiet, pushNeeded: false },
    ]);
    expect(tips(s)).toEqual(before);
    expect(git(s.work, "merge-base", "--is-ancestor", local(s, "f-b"), local(s, "f-c"))).toBe("");
  });

  test("a moved default branch leaves a unit based on it alone: camp merges the base, not sync", () => {
    const s = stack();
    const main = git(s.origin, "rev-parse", "main");
    git(s.origin, "update-ref", "refs/heads/main", git(s.origin, "commit-tree", `${main}^{tree}`, "-p", main, "-m", "docs: elsewhere"));
    const before = tips(s);
    expect(sync(s.work, "f", fakeGh(s).gh)).toEqual(UNITS.map((u) => ({ slug: u.slug, unit: u.unit, ...quiet, pushNeeded: false })));
    expect(tips(s)).toEqual(before);
  });

  /** Commit `path` on origin's main, as another PR landing would. */
  function commitOnOriginMain(s: Stack, path: string, content: string, subject: string): void {
    git(s.work, "fetch", "-q", "origin", "main");
    git(s.work, "switch", "-q", "--detach", "origin/main");
    commitFile(s.work, path, content, subject);
    git(s.work, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(s.work, "switch", "-q", "main");
  }

  /** f-b cut again from origin's main after f-a landed, as a follow-up unit is, with f-c dropped. */
  function followUpFromMain(s: Stack): void {
    git(s.work, "fetch", "-q", "origin", "main");
    rmSync(join(s.common, "fbs", "features", "f-c.json"));
    git(s.work, "push", "-q", "origin", ":refs/heads/feature/f-c", ":refs/heads/feature/f-b");
    git(s.work, "branch", "-q", "-D", "feature/f-b", "feature/f-c");
    git(s.work, "switch", "-q", "-c", "feature/f-b", "origin/main");
    const tip = commitFile(s.work, "b.txt", "b\n", "feat: f-b follow-up");
    git(s.work, "push", "-q", "origin", "feature/f-b");
    const base = git(s.work, "rev-parse", "origin/main");
    updateFeature(s.work, "f-b", ({ stamp: _, ...rec }) => ({ ...rec, branch: { name: "feature/f-b", parent: "main", base, pushed: tip } }));
    git(s.work, "switch", "-q", "main");
  }

  test.each([
    ["a later edit of the landed lines", "a\nX\nc\n"],
    ["a revert of the landed unit", "a\nb\nc\n"],
  ])("a follow-up unit cut from main after %s is only fast-forwarded, never merged with the landed head", (_, content) => {
    const s = stack();
    landedWithoutRestack(s, "f-a");
    commitOnOriginMain(s, "shared.txt", content, "fix: shared");
    followUpFromMain(s);
    commitOnOriginMain(s, "other.txt", "o\n", "chore: other");
    const before = local(s, "f-b");
    const { gh, calls } = fakeGh(s);
    expect(sync(s.work, "f", gh)).toEqual([{ slug: "f-b", unit: 2, ...quiet, pushNeeded: false }]);
    expect(local(s, "f-b")).toBe(before);
    expect(git(s.work, "show", "feature/f-b:shared.txt")).toBe(content.trimEnd());
    expect(besidesViews(calls)).toEqual([]);
  });

  test("a unit restacked onto main is not merged with main again when main moves", () => {
    const s = stack();
    const { gh } = fakeGh(s);
    landUnit(s, gh, "f-a");
    sync(s.work, "f", gh);
    commitOnOriginMain(s, "other.txt", "o\n", "chore: other");
    const before = tips(s);
    const synced = sync(s.work, "f", gh);
    expect(synced.map((unit) => unit.merged)).toEqual([null, null]);
    expect(tips(s)).toEqual(before);
  });

  test("a unit with no PR and no push above a landed unit is restacked and recorded on main, but not pushed", () => {
    const s = stack();
    git(s.work, "push", "-q", "origin", ":refs/heads/feature/f-b");
    updateFeature(s.work, "f-b", ({ repo: _, ...rec }) => ({ ...rec, pr: null, branch: { name: "feature/f-b", parent: "feature/f-a", base: rec.branch?.base as string } }));
    const squash = landedWithoutRestack(s, "f-a");
    const { gh, calls } = fakeGh(s);
    expect(sync(s.work, "f", gh)[0]).toEqual({ slug: "f-b", unit: 2, ...quiet, merged: "origin/main", pushNeeded: false });
    expect(readFeature(s.work, "f-b").branch).toEqual({ name: "feature/f-b", parent: "main", base: squash });
    expect(Bun.spawnSync(["git", "rev-parse", "-q", "--verify", "refs/heads/feature/f-b"], { cwd: s.origin, env: isolatedGitEnv() }).exitCode).toBe(1);
    expect(besidesViews(calls)).toEqual([]);
  });

  test("a conflict stops the sync with exit 1 and leaves every branch as it was", () => {
    const s = stack();
    git(s.work, "switch", "-q", "feature/f-a");
    commitFile(s.work, "shared.txt", "a\nB1 fixed\nc\n", "fix: f-a line");
    git(s.work, "switch", "-q", "main");
    const before = tips(s);
    const out: string[] = [];
    const deps = { gh: fakeGh(s).gh, now: () => NOW, sleep: () => {}, stdin: () => "" };
    expect(run(["stack", "sync", "f"], { cwd: s.work, today: "2026-10-25", out: (l) => out.push(l), err: () => {} }, deps)).toBe(1);
    expect(JSON.parse(out[0])).toEqual({
      units: [
        { slug: "f-a", unit: 1, ...quiet, treeChanged: true, pushNeeded: true },
        { slug: "f-b", unit: 2, ...quiet, done: false, pushNeeded: false, kind: "conflict", reason: "merging feature/f-a into feature/f-b conflicts; feature/f-b is left as it was, merge it by hand" },
      ],
    });
    expect(tips(s)).toEqual(before);
    expect(git(s.work, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  });

  test("a retarget that fails still restacks the unit above, and the next sync retargets without pushing anything new", () => {
    const s = stack();
    const squash = landedWithoutRestack(s, "f-a");
    const { gh, calls } = fakeGh(s);
    const failing: GhRunner = (args, cwd) => (args[1] === "edit" ? { code: 1, stdout: "", stderr: "HTTP 502" } : gh(args, cwd));
    expect(sync(s.work, "f", failing)).toEqual([
      { slug: "f-b", unit: 2, ...quiet, merged: "origin/main", done: false, pushNeeded: false, kind: "retarget-failed", reason: "pushed feature/f-b, but gh pr edit could not retarget PR #32 to main: HTTP 502" },
      { slug: "f-c", unit: 3, ...quiet, merged: "feature/f-b", pushNeeded: false },
    ]);
    const pushed = originTip(s, "f-b");
    expect(readFeature(s.work, "f-b").branch).toMatchObject({ parent: "feature/f-a", base: squash, pushed });
    expect(ownCommits(s, "feature/f-c")).toEqual(["feat: f-b", "feat: f-c"]);
    expect(sync(s.work, "f", gh)).toEqual([
      { slug: "f-b", unit: 2, ...quiet, retargeted: true, pushNeeded: false },
      { slug: "f-c", unit: 3, ...quiet, pushNeeded: false },
    ]);
    expect(originTip(s, "f-b")).toBe(pushed);
    expect(readFeature(s.work, "f-b").branch).toMatchObject({ parent: "main", pushed });
    expect(calls.filter((call) => call[1] === "edit")).toHaveLength(1);
  });

  test("a squash not on origin's main yet stops the restack before anything moves", () => {
    const s = stack();
    const head = originTip(s, "f-a");
    const squash = git(s.origin, "commit-tree", `${head}^{tree}`, "-p", "main", "-m", "feat: f-a (#31)");
    git(s.origin, "update-ref", "refs/heads/pending", squash);
    git(s.work, "fetch", "-q", "origin", "pending");
    updateFeature(s.work, "f-a", (rec) => ({ ...rec, landed: { pr: 31, repo: "acme/app", commit: squash, at: "2026-10-25", head } }));
    const before = tips(s);
    expect(sync(s.work, "f", fakeGh(s).gh)).toEqual([
      { slug: "f-b", unit: 2, ...quiet, done: false, pushNeeded: false, kind: "not-merged-yet", reason: `the squash commit ${squash} isn't on origin's main yet` },
    ]);
    expect(tips(s)).toEqual(before);
  });

  test("a landed head origin can't serve falls back to the base the unit was cut at", () => {
    const s = stack();
    landedWithoutRestack(s, "f-a");
    updateFeature(s.work, "f-a", (rec) => ({ ...rec, landed: { ...(rec.landed as NonNullable<typeof rec.landed>), head: "1".repeat(40) } }));
    expect(sync(s.work, "f", fakeGh(s).gh)[0]).toMatchObject({ slug: "f-b", merged: "origin/main", done: true });
    expect(ownCommits(s, "feature/f-b")).toEqual(["feat: f-b"]);
  });

  test("a unit still on the pre-squash history of a restacked unit below is stopped, not merged", () => {
    const s = stack();
    landedWithoutRestack(s, "f-a");
    git(s.work, "fetch", "-q", "origin", "main");
    // f-b restacked by hand, as a cascade that stopped below f-c leaves it, with f-c still on f-b's old tip.
    git(s.work, "rebase", "-q", "--onto", "origin/main", originTip(s, "f-a"), "feature/f-b");
    git(s.work, "switch", "-q", "main");
    updateFeature(s.work, "f-b", (rec) => ({ ...rec, branch: { ...(rec.branch as NonNullable<typeof rec.branch>), parent: "main" } }));
    git(s.work, "push", "-q", "-f", "origin", "feature/f-b");
    const before = local(s, "f-c");
    expect(sync(s.work, "f", fakeGh(s).gh)[1]).toMatchObject({ slug: "f-c", done: false, kind: "diverged" });
    expect(local(s, "f-c")).toBe(before);
  });

  test("a conflict in a unit checked out in another worktree leaves that worktree as it was", () => {
    const s = stack();
    const linked = join(tempDir(), "linked");
    git(s.work, "worktree", "add", "-q", linked, "feature/f-b");
    git(s.work, "switch", "-q", "feature/f-a");
    commitFile(s.work, "shared.txt", "a\nB1 fixed\nc\n", "fix: f-a line");
    git(s.work, "switch", "-q", "main");
    const before = git(linked, "rev-parse", "HEAD");
    expect(sync(s.work, "f", fakeGh(s).gh)[1]).toMatchObject({ slug: "f-b", done: false, kind: "conflict" });
    expect(git(linked, "rev-parse", "HEAD")).toBe(before);
    expect(git(linked, "status", "--porcelain")).toBe("");
    expect(Bun.spawnSync(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: linked, env: isolatedGitEnv() }).exitCode).toBe(1);
  });

  test("a checked-out unit is merged in place when clean and refused when dirty", () => {
    const s = stack({ on: "feature/f-b" });
    git(s.work, "switch", "-q", "feature/f-a");
    commitFile(s.work, "api.txt", "api\n", "feat: f-a api");
    git(s.work, "switch", "-q", "feature/f-b");
    writeFileSync(join(s.work, "scratch.txt"), "dirty\n");
    const before = tips(s);
    expect(sync(s.work, "f", fakeGh(s).gh)[1]).toEqual({
      slug: "f-b",
      unit: 2,
      ...quiet,
      done: false,
      pushNeeded: false,
      kind: "dirty",
      reason: `feature/f-b is checked out at ${s.work} with uncommitted changes; commit or stash them, then sync again`,
    });
    expect(tips(s)).toEqual(before);
    rmSync(join(s.work, "scratch.txt"));
    expect(sync(s.work, "f", fakeGh(s).gh)[1]).toMatchObject({ merged: "feature/f-a", treeChanged: true, done: true });
    expect(readFileSync(join(s.work, "api.txt"), "utf8")).toBe("api\n");
    expect(git(s.work, "status", "--porcelain")).toBe("");
  });

  test("a unit behind origin is fast-forwarded, checked out or not, and one that diverged stops the sync", () => {
    for (const on of ["main", "feature/f-b"]) {
      const s = stack({ on });
      const ahead = git(s.origin, "commit-tree", `${originTip(s, "f-b")}^{tree}`, "-p", originTip(s, "f-b"), "-m", "fix: from elsewhere");
      git(s.origin, "update-ref", "refs/heads/feature/f-b", ahead);
      const synced = sync(s.work, "f", fakeGh(s).gh);
      expect(synced[1]).toEqual({ slug: "f-b", unit: 2, ...quiet, fastForwarded: true, pushNeeded: false });
      expect(synced[2]).toMatchObject({ merged: "feature/f-b", done: true });
      expect(local(s, "f-b")).toBe(ahead);
    }
    const s = stack();
    const ahead = git(s.origin, "commit-tree", `${originTip(s, "f-b")}^{tree}`, "-p", originTip(s, "f-b"), "-m", "fix: from elsewhere");
    git(s.origin, "update-ref", "refs/heads/feature/f-b", ahead);
    git(s.work, "switch", "-q", "feature/f-b");
    commitFile(s.work, "mine.txt", "mine\n", "fix: here");
    const synced = sync(s.work, "f", fakeGh(s).gh);
    expect(synced).toHaveLength(2);
    expect(synced[1]).toMatchObject({ done: false, kind: "diverged", reason: "diverged: feature/f-b and origin/feature/f-b each have commits the other lacks; merge origin/feature/f-b into it by hand" });
  });
});

describe("a merge outside fbs land", () => {
  const VIEW = "state,headRefOid,mergeCommit,baseRefName";
  /** `gh`, except that sync's state query for each PR in `answers` gets that answer. */
  function answering(gh: GhRunner, answers: Record<number, GhResult>): GhRunner {
    return (args, cwd) => (args[1] === "view" && args.includes(VIEW) && answers[Number(args[2])] !== undefined ? answers[Number(args[2])] : gh(args, cwd));
  }
  const merged = (head: string, commit: string): GhResult => ({ code: 0, stdout: JSON.stringify({ state: "MERGED", headRefOid: head, mergeCommit: { oid: commit }, baseRefName: "main" }), stderr: "" });

  test.each([
    ["a squash", (_head: string, tree: string) => ["commit-tree", tree, "-p", "main", "-m", "feat: f-a (#31)"]],
    ["a merge commit", (head: string, tree: string) => ["commit-tree", tree, "-p", "main", "-p", head, "-m", "Merge pull request #31"]],
    // A rebase-merge rewrites the commit; the distinct message stands in for GitHub's new committer.
    ["a rebase-merge", (_head: string, tree: string) => ["commit-tree", tree, "-p", "main", "-m", "feat: f-a", "-m", "rebased"]],
  ])("%s is recorded as landed by outside, and the units above are restacked to their own commits", (_, commitArgs) => {
    const s = stack();
    const head = originTip(s, "f-a");
    const tree = git(s.origin, "merge-tree", "--write-tree", "main", head).split("\n")[0];
    const commit = git(s.origin, ...commitArgs(head, tree));
    git(s.origin, "update-ref", "refs/heads/main", commit);
    mkdirSync(dirname(campMarkerPath(s.common, "f-a")), { recursive: true });
    writeFileSync(campMarkerPath(s.common, "f-a"), "");
    const { gh, calls } = fakeGh(s);
    const result = syncStack(s.work, "f", answering(gh, { 31: merged(head, commit) }), "2026-11-01");
    expect(result.outside).toEqual([{ slug: "f-a", pr: 31, kind: "landed", reason: `PR #31 was merged outside fbs land; recorded f-a as landed at ${commit}` }]);
    expect(readFeature(s.work, "f-a").landed).toEqual({ pr: 31, repo: "acme/app", commit, at: "2026-11-01", head, by: "outside" });
    expect(existsSync(campMarkerPath(s.common, "f-a"))).toBe(false);
    expect(result.units.map((unit) => [unit.slug, unit.done, unit.merged])).toEqual([["f-b", true, "origin/main"], ["f-c", true, "feature/f-b"]]);
    expect(ownCommits(s, "feature/f-b")).toEqual(["feat: f-b"]);
    expect(ownCommits(s, "feature/f-c")).toEqual(["feat: f-b", "feat: f-c"]);
    expect(readFeature(s.work, "f-b").branch).toMatchObject({ parent: "main" });
    expect(calls.filter((call) => call[1] === "view").map((call) => call[2])).toEqual(["32", "33"]);
  });

  /** Squash origin's `head` into its main, as GitHub's merge button would, and return the squash. */
  function squashOnOrigin(s: Stack, head: string, subject: string): string {
    const tree = git(s.origin, "merge-tree", "--write-tree", "main", head).split("\n")[0];
    const squash = git(s.origin, "commit-tree", tree, "-p", "main", "-m", subject);
    git(s.origin, "update-ref", "refs/heads/main", squash);
    return squash;
  }

  test("a plain feature cut from a unit merged outside is restacked as land would, and reported under it", () => {
    const s = stack();
    git(s.work, "switch", "-q", "-c", "feature/g", "feature/f-a");
    const tip = commitFile(s.work, "g.txt", "g\n", "feat: g");
    git(s.work, "push", "-q", "origin", "feature/g");
    git(s.work, "switch", "-q", "main");
    const branch = { name: "feature/g", parent: "feature/f-a", base: originTip(s, "f-a"), pushed: tip };
    writeFileSync(join(s.common, "fbs", "features", "g.json"), JSON.stringify({ slug: "g", dir: "docs/features/2026-10-21-g", size: "mid", approvals: {}, pr: 40, repo: "acme/app", branch }));
    const head = originTip(s, "f-a");
    const squash = squashOnOrigin(s, head, "feat: f-a (#31)");
    const { gh, calls } = fakeGh(s);
    const result = syncStack(s.work, "f", answering(gh, { 31: merged(head, squash) }), "2026-11-01");
    expect(result.outside).toMatchObject([{ slug: "f-a", kind: "landed", stacked: [{ slug: "g", pr: 40, done: true, treeChanged: false }] }]);
    expect(ownCommits(s, "feature/g")).toEqual(["feat: g"]);
    expect(readFeature(s.work, "g").branch).toMatchObject({ parent: "main" });
    expect(calls).toContainEqual(["pr", "edit", "40", "--repo", "acme/app", "--base", "main"]);
  });

  test("a PR merged into another branch is reported and not recorded", () => {
    const s = stack();
    const answer = { code: 0, stdout: JSON.stringify({ state: "MERGED", headRefOid: originTip(s, "f-a"), mergeCommit: { oid: "e".repeat(40) }, baseRefName: "release" }), stderr: "" };
    const result = syncStack(s.work, "f", answering(fakeGh(s).gh, { 31: answer }), "2026-11-01");
    expect(result.outside).toEqual([{ slug: "f-a", pr: 31, kind: "merged-elsewhere", reason: "PR #31 was merged into release, not main; f-a is left as it was" }]);
    expect(readFeature(s.work, "f-a").landed).toBeUndefined();
    expect(result.units.every((unit) => unit.done)).toBe(true);
  });

  test("a merged head newer than the unit's tip here lands with no warning, and the unit above keeps only its own commits", () => {
    const s = stack();
    const newer = git(s.origin, "commit-tree", `${originTip(s, "f-a")}^{tree}`, "-p", originTip(s, "f-a"), "-m", "fix: f-a from elsewhere");
    git(s.origin, "update-ref", "refs/heads/feature/f-a", newer);
    const squash = squashOnOrigin(s, newer, "feat: f-a (#31)");
    const result = syncStack(s.work, "f", answering(fakeGh(s).gh, { 31: merged(newer, squash) }), "2026-11-01");
    expect(result.outside).toEqual([{ slug: "f-a", pr: 31, kind: "landed", reason: `PR #31 was merged outside fbs land; recorded f-a as landed at ${squash}` }]);
    expect(ownCommits(s, "feature/f-b")).toEqual(["feat: f-b"]);
  });

  test("commits here that the merged head lacks are named in a warning", () => {
    const s = stack();
    const head = originTip(s, "f-a");
    git(s.work, "switch", "-q", "feature/f-a");
    commitFile(s.work, "late.txt", "late\n", "fix: f-a late");
    git(s.work, "switch", "-q", "main");
    const squash = squashOnOrigin(s, head, "feat: f-a (#31)");
    const result = syncStack(s.work, "f", answering(fakeGh(s).gh, { 31: merged(head, squash) }), "2026-11-01");
    expect(result.outside[0].reason).toBe(`PR #31 was merged outside fbs land; recorded f-a as landed at ${squash}; warning: 1 commit on feature/f-a isn't in the merged head, so it didn't land`);
  });

  test("an unpushed merge of main on the unit's branch here is not named as dropped", () => {
    const s = stack();
    const head = originTip(s, "f-a");
    const main = git(s.origin, "rev-parse", "main");
    git(s.origin, "update-ref", "refs/heads/main", git(s.origin, "commit-tree", `${main}^{tree}`, "-p", main, "-m", "chore: other"));
    git(s.work, "fetch", "-q", "origin", "main");
    git(s.work, "switch", "-q", "feature/f-a");
    git(s.work, "merge", "-q", "--no-ff", "--no-edit", "origin/main");
    git(s.work, "switch", "-q", "main");
    const squash = squashOnOrigin(s, head, "feat: f-a (#31)");
    const result = syncStack(s.work, "f", answering(fakeGh(s).gh, { 31: merged(head, squash) }), "2026-11-01");
    expect(result.outside[0].reason).toBe(`PR #31 was merged outside fbs land; recorded f-a as landed at ${squash}`);
  });

  test("the last unit merged outside removes the feature's camp marker too", () => {
    const s = stack();
    const main = git(s.origin, "rev-parse", "main");
    for (const slug of ["f-b", "f-c"] as const) updateFeature(s.work, slug, (rec) => ({ ...rec, landed: { pr: unitOf(slug).pr, repo: "acme/app", commit: main, at: "2026-10-25" } }));
    for (const slug of ["f", "f-a"]) {
      mkdirSync(dirname(campMarkerPath(s.common, slug)), { recursive: true });
      writeFileSync(campMarkerPath(s.common, slug), "");
    }
    const head = originTip(s, "f-a");
    const squash = squashOnOrigin(s, head, "feat: f-a (#31)");
    syncStack(s.work, "f", answering(fakeGh(s).gh, { 31: merged(head, squash) }), "2026-11-01");
    expect(["f", "f-a"].map((slug) => existsSync(campMarkerPath(s.common, slug)))).toEqual([false, false]);
  });

  describe("a plain feature cut from another feature's branch", () => {
    /** Plain feature p on main with PR 50, and q cut from p's branch with PR 51, both pushed. */
    function plainPair(): Stack & { pTip: string } {
      const origin = join(tempDir(), "origin.git");
      git(dirname(origin), "init", "-q", "--bare", "-b", "main", origin);
      const work = join(tempDir(), "work");
      git(dirname(work), "init", "-q", "-b", "main", work);
      git(work, "remote", "add", "origin", origin);
      const base = commitFile(work, "shared.txt", "a\n", "chore: init");
      git(work, "push", "-q", "origin", "main");
      git(work, "switch", "-q", "-c", "feature/p");
      const pTip = commitFile(work, "p.txt", "p\n", "feat: p");
      git(work, "switch", "-q", "-c", "feature/q");
      const qTip = commitFile(work, "q.txt", "q\n", "feat: q");
      git(work, "push", "-q", "origin", "feature/p", "feature/q");
      git(work, "switch", "-q", "main");
      const common = join(work, ".git");
      mkdirSync(join(common, "fbs", "features"), { recursive: true });
      const record = (slug: string, pr: number, branch: object) => ({ slug, dir: `docs/features/2026-10-21-${slug}`, size: "mid", approvals: {}, pr, repo: "acme/app", branch });
      writeFileSync(join(common, "fbs", "features", "p.json"), JSON.stringify(record("p", 50, { name: "feature/p", parent: "main", base, pushed: pTip })));
      writeFileSync(join(common, "fbs", "features", "q.json"), JSON.stringify(record("q", 51, { name: "feature/q", parent: "feature/p", base: pTip, pushed: qTip })));
      return { work, origin, common, pTip };
    }

    /** A gh where every PR is open unless `answers` says otherwise, and edits succeed. */
    function plainGh(answers: Record<number, GhResult> = {}) {
      const calls: string[][] = [];
      const open: GhResult = { code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: "0".repeat(40), mergeCommit: null, baseRefName: "main" }), stderr: "" };
      const gh: GhRunner = (args) => {
        calls.push(args);
        if (args[1] === "edit") return { code: 0, stdout: "", stderr: "" };
        return answers[Number(args[2])] ?? open;
      };
      return { gh, calls };
    }

    test("its parent squash-merged outside fbs is recorded, and it is restacked to its own commits and retargeted", () => {
      const s = plainPair();
      const squash = squashOnOrigin(s, s.pTip, "feat: p (#50)");
      const { gh, calls } = plainGh({ 50: merged(s.pTip, squash) });
      const out: string[] = [];
      const deps = { gh, now: () => NOW, sleep: () => {}, stdin: () => "" };
      expect(run(["stack", "sync", "q"], { cwd: s.work, today: "2026-11-01", out: (l) => out.push(l), err: () => {} }, deps)).toBe(0);
      const restack = { slug: "q", pr: 51, done: true, treeChanged: false };
      expect(JSON.parse(out[0])).toEqual({
        units: [],
        outside: [{ slug: "p", pr: 50, kind: "landed", reason: `PR #50 was merged outside fbs land; recorded p as landed at ${squash}`, stacked: [restack] }],
        restack,
      });
      expect(readFeature(s.work, "p").landed).toEqual({ pr: 50, repo: "acme/app", commit: squash, at: "2026-11-01", head: s.pTip, by: "outside" });
      expect(ownCommits(s, "feature/q")).toEqual(["feat: q"]);
      expect(readFeature(s.work, "q").branch).toMatchObject({ parent: "main", base: squash });
      expect(calls).toEqual([
        ["pr", "view", "51", "--repo", "acme/app", "--json", "state,headRefOid,mergeCommit,baseRefName"],
        ["pr", "view", "50", "--repo", "acme/app", "--json", "state,headRefOid,mergeCommit,baseRefName"],
        ["pr", "edit", "51", "--repo", "acme/app", "--base", "main"],
      ]);
    });

    test("a parent fbs land landed, when its restack didn't happen, is restacked without asking gh about the parent", () => {
      const s = plainPair();
      const squash = squashOnOrigin(s, s.pTip, "feat: p (#50)");
      updateFeature(s.work, "p", (rec) => ({ ...rec, landed: { pr: 50, repo: "acme/app", commit: squash, at: "2026-10-25", head: s.pTip } }));
      const { gh, calls } = plainGh();
      expect(syncStack(s.work, "q", gh, "2026-11-01")).toEqual({ units: [], outside: [], restack: { slug: "q", pr: 51, done: true, treeChanged: false } });
      expect(ownCommits(s, "feature/q")).toEqual(["feat: q"]);
      expect(calls).toEqual([
        ["pr", "view", "51", "--repo", "acme/app", "--json", "state,headRefOid,mergeCommit,baseRefName"],
        ["pr", "edit", "51", "--repo", "acme/app", "--base", "main"],
      ]);
    });

    test("one based on the default branch with its PR open has nothing to do", () => {
      const s = plainPair();
      const { gh, calls } = plainGh();
      expect(syncStack(s.work, "p", gh, "2026-11-01")).toEqual({ units: [], outside: [], restack: null });
      expect(calls).toEqual([["pr", "view", "50", "--repo", "acme/app", "--json", "state,headRefOid,mergeCommit,baseRefName"]]);
    });

    test("its own PR squash-merged outside fbs, with nothing cut from it, is recorded as landed", () => {
      const s = plainPair();
      rmSync(join(s.common, "fbs", "features", "q.json"));
      mkdirSync(dirname(campMarkerPath(s.common, "p")), { recursive: true });
      writeFileSync(campMarkerPath(s.common, "p"), "");
      const squash = squashOnOrigin(s, s.pTip, "feat: p (#50)");
      const out: string[] = [];
      const deps = { gh: plainGh({ 50: merged(s.pTip, squash) }).gh, now: () => NOW, sleep: () => {}, stdin: () => "" };
      expect(run(["stack", "sync", "p"], { cwd: s.work, today: "2026-11-01", out: (l) => out.push(l), err: () => {} }, deps)).toBe(0);
      expect(JSON.parse(out[0])).toEqual({ units: [], outside: [{ slug: "p", pr: 50, kind: "landed", reason: `PR #50 was merged outside fbs land; recorded p as landed at ${squash}` }], restack: null });
      expect(readFeature(s.work, "p").landed).toEqual({ pr: 50, repo: "acme/app", commit: squash, at: "2026-11-01", head: s.pTip, by: "outside" });
      expect(existsSync(campMarkerPath(s.common, "p"))).toBe(false);
    });

    test("its own PR merged outside fbs restacks the plain feature cut from it", () => {
      const s = plainPair();
      const squash = squashOnOrigin(s, s.pTip, "feat: p (#50)");
      const { gh, calls } = plainGh({ 50: merged(s.pTip, squash) });
      const result = syncStack(s.work, "p", gh, "2026-11-01");
      expect(result.outside).toMatchObject([{ slug: "p", kind: "landed", stacked: [{ slug: "q", pr: 51, done: true }] }]);
      expect(result.restack).toBeNull();
      expect(ownCommits(s, "feature/q")).toEqual(["feat: q"]);
      expect(calls).toContainEqual(["pr", "edit", "51", "--repo", "acme/app", "--base", "main"]);
    });
  });

  test("a closed PR and a gh that can't answer are reported, nothing is recorded, and the stack still syncs", () => {
    const s = stack();
    const { gh } = fakeGh(s);
    const closed = { code: 0, stdout: JSON.stringify({ state: "CLOSED", headRefOid: originTip(s, "f-a"), mergeCommit: null, baseRefName: "main" }), stderr: "" };
    const failing = { code: 1, stdout: "", stderr: "HTTP 502\n" };
    const tips = () => UNITS.map((u) => [git(s.work, "rev-parse", u.branch), originTip(s, u.slug)]);
    const before = tips();
    const out: string[] = [];
    const deps = { gh: answering(gh, { 31: closed, 32: failing }), now: () => NOW, sleep: () => {}, stdin: () => "" };
    expect(run(["stack", "sync", "f"], { cwd: s.work, today: "2026-11-01", out: (l) => out.push(l), err: () => {} }, deps)).toBe(0);
    const printed = JSON.parse(out[0]);
    expect(printed.outside).toEqual([
      { slug: "f-a", pr: 31, kind: "closed", reason: "PR #31 was closed without merging; f-a is left as it was" },
      { slug: "f-b", pr: 32, kind: "gh-failed", reason: "gh pr view could not read PR #32, so whether it was merged is unknown: HTTP 502" },
    ]);
    expect(printed.units.map((unit: { slug: string; done: boolean }) => [unit.slug, unit.done])).toEqual([["f-a", true], ["f-b", true], ["f-c", true]]);
    expect(UNITS.map((u) => readFeature(s.work, u.slug).landed)).toEqual([undefined, undefined, undefined]);
    expect(tips()).toEqual(before);
  });
});

describe("the restack is a rebase", () => {
  /** Commit on `branch` in the work repo and push it, as a fix round and fbs push would. */
  function commitOn(s: Stack, branch: string, path: string, content: string, subject: string): string {
    git(s.work, "switch", "-q", branch);
    const sha = commitFile(s.work, path, content, subject);
    git(s.work, "push", "-q", "origin", branch);
    git(s.work, "switch", "-q", "main");
    return sha;
  }

  test("fixes merged forward from the unit below drop out, leaving each PR only its own commits", () => {
    const s = stack();
    commitOn(s, "feature/f-a", "fix.txt", "fix\n", "fix: f-a review");
    const { gh } = fakeGh(s);
    sync(s.work, "f", gh);
    git(s.work, "push", "-q", "origin", "feature/f-b", "feature/f-c");
    expect(git(s.origin, "rev-list", "--merges", "--count", "main..refs/heads/feature/f-c")).toBe("2");
    expect(landUnit(s, gh, "f-a")).toMatchObject({ restack: { slug: "f-b", done: true }, stacked: [{ slug: "f-c", done: true }] });
    expect(ownCommits(s, "feature/f-b")).toEqual(["feat: f-b"]);
    expect(ownCommits(s, "feature/f-c")).toEqual(["feat: f-b", "feat: f-c"]);
    expect(show(s, originTip(s, "f-c"), "fix.txt")).toBe("fix");
    expect(show(s, originTip(s, "f-c"), "shared.txt")).toBe("a\nB3\nc");
  });

  test("merges of the default branch, from camp on the unit below, drop out too, and main's later commits come along", () => {
    const s = stack();
    git(s.work, "fetch", "-q", "origin", "main");
    git(s.work, "switch", "-q", "--detach", "origin/main");
    commitFile(s.work, "other.txt", "o\n", "chore: other");
    git(s.work, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(s.work, "switch", "-q", "feature/f-a");
    git(s.work, "merge", "-q", "--no-edit", "HEAD@{1}");
    git(s.work, "push", "-q", "origin", "feature/f-a");
    git(s.work, "switch", "-q", "main");
    const { gh } = fakeGh(s);
    sync(s.work, "f", gh);
    git(s.work, "push", "-q", "origin", "feature/f-b", "feature/f-c");
    const later = git(s.origin, "commit-tree", "main^{tree}", "-p", "main", "-m", "chore: later");
    git(s.origin, "update-ref", "refs/heads/main", later);
    expect(landUnit(s, gh, "f-a")).toMatchObject({ restack: { slug: "f-b", done: true }, stacked: [{ slug: "f-c", done: true }] });
    expect(ownCommits(s, "feature/f-b")).toEqual(["feat: f-b"]);
    expect(ownCommits(s, "feature/f-c")).toEqual(["feat: f-b", "feat: f-c"]);
    expect(git(s.origin, "merge-base", "--is-ancestor", later, originTip(s, "f-b"))).toBe("");
    expect(show(s, originTip(s, "f-b"), "other.txt")).toBe("o");
  });

  test("plain features stacked on the landed unit are restacked too: one with a PR pushed and retargeted, one without only here", () => {
    const s = stack();
    const below = git(s.work, "rev-parse", "feature/f-a");
    const records: Record<string, object> = {};
    for (const [slug, pr] of [["g", 40], ["h", null]] as const) {
      git(s.work, "switch", "-q", "-c", `feature/${slug}`, "feature/f-a");
      const tip = commitFile(s.work, `${slug}.txt`, `${slug}\n`, `feat: ${slug}`);
      if (pr !== null) git(s.work, "push", "-q", "origin", `feature/${slug}`);
      const branch = { name: `feature/${slug}`, parent: "feature/f-a", base: below, ...(pr !== null && { pushed: tip }) };
      records[slug] = { slug, dir: `docs/features/2026-10-21-${slug}`, size: "mid", approvals: {}, pr, ...(pr !== null && { repo: "acme/app" }), branch };
    }
    git(s.work, "switch", "-q", "main");
    for (const [slug, record] of Object.entries(records)) writeFileSync(join(s.common, "fbs", "features", `${slug}.json`), JSON.stringify(record));
    const { gh, calls } = fakeGh(s);
    expect(landUnit(s, gh, "f-a")).toMatchObject({
      stacked: [
        { slug: "f-c", done: true },
        { slug: "g", pr: 40, done: true, treeChanged: false },
        { slug: "h", pr: null, done: true, treeChanged: false },
      ],
    });
    expect(calls).toContainEqual(["pr", "edit", "40", "--repo", "acme/app", "--base", "main"]);
    expect(ownCommits(s, "feature/g")).toEqual(["feat: g"]);
    expect(readFeature(s.work, "g").branch).toEqual({ name: "feature/g", parent: "main", base: git(s.origin, "rev-parse", "main"), pushed: git(s.origin, "rev-parse", "refs/heads/feature/g") });
    expect(git(s.work, "log", "--format=%s", "origin/main..feature/h")).toBe("feat: h");
    expect(readFeature(s.work, "h").branch).toEqual({ name: "feature/h", parent: "main", base: git(s.origin, "rev-parse", "main") });
    expect(Bun.spawnSync(["git", "rev-parse", "-q", "--verify", "refs/heads/feature/h"], { cwd: s.origin, env: isolatedGitEnv() }).exitCode).toBe(1);
  });

  test("the lease refuses the push when origin's branch moved after the rebase started, leaving the branch as it was", () => {
    const s = stack();
    const ahead = git(s.origin, "commit-tree", `${originTip(s, "f-b")}^{tree}`, "-p", originTip(s, "f-b"), "-m", "fix: from elsewhere");
    const hook = join(s.common, "hooks", "pre-rebase");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\ngit --git-dir="${s.origin}" update-ref refs/heads/feature/f-b ${ahead}\n`, { mode: 0o755 });
    const local = git(s.work, "rev-parse", "feature/f-b");
    const before = readFeature(s.work, "f-b");
    const { gh, calls } = fakeGh(s);
    const result = landUnit(s, gh, "f-a");
    expect(result).toMatchObject({ restack: { slug: "f-b", done: false, kind: "push-rejected", reason: "origin's feature/f-b moved during the restack; nothing was pushed" } });
    expect("stacked" in result).toBe(false);
    expect(originTip(s, "f-b")).toBe(ahead);
    expect(git(s.work, "rev-parse", "feature/f-b")).toBe(local);
    expect(readFeature(s.work, "f-b")).toEqual(before);
    expect(calls.some((call) => call[1] === "edit")).toBe(false);
  });
  test("a branch that diverged from origin isn't restacked, here or on origin", () => {
    const s = stack();
    commitOn(s, "feature/f-b", "mine.txt", "mine\n", "fix: here");
    git(s.work, "push", "-q", "origin", ":refs/heads/feature/f-b");
    const elsewhere = git(s.work, "rev-parse", "feature/f-b~1");
    const ahead = git(s.origin, "commit-tree", `${elsewhere}^{tree}`, "-p", elsewhere, "-m", "fix: elsewhere");
    git(s.origin, "update-ref", "refs/heads/feature/f-b", ahead);
    const local = git(s.work, "rev-parse", "feature/f-b");
    expect(landUnit(s, fakeGh(s).gh, "f-a")).toMatchObject({ restack: { slug: "f-b", done: false, kind: "diverged" } });
    expect(originTip(s, "f-b")).toBe(ahead);
    expect(git(s.work, "rev-parse", "feature/f-b")).toBe(local);
  });

  test("a checkout changed during the restack keeps its changes and its old tip, and the unit above is still restacked", () => {
    const s = stack({ on: "feature/f-b" });
    const old = git(s.work, "rev-parse", "HEAD");
    const hook = join(s.common, "hooks", "pre-rebase");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\necho wip > "${s.work}/scratch.txt"\n`, { mode: 0o755 });
    const result = landUnit(s, fakeGh(s).gh, "f-a");
    expect(result).toMatchObject({ restack: { slug: "f-b", done: false, kind: "dirty" }, stacked: [{ slug: "f-c", done: true }] });
    expect(git(s.work, "rev-parse", "HEAD")).toBe(old);
    expect(readFileSync(join(s.work, "scratch.txt"), "utf8")).toBe("wip\n");
    expect(ownCommits(s, "feature/f-b")).toEqual(["feat: f-b"]);
    expect(ownCommits(s, "feature/f-c")).toEqual(["feat: f-b", "feat: f-c"]);
  });

  test("a retarget that fails in land still restacks the units above, and a later sync retargets it", () => {
    const s = stack();
    const { gh, calls } = fakeGh(s);
    const failing: GhRunner = (args, cwd) => (args[1] === "edit" ? { code: 1, stdout: "", stderr: "HTTP 502" } : gh(args, cwd));
    expect(landUnit(s, failing, "f-a")).toMatchObject({ restack: { slug: "f-b", done: false, kind: "retarget-failed" }, stacked: [{ slug: "f-c", done: true }] });
    expect(readFeature(s.work, "f-b").branch).toMatchObject({ parent: "feature/f-a", base: git(s.origin, "rev-parse", "main") });
    expect(sync(s.work, "f", gh).map((unit) => [unit.slug, unit.done, unit.retargeted])).toEqual([["f-b", true, true], ["f-c", true, false]]);
    expect(calls.filter((call) => call[1] === "edit")).toEqual([["pr", "edit", "32", "--repo", "acme/app", "--base", "main"]]);
    expect(readFeature(s.work, "f-b").branch).toMatchObject({ parent: "main" });
    expect(ownCommits(s, "feature/f-c")).toEqual(["feat: f-b", "feat: f-c"]);
  });
});
