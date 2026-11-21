import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enterFeatureBranch } from "./branch";
import { isConventionalSubject } from "./commits";
import { run } from "./main";
import { initFeature } from "./status";
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

function commit(cwd: string, subject: string): string {
  git(cwd, "commit", "-q", "--allow-empty", "-m", subject);
  return git(cwd, "rev-parse", "HEAD");
}

/** A repo on main with a commit whose subject isn't conventional, and feature x recorded; on its branch unless `branched` is false. */
function repo(branched = true): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "fbs-commits-")));
  dirs.push(cwd);
  git(cwd, "init", "-q", "-b", "main");
  writeFileSync(join(cwd, "f.txt"), "one\n");
  git(cwd, "add", "f.txt");
  commit(cwd, "Initial import");
  initFeature(cwd, "x", "mid", "2026-10-21");
  if (branched) enterFeatureBranch(cwd, "x", { type: "feature" }, () => {});
  return cwd;
}

function check(cwd: string, ...args: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(["commits", ...args], { cwd, today: "2026-10-28", out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

describe("fbs commits check", () => {
  test("conventional subjects since the branch's base are ok, and commits before it don't count", () => {
    const cwd = repo();
    commit(cwd, "feat(api)!: drop the v1 endpoints");
    commit(cwd, "fix: handle an empty list");
    expect(check(cwd, "check", "x")).toEqual({ code: 0, out: ["ok"], err: [] });
  });

  test("an offending subject is listed with its short sha, in commit order, and exits 1", () => {
    const cwd = repo();
    const wip = commit(cwd, "wip");
    commit(cwd, "feat: fine");
    const upper = commit(cwd, "Feat: capitalised");
    expect(check(cwd, "check", "x")).toEqual({ code: 1, out: [`${wip.slice(0, 12)} wip`, `${upper.slice(0, 12)} Feat: capitalised`], err: [] });
  });

  test("the whole message is held to commitlint config-conventional's limits: header and lines of 100 at most, a blank line after the header", () => {
    const cwd = repo();
    commit(cwd, `feat: ${"a".repeat(94)}\n\n${"b".repeat(100)}\n\nRefs: ACM-123`);
    const header = `feat: ${"a".repeat(95)}`;
    const long = commit(cwd, header);
    const body = commit(cwd, `docs: explain the booking window\n\nShort line.\n${"c".repeat(101)}`);
    const footer = commit(cwd, `fix: retry the sync\n\nBody.\n\nReviewed-by: ${"d".repeat(90)}`);
    expect(check(cwd, "check", "x")).toEqual({
      code: 1,
      out: [
        `${long.slice(0, 12)} ${header} [header is 101 characters, over 100]`,
        `${body.slice(0, 12)} docs: explain the booking window [line 4 is 101 characters, over 100]`,
        `${footer.slice(0, 12)} fix: retry the sync [line 5 is 103 characters, over 100]`,
      ],
      err: [],
    });
  });

  test("no blank line after the header is a warning, as config-conventional has it: listed, but the check passes", () => {
    const cwd = repo();
    const glued = commit(cwd, "fix: handle an empty list\nThe body starts right under the header.");
    expect(check(cwd, "check", "x")).toEqual({ code: 0, out: [`${glued.slice(0, 12)} fix: handle an empty list [warning: no blank line after the header]`, "ok"], err: [] });
    const long = commit(cwd, `fix: retry\n${"f".repeat(101)}`);
    expect(check(cwd, "check", "x")).toEqual({
      code: 1,
      out: [`${glued.slice(0, 12)} fix: handle an empty list [warning: no blank line after the header]`, `${long.slice(0, 12)} fix: retry [line 2 is 101 characters, over 100; warning: no blank line after the header]`],
      err: [],
    });
  });

  test("a subject in sentence or start case, one ending in a full stop, and a header with spaces around it fail, as in config-conventional", () => {
    const cwd = repo();
    const capital = commit(cwd, "feat: Add the booking window");
    const start = commit(cwd, "fix(api): Retry The Sync");
    const stop = commit(cwd, "docs: explain the window.");
    commit(cwd, "feat: add the API client");
    commit(cwd, "fix: 2 retries are enough");
    expect(check(cwd, "check", "x").out).toEqual([
      `${capital.slice(0, 12)} feat: Add the booking window [subject starts with a capital letter]`,
      `${start.slice(0, 12)} fix(api): Retry The Sync [subject starts with a capital letter]`,
      `${stop.slice(0, 12)} docs: explain the window. [subject ends with a full stop]`,
    ]);
    const cwd2 = repo();
    const padded = Bun.spawnSync(["git", "-c", "user.name=fbs", "-c", "user.email=fbs@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--cleanup=verbatim", "-m", "feat: trailing space "], { cwd: cwd2, env: isolatedGitEnv() });
    expect(padded.exitCode).toBe(0);
    const sha = git(cwd2, "rev-parse", "HEAD");
    expect(check(cwd2, "check", "x")).toEqual({ code: 1, out: [`${sha.slice(0, 12)} feat: trailing space  [header has spaces around it]`], err: [] });
  });

  test("fixup!, squash! and amend! commits are skipped, as commitlint skips them", () => {
    const cwd = repo();
    const target = commit(cwd, "feat: one");
    commit(cwd, `fixup! feat: one\n\n${"g".repeat(120)}`);
    commit(cwd, "squash! feat: one");
    commit(cwd, `amend! ${target}\n\nfeat: the one`);
    expect(check(cwd, "check", "x")).toEqual({ code: 0, out: ["ok"], err: [] });
  });

  test("lines ending in CRLF are measured without the carriage return", () => {
    const cwd = repo();
    const file = join(cwd, "..", `msg-${Date.now()}.txt`);
    writeFileSync(file, `fix: windows line endings\r\n\r\n${"h".repeat(100)}\r\n`);
    dirs.push(file);
    const result = Bun.spawnSync(["git", "-c", "user.name=fbs", "-c", "user.email=fbs@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--cleanup=verbatim", "-F", file], { cwd, env: isolatedGitEnv() });
    expect(result.exitCode).toBe(0);
    expect(git(cwd, "log", "-1", "--format=%B")).toContain("\r");
    expect(check(cwd, "check", "x")).toEqual({ code: 0, out: ["ok"], err: [] });
  });

  test("a subject that isn't conventional and a message over the limits are listed on one line", () => {
    const cwd = repo();
    const wip = commit(cwd, `wip\n\n${"e".repeat(120)}`);
    expect(check(cwd, "check", "x")).toEqual({ code: 1, out: [`${wip.slice(0, 12)} wip [line 3 is 120 characters, over 100]`], err: [] });
  });

  test("merge commits are skipped", () => {
    const cwd = repo();
    commit(cwd, "feat: one");
    git(cwd, "switch", "-q", "-c", "side", "main");
    commit(cwd, "docs: side");
    git(cwd, "switch", "-q", "feature/x");
    git(cwd, "merge", "-q", "--no-ff", "--no-edit", "side");
    expect(git(cwd, "log", "-1", "--format=%s")).toBe("Merge branch 'side' into feature/x");
    expect(check(cwd, "check", "x")).toEqual({ code: 0, out: ["ok"], err: [] });
  });

  test("commits brought in by merging the parent are left out, and a merged task branch's are not", () => {
    const cwd = repo();
    git(cwd, "switch", "-q", "main");
    commit(cwd, "Update the readme");
    git(cwd, "switch", "-q", "-c", "task", "feature/x");
    const task = commit(cwd, "task work");
    git(cwd, "switch", "-q", "feature/x");
    git(cwd, "merge", "-q", "--no-ff", "--no-edit", "main");
    git(cwd, "merge", "-q", "--no-ff", "--no-edit", "task");
    expect(check(cwd, "check", "x")).toEqual({ code: 1, out: [`${task.slice(0, 12)} task work`], err: [] });
  });

  test("both copies of the parent are left out, origin's and the local one", () => {
    const cwd = repo();
    git(cwd, "switch", "-q", "main");
    const pushed = commit(cwd, "Pushed to origin");
    git(cwd, "update-ref", "refs/remotes/origin/main", pushed);
    commit(cwd, "Only on the local main");
    git(cwd, "switch", "-q", "feature/x");
    git(cwd, "merge", "-q", "--no-ff", "--no-edit", "main");
    expect(check(cwd, "check", "x")).toEqual({ code: 0, out: ["ok"], err: [] });
  });

  test("a parent rewritten locally after a push leaves out both its old commits on origin and its new ones", () => {
    const cwd = repo(false);
    git(cwd, "switch", "-q", "-c", "feature/p");
    commit(cwd, "feat: lower work");
    enterFeatureBranch(cwd, "x", { type: "feature", parent: "feature/p" }, () => {});
    const own = commit(cwd, "upper work");
    git(cwd, "switch", "-q", "feature/p");
    const old = commit(cwd, "Lower fix");
    git(cwd, "update-ref", "refs/remotes/origin/feature/p", old);
    git(cwd, "switch", "-q", "feature/x");
    git(cwd, "merge", "-q", "--no-ff", "--no-edit", "feature/p");
    git(cwd, "switch", "-q", "feature/p");
    git(cwd, "commit", "-q", "--amend", "--allow-empty", "-m", "Lower fix, reworded");
    git(cwd, "switch", "-q", "feature/x");
    git(cwd, "merge", "-q", "--no-ff", "--no-edit", "feature/p");
    expect(check(cwd, "check", "x")).toEqual({ code: 1, out: [`${own.slice(0, 12)} upper work`], err: [] });
  });

  test("a branch adopted with --use leaves out the default branch's commits", () => {
    const cwd = repo(false);
    git(cwd, "switch", "-q", "-c", "Mine");
    enterFeatureBranch(cwd, "x", { use: "Mine" }, () => {});
    git(cwd, "switch", "-q", "main");
    commit(cwd, "Update the readme");
    git(cwd, "switch", "-q", "Mine");
    const own = commit(cwd, "my work");
    git(cwd, "merge", "-q", "--no-ff", "--no-edit", "main");
    expect(check(cwd, "check", "x")).toEqual({ code: 1, out: [`${own.slice(0, 12)} my work`], err: [] });
  });

  test("a feature with no branch recorded is refused, and a missing one is an error", () => {
    const cwd = repo(false);
    expect(check(cwd, "check", "x")).toEqual({ code: 1, out: ["refused: no branch recorded for x"], err: [] });
    expect(check(cwd, "check", "nope")).toEqual({ code: 1, out: ["error: missing: no feature nope"], err: [] });
  });

  test.each([
    [[]],
    [["check"]],
    [["check", "x", "y"]],
    [["check", "--title"]],
    [["check", "x", "--title", "feat: x"]],
    [["check", "x", "--nope", "a"]],
    [["title"]],
    [["title", ""]],
    [["title", " "]],
    [["title", "feat: x", "y"]],
    [["title", "--title"]],
    [["nope", "x"]],
  ])(
    "%p is a usage error",
    (args) => {
      const r = check(repo(false), ...args);
      expect(r.code).toBe(2);
      expect(r.out).toEqual([]);
      expect(r.err[0]).toStartWith("unknown command: commits");
    },
  );
});

describe("fbs commits title", () => {
  test("a conventional title is ok, needing no feature or repo", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "fbs-commits-")));
    dirs.push(cwd);
    expect(check(cwd, "title", "feat(booking): sync the booking window")).toEqual({ code: 0, out: ["ok"], err: [] });
  });

  test("any other title is printed back and exits 1", () => {
    expect(check(repo(false), "title", "Booking sync")).toEqual({ code: 1, out: ["title: Booking sync"], err: [] });
    expect(check(repo(false), "title", "Feat: watch")).toEqual({ code: 1, out: ["title: Feat: watch"], err: [] });
  });
});

describe("a conventional subject", () => {
  test.each([
    "feat: x",
    "feat(api)!: x",
    "fix!: x",
    "build(deps): bump zod",
    "chore(release v1.2): x",
    "ci: x",
    "docs: x",
    "perf: x",
    "refactor: x",
    "revert: feat: x",
    "style: x",
    "test: x",
    "feat: a description: with a colon",
  ])("%p is accepted", (subject) => {
    expect(isConventionalSubject(subject)).toBe(true);
  });

  test.each([
    "Feat: x",
    "FIX: x",
    "feat:x",
    "feat:  x",
    "feat: ",
    "feat:",
    "feat(): x",
    "feat(a(b)): x",
    "feat(api) : x",
    "feat !: x",
    "feat(api)!!: x",
    "feature: x",
    "wip",
    "",
    "feat: x\nmore",
    "feat(a\nb): x",
  ])("%p is rejected", (subject) => {
    expect(isConventionalSubject(subject)).toBe(false);
  });
});
