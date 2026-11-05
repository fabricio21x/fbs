import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afkGuard, type Flag } from "./afk-guard";
import { type CommandOutput, type Criterion, JUDGE_OUTPUT_CHARS, type JudgeRunner, type JudgeVerdict, rubricCriteria, runClaudeJudge } from "./afk-judge";
import { CONFIG_PATH, configAt, type FbsConfig, loadConfig } from "./config";
import { commitOf, commitTree, currentBranch, envWithoutRepoOverrides, gitCommonDir, headTree, isIgnored, mainWorktree, mergeBase, repoRoot, resetHard, trackedFiles, uncommittedFiles, untrackedNotIgnored } from "./git";
import { afkRunsIn, isSlug } from "./guard";
import { readFeature, recordPath } from "./status";

export type AfkErrorCode = "bad-slug" | "bad-spec" | "missing" | "exists" | "running" | "not-running" | "not-met" | "dirty" | "no-step" | "bad-branch" | "locked" | "state-changed";

export class AfkError extends Error {
  readonly code: AfkErrorCode;

  constructor(code: AfkErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

export interface Metric {
  /** A regex whose first capture group is the number; the last match on stdout counts. */
  pattern: string;
  target: number;
  /** "min": the value must reach at least the target; "max": at most. */
  direction: "min" | "max";
}

export type Check = { id: string; kind: "command"; run: string; metric: Metric | null } | { id: string; kind: "judged"; rubric: string[] };
type JudgedCheck = Extract<Check, { kind: "judged" }>;

export interface Budgets {
  maxIterations: number;
  maxDiscardsInRow: number;
  checkTimeoutSec: number;
  judgeUsdPerCall: number;
}

export interface Spec {
  goal: string;
  checks: Check[];
  scope: string[];
  protect: string[];
  budgets: Budgets;
  /** Tests that failed before the run, for verify; the checks ignore it. */
  testBaseline: string[];
}

export type CheckResult =
  | { id: string; kind: "command"; pass: boolean; exit: number | null; value: number | null; error: string | null; tail: string }
  | {
      id: string;
      kind: "judged";
      pass: boolean;
      /** Not judged because a command check failed. */
      skipped: boolean;
      criteria: Criterion[];
      /** The second, independent vote on a tree where everything else passes; null when not asked. */
      second: boolean | null;
      costUsd: number;
      error: string | null;
    };
type JudgedResult = Extract<CheckResult, { kind: "judged" }>;

export type StopRule = "met" | "max-iterations" | "discards-in-row" | "protected-changed" | "guard-flag" | "judge-error" | "state-changed" | "agent";

export interface Run extends Spec {
  slug: string;
  /** The guard holds a running or met run; `fbs land` marks a met one landed. */
  status: "running" | "met" | "stopped" | "landed";
  sessionId: string | null;
  worktree: string;
  branch: string;
  /** The ref of the branch's parent from its feature record; afk-guard diffs from where HEAD meets it once it's merged in. */
  baseRef?: string | null;
  start: { sha: string; at: string; results: CheckResult[] };
  /** sha256 of each tracked file `protect` matched at the start, by repo-relative path: the files the run may not change. */
  protected: Record<string, string>;
  /** `.fbs/config.json` as it was at the start when git ignores it, so no commit holds it; the guard goes by this copy. */
  config?: FbsConfig;
  /** The state a discarded step is reset to; `met` when every check passed there, judged ones on both votes. */
  kept: { sha: string; results: CheckResult[]; met: boolean };
  lastChecked: string | null;
  iteration: number;
  discardsInRow: number;
  /** Checks held in a row because a judge call failed; older records lack it. */
  judgeErrorsInRow?: number;
  judgeCostUsd: number;
  stop: { rule: StopRule; why: string } | null;
  /** The last `fbs afk final` measurement of a met run. */
  final?: FinalMeasure;
}

/** A met run's tree measured again after the final review, without keep, discard or reset. */
export interface FinalMeasure {
  sha: string;
  results: CheckResult[];
  /** Every check passed, judged ones on both votes, and afk-guard raised no flag. */
  met: boolean;
  flags: Flag[];
}

/** What afk touches outside the repo; tests pass fakes. */
export interface AfkDeps {
  judge: JudgeRunner;
  /** The user's Claude settings file, read by the preflight. */
  userSettings: string;
  /** The Claude Code session running this command, which the Stop hook binds the run to; null outside one. */
  sessionId: () => string | null;
}

export const REAL_AFK_DEPS: AfkDeps = { judge: runClaudeJudge, userSettings: join(homedir(), ".claude", "settings.json"), sessionId: () => process.env.CLAUDE_CODE_SESSION_ID || null };

export const DEFAULT_BUDGETS: Budgets = { maxIterations: 30, maxDiscardsInRow: 5, checkTimeoutSec: 600, judgeUsdPerCall: 0.5 };

const LOG_HEADER = ["ts", "kind", "iteration", "sha", "results", "decision", "cost", "note"].join("\t");
const TAIL_CHARS = 600;
const LOCK_MARGIN_MS = 60_000;
const MAX_JUDGE_ERRORS_IN_ROW = 3;

function afkRoot(commonDir: string): string {
  return join(commonDir, "fbs", "afk");
}

export function afkDir(commonDir: string, slug: string): string {
  return join(afkRoot(commonDir), slug);
}

function runPath(commonDir: string, slug: string): string {
  return join(afkDir(commonDir, slug), "run.json");
}

function checkSlug(slug: string): void {
  if (!isSlug(slug)) throw new AfkError("bad-slug", `${JSON.stringify(slug)} must be lowercase words joined by single hyphens`);
}

// ---- The spec, validated once here.

export function parseSpec(raw: unknown): Spec {
  const bad = (detail: string): never => {
    throw new AfkError("bad-spec", detail);
  };
  if (!isObject(raw)) bad("the spec must be a JSON object");
  const spec = raw as Record<string, unknown>;
  onlyKeys(spec, ["goal", "checks", "scope", "protect", "budgets", "testBaseline"], "the spec", bad);
  if (typeof spec.goal !== "string" || spec.goal.trim() === "") bad("goal must be a non-empty string");
  if (!Array.isArray(spec.checks) || spec.checks.length === 0) bad("checks must be a non-empty list");
  const checks = (spec.checks as unknown[]).map((c, i) => parseCheck(c, i, bad));
  const ids = checks.map((c) => c.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) bad(`check id ${duplicate} is used twice`);
  const scope = globList(spec.scope, "scope", bad);
  if (scope.length === 0) bad("scope must name at least one glob");
  const baseline = spec.testBaseline ?? [];
  if (!Array.isArray(baseline) || !baseline.every((t) => typeof t === "string" && t.trim() !== "")) bad("testBaseline must be a list of test names");
  const protect = spec.protect === undefined ? [] : globList(spec.protect, "protect", bad);
  return { goal: spec.goal as string, checks, scope, protect, budgets: parseBudgets(spec.budgets, bad), testBaseline: baseline as string[] };
}

function parseCheck(raw: unknown, i: number, bad: (detail: string) => never): Check {
  if (!isObject(raw)) bad(`checks[${i}] must be an object`);
  const c = raw as Record<string, unknown>;
  const where = `checks[${i}]`;
  if (typeof c.id !== "string" || !isSlug(c.id)) bad(`${where}.id must be lowercase words joined by single hyphens`);
  const id = c.id as string;
  if (c.kind === "judged") {
    onlyKeys(c, ["id", "kind", "rubric"], where, bad);
    if (!Array.isArray(c.rubric) || c.rubric.length === 0 || !c.rubric.every((r) => typeof r === "string" && r.trim() !== "")) bad(`${where}.rubric must be a non-empty list of criteria`);
    return { id, kind: "judged", rubric: c.rubric as string[] };
  }
  if (c.kind !== "command") return bad(`${where}.kind must be "command" or "judged"`);
  onlyKeys(c, ["id", "kind", "run", "metric", "target", "direction"], where, bad);
  if (typeof c.run !== "string" || c.run.trim() === "") bad(`${where}.run must be a non-empty command`);
  if (c.metric === undefined) {
    if (c.target !== undefined || c.direction !== undefined) bad(`${where} has a target or direction without a metric`);
    return { id, kind: "command", run: c.run as string, metric: null };
  }
  if (typeof c.metric !== "string" || captureGroups(c.metric) < 1) bad(`${where}.metric must be a regex with a capture group`);
  if (typeof c.target !== "number" || !Number.isFinite(c.target)) bad(`${where}.target must be a number`);
  if (c.direction !== "min" && c.direction !== "max") bad(`${where}.direction must be "min" or "max"`);
  return { id, kind: "command", run: c.run as string, metric: { pattern: c.metric as string, target: c.target as number, direction: c.direction as "min" | "max" } };
}

function captureGroups(pattern: string): number {
  try {
    return (new RegExp(`${pattern}|`).exec("")?.length ?? 1) - 1;
  } catch {
    return 0;
  }
}

function globList(raw: unknown, name: string, bad: (detail: string) => never): string[] {
  if (!Array.isArray(raw) || !raw.every((g) => typeof g === "string" && g.trim() !== "")) return bad(`${name} must be a list of globs`);
  return raw as string[];
}

function parseBudgets(raw: unknown, bad: (detail: string) => never): Budgets {
  if (raw === undefined) return { ...DEFAULT_BUDGETS };
  if (!isObject(raw)) bad("budgets must be an object");
  const b = raw as Record<string, unknown>;
  onlyKeys(b, Object.keys(DEFAULT_BUDGETS), "budgets", bad);
  const budgets = { ...DEFAULT_BUDGETS };
  for (const key of Object.keys(DEFAULT_BUDGETS) as (keyof Budgets)[]) {
    const value = b[key];
    if (value === undefined) continue;
    const ok = key === "judgeUsdPerCall" ? typeof value === "number" && value > 0 : Number.isInteger(value) && (value as number) >= 1;
    if (!ok) bad(`budgets.${key} must be ${key === "judgeUsdPerCall" ? "a positive number" : "a positive whole number"}`);
    budgets[key] = value as number;
  }
  return budgets;
}

function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string, bad: (detail: string) => never): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0) bad(`${where} has unknown keys: ${extra.join(", ")}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- The run record.

export function readRun(cwd: string, slug: string): Run {
  checkSlug(slug);
  const path = runPath(gitCommonDir(cwd), slug);
  if (!existsSync(path)) throw new AfkError("missing", `no afk run ${slug}`);
  return JSON.parse(readFileSync(path, "utf8")) as Run;
}

function writeRun(commonDir: string, run: Run): void {
  const path = runPath(commonDir, run.slug);
  const temp = `${path}.${process.pid}.tmp`;
  // Two-space indent: bin/fbs-guard and bin/fbs-afk-stop grep for the top-level `  "status": …` line.
  writeFileSync(temp, `${JSON.stringify(run, null, 2)}\n`);
  renameSync(temp, path);
}

function appendLog(commonDir: string, slug: string, row: { ts: string; kind: string; iteration: number; sha: string; results: CheckResult[] | null; decision: string; cost: number; note: string }): void {
  const results = row.results === null ? "" : JSON.stringify(row.results, (key, value) => (key === "tail" ? undefined : value));
  const cells = [row.ts, row.kind, String(row.iteration), row.sha, results, row.decision, row.cost === 0 ? "" : row.cost.toFixed(4), row.note.replace(/[\t\r\n]+/g, " ")];
  appendFileSync(join(afkDir(commonDir, slug), "log.tsv"), `${cells.join("\t")}\n`);
}

/** Write the run and its log row, then seal the run dir's digest so the next command sees any write made in between. */
function record(commonDir: string, run: Run, row: Parameters<typeof appendLog>[2]): void {
  writeRun(commonDir, run);
  appendLog(commonDir, run.slug, row);
  sealState(commonDir, run.slug);
}

/** Record the run dir's digest as the state the next afk command must find. */
export function sealState(commonDir: string, slug: string): void {
  writeFileSync(sealPath(commonDir, slug), stateDigest(commonDir, slug));
}

function sealPath(commonDir: string, slug: string): string {
  return join(afkRoot(commonDir), `${slug}.seal`);
}

function stateDigest(commonDir: string, slug: string): string {
  return sha256(JSON.stringify(dirHashes(afkDir(commonDir, slug))));
}

function isSealed(commonDir: string, slug: string): boolean {
  try {
    return readFileSync(sealPath(commonDir, slug), "utf8") === stateDigest(commonDir, slug);
  } catch {
    return false;
  }
}

function readLog(commonDir: string, slug: string): Record<string, string>[] {
  const path = join(afkDir(commonDir, slug), "log.tsv");
  if (!existsSync(path)) return [];
  const [header, ...lines] = readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
  const keys = header.split("\t");
  return lines.map((line) => Object.fromEntries(line.split("\t").map((cell, i) => [keys[i], cell])));
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** sha256 of each tracked file that `matches`, by repo-relative path. */
function protectedHashes(worktree: string, matches: (path: string) => boolean): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const path of trackedFiles(worktree).sort()) {
    if (!matches(path)) continue;
    const full = join(worktree, path);
    hashes[path] = existsSync(full) ? sha256(readFileSync(full)) : "missing";
  }
  return hashes;
}

/** The files protected at the start that changed or are gone; a file added since isn't protected. */
function changedProtected(worktree: string, before: Record<string, string>): string[] {
  const after = protectedHashes(worktree, (path) => Object.hasOwn(before, path));
  return Object.keys(before)
    .sort()
    .filter((p) => before[p] !== after[p])
    .map((p) => (after[p] === undefined ? `${p} (removed)` : `${p} (changed)`));
}

/** sha256 of every file under `dir`, by relative path. */
function dirHashes(dir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  if (!existsSync(dir)) return hashes;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    hashes[full.slice(dir.length + 1)] = sha256(readFileSync(full));
  }
  return hashes;
}

/** Changed, staged or untracked files, including untracked ones hidden only by `.git/info/exclude`. */
function strayFiles(worktree: string): string[] {
  return [...new Set([...uncommittedFiles(worktree), ...untrackedNotIgnored(worktree)])].sort();
}

function listed(paths: string[]): string {
  return paths.length > 10 ? `${paths.slice(0, 10).join(", ")} and ${paths.length - 10} more` : paths.join(", ");
}

// ---- The lock: one afk command per run at a time.

function isAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Run `body` holding `<slug>.lock`, beside the run dir. A dead holder's lock is taken over at once, a live one's only
 * after `staleMs`; the lock is released only while it is still this call's.
 */
function withLock<T>(commonDir: string, slug: string, staleMs: number, now: number, body: () => T): T {
  const path = join(afkRoot(commonDir), `${slug}.lock`);
  mkdirSync(afkRoot(commonDir), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let holder: { pid?: unknown; at?: unknown } = {};
    try {
      holder = JSON.parse(readFileSync(path, "utf8"));
    } catch {}
    const at = typeof holder.at === "number" ? holder.at : now;
    if (isAlive(holder.pid) && now - at <= staleMs) throw new AfkError("locked", `another afk command (pid ${String(holder.pid)}) is working on ${slug}; wait for it to finish`);
    rmSync(path, { force: true });
    try {
      fd = openSync(path, "wx");
    } catch {
      throw new AfkError("locked", `another afk command took over ${slug}'s stale lock`);
    }
  }
  const mine = JSON.stringify({ pid: process.pid, at: now, nonce: randomBytes(8).toString("hex") });
  writeSync(fd, mine);
  closeSync(fd);
  try {
    return body();
  } finally {
    try {
      if (readFileSync(path, "utf8") === mine) rmSync(path, { force: true });
    } catch {}
  }
}

/** The longest a check may take: each command and each of two judge votes per judged check, at the timeout. */
function staleAfter(spec: Spec): number {
  const calls = spec.checks.reduce((n, c) => n + (c.kind === "judged" ? 2 : 1), 0);
  return calls * spec.budgets.checkTimeoutSec * 1000 + LOCK_MARGIN_MS;
}

// ---- Running the checks.

interface Ran {
  results: CheckResult[];
  cost: number;
  /** Every command check passed and every judged check passed on both votes. */
  met: boolean;
}

/** Run every command check in `worktree`, each in its own process group. */
function runCommands(commonDir: string, slug: string, spec: Spec, worktree: string): { results: Map<string, CheckResult>; outputs: CommandOutput[] } {
  mkdirSync(afkRoot(commonDir), { recursive: true });
  const outDir = mkdtempSync(join(afkRoot(commonDir), `${slug}.out-`));
  const results = new Map<string, CheckResult>();
  const outputs: CommandOutput[] = [];
  try {
    for (const check of spec.checks) {
      if (check.kind !== "command") continue;
      const { result, output } = runCommand(check, worktree, spec.budgets.checkTimeoutSec, outDir);
      results.set(check.id, result);
      outputs.push(output);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  return { results, outputs };
}

function runCommand(check: Extract<Check, { kind: "command" }>, cwd: string, timeoutSec: number, outDir: string): { result: CheckResult; output: CommandOutput } {
  const stdoutPath = join(outDir, `${check.id}.out`);
  const stderrPath = join(outDir, `${check.id}.err`);
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  let exit: number | null = null;
  let error: string | null = null;
  try {
    // Files, not pipes, so a server the command leaves behind can't hold the call open; detached gives it its own process group.
    const proc = Bun.spawnSync(["sh", "-c", check.run], { cwd, env: envWithoutRepoOverrides(), stdin: "ignore", stdout: stdoutFd, stderr: stderrFd, timeout: timeoutSec * 1000, detached: true });
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
    exit = proc.exitCode;
    if (exit === null) error = proc.exitedDueToTimeout ? `timed out after ${timeoutSec}s` : `killed by ${proc.signalCode ?? "a signal"}`;
  } catch (e) {
    error = `cannot run: ${(e as Error).message}`;
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  const stdout = readFileSync(stdoutPath, "utf8");
  const output = `${stdout}${readFileSync(stderrPath, "utf8")}`;
  let value: number | null = null;
  let pass = error === null && exit === 0;
  if (check.metric !== null && error === null) {
    const matches = [...stdout.matchAll(new RegExp(check.metric.pattern, "gm"))];
    const group = matches.at(-1)?.[1];
    const parsed = group === undefined ? Number.NaN : Number.parseFloat(group);
    if (Number.isNaN(parsed)) error = `no number matched ${check.metric.pattern} on stdout${exit === 0 ? "" : ` (exit ${exit})`}`;
    else value = parsed;
    pass = value !== null && (check.metric.direction === "min" ? value >= check.metric.target : value <= check.metric.target);
  }
  return { result: { id: check.id, kind: "command", pass, exit, value, error, tail: output.slice(-TAIL_CHARS) }, output: { id: check.id, run: check.run, exit, output: output.slice(-JUDGE_OUTPUT_CHARS) } };
}

interface RecordedVerdict extends JudgeVerdict {
  /** sha256 of the rubric the verdict answers. */
  rubric: string;
}

function rubricHash(rubric: string[]): string {
  return sha256(JSON.stringify(rubric));
}

function verdictPath(commonDir: string, slug: string, checkId: string, tree: string, vote: 1 | 2): string {
  return join(afkDir(commonDir, slug), "verdicts", `${checkId}-${tree}-${vote}.json`);
}

/** The recorded verdicts for `tree`, read before any command runs and kept only when they answer this rubric in shape. */
function recordedVerdicts(commonDir: string, slug: string, checks: JudgedCheck[], tree: string): Map<string, JudgeVerdict> {
  const verdicts = new Map<string, JudgeVerdict>();
  for (const check of checks) {
    for (const vote of [1, 2] as const) {
      let raw: Partial<RecordedVerdict>;
      try {
        raw = JSON.parse(readFileSync(verdictPath(commonDir, slug, check.id, tree, vote), "utf8"));
      } catch {
        continue;
      }
      const criteria = rubricCriteria(raw.criteria, check.rubric);
      if (raw.rubric !== rubricHash(check.rubric) || criteria === null || raw.pass !== criteria.every((c) => c.pass)) continue;
      verdicts.set(`${check.id}-${vote}`, { pass: raw.pass, criteria, costUsd: 0, error: null });
    }
  }
  return verdicts;
}

/** Judge every judged check: vote 1 when the commands pass (always at the baseline), vote 2 when everything passes on vote 1. */
function runJudged(commonDir: string, slug: string, spec: Spec, worktree: string, tree: string, commands: ReturnType<typeof runCommands>, recorded: Map<string, JudgeVerdict>, deps: AfkDeps, baseline: boolean, left: string[]): { results: Map<string, CheckResult>; cost: number } {
  const judged = spec.checks.filter((c): c is JudgedCheck => c.kind === "judged");
  const commandsPass = [...commands.results.values()].every((r) => r.pass);
  const results = new Map<string, JudgedResult>();
  const vote = (check: JudgedCheck, n: 1 | 2): { verdict: JudgeVerdict; spent: number } => {
    const known = recorded.get(`${check.id}-${n}`);
    if (known !== undefined) return { verdict: known, spent: 0 };
    const verdict = deps.judge({ cwd: worktree, goal: spec.goal, rubric: check.rubric, commandOutputs: commands.outputs, budgetUsd: spec.budgets.judgeUsdPerCall, timeoutSec: spec.budgets.checkTimeoutSec });
    // A failed call is not a verdict, so it isn't recorded.
    if (verdict.error === null) {
      const path = verdictPath(commonDir, slug, check.id, tree, n);
      mkdirSync(join(path, ".."), { recursive: true });
      const record: RecordedVerdict = { ...verdict, rubric: rubricHash(check.rubric) };
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
      // Sealed at once, so a crash before the command records its row doesn't read as tampering later.
      sealState(commonDir, slug);
    }
    return { verdict, spent: verdict.costUsd };
  };
  for (const check of judged) {
    if (!commandsPass && !baseline) {
      results.set(check.id, { id: check.id, kind: "judged", pass: false, skipped: true, criteria: [], second: null, costUsd: 0, error: null });
      continue;
    }
    // The judge reads the work tree, so files outside the commit would be judged under the commit's tree.
    if (left.length > 0) {
      results.set(check.id, { id: check.id, kind: "judged", pass: false, skipped: false, criteria: [], second: null, costUsd: 0, error: `the check commands left files: ${listed(left)}` });
      continue;
    }
    const { verdict, spent } = vote(check, 1);
    results.set(check.id, { id: check.id, kind: "judged", pass: verdict.pass, skipped: false, criteria: verdict.criteria, second: null, costUsd: spent, error: verdict.error });
  }
  if (commandsPass && !baseline && [...results.values()].every((r) => r.pass)) {
    for (const check of judged) {
      const first = results.get(check.id) as JudgedResult;
      const { verdict, spent } = vote(check, 2);
      results.set(check.id, { ...first, second: verdict.pass, costUsd: first.costUsd + spent, error: first.error ?? verdict.error });
    }
  }
  const cost = [...results.values()].reduce((sum, r) => sum + r.costUsd, 0);
  return { results, cost };
}

function combine(spec: Spec, commands: Map<string, CheckResult>, judged: Map<string, CheckResult>, cost: number, baseline: boolean): Ran {
  const results = spec.checks.map((c) => (commands.get(c.id) ?? judged.get(c.id)) as CheckResult);
  const met = !baseline && results.every((r) => r.pass && (r.kind === "command" || r.second === true));
  return { results, cost, met };
}

// ---- Keep or discard.

/** Higher is better; null when the check wasn't judged and can't be compared. A passing second vote counts one more. */
function score(check: Check, result: CheckResult): number | null {
  if (result.kind === "judged") return result.skipped ? null : result.criteria.filter((c) => c.pass).length + (result.second === true ? 1 : 0);
  if (check.kind !== "command" || check.metric === null) return result.pass ? 1 : 0;
  if (result.value === null) return Number.NEGATIVE_INFINITY;
  const { target, direction } = check.metric;
  return -Math.max(0, direction === "min" ? target - result.value : result.value - target);
}

/** Which checks moved toward their target and which moved away, from `before` to `after`. */
export function compare(checks: Check[], before: CheckResult[], after: CheckResult[]): { improved: string[]; regressed: string[] } {
  const improved: string[] = [];
  const regressed: string[] = [];
  for (const check of checks) {
    const a = before.find((r) => r.id === check.id);
    const b = after.find((r) => r.id === check.id);
    const from = a === undefined ? null : score(check, a);
    const to = b === undefined ? null : score(check, b);
    if (from === null || to === null || from === to) continue;
    (to > from ? improved : regressed).push(check.id);
  }
  return { improved, regressed };
}

// ---- Commands.

export interface StartOptions {
  spec: Spec;
  sessionId: string | null;
  /** Archive a finished run of this slug and start over. */
  restart: boolean;
}

export function startRun(cwd: string, slug: string, options: StartOptions, deps: AfkDeps, now: number): Run {
  checkSlug(slug);
  const worktree = repoRoot(cwd);
  const commonDir = gitCommonDir(cwd);
  const { spec } = options;
  return withLock(commonDir, slug, staleAfter(spec), now, () => {
    const dir = afkDir(commonDir, slug);
    if (existsSync(runPath(commonDir, slug))) {
      const old = JSON.parse(readFileSync(runPath(commonDir, slug), "utf8")) as Run;
      if (old.status === "running") throw new AfkError("running", `afk run ${slug} is already running`);
      if (!options.restart) throw new AfkError("exists", `afk run ${slug} finished (${old.status}); pass --restart to archive it and start over`);
      renameSync(dir, join(afkRoot(commonDir), `${slug}.${new Date(now).toISOString().replace(/[:.]/g, "-")}`));
    }
    const stray = strayFiles(worktree);
    if (stray.length > 0) throw new AfkError("dirty", `${worktree} has uncommitted or untracked files (${listed(stray)}); commit, remove or .gitignore them first`);
    const branch = currentBranch(worktree);
    if (branch === null) throw new AfkError("bad-branch", `${worktree} is on a detached HEAD; an afk run works on a branch`);
    const sha = commitOf(worktree, "HEAD");
    if (sha === null) throw new AfkError("no-step", `${worktree} has no commit to start from`);

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const commands = runCommands(commonDir, slug, spec, worktree);
    const wrote = strayFiles(worktree);
    const planted = Object.keys(dirHashes(dir));
    if (wrote.length > 0 || planted.length > 0) {
      rmSync(dir, { recursive: true, force: true });
      if (planted.length > 0) throw new AfkError("dirty", `the check commands wrote into the afk run's own files (${listed(planted)})`);
      throw new AfkError("dirty", `the check commands wrote ${listed(wrote)}; ignore them in .gitignore or write outside the repo, then start again`);
    }
    const judged = runJudged(commonDir, slug, spec, worktree, headTree(worktree), commands, new Map(), deps, true, []);
    const baseline = combine(spec, commands.results, judged.results, judged.cost, true);
    const at = new Date(now).toISOString();
    const run: Run = {
      slug,
      status: "running",
      sessionId: options.sessionId,
      ...spec,
      worktree,
      branch,
      baseRef: parentRef(cwd, worktree, slug, branch),
      start: { sha, at, results: baseline.results },
      protected: protectedHashes(worktree, (path) => spec.protect.some((glob) => new Bun.Glob(glob).match(path))),
      ...(isIgnored(worktree, CONFIG_PATH) && { config: loadConfig(mainWorktree(worktree)) }),
      kept: { sha, results: baseline.results, met: false },
      lastChecked: null,
      iteration: 0,
      discardsInRow: 0,
      judgeErrorsInRow: 0,
      judgeCostUsd: baseline.cost,
      stop: null,
    };
    writeFileSync(join(dir, "log.tsv"), `${LOG_HEADER}\n`);
    record(commonDir, run, { ts: at, kind: "start", iteration: 0, sha, results: baseline.results, decision: "baseline", cost: baseline.cost, note: "start" });
    return run;
  });
}

export interface CheckReport {
  iteration: number;
  sha: string;
  results: CheckResult[];
  /** `held`: a judge call failed, so the step is neither kept nor discarded and the same HEAD can be checked again. */
  decision: "kept" | "discarded" | "held" | "stopped";
  met: boolean;
  stop: Run["stop"];
  /** Set when the check commands left files in the tree, which the next check would refuse. */
  warning: string | null;
  /** afk-guard's flags on the run's diff; any flag stops the run. */
  flags: Flag[];
  /** The failed judge call that held the step. */
  judgeError: string | null;
}

/** Run `body` on the run `slug` when its status is one of `statuses`, holding its lock. */
function withRunningRun<T>(cwd: string, slug: string, now: number, statuses: Run["status"][], body: (run: Run, commonDir: string) => T): T {
  const commonDir = gitCommonDir(cwd);
  return withLock(commonDir, slug, staleAfter(readRun(cwd, slug)), now, () => {
    const run = readRun(cwd, slug);
    if (!statuses.includes(run.status)) throw new AfkError("not-running", `afk run ${slug} is ${run.status}`);
    return body(run, commonDir);
  });
}

/** Run the recorded checks on HEAD, the agent's committed step, keep or discard it, and apply the stop rules. */
export function checkStep(cwd: string, slug: string, deps: AfkDeps, now: number): CheckReport {
  return withRunningRun(cwd, slug, now, ["running"], (run, commonDir) => {
    const worktree = run.worktree;
    const branch = currentBranch(worktree);
    if (branch !== run.branch) throw new AfkError("bad-branch", `${worktree} is on ${branch ?? "a detached HEAD"}, not the run's branch ${run.branch}`);
    const stray = strayFiles(worktree);
    if (stray.length > 0) throw new AfkError("dirty", `${worktree} has uncommitted or untracked files (${listed(stray)}); commit the step, or remove or .gitignore them`);
    const sha = commitOf(worktree, "HEAD") as string;
    if (sha === run.lastChecked || sha === run.kept.sha) throw new AfkError("no-step", `HEAD ${sha.slice(0, 12)} was checked already; commit the next step first`);
    if (mergeBase(worktree, run.kept.sha, sha) !== run.kept.sha) throw new AfkError("bad-branch", `HEAD ${sha.slice(0, 12)} doesn't build on the last kept commit ${run.kept.sha.slice(0, 12)}`);
    const tree = headTree(worktree);
    const judgeFailed = run.kept.results.some((r) => r.kind === "judged" && r.error !== null);
    if (tree === commitTree(worktree, run.kept.sha) && !judgeFailed) throw new AfkError("no-step", `HEAD ${sha.slice(0, 12)} changes nothing since the last kept commit; an empty commit is not a step`);
    const ts = new Date(now).toISOString();
    const iteration = run.iteration + 1;
    const stopNow = (rule: StopRule, why: string, flags: Flag[] = []): CheckReport => {
      const stop = { rule, why };
      record(commonDir, { ...run, status: "stopped", stop, iteration, lastChecked: sha }, { ts, kind: "check", iteration, sha, results: [], decision: "stopped", cost: 0, note: why });
      return { iteration, sha, results: [], decision: "stopped", met: false, stop, warning: null, flags, judgeError: null };
    };

    if (!isSealed(commonDir, slug)) return stopNow("state-changed", "the afk run's files changed since the last afk command");

    const changed = changedProtected(worktree, run.protected);
    if (changed.length > 0) return stopNow("protected-changed", `protected files changed: ${changed.join(", ")}`);

    // Before any command runs, and without a reset, so the flagged diff stays for the human.
    const { flags } = guardRun(run);
    if (flags.length > 0) return stopNow("guard-flag", `afk-guard flagged: ${flagList(flags)}`, flags);

    // Snapshot the run's state before any command runs: the commands run the agent's code, which could plant verdicts.
    const judgedChecks = run.checks.filter((c): c is JudgedCheck => c.kind === "judged");
    const recorded = recordedVerdicts(commonDir, slug, judgedChecks, tree);
    const state = JSON.stringify(dirHashes(afkDir(commonDir, slug)));
    const commands = runCommands(commonDir, slug, run, worktree);
    if (JSON.stringify(dirHashes(afkDir(commonDir, slug))) !== state) return stopNow("state-changed", "the check commands changed the afk run's own files");
    const wrote = strayFiles(worktree);
    const judged = runJudged(commonDir, slug, run, worktree, tree, commands, recorded, deps, false, wrote);
    const ran = combine(run, commands.results, judged.results, judged.cost, false);
    const warning = wrote.length > 0 ? `the check commands wrote ${listed(wrote)}; ignore them in .gitignore or write outside the repo` : null;

    const judgeError = wrote.length === 0 ? judgeErrorOf(ran.results) : null;
    if (judgeError !== null) {
      // Not a verdict, so the step isn't scored: nothing is kept, discarded or reset, and the same HEAD may be checked again.
      const errors = (run.judgeErrorsInRow ?? 0) + 1;
      const stop: Run["stop"] = errors >= MAX_JUDGE_ERRORS_IN_ROW ? { rule: "judge-error", why: `${errors} judge errors in a row; the last: ${judgeError}` } : null;
      record(
        commonDir,
        { ...run, status: stop === null ? "running" : "stopped", stop, judgeErrorsInRow: errors, judgeCostUsd: run.judgeCostUsd + ran.cost },
        { ts, kind: "check", iteration, sha, results: ran.results, decision: "held", cost: ran.cost, note: `judge error: ${judgeError}${stop === null ? "" : `; stop: ${stop.rule}`}` },
      );
      return { iteration, sha, results: ran.results, decision: "held", met: false, stop, warning, flags: [], judgeError };
    }

    const { improved, regressed } = compare(run.checks, run.kept.results, ran.results);
    const keep = regressed.length === 0 && improved.length > 0;
    const note = [improved.length > 0 && `improved: ${improved.join(", ")}`, regressed.length > 0 && `regressed: ${regressed.join(", ")}`].filter(Boolean).join("; ") || "no check moved";
    const kept = keep ? { sha, results: ran.results, met: ran.met } : run.kept;
    const discardsInRow = keep ? 0 : run.discardsInRow + 1;

    let stop: Run["stop"] = null;
    if (kept.met) stop = { rule: "met", why: `every check passes at ${kept.sha.slice(0, 12)}` };
    else if (iteration >= run.budgets.maxIterations) stop = { rule: "max-iterations", why: `${iteration} of ${run.budgets.maxIterations} iterations used` };
    else if (discardsInRow >= run.budgets.maxDiscardsInRow) stop = { rule: "discards-in-row", why: `${discardsInRow} steps discarded in a row` };

    const decision = keep ? "kept" : "discarded";
    // Recorded before the reset, so a reset that fails doesn't lose a paid judge result.
    record(
      commonDir,
      { ...run, status: stop === null ? "running" : stop.rule === "met" ? "met" : "stopped", stop, kept, lastChecked: sha, iteration, discardsInRow, judgeErrorsInRow: 0, judgeCostUsd: run.judgeCostUsd + ran.cost },
      { ts, kind: "check", iteration, sha, results: ran.results, decision, cost: ran.cost, note: stop === null ? note : `${note}; stop: ${stop.rule}` },
    );
    if (!keep) resetHard(worktree, run.kept.sha);
    return { iteration, sha, results: ran.results, decision, met: kept.met, stop, warning, flags: [], judgeError: null };
  });
}

/** The agent reports a dead end, or a met run won't ship, which switches the guard off. */
export function stopRun(cwd: string, slug: string, reason: string, now: number): Run {
  return withRunningRun(cwd, slug, now, ["running", "met"], (run, commonDir) => {
    const updated: Run = { ...run, status: "stopped", stop: { rule: "agent", why: reason } };
    record(commonDir, updated, { ts: new Date(now).toISOString(), kind: "stop", iteration: run.iteration, sha: commitOf(run.worktree, "HEAD") ?? "", results: null, decision: "stopped", cost: 0, note: reason });
    return updated;
  });
}

/** A new pickup: a `start` row, and the run rebound to `sessionId` when given; a run whose files changed is stopped instead. */
export function resumeRun(cwd: string, slug: string, now: number, sessionId: string | null): Run {
  return withRunningRun(cwd, slug, now, ["running"], (run, commonDir) => {
    const row = { ts: new Date(now).toISOString(), kind: "start", iteration: run.iteration, sha: commitOf(run.worktree, "HEAD") ?? "", results: null, decision: "", cost: 0, note: "resume" };
    if (isSealed(commonDir, slug)) {
      const resumed = { ...run, sessionId: sessionId ?? run.sessionId };
      record(commonDir, resumed, row);
      return resumed;
    }
    return stopOnChangedState(commonDir, run, row);
  });
}

/** Stop a run whose files changed since the last afk command, instead of sealing the change in. */
function stopOnChangedState(commonDir: string, run: Run, row: Parameters<typeof appendLog>[2]): Run {
  const why = "the afk run's files changed since the last afk command";
  const stopped: Run = { ...run, status: "stopped", stop: { rule: "state-changed", why } };
  record(commonDir, stopped, { ...row, kind: "stop", decision: "stopped", note: why });
  return stopped;
}

export interface Summary {
  iterations: number;
  kept: number;
  discarded: number;
  lastResults: CheckResult[];
}

export function showRun(cwd: string, slug: string): { run: Run; summary: Summary } {
  const run = readRun(cwd, slug);
  const checks = readLog(gitCommonDir(cwd), slug).filter((row) => row.kind === "check");
  const last = [...checks].reverse().find((row) => row.results !== "" && row.results !== "[]");
  return {
    run,
    summary: {
      iterations: run.iteration,
      kept: checks.filter((row) => row.decision === "kept").length,
      discarded: checks.filter((row) => row.decision === "discarded").length,
      lastResults: last === undefined ? run.start.results : (JSON.parse(last.results) as CheckResult[]),
    },
  };
}

/** `fbs land` merged the slug's PR: a met run becomes landed, which switches its guard off; anything else is left alone. */
export function markLanded(cwd: string, slug: string, note: string, now: number): void {
  const commonDir = gitCommonDir(cwd);
  if (!isSlug(slug) || !existsSync(runPath(commonDir, slug)) || readRun(cwd, slug).status !== "met") return;
  withRunningRun(cwd, slug, now, ["met"], (run) => {
    record(commonDir, { ...run, status: "landed" }, { ts: new Date(now).toISOString(), kind: "land", iteration: run.iteration, sha: run.kept.sha, results: null, decision: "landed", cost: 0, note });
  });
}

// ---- The final measurement.

export interface FinalReport extends FinalMeasure {
  tree: string;
  /** Set when the check commands left files in the tree. */
  warning: string | null;
  /** A failed judge call, which leaves the final not met. */
  judgeError: string | null;
  costUsd: number;
  /** The evidence index verify reads. */
  evidence: string;
}

/** Measure a met run's HEAD (the reviewed tree) with afk-guard and every check, record it and write verify's evidence. */
export function finalRun(cwd: string, slug: string, deps: AfkDeps, now: number): FinalReport {
  checkSlug(slug);
  const commonDir = gitCommonDir(cwd);
  return withLock(commonDir, slug, staleAfter(readRun(cwd, slug)), now, () => {
    const run = readRun(cwd, slug);
    if (run.status !== "met") throw new AfkError("not-met", `afk run ${slug} is ${run.status}; fbs afk final measures a met run`);
    const worktree = run.worktree;
    const branch = currentBranch(worktree);
    if (branch !== run.branch) throw new AfkError("bad-branch", `${worktree} is on ${branch ?? "a detached HEAD"}, not the run's branch ${run.branch}`);
    const stray = strayFiles(worktree);
    if (stray.length > 0) throw new AfkError("dirty", `${worktree} has uncommitted or untracked files (${listed(stray)}); commit the review's fixes, or remove or .gitignore them`);
    // Any HEAD on the branch: the final review's fixes, organize-commits' rewrite, a merged base; all of it is measured.
    const sha = commitOf(worktree, "HEAD") as string;
    if (!isSealed(commonDir, slug)) throw new AfkError("state-changed", "the afk run's files changed since the last afk command, so its records can't be trusted");

    const tree = headTree(worktree);
    const { flags } = guardRun(run);
    const judgedChecks = run.checks.filter((c): c is JudgedCheck => c.kind === "judged");
    const recorded = recordedVerdicts(commonDir, slug, judgedChecks, tree);
    const state = JSON.stringify(dirHashes(afkDir(commonDir, slug)));
    const commands = runCommands(commonDir, slug, run, worktree);
    if (JSON.stringify(dirHashes(afkDir(commonDir, slug))) !== state) throw new AfkError("state-changed", "the check commands changed the afk run's own files");
    const wrote = strayFiles(worktree);
    const judged = runJudged(commonDir, slug, run, worktree, tree, commands, recorded, deps, false, wrote);
    const ran = combine(run, commands.results, judged.results, judged.cost, false);

    const final: FinalMeasure = { sha, results: ran.results, met: ran.met && flags.length === 0, flags };
    const evidence = writeEvidence(commonDir, run, final, tree, ran.cost, now);
    const failing = failingChecks(final.results);
    const judgeError = wrote.length === 0 ? judgeErrorOf(ran.results) : null;
    const note = final.met
      ? "every check passes"
      : [failing.length > 0 && `failing: ${failing.join(", ")}`, judgeError !== null && `judge error: ${judgeError}`, flags.length > 0 && `afk-guard flagged: ${flagList(flags)}`].filter(Boolean).join("; ");
    record(commonDir, { ...run, final, judgeCostUsd: run.judgeCostUsd + ran.cost }, { ts: new Date(now).toISOString(), kind: "final", iteration: run.iteration, sha, results: ran.results, decision: final.met ? "met" : "not met", cost: ran.cost, note });
    const warning = wrote.length > 0 ? `the check commands wrote ${listed(wrote)}; ignore them in .gitignore or write outside the repo` : null;
    return { ...final, tree, costUsd: ran.cost, evidence, warning, judgeError };
  });
}

/** The first failed judge call among the judged results: an error, not a verdict. */
function judgeErrorOf(results: CheckResult[]): string | null {
  return results.find((r): r is JudgedResult => r.kind === "judged" && r.error !== null)?.error ?? null;
}

function failingChecks(results: CheckResult[]): string[] {
  return results.filter((r) => !(r.pass && (r.kind === "command" || r.second === true))).map((r) => r.id);
}

/** Write validate's index format under `fbs/evidence/<slug>/afk-<YYYY-MM-DD-HHMM>/`, where verify looks; returns its path. */
function writeEvidence(commonDir: string, run: Run, final: FinalMeasure, tree: string, cost: number, now: number): string {
  const at = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}`;
  const dir = join(commonDir, "fbs", "evidence", run.slug, `afk-${day}-${time}`);
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  const failing = failingChecks(final.results);
  const missed = [...failing, ...(final.flags.length > 0 ? ["afk-guard flags"] : [])];
  const source = `(afk run ${run.slug}, fbs afk final)`;
  const lines = [
    `# Validation: ${run.slug}`,
    `- Tree: ${tree}`,
    `- Commit: ${final.sha.slice(0, 12)}`,
    `- Date: ${day} ${time.slice(0, 2)}:${time.slice(2)}`,
    "",
    "## Criteria",
    final.met ? `- [x] ${oneLine(run.goal)}: every check passes on this tree ${source}` : `- [ ] ${oneLine(run.goal)}: not met: ${missed.join(", ")} ${source}`,
    "",
    "## Checks",
  ];
  for (const check of run.checks) {
    const after = final.results.find((r) => r.id === check.id) as CheckResult;
    const before = run.start.results.find((r) => r.id === check.id);
    const passed = !failing.includes(check.id);
    if (check.kind === "command") {
      lines.push(`- ${check.id} (command \`${oneLine(check.run)}\`): ${passed ? "pass" : "fail"}; baseline ${before === undefined ? "none" : shownResult(before)}, final ${shownResult(after)}`);
      continue;
    }
    lines.push(`- ${check.id} (judged): ${passed ? "pass on both votes" : "fail"}; baseline ${before === undefined ? "none" : shownResult(before)}, final ${shownResult(after)}`);
    if (after.kind === "judged") for (const c of after.criteria) lines.push(`  - ${c.pass ? "pass" : "fail"}: ${oneLine(c.criterion)}: ${oneLine(c.evidence) || "no evidence"}`);
  }
  lines.push("", "## Findings");
  lines.push(...(final.flags.length === 0 ? ["- afk-guard: no flags"] : final.flags.map((f) => `- afk-guard: ${f.kind} ${f.path}${f.line === undefined ? "" : `:${f.line}`} (${oneLine(f.detail)})`)));
  lines.push(`- Judge cost of this measurement: $${cost.toFixed(4)}`, "");
  // An older afk index of this slug, maybe [x], must not outlive this measurement.
  const root = dirname(dir);
  if (existsSync(root)) for (const old of readdirSync(root)) if (old.startsWith("afk-")) rmSync(join(root, old), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "index.md");
  writeFileSync(path, lines.join("\n"));
  return path;
}

/** A check result in a few words: a command's value or exit, a judged check's passing criteria. */
function shownResult(result: CheckResult): string {
  if (result.kind === "command") return result.error !== null ? `error (${result.error})` : result.value !== null ? String(result.value) : `exit ${result.exit}`;
  if (result.skipped) return "not judged (a command check failed)";
  if (result.error !== null) return `error (${result.error})`;
  const shown = `${result.criteria.filter((c) => c.pass).length}/${result.criteria.length} criteria`;
  return result.second === false ? `${shown}, second vote failed` : shown;
}

// ---- afk-guard on a run.

/** afk-guard over the run's `start..HEAD`, with the config as it was at the start so later edits can't loosen it. */
export function afkGuardRun(cwd: string, slug: string): { flags: Flag[] } {
  return guardRun(readRun(cwd, slug));
}

function guardRun(run: Run): { flags: Flag[] } {
  const input = { start: diffBase(run), scope: run.scope, protectedFiles: Object.keys(run.protected), checkScripts: checkScripts(run.checks) };
  return afkGuard(run.worktree, input, runConfig(run));
}

/** The config a run's guard goes by: the copy taken at its start when the config is local, else the one committed then. */
export function runConfig(run: Run): FbsConfig {
  return run.config ?? configAt(run.worktree, run.start.sha);
}

/** Where HEAD meets the branch's base when that's above the start (the base was merged in), else the start. */
function diffBase(run: Run): string {
  const start = run.start.sha;
  if (run.baseRef == null || commitOf(run.worktree, run.baseRef) === null) return start;
  const met = mergeBase(run.worktree, "HEAD", run.baseRef);
  return met !== null && met !== start && mergeBase(run.worktree, start, met) === start ? met : start;
}

/** The parent branch's ref, origin's when it has one, from the slug's feature record when it names this branch; null otherwise. */
function parentRef(cwd: string, worktree: string, slug: string, branch: string): string | null {
  try {
    if (!existsSync(recordPath(cwd, slug))) return null;
    const recorded = readFeature(cwd, slug).branch;
    if (recorded === undefined || recorded.name !== branch || recorded.parent === null) return null;
    return [`refs/remotes/origin/${recorded.parent}`, `refs/heads/${recorded.parent}`].find((ref) => commitOf(worktree, ref) !== null) ?? null;
  } catch {
    return null;
  }
}

const SCRIPT_CALLS = [/\b(?:bun|npm)\s+(?:run|run-script)(?:\s+-\S+)*\s+([^\s;&|<>-][^\s;&|<>]*)/g, /\b(?:pnpm|yarn)(?:\s+-\S+)*\s+(?:run(?:\s+-\S+)*\s+)?([^\s;&|<>-][^\s;&|<>]*)/g];

/** The package.json scripts the command checks call, such as `lint` in `bun run lint`; `npm test` calls `test`. */
export function checkScripts(checks: Check[]): string[] {
  const names = new Set<string>();
  for (const check of checks) {
    if (check.kind !== "command") continue;
    const run = check.run.replace(/["']/g, "");
    for (const pattern of SCRIPT_CALLS) for (const match of run.matchAll(pattern)) names.add(match[1]);
    if (/\bnpm\s+(test|t|tst)\b/.test(run)) names.add("test");
  }
  return [...names].sort();
}

function flagList(flags: Flag[]): string {
  return listed(flags.map((f) => `${f.kind} ${f.path}${f.line === undefined ? "" : `:${f.line}`} (${f.detail})`));
}

// ---- The Stop hook.

export interface StopDecision {
  /** Why the session must keep going, shown to the agent; null lets it stop. */
  block: string | null;
  /** What happened, for stderr. */
  note: string | null;
}

const LET_STOP: StopDecision = { block: null, note: null };

/** Which run the last block was for and how many log rows it had then. */
interface StopBlock {
  start: string;
  rows: number;
}

/** The Stop hook: keep this session's running afk run going, unless something will wake it or it made no progress; never throws. */
export function stopCheck(raw: string, fallbackCwd: string, now: number): StopDecision {
  try {
    const input = JSON.parse(raw) as unknown;
    if (!isObject(input) || typeof input.session_id !== "string" || input.session_id === "") return LET_STOP;
    const cwd = typeof input.cwd === "string" && existsSync(input.cwd) ? input.cwd : fallbackCwd;
    const commonDir = gitCommonDir(cwd);
    const run = afkRunsIn(commonDir, ["running"]).find((r) => r.sessionId === input.session_id);
    if (run === undefined) return LET_STOP;
    const tasks = Array.isArray(input.background_tasks) ? input.background_tasks.filter(isObject) : [];
    const crons = Array.isArray(input.session_crons) ? input.session_crons : [];
    if (crons.length > 0 || tasks.some(wakesSession)) return { block: null, note: `afk run ${run.slug}: a background task or wakeup will wake the session` };
    const shells = tasks.filter((t) => t.type === "shell").map((t) => String(t.command ?? t.description ?? t.id));
    const log = readLog(commonDir, run.slug);
    const path = join(afkRoot(commonDir), `${run.slug}.stopblock`);
    const last = readStopBlock(path);
    if (input.stop_hook_active === true && last !== null && last.start === run.start.at && log.length <= last.rows) {
      rmSync(path, { force: true });
      return pauseRun(cwd, run.slug, now);
    }
    const block: StopBlock = { start: run.start.at, rows: log.length };
    writeFileSync(path, `${JSON.stringify(block)}\n`);
    const idle = shells.length === 0 ? "" : ` A background shell won't wake you (${shells.join("; ")}); stop it if you don't need it.`;
    return { block: `${continueReason(run, log.at(-1))}${idle}`, note: null };
  } catch {
    return LET_STOP;
  }
}

// A shell such as a dev server may never exit, so only fbs's own that end and report count: the PR watcher and long afk commands.
const WAKING_TASKS = ["subagent", "workflow", "teammate"];
const WAKING_COMMAND = /\bfbs["']?\s+(watch-pr|afk\s+(check|start|final))\b/;

function wakesSession(task: Record<string, unknown>): boolean {
  return WAKING_TASKS.includes(String(task.type)) || (task.type === "shell" && typeof task.command === "string" && WAKING_COMMAND.test(task.command));
}

function readStopBlock(path: string): StopBlock | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return typeof raw?.start === "string" && Number.isInteger(raw.rows) ? { start: raw.start, rows: raw.rows } : null;
  } catch {
    return null;
  }
}

/** Log that the session stopped without progress; the run stays running for `fbs afk resume` or /fbs:assemble. */
function pauseRun(cwd: string, slug: string, now: number): StopDecision {
  return withRunningRun(cwd, slug, now, ["running"], (run, commonDir) => {
    const note = "the session stopped with no progress since the last stop-hook block; pick it up with fbs afk resume or /fbs:assemble";
    const row = { ts: new Date(now).toISOString(), kind: "stop", iteration: run.iteration, sha: commitOf(run.worktree, "HEAD") ?? "", results: null, decision: "paused", cost: 0, note };
    if (!isSealed(commonDir, slug)) {
      stopOnChangedState(commonDir, run, row);
      return { block: null, note: `afk run ${slug} stopped: its files changed since the last afk command` };
    }
    record(commonDir, run, row);
    return { block: null, note: `afk run ${slug} paused: ${note}` };
  });
}

function continueReason(run: Run, last: Record<string, string> | undefined): string {
  const slug = run.slug;
  const lastStep = last === undefined ? "nothing logged yet" : [last.kind, last.kind === "check" ? last.iteration : "", last.decision, last.note === "" ? "" : `(${last.note.slice(0, 160)})`].filter((part) => part !== "").join(" ");
  return [
    `afk run ${slug} is still running (iteration ${run.iteration} of ${run.budgets.maxIterations}; last: ${lastStep}).`,
    `Make the next smallest step, commit it and run \`fbs afk check ${slug}\`; if it's a dead end, \`fbs afk stop ${slug} --reason <why>\`.`,
    `On wake, re-read the afk skill (skills/afk/SKILL.md) and \`fbs afk show ${slug}\`.`,
  ].join(" ");
}
