import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type AfkDeps, type CheckResult, checkScripts, checkStep, markLanded, parseSpec, type Run, sealState } from "./afk";
import type { JudgeInput, JudgeRunner } from "./afk-judge";
import { GitError } from "./git";
import { type PrDeps, run } from "./main";
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fbs-afk-")));
  dirs.push(dir);
  return dir;
}

/** Write (or, for null, delete) `files` and commit them; returns the new HEAD. */
function commit(cwd: string, files: Record<string, string | null>, message = "step"): string {
  for (const [path, content] of Object.entries(files)) {
    const full = join(cwd, path);
    if (content === null) rmSync(full, { force: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function repo(files: Record<string, string>): string {
  const cwd = tempDir();
  git(cwd, "init", "-q", "-b", "fbs/x");
  commit(cwd, { "README.md": "x\n", ...files }, "init");
  return cwd;
}

const head = (cwd: string) => git(cwd, "rev-parse", "HEAD");
const afkRoot = (cwd: string) => join(cwd, ".git", "fbs", "afk");
const runDir = (cwd: string) => join(afkRoot(cwd), "x");

const PASS_FILE = { id: "tests", kind: "command", run: "test -f pass.txt" };
const SCORE_MIN = { id: "seo", kind: "command", run: "cat score.txt", metric: "score: (\\d+)", target: 90, direction: "min" };
const JUDGED = { id: "meta", kind: "judged", rubric: ["c1 holds", "c2 holds"] };

function spec(checks: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { goal: "make it good", checks, scope: ["**"], protect: ["e2e/**", "**/*.test.ts"], ...extra };
}

/** A judge that passes criterion i when judge.txt holds `c<i>`; `override` decides instead when given. */
function fakeJudge(override?: (input: JudgeInput, call: number) => boolean[]) {
  const calls: JudgeInput[] = [];
  const judge: JudgeRunner = (input) => {
    calls.push(input);
    const file = join(input.cwd, "judge.txt");
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const passes = override?.(input, calls.length) ?? input.rubric.map((_, i) => text.includes(`c${i + 1}`));
    const criteria = input.rubric.map((criterion, i) => ({ criterion, pass: passes[i], evidence: passes[i] ? "judge.txt:1" : "" }));
    return { pass: passes.every(Boolean), criteria, costUsd: 0.1, error: null };
  };
  return { judge, calls };
}

interface Cli {
  code: number;
  out: string[];
  err: string[];
  json: () => Record<string, unknown>;
}

function afk(cwd: string, judge: JudgeRunner, args: string[], now = NOW, env: { session?: string; stdin?: string } = {}): Cli {
  const out: string[] = [];
  const err: string[] = [];
  const deps: PrDeps = { gh: () => ({ code: 1, stdout: "", stderr: "no gh" }), now: () => now, sleep: () => {}, stdin: () => env.stdin ?? "" };
  const afkDeps: AfkDeps = { judge, userSettings: join(cwd, "no-settings.json"), sessionId: () => env.session ?? null };
  const code = run(["afk", ...args], { cwd, today: "2026-10-28", out: (l) => out.push(l), err: (l) => err.push(l) }, deps, afkDeps);
  return { code, out, err, json: () => JSON.parse(out[0]) };
}

function start(cwd: string, judge: JudgeRunner, s: Record<string, unknown>, ...extra: string[]): Cli {
  const path = join(tempDir(), "spec.json");
  writeFileSync(path, JSON.stringify(s));
  return afk(cwd, judge, ["start", "x", "--spec", path, ...extra]);
}

const check = (cwd: string, judge: JudgeRunner, now = NOW) => afk(cwd, judge, ["check", "x"], now);
const runJson = (cwd: string): Run => JSON.parse(readFileSync(join(runDir(cwd), "run.json"), "utf8"));
const logRows = (cwd: string) =>
  readFileSync(join(runDir(cwd), "log.tsv"), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
const result = (results: unknown, id: string) => (results as CheckResult[]).find((r) => r.id === id) as CheckResult;
/** The pids still matching `marker` once a killed group has had a moment to go. */
function sleeping(marker: string): string {
  const find = () => Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim();
  for (let i = 0; i < 20 && find() !== ""; i++) Bun.sleepSync(50);
  return find();
}

describe("fbs afk start", () => {
  test("records the run, the baseline and the protected hashes, writes the log and prints one JSON line", () => {
    const cwd = repo({ "score.txt": "score: 80\n", "e2e/a.spec.ts": "e2e\n", "x.test.ts": "t\n", "src/y.test.ts": "y\n", "src/app.ts": "app\n" });
    const { judge, calls } = fakeJudge();
    const r = start(cwd, judge, spec([PASS_FILE, SCORE_MIN, JUDGED], { budgets: { maxIterations: 9 } }), "--session", "abc");
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    const rec = r.json() as unknown as Run;
    expect(rec).toEqual(runJson(cwd));
    expect(rec).toMatchObject({ slug: "x", status: "running", sessionId: "abc", goal: "make it good", worktree: cwd, branch: "fbs/x", iteration: 0, discardsInRow: 0, lastChecked: null, stop: null });
    expect(rec.budgets).toEqual({ maxIterations: 9, maxDiscardsInRow: 5, checkTimeoutSec: 600, judgeUsdPerCall: 0.5 });
    expect(rec.start.sha).toBe(head(cwd));
    expect(rec.kept).toEqual({ sha: head(cwd), results: rec.start.results, met: false });
    expect(Object.keys(rec.protected)).toEqual(["e2e/a.spec.ts", "src/y.test.ts", "x.test.ts"]);
    expect(rec.protected["x.test.ts"]).toMatch(/^[0-9a-f]{64}$/);
    expect(result(rec.start.results, "tests")).toMatchObject({ pass: false, exit: 1 });
    expect(result(rec.start.results, "seo")).toMatchObject({ pass: false, value: 80, error: null });
    // The baseline judges even with failing commands, once.
    expect(result(rec.start.results, "meta")).toMatchObject({ pass: false, skipped: false, second: null });
    expect(calls).toHaveLength(1);
    expect(rec.judgeCostUsd).toBeCloseTo(0.1);
    const rows = logRows(cwd);
    expect(rows[0]).toEqual(["ts", "kind", "iteration", "sha", "results", "decision", "cost", "note"]);
    expect(rows[1].slice(0, 4)).toEqual([new Date(NOW).toISOString(), "start", "0", head(cwd)]);
    expect(rows[1][5]).toBe("baseline");
    expect(readdirSync(afkRoot(cwd)).sort()).toEqual(["x", "x.seal"]);
  });

  test("no --session records a null session", () => {
    const cwd = repo({});
    expect(start(cwd, fakeJudge().judge, spec([PASS_FILE])).json().sessionId).toBeNull();
  });

  test("refuses a dirty tree, an untracked file hidden by info/exclude, and a detached HEAD", () => {
    const cwd = repo({});
    writeFileSync(join(cwd, "stray.txt"), "x");
    expect(start(cwd, fakeJudge().judge, spec([PASS_FILE])).out[0]).toStartWith("error: dirty:");
    rmSync(join(cwd, "stray.txt"));
    writeFileSync(join(cwd, ".git", "info", "exclude"), "pass.txt\n");
    writeFileSync(join(cwd, "pass.txt"), "x");
    expect(start(cwd, fakeJudge().judge, spec([PASS_FILE])).out[0]).toBe(`error: dirty: ${cwd} has uncommitted or untracked files (pass.txt); commit, remove or .gitignore them first`);
    rmSync(join(cwd, "pass.txt"));
    git(cwd, "checkout", "-q", "--detach");
    expect(start(cwd, fakeJudge().judge, spec([PASS_FILE])).out[0]).toStartWith("error: bad-branch:");
  });

  test("refuses a second start while running; a finished run restarts only with --restart and is archived", () => {
    const cwd = repo({});
    expect(start(cwd, fakeJudge().judge, spec([PASS_FILE])).code).toBe(0);
    expect(start(cwd, fakeJudge().judge, spec([PASS_FILE]))).toMatchObject({ code: 1, out: ["error: running: afk run x is already running"] });
    expect(afk(cwd, fakeJudge().judge, ["stop", "x", "--reason", "done"]).code).toBe(0);
    expect(start(cwd, fakeJudge().judge, spec([PASS_FILE])).out).toEqual(["error: exists: afk run x finished (stopped); pass --restart to archive it and start over"]);
    expect(start(cwd, fakeJudge().judge, spec([PASS_FILE]), "--restart").code).toBe(0);
    expect(readdirSync(afkRoot(cwd)).sort()).toEqual(["x", "x.2027-01-15T08-00-00-000Z", "x.seal"]);
    expect(readFileSync(join(afkRoot(cwd), "x.2027-01-15T08-00-00-000Z", "log.tsv"), "utf8")).toContain("\tstop\t");
    expect(logRows(cwd)).toHaveLength(2);
  });

  test("refuses checks that leave the tree dirty, naming what they wrote", () => {
    const cwd = repo({});
    const r = start(cwd, fakeJudge().judge, spec([{ id: "build", kind: "command", run: "echo out > built.txt" }]));
    expect(r.out[0]).toBe("error: dirty: the check commands wrote built.txt; ignore them in .gitignore or write outside the repo, then start again");
    expect(existsSync(runDir(cwd))).toBe(false);
  });

  test.each([
    ["not an object", [], "the spec must be a JSON object"],
    ["no goal", { ...spec([PASS_FILE]), goal: "" }, "goal must be a non-empty string"],
    ["no checks", spec([]), "checks must be a non-empty list"],
    ["an unknown key", { ...spec([PASS_FILE]), extra: 1 }, "the spec has unknown keys: extra"],
    ["a bad id", spec([{ ...PASS_FILE, id: "Bad Id" }]), "checks[0].id must be"],
    ["a duplicate id", spec([PASS_FILE, PASS_FILE]), "check id tests is used twice"],
    ["a bad kind", spec([{ id: "a", kind: "vibes" }]), 'checks[0].kind must be "command" or "judged"'],
    ["an empty command", spec([{ id: "a", kind: "command", run: " " }]), "checks[0].run must be a non-empty command"],
    ["a metric without a group", spec([{ ...SCORE_MIN, metric: "score: \\d+" }]), "checks[0].metric must be a regex with a capture group"],
    ["a broken regex", spec([{ ...SCORE_MIN, metric: "(" }]), "checks[0].metric must be a regex"],
    ["a metric without a target", spec([{ ...SCORE_MIN, target: "90" }]), "checks[0].target must be a number"],
    ["a bad direction", spec([{ ...SCORE_MIN, direction: "up" }]), 'checks[0].direction must be "min" or "max"'],
    ["a target without a metric", spec([{ ...PASS_FILE, target: 3 }]), "checks[0] has a target or direction without a metric"],
    ["an empty rubric", spec([{ ...JUDGED, rubric: [] }]), "checks[0].rubric must be a non-empty list of criteria"],
    ["no scope", { ...spec([PASS_FILE]), scope: [] }, "scope must name at least one glob"],
    ["a bad protect", { ...spec([PASS_FILE]), protect: "e2e/**" }, "protect must be a list of globs"],
    ["a bad budget", spec([PASS_FILE], { budgets: { maxIterations: 0 } }), "budgets.maxIterations must be a positive whole number"],
    ["minAttempts, which is gone", spec([PASS_FILE], { budgets: { minAttempts: 2 } }), "budgets has unknown keys: minAttempts"],
  ])("rejects a spec with %s", (_, raw, message) => {
    expect(() => parseSpec(raw)).toThrow(message);
    const cwd = repo({});
    const r = start(cwd, fakeJudge().judge, raw as Record<string, unknown>);
    expect(r.code).toBe(1);
    expect(r.out[0]).toStartWith("error: bad-spec:");
  });

  test("an unreadable spec is an error; a missing --spec or --reason says which flag", () => {
    const cwd = repo({});
    const r = afk(cwd, fakeJudge().judge, ["start", "x", "--spec", join(cwd, "nope.json")]);
    expect(r.code).toBe(1);
    expect(r.out[0]).toStartWith("error: bad-spec: cannot read");
    expect(afk(cwd, fakeJudge().judge, ["start", "x"])).toMatchObject({ code: 2, err: ["afk start needs --spec <file>"] });
    expect(afk(cwd, fakeJudge().judge, ["stop", "x"])).toMatchObject({ code: 2, err: ["afk stop needs --reason <text>"] });
  });

  test("a repo without a commit has no-step", () => {
    const cwd = tempDir();
    git(cwd, "init", "-q", "-b", "fbs/x");
    expect(start(cwd, fakeJudge().judge, spec([PASS_FILE])).out[0]).toStartWith("error: no-step:");
  });
});

describe("fbs afk check", () => {
  test("a step that makes a failing check pass is kept and, with every check passing, met", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE]));
    const sha = commit(cwd, { "pass.txt": "ok" });
    const r = check(cwd, judge);
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    expect(r.json()).toMatchObject({ iteration: 1, sha, decision: "kept", met: true, stop: { rule: "met" }, warning: null });
    expect(runJson(cwd)).toMatchObject({ status: "met", kept: { sha, met: true }, lastChecked: sha });
    const row = logRows(cwd)[2];
    expect(row.slice(1, 4)).toEqual(["check", "1", sha]);
    expect(row[5]).toBe("kept");
    expect(JSON.parse(row[4])[0]).toMatchObject({ id: "tests", pass: true });
    expect(JSON.parse(row[4])[0].tail).toBeUndefined();
  });

  test("a step that breaks a passing check is discarded and the CLI resets to the last kept commit", () => {
    const cwd = repo({ "pass.txt": "ok", "score.txt": "score: 80\n" });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE, SCORE_MIN]));
    const kept = commit(cwd, { "score.txt": "score: 85\n" });
    expect(check(cwd, judge).json()).toMatchObject({ decision: "kept", met: false, stop: null });
    const bad = commit(cwd, { "score.txt": "score: 88\n", "pass.txt": null });
    expect(check(cwd, judge).json()).toMatchObject({ iteration: 2, sha: bad, decision: "discarded", met: false });
    expect(head(cwd)).toBe(kept);
    expect(readFileSync(join(cwd, "score.txt"), "utf8")).toBe("score: 85\n");
    expect(runJson(cwd)).toMatchObject({ kept: { sha: kept }, discardsInRow: 1, lastChecked: bad, status: "running" });
    expect(logRows(cwd)[3][7]).toBe("improved: seo; regressed: tests");
  });

  test("a step that moves nothing is discarded, back to the start commit", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    const startSha = head(cwd);
    start(cwd, judge, spec([PASS_FILE]));
    commit(cwd, { "src/a.ts": "noise" });
    expect(check(cwd, judge).json()).toMatchObject({ decision: "discarded" });
    expect(head(cwd)).toBe(startSha);
    expect(existsSync(join(cwd, "src/a.ts"))).toBe(false);
    expect(logRows(cwd)[2][7]).toBe("no check moved");
  });

  test("a min metric counts moves toward the target and is met when it reaches it", () => {
    const cwd = repo({ "score.txt": "score: 80\n" });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([SCORE_MIN]));
    commit(cwd, { "score.txt": "score: 85\n" });
    expect(check(cwd, judge).json()).toMatchObject({ decision: "kept", met: false, results: [{ value: 85, pass: false }] });
    commit(cwd, { "score.txt": "score: 95\n" });
    expect(check(cwd, judge).json()).toMatchObject({ decision: "kept", met: true, stop: { rule: "met" }, results: [{ value: 95, pass: true }] });
  });

  test("a max metric keeps a lower count and discards a higher one", () => {
    const cwd = repo({ "lint.txt": "errors: 5\n" });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([{ id: "lint", kind: "command", run: "cat lint.txt", metric: "errors: (\\d+)", target: 0, direction: "max" }]));
    commit(cwd, { "lint.txt": "errors: 2\n" });
    expect(check(cwd, judge).json()).toMatchObject({ decision: "kept", results: [{ value: 2, pass: false }] });
    commit(cwd, { "lint.txt": "errors: 3\n" });
    expect(check(cwd, judge).json()).toMatchObject({ decision: "discarded" });
    commit(cwd, { "lint.txt": "errors: 0\n" });
    expect(check(cwd, judge).json()).toMatchObject({ decision: "kept", met: true, results: [{ value: 0, pass: true }] });
  });

  test("a metric takes the last match on stdout, ignores the exit code when it matches, and is an error without a match", () => {
    const cwd = repo({});
    start(
      cwd,
      fakeJudge().judge,
      spec([
        { ...SCORE_MIN, run: "echo 'score: 70'; echo 'score: 92'; echo 'score: 99' >&2; exit 3" },
        { ...SCORE_MIN, id: "stderr-only", run: "echo 'score: 95' >&2" },
        { ...SCORE_MIN, id: "failing", run: "echo nothing; exit 4" },
      ]),
    );
    const results = runJson(cwd).start.results;
    expect(result(results, "seo")).toMatchObject({ pass: true, value: 92, exit: 3, error: null });
    expect(result(results, "stderr-only")).toMatchObject({ pass: false, value: null, error: "no number matched score: (\\d+) on stdout" });
    expect(result(results, "failing")).toMatchObject({ pass: false, value: null, error: "no number matched score: (\\d+) on stdout (exit 4)" });
  });

  test("a command over the timeout is an error result, and its whole process group is killed", () => {
    const cwd = repo({});
    const t = Date.now();
    start(cwd, fakeJudge().judge, spec([{ id: "slow", kind: "command", run: "sleep 37771 & sleep 37772" }], { budgets: { checkTimeoutSec: 1 } }));
    expect(Date.now() - t).toBeLessThan(5000);
    expect(result(runJson(cwd).start.results, "slow")).toMatchObject({ pass: false, exit: null, error: "timed out after 1s" });
    expect(sleeping("^sleep 3777")).toBe("");
  });

  test("a server a passing command leaves behind is killed after the check", () => {
    const cwd = repo({});
    start(cwd, fakeJudge().judge, spec([{ id: "serve", kind: "command", run: "(sleep 37781 &); echo started" }]));
    expect(result(runJson(cwd).start.results, "serve")).toMatchObject({ pass: true, tail: "started\n" });
    expect(sleeping("^sleep 37781")).toBe("");
  });

  test("judged checks run only when every command check passes, and pass on two votes", () => {
    const cwd = repo({});
    const { judge, calls } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE, JUDGED]));
    expect(calls).toHaveLength(1);
    commit(cwd, { "judge.txt": "c1 c2" });
    const skipped = check(cwd, judge).json();
    expect(result(skipped.results, "meta")).toMatchObject({ skipped: true, pass: false });
    expect(calls).toHaveLength(1);
    expect(skipped.decision).toBe("discarded");
    commit(cwd, { "judge.txt": "c1 c2", "pass.txt": "ok" });
    const r = check(cwd, judge).json();
    expect(r).toMatchObject({ decision: "kept", met: true, stop: { rule: "met" } });
    expect(result(r.results, "meta")).toMatchObject({ pass: true, second: true, costUsd: 0.2 });
    expect(calls).toHaveLength(3);
    expect(calls[1].commandOutputs).toEqual([{ id: "tests", run: "test -f pass.txt", exit: 0, output: "" }]);
    expect(calls[1]).toMatchObject({ cwd, goal: "make it good", rubric: ["c1 holds", "c2 holds"], budgetUsd: 0.5, timeoutSec: 600 });
    expect(runJson(cwd).judgeCostUsd).toBeCloseTo(0.3);
    expect(logRows(cwd)[3][6]).toBe("0.2000");
  });

  test("a judged check that passes more criteria is kept; one that doesn't is discarded", () => {
    const cwd = repo({ "pass.txt": "ok" });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE, JUDGED]));
    commit(cwd, { "judge.txt": "c1" });
    const better = check(cwd, judge).json();
    expect(better).toMatchObject({ decision: "kept", met: false });
    expect(result(better.results, "meta")).toMatchObject({ pass: false, second: null, criteria: [{ pass: true }, { pass: false }] });
    commit(cwd, { "judge.txt": "c2" });
    expect(check(cwd, judge).json()).toMatchObject({ decision: "discarded" });
  });

  test("the same tree gets the recorded verdict, never a new roll", () => {
    const cwd = repo({ "pass.txt": "ok", "judge.txt": "c1" });
    let rolls = 0;
    const { judge, calls } = fakeJudge(() => (++rolls <= 2 ? [true, false] : [true, true]));
    start(cwd, judge, spec([PASS_FILE, JUDGED]));
    commit(cwd, { "src/a.ts": "1" });
    expect(check(cwd, judge).json().decision).toBe("discarded");
    expect(calls).toHaveLength(2);
    commit(cwd, { "src/a.ts": "1" }, "the discarded step again");
    const r = check(cwd, judge).json();
    expect(calls).toHaveLength(2);
    expect(result(r.results, "meta")).toMatchObject({ pass: false, costUsd: 0 });
    expect(r.decision).toBe("discarded");
  });

  test("an empty commit is not a step, unless the kept state's judge call failed", () => {
    const cwd = repo({ "pass.txt": "ok" });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE, JUDGED]));
    commit(cwd, {}, "nothing");
    expect(check(cwd, judge).out[0]).toMatch(/^error: no-step: HEAD [0-9a-f]{12} changes nothing since the last kept commit; an empty commit is not a step$/);

    const retry = repo({ "pass.txt": "ok", "judge.txt": "c1 c2" });
    let calls = 0;
    const flaky: JudgeRunner = (input) => (++calls === 1 ? { pass: false, criteria: [], costUsd: 0, error: "the judge timed out" } : fakeJudge().judge(input));
    start(retry, flaky, spec([PASS_FILE, JUDGED]));
    commit(retry, {}, "retry the judge");
    expect(check(retry, flaky).json()).toMatchObject({ decision: "kept", met: true });
    expect(calls).toBe(3);
  });

  test("a write to the run's files between afk commands stops the run at the next check or resume", () => {
    const cwd = repo({ "pass.txt": "ok" });
    const { judge, calls } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE, JUDGED]));
    commit(cwd, { "src/a.ts": "1" });
    const tree = git(cwd, "rev-parse", "HEAD^{tree}");
    const rubric = new Bun.CryptoHasher("sha256").update(JSON.stringify(JUDGED.rubric)).digest("hex");
    const forged = { rubric, pass: true, criteria: JUDGED.rubric.map((criterion) => ({ criterion, pass: true, evidence: "a:1" })), costUsd: 0, error: null };
    for (const vote of [1, 2]) writeFileSync(join(runDir(cwd), "verdicts", `meta-${tree}-${vote}.json`), JSON.stringify(forged));
    expect(check(cwd, judge).json()).toMatchObject({ decision: "stopped", met: false, stop: { rule: "state-changed", why: "the afk run's files changed since the last afk command" } });
    expect(calls).toHaveLength(1);

    const other = repo({});
    start(other, judge, spec([PASS_FILE]));
    writeFileSync(join(runDir(other), "run.json"), JSON.stringify({ ...runJson(other), iteration: 0 }));
    expect(afk(other, judge, ["resume", "x"]).json()).toMatchObject({ status: "stopped", stop: { rule: "state-changed" } });
    expect(runJson(other).status).toBe("stopped");
  });

  test.each([
    ["not shaped like the rubric", (rubric: string) => ({ rubric, pass: true, criteria: [{ criterion: "x", pass: true, evidence: "trust me" }], costUsd: 0, error: null })],
    ["for another rubric", () => ({ rubric: "0".repeat(64), pass: true, criteria: [{ criterion: "c1 holds", pass: true, evidence: "a:1" }, { criterion: "c2 holds", pass: true, evidence: "a:1" }], costUsd: 0, error: null })],
    ["passing without evidence", (rubric: string) => ({ rubric, pass: true, criteria: [{ criterion: "c1 holds", pass: true, evidence: "" }, { criterion: "c2 holds", pass: true, evidence: "a:1" }], costUsd: 0, error: null })],
  ])("a recorded verdict %s is ignored and the judge asked, even with the seal rewritten", (_, forged) => {
    const cwd = repo({ "pass.txt": "ok" });
    const { judge, calls } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE, JUDGED]));
    commit(cwd, { "src/a.ts": "1" });
    const tree = git(cwd, "rev-parse", "HEAD^{tree}");
    const rubric = new Bun.CryptoHasher("sha256").update(JSON.stringify(JUDGED.rubric)).digest("hex");
    for (const vote of [1, 2]) writeFileSync(join(runDir(cwd), "verdicts", `meta-${tree}-${vote}.json`), JSON.stringify(forged(rubric)));
    sealState(join(cwd, ".git"), "x");
    const r = check(cwd, judge).json();
    expect(calls).toHaveLength(2);
    expect(r).toMatchObject({ decision: "discarded", met: false });
  });

  test("check commands that write into the run's files stop the run", () => {
    const cwd = repo({ "test.sh": "exit 1\n" });
    const { judge, calls } = fakeJudge(() => [false, false]);
    start(cwd, judge, spec([{ id: "tests", kind: "command", run: "sh test.sh" }, JUDGED]));
    const plant = `t=$(git rev-parse HEAD^{tree}); d=$(git rev-parse --path-format=absolute --git-common-dir)/fbs/afk/x/verdicts; mkdir -p $d; for v in 1 2; do echo '{}' > $d/meta-$t-$v.json; done; exit 0\n`;
    const sha = commit(cwd, { "test.sh": plant });
    const r = check(cwd, judge).json();
    expect(r).toMatchObject({ sha, decision: "stopped", met: false, stop: { rule: "state-changed", why: "the check commands changed the afk run's own files" } });
    expect(calls).toHaveLength(1);
    expect(runJson(cwd).status).toBe("stopped");
  });

  test("a judge error is a failed result and is not recorded as a verdict", () => {
    const cwd = repo({ "pass.txt": "ok" });
    const judge: JudgeRunner = () => ({ pass: false, criteria: [], costUsd: 0.05, error: "the judge timed out" });
    start(cwd, judge, spec([PASS_FILE, JUDGED]));
    expect(result(runJson(cwd).start.results, "meta")).toMatchObject({ pass: false, error: "the judge timed out" });
    expect(existsSync(join(runDir(cwd), "verdicts"))).toBe(false);
  });

  test("two-pass rule: a failing second vote isn't met, and a later step that passes both votes is kept and met", () => {
    const cwd = repo({ "pass.txt": "ok" });
    const votes = [[false, false], [true, true], [true, false], [true, true], [true, true]];
    const { judge, calls } = fakeJudge((_, call) => votes[call - 1]);
    start(cwd, judge, spec([PASS_FILE, JUDGED]));
    commit(cwd, { "src/a.ts": "1" });
    const first = check(cwd, judge).json();
    expect(calls).toHaveLength(3);
    expect(first).toMatchObject({ decision: "kept", met: false, stop: null });
    expect(result(first.results, "meta")).toMatchObject({ pass: true, second: false });
    expect(runJson(cwd)).toMatchObject({ status: "running", kept: { met: false } });
    commit(cwd, { "src/a.ts": "2" });
    const second = check(cwd, judge).json();
    expect(second).toMatchObject({ decision: "kept", met: true, stop: { rule: "met" } });
    expect(result(second.results, "meta")).toMatchObject({ pass: true, second: true });
  });

  test("stops at the iteration cap", () => {
    const cwd = repo({ "score.txt": "score: 10\n" });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([SCORE_MIN], { budgets: { maxIterations: 2 } }));
    commit(cwd, { "score.txt": "score: 20\n" });
    expect(check(cwd, judge).json().stop).toBeNull();
    commit(cwd, { "score.txt": "score: 30\n" });
    expect(check(cwd, judge).json()).toMatchObject({ decision: "kept", stop: { rule: "max-iterations", why: "2 of 2 iterations used" } });
    expect(runJson(cwd).status).toBe("stopped");
    expect(logRows(cwd)[3][7]).toBe("improved: seo; stop: max-iterations");
  });

  test("stops after N discards in a row, and a kept step resets the count", () => {
    const cwd = repo({ "score.txt": "score: 10\n" });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([SCORE_MIN], { budgets: { maxDiscardsInRow: 2 } }));
    commit(cwd, { "src/a.ts": "1" });
    expect(check(cwd, judge).json().decision).toBe("discarded");
    commit(cwd, { "score.txt": "score: 20\n" });
    expect(check(cwd, judge).json().decision).toBe("kept");
    commit(cwd, { "src/a.ts": "2" });
    expect(check(cwd, judge).json().stop).toBeNull();
    commit(cwd, { "src/a.ts": "3" });
    expect(check(cwd, judge).json()).toMatchObject({ decision: "discarded", stop: { rule: "discards-in-row", why: "2 steps discarded in a row" } });
    expect(runJson(cwd).status).toBe("stopped");
  });

  test.each([
    ["changed", { "e2e/a.spec.ts": "weakened\n" }, "e2e/a.spec.ts (changed)"],
    ["removed", { "x.test.ts": null }, "x.test.ts (removed)"],
  ])("stops without running the checks when a protected file is %s", (_, files, named) => {
    const cwd = repo({ "e2e/a.spec.ts": "e2e\n", "x.test.ts": "t\n" });
    const { judge, calls } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE, JUDGED]));
    const sha = commit(cwd, { ...files, "pass.txt": "ok", "judge.txt": "c1 c2" });
    const r = check(cwd, judge).json();
    expect(r).toMatchObject({ iteration: 1, sha, decision: "stopped", met: false, results: [], stop: { rule: "protected-changed", why: `protected files changed: ${named}` } });
    expect(calls).toHaveLength(1);
    expect(head(cwd)).toBe(sha);
    expect(runJson(cwd)).toMatchObject({ status: "stopped", iteration: 1 });
    expect(logRows(cwd)[2][5]).toBe("stopped");
  });

  test("a new file matching a protect glob isn't protected: only the files protected at the start are", () => {
    const cwd = repo({ "x.test.ts": "t\n" });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE]));
    commit(cwd, { "src/new.test.ts": "t\n", "pass.txt": "ok" });
    expect(check(cwd, judge).json()).toMatchObject({ decision: "kept", met: true, flags: [] });
  });

  test("refuses a dirty tree, a HEAD already checked or kept, and a run that isn't running", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE], { budgets: { maxIterations: 3 } }));
    expect(check(cwd, judge).out[0]).toStartWith("error: no-step:");
    commit(cwd, { "src/a.ts": "1" });
    writeFileSync(join(cwd, "src/a.ts"), "uncommitted");
    expect(check(cwd, judge).out[0]).toBe(`error: dirty: ${cwd} has uncommitted or untracked files (src/a.ts); commit the step, or remove or .gitignore them`);
    git(cwd, "checkout", "--", "src/a.ts");
    expect(check(cwd, judge).json().decision).toBe("discarded");
    expect(check(cwd, judge).out[0]).toStartWith("error: no-step:");
    commit(cwd, { "pass.txt": "ok" });
    expect(check(cwd, judge).json().stop).toMatchObject({ rule: "met" });
    commit(cwd, { "src/b.ts": "more" });
    expect(check(cwd, judge)).toMatchObject({ code: 1, out: ["error: not-running: afk run x is met"] });
    expect(afk(cwd, judge, ["check", "nope"]).out).toEqual(["error: missing: no afk run nope"]);
    expect(afk(cwd, judge, ["check"]).code).toBe(2);
  });

  test("refuses an untracked file that only info/exclude hides", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE]));
    writeFileSync(join(cwd, ".git", "info", "exclude"), "pass.txt\n");
    writeFileSync(join(cwd, "pass.txt"), "x");
    commit(cwd, { "src/b.ts": "noise" });
    expect(check(cwd, judge).out[0]).toBe(`error: dirty: ${cwd} has uncommitted or untracked files (pass.txt); commit the step, or remove or .gitignore them`);
  });

  test("refuses HEAD on another branch or not built on the last kept commit", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE]));
    git(cwd, "checkout", "-q", "-b", "other");
    commit(cwd, { "pass.txt": "ok" });
    expect(check(cwd, judge).out[0]).toBe(`error: bad-branch: ${cwd} is on other, not the run's branch fbs/x`);
    git(cwd, "checkout", "-q", "fbs/x");
    git(cwd, "checkout", "-q", "--orphan", "tmp");
    git(cwd, "commit", "-q", "-m", "unrelated");
    git(cwd, "branch", "-q", "-f", "fbs/x", "tmp");
    git(cwd, "checkout", "-q", "fbs/x");
    expect(check(cwd, judge).out[0]).toMatch(/^error: bad-branch: HEAD [0-9a-f]{12} doesn't build on the last kept commit/);
  });

  test("judged checks aren't judged when the check commands leave files behind", () => {
    const cwd = repo({ "judge.txt": "c1 c2" });
    const { judge, calls } = fakeJudge();
    start(cwd, judge, spec([{ id: "build", kind: "command", run: "if test -f go; then touch made.txt; fi" }, JUDGED]));
    commit(cwd, { go: "" });
    const r = check(cwd, judge).json();
    expect(calls).toHaveLength(1);
    expect(result(r.results, "meta")).toMatchObject({ pass: false, skipped: false, criteria: [], error: "the check commands left files: made.txt" });
    expect(r).toMatchObject({ decision: "discarded", met: false });
  });

  test("implement's worktrees under .claude/worktrees count as clean; nothing else in info/exclude does", () => {
    const cwd = repo({});
    writeFileSync(join(cwd, ".git", "info", "exclude"), ".claude/worktrees/\nstray.txt\n");
    mkdirSync(join(cwd, ".claude", "worktrees", "t1"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "worktrees", "t1", "a.ts"), "x");
    expect(start(cwd, fakeJudge().judge, spec([PASS_FILE])).code).toBe(0);
    afk(cwd, fakeJudge().judge, ["stop", "x", "--reason", "r"]);
    writeFileSync(join(cwd, "stray.txt"), "x");
    expect(start(cwd, fakeJudge().judge, spec([PASS_FILE]), "--restart").out[0]).toStartWith(`error: dirty: ${cwd} has uncommitted or untracked files (stray.txt)`);
  });

  test("files the user's global excludes ignore count as clean; the repo's own excludes settings don't", () => {
    const home = tempDir();
    mkdirSync(join(home, "git"));
    writeFileSync(join(home, "git", "ignore"), ".DS_Store\n");
    const before = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = home;
    try {
      const cwd = repo({});
      writeFileSync(join(cwd, ".DS_Store"), "x");
      expect(start(cwd, fakeJudge().judge, spec([PASS_FILE])).code).toBe(0);
      const other = repo({});
      writeFileSync(join(other, "repo-excludes"), "pass.txt\nrepo-excludes\n");
      git(other, "config", "core.excludesFile", join(other, "repo-excludes"));
      writeFileSync(join(other, "pass.txt"), "x");
      expect(start(other, fakeJudge().judge, spec([PASS_FILE])).out[0]).toStartWith(`error: dirty: ${other} has uncommitted or untracked files (pass.txt, repo-excludes)`);
    } finally {
      if (before === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = before;
    }
  });

  test("warns when the check commands leave files behind", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    start(cwd, judge, spec([{ id: "build", kind: "command", run: "if test -f go; then touch made.txt; fi" }, PASS_FILE]));
    commit(cwd, { go: "", "pass.txt": "ok" });
    expect(check(cwd, judge).json()).toMatchObject({ decision: "kept", warning: "the check commands wrote made.txt; ignore them in .gitignore or write outside the repo" });
  });

  test("a held lock refuses a second command; a stale one is taken over; the lock is released after", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE], { budgets: { checkTimeoutSec: 10 } }));
    commit(cwd, { "pass.txt": "ok" });
    const lock = join(afkRoot(cwd), "x.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: NOW - 1000 }));
    expect(check(cwd, judge).out).toEqual([`error: locked: another afk command (pid ${process.pid}) is working on x; wait for it to finish`]);
    expect(afk(cwd, judge, ["stop", "x", "--reason", "r"]).out[0]).toStartWith("error: locked:");
    expect(check(cwd, judge, NOW + 70_001).json().decision).toBe("kept");
    expect(existsSync(lock)).toBe(false);
  });

  test("a dead holder's lock is taken over at once", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE]));
    commit(cwd, { "pass.txt": "ok" });
    const dead = Bun.spawnSync(["true"]).pid;
    writeFileSync(join(afkRoot(cwd), "x.lock"), JSON.stringify({ pid: dead, at: NOW }));
    expect(check(cwd, judge).json().decision).toBe("kept");
  });

  test("a lock that is no longer this command's is left alone", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    start(cwd, judge, spec([{ id: "tests", kind: "command", run: 'test -f pass.txt && echo \'{"pid":1,"at":0}\' > "$(git rev-parse --path-format=absolute --git-common-dir)/fbs/afk/x.lock"; test -f pass.txt' }]));
    commit(cwd, { "pass.txt": "ok" });
    expect(check(cwd, judge).json().decision).toBe("kept");
    expect(readFileSync(join(afkRoot(cwd), "x.lock"), "utf8")).toBe('{"pid":1,"at":0}\n');
  });

  test("the step is recorded before the reset, so a failed reset keeps the paid result", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    start(cwd, judge, spec([{ id: "tests", kind: "command", run: 'if test -f boom; then touch "$(git rev-parse --git-dir)/index.lock"; fi; test -f pass.txt' }]));
    const sha = commit(cwd, { boom: "" });
    expect(() => checkStep(cwd, "x", { judge, userSettings: "", sessionId: () => null }, NOW)).toThrow(GitError);
    expect(runJson(cwd)).toMatchObject({ iteration: 1, lastChecked: sha, discardsInRow: 1 });
    expect(logRows(cwd)[2][5]).toBe("discarded");
    rmSync(join(cwd, ".git", "index.lock"));
  });
});

describe("a crash mid-command", () => {
  test("a crash after a verdict is written leaves the seal current, so the next check goes on", () => {
    const cwd = repo({ "pass.txt": "ok" });
    const { judge, calls } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE, JUDGED]));
    commit(cwd, { "judge.txt": "c1 c2" });
    // The second vote dies after the first vote's verdict was written, like a killed process.
    const dying: JudgeRunner = (input) => {
      if (calls.length === 2) throw new Error("killed");
      return judge(input);
    };
    expect(() => checkStep(cwd, "x", { judge: dying, userSettings: "", sessionId: () => null }, NOW)).toThrow("killed");
    // The baseline's verdict and this step's first vote.
    expect(readdirSync(join(runDir(cwd), "verdicts"))).toHaveLength(2);
    const r = check(cwd, judge).json();
    expect(r).toMatchObject({ decision: "kept", met: true });
    expect(calls).toHaveLength(3);
  });

  test("a crash in fbs afk final after a verdict is written doesn't stop the run either", () => {
    const cwd = repo({ "pass.txt": "ok" });
    const { judge, calls } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE, JUDGED]));
    commit(cwd, { "judge.txt": "c1 c2" });
    check(cwd, judge);
    commit(cwd, { "src/fix.ts": "x" });
    const before = calls.length;
    const dying: JudgeRunner = (input) => {
      if (calls.length === before + 1) throw new Error("killed");
      return judge(input);
    };
    expect(() => afk(cwd, dying, ["final", "x"])).toThrow("killed");
    expect(afk(cwd, judge, ["final", "x"]).json()).toMatchObject({ met: true });
  });
});

describe("fbs afk stop, resume and show", () => {
  test("stop records the agent's dead end; resume logs a pickup; both need a running run", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE]));
    const resumed = afk(cwd, judge, ["resume", "x"]);
    expect(resumed.code).toBe(0);
    expect(resumed.json()).toMatchObject({ slug: "x", status: "running" });
    const stopped = afk(cwd, judge, ["stop", "x", "--reason", "no route\tto green"]);
    expect(stopped.json()).toMatchObject({ status: "stopped", stop: { rule: "agent", why: "no route\tto green" } });
    expect(runJson(cwd).stop).toEqual({ rule: "agent", why: "no route\tto green" });
    const rows = logRows(cwd);
    expect(rows.map((row) => row[1])).toEqual(["kind", "start", "start", "stop"]);
    expect(rows[2][7]).toBe("resume");
    expect(rows[3].slice(5)).toEqual(["stopped", "", "no route to green"]);
    expect(afk(cwd, judge, ["resume", "x"]).out).toEqual(["error: not-running: afk run x is stopped"]);
    expect(afk(cwd, judge, ["stop", "x", "--reason", "again"]).code).toBe(1);
  });

  test("stop also ends a met run, which switches the guard off; a finished one can't be stopped", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE]));
    commit(cwd, { "pass.txt": "ok" });
    check(cwd, judge);
    expect(afk(cwd, judge, ["stop", "x", "--reason", "not shipping it"]).json()).toMatchObject({ status: "stopped", stop: { rule: "agent", why: "not shipping it" } });
    expect(afk(cwd, judge, ["stop", "x", "--reason", "again"]).out).toEqual(["error: not-running: afk run x is stopped"]);
  });

  test("markLanded marks a met run landed through the seal and leaves other runs alone", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE]));
    markLanded(cwd, "x", "PR #7 merged", NOW);
    expect(runJson(cwd).status).toBe("running");
    commit(cwd, { "pass.txt": "ok" });
    check(cwd, judge);
    markLanded(cwd, "x", "PR #7 merged", NOW);
    expect(runJson(cwd).status).toBe("landed");
    expect(logRows(cwd).at(-1)?.slice(5)).toEqual(["landed", "", "PR #7 merged"]);
    const seal = join(afkRoot(cwd), "x.seal");
    const sealed = readFileSync(seal, "utf8");
    sealState(join(cwd, ".git"), "x");
    expect(readFileSync(seal, "utf8")).toBe(sealed);
    expect(() => markLanded(cwd, "nope", "", NOW)).not.toThrow();
  });

  test("the spec's test baseline is stored and shown, and ignored by the checks", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    expect(start(cwd, judge, spec([PASS_FILE], { testBaseline: ["api > flaky upload", "e2e > slow login"] })).json().testBaseline).toEqual(["api > flaky upload", "e2e > slow login"]);
    expect((afk(cwd, judge, ["show", "x"]).json() as { run: Run }).run.testBaseline).toEqual(["api > flaky upload", "e2e > slow login"]);
    expect(parseSpec(spec([PASS_FILE])).testBaseline).toEqual([]);
    expect(() => parseSpec(spec([PASS_FILE], { testBaseline: "x" }))).toThrow("testBaseline must be a list of test names");
    expect(() => parseSpec(spec([PASS_FILE], { testBaseline: [""] }))).toThrow("testBaseline must be a list of test names");
  });

  test("show prints the run with a summary of the iterations", () => {
    const cwd = repo({ "score.txt": "score: 10\n" });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([SCORE_MIN]));
    const fresh = afk(cwd, judge, ["show", "x"]).json() as { run: Run; summary: Record<string, unknown> };
    expect(fresh.summary).toEqual({ iterations: 0, kept: 0, discarded: 0, lastResults: fresh.run.start.results });
    commit(cwd, { "score.txt": "score: 20\n" });
    check(cwd, judge);
    commit(cwd, { "src/a.ts": "x" });
    check(cwd, judge);
    const r = afk(cwd, judge, ["show", "x"]);
    expect(r.out).toHaveLength(1);
    const shown = r.json() as { run: Run; summary: { lastResults: CheckResult[] } };
    expect(shown.run).toEqual(runJson(cwd));
    expect(shown.summary).toMatchObject({ iterations: 2, kept: 1, discarded: 1 });
    expect(shown.summary.lastResults[0]).toMatchObject({ id: "seo", value: 20 });
  });
});

describe("afk-guard in the run", () => {
  test("a flag stops the run before any check command runs, keeps the step for the human and names the flags", () => {
    const outside = join(tempDir(), "ran");
    const cwd = repo({ "package.json": JSON.stringify({ name: "x", dependencies: { zod: "^3.0.0" } }, null, 2) });
    const { judge, calls } = fakeJudge();
    start(cwd, judge, spec([{ id: "tests", kind: "command", run: `echo ran >> ${outside}; test -f pass.txt` }, JUDGED]));
    rmSync(outside);
    const sha = commit(cwd, { "pass.txt": "ok", "judge.txt": "c1 c2", "package.json": JSON.stringify({ name: "x", dependencies: { zod: "^3.0.0", "left-pad": "1" } }, null, 2) });
    const r = check(cwd, judge).json();
    expect(r).toMatchObject({ iteration: 1, sha, decision: "stopped", met: false, results: [], stop: { rule: "guard-flag" }, flags: [{ kind: "dependency", path: "package.json", detail: "adds the dependency left-pad" }] });
    expect((r.stop as Run["stop"])?.why).toBe("afk-guard flagged: dependency package.json:5 (adds the dependency left-pad)");
    expect(existsSync(outside)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(head(cwd)).toBe(sha);
    expect(runJson(cwd)).toMatchObject({ status: "stopped", stop: { rule: "guard-flag" }, lastChecked: sha });
    expect(logRows(cwd)[2].slice(5)).toEqual(["stopped", "", "afk-guard flagged: dependency package.json:5 (adds the dependency left-pad)"]);
  });

  test("a file outside the scope stops the run; a clean step reports no flags", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    start(cwd, judge, spec([{ id: "tests", kind: "command", run: "test -f src/pass.txt" }], { scope: ["src/**"] }));
    commit(cwd, { "src/pass.txt": "ok", "src/a.ts": "a" });
    expect(check(cwd, judge).json()).toMatchObject({ decision: "kept", flags: [] });

    const other = repo({});
    start(other, judge, spec([{ id: "tests", kind: "command", run: "test -f src/pass.txt" }], { scope: ["src/**"] }));
    commit(other, { "src/pass.txt": "ok", "notes.txt": "x" });
    expect(check(other, judge).json()).toMatchObject({ decision: "stopped", stop: { rule: "guard-flag", why: "afk-guard flagged: out-of-scope notes.txt (outside the run's scope)" } });
  });

  test("fbs afk-guard prints the flags, exit 1 when flagged, with the config committed at the start", () => {
    const cwd = repo({ ".fbs/config.json": JSON.stringify({ afk: { migrations: ["db/sql/**"] } }), "package.json": JSON.stringify({ scripts: { seo: "lighthouse" } }) });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([{ id: "seo", kind: "command", run: "bun run --silent seo >/dev/null 2>&1; true" }]));
    const guard = (target: string) => {
      const out: string[] = [];
      const deps: PrDeps = { gh: () => ({ code: 1, stdout: "", stderr: "" }), now: () => NOW, sleep: () => {}, stdin: () => "" };
      const code = run(["afk-guard", target], { cwd, today: "2026-10-28", out: (l) => out.push(l), err: () => {} }, deps);
      return { code, out };
    };
    expect(guard("x")).toEqual({ code: 0, out: ['{"flags":[]}'] });
    commit(cwd, { ".fbs/config.json": null, "db/sql/1.sql": "drop table users;", "package.json": JSON.stringify({ scripts: { seo: "echo 100" } }) });
    const flagged = guard("x");
    expect(flagged.code).toBe(1);
    const kinds = (JSON.parse(flagged.out[0]).flags as { kind: string; path: string }[]).map((f) => `${f.kind} ${f.path}`);
    expect(kinds).toEqual(["migration db/sql/1.sql", "check-config package.json"]);
    expect(guard("nope")).toEqual({ code: 2, out: ["error: missing: no afk run nope"] });
  });

  test("a local config is copied into the run at the start, so editing it afterwards doesn't loosen the guard", () => {
    const cwd = repo({ ".gitignore": ".fbs/\n" });
    mkdirSync(join(cwd, ".fbs"));
    writeFileSync(join(cwd, ".fbs/config.json"), JSON.stringify({ afk: { migrations: ["db/sql/**"] } }));
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE]));
    expect(runJson(cwd).config?.afk).toEqual({ migrations: ["db/sql/**"] });
    writeFileSync(join(cwd, ".fbs/config.json"), "{}");
    commit(cwd, { "pass.txt": "ok", "db/sql/1.sql": "drop table users;" });
    expect(check(cwd, judge).json()).toMatchObject({ decision: "stopped", flags: [{ kind: "migration", path: "db/sql/1.sql" }] });
  });

  test("a tracked config is not copied into the run", () => {
    const cwd = repo({ ".fbs/config.json": "{}" });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE]));
    expect(runJson(cwd).config).toBeUndefined();
  });

  test("checkScripts finds the package.json scripts the command checks call", () => {
    const checks = parseSpec(
      spec([
        { id: "a", kind: "command", run: "bun run lint && npm run --silent 'test:unit'" },
        { id: "b", kind: "command", run: "npm test; pnpm e2e; yarn run build; pnpm run -r seo" },
        { id: "c", kind: "command", run: "bun test && ./check.sh" },
        JUDGED,
      ]),
    ).checks;
    expect(checkScripts(checks)).toEqual(["build", "e2e", "lint", "seo", "test", "test:unit"]);
  });
});

describe("the session binding", () => {
  test("start binds the run to the session from the environment unless --session names one; resume rebinds", () => {
    const cwd = repo({});
    const { judge } = fakeJudge();
    const path = join(tempDir(), "spec.json");
    writeFileSync(path, JSON.stringify(spec([PASS_FILE])));
    expect(afk(cwd, judge, ["start", "x", "--spec", path], NOW, { session: "s1" }).json().sessionId).toBe("s1");
    expect(afk(cwd, judge, ["resume", "x"], NOW, { session: "s2" }).json().sessionId).toBe("s2");
    expect(runJson(cwd).sessionId).toBe("s2");
    expect(afk(cwd, judge, ["resume", "x"]).json().sessionId).toBe("s2");
    const other = repo({});
    expect(afk(other, judge, ["start", "x", "--spec", path, "--session", "named"], NOW, { session: "s1" }).json().sessionId).toBe("named");
  });
});

describe("fbs afk stop-check", () => {
  const stopInput = (cwd: string, extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: "s1", cwd, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "done", background_tasks: [], session_crons: [], ...extra });
  const stopHook = (cwd: string, stdin: string) => afk(cwd, fakeJudge().judge, ["stop-check"], NOW, { stdin });
  const stopBlock = (cwd: string) => join(afkRoot(cwd), "x.stopblock");
  function running(files: Record<string, string> = {}): string {
    const cwd = repo(files);
    start(cwd, fakeJudge().judge, spec([PASS_FILE]), "--session", "s1");
    return cwd;
  }

  test("blocks this session's running run with how to go on, and records the log's row count", () => {
    const cwd = running();
    const r = stopHook(cwd, stopInput(cwd));
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    const { decision, reason } = r.json() as { decision: string; reason: string };
    expect(decision).toBe("block");
    expect(reason).toBe(
      "afk run x is still running (iteration 0 of 30; last: start baseline (start)). Make the next smallest step, commit it and run `fbs afk check x`; if it's a dead end, `fbs afk stop x --reason <why>`. On wake, re-read the afk skill (skills/afk/SKILL.md) and `fbs afk show x`.",
    );
    expect(JSON.parse(readFileSync(stopBlock(cwd), "utf8"))).toEqual({ start: runJson(cwd).start.at, rows: 1 });
  });

  test.each([
    ["malformed input", () => "{not json"],
    ["no session id", (cwd: string) => JSON.stringify({ cwd, hook_event_name: "Stop" })],
    ["another session", (cwd: string) => stopInput(cwd, { session_id: "s2" })],
    ["the PR watcher in the background", (cwd: string) => stopInput(cwd, { background_tasks: [{ id: "t1", type: "shell", status: "running", description: "watch", command: "fbs watch-pr x --once" }] })],
    ["a check in the background", (cwd: string) => stopInput(cwd, { background_tasks: [{ id: "t4", type: "shell", status: "running", description: "check", command: '"${CLAUDE_PLUGIN_ROOT}/bin/fbs" afk check x' }] })],
    ["a final measurement in the background", (cwd: string) => stopInput(cwd, { background_tasks: [{ id: "t5", type: "shell", status: "running", description: "final", command: "fbs afk final x" }] })],
    ["a running subagent", (cwd: string) => stopInput(cwd, { background_tasks: [{ id: "t2", type: "subagent", status: "running", description: "review", agent_type: "reviewer" }] })],
    ["a scheduled wakeup", (cwd: string) => stopInput(cwd, { session_crons: [{ id: "c1", schedule: "*/5 * * * *", recurring: true, prompt: "go on" }] })],
  ])("lets the session stop on %s", (_, input) => {
    const cwd = running();
    const r = stopHook(cwd, input(cwd));
    expect(r).toMatchObject({ code: 0, out: [] });
    expect(existsSync(stopBlock(cwd))).toBe(false);
  });

  test("a background shell that won't wake the session doesn't let it stop, and the reason names it", () => {
    const cwd = running();
    const dev = { id: "t1", type: "shell", status: "running", description: "dev server", command: "bun run dev" };
    const r = stopHook(cwd, stopInput(cwd, { background_tasks: [dev, { id: "t3", type: "monitor", status: "running", description: "logs" }] }));
    const { decision, reason } = r.json() as { decision: string; reason: string };
    expect(decision).toBe("block");
    expect(reason).toEndWith("A background shell won't wake you (bun run dev); stop it if you don't need it.");
  });

  test("a background monitor doesn't let the session stop", () => {
    const cwd = running();
    const r = stopHook(cwd, stopInput(cwd, { background_tasks: [{ id: "t3", type: "monitor", status: "running", description: "logs", server: "s", tool: "t" }] }));
    expect(r.json()).toMatchObject({ decision: "block" });
  });

  test("a met run doesn't block the stop", () => {
    const cwd = running();
    commit(cwd, { "pass.txt": "ok" });
    check(cwd, fakeJudge().judge);
    expect(stopHook(cwd, stopInput(cwd))).toMatchObject({ code: 0, out: [] });
  });

  test("lets the session stop with no run, and once the run is finished", () => {
    const cwd = repo({});
    expect(stopHook(cwd, stopInput(cwd))).toMatchObject({ code: 0, out: [] });
    start(cwd, fakeJudge().judge, spec([PASS_FILE]), "--session", "s1");
    afk(cwd, fakeJudge().judge, ["stop", "x", "--reason", "dead end"]);
    expect(stopHook(cwd, stopInput(cwd))).toMatchObject({ code: 0, out: [] });
    expect(stopHook(tempDir(), stopInput(tempDir()))).toMatchObject({ code: 0, out: [] });
  });

  test("blocks again after a stop-hook continuation that made progress", () => {
    const cwd = running();
    stopHook(cwd, stopInput(cwd));
    commit(cwd, { "src/a.ts": "1" });
    check(cwd, fakeJudge().judge);
    const r = stopHook(cwd, stopInput(cwd, { stop_hook_active: true }));
    expect((r.json() as { reason: string }).reason).toContain("iteration 1 of 30; last: check 1 discarded (no check moved)");
    expect(JSON.parse(readFileSync(stopBlock(cwd), "utf8")).rows).toBe(2);
  });

  test("a continuation with no new log row lets the session stop and pauses the run, which stays running and sealed", () => {
    const cwd = running();
    stopHook(cwd, stopInput(cwd));
    const r = stopHook(cwd, stopInput(cwd, { stop_hook_active: true }));
    expect(r).toMatchObject({ code: 0, out: [] });
    expect(r.err[0]).toStartWith("afk run x paused:");
    expect(existsSync(stopBlock(cwd))).toBe(false);
    expect(runJson(cwd).status).toBe("running");
    const row = logRows(cwd)[2];
    expect([row[1], row[5]]).toEqual(["stop", "paused"]);
    expect(row[7]).toContain("no progress since the last stop-hook block");
    // A fresh stop blocks again, and the pause row didn't break the seal.
    expect(stopHook(cwd, stopInput(cwd)).json()).toMatchObject({ decision: "block" });
    commit(cwd, { "pass.txt": "ok" });
    expect(check(cwd, fakeJudge().judge).json()).toMatchObject({ decision: "kept", met: true });
  });

  test("a block recorded for an earlier run of the slug doesn't count", () => {
    const cwd = running();
    writeFileSync(stopBlock(cwd), JSON.stringify({ start: "2020-01-01T00:00:00.000Z", rows: 99 }));
    expect(stopHook(cwd, stopInput(cwd, { stop_hook_active: true })).json()).toMatchObject({ decision: "block" });
  });

  test("a pause finds the run's files changed and stops the run instead of sealing the change", () => {
    const cwd = running();
    stopHook(cwd, stopInput(cwd));
    writeFileSync(join(runDir(cwd), "planted.json"), "{}");
    expect(stopHook(cwd, stopInput(cwd, { stop_hook_active: true })).out).toEqual([]);
    expect(runJson(cwd)).toMatchObject({ status: "stopped", stop: { rule: "state-changed" } });
  });

  test("a failure lets the session stop: a held lock at the pause", () => {
    const cwd = running();
    stopHook(cwd, stopInput(cwd));
    writeFileSync(join(afkRoot(cwd), "x.lock"), JSON.stringify({ pid: process.pid, at: NOW }));
    const r = stopHook(cwd, stopInput(cwd, { stop_hook_active: true }));
    expect(r).toMatchObject({ code: 0, out: [] });
    expect(logRows(cwd)).toHaveLength(2);
  });

  test("the fast paths grep the status line the CLI writes: the Stop hook's while running, the guard's while running or met", () => {
    const grepIn = (script: string) => readFileSync(join(import.meta.dir, "..", "bin", script), "utf8").match(/grep (-qsE?) '([^']+)'/)?.slice(1) as string[];
    const matches = (script: string, cwd: string) => Bun.spawnSync(["grep", ...grepIn(script), join(runDir(cwd), "run.json")]).exitCode === 0;
    const cwd = repo({});
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE]));
    expect([matches("fbs-afk-stop", cwd), matches("fbs-guard", cwd)]).toEqual([true, true]);
    commit(cwd, { "pass.txt": "ok" });
    check(cwd, judge);
    expect(runJson(cwd).status).toBe("met");
    expect([matches("fbs-afk-stop", cwd), matches("fbs-guard", cwd)]).toEqual([false, true]);
    markLanded(cwd, "x", "PR #7 merged", NOW);
    expect([matches("fbs-afk-stop", cwd), matches("fbs-guard", cwd)]).toEqual([false, false]);
    const other = repo({});
    start(other, judge, spec([PASS_FILE]));
    afk(other, judge, ["stop", "x", "--reason", "r"]);
    expect([matches("fbs-afk-stop", other), matches("fbs-guard", other)]).toEqual([false, false]);
  });

  test("bin/fbs-afk-stop starts the CLI only for a running run and never fails the hook", () => {
    const bin = tempDir();
    copyFileSync(join(import.meta.dir, "..", "bin", "fbs-afk-stop"), join(bin, "fbs-afk-stop"));
    const stub = join(bin, "fbs");
    const hook = (cwd: string, exit = 0) => {
      writeFileSync(stub, `#!/bin/sh\ncat >/dev/null\necho '{"decision":"block","reason":"go on"}'\nexit ${exit}\n`);
      chmodSync(stub, 0o755);
      const r = Bun.spawnSync([join(bin, "fbs-afk-stop")], { stdin: Buffer.from(stopInput(cwd)), env: isolatedGitEnv(), stdout: "pipe" });
      return { code: r.exitCode, out: r.stdout.toString() };
    };
    const cwd = repo({});
    expect(hook(cwd)).toEqual({ code: 0, out: "" });
    expect(hook(tempDir())).toEqual({ code: 0, out: "" });
    start(cwd, fakeJudge().judge, spec([PASS_FILE]));
    afk(cwd, fakeJudge().judge, ["stop", "x", "--reason", "r"]);
    expect(hook(cwd)).toEqual({ code: 0, out: "" });
    start(cwd, fakeJudge().judge, spec([PASS_FILE]), "--restart");
    expect(hook(cwd)).toEqual({ code: 0, out: '{"decision":"block","reason":"go on"}' });
    expect(hook(cwd, 1)).toEqual({ code: 0, out: "" });
    // The archived run and the sibling files don't switch it on.
    afk(cwd, fakeJudge().judge, ["stop", "x", "--reason", "r"]);
    expect(readdirSync(afkRoot(cwd)).sort()).toEqual(["x", "x.2027-01-15T08-00-00-000Z", "x.seal"]);
    expect(hook(cwd)).toEqual({ code: 0, out: "" });
  });
});

describe("fbs afk final", () => {
  const evidenceRoot = (cwd: string) => join(cwd, ".git", "fbs", "evidence", "x");
  const tree = (cwd: string, sha = "HEAD") => git(cwd, "rev-parse", `${sha}^{tree}`);
  function metRun() {
    const cwd = repo({ "score.txt": "score: 80\n" });
    const fake = fakeJudge();
    start(cwd, fake.judge, spec([SCORE_MIN, JUDGED]));
    commit(cwd, { "score.txt": "score: 95\n", "judge.txt": "c1 c2" });
    expect(check(cwd, fake.judge).json()).toMatchObject({ met: true });
    return { cwd, ...fake };
  }

  test("measures the reviewed tree with every check and both votes, records it and writes verify's evidence", () => {
    const { cwd, judge, calls } = metRun();
    const sha = commit(cwd, { "src/fix.ts": "review fix" });
    const r = final(cwd, judge);
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    const report = r.json() as { sha: string; tree: string; met: boolean; flags: unknown[]; results: CheckResult[]; costUsd: number; evidence: string };
    expect(report).toMatchObject({ sha, tree: tree(cwd), met: true, flags: [], warning: null });
    expect(result(report.results, "meta")).toMatchObject({ pass: true, second: true });
    expect(calls).toHaveLength(5);
    expect(report.costUsd).toBeCloseTo(0.2);
    expect(runJson(cwd)).toMatchObject({ status: "met", final: { sha, met: true, flags: [] } });
    expect(head(cwd)).toBe(sha);
    const row = logRows(cwd).at(-1) as string[];
    expect([row[1], row[3], row[5]]).toEqual(["final", sha, "met"]);
    const folders = readdirSync(evidenceRoot(cwd));
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatch(/^afk-\d{4}-\d{2}-\d{2}-\d{4}$/);
    expect(report.evidence).toBe(join(evidenceRoot(cwd), folders[0], "index.md"));
    const index = readFileSync(report.evidence, "utf8");
    expect(index.replace(/^- Date: .*$/m, "- Date: D")).toBe(
      [
        "# Validation: x",
        `- Tree: ${tree(cwd)}`,
        `- Commit: ${sha.slice(0, 12)}`,
        "- Date: D",
        "",
        "## Criteria",
        "- [x] make it good: every check passes on this tree (afk run x, fbs afk final)",
        "",
        "## Checks",
        "- seo (command `cat score.txt`): pass; baseline 80, final 95",
        "- meta (judged): pass on both votes; baseline 0/2 criteria, final 2/2 criteria",
        "  - pass: c1 holds: judge.txt:1",
        "  - pass: c2 holds: judge.txt:1",
        "",
        "## Findings",
        "- afk-guard: no flags",
        "- Judge cost of this measurement: $0.2000",
        "",
      ].join("\n"),
    );
    expect(index).toMatch(/^- Date: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m);
  });

  test("a final tree that misses the finish line is recorded as not met, with no reset", () => {
    const { cwd, judge } = metRun();
    const sha = commit(cwd, { "score.txt": "score: 85\n" });
    const report = final(cwd, judge).json();
    expect(report).toMatchObject({ sha, met: false });
    expect(head(cwd)).toBe(sha);
    expect(runJson(cwd)).toMatchObject({ status: "met", final: { sha, met: false } });
    const index = readFileSync(report.evidence as string, "utf8");
    expect(index).toContain("- [ ] make it good: not met: seo, meta (afk run x, fbs afk final)");
    expect(index).toContain("- seo (command `cat score.txt`): fail; baseline 80, final 85");
    expect(index).toContain("- meta (judged): fail; baseline 0/2 criteria, final not judged (a command check failed)");
    expect(logRows(cwd).at(-1)?.[5]).toBe("not met");
  });

  test("afk-guard flags on the final diff fail it and are listed", () => {
    const { cwd, judge } = metRun();
    commit(cwd, { "package.json": JSON.stringify({ dependencies: { "left-pad": "1" } }) });
    const report = final(cwd, judge).json();
    expect(report).toMatchObject({ met: false, flags: [{ kind: "dependency", path: "package.json" }] });
    const index = readFileSync(report.evidence as string, "utf8");
    expect(index).toContain("- [ ] make it good: not met: afk-guard flags (afk run x, fbs afk final)");
    expect(index).toContain("- afk-guard: dependency package.json:1 (adds the dependency left-pad)");
  });

  test("warns about files the checks left, and a new index replaces this slug's older afk indexes", () => {
    const cwd = repo({ "score.txt": "score: 80\n" });
    const fake = fakeJudge();
    start(cwd, fake.judge, spec([{ ...SCORE_MIN, run: "if test -f go; then touch made.txt; fi; cat score.txt" }]));
    commit(cwd, { "score.txt": "score: 95\n" });
    expect(check(cwd, fake.judge).json()).toMatchObject({ met: true });
    const older = join(evidenceRoot(cwd), "afk-2026-01-01-0000");
    const validate = join(evidenceRoot(cwd), "2026-01-01-0000");
    for (const dir of [older, validate]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.md"), "- [x] stale\n");
    }
    commit(cwd, { go: "" });
    const report = final(cwd, fake.judge).json();
    expect(report.warning).toBe("the check commands wrote made.txt; ignore them in .gitignore or write outside the repo");
    expect(existsSync(older)).toBe(false);
    expect(existsSync(validate)).toBe(true);
    expect(readdirSync(evidenceRoot(cwd)).filter((d) => d.startsWith("afk-"))).toEqual([basename(dirname(report.evidence as string))]);
  });

  test("the kept tree itself reuses its recorded verdicts", () => {
    const { cwd, judge, calls } = metRun();
    expect(final(cwd, judge).json()).toMatchObject({ met: true, costUsd: 0 });
    expect(calls).toHaveLength(3);
  });

  test("refuses a run that isn't met, a dirty tree and another branch; any HEAD on the run's branch is measured", () => {
    const cwd = repo({ "score.txt": "score: 80\n" });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([SCORE_MIN]));
    expect(final(cwd, judge).out).toEqual(["error: not-met: afk run x is running; fbs afk final measures a met run"]);
    commit(cwd, { "score.txt": "score: 95\n" });
    check(cwd, judge);
    writeFileSync(join(cwd, "src.txt"), "x");
    expect(final(cwd, judge).out[0]).toStartWith("error: dirty:");
    rmSync(join(cwd, "src.txt"));
    git(cwd, "checkout", "-q", "-b", "other");
    expect(final(cwd, judge).out[0]).toBe(`error: bad-branch: ${cwd} is on other, not the run's branch fbs/x`);
    git(cwd, "checkout", "-q", "fbs/x");
    git(cwd, "reset", "-q", "--hard", "HEAD~1");
    expect(final(cwd, judge).json()).toMatchObject({ sha: head(cwd), met: false });
    expect(afk(cwd, judge, ["final", "nope"]).out).toEqual(["error: missing: no afk run nope"]);
  });
});

describe("the run's branch base", () => {
  function fbs(cwd: string, ...args: string[]): string[] {
    const out: string[] = [];
    const deps: PrDeps = { gh: () => ({ code: 1, stdout: "", stderr: "" }), now: () => NOW, sleep: () => {}, stdin: () => "" };
    expect(run(args, { cwd, today: "2026-10-28", out: (l) => out.push(l), err: () => {} }, deps, { judge: fakeJudge().judge, userSettings: "", sessionId: () => null })).toBe(0);
    return out;
  }

  test("afk-guard diffs from where the branch meets its advanced base, so a merged base raises nothing", () => {
    const cwd = tempDir();
    git(cwd, "init", "-q", "-b", "main");
    commit(cwd, { "package.json": JSON.stringify({ dependencies: { zod: "1" } }, null, 2) }, "init");
    fbs(cwd, "status", "init", "x", "--size", "tiny");
    fbs(cwd, "branch", "x", "--type", "feature");
    const { judge } = fakeJudge();
    expect(start(cwd, judge, spec([{ id: "tests", kind: "command", run: "test -f src/pass.txt" }], { scope: ["src/**"] })).json().baseRef).toBe("refs/heads/main");
    commit(cwd, { "src/pass.txt": "ok" });
    expect(check(cwd, judge).json()).toMatchObject({ met: true });
    git(cwd, "checkout", "-q", "main");
    commit(cwd, { "package.json": JSON.stringify({ dependencies: { zod: "1", lodash: "4" } }, null, 2), "docs/other.md": "x" }, "base moves on");
    git(cwd, "checkout", "-q", "feature/x");
    git(cwd, "-c", "user.name=fbs", "-c", "user.email=fbs@example.com", "merge", "-q", "--no-edit", "main");
    expect(final(cwd, judge).json()).toMatchObject({ met: true, flags: [] });
    commit(cwd, { "package.json": JSON.stringify({ dependencies: { zod: "1", lodash: "4", "left-pad": "1" } }, null, 2) });
    const flagged = final(cwd, judge).json() as { met: boolean; flags: { kind: string; path: string; detail: string }[] };
    expect(flagged.met).toBe(false);
    expect(flagged.flags.map((f) => `${f.kind} ${f.path} ${f.detail}`)).toEqual(["out-of-scope package.json outside the run's scope", "dependency package.json adds the dependency left-pad"]);
  });

  test("without a feature record the base is unknown and afk-guard diffs from the start", () => {
    const cwd = repo({});
    expect(start(cwd, fakeJudge().judge, spec([PASS_FILE])).json().baseRef).toBeNull();
  });
});

function final(cwd: string, judge: JudgeRunner): Cli {
  return afk(cwd, judge, ["final", "x"]);
}

describe("a judge error holds the step", () => {
  const timedOut = { pass: false, criteria: [], costUsd: 0.01, error: "the judge timed out" };

  test("the step is held: no keep, discard or reset, and the same HEAD can be checked again", () => {
    const cwd = repo({ "pass.txt": "ok" });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE, JUDGED]));
    const sha = commit(cwd, { "judge.txt": "c1 c2" });
    const r = check(cwd, () => timedOut).json();
    expect(r).toMatchObject({ iteration: 1, sha, decision: "held", met: false, stop: null, judgeError: "the judge timed out" });
    expect(head(cwd)).toBe(sha);
    expect(runJson(cwd)).toMatchObject({ status: "running", iteration: 0, lastChecked: null, discardsInRow: 0, judgeErrorsInRow: 1 });
    expect(logRows(cwd)[2].slice(1, 6)).toEqual(["check", "1", sha, logRows(cwd)[2][4], "held"]);
    const retry = check(cwd, judge).json();
    expect(retry).toMatchObject({ iteration: 1, sha, decision: "kept", met: true, judgeError: null });
    expect(runJson(cwd)).toMatchObject({ iteration: 1, judgeErrorsInRow: 0 });
  });

  test("an error on the second vote holds the step too", () => {
    const cwd = repo({ "pass.txt": "ok" });
    let call = 0;
    const { judge } = fakeJudge();
    const second: JudgeRunner = (input) => (++call === 3 ? timedOut : judge(input));
    start(cwd, second, spec([PASS_FILE, JUDGED]));
    commit(cwd, { "judge.txt": "c1 c2" });
    expect(check(cwd, second).json()).toMatchObject({ decision: "held", met: false, judgeError: "the judge timed out" });
  });

  test("three judge errors in a row stop the run with judge-error, keeping the step; a verdict resets the count", () => {
    const cwd = repo({ "pass.txt": "ok" });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE, JUDGED]));
    commit(cwd, { "src/a.ts": "1" });
    check(cwd, () => timedOut);
    check(cwd, () => timedOut);
    expect(check(cwd, judge).json()).toMatchObject({ decision: "discarded" });
    expect(runJson(cwd).judgeErrorsInRow).toBe(0);
    const sha = commit(cwd, { "src/a.ts": "2" });
    check(cwd, () => timedOut);
    check(cwd, () => timedOut);
    const last = { ...timedOut, error: "claude exited 1: over budget" };
    const r = check(cwd, () => last).json();
    expect(r).toMatchObject({ decision: "held", stop: { rule: "judge-error", why: "3 judge errors in a row; the last: claude exited 1: over budget" } });
    expect(head(cwd)).toBe(sha);
    expect(runJson(cwd)).toMatchObject({ status: "stopped", stop: { rule: "judge-error" }, judgeErrorsInRow: 3 });
  });

  test("in fbs afk final, a judge error makes it not met and names the error, with nothing reset", () => {
    const cwd = repo({ "pass.txt": "ok" });
    const { judge } = fakeJudge();
    start(cwd, judge, spec([PASS_FILE, JUDGED]));
    commit(cwd, { "judge.txt": "c1 c2" });
    check(cwd, judge);
    const sha = commit(cwd, { "src/fix.ts": "x" });
    const report = final(cwd, () => timedOut).json();
    expect(report).toMatchObject({ sha, met: false, judgeError: "the judge timed out" });
    expect(head(cwd)).toBe(sha);
    expect(readFileSync(report.evidence as string, "utf8")).toContain("final error (the judge timed out)");
    expect(logRows(cwd).at(-1)?.[7]).toContain("judge error: the judge timed out");
    expect(runJson(cwd).status).toBe("met");
  });
});
