import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitCommonDir, repoRoot } from "./git";
import type { GhResult } from "./github";
import { type PrDeps, run, takeToolFlags } from "./main";
import { isolatedGitEnv } from "./test-env";

const io = (out: string[], err: string[], cwd = process.cwd()) => ({ cwd, today: "2026-10-21", out: (s: string) => out.push(s), err: (s: string) => err.push(s) });

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fbs-main-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const identity = ["-c", "user.name=fbs", "-c", "user.email=fbs@example.com", "-c", "commit.gpgsign=false"];
  const result = Bun.spawnSync(["git", ...identity, ...args], { cwd, env: isolatedGitEnv(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

function gitRepo(files: Record<string, string> = {}): string {
  const repo = tempDir();
  git(repo, "init", "-q");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  return repo;
}

function contextCheck(cwd: string, ...flags: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(["context", "check", ...flags], io(out, err, cwd));
  return { code, out, err };
}

function cli(args: string[], cwd: string, env: Record<string, string>) {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "main.ts"), ...args], {
    cwd,
    env: isolatedGitEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("--version prints the plugin version", () => {
  const out: string[] = [];
  expect(run(["--version"], io(out, []))).toBe(0);
  const { version } = JSON.parse(readFileSync(join(import.meta.dir, "../.claude-plugin/plugin.json"), "utf8"));
  expect(out.join("\n")).toBe(`fbs ${version}`);
});

test("unknown subcommand is a usage error", () => {
  const err: string[] = [];
  expect(run(["nope"], io([], err))).toBe(2);
  expect(err.join("\n")).toContain("unknown command: nope");
});

test("context check in a repo with no .fbs reports no context file", () => {
  expect(contextCheck(gitRepo())).toEqual({ code: 0, out: ["ok: no context file"], err: [] });
});

test("context check outside a git repo is an environment error with git's reason", () => {
  const dir = realpathSync(tempDir());
  const r = cli(["context", "check"], dir, { GIT_CEILING_DIRECTORIES: dirname(dir), FBS_TODAY: "2026-10-21" });
  expect(r.code).toBe(2);
  expect(r.stdout).toBe("");
  expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
  expect(r.stderr).toContain("not a git repository");
  expect(r.stderr).toContain("fatal:");
});

test("context check from a directory git cannot run in is an environment error", () => {
  const r = contextCheck(join(tempDir(), "missing"));
  expect(r.code).toBe(2);
  expect(r.err).toHaveLength(1);
  expect(r.err[0]).toContain("missing");
});

test("an invalid FBS_TODAY is an environment error", () => {
  const r = cli(["context", "check"], gitRepo(), { FBS_TODAY: "2026-02-30" });
  expect(r.code).toBe(2);
  expect(r.stdout).toBe("");
  expect(r.stderr.trimEnd()).toBe("invalid FBS_TODAY: 2026-02-30");
});

test("a context.md that cannot be read is an environment error on one line", () => {
  const repo = gitRepo();
  mkdirSync(join(repo, ".fbs", "context.md"), { recursive: true });
  const r = contextCheck(repo);
  expect(r.code).toBe(2);
  expect(r.out).toEqual([]);
  expect(r.err).toHaveLength(1);
  expect(r.err[0]).not.toContain("\n");
  expect(r.err[0]).toContain(".fbs/context.md");
});

test("context errors print one error line each and exit 1", () => {
  const repo = gitRepo({ ".fbs/context.md": "- no date here\n- A. (2026-02-30, alex)\n" });
  expect(contextCheck(repo)).toEqual({
    code: 1,
    out: ["error: line 1: not a fact line: - no date here", "error: line 2: invalid date 2026-02-30"],
    err: [],
  });
});

test("a valid context prints the fact count, then one line per stale fact", () => {
  const repo = gitRepo({ ".fbs/context.md": "- Old. (2026-09-01, alex)\n- New. (2026-10-20, alex)\n" });
  expect(contextCheck(repo)).toEqual({ code: 0, out: ["ok: 2/25 facts", "stale: Old. (2026-09-01, alex)"], err: [] });
});

test("--json prints the report as JSON", () => {
  const repo = gitRepo({ ".fbs/context.md": "- Old. (2026-09-01, alex)\n" });
  const r = contextCheck(repo, "--json");
  expect(r.code).toBe(0);
  const old = { text: "Old.", date: "2026-09-01", source: "alex", line: 1 };
  expect(JSON.parse(r.out.join("\n"))).toEqual({ facts: [old], errors: [], stale: [old], maxFacts: 25 });
});

test("an invalid config is an environment error naming the file", () => {
  const r = contextCheck(gitRepo({ ".fbs/config.json": "{not json" }));
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toContain(".fbs/config.json");
});

test("gitCommonDir is the same absolute path from a subdirectory and from a linked worktree", () => {
  const repo = gitRepo({ "sub/.keep": "" });
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const worktree = join(tempDir(), "wt");
  git(repo, "worktree", "add", "-q", worktree);
  const expected = realpathSync(join(repo, ".git"));
  expect(gitCommonDir(repo)).toBe(expected);
  expect(gitCommonDir(join(repo, "sub"))).toBe(expected);
  expect(gitCommonDir(worktree)).toBe(expected);
});

test("the test preload leaves no inherited GIT_* vars and switches off global and system git config", () => {
  expect(Object.keys(process.env).filter((key) => key.startsWith("GIT_")).sort()).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]);
  expect(process.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
});

test("git lookups take the repo from cwd, never from GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR or GIT_INDEX_FILE", () => {
  const repo = realpathSync(gitRepo({ "sub/.keep": "" }));
  const other = realpathSync(gitRepo());
  const vars = { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other, GIT_COMMON_DIR: join(other, ".git"), GIT_INDEX_FILE: join(other, "index") };
  Object.assign(process.env, vars);
  try {
    expect(repoRoot(join(repo, "sub"))).toBe(repo);
    expect(gitCommonDir(join(repo, "sub"))).toBe(join(repo, ".git"));
  } finally {
    for (const key of Object.keys(vars)) delete process.env[key];
  }
});

test("the fbs CLI takes the repo from cwd even when inherited GIT_* vars point at another repo", () => {
  const repo = gitRepo({ "sub/.keep": "" });
  const other = gitRepo();
  expect(run(["status", "init", "x", "--size", "mid"], io([], [], repo))).toBe(0);
  const vars = { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other, GIT_COMMON_DIR: join(other, ".git"), GIT_INDEX_FILE: join(other, ".git", "index") };
  const r = cli(["status", "list"], join(repo, "sub"), { ...vars, FBS_TODAY: "2026-10-21" });
  expect(r).toEqual({ code: 0, stdout: "x\tmid\tdraft\n", stderr: "" });
});

function status(cwd: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(["status", ...args], io(out, err, cwd));
  return { code, out, err };
}

function featureRepo(spec?: string): string {
  const repo = gitRepo();
  expect(status(repo, "init", "x", "--size", "mid").code).toBe(0);
  if (spec !== undefined) writeFileSync(join(repo, "docs/features/2026-10-21-x/spec.md"), spec);
  return repo;
}

const PASSING_SPEC = "## Facts\n- Two beta clients (.fbs/context.md)\n## Assumptions\n- [x] A (user, 2026-10-21)\n## Open questions\nNone\n";
const PASSING_DESIGN = `${PASSING_SPEC}## Work units\nNone\n`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

test("context check reads an ignored .fbs/ from the main worktree inside a linked one", () => {
  const repo = gitRepo({ ".gitignore": ".fbs/\n", ".fbs/context.md": "- One fact (2026-10-20, alex)\n" });
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-q", "-m", "init");
  const wt = join(tempDir(), "wt");
  git(repo, "worktree", "add", "-q", wt, "-b", "wt");
  expect(contextCheck(wt)).toEqual({ code: 0, out: ["ok: 1/25 facts"], err: [] });
});

test("status init prints the new record", () => {
  const r = status(gitRepo(), "init", "x", "--size", "mid");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out.join("\n"))).toEqual({ slug: "x", dir: "docs/features/2026-10-21-x", size: "mid", approvals: {}, pr: null });
});

test("status show prints the record", () => {
  const r = status(featureRepo(), "show", "x");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out.join("\n")).slug).toBe("x");
});

test("status show says whether the documents are local or tracked, and where they are read from, in a linked worktree too", () => {
  const shownDocs = (cwd: string) => {
    const { docs, docsRoot } = JSON.parse(status(cwd, "show", "x").out.join("\n"));
    return { docs, docsRoot };
  };
  for (const [ignore, docs] of [["", "tracked"], ["docs/\n", "local"]]) {
    const repo = realpathSync(gitRepo({ ".gitignore": ignore }));
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-q", "-m", "init");
    expect(status(repo, "init", "x", "--size", "mid").code).toBe(0);
    expect(shownDocs(repo)).toEqual({ docs, docsRoot: join(repo, "docs/features/2026-10-21-x") });
    const wt = join(realpathSync(tempDir()), "wt");
    git(repo, "worktree", "add", "-q", wt, "-b", "wt");
    expect(shownDocs(wt)).toEqual({ docs, docsRoot: join(docs === "local" ? repo : wt, "docs/features/2026-10-21-x") });
  }
});

test("status gate on a passing spec prints ok", () => {
  expect(status(featureRepo(PASSING_SPEC), "gate", "x", "spec")).toEqual({ code: 0, out: ["ok"], err: [] });
});

test("status approve on a failing spec prints the blockers and exits 1", () => {
  const r = status(featureRepo("## Facts\nNone\n## Assumptions\n- [ ] A\n"), "approve", "x", "spec", "--quote", "q");
  expect(r).toEqual({ code: 1, out: ["missing section: Open questions", "unconfirmed: A"], err: [] });
});

test("blocker lines come out as missing, empty, unsourced, unconfirmed, then open questions", () => {
  const spec = "## Facts\n- F\n## Assumptions\n- [ ] A\n## Open questions\n- Q1\n## Notes\n### Assumptions\n";
  const repo = gitRepo();
  expect(status(repo, "init", "x", "--size", "big").code).toBe(0);
  writeFileSync(join(repo, "docs/features/2026-10-21-x/spec.md"), spec);
  expect(status(repo, "gate", "x", "spec").out).toEqual([
    "empty section: Assumptions (write None if there are none)",
    "unsourced: F",
    "unconfirmed: A",
    "open question: Q1",
  ]);
  writeFileSync(join(repo, "docs/features/2026-10-21-x/design.md"), "## Assumptions\n- [ ] A\n## Notes\n### Assumptions\n");
  expect(status(repo, "gate", "x", "design").out).toEqual([
    "missing section: Facts",
    "missing section: Open questions",
    "missing section: Work units",
    "empty section: Assumptions (write None if there are none)",
    "unconfirmed: A",
  ]);
});

test("status gate on a design checks its work units against the spec, and approving it is refused the same way", () => {
  const repo = gitRepo();
  expect(status(repo, "init", "x", "--size", "big").code).toBe(0);
  const dir = join(repo, "docs/features/2026-10-21-x");
  writeFileSync(join(dir, "spec.md"), `${PASSING_SPEC}## Acceptance criteria\n- [ ] One\n- [ ] Two\n`);
  expect(status(repo, "approve", "x", "spec", "--quote", "ok").code).toBe(0);
  const units = "## Work units\n### U1: First\n- Covers: AC1\n- Depends on: U2\n### U2: Second\n- Covers: AC1\n- Depends on: U1\n";
  writeFileSync(join(dir, "design.md"), `${PASSING_SPEC}${units}`);
  const blockers = [
    "work units: U1 depends on U2; a unit depends only on lower-numbered units",
    "work units: AC1 is covered by U1, U2; each criterion belongs to exactly one unit",
    "work units: AC2 isn't covered by any unit",
  ];
  expect(status(repo, "gate", "x", "design")).toEqual({ code: 1, out: blockers, err: [] });
  expect(status(repo, "approve", "x", "design", "--quote", "ok")).toEqual({ code: 1, out: blockers, err: [] });
  writeFileSync(join(dir, "design.md"), `${PASSING_SPEC}${units.replace("Depends on: U2", "Depends on: none").replace("- Covers: AC1\n- Depends on: U1", "- Covers: AC2\n- Depends on: U1")}`);
  expect(status(repo, "gate", "x", "design")).toEqual({ code: 0, out: ["ok"], err: [] });
  writeFileSync(join(dir, "design.md"), `${PASSING_SPEC}## Work units\nNone\n`);
  expect(status(repo, "gate", "x", "design")).toEqual({ code: 0, out: ["ok"], err: [] });
  expect(status(repo, "gate", "x", "spec")).toEqual({ code: 0, out: ["ok"], err: [] });
});

test("a big design without a Work units section is missing it, and approving it is refused", () => {
  const repo = bigFeatureRepo();
  writeFileSync(join(repo, "docs/features/2026-10-21-x/design.md"), PASSING_SPEC);
  expect(status(repo, "gate", "x", "design")).toEqual({ code: 1, out: ["missing section: Work units"], err: [] });
  expect(status(repo, "approve", "x", "design", "--quote", "ok")).toEqual({ code: 1, out: ["missing section: Work units"], err: [] });
});

test("unsupported markup lines come out after the other blocker kinds", () => {
  const r = status(featureRepo("## Facts\nNone\n## Assumptions\n- [ ] A\n## Open questions\n- Q1\n## Notes\n<!-- todo\n```md\n"), "gate", "x", "spec");
  expect(r).toEqual({ code: 1, out: ["unconfirmed: A", "open question: Q1", "unsupported markup: <!-- todo", "unsupported markup: ```md"], err: [] });
});

test("status approve on a passing spec prints the record with the approval", () => {
  const r = status(featureRepo(PASSING_SPEC), "approve", "x", "spec", "--quote", "ship it");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out.join("\n")).approvals).toEqual({ spec: { at: "2026-10-21", by: "user", quote: "ship it", sha256: sha256(PASSING_SPEC) } });
});

test("status show marks each approval current or not from the document on disk", () => {
  const repo = gitRepo();
  expect(status(repo, "init", "x", "--size", "big").code).toBe(0);
  const dir = join(repo, "docs/features/2026-10-21-x");
  writeFileSync(join(dir, "spec.md"), PASSING_SPEC);
  writeFileSync(join(dir, "design.md"), PASSING_DESIGN);
  expect(status(repo, "approve", "x", "spec", "--quote", "s").code).toBe(0);
  expect(status(repo, "approve", "x", "design", "--quote", "d").code).toBe(0);
  writeFileSync(join(dir, "design.md"), `${PASSING_DESIGN}edited\n`);
  const r = status(repo, "show", "x");
  expect(r.code).toBe(0);
  const approvals = JSON.parse(r.out.join("\n")).approvals;
  expect(approvals.spec).toEqual({ at: "2026-10-21", by: "user", quote: "s", sha256: sha256(PASSING_SPEC), current: true });
  expect(approvals.design).toEqual({ at: "2026-10-21", by: "user", quote: "d", sha256: sha256(PASSING_DESIGN), current: false });
  expect(JSON.parse(readFileSync(join(repo, RECORDS, "x.json"), "utf8")).approvals.spec.current).toBeUndefined();
});

test("a design approval against a changed spec prints spec-changed and exits 1", () => {
  const repo = gitRepo();
  expect(status(repo, "init", "x", "--size", "big").code).toBe(0);
  const dir = join(repo, "docs/features/2026-10-21-x");
  writeFileSync(join(dir, "spec.md"), PASSING_SPEC);
  writeFileSync(join(dir, "design.md"), PASSING_DESIGN);
  expect(status(repo, "approve", "x", "spec", "--quote", "s").code).toBe(0);
  writeFileSync(join(dir, "spec.md"), `${PASSING_SPEC}edited\n`);
  expect(status(repo, "approve", "x", "design", "--quote", "d")).toEqual({ code: 1, out: [expect.stringMatching(/^error: spec-changed: /)], err: [] });
});

test("status list prints one line per feature with its stage", () => {
  const repo = featureRepo(PASSING_SPEC);
  expect(status(repo, "init", "y", "--size", "big").code).toBe(0);
  expect(status(repo, "approve", "x", "spec", "--quote", "q").code).toBe(0);
  expect(status(repo, "list")).toEqual({ code: 0, out: ["x\tmid\tspec approved", "y\tbig\tdraft"], err: [] });
});

test("a status error prints its code on stdout and exits 1", () => {
  expect(status(gitRepo(), "show", "nope")).toEqual({ code: 1, out: [expect.stringMatching(/^error: missing: /)], err: [] });
  expect(status(gitRepo(), "init", "../x", "--size", "mid").out).toEqual([expect.stringMatching(/^error: bad-slug: /)]);
});

test.each([
  [["init", "x"]],
  [["init", "x", "--size"]],
  [["init", "x", "--size", "mid", "extra"]],
  [["init", "x", "--color", "red"]],
  [["show"]],
  [["gate", "x", "plan"]],
  [["approve", "x", "spec"]],
  [["approve", "x", "spec", "--quote", ""]],
  [["approve", "x", "spec", "--quote", "a", "--quote", "b"]],
  [["approve", "x", "design", "--auto"]],
  [["approve", "x", "design", "--auto", "  "]],
  [["approve", "x", "design", "--quote", "a", "--auto", "b"]],
  [["approve", "x", "design", "--auto", "a", "--quote", "b"]],
  [["list", "extra"]],
  [["nope"]],
  [[]],
])("status %p is a usage error", (args) => {
  const r = status(featureRepo(PASSING_SPEC), ...args);
  expect(r.code).toBe(2);
  expect(r.out).toEqual([]);
  expect(r.err).toHaveLength(1);
});

test("status outside a git repo is an environment error", () => {
  const dir = realpathSync(tempDir());
  const r = cli(["status", "list"], dir, { GIT_CEILING_DIRECTORIES: dirname(dir), FBS_TODAY: "2026-10-21" });
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("not a git repository");
});

const RECORDS = ".git/fbs/features";

function writeRecordFile(repo: string, name: string, content: string): void {
  mkdirSync(join(repo, RECORDS), { recursive: true });
  writeFileSync(join(repo, RECORDS, name), content);
}

function expectEnvironmentError(r: { code: number; out: string[]; err: string[] }, text: string): void {
  expect(r.code).toBe(2);
  expect(r.out).toEqual([]);
  expect(r.err).toHaveLength(1);
  expect(r.err[0]).toContain(text);
}

test.each([["{not json"], ["{}"]])("a corrupt record %p is an environment error for show, list and approve", (content) => {
  const repo = featureRepo(PASSING_SPEC);
  writeRecordFile(repo, "x.json", content);
  expectEnvironmentError(status(repo, "show", "x"), "x.json");
  expectEnvironmentError(status(repo, "list"), "x.json");
  expectEnvironmentError(status(repo, "approve", "x", "spec", "--quote", "q"), "x.json");
  expect(readFileSync(join(repo, RECORDS, "x.json"), "utf8")).toBe(content);
});

test("a record with a tampered slug is an environment error and nothing is written", () => {
  const repo = featureRepo(PASSING_SPEC);
  const record = JSON.parse(readFileSync(join(repo, RECORDS, "x.json"), "utf8"));
  writeRecordFile(repo, "x.json", JSON.stringify({ ...record, slug: "y" }));
  expectEnvironmentError(status(repo, "show", "x"), "slug");
  expectEnvironmentError(status(repo, "approve", "x", "spec", "--quote", "q"), "slug");
  expect(readdirSync(join(repo, RECORDS))).toEqual(["x.json"]);
});

test("a record with a dir outside the repo is an environment error and nothing is read or written there", () => {
  const parent = tempDir();
  const repo = join(parent, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  expect(status(repo, "init", "x", "--size", "mid").code).toBe(0);
  mkdirSync(join(parent, "outside"));
  writeFileSync(join(parent, "outside", "spec.md"), PASSING_SPEC);
  const record = JSON.parse(readFileSync(join(repo, RECORDS, "x.json"), "utf8"));
  const tampered = JSON.stringify({ ...record, dir: "../outside" });
  writeRecordFile(repo, "x.json", tampered);
  expectEnvironmentError(status(repo, "gate", "x", "spec"), "dir");
  expectEnvironmentError(status(repo, "approve", "x", "spec", "--quote", "q"), "dir");
  expect(readFileSync(join(repo, RECORDS, "x.json"), "utf8")).toBe(tampered);
  expect(readdirSync(join(repo, RECORDS))).toEqual(["x.json"]);
  expect(readdirSync(join(parent, "outside"))).toEqual(["spec.md"]);
});

test.each(["/tmp/features", "../features", ".git/features", "docs/.GIT/features"])("featuresDir %p is an environment error and init writes nothing", (featuresDir) => {
  const repo = gitRepo({ ".fbs/config.json": JSON.stringify({ featuresDir }) });
  expectEnvironmentError(status(repo, "init", "x", "--size", "mid"), ".fbs/config.json");
  expect(readdirSync(repo).sort()).toEqual([".fbs", ".git"]);
});

test("init where the feature dir cannot be created is an environment error and leaves no record", () => {
  const repo = gitRepo({ docs: "not a directory" });
  expectEnvironmentError(status(repo, "init", "x", "--size", "mid"), "ENOTDIR");
  expect(readdirSync(join(repo, RECORDS))).toEqual([]);
});

test("a document that cannot be read is an environment error on one line", () => {
  const repo = featureRepo();
  mkdirSync(join(repo, "docs/features/2026-10-21-x/spec.md"));
  expectEnvironmentError(status(repo, "gate", "x", "spec"), "EISDIR");
  expectEnvironmentError(status(repo, "approve", "x", "spec", "--quote", "q"), "EISDIR");
  expect(readdirSync(join(repo, RECORDS))).toEqual(["x.json"]);
});

test("status list skips a badly named record with a warning", () => {
  const repo = featureRepo();
  writeRecordFile(repo, "Bad.json", "{not json");
  const r = status(repo, "list");
  expect(r.code).toBe(0);
  expect(r.out).toEqual(["x\tmid\tdraft"]);
  expect(r.err).toHaveLength(1);
  expect(r.err[0]).toContain("Bad.json");
});

test("an empty FBS_TODAY is an environment error", () => {
  const r = cli(["context", "check"], gitRepo(), { FBS_TODAY: "" });
  expect(r.code).toBe(2);
  expect(r.stdout).toBe("");
  expect(r.stderr.trimEnd()).toBe("invalid FBS_TODAY:");
});

test("git and CLI fixtures ignore GIT_* vars inherited from the developer", () => {
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(tempDir(), "not-a-repo");
  try {
    const repo = gitRepo();
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const r = cli(["status", "list"], repo, { FBS_TODAY: "2026-10-21" });
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});

function stamp(cwd: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(["stamp", ...args], io(out, err, cwd));
  return { code, out, err };
}

const VERDICT_PATH = "docs/features/2026-10-21-x/verdict.md";

/** A mid feature x with an approved spec and a passing verdict, all committed. */
function stampableRepo(): string {
  const repo = featureRepo(PASSING_SPEC);
  expect(status(repo, "approve", "x", "spec", "--quote", "ship it").code).toBe(0);
  writeFileSync(join(repo, VERDICT_PATH), "## Criteria\n- [x] A\n- [x] B\n- [ ] C\nVerdict: pass\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "work");
  return repo;
}

function headTreeOf(repo: string): string {
  return Bun.spawnSync(["git", "rev-parse", "HEAD^{tree}"], { cwd: repo, env: isolatedGitEnv() }).stdout.toString().trim();
}

test("stamp set prints the record with the stamp, and check prints ok", () => {
  const repo = stampableRepo();
  const r = stamp(repo, "set", "x", "--verdict", VERDICT_PATH);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out.join("\n")).stamp).toEqual({ tree: headTreeOf(repo), at: "2026-10-21", verdict: "pass", criteria: 2, evidence: VERDICT_PATH });
  expect(stamp(repo, "check", "x")).toEqual({ code: 0, out: ["ok"], err: [] });
});

test("stamp check prints missing, dirty and stale and exits 1", () => {
  const repo = stampableRepo();
  expect(stamp(repo, "check", "x")).toEqual({ code: 1, out: ["missing: no stamp"], err: [] });
  expect(stamp(repo, "set", "x", "--verdict", VERDICT_PATH).code).toBe(0);
  writeFileSync(join(repo, "new.txt"), "x");
  expect(stamp(repo, "check", "x")).toEqual({ code: 1, out: ["dirty: uncommitted changes"], err: [] });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "more");
  expect(stamp(repo, "check", "x")).toEqual({ code: 1, out: ["stale: tree changed"], err: [] });
  writeFileSync(join(repo, "new.txt"), "y");
  expect(stamp(repo, "check", "x")).toEqual({ code: 1, out: ["stale: tree changed", "dirty: uncommitted changes"], err: [] });
});

test("stamp set prints one refused line per reason and exits 1", () => {
  const repo = featureRepo();
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  writeFileSync(join(repo, "new.txt"), "x");
  expect(stamp(repo, "set", "x", "--verdict", VERDICT_PATH)).toEqual({
    code: 1,
    out: ["refused: uncommitted changes", "refused: spec not approved", `refused: verdict file ${VERDICT_PATH} does not exist`],
    err: [],
  });
});

test("stamp set refuses a verdict file without Verdict: pass", () => {
  const repo = stampableRepo();
  writeFileSync(join(repo, VERDICT_PATH), "- [x] A\nVerdict: fail\n");
  git(repo, "commit", "-q", "-am", "fail");
  expect(stamp(repo, "set", "x", "--verdict", VERDICT_PATH)).toEqual({ code: 1, out: [`refused: verdict file ${VERDICT_PATH} has no line "Verdict: pass"`], err: [] });
});

test("stamp carry prints ok when nothing changed, then carried with the trees and paths over a documents-only commit", () => {
  const repo = stampableRepo();
  expect(stamp(repo, "set", "x", "--verdict", VERDICT_PATH).code).toBe(0);
  expect(stamp(repo, "carry", "x")).toEqual({ code: 0, out: ["ok"], err: [] });
  const stamped = headTreeOf(repo);
  writeFileSync(join(repo, "docs/features/2026-10-21-x/changes.md"), "# Changes\n");
  writeFileSync(join(repo, "docs/features/2026-10-21-x/notes.md"), "notes\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "docs");
  expect(stamp(repo, "check", "x")).toEqual({ code: 1, out: ["stale: tree changed"], err: [] });
  const paths = "docs/features/2026-10-21-x/changes.md, docs/features/2026-10-21-x/notes.md";
  expect(stamp(repo, "carry", "x")).toEqual({ code: 0, out: [`carried: ${stamped.slice(0, 12)} -> ${headTreeOf(repo).slice(0, 12)}; only documents changed: ${paths}`], err: [] });
  expect(stamp(repo, "check", "x")).toEqual({ code: 0, out: ["ok"], err: [] });
  expect(JSON.parse(readFileSync(join(repo, RECORDS, "x.json"), "utf8")).stamp.verifiedTree).toBe(stamped);
});

test("stamp carry prints one refused line per reason and exits 1", () => {
  const repo = stampableRepo();
  expect(stamp(repo, "carry", "x")).toEqual({ code: 1, out: ["refused: no stamp to carry; verify first"], err: [] });
  expect(stamp(repo, "set", "x", "--verdict", VERDICT_PATH).code).toBe(0);
  writeFileSync(join(repo, "app.ts"), "export {};\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "code");
  writeFileSync(join(repo, "new.txt"), "x");
  expect(stamp(repo, "carry", "x")).toEqual({
    code: 1,
    out: ["refused: uncommitted changes", "refused: app.ts changed: outside the feature's documents (docs/features/2026-10-21-x/)"],
    err: [],
  });
});

test("stamp set refuses a directory as the verdict with a refused line", () => {
  expect(stamp(stampableRepo(), "set", "x", "--verdict", "docs/features/2026-10-21-x")).toEqual({
    code: 1,
    out: ["refused: verdict file docs/features/2026-10-21-x is not a regular file"],
    err: [],
  });
});

test("status show marks a stale but clean stamp not current", () => {
  const repo = stampableRepo();
  expect(stamp(repo, "set", "x", "--verdict", VERDICT_PATH).code).toBe(0);
  git(repo, "commit", "-q", "--allow-empty", "-m", "same tree");
  expect(JSON.parse(status(repo, "show", "x").out.join("\n")).stamp.current).toBe(true);
  writeFileSync(join(repo, "new.txt"), "x");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "new tree");
  expect(JSON.parse(status(repo, "show", "x").out.join("\n")).stamp.current).toBe(false);
});

test("status show on a stamped record in a repo with no commits is an environment error", () => {
  const repo = featureRepo();
  const record = JSON.parse(readFileSync(join(repo, RECORDS, "x.json"), "utf8"));
  writeRecordFile(repo, "x.json", JSON.stringify({ ...record, stamp: { tree: "b".repeat(40), at: "2026-10-21", verdict: "pass", criteria: 1, evidence: VERDICT_PATH } }));
  expectEnvironmentError(status(repo, "show", "x"), "HEAD");
});

test("status show marks the stamp current or not, and never writes current", () => {
  const repo = stampableRepo();
  expect(JSON.parse(status(repo, "show", "x").out.join("\n")).stamp).toBeUndefined();
  expect(stamp(repo, "set", "x", "--verdict", VERDICT_PATH).code).toBe(0);
  expect(JSON.parse(status(repo, "show", "x").out.join("\n")).stamp.current).toBe(true);
  writeFileSync(join(repo, "new.txt"), "x");
  expect(JSON.parse(status(repo, "show", "x").out.join("\n")).stamp).toEqual({ tree: headTreeOf(repo), at: "2026-10-21", verdict: "pass", criteria: 2, evidence: VERDICT_PATH, current: false });
  expect(JSON.parse(readFileSync(join(repo, RECORDS, "x.json"), "utf8")).stamp.current).toBeUndefined();
});

test("a malformed stamp is an environment error for show, stamp check and stamp set", () => {
  const repo = stampableRepo();
  const record = JSON.parse(readFileSync(join(repo, RECORDS, "x.json"), "utf8"));
  const tampered = JSON.stringify({ ...record, stamp: { tree: "nope", at: "2026-10-21", verdict: "pass", criteria: 1, evidence: VERDICT_PATH } });
  writeRecordFile(repo, "x.json", tampered);
  expectEnvironmentError(status(repo, "show", "x"), "stamp.tree");
  expectEnvironmentError(stamp(repo, "check", "x"), "stamp.tree");
  expectEnvironmentError(stamp(repo, "set", "x", "--verdict", VERDICT_PATH), "stamp.tree");
  expect(readFileSync(join(repo, RECORDS, "x.json"), "utf8")).toBe(tampered);
});

test("stamp check in a repo with no commits yet is an environment error", () => {
  const repo = featureRepo();
  const record = JSON.parse(readFileSync(join(repo, RECORDS, "x.json"), "utf8"));
  writeRecordFile(repo, "x.json", JSON.stringify({ ...record, stamp: { tree: "b".repeat(40), at: "2026-10-21", verdict: "pass", criteria: 1, evidence: VERDICT_PATH } }));
  expectEnvironmentError(stamp(repo, "check", "x"), "HEAD");
});

test("stamp with an unsafe slug or an unknown feature prints the status error and exits 1", () => {
  const repo = stampableRepo();
  expect(stamp(repo, "check", "../x").out).toEqual([expect.stringMatching(/^error: bad-slug: /)]);
  expect(stamp(repo, "set", "../x", "--verdict", VERDICT_PATH)).toEqual({ code: 1, out: [expect.stringMatching(/^error: bad-slug: /)], err: [] });
  expect(stamp(repo, "check", "nope")).toEqual({ code: 1, out: [expect.stringMatching(/^error: missing: /)], err: [] });
});

test.each([
  [[]],
  [["set", "x"]],
  [["set", "--verdict", VERDICT_PATH]],
  [["set", "x", "--verdict"]],
  [["set", "x", "--verdict", ""]],
  [["set", "x", "y", "--verdict", VERDICT_PATH]],
  [["set", "x", "--quote", "q"]],
  [["check"]],
  [["check", "x", "y"]],
  [["check", "x", "--verdict", VERDICT_PATH]],
  [["carry"]],
  [["carry", "x", "y"]],
  [["carry", "x", "--verdict", VERDICT_PATH]],
  [["nope", "x"]],
])("stamp %p is a usage error", (args) => {
  const r = stamp(stampableRepo(), ...args);
  expect(r.code).toBe(2);
  expect(r.out).toEqual([]);
  expect(r.err).toHaveLength(1);
  expect(r.err[0]).toStartWith("unknown command: stamp");
});

/** A big feature x with passing spec and design documents and the spec approved by the user. */
function bigFeatureRepo(): string {
  const repo = gitRepo();
  expect(status(repo, "init", "x", "--size", "big").code).toBe(0);
  writeFileSync(join(repo, "docs/features/2026-10-21-x/spec.md"), PASSING_SPEC);
  writeFileSync(join(repo, "docs/features/2026-10-21-x/design.md"), PASSING_DESIGN);
  expect(status(repo, "approve", "x", "spec", "--quote", "s").code).toBe(0);
  return repo;
}

test("status approve --auto records the design as the agent's, and show prints who approved each", () => {
  const repo = bigFeatureRepo();
  const r = status(repo, "approve", "x", "design", "--auto", "follows from the approved spec change");
  expect(r.code).toBe(0);
  const design = { at: "2026-10-21", by: "agent", reason: "follows from the approved spec change", sha256: sha256(PASSING_DESIGN) };
  expect(JSON.parse(r.out.join("\n")).approvals.design).toEqual(design);
  const approvals = JSON.parse(status(repo, "show", "x").out.join("\n")).approvals;
  expect(approvals.spec.by).toBe("user");
  expect(approvals.design).toEqual({ ...design, current: true });
});

test("status show prints by user for an approval recorded without by", () => {
  const repo = bigFeatureRepo();
  const path = join(repo, RECORDS, "x.json");
  const rec = JSON.parse(readFileSync(path, "utf8"));
  delete rec.approvals.spec.by;
  writeFileSync(path, JSON.stringify(rec));
  expect(JSON.parse(status(repo, "show", "x").out.join("\n")).approvals.spec.by).toBe("user");
});

test("status approve --auto on the spec is refused and exits 1", () => {
  expect(status(featureRepo(PASSING_SPEC), "approve", "x", "spec", "--auto", "simple")).toEqual({ code: 1, out: ["refused: the spec needs the user's approval"], err: [] });
});

test("status approve --auto on a design whose spec approval isn't current prints the spec error and exits 1", () => {
  const repo = bigFeatureRepo();
  writeFileSync(join(repo, "docs/features/2026-10-21-x/spec.md"), `${PASSING_SPEC}edited\n`);
  expect(status(repo, "approve", "x", "design", "--auto", "simple")).toEqual({ code: 1, out: [expect.stringMatching(/^error: spec-changed: /)], err: [] });
});

test("status approve --auto on a failing design prints the blockers and exits 1", () => {
  const repo = bigFeatureRepo();
  writeFileSync(join(repo, "docs/features/2026-10-21-x/design.md"), "## Facts\nNone\n## Assumptions\n- [ ] A\n## Open questions\nNone\n## Work units\nNone\n");
  expect(status(repo, "approve", "x", "design", "--auto", "simple")).toEqual({ code: 1, out: ["unconfirmed: A"], err: [] });
});

test("the help lists both ways to approve", () => {
  const out: string[] = [];
  expect(run(["help"], io(out, []))).toBe(0);
  expect(out.join("\n")).toContain("status approve <slug> <spec|design> --quote <the user's words>");
  expect(out.join("\n")).toContain("status approve <slug> design --auto <why the agent may approve it>");
});

test("the help lists the stamp commands", () => {
  const out: string[] = [];
  expect(run(["help"], io(out, []))).toBe(0);
  expect(out.join("\n")).toContain("stamp set <slug> --verdict <repo-relative path>");
  expect(out.join("\n")).toContain("stamp check <slug>");
  expect(out.join("\n")).toContain("stamp carry <slug>");
});

test("the help lists the branch types", () => {
  const out: string[] = [];
  expect(run(["help"], io(out, []))).toBe(0);
  expect(out.join("\n")).toContain("branch <slug> [--type <feature|bugfix|hotfix|chore>] [--ticket <id>] [--existing] [--parent <branch>]");
});

test("branch names the flags --use can't be combined with, instead of an unknown command", () => {
  const out: string[] = [];
  const err: string[] = [];
  expect(run(["branch", "x", "--use", "feature/a", "--parent", "feature/b"], io(out, err))).toBe(2);
  expect(out).toEqual([]);
  expect(err).toEqual(["branch: --use and --parent can't be combined"]);
});

test("the help lists the commits check and the title check, with the type set", () => {
  const out: string[] = [];
  expect(run(["help"], io(out, []))).toBe(0);
  const help = out.join("\n");
  expect(help).toContain("commits check <slug> ");
  expect(help).toContain("commits title <text> ");
  expect(help).toContain("commitlint config-conventional's");
  expect(help).toContain("build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test");
});

test("the help lists the PR commands", () => {
  const out: string[] = [];
  expect(run(["help"], io(out, []))).toBe(0);
  const help = out.join("\n");
  for (const line of ["status pr <slug> <number|url|none>", "watch-pr <slug> [--interval <s>] [--timeout <s>] [--once]", "pr reply <slug> --comment <thread|issue|review>:<id> --body-file <path>", "pr resolve <slug> --thread <id>"]) {
    expect(help).toContain(line);
  }
  expect(help).toContain("6 conflict");
  expect(help).toContain("8 ready");
  expect(help).toContain("9 waiting");
  expect(help).toContain("land <slug>");
  expect(help).toContain("land request <slug>");
  expect(help).toContain("guard [--prompt|--reply]");
});

const PR_HEAD = "e".repeat(40);
const page = { hasPreviousPage: false };

function graphqlAnswer(pr: Record<string, unknown>): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          baseRefName: "main",
          headRefOid: PR_HEAD,
          reviewDecision: "APPROVED",
          reviews: { pageInfo: page, nodes: [] },
          reviewThreads: { pageInfo: page, nodes: [] },
          comments: { pageInfo: page, nodes: [] },
          commits: {
            nodes: [
              {
                commit: {
                  oid: PR_HEAD,
                  statusCheckRollup: {
                    contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", databaseId: 1, name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] },
                  },
                },
              },
            ],
          },
          ...pr,
        },
      },
    },
  });
}

/** Fake deps whose gh answers by route and records every call, --input file content included. */
function prDeps(routes: Record<string, Partial<GhResult>>) {
  const calls: { args: string[]; input: string | null }[] = [];
  const deps: PrDeps = {
    stdin: () => "",
    now: () => 0,
    sleep: () => {
      throw new Error("tests never sleep");
    },
    gh: (args) => {
      const inputAt = args.indexOf("--input");
      calls.push({ args, input: inputAt === -1 ? null : readFileSync(args[inputAt + 1], "utf8") });
      const route = Object.keys(routes).find((key) => args.includes(key) || args.some((arg) => arg.startsWith(key)));
      return { code: 0, stdout: "", stderr: "", ...(route === undefined ? { code: 1, stderr: "gh: Not Found (HTTP 404)" } : routes[route]) };
    },
  };
  return { deps, calls };
}

const REPO_VIEW = { nameWithOwner: { stdout: "acme/app\n" } };

function prStatus(cwd: string, deps: PrDeps, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(["status", "pr", ...args], io(out, err, cwd), deps);
  return { code, out, err };
}

test("status pr with a number records it with the repo gh names, and show prints both", () => {
  const repo = featureRepo();
  const { deps, calls } = prDeps(REPO_VIEW);
  const r = prStatus(repo, deps, "x", "42");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out.join("\n"))).toMatchObject({ pr: 42, repo: "acme/app" });
  expect(calls.map((c) => c.args[0])).toEqual(["repo"]);
  expect(JSON.parse(status(repo, "show", "x").out.join("\n"))).toMatchObject({ pr: 42, repo: "acme/app" });
});

test("status pr <slug> none clears the PR and its repo", () => {
  const repo = featureRepo();
  const { deps, calls } = prDeps({});
  expect(prStatus(repo, deps, "x", "https://github.com/acme/web/pull/9").code).toBe(0);
  const r = prStatus(repo, deps, "x", "none");
  expect(r.code).toBe(0);
  const shown = JSON.parse(status(repo, "show", "x").out.join("\n"));
  expect(shown.pr).toBeNull();
  expect("repo" in shown).toBe(false);
  expect(JSON.parse(r.out.join("\n")).pr).toBeNull();
  expect(calls).toEqual([]);
});

test("status pr with a URL takes the repo from it without asking gh", () => {
  const repo = featureRepo();
  const { deps, calls } = prDeps({});
  const r = prStatus(repo, deps, "x", "https://github.com/acme/web.app/pull/913/files");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out.join("\n"))).toMatchObject({ pr: 913, repo: "acme/web.app" });
  expect(calls).toEqual([]);
});

test.each(["0", "-3", "4.2", "abc", "01", "12345678901", "https://gitlab.com/a/b/pull/1", "https://github.com/a/pull/1"])("status pr refuses %p", (ref) => {
  const repo = featureRepo();
  const r = prStatus(repo, prDeps(REPO_VIEW).deps, "x", ref);
  expect(r.code).toBe(1);
  expect(r.out[0]).toStartWith("error: bad-pr: ");
  expect(JSON.parse(status(repo, "show", "x").out.join("\n")).pr).toBeNull();
});

test("status pr needs a slug and a number, and a repo gh can name", () => {
  const repo = featureRepo();
  const { deps } = prDeps(REPO_VIEW);
  expect(prStatus(repo, deps, "x").code).toBe(2);
  expect(prStatus(repo, deps, "x", "1", "2").code).toBe(2);
  expect(prStatus(repo, deps, "nope", "1")).toEqual({ code: 1, out: ["error: missing: no feature nope"], err: [] });
  const noRemote = prStatus(repo, prDeps({ nameWithOwner: { code: 1, stderr: "no git remotes found" } }).deps, "x", "1");
  expect(noRemote.code).toBe(2);
  expect(noRemote.err[0]).toContain("cannot tell the GitHub repo");
});

test("status ticket records the ticket and its url, prints the record, and none clears it", () => {
  const repo = featureRepo();
  const url = "https://linear.app/acme/issue/ACM-123/booking-sync";
  const r = status(repo, "ticket", "x", "ACM-123", "--url", url);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out.join("\n")).ticket).toEqual({ id: "ACM-123", url });
  expect(JSON.parse(status(repo, "show", "x").out.join("\n")).ticket).toEqual({ id: "ACM-123", url });
  expect(JSON.parse(status(repo, "ticket", "x", "#42").out.join("\n")).ticket).toEqual({ id: "#42" });
  const cleared = status(repo, "ticket", "x", "none");
  expect(cleared.code).toBe(0);
  expect("ticket" in JSON.parse(cleared.out.join("\n"))).toBe(false);
});

test("status ticket refuses a bad id or url, and needs a slug and an id", () => {
  const repo = featureRepo();
  expect(status(repo, "ticket", "x", "ACM 1").out[0]).toStartWith("error: bad-ticket: ");
  expect(status(repo, "ticket", "x", "ACM-1", "--url", "http://x.test").code).toBe(1);
  expect(status(repo, "ticket", "x").code).toBe(2);
  expect(status(repo, "ticket", "x", "none", "--url", "https://x.test").code).toBe(2);
  expect(status(repo, "ticket", "x", "ACM-1", "--quote", "q").code).toBe(2);
  expect("ticket" in JSON.parse(status(repo, "show", "x").out.join("\n"))).toBe(false);
});

function tracker(cwd: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(["tracker", ...args], io(out, err, cwd), prDeps({ pr: { stdout: '[{"body":"Fixes #4"}]' }, issue: { stdout: "[]" } }).deps);
  return { code, out, err };
}

test("tracker detect prints the evidence as one JSON line", () => {
  const repo = gitRepo({ ".fbs/config.json": '{"tracker": {"kind": "github"}}' });
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "branch", "feature/acm-2-x");
  const r = tracker(repo, "detect");
  expect(r.code).toBe(0);
  expect(r.out).toHaveLength(1);
  expect(JSON.parse(r.out[0])).toEqual({
    config: { kind: "github" },
    branchIds: [{ prefix: "acm", count: 1, examples: ["feature/acm-2-x"] }],
    prLinks: { linear: 0, github: 1, jira: 0 },
    issues: 0,
  });
  expect(tracker(repo, "detect", "--all").code).toBe(2);
});

test("tracker show prints the configured tracker on one line, or unset", () => {
  expect(tracker(gitRepo(), "show")).toEqual({ code: 0, out: ["unset"], err: [] });
  const linear = gitRepo({ ".fbs/config.json": '{"tracker": {"kind": "linear", "team": "ACM"}}' });
  expect(tracker(linear, "show")).toEqual({ code: 0, out: ['{"kind":"linear","team":"ACM"}'], err: [] });
  const none = gitRepo({ ".fbs/config.json": '{"tracker": {"kind": "none"}}' });
  expect(tracker(none, "show")).toEqual({ code: 0, out: ['{"kind":"none"}'], err: [] });
});

test("tracker show on an invalid tracker is an environment error, and other subcommands are usage errors", () => {
  expectEnvironmentError(tracker(gitRepo({ ".fbs/config.json": '{"tracker": {"kind": "jira"}}' }), "show"), "tracker must be");
  expect(tracker(gitRepo()).code).toBe(2);
  expect(tracker(gitRepo(), "show", "x").code).toBe(2);
  expect(tracker(gitRepo(), "set").code).toBe(2);
});

test("a record with a PR but no repo, or a repo without a PR, is an environment error", () => {
  const repo = gitRepo();
  for (const record of [{ pr: 3 }, { pr: null, repo: "a/b" }, { pr: 3, repo: "not a repo" }]) {
    writeRecordFile(repo, "x.json", JSON.stringify({ slug: "x", dir: "docs/features/2026-10-21-x", size: "mid", approvals: {}, ...record }));
    expectEnvironmentError(status(repo, "show", "x"), "repo must be owner/name");
  }
});

function prRepo(): string {
  const repo = featureRepo();
  expect(prStatus(repo, prDeps({}).deps, "x", "https://github.com/acme/app/pull/7").code).toBe(0);
  return repo;
}

function prCommand(cwd: string, deps: PrDeps, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, io(out, err, cwd), deps);
  return { code, out, err };
}

const cursorFile = (repo: string) => join(repo, ".git", "fbs", "pr", "x.json");

test("watch-pr --once prints the verdict as one JSON line, exits with its code and saves the cursor", () => {
  const repo = prRepo();
  const comment = { databaseId: 9, author: { login: "ana", __typename: "User" }, body: "Why?", createdAt: "2026-10-25T10:00:00Z", updatedAt: "2026-10-25T10:00:00Z" };
  const { deps, calls } = prDeps({ graphql: { stdout: graphqlAnswer({ comments: { pageInfo: page, nodes: [comment] } }) } });
  const first = prCommand(repo, deps, "watch-pr", "x", "--once");
  expect(first.code).toBe(3);
  expect(first.out).toHaveLength(1);
  expect(JSON.parse(first.out[0])).toEqual({
    verdict: "activity",
    pr: 7,
    state: "OPEN",
    head: PR_HEAD,
    draft: false,
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    truncated: false,
    newComments: [{ id: 9, key: "issue:9", kind: "issue", threadId: null, author: "ana", bot: false, path: null, line: null, body: "Why?", createdAt: "2026-10-25T10:00:00Z", updatedAt: "2026-10-25T10:00:00Z", edited: false }],
    failingChecks: [],
    unresolvedThreads: 0,
  });
  expect(calls.every((c) => c.args.includes("owner=acme") && c.args.includes("repo=app"))).toBe(true);
  expect(first.err.map((line) => JSON.parse(line).verdict)).toEqual(["activity"]);
  const again = prCommand(repo, deps, "watch-pr", "x", "--once");
  expect(again.code).toBe(0);
  expect(JSON.parse(again.out[0]).verdict).toBe("approved-green");
});

test.each([
  [{ state: "MERGED" }, "closed", 4],
  [{ mergeable: "CONFLICTING" }, "conflict", 6],
  [{ reviewDecision: "REVIEW_REQUIRED", reviewThreads: { pageInfo: page, nodes: [{ id: "T", isResolved: false, path: null, line: null, comments: { pageInfo: page, nodes: [] } }] } }, "timeout", 5],
  [{ isDraft: true, mergeStateStatus: "DRAFT", reviewDecision: null }, "ready", 8],
  [{ reviewDecision: "REVIEW_REQUIRED" }, "waiting", 9],
])("watch-pr --once on %p is %p, exit %p", (pr, verdict, code) => {
  const { deps } = prDeps({ graphql: { stdout: graphqlAnswer(pr) } });
  const r = prCommand(prRepo(), deps, "watch-pr", "x", "--once");
  expect(r.code).toBe(code);
  expect(JSON.parse(r.out[0]).verdict).toBe(verdict);
});

test("a timeout leaves the cursor unsaved, so the next watch reports the same comment", () => {
  const repo = prRepo();
  const comment = { databaseId: 9, author: { login: "codex", __typename: "Bot" }, body: "Nit", createdAt: "2026-10-25T10:00:00Z", updatedAt: "2026-10-25T10:00:00Z" };
  const pendingCheck = { __typename: "CheckRun", databaseId: 2, name: "ci", status: "IN_PROGRESS", conclusion: null };
  const commits = { nodes: [{ commit: { oid: PR_HEAD, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [pendingCheck] } } } }] };
  const { deps } = prDeps({ graphql: { stdout: graphqlAnswer({ comments: { pageInfo: page, nodes: [comment] }, commits }) } });
  const r = prCommand(repo, deps, "watch-pr", "x", "--once");
  expect(r.code).toBe(5);
  expect(JSON.parse(r.out[0]).newComments.map((c: { key: string }) => c.key)).toEqual(["issue:9"]);
  expect(existsSync(cursorFile(repo))).toBe(false);
  expect(JSON.parse(prCommand(repo, deps, "watch-pr", "x", "--once").out[0]).newComments).toHaveLength(1);
});

test("watch-pr with a transient gh failure and no time left reports query-error with exit 7 and saves nothing", () => {
  const repo = prRepo();
  const { deps, calls } = prDeps({ graphql: { code: 1, stderr: "HTTP 502: Bad Gateway" } });
  const r = prCommand(repo, deps, "watch-pr", "x", "--once");
  expect(r.code).toBe(7);
  expect(JSON.parse(r.out[0])).toEqual({ verdict: "query-error", pr: 7, error: "gh api graphql failed: HTTP 502: Bad Gateway" });
  expect(calls).toHaveLength(1);
  expect(existsSync(cursorFile(repo))).toBe(false);
});

test.each([
  [{ code: 127, stderr: "cannot run gh: ENOENT" }, "gh is missing"],
  [{ code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login" }, "gh is not authenticated"],
  [{ code: 1, stderr: "GraphQL: Could not resolve to a PullRequest with the number of 7." }, "repo or PR not found"],
])("watch-pr fails fast on a permanent gh failure %p with exit 2", (result, message) => {
  const { deps, calls } = prDeps({ graphql: result });
  const r = prCommand(prRepo(), { ...deps, now: () => 0 }, "watch-pr", "x");
  expect(r.code).toBe(2);
  expect(r.out).toEqual([]);
  expect(r.err.at(-1)).toContain(message);
  expect(calls).toHaveLength(1);
});

test("watch-pr without a recorded PR is refused with no-pr", () => {
  const { deps, calls } = prDeps({});
  const r = prCommand(featureRepo(), deps, "watch-pr", "x");
  expect(r).toEqual({ code: 1, out: ["error: no-pr: feature x has no PR; record it with fbs status pr x <number|url>"], err: [] });
  expect(calls).toEqual([]);
});

test.each([[["watch-pr"]], [["watch-pr", "x", "--interval", "0"]], [["watch-pr", "x", "--timeout", "-1"]], [["watch-pr", "x", "--once", "--once"]], [["watch-pr", "x", "--nope"]]])(
  "watch-pr usage error %p",
  (args) => {
    const { deps } = prDeps({});
    const r = prCommand(prRepo(), deps, ...args);
    expect(r.code).toBe(2);
    expect(r.err[0]).toStartWith("unknown command: watch-pr");
  },
);

test("watch-pr with a malformed cursor is an environment error", () => {
  const repo = prRepo();
  mkdirSync(dirname(cursorFile(repo)), { recursive: true });
  writeFileSync(cursorFile(repo), "{}");
  const { deps } = prDeps({ graphql: { stdout: graphqlAnswer({}) } });
  const r = prCommand(repo, deps, "watch-pr", "x", "--once");
  expect(r.code).toBe(2);
  expect(r.out).toEqual([]);
  expect(r.err[0]).toContain("invalid cursor");
});

test("pr reply posts the body file through --input to the keyed comment and marks its own reply seen", () => {
  const repo = prRepo();
  writeFileSync(join(repo, "reply.md"), "Done; `rm -rf /` stays text.\n");
  const { deps, calls } = prDeps({
    "repos/acme/app/pulls/comments/5": { stdout: JSON.stringify({ id: 5, pull_request_url: "https://api.github.com/repos/acme/app/pulls/7" }) },
    "repos/acme/app/pulls/7/comments/5/replies": { stdout: JSON.stringify({ id: 6, updated_at: "2026-10-25T11:00:00Z", html_url: "https://github.com/r/6" }) },
  });
  const r = prCommand(repo, deps, "pr", "reply", "x", "--comment", "thread:5", "--body-file", "reply.md");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out.join("\n"))).toEqual({ kind: "thread", id: 6, updatedAt: "2026-10-25T11:00:00Z", url: "https://github.com/r/6" });
  expect(calls).toHaveLength(2);
  expect(calls[1].args).toEqual(["api", "--method", "POST", "repos/acme/app/pulls/7/comments/5/replies", "--input", expect.any(String)]);
  expect(JSON.parse(calls[1].input ?? "")).toEqual({ body: "Done; `rm -rf /` stays text.\n" });
  expect(JSON.parse(readFileSync(cursorFile(repo), "utf8")).comments).toEqual({ "thread:6": "2026-10-25T11:00:00Z" });
});

test("a watch that saves after a reply keeps the reply seen", () => {
  const repo = prRepo();
  writeFileSync(join(repo, "reply.md"), "ok");
  const { deps } = prDeps({
    "repos/acme/app/issues/comments/9": { stdout: JSON.stringify({ id: 9, body: "Why?", issue_url: "https://api.github.com/repos/acme/app/issues/7" }) },
    "repos/acme/app/issues/7/comments": { stdout: JSON.stringify({ id: 10, updated_at: "2026-10-25T11:00:00Z" }) },
    graphql: { stdout: graphqlAnswer({ state: "CLOSED" }) },
  });
  expect(prCommand(repo, deps, "pr", "reply", "x", "--comment", "issue:9", "--body-file", "reply.md").code).toBe(0);
  expect(prCommand(repo, deps, "watch-pr", "x", "--once").code).toBe(4);
  expect(JSON.parse(readFileSync(cursorFile(repo), "utf8")).comments).toEqual({ "issue:10": "2026-10-25T11:00:00Z" });
});

test("pr reply refuses an empty body, a comment off the PR, and a feature without a PR", () => {
  const repo = prRepo();
  writeFileSync(join(repo, "empty.md"), "  \n");
  writeFileSync(join(repo, "reply.md"), "ok");
  const { deps } = prDeps({});
  expect(prCommand(repo, deps, "pr", "reply", "x", "--comment", "thread:5", "--body-file", "empty.md").out[0]).toStartWith("error: bad-body: ");
  expect(prCommand(repo, deps, "pr", "reply", "x", "--comment", "review:5", "--body-file", "reply.md")).toEqual({ code: 1, out: ["error: not-on-pr: no review comment 5 on PR #7"], err: [] });
  expect(prCommand(featureRepo(), deps, "pr", "reply", "x", "--comment", "thread:5", "--body-file", "reply.md").out[0]).toStartWith("error: no-pr: ");
});

test("pr reply with a missing body file or a failing gh is an environment error", () => {
  const repo = prRepo();
  writeFileSync(join(repo, "reply.md"), "ok");
  const { deps } = prDeps({});
  const missing = prCommand(repo, deps, "pr", "reply", "x", "--comment", "thread:5", "--body-file", "nope.md");
  expect(missing.code).toBe(2);
  expect(missing.err[0]).toContain("nope.md");
  const { deps: broken } = prDeps({ "repos/acme/app/pulls/comments/5": { code: 1, stderr: "HTTP 401: Bad credentials" } });
  const failed = prCommand(repo, broken, "pr", "reply", "x", "--comment", "thread:5", "--body-file", "reply.md");
  expect(failed.code).toBe(2);
  expect(failed.err[0]).toContain("Bad credentials");
});

test("pr resolve resolves a thread of the PR", () => {
  const { deps, calls } = prDeps({
    "query=query": { stdout: JSON.stringify({ data: { node: { pullRequest: { number: 7, repository: { nameWithOwner: "acme/app" } } } } }) },
    "query=mutation": { stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }) },
  });
  const r = prCommand(prRepo(), deps, "pr", "resolve", "x", "--thread", "PRRT_kwDO1");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out.join("\n"))).toEqual({ thread: "PRRT_kwDO1", resolved: true });
  expect(calls.map((c) => c.args.at(-1))).toEqual(["id=PRRT_kwDO1", "id=PRRT_kwDO1"]);
});

test("pr reply to a review thread's node id posts the GraphQL reply mutation with the id and body as variables", () => {
  const repo = prRepo();
  writeFileSync(join(repo, "reply.md"), "Fixed in abc123.\n");
  const { deps, calls } = prDeps({
    "query=query": { stdout: JSON.stringify({ data: { node: { __typename: "PullRequestReviewThread", pullRequest: { number: 7, repository: { nameWithOwner: "acme/app" } } } } }) },
    graphql: { stdout: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { databaseId: 6, updatedAt: "2026-10-25T11:00:00Z", url: "https://github.com/r/6" } } } }) },
  });
  const r = prCommand(repo, deps, "pr", "reply", "x", "--comment", "thread:PRRT_kwDO1", "--body-file", "reply.md");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out.join("\n"))).toEqual({ kind: "thread", id: 6, updatedAt: "2026-10-25T11:00:00Z", url: "https://github.com/r/6" });
  expect(calls).toHaveLength(2);
  expect(calls[0].args.at(-1)).toBe("id=PRRT_kwDO1");
  expect(calls[1].args).toEqual(["api", "graphql", "--input", expect.any(String)]);
  const { query, variables } = JSON.parse(calls[1].input ?? "");
  expect(query).toContain("addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body })");
  expect(variables).toEqual({ id: "PRRT_kwDO1", body: "Fixed in abc123.\n" });
  expect(JSON.parse(readFileSync(cursorFile(repo), "utf8")).comments).toEqual({ "thread:6": "2026-10-25T11:00:00Z" });
});

test("pr reply to a review comment's node id replies in its thread through the REST path", () => {
  const repo = prRepo();
  writeFileSync(join(repo, "reply.md"), "ok");
  const { deps, calls } = prDeps({
    "query=query": { stdout: JSON.stringify({ data: { node: { __typename: "PullRequestReviewComment", databaseId: 5, pullRequest: { number: 7, repository: { nameWithOwner: "acme/app" } } } } }) },
    "repos/acme/app/pulls/comments/5": { stdout: JSON.stringify({ id: 5, pull_request_url: "https://api.github.com/repos/acme/app/pulls/7" }) },
    "repos/acme/app/pulls/7/comments/5/replies": { stdout: JSON.stringify({ id: 6, updated_at: "2026-10-25T11:00:00Z" }) },
  });
  expect(prCommand(repo, deps, "pr", "reply", "x", "--comment", "thread:PRRC_kwDO5", "--body-file", "reply.md").code).toBe(0);
  expect(calls.at(-1)?.args.slice(0, 4)).toEqual(["api", "--method", "POST", "repos/acme/app/pulls/7/comments/5/replies"]);
});

test("pr reply to a node id on another PR is refused before anything is posted", () => {
  const repo = prRepo();
  writeFileSync(join(repo, "reply.md"), "ok");
  const { deps, calls } = prDeps({
    "query=query": { stdout: JSON.stringify({ data: { node: { __typename: "PullRequestReviewThread", pullRequest: { number: 8, repository: { nameWithOwner: "acme/app" } } } } }) },
  });
  expect(prCommand(repo, deps, "pr", "reply", "x", "--comment", "thread:PRRT_x", "--body-file", "reply.md")).toEqual({
    code: 1,
    out: ["error: not-on-pr: PRRT_x is not a review thread or review comment on PR #7"],
    err: [],
  });
  expect(calls).toHaveLength(1);
});

test.each(["5", "comment:5", "thread:", "thread:0", "issue:IC_abc", "review:PRR_abc", "thread:PRRT x"])("pr reply with the malformed key %p names the expected forms", (key) => {
  const { deps, calls } = prDeps({});
  const r = prCommand(prRepo(), deps, "pr", "reply", "x", "--comment", key, "--body-file", "f");
  expect(r.code).toBe(2);
  expect(r.err).toEqual([`pr reply: --comment takes thread:<id>, thread:<node id> (PRRT_… or PRRC_…), issue:<id> or review:<id>, not ${key}`]);
  expect(calls).toEqual([]);
});

test.each(["123", "a b"])("pr resolve with the thread %p says it takes a node id", (thread) => {
  const { deps, calls } = prDeps({});
  const r = prCommand(prRepo(), deps, "pr", "resolve", "x", "--thread", thread);
  expect(r).toEqual({ code: 2, out: [], err: [`pr resolve: --thread takes a review thread's node id (PRRT_…), not ${thread}`] });
  expect(calls).toEqual([]);
});

test.each([
  [["pr"]],
  [["pr", "reply", "x", "--comment", "thread:5"]],
  [["pr", "resolve", "x"]],
  [["pr", "resolve", "x", "--thread", "T", "--comment", "thread:5"]],
])("pr usage error %p", (args) => {
  const { deps, calls } = prDeps({});
  const r = prCommand(prRepo(), deps, ...args);
  expect(r.code).toBe(2);
  expect(r.err[0]).toStartWith("unknown command: pr");
  expect(calls).toEqual([]);
});

test("bin/fbs passes the gh, git and claude it resolves as leading flags", () => {
  const dir = tempDir();
  copyFileSync(join(import.meta.dir, "..", "bin", "fbs"), join(dir, "fbs"));
  writeFileSync(join(dir, "fbs-bin"), '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  const tools = tempDir();
  for (const tool of ["gh", "git", "claude"]) writeFileSync(join(tools, tool), "#!/bin/sh\n");
  for (const file of [join(dir, "fbs"), join(dir, "fbs-bin"), join(tools, "gh"), join(tools, "git"), join(tools, "claude")]) chmodSync(file, 0o755);
  const result = Bun.spawnSync([join(dir, "fbs"), "watch-pr", "x"], { env: { PATH: `${tools}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString().trimEnd().split("\n")).toEqual([`--fbs-git=${join(tools, "git")}`, `--fbs-gh=${join(tools, "gh")}`, `--fbs-claude=${join(tools, "claude")}`, "watch-pr", "x"]);
});

test("--fbs-claude=<path> is the claude polish check runs", () => {
  const dir = tempDir();
  const claude = join(dir, "claude");
  writeFileSync(claude, '#!/bin/sh\n[ "$*" = "plugin list --json" ] && echo "[]"\n');
  chmodSync(claude, 0o755);
  const r = cli([`--fbs-claude=${claude}`, "polish", "check"], dir, {});
  expect(r.code).toBe(1);
  expect(r.stdout.split("\n").filter((line) => line.startsWith("error: missing plugin:"))).toHaveLength(2);
});

describe("takeToolFlags", () => {
  test("splits off a leading --fbs-git=<path>", () => {
    expect(takeToolFlags(["--fbs-git=/x/git", "context", "check"])).toEqual({ git: "/x/git", gh: null, claude: null, argv: ["context", "check"] });
  });
  test("splits off leading --fbs-git and --fbs-gh in either order", () => {
    expect(takeToolFlags(["--fbs-git=/x/git", "--fbs-gh=/x/gh", "watch-pr", "x"])).toEqual({ git: "/x/git", gh: "/x/gh", claude: null, argv: ["watch-pr", "x"] });
    expect(takeToolFlags(["--fbs-gh=/x/gh", "--fbs-git=/x/git", "help"])).toEqual({ git: "/x/git", gh: "/x/gh", claude: null, argv: ["help"] });
    expect(takeToolFlags(["--fbs-gh=/x/gh", "help"])).toEqual({ git: null, gh: "/x/gh", claude: null, argv: ["help"] });
  });
  test("splits off a leading --fbs-claude=<path> with the others", () => {
    expect(takeToolFlags(["--fbs-git=/x/git", "--fbs-gh=/x/gh", "--fbs-claude=/x/claude", "polish", "check"])).toEqual({ git: "/x/git", gh: "/x/gh", claude: "/x/claude", argv: ["polish", "check"] });
  });
  test("leaves argv alone without the flags, or when they aren't first, are empty or repeat", () => {
    expect(takeToolFlags(["context", "check"])).toEqual({ git: null, gh: null, claude: null, argv: ["context", "check"] });
    expect(takeToolFlags(["context", "--fbs-git=/x/git"])).toEqual({ git: null, gh: null, claude: null, argv: ["context", "--fbs-git=/x/git"] });
    expect(takeToolFlags(["--fbs-git="])).toEqual({ git: null, gh: null, claude: null, argv: ["--fbs-git="] });
    expect(takeToolFlags(["--fbs-gh=/a", "--fbs-gh=/b"])).toEqual({ git: null, gh: "/a", claude: null, argv: ["--fbs-gh=/b"] });
  });
});

describe("work units", () => {
  const SPEC = `${PASSING_SPEC}## Acceptance criteria\n- [ ] One\n- [ ] Two\n`;
  const DESIGN = `${PASSING_SPEC}## Work units\n### U1: Api\n- Covers: AC1\n- Depends on: none\n### U2: Ui\n- Covers: AC2\n- Depends on: U1\n### U3: Db\n- Covers: none\n- Depends on: U2\n`;
  const DIR = "docs/features/2026-10-21-f";

  /** Big feature f with its spec and two-unit design approved and committed. */
  function unitRepo(): string {
    const repo = gitRepo();
    expect(status(repo, "init", "f", "--size", "big").code).toBe(0);
    writeFileSync(join(repo, DIR, "spec.md"), SPEC);
    writeFileSync(join(repo, DIR, "design.md"), DESIGN);
    expect(status(repo, "approve", "f", "spec", "--quote", "s").code).toBe(0);
    expect(status(repo, "approve", "f", "design", "--quote", "d").code).toBe(0);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "docs");
    return repo;
  }

  test("status init --unit-of prints the unit record, numbered next or as --unit says", () => {
    const repo = unitRepo();
    const r = status(repo, "init", "f-api", "--unit-of", "f");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.join("\n"))).toEqual({ slug: "f-api", dir: `${DIR}/units/f-api`, size: "big", approvals: {}, pr: null, unitOf: "f", unit: 1 });
    expect(JSON.parse(status(repo, "init", "f-ui", "--unit-of", "f", "--unit", "2").out.join("\n")).unit).toBe(2);
    expect(status(repo, "init", "f-x", "--unit-of", "f", "--unit", "2")).toEqual({ code: 1, out: ["error: unit-taken: unit 2 of f is f-ui"], err: [] });
    expect(status(repo, "init", "f-y", "--unit-of", "f-api")).toEqual({ code: 1, out: [expect.stringMatching(/^error: is-unit: /)], err: [] });
  });

  test.each([
    [["init", "u", "--unit-of", "f", "--size", "big"]],
    [["init", "u", "--unit", "1"]],
    [["init", "u", "--unit-of", "f", "--unit", "0"]],
    [["init", "u", "--unit-of", "f", "--unit", "x"]],
    [["init", "u"]],
  ])("status %p is a usage error", (args) => {
    expect(status(unitRepo(), ...args).code).toBe(2);
  });

  test("status show on a unit prints the feature's approvals, its place in the stack and its plan", () => {
    const repo = unitRepo();
    status(repo, "init", "f-api", "--unit-of", "f");
    const record = JSON.parse(readFileSync(join(repo, RECORDS, "f-api.json"), "utf8"));
    writeRecordFile(repo, "f-extra.json", JSON.stringify({ ...record, slug: "f-extra", dir: `${DIR}/units/f-extra`, unit: 4 }));
    expect(status(repo, "init", "f-four", "--unit-of", "f", "--unit", "4")).toEqual({ code: 1, out: [`error: bad-unit: ${DIR}/design.md lists no U4 under Work units; amend the design to add it first`], err: [] });
    const shown = JSON.parse(status(repo, "show", "f-api").out.join("\n"));
    expect(shown).toMatchObject({ slug: "f-api", unitOf: "f", unit: 1, covers: [1], dependsOn: [] });
    expect(shown.approvals.spec).toMatchObject({ quote: "s", current: true });
    expect(shown.approvals.design).toMatchObject({ quote: "d", current: true });
    expect(JSON.parse(status(repo, "show", "f-extra").out.join("\n"))).toMatchObject({ unit: 4, covers: null, dependsOn: null });
    writeFileSync(join(repo, DIR, "design.md"), `${DESIGN}edited\n`);
    expect(JSON.parse(status(repo, "show", "f-api").out.join("\n")).approvals.design.current).toBe(false);
  });

  test("status show on a feature lists its units in order with branch, PR, stamp and landed", () => {
    const repo = unitRepo();
    expect(JSON.parse(status(repo, "show", "f").out.join("\n")).units).toBeUndefined();
    status(repo, "init", "f-ui", "--unit-of", "f", "--unit", "2");
    status(repo, "init", "f-api", "--unit-of", "f", "--unit", "1");
    const verdict = `${DIR}/units/f-api/verdict.md`;
    writeFileSync(join(repo, verdict), "## Criteria\n- [x] A\nVerdict: pass\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "unit work");
    expect(stamp(repo, "set", "f-api", "--verdict", verdict).code).toBe(0);
    const record = JSON.parse(readFileSync(join(repo, RECORDS, "f-ui.json"), "utf8"));
    const landed = { pr: 8, repo: "acme/app", commit: "c".repeat(40), at: "2026-10-25" };
    writeRecordFile(repo, "f-ui.json", JSON.stringify({ ...record, branch: { name: "feature/f-ui", parent: "feature/f-api", base: "d".repeat(40) }, landed }));
    expect(JSON.parse(status(repo, "show", "f").out.join("\n")).units).toEqual([
      { slug: "f-api", unit: 1, branch: null, pr: null, stamp: { current: true }, landed: false },
      { slug: "f-ui", unit: 2, branch: "feature/f-ui", pr: null, stamp: null, landed: true },
    ]);
    writeFileSync(join(repo, DIR, "design.md"), `${DESIGN}edited\n`);
    git(repo, "commit", "-q", "-am", "edit design");
    expect(JSON.parse(status(repo, "show", "f").out.join("\n")).units[0].stamp).toEqual({ current: false });
    expect(stamp(repo, "check", "f-api")).toEqual({ code: 1, out: ["stale: tree changed", "stale: design changed since its approval"], err: [] });
  });

  test("status show on a feature judges each unit's stamp on its own branch, not the checked-out one", () => {
    const repo = unitRepo();
    status(repo, "init", "f-api", "--unit-of", "f");
    status(repo, "init", "f-ui", "--unit-of", "f");
    for (const [slug, parent] of [["f-api", "main"], ["f-ui", "feature/f-api"]]) {
      git(repo, "switch", "-q", "-c", `feature/${slug}`);
      const verdict = `${DIR}/units/${slug}/verdict.md`;
      writeFileSync(join(repo, verdict), "## Criteria\n- [x] A\nVerdict: pass\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", `${slug} work`);
      expect(stamp(repo, "set", slug, "--verdict", verdict).code).toBe(0);
      const record = JSON.parse(readFileSync(join(repo, RECORDS, `${slug}.json`), "utf8"));
      writeRecordFile(repo, `${slug}.json`, JSON.stringify({ ...record, branch: { name: `feature/${slug}`, parent, base: "d".repeat(40) } }));
    }
    const stamps = () => JSON.parse(status(repo, "show", "f").out.join("\n")).units.map((unit: { stamp: unknown }) => unit.stamp);
    expect(stamps()).toEqual([{ current: true }, { current: true }]);
    writeFileSync(join(repo, "more.txt"), "more\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "more ui work");
    expect(stamps()).toEqual([{ current: true }, { current: false }]);
  });

  const PENDING = { commits: { nodes: [{ commit: { oid: PR_HEAD, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", databaseId: 2, name: "ci", status: "IN_PROGRESS", conclusion: null }] } } } }] } };

  /** Units f-api (landed, PR 21), f-ui (PR 22) and f-db (PR 23) of feature f. */
  function stackRepo(): string {
    const repo = unitRepo();
    for (const [slug, pr] of [["f-api", 21], ["f-ui", 22], ["f-db", 23]] as const) {
      status(repo, "init", slug, "--unit-of", "f");
      expect(prStatus(repo, prDeps({}).deps, slug, `https://github.com/acme/app/pull/${pr}`).code).toBe(0);
    }
    const record = JSON.parse(readFileSync(join(repo, RECORDS, "f-api.json"), "utf8"));
    writeRecordFile(repo, "f-api.json", JSON.stringify({ ...record, landed: { pr: 21, repo: "acme/app", commit: "c".repeat(40), at: "2026-10-25" } }));
    return repo;
  }

  const prOf = (args: string[]) => args.find((arg) => arg.startsWith("pr="));

  test("watch-pr on a feature watches each unit's open PR in order and reports the first with a verdict, naming the unit", () => {
    const repo = stackRepo();
    const comment = { databaseId: 9, author: { login: "ana", __typename: "User" }, body: "Why?", createdAt: "2026-10-25T10:00:00Z", updatedAt: "2026-10-25T10:00:00Z" };
    const { deps, calls } = prDeps({ "pr=22": { stdout: graphqlAnswer(PENDING) }, "pr=23": { stdout: graphqlAnswer({ comments: { pageInfo: page, nodes: [comment] } }) } });
    const first = prCommand(repo, deps, "watch-pr", "f", "--once");
    expect(first.code).toBe(3);
    expect(JSON.parse(first.out[0])).toMatchObject({ verdict: "activity", pr: 23, slug: "f-db", unit: 3, newComments: [{ key: "issue:9" }] });
    expect(calls.map((c) => prOf(c.args))).toEqual(["pr=22", "pr=23"]);
    expect(first.err.map((line) => JSON.parse(line))).toEqual([
      { poll: 1, unit: 2, head: "eeeeeee", pending: 1, failing: 0, unseen: 0 },
      { poll: 1, unit: 3, head: "eeeeeee", pending: 0, failing: 0, unseen: 1, verdict: "activity" },
    ]);
    expect(existsSync(join(repo, ".git", "fbs", "pr", "f-db.json"))).toBe(true);
    expect(existsSync(join(repo, ".git", "fbs", "pr", "f-ui.json"))).toBe(false);

    const second = prCommand(repo, deps, "watch-pr", "f", "--once");
    expect(second.code).toBe(0);
    expect(JSON.parse(second.out[0])).toMatchObject({ verdict: "approved-green", pr: 23, slug: "f-db", unit: 3 });
    const quiet = prCommand(repo, deps, "watch-pr", "f", "--once");
    expect(quiet.code).toBe(5);
    expect(JSON.parse(quiet.out[0])).toMatchObject({ verdict: "timeout", pr: 22, slug: "f-ui", unit: 2, newComments: [] });
  });

  test("watch-pr on a feature polls every open unit each interval until one has a verdict", () => {
    const repo = stackRepo();
    let uiCalls = 0;
    const sleeps: number[] = [];
    const { deps, calls } = prDeps({});
    deps.gh = (args) => {
      calls.push({ args, input: null });
      const draft = prOf(args) === "pr=22" && ++uiCalls > 1;
      return { code: 0, stderr: "", stdout: graphqlAnswer(draft ? { isDraft: true, mergeStateStatus: "DRAFT", reviewDecision: null } : PENDING) };
    };
    deps.sleep = (ms) => sleeps.push(ms / 1000);
    const r = prCommand(repo, deps, "watch-pr", "f", "--interval", "30");
    expect(r.code).toBe(8);
    expect(JSON.parse(r.out[0])).toMatchObject({ verdict: "ready", pr: 22, slug: "f-ui", unit: 2 });
    expect(calls.map((c) => prOf(c.args))).toEqual(["pr=22", "pr=23", "pr=22"]);
    expect(sleeps).toEqual([30]);
  });

  test("watch-pr on a feature whose units have no open PR exits 2, and on a unit watches that unit alone", () => {
    const repo = unitRepo();
    status(repo, "init", "f-api", "--unit-of", "f");
    const { deps, calls } = prDeps({ graphql: { stdout: graphqlAnswer({}) } });
    expect(prCommand(repo, deps, "watch-pr", "f", "--once")).toEqual({ code: 2, out: [], err: ["f has no unit with an open PR; record one with fbs status pr <unit> <number|url>"] });
    expect(calls).toHaveLength(0);
    expect(prStatus(repo, deps, "f-api", "https://github.com/acme/app/pull/21").code).toBe(0);
    const alone = prCommand(repo, deps, "watch-pr", "f-api", "--once");
    expect(alone.code).toBe(0);
    expect(JSON.parse(alone.out[0])).toEqual(expect.not.objectContaining({ slug: expect.anything() }));
    expect(JSON.parse(alone.out[0])).toMatchObject({ verdict: "approved-green", pr: 21 });
  });

  test("status approve and gate on a unit point at the feature, and list shows each unit's place", () => {
    const repo = unitRepo();
    status(repo, "init", "f-api", "--unit-of", "f");
    const refused = { code: 1, out: ["error: is-unit: f-api is unit 1 of f and goes by its documents and approvals; run this on f"], err: [] };
    expect(status(repo, "approve", "f-api", "design", "--quote", "ok")).toEqual(refused);
    expect(status(repo, "gate", "f-api", "spec")).toEqual(refused);
    expect(status(repo, "list")).toEqual({ code: 0, out: ["f-api\tbig\tunit 1 of f", "f\tbig\tdesign approved"], err: [] });
  });
});
