import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BRANCH_TYPES, BranchRefusedError, type BranchChoice, type BranchResult, enterFeatureBranch, isConventionalBranchName } from "./branch";
import { GitError, setGitBinary } from "./git";
import { run } from "./main";
import { approve, type FeatureBranch, initFeature, initUnit, readFeature, setPr, setTicket, updateFeature } from "./status";
import { isolatedGitEnv } from "./test-env";

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fbs-branch-")));
  dirs.push(dir);
  return dir;
}

function commitFile(cwd: string, path: string, content: string): string {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
  git(cwd, "add", path);
  git(cwd, "commit", "-q", "-m", `write ${path}`);
  return git(cwd, "rev-parse", "HEAD");
}

/** Give the repo an identity of its own, for the commits fbs makes itself (a rebase, an initial commit). */
function withIdentity(repo: string): void {
  git(repo, "config", "user.name", "fbs");
  git(repo, "config", "user.email", "fbs@example.com");
  git(repo, "config", "commit.gpgsign", "false");
}

/** A bare origin whose default branch is `main` (or `defaultBranch`) and a clone of it with feature x recorded. */
function cloned(defaultBranch = "main"): { origin: string; work: string } {
  const seed = tempDir();
  git(seed, "init", "-q", "-b", defaultBranch);
  commitFile(seed, "f.txt", "one\n");
  const origin = join(tempDir(), "origin.git");
  git(dirname(origin), "clone", "-q", "--bare", seed, origin);
  const work = join(tempDir(), "work");
  git(dirname(work), "clone", "-q", origin, work);
  withIdentity(work);
  initFeature(work, "x", "mid", "2026-10-21");
  return { origin, work };
}

/** A repo with no remote, on `main`, with feature x recorded. */
function local(): string {
  const repo = tempDir();
  git(repo, "init", "-q", "-b", "main");
  commitFile(repo, "f.txt", "one\n");
  initFeature(repo, "x", "mid", "2026-10-21");
  return repo;
}

/** Push a commit to origin's `branch` from another clone; returns its sha. */
function pushFromElsewhere(origin: string, branch = "main"): string {
  const other = join(tempDir(), "other");
  git(dirname(other), "clone", "-q", "-b", branch, origin, other);
  const sha = commitFile(other, "elsewhere.txt", "pushed\n");
  git(other, "push", "-q", "origin", branch);
  return sha;
}

/** Feature `other` on feature/other with one commit writing `path`, pushed; the work tree is left on main. */
function otherFeature(work: string, path = "other.txt", content = "other\n"): string {
  initFeature(work, "other", "mid", "2026-10-21");
  enter(work, {}, "other");
  const head = commitFile(work, path, content);
  git(work, "push", "-q", "origin", "feature/other");
  git(work, "switch", "-q", "main");
  return head;
}

/** Enter the feature's branch; a new one is a feature/ branch unless `choice` says otherwise. */
function enter(cwd: string, choice: BranchChoice = {}, slug = "x"): { result: BranchResult; notes: string[] } {
  const notes: string[] = [];
  const result = enterFeatureBranch(cwd, slug, { type: "feature", ...choice }, (line) => notes.push(line));
  return { result, notes };
}

function refusal(body: () => unknown): string {
  try {
    body();
  } catch (e) {
    if (e instanceof BranchRefusedError) return e.reason;
    throw e;
  }
  throw new Error("fbs branch did not refuse");
}

function push(cwd: string, ...args: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(["push", ...(args.length > 0 ? args : ["x"])], { cwd, today: "2026-10-25", out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

const current = (cwd: string) => git(cwd, "branch", "--show-current");
const recordFile = (cwd: string) => readFileSync(join(cwd, ".git/fbs/features/x.json"), "utf8");
const lockLeft = (cwd: string) => existsSync(join(cwd, ".git/fbs/features/x.lock"));

describe("a new feature branch", () => {
  test("creates <type>/<slug> from the remote's default branch, not the local one, and records it", () => {
    const { origin, work } = cloned();
    const remoteHead = pushFromElsewhere(origin);
    commitFile(work, "local.txt", "unpushed\n");
    const { result, notes } = enter(work);
    expect(result).toEqual({ branch: "feature/x", parent: "main", base: remoteHead, created: true, switched: true, moved: false, renamed: false });
    expect(current(work)).toBe("feature/x");
    expect(git(work, "rev-parse", "HEAD")).toBe(remoteHead);
    expect(existsSync(join(work, "local.txt"))).toBe(false);
    expect(readFeature(work, "x").branch).toEqual({ name: "feature/x", parent: "main", base: remoteHead });
    expect(notes).toEqual(["note: local main has 1 commit not on origin"]);
  });

  test("the new branch tracks nothing, so a push or pull never goes to the default branch", () => {
    const { work } = cloned();
    enter(work);
    expect(() => git(work, "config", "--get", "branch.feature/x.merge")).toThrow();
  });

  test("says nothing when the local default branch has nothing the remote lacks", () => {
    const { origin, work } = cloned();
    pushFromElsewhere(origin);
    expect(enter(work).notes).toEqual([]);
  });

  test("the default branch comes from origin/HEAD", () => {
    const { work } = cloned("trunk");
    const { result } = enter(work);
    expect(result.parent).toBe("trunk");
    expect(result.base).toBe(git(work, "rev-parse", "origin/trunk"));
  });

  test("without a remote, creates from the local default branch", () => {
    const repo = local();
    const head = git(repo, "rev-parse", "HEAD");
    expect(enter(repo)).toEqual({ result: { branch: "feature/x", parent: "main", base: head, created: true, switched: true, moved: false, renamed: false }, notes: [] });
    expect(current(repo)).toBe("feature/x");
  });

  test("without a remote or origin/HEAD, master is the default when there is no main", () => {
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "master");
    commitFile(repo, "f.txt", "one\n");
    initFeature(repo, "x", "mid", "2026-10-21");
    expect(enter(repo).result.parent).toBe("master");
  });

  test("--parent feature/<other> stacks the feature on the other feature's pushed branch", () => {
    const { work } = cloned();
    const otherHead = otherFeature(work);
    const { result, notes } = enter(work, { parent: "feature/other" });
    expect(result).toEqual({ branch: "feature/x", parent: "feature/other", base: otherHead, created: true, switched: true, moved: false, renamed: false });
    expect(existsSync(join(work, "other.txt"))).toBe(true);
    expect(notes).toEqual([]);
  });

  test("a stacked parent ahead of its pushed copy starts from the local one, since those commits are its own work", () => {
    const { work } = cloned();
    otherFeature(work);
    git(work, "switch", "-q", "feature/other");
    const ahead = commitFile(work, "more.txt", "more\n");
    const { result, notes } = enter(work, { parent: "feature/other" });
    expect(result.base).toBe(ahead);
    expect(notes).toEqual(["note: starting from the local feature/other, 1 commit ahead of origin"]);
  });

  test("a stacked parent that diverged from its pushed copy starts from origin's, with a note", () => {
    const { origin, work } = cloned();
    otherFeature(work);
    const pushed = pushFromElsewhere(origin, "feature/other");
    git(work, "switch", "-q", "feature/other");
    commitFile(work, "more.txt", "more\n");
    git(work, "switch", "-q", "main");
    const { result, notes } = enter(work, { parent: "feature/other" });
    expect(result.base).toBe(pushed);
    expect(notes).toEqual(["note: local feature/other has 1 commit not on origin"]);
  });

  test("a stacked parent the remote doesn't have starts from the local branch, with a note", () => {
    const { work } = cloned();
    initFeature(work, "other", "mid", "2026-10-21");
    enter(work, {}, "other");
    const otherHead = commitFile(work, "other.txt", "other\n");
    const { result, notes } = enter(work, { parent: "feature/other" });
    expect(result).toMatchObject({ parent: "feature/other", base: otherHead, created: true });
    expect(notes).toEqual(["note: origin has no feature/other; starting from the local one"]);
  });

  test("a parent that exists nowhere is an environment error, and nothing is recorded", () => {
    const { work } = cloned();
    expect(() => enter(work, { parent: "nope" })).toThrow(GitError);
    expect(current(work)).toBe("main");
    expect(readFeature(work, "x").branch).toBeUndefined();
  });

  test("a <type>/<slug> nobody recorded is refused, here or on origin", () => {
    const { work } = cloned();
    git(work, "branch", "feature/x");
    expect(refusal(() => enter(work))).toBe("feature/x exists but isn't recorded; pass --use feature/x to adopt it");
    git(work, "push", "-q", "origin", "feature/x");
    git(work, "branch", "-q", "-D", "feature/x");
    expect(refusal(() => enter(work))).toBe("feature/x exists but isn't recorded; pass --use feature/x to adopt it");
    expect(current(work)).toBe("main");
    expect(readFeature(work, "x").branch).toBeUndefined();
  });

  test("--existing without a recorded branch is refused and creates nothing", () => {
    const { work } = cloned();
    expect(refusal(() => enter(work, { existing: true }))).toBe("no branch recorded for x");
    expect(current(work)).toBe("main");
    expect(() => git(work, "rev-parse", "--verify", "feature/x")).toThrow();
  });
});

describe("the new branch's name", () => {
  const TYPES_HINT = "a new branch needs --type <feature|bugfix|hotfix|chore>";

  /** A repo with no remote, on `main`, with feature `slug` recorded. */
  function localWith(slug: string): string {
    const repo = local();
    initFeature(repo, slug, "mid", "2026-10-21");
    return repo;
  }

  test.each(BRANCH_TYPES.map((type) => [type]))("--type %s without a ticket is <type>/<slug>", (type) => {
    const repo = local();
    expect(enter(repo, { type }).result).toMatchObject({ branch: `${type}/x`, created: true });
    expect(current(repo)).toBe(`${type}/x`);
    expect(readFeature(repo, "x").branch?.name).toBe(`${type}/x`);
  });

  test.each([
    ["feature", "acm-123", "feature/acm-123-x"],
    ["bugfix", "ACM-123", "bugfix/acm-123-x"],
    ["hotfix", "Ab2-7", "hotfix/ab2-7-x"],
    ["chore", "123", "chore/issue-123-x"],
    ["feature", "#123", "feature/issue-123-x"],
  ])("--type %s --ticket %s is %s", (type, ticket, name) => {
    const repo = local();
    expect(enter(repo, { type, ticket }).result.branch).toBe(name);
    expect(current(repo)).toBe(name);
  });

  test.each([
    ["acm-123-booking-sync", "ACM-123", "feature/acm-123-booking-sync"],
    ["acm-123", "acm-123", "feature/acm-123"],
    ["issue-5-x", "#5", "feature/issue-5-x"],
    ["acm-1234-x", "acm-123", "feature/acm-123-acm-1234-x"],
  ])("slug %s with --ticket %s is %s", (slug, ticket, name) => {
    const repo = localWith(slug);
    expect(enter(repo, { ticket }, slug).result.branch).toBe(name);
  });

  test.each(["ACM", "acm_123", "123-acm", "1-2", "acm-12a", "ACM 123", "#", "#acm-1", "acm-", "-1", "acó-1"])("the ticket %p is refused, and nothing is created", (ticket) => {
    const repo = local();
    expect(refusal(() => enter(repo, { ticket }))).toBe(`bad ticket ${JSON.stringify(ticket)}: use a tracker id like ACM-123 or an issue number`);
    expect(current(repo)).toBe("main");
    expect(readFeature(repo, "x").branch).toBeUndefined();
  });

  test("a new branch takes the record's ticket when --ticket isn't passed, and --ticket wins over it", () => {
    const repo = local();
    setTicket(repo, "x", "ACM-123");
    expect(enter(repo).result.branch).toBe("feature/acm-123-x");
    const other = local();
    setTicket(other, "x", "ACM-123");
    expect(enter(other, { ticket: "#9" }).result.branch).toBe("feature/issue-9-x");
  });

  test("a missing or unknown --type is refused, with or without a ticket, and nothing is created", () => {
    const repo = local();
    expect(refusal(() => enter(repo, { type: undefined }))).toBe(TYPES_HINT);
    expect(refusal(() => enter(repo, { type: undefined, ticket: "ACM-1" }))).toBe(TYPES_HINT);
    for (const type of ["release", "Feature", "fbs"]) {
      expect(refusal(() => enter(repo, { type }))).toBe(`unknown type ${JSON.stringify(type)}; --type is one of feature, bugfix, hotfix, chore`);
    }
    expect(current(repo)).toBe("main");
    expect(git(repo, "branch", "--format=%(refname:short)")).toBe("main");
    expect(readFeature(repo, "x").branch).toBeUndefined();
  });

  test("a recorded branch resumes without --type, and --type doesn't rename it", () => {
    const repo = local();
    const first = enter(repo, { type: "bugfix" }).result;
    git(repo, "switch", "-q", "main");
    expect(enter(repo, { type: undefined }).result).toEqual({ ...first, created: false, switched: true });
    git(repo, "switch", "-q", "main");
    expect(enter(repo, { type: "nope" }).result).toEqual({ ...first, created: false, switched: true });
    expect(enter(repo, { type: undefined, existing: true }).result).toEqual({ ...first, created: false, switched: false });
    expect(readFeature(repo, "x").branch?.name).toBe("bugfix/x");
  });

  test("a record from before types, on fbs/<slug>, resumes unchanged", () => {
    const repo = local();
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "branch", "fbs/x");
    updateFeature(repo, "x", (rec) => ({ ...rec, branch: { name: "fbs/x", parent: "main", base } }));
    const expected = { branch: "fbs/x", parent: "main", base, created: false, switched: true, moved: false, renamed: false };
    expect(enter(repo, { type: undefined }).result).toEqual(expected);
    git(repo, "switch", "-q", "main");
    expect(enter(repo, { type: undefined, existing: true }).result).toEqual(expected);
    expect(current(repo)).toBe("fbs/x");
    expect(readFeature(repo, "x").branch).toEqual({ name: "fbs/x", parent: "main", base });
  });

  test("--use adopts a branch whatever its shape, without a type", () => {
    const repo = local();
    git(repo, "branch", "Alex/WIP");
    expect(enter(repo, { type: undefined, use: "Alex/WIP" }).result).toMatchObject({ branch: "Alex/WIP", parent: null });
  });

  test.each(["feature/x", "bugfix/acm-123-booking-sync", "hotfix/issue-7", "chore/v1.2.0", "feature/a.b-c.d", "feature/2fa"])("%p is a conventional branch name", (name) => {
    expect(isConventionalBranchName(name)).toBe(true);
  });

  test.each([
    "Feature/x",
    "feature/X",
    "feature/acm-123-X",
    "feature/-x",
    "feature/x-",
    "feature/a--b",
    "feature/a..b",
    "feature/.a",
    "feature/a.",
    "feature/a-.b",
    "feature/a.-b",
    "feature/a_b",
    "feature/a/b",
    "feature/",
    "feature",
    "release/v1.2.0",
    "fbs/x",
  ])("%p is not a conventional branch name", (name) => {
    expect(isConventionalBranchName(name)).toBe(false);
  });
});

describe("an unborn repo", () => {
  test("gets an empty initial commit on its branch, and the feature branch starts there", () => {
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "main");
    withIdentity(repo);
    initFeature(repo, "x", "mid", "2026-10-21");
    writeFileSync(join(repo, "staged.txt"), "staged\n");
    git(repo, "add", "staged.txt");
    const { result, notes } = enter(repo);
    const root = git(repo, "rev-parse", "main");
    expect(result).toEqual({ branch: "feature/x", parent: "main", base: root, created: true, switched: true, moved: false, renamed: false });
    expect(git(repo, "log", "--format=%s", "main")).toBe("chore: initial commit");
    expect(git(repo, "ls-tree", "-r", "--name-only", "main")).toBe("");
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("staged.txt");
    expect(notes).toEqual(["note: the repo had no commits; started main with an empty initial commit", "note: carrying uncommitted changes: staged.txt"]);
  });

  test("with an origin that has history, starts from origin's default branch instead of a new root", () => {
    const { origin } = cloned();
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "master");
    withIdentity(repo);
    git(repo, "remote", "add", "origin", origin);
    initFeature(repo, "x", "mid", "2026-10-21");
    const { result, notes } = enter(repo);
    const main = git(origin, "rev-parse", "main");
    expect(result).toEqual({ branch: "feature/x", parent: "main", base: main, created: true, switched: true, moved: false, renamed: false });
    expect(notes).toEqual([]);
  });

  test("without a git identity is an environment error with git's message", () => {
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.useConfigOnly", "true");
    initFeature(repo, "x", "mid", "2026-10-21");
    const out: string[] = [];
    const err: string[] = [];
    const code = run(["branch", "x", "--type", "feature"], { cwd: repo, today: "2026-10-25", out: (l) => out.push(l), err: (l) => err.push(l) });
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("cannot make the initial commit");
    expect(lockLeft(repo)).toBe(false);
  });
});

describe("an unreachable origin", () => {
  test("falls back to the last fetched parent with a note, and leaves no lock", () => {
    const { work } = cloned();
    const fetched = git(work, "rev-parse", "origin/main");
    git(work, "remote", "set-url", "origin", join(tempDir(), "gone.git"));
    const { result, notes } = enter(work);
    expect(result).toMatchObject({ branch: "feature/x", parent: "main", base: fetched, created: true });
    expect(notes).toEqual(["note: could not reach origin; using the last fetched main"]);
    expect(lockLeft(work)).toBe(false);
  });

  test("with no usable ref at all is exit 2, and leaves no lock", () => {
    const { work } = cloned();
    git(work, "remote", "set-url", "origin", join(tempDir(), "gone.git"));
    const err: string[] = [];
    const code = run(["branch", "x", "--type", "feature", "--parent", "nope"], { cwd: work, today: "2026-10-25", out: () => {}, err: (l) => err.push(l) });
    expect(code).toBe(2);
    expect(err.at(-1)).toContain("cannot start from nope");
    expect(lockLeft(work)).toBe(false);
    expect(readFeature(work, "x").branch).toBeUndefined();
  });
});

describe("a recorded branch", () => {
  test("on the branch already, prints the recorded branch and changes nothing", () => {
    const { work } = cloned();
    const first = enter(work).result;
    const record = recordFile(work);
    expect(enter(work, { existing: true }).result).toEqual({ ...first, created: false, switched: false });
    expect(recordFile(work)).toBe(record);
  });

  test("is switched to and keeps its recorded parent and base, also with the same --parent", () => {
    const { work } = cloned();
    const first = enter(work).result;
    commitFile(work, "feature.txt", "work\n");
    git(work, "switch", "-q", "main");
    expect(enter(work, { parent: "main" }).result).toEqual({ ...first, created: false, switched: true });
    expect(current(work)).toBe("feature/x");
    expect(existsSync(join(work, "feature.txt"))).toBe(true);
  });

  test("missing here but pushed is restored from origin, untracked, with its recorded base", () => {
    const { work } = cloned();
    const first = enter(work).result;
    const pushed = commitFile(work, "feature.txt", "work\n");
    git(work, "push", "-q", "origin", "feature/x");
    git(work, "switch", "-q", "main");
    git(work, "branch", "-q", "-D", "feature/x");
    expect(enter(work).result).toEqual({ ...first, created: false, switched: true });
    expect(git(work, "rev-parse", "HEAD")).toBe(pushed);
    expect(() => git(work, "config", "--get", "branch.feature/x.merge")).toThrow();
  });

  test("gone from here and from origin is refused", () => {
    const { work } = cloned();
    enter(work);
    git(work, "switch", "-q", "main");
    git(work, "branch", "-q", "-D", "feature/x");
    const record = recordFile(work);
    expect(refusal(() => enter(work, { existing: true }))).toBe("branch feature/x is gone: not here and not on origin");
    expect(current(work)).toBe("main");
    expect(recordFile(work)).toBe(record);
  });

  test("a new --parent re-cuts an unpushed branch onto it and records the new parent and base", () => {
    const { work } = cloned();
    enter(work);
    commitFile(work, "feature.txt", "work\n");
    git(work, "switch", "-q", "main");
    const otherHead = otherFeature(work);
    const { result } = enter(work, { parent: "feature/other" });
    expect(result).toEqual({ branch: "feature/x", parent: "feature/other", base: otherHead, created: false, switched: true, moved: true, renamed: false });
    expect(current(work)).toBe("feature/x");
    expect(git(work, "rev-list", "--count", `${otherHead}..feature/x`)).toBe("1");
    expect(existsSync(join(work, "other.txt"))).toBe(true);
    expect(existsSync(join(work, "feature.txt"))).toBe(true);
    expect(readFeature(work, "x").branch).toEqual({ name: "feature/x", parent: "feature/other", base: otherHead });
  });

  test("a new --parent is refused when origin has a copy fbs didn't push", () => {
    const { work } = cloned();
    enter(work);
    commitFile(work, "feature.txt", "work\n");
    git(work, "push", "-q", "origin", "feature/x");
    otherFeature(work);
    const record = recordFile(work);
    expect(refusal(() => enter(work, { parent: "feature/other" }))).toBe("origin has commits fbs didn't push to feature/x; it can't move");
    expect(recordFile(work)).toBe(record);
  });

  test("a new --parent is refused when someone pushed on top of what fbs pushed", () => {
    const { origin, work } = cloned();
    enter(work);
    commitFile(work, "feature.txt", "work\n");
    push(work);
    pushFromElsewhere(origin, "feature/x");
    otherFeature(work);
    const record = recordFile(work);
    expect(refusal(() => enter(work, { parent: "feature/other" }))).toBe("origin has commits fbs didn't push to feature/x; it can't move");
    expect(recordFile(work)).toBe(record);
  });

  test("a new --parent moves a branch whose origin copy is what fbs pushed, keeps pushed, and the next push forces over it", () => {
    const { origin, work } = cloned();
    enter(work);
    commitFile(work, "feature.txt", "work\n");
    const pushed = JSON.parse(push(work).out[0]).pushed;
    git(work, "switch", "-q", "main");
    const otherHead = otherFeature(work);
    expect(enter(work, { parent: "feature/other" }).result).toMatchObject({ parent: "feature/other", base: otherHead, moved: true });
    expect(readFeature(work, "x").branch).toEqual({ name: "feature/x", parent: "feature/other", base: otherHead, pushed });
    const moved = git(work, "rev-parse", "feature/x");
    expect(push(work)).toEqual({ code: 0, out: [JSON.stringify({ branch: "feature/x", pushed: moved, forced: true })], err: [] });
    expect(git(origin, "rev-parse", "feature/x")).toBe(moved);
  });

  test("a new --parent is refused when origin can't be reached to check what fbs pushed", () => {
    const { work } = cloned();
    enter(work);
    commitFile(work, "feature.txt", "work\n");
    push(work);
    git(work, "switch", "-q", "main");
    otherFeature(work);
    git(work, "remote", "set-url", "origin", join(tempDir(), "gone.git"));
    const record = recordFile(work);
    expect(refusal(() => enter(work, { parent: "feature/other" }))).toBe("can't reach origin to check feature/x before moving it");
    expect(recordFile(work)).toBe(record);
  });

  test("a new --parent restores a pushed branch that is gone here before moving it", () => {
    const { work } = cloned();
    enter(work);
    commitFile(work, "feature.txt", "work\n");
    push(work);
    git(work, "switch", "-q", "main");
    git(work, "branch", "-q", "-D", "feature/x");
    const otherHead = otherFeature(work);
    expect(enter(work, { parent: "feature/other" }).result).toMatchObject({ parent: "feature/other", base: otherHead, switched: true, moved: true });
    expect(current(work)).toBe("feature/x");
    expect(existsSync(join(work, "feature.txt"))).toBe(true);
    expect(existsSync(join(work, "other.txt"))).toBe(true);
  });

  test("a new --parent is refused once the feature has a PR", () => {
    const { work } = cloned();
    enter(work);
    commitFile(work, "feature.txt", "work\n");
    git(work, "switch", "-q", "main");
    otherFeature(work);
    setPr(work, "x", 7, "acme/app");
    const record = recordFile(work);
    expect(refusal(() => enter(work, { parent: "feature/other" }))).toBe("feature/x has an open PR; it can't move");
    expect(recordFile(work)).toBe(record);
  });

  test("a new --parent that conflicts is aborted, leaving the branch and the work tree as they were", () => {
    const { work } = cloned();
    enter(work);
    const tip = commitFile(work, "f.txt", "mine\n");
    git(work, "switch", "-q", "main");
    otherFeature(work, "f.txt", "theirs\n");
    const record = recordFile(work);
    expect(refusal(() => enter(work, { parent: "feature/other" }))).toBe("moving feature/x onto feature/other conflicts");
    expect(git(work, "rev-parse", "feature/x")).toBe(tip);
    expect(current(work)).toBe("main");
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(existsSync(join(work, ".git/rebase-merge"))).toBe(false);
    expect(recordFile(work)).toBe(record);
  });

  test("a new --parent with uncommitted changes is refused before anything moves", () => {
    const { work } = cloned();
    enter(work);
    commitFile(work, "feature.txt", "work\n");
    git(work, "switch", "-q", "main");
    otherFeature(work);
    writeFileSync(join(work, "f.txt"), "dirty\n");
    expect(refusal(() => enter(work, { parent: "feature/other" }))).toBe(
      "moving feature/x needs a clean work tree: f.txt; stash them or commit them where they are, then run this again",
    );
    expect(current(work)).toBe("main");
  });

  test("a branch adopted with --use has no parent to move", () => {
    const { work } = cloned();
    enter(work, { use: "main" });
    expect(refusal(() => enter(work, { parent: "feature/other" }))).toBe("main was adopted with --use; it has no parent to move");
  });
});

describe("a recorded branch and a ticket", () => {
  test("--ticket renames a branch fbs cut, keeping its type, parent and base, and says so", () => {
    const repo = local();
    const first = enter(repo, { type: "bugfix" }).result;
    git(repo, "switch", "-q", "main");
    const { result, notes } = enter(repo, { type: undefined, ticket: "ACM-123" });
    expect(result).toEqual({ ...first, branch: "bugfix/acm-123-x", created: false, switched: true, renamed: true });
    expect(notes).toEqual(["note: renamed bugfix/x to bugfix/acm-123-x"]);
    expect(current(repo)).toBe("bugfix/acm-123-x");
    expect(git(repo, "branch", "--format=%(refname:short)").split("\n").sort()).toEqual(["bugfix/acm-123-x", "main"]);
    expect(readFeature(repo, "x").branch).toEqual({ name: "bugfix/acm-123-x", parent: "main", base: first.base });
  });

  test("a ticket only on the record never renames, and once the name carries the ticket nothing changes", () => {
    const repo = local();
    enter(repo);
    setTicket(repo, "x", "ACM-7");
    const before = recordFile(repo);
    expect(enter(repo, { existing: true })).toEqual({ result: expect.objectContaining({ branch: "feature/x", renamed: false }), notes: [] });
    expect(recordFile(repo)).toBe(before);
    expect(enter(repo, { existing: true, ticket: "ACM-7" }).result).toMatchObject({ branch: "feature/acm-7-x", switched: false, renamed: true });
    const record = recordFile(repo);
    const { result, notes } = enter(repo, { existing: true, ticket: "acm-7" });
    expect(result).toMatchObject({ branch: "feature/acm-7-x", renamed: false });
    expect(notes).toEqual([]);
    expect(recordFile(repo)).toBe(record);
  });

  test("a renamed branch that was pushed keeps the old name for the next push to delete", () => {
    const { origin, work } = cloned();
    enter(work);
    const tip = commitFile(work, "feature.txt", "work\n");
    push(work);
    expect(enter(work, { ticket: "ACM-1" }).result.renamed).toBe(true);
    expect(readFeature(work, "x").branch).toMatchObject({ name: "feature/acm-1-x", pushed: tip, previous: "feature/x" });
    expect(git(origin, "rev-parse", "feature/x")).toBe(tip);
  });

  /** Each reason to refuse renaming feature/x to feature/acm-1-x, set up on a fresh repo; returns the repo. */
  const BLOCKERS: [string, () => string, string][] = [
    [
      "an open PR",
      () => {
        const repo = local();
        enter(repo);
        setPr(repo, "x", 4, "acme/app");
        return repo;
      },
      "feature/x has an open PR; it can't be renamed to feature/acm-1-x",
    ],
    [
      "commits on origin fbs didn't push",
      () => {
        const { origin, work } = cloned();
        enter(work);
        commitFile(work, "feature.txt", "work\n");
        push(work);
        pushFromElsewhere(origin, "feature/x");
        return work;
      },
      "origin has commits fbs didn't push to feature/x; it can't be renamed",
    ],
    [
      "an unreachable origin after a push",
      () => {
        const { work } = cloned();
        enter(work);
        commitFile(work, "feature.txt", "work\n");
        push(work);
        git(work, "remote", "set-url", "origin", join(tempDir(), "gone.git"));
        return work;
      },
      "can't reach origin to check feature/x before renaming it",
    ],
    [
      "the new name taken here",
      () => {
        const repo = local();
        enter(repo);
        git(repo, "branch", "feature/acm-1-x");
        return repo;
      },
      "feature/acm-1-x already exists; feature/x can't be renamed to it",
    ],
    [
      "the new name taken on origin",
      () => {
        const { work } = cloned();
        enter(work);
        git(work, "push", "-q", "origin", "main:feature/acm-1-x");
        return work;
      },
      "feature/acm-1-x already exists; feature/x can't be renamed to it",
    ],
  ];

  test.each(BLOCKERS)("%s refuses a rename asked with --ticket, and changes nothing", (_, setUp, refused) => {
    const repo = setUp();
    const record = recordFile(repo);
    expect(refusal(() => enter(repo, { ticket: "ACM-1" }))).toBe(refused);
    expect(recordFile(repo)).toBe(record);
    expect(current(repo)).toBe("feature/x");
  });

  test("a feature stacked on the branch refuses its rename", () => {
    const repo = local();
    enter(repo);
    initFeature(repo, "child", "mid", "2026-10-21");
    enter(repo, { parent: "feature/x" }, "child");
    git(repo, "switch", "-q", "feature/x");
    const record = recordFile(repo);
    expect(refusal(() => enter(repo, { ticket: "ACM-1" }))).toBe("child is stacked on feature/x; rename it before it has children");
    expect(recordFile(repo)).toBe(record);
    expect(current(repo)).toBe("feature/x");
  });

  test("an adopted branch and a branch from before types are never renamed", () => {
    const repo = local();
    git(repo, "branch", "mine");
    enter(repo, { use: "mine" });
    expect(enter(repo, { ticket: "ACM-1" }).result).toMatchObject({ branch: "mine", renamed: false });
    const old = local();
    const base = git(old, "rev-parse", "HEAD");
    git(old, "branch", "fbs/x");
    updateFeature(old, "x", (rec) => ({ ...rec, branch: { name: "fbs/x", parent: "main", base } }));
    expect(enter(old, { ticket: "ACM-1" }).result).toMatchObject({ branch: "fbs/x", renamed: false });
  });
});

describe("--use", () => {
  test("--use main records the default branch at its tip, and later runs stay on it", () => {
    const { work } = cloned();
    const head = git(work, "rev-parse", "HEAD");
    expect(enter(work, { use: "main" }).result).toEqual({ branch: "main", parent: null, base: head, created: false, switched: false, moved: false, renamed: false });
    expect(readFeature(work, "x").branch).toEqual({ name: "main", parent: null, base: head });
    git(work, "switch", "-q", "-c", "elsewhere");
    commitFile(work, "later.txt", "later\n");
    git(work, "switch", "-q", "main");
    git(work, "merge", "-q", "elsewhere");
    git(work, "switch", "-q", "elsewhere");
    expect(enter(work).result).toEqual({ branch: "main", parent: null, base: head, created: false, switched: true, moved: false, renamed: false });
    expect(current(work)).toBe("main");
  });

  test("records the merge base with the default branch, so the feature's commits are base..branch", () => {
    const { origin, work } = cloned();
    const start = git(work, "rev-parse", "HEAD");
    git(work, "switch", "-q", "-c", "mine");
    commitFile(work, "mine.txt", "mine\n");
    git(work, "switch", "-q", "main");
    pushFromElsewhere(origin);
    expect(enter(work, { use: "mine" }).result).toEqual({ branch: "mine", parent: null, base: start, created: false, switched: true, moved: false, renamed: false });
  });

  test("adopts an unrecorded <type>/<slug>", () => {
    const { work } = cloned();
    const start = git(work, "rev-parse", "HEAD");
    git(work, "switch", "-q", "-c", "feature/x");
    commitFile(work, "feature.txt", "work\n");
    expect(enter(work, { use: "feature/x" }).result).toEqual({ branch: "feature/x", parent: null, base: start, created: false, switched: false, moved: false, renamed: false });
  });

  test("switches to a branch that exists only on the remote, without tracking it", () => {
    const { origin, work } = cloned();
    const start = git(work, "rev-parse", "HEAD");
    const other = join(tempDir(), "other");
    git(dirname(other), "clone", "-q", origin, other);
    git(other, "switch", "-q", "-c", "shared");
    const sha = commitFile(other, "shared.txt", "shared\n");
    git(other, "push", "-q", "origin", "shared");
    expect(enter(work, { use: "shared" }).result).toEqual({ branch: "shared", parent: null, base: start, created: false, switched: true, moved: false, renamed: false });
    expect(git(work, "rev-parse", "HEAD")).toBe(sha);
    expect(() => git(work, "config", "--get", "branch.shared.merge")).toThrow();
  });

  test("refuses a branch that exists nowhere", () => {
    const { work } = cloned();
    expect(refusal(() => enter(work, { use: "nope" }))).toBe("no branch nope");
    expect(readFeature(work, "x").branch).toBeUndefined();
  });
});

describe("uncommitted changes", () => {
  test("a switch that would overwrite them is refused, and nothing is recorded", () => {
    const { work } = cloned();
    enter(work);
    commitFile(work, "f.txt", "feature\n");
    git(work, "switch", "-q", "main");
    writeFileSync(join(work, "f.txt"), "dirty\n");
    const record = recordFile(work);
    expect(refusal(() => enter(work))).toBe("uncommitted changes would be overwritten: f.txt; stash them or commit them where they are, then run this again");
    expect(current(work)).toBe("main");
    expect(recordFile(work)).toBe(record);
  });

  test("a new branch that would overwrite them is refused", () => {
    const { origin, work } = cloned();
    pushFromElsewhere(origin);
    writeFileSync(join(work, "elsewhere.txt"), "untracked here\n");
    expect(refusal(() => enter(work))).toBe(
      "uncommitted changes would be overwritten: elsewhere.txt; stash them or commit them where they are, then run this again",
    );
    expect(current(work)).toBe("main");
    expect(readFeature(work, "x").branch).toBeUndefined();
  });

  test("ones that don't conflict come along, with a note", () => {
    const { work } = cloned();
    writeFileSync(join(work, "f.txt"), "edited\n");
    writeFileSync(join(work, "new.txt"), "new\n");
    const { result, notes } = enter(work);
    expect(result.created).toBe(true);
    expect(readFileSync(join(work, "f.txt"), "utf8")).toBe("edited\n");
    expect(existsSync(join(work, "new.txt"))).toBe(true);
    expect(notes).toEqual(["note: carrying uncommitted changes: f.txt, new.txt"]);
  });
});

describe("the record", () => {
  test("a record made in a worktree is seen by the main checkout", () => {
    const { work } = cloned();
    const wt = join(tempDir(), "wt");
    git(work, "worktree", "add", "-q", "--detach", wt);
    const { result } = enter(wt);
    expect(current(wt)).toBe("feature/x");
    expect(readFeature(work, "x").branch).toEqual({ name: "feature/x", parent: "main", base: result.base });
  });

  test("a missing record is missing, and an unsafe slug is bad-slug", () => {
    const { work } = cloned();
    expect(() => enter(work, {}, "nope")).toThrow(/missing: no feature nope/);
    expect(() => enter(work, {}, "../x")).toThrow(/bad-slug/);
    expect(current(work)).toBe("main");
  });

  test.each(["-x", "a..b", "a b", "@{-1}", "x.lock", "/x", "x/", "@", "HEAD"])("rejects the branch name %p", (name) => {
    const { work } = cloned();
    expect(() => enter(work, { use: name })).toThrow(/bad-branch/);
    expect(() => enter(work, { parent: name })).toThrow(/bad-branch/);
  });
});

describe("fbs branch", () => {
  const cli = (cwd: string, ...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(["branch", ...args], { cwd, today: "2026-10-25", out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
  };

  test("prints one JSON line, notes on stderr, and status show includes the branch", () => {
    const { work } = cloned();
    commitFile(work, "local.txt", "unpushed\n");
    const r = cli(work, "x", "--type", "feature");
    const base = git(work, "rev-parse", "origin/main");
    expect(r).toEqual({
      code: 0,
      out: [JSON.stringify({ branch: "feature/x", parent: "main", base, created: true, switched: true, moved: false, renamed: false })],
      err: ["note: local main has 1 commit not on origin"],
    });
    const shown: string[] = [];
    run(["status", "show", "x"], { cwd: work, today: "2026-10-25", out: (l) => shown.push(l), err: () => {} });
    expect(JSON.parse(shown.join("\n")).branch).toEqual({ name: "feature/x", parent: "main", base });
  });

  test("--type and --ticket reach the command, and a missing or unknown --type is refused on stdout", () => {
    const { work } = cloned();
    expect(cli(work, "x")).toEqual({ code: 1, out: ["refused: a new branch needs --type <feature|bugfix|hotfix|chore>"], err: [] });
    expect(cli(work, "x", "--ticket", "ACM-1")).toEqual({ code: 1, out: ["refused: a new branch needs --type <feature|bugfix|hotfix|chore>"], err: [] });
    expect(cli(work, "x", "--type", "release")).toEqual({ code: 1, out: ['refused: unknown type "release"; --type is one of feature, bugfix, hotfix, chore'], err: [] });
    expect(cli(work, "x", "--type", "bugfix", "--ticket", "x")).toEqual({ code: 1, out: ['refused: bad ticket "x": use a tracker id like ACM-123 or an issue number'], err: [] });
    const r = cli(work, "x", "--type", "bugfix", "--ticket", "ACM-1");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out[0])).toMatchObject({ branch: "bugfix/acm-1-x", parent: "main", created: true });
    expect(JSON.parse(cli(work, "x").out[0])).toMatchObject({ branch: "bugfix/acm-1-x", created: false });
  });

  test("--use ignores --type and --ticket, as resuming does", () => {
    const { work } = cloned();
    const r = cli(work, "x", "--use", "main", "--type", "feature", "--ticket", "ACM-1");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out[0])).toMatchObject({ branch: "main", parent: null });
  });

  test.each([
    ["no --type", []],
    ["a bad ticket", ["--type", "feature", "--ticket", "x"]],
  ])("with %s, refuses before fetching or taking the record lock", (_, flags) => {
    const { work } = cloned();
    git(work, "remote", "set-url", "origin", join(tempDir(), "gone.git"));
    const r = cli(work, "x", ...flags);
    expect(r.code).toBe(1);
    expect(r.out[0]).toStartWith("refused: ");
    expect(r.err).toEqual([]);
    expect(lockLeft(work)).toBe(false);
    writeFileSync(join(work, ".git/fbs/features/x.lock"), "");
    expect(cli(work, "x", ...flags).out).toEqual(r.out);
  });

  test("--use and --existing reach the command", () => {
    const { work } = cloned();
    expect(cli(work, "x", "--existing")).toEqual({ code: 1, out: ["refused: no branch recorded for x"], err: [] });
    const r = cli(work, "x", "--use", "main");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out[0])).toMatchObject({ branch: "main", parent: null });
    expect(cli(work, "x", "--existing").code).toBe(0);
  });

  test("a refusal prints refused on stdout and exits 1", () => {
    const { work } = cloned();
    cli(work, "x", "--type", "feature");
    commitFile(work, "f.txt", "feature\n");
    git(work, "switch", "-q", "main");
    writeFileSync(join(work, "f.txt"), "dirty\n");
    expect(cli(work, "x")).toEqual({
      code: 1,
      out: ["refused: uncommitted changes would be overwritten: f.txt; stash them or commit them where they are, then run this again"],
      err: [],
    });
  });

  test("a missing record, a bad slug and a bad branch name are errors on stdout with exit 1", () => {
    const { work } = cloned();
    expect(cli(work, "nope")).toEqual({ code: 1, out: ["error: missing: no feature nope"], err: [] });
    expect(cli(work, "Bad")).toMatchObject({ code: 1, out: [expect.stringContaining("error: bad-slug:")] });
    expect(cli(work, "x", "--parent", "a..b")).toMatchObject({ code: 1, out: [expect.stringContaining("error: bad-branch:")] });
    expect(cli(work, "x", "--use", "HEAD")).toMatchObject({ code: 1, out: [expect.stringContaining("error: bad-branch:")] });
  });

  test.each([
    [[]],
    [["x", "y"]],
    [["x", "--use"]],
    [["x", "--nope", "a"]],
    [["x", "--use", "a", "--use", "b"]],
    [["x", "--existing", "--existing"]],
    [["x", "--type"]],
    [["x", "--type", "feature", "--type", "chore"]],
    [["x", "--type", "feature", "--ticket", ""]],
  ])("%p is a usage error", (args) => {
    const { work } = cloned();
    const r = cli(work, ...args);
    expect(r.code).toBe(2);
    expect(r.out).toEqual([]);
    expect(r.err[0]).toContain("unknown command: branch");
  });

  test.each([
    [["--parent", "main"], "--use and --parent can't be combined"],
    [["--existing"], "--use and --existing can't be combined"],
    [["--existing", "--parent", "main"], "--use and --existing and --parent can't be combined"],
  ])("--use with %p is a usage error naming the flags", (flags, message) => {
    const { work } = cloned();
    expect(cli(work, "x", "--use", "main", ...flags)).toEqual({ code: 2, out: [], err: [`branch: ${message}`] });
  });

  test("outside a git repo is an environment error", () => {
    const dir = tempDir();
    const r = cli(join(dir, "missing"), "x");
    expect(r.code).toBe(2);
    expect(r.out).toEqual([]);
  });
});

describe("fbs push", () => {
  const pushedJson = (pushed: string, forced = false) => [JSON.stringify({ branch: "feature/x", pushed, forced })];
  const amend = (cwd: string) => {
    git(cwd, "commit", "-q", "--amend", "-m", "rewritten");
    return git(cwd, "rev-parse", "HEAD");
  };

  const LEGACY =
    "refused: fbs has no record of pushing feature/x and origin has commits it lacks; run git fetch origin feature/x and git log feature/x..origin/feature/x: " +
    "if those are this branch's own earlier pushes, the user pushes once with git push --force-with-lease=feature/x:<sha of origin/feature/x> origin feature/x " +
    "and fbs push works from then on; otherwise look before pushing";

  /** Feature x on feature/x with one commit, not yet pushed. */
  function onFeature(): { origin: string; work: string; tip: string } {
    const { origin, work } = cloned();
    enter(work);
    const tip = commitFile(work, "feature.txt", "work\n");
    return { origin, work, tip };
  }

  test("the first push creates origin's branch and records the commit pushed, without writing git config", () => {
    const { origin, work, tip } = onFeature();
    const config = readFileSync(join(work, ".git/config"), "utf8");
    expect(push(work)).toEqual({ code: 0, out: pushedJson(tip), err: [] });
    expect(git(origin, "rev-parse", "feature/x")).toBe(tip);
    expect(readFileSync(join(work, ".git/config"), "utf8")).toBe(config);
    expect(readFeature(work, "x").branch?.pushed).toBe(tip);
  });

  test("after a rename, the push creates the new name and deletes the old one fbs pushed, and the record forgets it", () => {
    const { origin, work } = onFeature();
    push(work);
    enter(work, { ticket: "ACM-1" });
    const next = commitFile(work, "more.txt", "more\n");
    const r = push(work);
    expect(r).toEqual({ code: 0, out: [JSON.stringify({ branch: "feature/acm-1-x", pushed: next, forced: false, previous: { name: "feature/x", deleted: true } })], err: [] });
    expect(git(origin, "rev-parse", "feature/acm-1-x")).toBe(next);
    expect(() => git(origin, "rev-parse", "--verify", "--quiet", "refs/heads/feature/x")).toThrow();
    const { base } = readFeature(work, "x").branch as FeatureBranch;
    expect(readFeature(work, "x").branch).toEqual({ name: "feature/acm-1-x", parent: "main", base, pushed: next });
  });

  test("after a rename, an old name that origin moved since fbs pushed it stays, with a note", () => {
    const { origin, work, tip } = onFeature();
    push(work);
    enter(work, { ticket: "ACM-1" });
    const theirs = pushFromElsewhere(origin, "feature/x");
    const r = push(work);
    expect(r).toEqual({
      code: 0,
      out: [JSON.stringify({ branch: "feature/acm-1-x", pushed: tip, forced: false, previous: { name: "feature/x", deleted: false } })],
      err: ["note: left feature/x on origin: it isn't at the commit fbs pushed"],
    });
    expect(git(origin, "rev-parse", "feature/x")).toBe(theirs);
    expect(git(origin, "rev-parse", "feature/acm-1-x")).toBe(tip);
    expect(readFeature(work, "x").branch?.previous).toBeUndefined();
  });

  test("after a rename, an old name already gone from origin counts as deleted, with a note", () => {
    const { origin, work, tip } = onFeature();
    push(work);
    enter(work, { ticket: "ACM-1" });
    git(origin, "branch", "-q", "-D", "feature/x");
    expect(push(work)).toEqual({
      code: 0,
      out: [JSON.stringify({ branch: "feature/acm-1-x", pushed: tip, forced: false, previous: { name: "feature/x", deleted: true } })],
      err: ["note: feature/x is already gone from origin"],
    });
    expect(readFeature(work, "x").branch?.previous).toBeUndefined();
  });

  test("after a rename, a delete origin refuses still records the push and leaves the old name, with a note", () => {
    const { origin, work, tip } = onFeature();
    push(work);
    enter(work, { ticket: "ACM-1" });
    const hook = join(origin, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do [ \"$new\" = 0000000000000000000000000000000000000000 ] && exit 1; done\nexit 0\n");
    chmodSync(hook, 0o755);
    const r = push(work);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([JSON.stringify({ branch: "feature/acm-1-x", pushed: tip, forced: false, previous: { name: "feature/x", deleted: false } })]);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toStartWith("note: left feature/x on origin: cannot delete feature/x on origin: ");
    expect(git(origin, "rev-parse", "feature/x")).toBe(tip);
    expect(readFeature(work, "x").branch).toMatchObject({ name: "feature/acm-1-x", pushed: tip });
    expect(readFeature(work, "x").branch?.previous).toBeUndefined();
  });

  test("a push after a new commit adds it without forcing", () => {
    const { origin, work } = onFeature();
    push(work);
    const next = commitFile(work, "more.txt", "more\n");
    expect(push(work)).toEqual({ code: 0, out: pushedJson(next), err: [] });
    expect(git(origin, "rev-parse", "feature/x")).toBe(next);
    expect(readFeature(work, "x").branch?.pushed).toBe(next);
  });

  test("before a PR, a rewritten branch is forced over what fbs pushed last", () => {
    const { origin, work } = onFeature();
    push(work);
    const rewritten = amend(work);
    expect(push(work)).toEqual({ code: 0, out: pushedJson(rewritten, true), err: [] });
    expect(git(origin, "rev-parse", "feature/x")).toBe(rewritten);
    expect(readFeature(work, "x").branch?.pushed).toBe(rewritten);
  });

  test("commits someone else pushed are never overwritten, and the record keeps what fbs pushed", () => {
    const { origin, work, tip } = onFeature();
    push(work);
    const theirs = pushFromElsewhere(origin, "feature/x");
    amend(work);
    expect(push(work)).toEqual({ code: 1, out: ["refused: origin has commits fbs didn't push to feature/x; fetch and look before pushing"], err: [] });
    expect(git(origin, "rev-parse", "feature/x")).toBe(theirs);
    expect(readFeature(work, "x").branch?.pushed).toBe(tip);
  });

  test("a branch fbs never pushed is pushed plainly, and a refusal names the one-time way out", () => {
    const { origin, work, tip } = onFeature();
    git(work, "push", "-q", "origin", "feature/x");
    amend(work);
    expect(push(work).out).toEqual([LEGACY]);
    expect(git(origin, "rev-parse", "feature/x")).toBe(tip);
    git(work, "reset", "-q", "--hard", tip);
    const next = commitFile(work, "more.txt", "more\n");
    expect(push(work)).toEqual({ code: 0, out: pushedJson(next), err: [] });
  });

  test("with a PR open, new commits are added but a rewrite is refused and nothing is forced", () => {
    const { origin, work } = onFeature();
    push(work);
    setPr(work, "x", 7, "acme/app");
    const next = commitFile(work, "more.txt", "more\n");
    expect(push(work)).toEqual({ code: 0, out: pushedJson(next), err: [] });
    amend(work);
    expect(push(work)).toEqual({ code: 1, out: ["refused: feature/x has an open PR and its history was rewritten; after a PR opens, only add commits (if that PR was already merged, run fbs stack sync on the feature first: it records the landing)"], err: [] });
    expect(git(origin, "rev-parse", "feature/x")).toBe(next);
    expect(readFeature(work, "x").branch?.pushed).toBe(next);
  });

  test("with a PR open, a rewrite of a branch fbs never pushed names the one-time way out", () => {
    const { origin, work, tip } = onFeature();
    git(work, "push", "-q", "origin", "feature/x");
    setPr(work, "x", 7, "acme/app");
    amend(work);
    expect(push(work)).toEqual({ code: 1, out: [LEGACY], err: [] });
    expect(git(origin, "rev-parse", "feature/x")).toBe(tip);
  });

  test("before a PR, commits the user pushed on top of fbs's are taken in with a plain push once merged here", () => {
    const { origin, work } = onFeature();
    push(work);
    pushFromElsewhere(origin, "feature/x");
    git(work, "fetch", "-q", "origin", "feature/x");
    git(work, "merge", "-q", "--ff-only", "FETCH_HEAD");
    const next = commitFile(work, "more.txt", "more\n");
    expect(push(work)).toEqual({ code: 0, out: pushedJson(next), err: [] });
    expect(git(origin, "rev-parse", "feature/x")).toBe(next);
    expect(readFeature(work, "x").branch?.pushed).toBe(next);
  });

  test("with a PR open, commits someone else pushed are refused", () => {
    const { origin, work } = onFeature();
    push(work);
    setPr(work, "x", 7, "acme/app");
    const theirs = pushFromElsewhere(origin, "feature/x");
    commitFile(work, "more.txt", "more\n");
    expect(push(work).out).toEqual(["refused: origin has commits fbs didn't push to feature/x; fetch and look before pushing"]);
    expect(git(origin, "rev-parse", "feature/x")).toBe(theirs);
  });

  test("the default branch is refused", () => {
    const { origin, work } = cloned();
    enter(work, { use: "main" });
    const before = git(origin, "rev-parse", "main");
    commitFile(work, "local.txt", "local\n");
    expect(push(work)).toEqual({ code: 1, out: ["refused: main is the default branch; pushing it is the user's call"], err: [] });
    expect(git(origin, "rev-parse", "main")).toBe(before);
  });

  test.each(["main", "master"])("%s is refused even when origin's default branch is another one", (name) => {
    const { origin, work } = cloned("trunk");
    git(work, "branch", name);
    enter(work, { use: name });
    expect(push(work)).toEqual({ code: 1, out: [`refused: ${name} is the default branch; pushing it is the user's call`], err: [] });
    expect(() => git(origin, "rev-parse", "--verify", name)).toThrow();
  });

  test("a work tree on another branch is refused", () => {
    const { origin, work } = onFeature();
    git(work, "switch", "-q", "main");
    expect(push(work)).toEqual({ code: 1, out: ["refused: on main, not feature/x"], err: [] });
    git(work, "switch", "-q", "--detach", "feature/x");
    expect(push(work).out).toEqual(["refused: on a detached HEAD, not feature/x"]);
    expect(() => git(origin, "rev-parse", "--verify", "feature/x")).toThrow();
  });

  test("without an origin remote, nothing is pushed or recorded", () => {
    const repo = local();
    enter(repo);
    commitFile(repo, "feature.txt", "work\n");
    expect(push(repo)).toEqual({ code: 0, out: ["skipped: no origin remote"], err: [] });
    expect(readFeature(repo, "x").branch?.pushed).toBeUndefined();
  });

  test("without an origin remote, even a default branch is skipped", () => {
    const repo = local();
    enter(repo, { use: "main" });
    expect(push(repo)).toEqual({ code: 0, out: ["skipped: no origin remote"], err: [] });
  });

  /** Run fbs push with a git that runs `onPush` (a shell snippet) just before pushing. */
  function pushWith(cwd: string, onPush: string): { code: number; out: string[]; err: string[] } {
    const wrapper = join(tempDir(), "git");
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = push ]; then ${onPush}; fi\nexec git "$@"\n`);
    chmodSync(wrapper, 0o755);
    setGitBinary(wrapper);
    try {
      return push(cwd);
    } finally {
      setGitBinary("git");
    }
  }

  test("the commit read before the push is the one pushed and recorded, even if the branch moves meanwhile", () => {
    const { origin, work, tip } = onFeature();
    const later = commitFile(work, "later.txt", "later\n");
    git(work, "reset", "-q", "--hard", tip);
    const r = pushWith(work, `git update-ref refs/heads/feature/x ${later}`);
    expect(r).toEqual({ code: 0, out: pushedJson(tip), err: [] });
    expect(git(origin, "rev-parse", "feature/x")).toBe(tip);
    expect(readFeature(work, "x").branch?.pushed).toBe(tip);
  });

  test("a pushed commit another fbs push recorded meanwhile is not overwritten", () => {
    const { work } = onFeature();
    const path = join(work, ".git/fbs/features/x.json");
    const theirs = { ...JSON.parse(readFileSync(path, "utf8")) };
    theirs.branch = { ...theirs.branch, pushed: "e".repeat(40) };
    const staged = join(tempDir(), "theirs.json");
    writeFileSync(staged, `${JSON.stringify(theirs)}\n`);
    const r = pushWith(work, `cp '${staged}' '${path}'`);
    expect(r).toEqual({ code: 1, out: ["refused: the record of x changed during the push; run fbs push x again"], err: [] });
    expect(readFeature(work, "x").branch?.pushed).toBe("e".repeat(40));
  });

  test("a feature without a record or without a branch is refused", () => {
    const { work } = cloned();
    expect(push(work, "nope")).toEqual({ code: 1, out: ["error: missing: no feature nope"], err: [] });
    expect(push(work)).toEqual({ code: 1, out: ["refused: no branch recorded for x"], err: [] });
  });

  test("the record lock is taken only after the push", () => {
    const { origin, work, tip } = onFeature();
    writeFileSync(join(work, ".git/fbs/features/x.lock"), "");
    const r = push(work);
    expect(r.code).toBe(1);
    expect(r.out[0]).toContain("error: locked:");
    expect(git(origin, "rev-parse", "feature/x")).toBe(tip);
  });

  test("an unreachable origin is an environment error with git's message, and leaves no lock", () => {
    const { work } = onFeature();
    git(work, "remote", "set-url", "origin", join(tempDir(), "gone.git"));
    const r = push(work);
    expect(r.code).toBe(2);
    expect(r.out).toEqual([]);
    expect(r.err[0]).toMatch(/^cannot push feature\/x to origin: fatal: /);
    expect(lockLeft(work)).toBe(false);
    expect(readFeature(work, "x").branch?.pushed).toBeUndefined();
  });

  test.each([[[]], [["x", "y"]], [["x", "--force"]]])("%p is a usage error", (args) => {
    const { work } = cloned();
    const r = run(["push", ...args], { cwd: work, today: "2026-10-25", out: () => {}, err: () => {} });
    expect(r).toBe(2);
  });

  test("outside a git repo is an environment error", () => {
    const r = push(join(tempDir(), "missing"));
    expect(r.code).toBe(2);
    expect(r.out).toEqual([]);
  });
});

describe("a unit's branch", () => {
  const SPEC = "## Facts\n- Two beta clients (.fbs/context.md)\n## Assumptions\nNone\n## Open questions\nNone\n";
  const DESIGN = `${SPEC}## Work units\n### U1: Api\n- Covers: none\n- Depends on: none\n### U2: Ui\n- Covers: none\n- Depends on: U1\n### U3: Db\n- Covers: none\n- Depends on: U2\n### U4: Late\n- Covers: none\n- Depends on: U3\n`;

  /** Big feature f on feature/f with its spec and design committed and approved, and units f-api and f-ui recorded. */
  function stackable(work: string): string {
    initFeature(work, "f", "big", "2026-10-21");
    enter(work, {}, "f");
    commitFile(work, "docs/features/2026-10-21-f/spec.md", SPEC);
    const tip = commitFile(work, "docs/features/2026-10-21-f/design.md", DESIGN);
    approve(work, "f", "spec", "spec ok", "2026-10-21");
    approve(work, "f", "design", "design ok", "2026-10-21");
    initUnit(work, "f-api", "f");
    initUnit(work, "f-ui", "f");
    return tip;
  }

  test("unit 1 starts at the feature branch's tip and takes its parent and base, so the spec and design ship in its PR", () => {
    const { work } = cloned();
    const tip = stackable(work);
    const feature = readFeature(work, "f").branch as FeatureBranch;
    const { result } = enter(work, {}, "f-api");
    expect(result).toEqual({ branch: "feature/f-api", parent: "main", base: feature.base, created: true, switched: true, moved: false, renamed: false });
    expect(git(work, "rev-parse", "HEAD")).toBe(tip);
    expect(git(work, "log", "--format=%s", `${feature.base}..HEAD`).split("\n")).toEqual(["write docs/features/2026-10-21-f/design.md", "write docs/features/2026-10-21-f/spec.md"]);
    expect(readFeature(work, "f-api").branch).toEqual({ name: "feature/f-api", parent: "main", base: feature.base });
  });

  test("unit 1 starts at origin's feature branch when the local one is gone", () => {
    const { work } = cloned();
    const tip = stackable(work);
    git(work, "push", "-q", "origin", "feature/f");
    git(work, "switch", "-q", "main");
    git(work, "branch", "-q", "-D", "feature/f");
    enter(work, {}, "f-api");
    expect(git(work, "rev-parse", "HEAD")).toBe(tip);
  });

  test("unit 2 is stacked on unit 1's branch tip, and its ticket names it", () => {
    const { work } = cloned();
    stackable(work);
    enter(work, {}, "f-api");
    const below = commitFile(work, "api.txt", "api\n");
    setTicket(work, "f-ui", "ACM-7");
    const { result } = enter(work, {}, "f-ui");
    expect(result).toEqual({ branch: "feature/acm-7-f-ui", parent: "feature/f-api", base: below, created: true, switched: true, moved: false, renamed: false });
    expect(git(work, "rev-parse", "HEAD")).toBe(below);
    expect(readFeature(work, "f-ui").branch).toEqual({ name: "feature/acm-7-f-ui", parent: "feature/f-api", base: below });
  });

  test("a unit whose unit below has landed starts from origin's default branch, which becomes its parent", () => {
    const { work } = cloned();
    stackable(work);
    enter(work, {}, "f-api");
    commitFile(work, "api.txt", "api\n");
    git(work, "switch", "-q", "main");
    const landed = commitFile(work, "api.txt", "api\n");
    git(work, "push", "-q", "origin", "main");
    git(work, "reset", "-q", "--hard", "HEAD~1");
    updateFeature(work, "f-api", (rec) => ({ ...rec, landed: { pr: 21, repo: "acme/app", commit: landed, at: "2026-10-25" } }));
    const { result } = enter(work, {}, "f-ui");
    expect(result).toEqual({ branch: "feature/f-ui", parent: "main", base: landed, created: true, switched: true, moved: false, renamed: false });
    expect(git(work, "rev-parse", "HEAD")).toBe(landed);
  });

  test("a unit whose lower branch isn't recorded is refused, and nothing is created", () => {
    const { work } = cloned();
    initFeature(work, "f", "big", "2026-10-21");
    mkdirSync(join(work, "docs/features/2026-10-21-f"), { recursive: true });
    writeFileSync(join(work, "docs/features/2026-10-21-f/spec.md"), SPEC);
    writeFileSync(join(work, "docs/features/2026-10-21-f/design.md"), DESIGN);
    approve(work, "f", "spec", "spec ok", "2026-10-21");
    approve(work, "f", "design", "design ok", "2026-10-21");
    initUnit(work, "f-api", "f");
    initUnit(work, "f-ui", "f");
    expect(refusal(() => enter(work, {}, "f-api"))).toBe("f has no branch yet; f-api stacks on it, so run fbs branch f first");
    expect(refusal(() => enter(work, {}, "f-ui"))).toBe("f-api has no branch yet; f-ui stacks on it, so run fbs branch f-api first");
    initUnit(work, "f-late", "f", 4);
    expect(refusal(() => enter(work, {}, "f-late"))).toBe("unit 3 of f has no record; f-late stacks on it");
    expect(current(work)).toBe("main");
    expect(readFeature(work, "f-ui").branch).toBeUndefined();
  });

  test("--parent is refused for a unit, and --use still adopts a branch", () => {
    const { work } = cloned();
    stackable(work);
    expect(refusal(() => enter(work, { parent: "main" }, "f-api"))).toBe("f-api is unit 1 of f; its stack sets its parent, so --parent isn't used");
    const r: string[] = [];
    expect(run(["branch", "f-api", "--type", "feature", "--parent", "main"], { cwd: work, today: "2026-10-25", out: (l) => r.push(l), err: () => {} })).toBe(1);
    expect(r).toEqual(["refused: f-api is unit 1 of f; its stack sets its parent, so --parent isn't used"]);
    const feature = readFeature(work, "f").branch as FeatureBranch;
    expect(enter(work, { use: "feature/f" }, "f-api").result).toMatchObject({ branch: "feature/f", parent: "main", base: feature.base });
  });

  test("unit 1 adopted with --use takes its feature branch's parent and base", () => {
    const { work } = cloned();
    stackable(work);
    const feature = readFeature(work, "f").branch as FeatureBranch;
    git(work, "switch", "-q", "-c", "feature/api-by-hand");
    commitFile(work, "api.txt", "api\n");
    const { result } = enter(work, { use: "feature/api-by-hand" }, "f-api");
    expect(result).toEqual({ branch: "feature/api-by-hand", parent: "main", base: feature.base, created: false, switched: false, moved: false, renamed: false });
    expect(readFeature(work, "f-api").branch).toEqual({ name: "feature/api-by-hand", parent: "main", base: feature.base });
  });

  test("unit 2 made with a plain git switch -c off unit 1 and adopted with --use is stacked on unit 1", () => {
    const { work } = cloned();
    stackable(work);
    enter(work, {}, "f-api");
    const below = commitFile(work, "api.txt", "api\n");
    git(work, "switch", "-q", "-c", "feature/wit-1464");
    commitFile(work, "ui.txt", "ui\n");
    git(work, "switch", "-q", "main");
    const { result } = enter(work, { use: "feature/wit-1464" }, "f-ui");
    expect(result).toEqual({ branch: "feature/wit-1464", parent: "feature/f-api", base: below, created: false, switched: true, moved: false, renamed: false });
    expect(readFeature(work, "f-ui").branch).toEqual({ name: "feature/wit-1464", parent: "feature/f-api", base: below });
  });

  test("a unit adopted before its stack was recorded gets its parent on the next --use", () => {
    const { work } = cloned();
    stackable(work);
    enter(work, {}, "f-api");
    const below = commitFile(work, "api.txt", "api\n");
    git(work, "switch", "-q", "-c", "feature/wit-1464");
    updateFeature(work, "f-ui", (rec) => ({ ...rec, branch: { name: "feature/wit-1464", parent: null, base: "d".repeat(40) } }));
    expect(enter(work, { use: "feature/wit-1464" }, "f-ui").result).toMatchObject({ parent: "feature/f-api", base: below });
  });

  test("a unit's --use is refused when the branch doesn't contain the tip of the unit below, and nothing is recorded", () => {
    const { work } = cloned();
    stackable(work);
    enter(work, {}, "f-api");
    commitFile(work, "api.txt", "api\n");
    git(work, "switch", "-q", "-c", "feature/wit-1464", "main");
    commitFile(work, "ui.txt", "ui\n");
    git(work, "switch", "-q", "main");
    expect(refusal(() => enter(work, { use: "feature/wit-1464" }, "f-ui"))).toBe(
      "feature/wit-1464 doesn't contain the tip of feature/f-api, which f-ui stacks on; rebase it onto feature/f-api first",
    );
    expect(current(work)).toBe("main");
    expect(readFeature(work, "f-ui").branch).toBeUndefined();
  });

  test("a unit cut by hand before the unit below landed and adopted after stays on that unit's branch, based on its landed head", () => {
    const { work } = cloned();
    stackable(work);
    enter(work, {}, "f-api");
    const head = commitFile(work, "api.txt", "api\n");
    git(work, "switch", "-q", "-c", "feature/wit-1464");
    commitFile(work, "ui.txt", "ui\n");
    git(work, "switch", "-q", "main");
    const squash = commitFile(work, "api.txt", "api\n");
    git(work, "push", "-q", "origin", "main");
    updateFeature(work, "f-api", (rec) => ({ ...rec, landed: { pr: 21, repo: "acme/app", commit: squash, at: "2026-10-25", head } }));
    expect(enter(work, { use: "feature/wit-1464" }, "f-ui").result).toMatchObject({ branch: "feature/wit-1464", parent: "feature/f-api", base: head });
  });

  test("a unit cut from the default branch after a merge commit landed the unit below is adopted onto the default branch", () => {
    const { work } = cloned();
    stackable(work);
    enter(work, {}, "f-api");
    const head = commitFile(work, "api.txt", "api\n");
    git(work, "switch", "-q", "main");
    git(work, "merge", "-q", "--no-ff", "--no-edit", "feature/f-api");
    const merge = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", "origin", "main");
    updateFeature(work, "f-api", (rec) => ({ ...rec, landed: { pr: 21, repo: "acme/app", commit: merge, at: "2026-10-25", head, by: "outside" } }));
    git(work, "switch", "-q", "-c", "feature/wit-1464");
    commitFile(work, "ui.txt", "ui\n");
    expect(enter(work, { use: "feature/wit-1464" }, "f-ui").result).toMatchObject({ branch: "feature/wit-1464", parent: "main", base: merge });
  });

  test("a unit's base is the newer tip of the branch below that it holds, when the local one is behind origin", () => {
    const { work } = cloned();
    stackable(work);
    enter(work, {}, "f-api");
    const old = commitFile(work, "api.txt", "api\n");
    const newer = commitFile(work, "api.txt", "api 2\n");
    git(work, "push", "-q", "origin", "feature/f-api");
    git(work, "reset", "-q", "--hard", old);
    git(work, "switch", "-q", "-c", "feature/wit-1464", "origin/feature/f-api");
    commitFile(work, "ui.txt", "ui\n");
    expect(enter(work, { use: "feature/wit-1464" }, "f-ui").result).toMatchObject({ parent: "feature/f-api", base: newer });
  });

  test("a unit's branch that exists only on origin is adopted onto its stack", () => {
    const { work } = cloned();
    stackable(work);
    enter(work, {}, "f-api");
    const below = commitFile(work, "api.txt", "api\n");
    git(work, "switch", "-q", "-c", "feature/wit-1464");
    const tip = commitFile(work, "ui.txt", "ui\n");
    git(work, "push", "-q", "origin", "feature/wit-1464");
    git(work, "switch", "-q", "main");
    git(work, "branch", "-q", "-D", "feature/wit-1464");
    expect(enter(work, { use: "feature/wit-1464" }, "f-ui").result).toMatchObject({ branch: "feature/wit-1464", parent: "feature/f-api", base: below, switched: true });
    expect(git(work, "rev-parse", "HEAD")).toBe(tip);
  });

  test("unit 1's --use is refused when the branch doesn't contain the feature branch's tip", () => {
    const { work } = cloned();
    stackable(work);
    git(work, "switch", "-q", "-c", "feature/api-by-hand", "main");
    commitFile(work, "api.txt", "api\n");
    expect(refusal(() => enter(work, { use: "feature/api-by-hand" }, "f-api"))).toBe(
      "feature/api-by-hand doesn't contain the tip of feature/f, which f-api stacks on; rebase it onto feature/f first",
    );
  });

  test("re-adopting a unit whose branch is recorded with a parent keeps the record", () => {
    const { work } = cloned();
    stackable(work);
    enter(work, {}, "f-api");
    commitFile(work, "api.txt", "api\n");
    git(work, "switch", "-q", "-c", "feature/wit-1464");
    const recorded = { name: "feature/wit-1464", parent: "feature/f-api", base: "d".repeat(40) };
    updateFeature(work, "f-ui", (rec) => ({ ...rec, branch: recorded }));
    git(work, "switch", "-q", "feature/f-api");
    commitFile(work, "api.txt", "api 2\n");
    expect(enter(work, { use: "feature/wit-1464" }, "f-ui").result).toMatchObject({ branch: recorded.name, parent: recorded.parent, base: recorded.base });
    expect(readFeature(work, "f-ui").branch).toEqual(recorded);
  });

  test("a unit's unborn branch is refused without an empty commit", () => {
    const { work } = cloned();
    stackable(work);
    enter(work, {}, "f-api");
    commitFile(work, "api.txt", "api\n");
    git(work, "switch", "-q", "--orphan", "feature/wit-1464");
    expect(refusal(() => enter(work, { use: "feature/wit-1464" }, "f-ui"))).toStartWith("feature/wit-1464 doesn't contain the tip of feature/f-api");
    expect(() => git(work, "rev-parse", "--verify", "-q", "HEAD")).toThrow();
  });

  test("a unit adopted with --use above a landed unit takes the default branch as its parent", () => {
    const { work } = cloned();
    stackable(work);
    enter(work, {}, "f-api");
    commitFile(work, "api.txt", "api\n");
    git(work, "switch", "-q", "main");
    const landed = commitFile(work, "api.txt", "api\n");
    git(work, "push", "-q", "origin", "main");
    updateFeature(work, "f-api", (rec) => ({ ...rec, landed: { pr: 21, repo: "acme/app", commit: landed, at: "2026-10-25" } }));
    git(work, "switch", "-q", "-c", "feature/wit-1464");
    commitFile(work, "ui.txt", "ui\n");
    expect(enter(work, { use: "feature/wit-1464" }, "f-ui").result).toMatchObject({ branch: "feature/wit-1464", parent: "main", base: landed });
  });
});
