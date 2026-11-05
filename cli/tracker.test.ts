import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GhResult, GhRunner } from "./github";
import { detectTracker } from "./tracker";
import { isolatedGitEnv } from "./test-env";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const identity = ["-c", "user.name=fbs", "-c", "user.email=fbs@example.com", "-c", "commit.gpgsign=false"];
  const result = Bun.spawnSync(["git", ...identity, ...args], { cwd, env: isolatedGitEnv(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fbs-tracker-"));
  dirs.push(dir);
  return dir;
}

/** A clone whose origin has `remote` branches and which has `local` branches of its own. */
function repoWith(local: string[], remote: string[] = [], config?: string): string {
  const origin = tempDir();
  git(origin, "init", "-q", "-b", "main");
  git(origin, "commit", "-q", "--allow-empty", "-m", "init");
  for (const name of remote) git(origin, "branch", name);
  const work = join(tempDir(), "work");
  git(dirname(work), "clone", "-q", origin, work);
  for (const name of local) git(work, "branch", name);
  if (config !== undefined) {
    mkdirSync(join(work, ".fbs"));
    writeFileSync(join(work, ".fbs", "config.json"), config);
  }
  return work;
}

/** A gh that answers `pr list` and `issue list` with these results, and records each call. */
function fakeGh(pr: Partial<GhResult>, issue: Partial<GhResult>): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "", ...(args[0] === "pr" ? pr : issue) };
  };
  return { gh, calls };
}

const MISSING_GH = fakeGh({ code: 127, stderr: "cannot run gh" }, { code: 127, stderr: "cannot run gh" }).gh;

test("branch ids are counted per lowercase prefix over local and remote-tracking branches, each name once", () => {
  const repo = repoWith(["feature/acm-41-space-reviews", "alex/ACM-7-fix", "feature/issue-12-x", "chore/add-step-2"], ["feature/acm-41-space-reviews", "feature/acm-50-booking", "eng-3-spike"]);
  expect(detectTracker(repo, MISSING_GH).branchIds).toEqual([
    { prefix: "acm", count: 3, examples: ["alex/ACM-7-fix", "feature/acm-41-space-reviews", "feature/acm-50-booking"] },
    { prefix: "eng", count: 1, examples: ["eng-3-spike"] },
  ]);
});

test("ids inside a description and issue-<n> are not tracker ids", () => {
  expect(detectTracker(repoWith(["feature/add-step-2", "bugfix/issue-4", "feature/v2-3"]), MISSING_GH).branchIds).toEqual([]);
});

test("examples stop at three", () => {
  const names = ["a", "b", "c", "d"].map((n, i) => `feature/acm-${i + 1}-${n}`);
  expect(detectTracker(repoWith(names), MISSING_GH).branchIds).toEqual([{ prefix: "acm", count: 4, examples: names.slice(0, 3) }]);
});

test("PR links count the merged PRs whose body links each tracker, and issues count what gh lists", () => {
  const bodies = [
    "Fixes https://linear.app/acme/issue/ACM-41/space-reviews",
    "Closes #12",
    "fixes #3 and see https://acme.atlassian.net/browse/OPS-9",
    "No link here, #5 alone",
    "",
  ];
  const { gh, calls } = fakeGh({ stdout: JSON.stringify(bodies.map((body) => ({ body }))) }, { stdout: JSON.stringify([{ number: 1 }, { number: 2 }]) });
  const evidence = detectTracker(repoWith([]), gh);
  expect(evidence.prLinks).toEqual({ linear: 1, github: 2, jira: 1 });
  expect(evidence.issues).toBe(2);
  expect(calls).toEqual([
    ["pr", "list", "--state", "merged", "--limit", "30", "--json", "body"],
    ["issue", "list", "--state", "all", "--limit", "20", "--json", "number"],
  ]);
});

test("a missing or failing gh, or output that isn't a JSON array, gives null", () => {
  expect(detectTracker(repoWith([]), MISSING_GH)).toMatchObject({ prLinks: null, issues: null });
  const failing = fakeGh({ code: 1, stderr: "HTTP 404" }, { code: 1, stderr: "issues are disabled" }).gh;
  expect(detectTracker(repoWith([]), failing)).toMatchObject({ prLinks: null, issues: null });
  const garbled = fakeGh({ stdout: "not json" }, { stdout: '{"number":1}' }).gh;
  expect(detectTracker(repoWith([]), garbled)).toMatchObject({ prLinks: null, issues: null });
});

test("config is the configured tracker, or unset", () => {
  expect(detectTracker(repoWith([]), MISSING_GH).config).toBe("unset");
  expect(detectTracker(repoWith([], [], '{"tracker":{"kind":"github"}}'), MISSING_GH).config).toEqual({ kind: "github" });
});
