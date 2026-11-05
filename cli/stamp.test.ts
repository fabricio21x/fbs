import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { carryStamp, checkStamp, countCriteria, setStamp, StampRefusedError } from "./stamp";
import { approve, approveAsAgent, initFeature, initUnit, readFeature, type Stamp, updateFeature } from "./status";
import { isolatedGitEnv } from "./test-env";

const PASSING_SPEC = "## Facts\n- Two beta clients (.fbs/context.md)\n## Assumptions\nNone\n## Open questions\nNone\n";
const PASSING_DESIGN = `${PASSING_SPEC}## Work units\nNone\n`;
const VERDICT = "# Verify\n\n## Criteria\n- [x] A space owner can subscribe\n- [x] The plan matches Stripe\n- [ ] Not checked\n\n## Result\nVerdict: pass\n";
const VERDICT_PATH = "docs/features/2026-10-21-x/verdict.md";

let tempDirs: string[] = [];
let repo: string;
let wt: string;

function git(cwd: string, ...args: string[]): string {
  const identity = ["-c", "user.name=fbs", "-c", "user.email=fbs@example.com", "-c", "commit.gpgsign=false"];
  const result = Bun.spawnSync(["git", ...identity, ...args], { cwd, env: isolatedGitEnv(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fbs-stamp-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  repo = tempDir();
  wt = join(tempDir(), "wt");
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function write(path: string, content: string): void {
  writeFileSync(join(repo, path), content);
}

function commitAll(message = "work"): void {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

/** A feature x of `size` with its required documents approved, a passing verdict, everything committed. */
function approvedFeature(size: string, verdict = VERDICT, design = PASSING_DESIGN): void {
  initFeature(repo, "x", size, "2026-10-21");
  write("docs/features/2026-10-21-x/spec.md", PASSING_SPEC);
  write("docs/features/2026-10-21-x/design.md", design);
  if (size === "mid" || size === "big") approve(repo, "x", "spec", "spec ok", "2026-10-21");
  if (size === "big") approve(repo, "x", "design", "design ok", "2026-10-21");
  write(VERDICT_PATH, verdict);
  commitAll();
}

function refusal(body: () => unknown): string[] {
  try {
    body();
  } catch (e) {
    if (e instanceof StampRefusedError) return e.reasons;
    throw e;
  }
  throw new Error("stamp set did not refuse");
}

test("set records the HEAD tree, the date, the criteria count and the verdict path", () => {
  approvedFeature("big");
  const rec = setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  const stamp: Stamp = { tree: git(repo, "rev-parse", "HEAD^{tree}"), at: "2026-10-23", verdict: "pass", criteria: 2, evidence: VERDICT_PATH };
  expect(rec.stamp).toEqual(stamp);
  expect(readFeature(repo, "x").stamp).toEqual(stamp);
});

test("set then check is ok", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  expect(checkStamp(repo, "x")).toEqual([]);
});

test("check without a stamp is missing", () => {
  approvedFeature("big");
  expect(checkStamp(repo, "x")).toEqual(["missing: no stamp"]);
});

test("an edit to a tracked file after set is dirty, and committing it is stale", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  write(VERDICT_PATH, `${VERDICT}edited\n`);
  expect(checkStamp(repo, "x")).toEqual(["dirty: uncommitted changes"]);
  commitAll("edit");
  expect(checkStamp(repo, "x")).toEqual(["stale: tree changed"]);
});

test("an untracked file after set is dirty", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  write("new.txt", "x");
  expect(checkStamp(repo, "x")).toEqual(["dirty: uncommitted changes"]);
});

test("a changed tree with uncommitted changes on top is stale, then dirty", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  write("a.txt", "a");
  commitAll("a");
  write("b.txt", "b");
  expect(checkStamp(repo, "x")).toEqual(["stale: tree changed", "dirty: uncommitted changes"]);
});

test("a commit rewrite that keeps the tree keeps the stamp", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "commit", "-q", "--amend", "-m", "other");
  expect(git(repo, "rev-parse", "HEAD")).not.toBe(head);
  expect(checkStamp(repo, "x")).toEqual([]);
});

test("set refuses a big feature without a design approval, and records nothing", () => {
  initFeature(repo, "x", "big", "2026-10-21");
  write("docs/features/2026-10-21-x/spec.md", PASSING_SPEC);
  approve(repo, "x", "spec", "spec ok", "2026-10-21");
  write(VERDICT_PATH, VERDICT);
  commitAll();
  expect(refusal(() => setStamp(repo, "x", VERDICT_PATH, "2026-10-23"))).toEqual(["design not approved"]);
  expect(readFeature(repo, "x").stamp).toBeUndefined();
});

test("set refuses when the spec changed since its approval, even once committed", () => {
  approvedFeature("big");
  write("docs/features/2026-10-21-x/spec.md", `${PASSING_SPEC}edited\n`);
  commitAll("edit spec");
  expect(refusal(() => setStamp(repo, "x", VERDICT_PATH, "2026-10-23"))).toEqual(["spec changed since its approval"]);
});

test("set refuses a dirty tree", () => {
  approvedFeature("big");
  write("new.txt", "x");
  expect(refusal(() => setStamp(repo, "x", VERDICT_PATH, "2026-10-23"))).toEqual(["uncommitted changes"]);
});

test("set refuses a missing verdict file", () => {
  approvedFeature("big");
  expect(refusal(() => setStamp(repo, "x", "docs/nope.md", "2026-10-23"))).toEqual(["verdict file docs/nope.md does not exist"]);
});

test("set refuses a committed symlink as the verdict, even when its target passes", () => {
  approvedFeature("big");
  const outside = join(tempDir(), "verdict.md");
  writeFileSync(outside, VERDICT);
  const link = "docs/features/2026-10-21-x/link.md";
  symlinkSync(outside, join(repo, link));
  commitAll("link");
  expect(refusal(() => setStamp(repo, "x", link, "2026-10-23"))).toEqual([`verdict file ${link} is not a regular file`]);
});

test("set refuses a directory as the verdict", () => {
  approvedFeature("big");
  expect(refusal(() => setStamp(repo, "x", "docs/features/2026-10-21-x", "2026-10-23"))).toEqual(["verdict file docs/features/2026-10-21-x is not a regular file"]);
});

test("set reads the verdict from the commit, not the working copy", () => {
  approvedFeature("big", "## Criteria\n- [x] A\nVerdict: fail\n");
  git(repo, "update-index", "--assume-unchanged", VERDICT_PATH);
  write(VERDICT_PATH, VERDICT);
  expect(refusal(() => setStamp(repo, "x", VERDICT_PATH, "2026-10-23"))).toEqual([`verdict file ${VERDICT_PATH} has no line "Verdict: pass"`]);
});

test("a modified submodule is dirty even when the repo config ignores it", () => {
  approvedFeature("big");
  const sub = tempDir();
  git(sub, "init", "-q");
  git(sub, "commit", "-q", "--allow-empty", "-m", "sub");
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
  commitAll("add sub");
  git(repo, "config", "submodule.sub.ignore", "all");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  writeFileSync(join(repo, "sub", "new.txt"), "x");
  expect(checkStamp(repo, "x")).toEqual(["dirty: uncommitted changes"]);
});

test("a verdict git ignores is local: read from disk, bound by its sha256, stale once edited and missing once gone", () => {
  approvedFeature("big");
  write(".gitignore", "verdict.md\n");
  git(repo, "rm", "-q", "--cached", VERDICT_PATH);
  commitAll("keep the verdict local");
  const rec = setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  expect(rec.stamp?.verdictSha256).toBe(new Bun.CryptoHasher("sha256").update(VERDICT).digest("hex"));
  expect(rec.stamp?.criteria).toBe(2);
  expect(checkStamp(repo, "x")).toEqual([]);
  write(VERDICT_PATH, VERDICT.replace("Verdict: pass", "Verdict: pass\n\nEdited."));
  expect(checkStamp(repo, "x")).toEqual(["stale: verdict changed"]);
  rmSync(join(repo, VERDICT_PATH));
  expect(checkStamp(repo, "x")).toEqual(["missing: verdict file"]);
});

test("a local verdict is read from the main worktree when stamping in a linked one", () => {
  approvedFeature("big");
  write(".gitignore", "verdict.md\n");
  git(repo, "rm", "-q", "--cached", VERDICT_PATH);
  commitAll("keep the verdict local");
  git(repo, "worktree", "add", "-q", wt, "-b", "wt");
  expect(setStamp(wt, "x", VERDICT_PATH, "2026-10-23").stamp?.verdictSha256).toBeDefined();
  expect(checkStamp(wt, "x")).toEqual([]);
});

test("a local verdict without a pass line is refused", () => {
  approvedFeature("big");
  write(".gitignore", "verdict.md\n");
  git(repo, "rm", "-q", "--cached", VERDICT_PATH);
  commitAll("keep the verdict local");
  write(VERDICT_PATH, "- [x] A\n");
  expect(refusal(() => setStamp(repo, "x", VERDICT_PATH, "2026-10-23"))).toEqual([`verdict file ${VERDICT_PATH} has no line "Verdict: pass"`]);
});

test("a tracked verdict must be committed, and an ignored one that is committed anyway counts as tracked", () => {
  approvedFeature("big");
  const other = "docs/features/2026-10-21-x/other.md";
  write(other, VERDICT);
  expect(refusal(() => setStamp(repo, "x", other, "2026-10-23"))).toEqual(["uncommitted changes", `verdict file ${other} is not committed`]);
  write(".gitignore", "other.md\n");
  git(repo, "add", ".gitignore");
  git(repo, "add", "-f", other);
  commitAll("commit the verdict");
  const stamp = setStamp(repo, "x", other, "2026-10-23").stamp;
  expect(stamp?.evidence).toBe(other);
  expect(stamp?.verdictSha256).toBeUndefined();
  expect(checkStamp(repo, "x")).toEqual([]);
});

test.each([
  ["no verdict line", "- [x] A\n"],
  ["a failing verdict", "- [x] A\nVerdict: fail\n"],
  ["the verdict inside other text", "- [x] A\nThe Verdict: pass is pending\n"],
  ["the verdict inside a comment", "- [x] A\n<!-- Verdict: pass -->\n"],
])("set refuses a verdict file with %s", (_, verdict) => {
  approvedFeature("big", verdict);
  expect(refusal(() => setStamp(repo, "x", VERDICT_PATH, "2026-10-23"))).toEqual([`verdict file ${VERDICT_PATH} has no line "Verdict: pass"`]);
});

test.each(["/etc/passwd", "../outside.md", ".git/config", "docs/../docs/x.md"])("set refuses the verdict path %p", (path) => {
  approvedFeature("big");
  expect(refusal(() => setStamp(repo, "x", path, "2026-10-23"))).toEqual([`verdict path ${path} must be relative to the repo root, inside the repo`]);
});

test("set lists every reason that applies", () => {
  initFeature(repo, "x", "big", "2026-10-21");
  write("new.txt", "x");
  expect(refusal(() => setStamp(repo, "x", "docs/nope.md", "2026-10-23"))).toEqual([
    "uncommitted changes",
    "spec not approved",
    "design not approved",
    "verdict file docs/nope.md does not exist",
  ]);
});

test("a mid feature needs only its spec approval", () => {
  approvedFeature("mid");
  expect(setStamp(repo, "x", VERDICT_PATH, "2026-10-23").stamp?.criteria).toBe(2);
});

test("a mid feature without a spec approval is refused", () => {
  initFeature(repo, "x", "mid", "2026-10-21");
  write(VERDICT_PATH, VERDICT);
  commitAll();
  expect(refusal(() => setStamp(repo, "x", VERDICT_PATH, "2026-10-23"))).toEqual(["spec not approved"]);
});

test.each(["bug", "tiny"])("a %s record with no approvals stamps fine", (size) => {
  approvedFeature(size);
  expect(readFeature(repo, "x").approvals).toEqual({});
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  expect(checkStamp(repo, "x")).toEqual([]);
});

test("a worktree sees the same stamp", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  git(repo, "worktree", "add", "-q", wt, "-b", "wt");
  expect(readFeature(wt, "x").stamp).toEqual(readFeature(repo, "x").stamp);
  expect(checkStamp(wt, "x")).toEqual([]);
});

test("a stamp set in a worktree is seen by the main checkout", () => {
  approvedFeature("big");
  git(repo, "worktree", "add", "-q", wt, "-b", "wt");
  setStamp(wt, "x", VERDICT_PATH, "2026-10-23");
  expect(checkStamp(repo, "x")).toEqual([]);
});

test.each([
  ["spec", "big"],
  ["design", "big"],
  ["spec", "mid"],
])("re-approving the %s of a %s feature clears the stamp", (kind, size) => {
  approvedFeature(size);
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  approve(repo, "x", kind as "spec" | "design", "again", "2026-10-24");
  expect(readFeature(repo, "x").stamp).toBeUndefined();
  expect(checkStamp(repo, "x")).toEqual(["missing: no stamp"]);
});

test("an agent-approved design satisfies set for a big feature like a user one", () => {
  initFeature(repo, "x", "big", "2026-10-21");
  write("docs/features/2026-10-21-x/spec.md", PASSING_SPEC);
  write("docs/features/2026-10-21-x/design.md", PASSING_DESIGN);
  approve(repo, "x", "spec", "spec ok", "2026-10-21");
  approveAsAgent(repo, "x", "design", "simple amendment", "2026-10-22");
  write(VERDICT_PATH, VERDICT);
  commitAll();
  expect(setStamp(repo, "x", VERDICT_PATH, "2026-10-23").stamp?.verdict).toBe("pass");
  write("docs/features/2026-10-21-x/design.md", `${PASSING_DESIGN}edited\n`);
  commitAll("edit design");
  expect(refusal(() => setStamp(repo, "x", VERDICT_PATH, "2026-10-23"))).toEqual(["design changed since its approval"]);
});

test("an agent design approval clears the stamp", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  approveAsAgent(repo, "x", "design", "simple amendment", "2026-10-24");
  expect(readFeature(repo, "x").stamp).toBeUndefined();
});

test("set refuses while another fbs holds the lock, and releases its own lock", () => {
  approvedFeature("big");
  writeFileSync(join(repo, ".git/fbs/features/x.lock"), "");
  expect(() => setStamp(repo, "x", VERDICT_PATH, "2026-10-23")).toThrow(/locked/);
  rmSync(join(repo, ".git/fbs/features/x.lock"));
  expect(refusal(() => setStamp(repo, "x", "docs/nope.md", "2026-10-23"))).toHaveLength(1);
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  expect(readdirSync(join(repo, ".git/fbs/features"))).toEqual(["x.json"]);
});

test.each(["../x", "X"])("set and check reject the unsafe slug %p", (slug) => {
  expect(() => setStamp(repo, slug, VERDICT_PATH, "2026-10-23")).toThrow(/bad-slug/);
  expect(() => checkStamp(repo, slug)).toThrow(/bad-slug/);
});

test("set on an unknown slug is missing", () => {
  expect(() => setStamp(repo, "nope", VERDICT_PATH, "2026-10-23")).toThrow(/missing/);
});

test("set rejects an invalid date", () => {
  approvedFeature("big");
  expect(() => setStamp(repo, "x", VERDICT_PATH, "2026-02-30")).toThrow(/bad-date/);
});

test("criteria counts the lines that start with a checked box, after CRLF, trailing spaces and comments are normalised", () => {
  expect(countCriteria(VERDICT)).toBe(2);
  expect(countCriteria("## Criteria  \r\n- [x] A  \r\n- [X] upper is not counted\r\n  - [x] indented is not counted\n* [x] star is not counted\n<!-- - [x] commented -->\n- [x]no space\n- [x] B\n")).toBe(2);
  expect(countCriteria("Verdict: pass\n")).toBe(0);
});

test("criteria counts only checked boxes under the Criteria heading, up to the next level-2 heading", () => {
  const verdict = "- [x] before\n## Evidence\n- [x] evidence\n## Criteria\n- [x] A\n### Detail\n- [x] B\n## Notes\n- [x] note\n## Criteria extra\n- [x] not this\n";
  expect(countCriteria(verdict)).toBe(2);
});

test("a CRLF verdict file with trailing spaces passes", () => {
  approvedFeature("big", "## Criteria\r\n- [x] A\r\nVerdict: pass  \r\n");
  expect(setStamp(repo, "x", VERDICT_PATH, "2026-10-23").stamp?.criteria).toBe(1);
});

const UNIT_VERDICT_PATH = "docs/features/2026-10-21-x/units/x-api/verdict.md";

/** Unit x-api of the approved big feature x, with its own passing verdict committed. */
function approvedUnit(): void {
  approvedFeature("big", VERDICT, `${PASSING_SPEC}## Work units\n### U1: Api\n- Covers: none\n- Depends on: none\n`);
  initUnit(repo, "x-api", "x");
  write(UNIT_VERDICT_PATH, VERDICT);
  commitAll("unit work");
}

test("a unit is stamped on its feature's approvals", () => {
  approvedUnit();
  expect(setStamp(repo, "x-api", UNIT_VERDICT_PATH, "2026-10-23").stamp?.evidence).toBe(UNIT_VERDICT_PATH);
  expect(checkStamp(repo, "x-api")).toEqual([]);
});

test("a unit's stamp is refused when the feature's design changed after its approval", () => {
  approvedUnit();
  write("docs/features/2026-10-21-x/design.md", `${PASSING_SPEC}edited\n`);
  commitAll("edit design");
  expect(refusal(() => setStamp(repo, "x-api", UNIT_VERDICT_PATH, "2026-10-23"))).toEqual(["design changed since its approval"]);
  expect(readFeature(repo, "x-api").stamp).toBeUndefined();
});

test("a unit's stamp goes stale when the feature's design is approved again elsewhere, on the same tree", () => {
  approvedUnit();
  setStamp(repo, "x-api", UNIT_VERDICT_PATH, "2026-10-23");
  git(repo, "worktree", "add", "-q", wt, "-b", "amend");
  writeFileSync(join(wt, "docs/features/2026-10-21-x/design.md"), `${PASSING_DESIGN}## Notes\namended\n`);
  approve(wt, "x", "design", "amended ok", "2026-10-24");
  expect(checkStamp(repo, "x-api")).toEqual(["stale: design changed since its approval"]);
});

test("a unit whose branch isn't checked out is judged on its branch's tip, the local one else origin's", () => {
  approvedUnit();
  const home = git(repo, "symbolic-ref", "--short", "HEAD");
  git(repo, "switch", "-q", "-c", "feature/x-api");
  setStamp(repo, "x-api", UNIT_VERDICT_PATH, "2026-10-23");
  updateFeature(repo, "x-api", (rec) => ({ ...rec, branch: { name: "feature/x-api", parent: home, base: git(repo, "rev-parse", "HEAD") } }));
  git(repo, "switch", "-q", home);
  write("other.txt", "elsewhere\n");
  commitAll("other work");
  write("untracked.txt", "dirty\n");
  expect(checkStamp(repo, "x-api")).toEqual([]);

  git(repo, "update-ref", "refs/remotes/origin/feature/x-api", "feature/x-api");
  git(repo, "branch", "-q", "-D", "feature/x-api");
  expect(checkStamp(repo, "x-api")).toEqual([]);

  git(repo, "update-ref", "refs/remotes/origin/feature/x-api", home);
  expect(checkStamp(repo, "x-api")).toEqual(["stale: tree changed"]);
  git(repo, "update-ref", "-d", "refs/remotes/origin/feature/x-api");
  expect(checkStamp(repo, "x-api")).toEqual(["stale: branch feature/x-api is gone"]);
});

test("a unit's checked-out branch is judged on the work tree, as a feature is", () => {
  approvedUnit();
  git(repo, "switch", "-q", "-c", "feature/x-api");
  setStamp(repo, "x-api", UNIT_VERDICT_PATH, "2026-10-23");
  updateFeature(repo, "x-api", (rec) => ({ ...rec, branch: { name: "feature/x-api", parent: "main", base: git(repo, "rev-parse", "HEAD") } }));
  write("untracked.txt", "dirty\n");
  expect(checkStamp(repo, "x-api")).toEqual(["dirty: uncommitted changes"]);
});

const DIR = "docs/features/2026-10-21-x";

function treeOf(ref = "HEAD"): string {
  return git(repo, "rev-parse", `${ref}^{tree}`);
}

/** Commit `files` (paths relative to the repo root) as one change. */
function commitFiles(files: Record<string, string>, message = "change"): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    write(path, content);
  }
  commitAll(message);
}

test("carry moves the stamp over a changes.md-only commit, keeping the rest, and check is then ok", () => {
  approvedFeature("big");
  const stamped = setStamp(repo, "x", VERDICT_PATH, "2026-10-23").stamp as Stamp;
  commitFiles({ [`${DIR}/changes.md`]: "# Changes\n" });
  expect(checkStamp(repo, "x")).toEqual(["stale: tree changed"]);
  expect(carryStamp(repo, "x")).toEqual({ from: stamped.tree, to: treeOf(), paths: [`${DIR}/changes.md`] });
  expect(readFeature(repo, "x").stamp).toEqual({ ...stamped, tree: treeOf(), verifiedTree: stamped.tree });
  expect(checkStamp(repo, "x")).toEqual([]);
});

test("carry with nothing changed since the stamp leaves the record as it was", () => {
  approvedFeature("big");
  const stamped = setStamp(repo, "x", VERDICT_PATH, "2026-10-23").stamp;
  expect(carryStamp(repo, "x")).toBeNull();
  expect(readFeature(repo, "x").stamp).toEqual(stamped);
});

test("two carries in a row keep the first verified tree", () => {
  approvedFeature("big");
  const verified = setStamp(repo, "x", VERDICT_PATH, "2026-10-23").stamp?.tree;
  commitFiles({ [`${DIR}/changes.md`]: "one\n" });
  carryStamp(repo, "x");
  commitFiles({ [`${DIR}/notes/review.md`]: "two\n" });
  expect(carryStamp(repo, "x")?.paths).toEqual([`${DIR}/notes/review.md`]);
  expect(readFeature(repo, "x").stamp).toMatchObject({ tree: treeOf(), verifiedTree: verified });
});

test("stamp set after a carry writes a fresh stamp without a verified tree", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  commitFiles({ [`${DIR}/changes.md`]: "one\n" });
  carryStamp(repo, "x");
  expect(readFeature(repo, "x").stamp?.verifiedTree).toBeDefined();
  const rec = setStamp(repo, "x", VERDICT_PATH, "2026-10-24");
  expect(rec.stamp).toEqual({ tree: treeOf(), at: "2026-10-24", verdict: "pass", criteria: 2, evidence: VERDICT_PATH });
  expect(readFeature(repo, "x").stamp?.verifiedTree).toBeUndefined();
});

test("carry refuses a code change, naming the path, and leaves the stamp alone", () => {
  approvedFeature("big");
  const stamped = setStamp(repo, "x", VERDICT_PATH, "2026-10-23").stamp;
  commitFiles({ [`${DIR}/changes.md`]: "one\n", "src/app.ts": "export {};\n" });
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`src/app.ts changed: outside the feature's documents (${DIR}/)`]);
  expect(readFeature(repo, "x").stamp).toEqual(stamped);
  expect(checkStamp(repo, "x")).toEqual(["stale: tree changed"]);
});

test("carry refuses a path that only shares the documents folder's prefix", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  commitFiles({ [`${DIR}-other/changes.md`]: "one\n" });
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`${DIR}-other/changes.md changed: outside the feature's documents (${DIR}/)`]);
});

test.each(["spec.md", "design.md", "bug.md", "plan.md", "units/x-api/plan.md", "Plan.md", "units/x-api/PLAN.MD"])("carry refuses a change to %s, which verify reads", (file) => {
  approvedFeature("bug");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  commitFiles({ [`${DIR}/${file}`]: "edited\n" });
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`${DIR}/${file} changed: verify reads it`]);
});

test("carry refuses an approved spec that changed, for its approval and its path", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  commitFiles({ [`${DIR}/spec.md`]: `${PASSING_SPEC}edited\n` });
  expect(refusal(() => carryStamp(repo, "x"))).toEqual(["spec changed since its approval", `${DIR}/spec.md changed: verify reads it`]);
});

test("carry refuses a change to the stamp's own verdict", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  commitFiles({ [VERDICT_PATH]: "## Criteria\n- [x] A\nVerdict: fail\n" });
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`${VERDICT_PATH} changed: it is the stamp's verdict`]);
});

test("carry lists the first ten paths it can't cover and counts the rest", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  commitFiles(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`src/f${String(i).padStart(2, "0")}.ts`, "x\n"])));
  const reasons = refusal(() => carryStamp(repo, "x"));
  expect(reasons).toHaveLength(11);
  expect(reasons[0]).toBe(`src/f00.ts changed: outside the feature's documents (${DIR}/)`);
  expect(reasons[10]).toBe("3 more changed paths can't be carried");
});

test("carry refuses a dirty work tree", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  commitFiles({ [`${DIR}/changes.md`]: "one\n" });
  write("new.txt", "x");
  expect(refusal(() => carryStamp(repo, "x"))).toEqual(["uncommitted changes"]);
});

test("carry refuses without a stamp", () => {
  approvedFeature("big");
  expect(refusal(() => carryStamp(repo, "x"))).toEqual(["no stamp to carry; verify first"]);
});

test("carry refuses a stamped tree this repo doesn't have", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  updateFeature(repo, "x", (rec) => ({ ...rec, stamp: { ...(rec.stamp as Stamp), tree: "b".repeat(40) } }));
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`the stamped tree ${"b".repeat(40)} is not in this repo; verify again`]);
});

test("carry refuses a local verdict that changed or is gone", () => {
  approvedFeature("big");
  write(".gitignore", "verdict.md\n");
  git(repo, "rm", "-q", "--cached", VERDICT_PATH);
  commitAll("keep the verdict local");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  commitFiles({ [`${DIR}/changes.md`]: "one\n" });
  write(VERDICT_PATH, `${VERDICT}edited\n`);
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`local verdict file ${VERDICT_PATH} changed since the stamp`]);
  rmSync(join(repo, VERDICT_PATH));
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`local verdict file ${VERDICT_PATH} is missing from ${git(repo, "rev-parse", "--show-toplevel")}`]);
  write(VERDICT_PATH, VERDICT);
  expect(carryStamp(repo, "x")?.paths).toEqual([`${DIR}/changes.md`]);
  expect(checkStamp(repo, "x")).toEqual([]);
});

test("a unit's stamp carries over its own and its feature's documents, but not its plan", () => {
  approvedUnit();
  setStamp(repo, "x-api", UNIT_VERDICT_PATH, "2026-10-23");
  commitFiles({ [`${DIR}/units/x-api/changes.md`]: "one\n", [`${DIR}/units/x-ui/verdict.md`]: VERDICT });
  expect(carryStamp(repo, "x-api")?.paths).toEqual([`${DIR}/units/x-api/changes.md`, `${DIR}/units/x-ui/verdict.md`]);
  expect(checkStamp(repo, "x-api")).toEqual([]);
  commitFiles({ [`${DIR}/units/x-api/plan.md`]: "# Plan\n" });
  expect(refusal(() => carryStamp(repo, "x-api"))).toEqual([`${DIR}/units/x-api/plan.md changed: verify reads it`]);
});

test("a unit's carry refuses when its feature's design approval isn't current", () => {
  approvedUnit();
  setStamp(repo, "x-api", UNIT_VERDICT_PATH, "2026-10-23");
  git(repo, "worktree", "add", "-q", wt, "-b", "amend");
  writeFileSync(join(wt, `${DIR}/design.md`), `${PASSING_DESIGN}## Notes\namended\n`);
  approve(wt, "x", "design", "amended ok", "2026-10-24");
  commitFiles({ [`${DIR}/units/x-api/changes.md`]: "one\n" });
  expect(refusal(() => carryStamp(repo, "x-api"))).toEqual(["design changed since its approval"]);
});

test("a unit's carry refuses while its branch isn't checked out, naming it", () => {
  approvedUnit();
  const home = git(repo, "symbolic-ref", "--short", "HEAD");
  git(repo, "switch", "-q", "-c", "feature/x-api");
  setStamp(repo, "x-api", UNIT_VERDICT_PATH, "2026-10-23");
  updateFeature(repo, "x-api", (rec) => ({ ...rec, branch: { name: "feature/x-api", parent: home, base: git(repo, "rev-parse", "HEAD") } }));
  commitFiles({ [`${DIR}/units/x-api/changes.md`]: "one\n" });
  git(repo, "switch", "-q", home);
  expect(refusal(() => carryStamp(repo, "x-api"))).toEqual(["x-api's branch feature/x-api is not checked out; check it out first"]);
  git(repo, "switch", "-q", "feature/x-api");
  expect(carryStamp(repo, "x-api")?.paths).toEqual([`${DIR}/units/x-api/changes.md`]);
});

test("a unit's carry refuses while its branch is checked out in another worktree, naming that worktree", () => {
  approvedUnit();
  const home = git(repo, "symbolic-ref", "--short", "HEAD");
  git(repo, "switch", "-q", "-c", "feature/x-api");
  setStamp(repo, "x-api", UNIT_VERDICT_PATH, "2026-10-23");
  updateFeature(repo, "x-api", (rec) => ({ ...rec, branch: { name: "feature/x-api", parent: home, base: git(repo, "rev-parse", "HEAD") } }));
  commitFiles({ [`${DIR}/units/x-api/changes.md`]: "one\n" });
  git(repo, "switch", "-q", home);
  git(repo, "worktree", "add", "-q", wt, "feature/x-api");
  const checkout = git(wt, "rev-parse", "--show-toplevel");
  expect(refusal(() => carryStamp(repo, "x-api"))).toEqual([`x-api's branch feature/x-api is checked out in another worktree; run it in ${checkout}`]);
  expect(carryStamp(wt, "x-api")?.paths).toEqual([`${DIR}/units/x-api/changes.md`]);
});

test("carry refuses a rename out of spec.md, which git shows as spec.md deleted", () => {
  approvedFeature("bug");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  git(repo, "mv", `${DIR}/spec.md`, `${DIR}/notes.md`);
  commitAll("rename");
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`${DIR}/spec.md changed: verify reads it`]);
});

test("carry refuses a rename onto plan.md", () => {
  approvedFeature("bug");
  commitFiles({ [`${DIR}/notes.md`]: "# Plan\n" });
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  git(repo, "mv", `${DIR}/notes.md`, `${DIR}/plan.md`);
  commitAll("rename");
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`${DIR}/plan.md changed: verify reads it`]);
});

test("carry refuses a deleted spec.md and a deleted verdict", () => {
  approvedFeature("bug");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  git(repo, "rm", "-q", `${DIR}/spec.md`, VERDICT_PATH);
  commitAll("delete");
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`${DIR}/spec.md changed: verify reads it`, `${VERDICT_PATH} changed: it is the stamp's verdict`]);
});

test("carry moves the stamp over a deleted changes.md", () => {
  approvedFeature("big");
  commitFiles({ [`${DIR}/changes.md`]: "# Changes\n" });
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  git(repo, "rm", "-q", `${DIR}/changes.md`);
  commitAll("delete");
  expect(carryStamp(repo, "x")?.paths).toEqual([`${DIR}/changes.md`]);
  expect(checkStamp(repo, "x")).toEqual([]);
});

test("carry moves the stamp over an html document", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  commitFiles({ [`${DIR}/overview.html`]: "<p>overview</p>\n" });
  expect(carryStamp(repo, "x")?.paths).toEqual([`${DIR}/overview.html`]);
});

test("carry refuses code in the documents folder, which bun test would find", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  commitFiles({ [`${DIR}/check.ts`]: "export {};\n", [`${DIR}/check.test.ts`]: "export {};\n" });
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([
    `${DIR}/check.test.ts changed: not a plain document (only .md or .html files carry)`,
    `${DIR}/check.ts changed: not a plain document (only .md or .html files carry)`,
  ]);
});

test("carry refuses afk files, which the afk flow runs", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  commitFiles({ [`${DIR}/afk.json`]: "{}\n", [`${DIR}/afk-x.sh`]: "true\n" });
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`${DIR}/afk-x.sh changed: an afk file, which the afk flow runs`, `${DIR}/afk.json changed: an afk file, which the afk flow runs`]);
});

test("carry refuses a symlink and an executable in the documents folder", () => {
  approvedFeature("big");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  symlinkSync("../../../README.md", join(repo, `${DIR}/link.md`));
  write(`${DIR}/run.md`, "#!/bin/sh\n");
  chmodSync(join(repo, `${DIR}/run.md`), 0o755);
  commitAll("odd documents");
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`${DIR}/link.md changed: a symlink`, `${DIR}/run.md changed: an executable`]);
});

test("carry refuses when a symlink outside the folder points at a document that changed", () => {
  approvedFeature("big");
  commitFiles({ [`${DIR}/value.md`]: "1\n" });
  mkdirSync(join(repo, "src"));
  symlinkSync(`../${DIR}/value.md`, join(repo, "src/value.md"));
  commitAll("link");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  commitFiles({ [`${DIR}/value.md`]: "2\n" });
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`src/value.md is a symlink into the feature's documents (${DIR}/): content outside them can depend on them`]);
});

test("carry refuses when a plan.md symlink points at a document that changed", () => {
  approvedFeature("big");
  commitFiles({ [`${DIR}/notes.md`]: "# Plan\n" });
  mkdirSync(join(repo, `${DIR}/units/u`), { recursive: true });
  symlinkSync("../../notes.md", join(repo, `${DIR}/units/u/plan.md`));
  commitAll("link");
  setStamp(repo, "x", VERDICT_PATH, "2026-10-23");
  commitFiles({ [`${DIR}/notes.md`]: "# Plan\n- edited\n" });
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`${DIR}/units/u/plan.md is a symlink into the feature's documents (${DIR}/): content outside them can depend on them`]);
});

test("a replace ref can't make the stamped tree or commit pass for HEAD's", () => {
  approvedFeature("big");
  const stamped = setStamp(repo, "x", VERDICT_PATH, "2026-10-23").stamp as Stamp;
  const stampedCommit = git(repo, "rev-parse", "HEAD");
  commitFiles({ "src/app.ts": "export {};\n" });
  git(repo, "replace", stamped.tree, treeOf());
  expect(refusal(() => carryStamp(repo, "x"))).toEqual([`src/app.ts changed: outside the feature's documents (${DIR}/)`]);
  git(repo, "replace", "HEAD", stampedCommit);
  expect(checkStamp(repo, "x")).toEqual(["stale: tree changed"]);
});
