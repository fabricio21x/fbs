import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { campMarkers } from "./guard";
import { run } from "./main";
import { isolatedGitEnv } from "./test-env";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const identity = ["-c", "user.name=fbs", "-c", "user.email=fbs@example.com", "-c", "commit.gpgsign=false"];
  const result = Bun.spawnSync(["git", ...identity, ...args], { cwd, env: isolatedGitEnv(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

function fbs(cwd: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, { cwd, today: "2026-11-01", out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out, err };
}

/** A repo with feature x, and an optional .fbs/config.json. */
function campRepo(config?: object): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "fbs-camp-")));
  tempDirs.push(repo);
  git(repo, "init", "-q");
  if (config !== undefined) {
    mkdirSync(join(repo, ".fbs"));
    writeFileSync(join(repo, ".fbs", "config.json"), JSON.stringify(config));
  }
  expect(fbs(repo, "status", "init", "x", "--size", "mid").code).toBe(0);
  return repo;
}

const campFile = (repo: string, slug = "x") => join(repo, ".git", "fbs", "pr", `${slug}.camp`);
const show = (repo: string, ...args: string[]) => JSON.parse(fbs(repo, "camp", "show", "x", ...args).out.join("\n"));
const round = (repo: string, fixed: number, ...extra: string[]) =>
  fbs(repo, "camp", "round", "x", "--in", "3", "--fixed", String(fixed), "--declined", "1", "--followups", "0", "--asked", "0", ...extra);

test("camp start writes the camp file the guard reads, with the default budget of 2", () => {
  const repo = campRepo();
  const r = fbs(repo, "camp", "start", "x");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out.join("\n"))).toEqual({ slug: "x", autoFixRounds: 2, phase: "auto", checkpoints: [], rounds: [], followups: [], openFollowups: [] });
  expect(campMarkers(join(repo, ".git"))).toEqual(["x"]);
});

test("the budget comes from camp.autoFixRounds, and --auto-fix-rounds overrides it", () => {
  const repo = campRepo({ camp: { autoFixRounds: 3 } });
  expect(JSON.parse(fbs(repo, "camp", "start", "x").out.join("\n")).autoFixRounds).toBe(3);
  expect(JSON.parse(fbs(repo, "camp", "start", "x", "--auto-fix-rounds", "1").out.join("\n")).autoFixRounds).toBe(1);
  expect(show(repo).autoFixRounds).toBe(1);
});

test("rounds print continue, then checkpoint once on the round that spends the budget, then blockers-only after it is held", () => {
  const repo = campRepo();
  fbs(repo, "camp", "start", "x");
  expect(round(repo, 2).out).toEqual(["continue"]);
  expect(round(repo, 0).out).toEqual(["continue"]);
  expect(round(repo, 1, "--note", "edge cases").out).toEqual(["checkpoint"]);
  expect(show(repo).phase).toBe("checkpoint");
  expect(fbs(repo, "camp", "checkpoint", "x")).toEqual({ code: 0, out: ["blockers-only"], err: [] });
  expect(round(repo, 1).out).toEqual(["blockers-only"]);
  expect(round(repo, 0).out).toEqual(["blockers-only"]);
  const state = show(repo);
  expect(state.phase).toBe("blockers-only");
  expect(state.checkpoints).toEqual(["x"]);
  expect(state.rounds[2]).toEqual({ number: 3, date: "2026-11-01", in: 3, fixed: 1, declined: 1, followups: 0, asked: 0, note: "edge cases" });
  expect(state.rounds.map((r: { number: number }) => r.number)).toEqual([1, 2, 3, 4, 5]);
});

test("a round after the checkpoint is due but before it is held says checkpoint again", () => {
  const repo = campRepo();
  fbs(repo, "camp", "start", "x", "--auto-fix-rounds", "1");
  expect(round(repo, 1).out).toEqual(["checkpoint"]);
  expect(round(repo, 0).out).toEqual(["checkpoint"]);
});

test("camp checkpoint is refused before one is due, and holding it twice changes nothing", () => {
  const repo = campRepo();
  fbs(repo, "camp", "start", "x", "--auto-fix-rounds", "1");
  expect(fbs(repo, "camp", "checkpoint", "x")).toEqual({ code: 1, out: ["error: no checkpoint is due for x: the budget is 1 round that fixed something"], err: [] });
  round(repo, 1);
  fbs(repo, "camp", "checkpoint", "x");
  expect(fbs(repo, "camp", "checkpoint", "x").out).toEqual(["blockers-only"]);
  expect(show(repo).checkpoints).toEqual(["x"]);
});

test("a resume keeps the rounds, the budget and the checkpoint", () => {
  const repo = campRepo();
  fbs(repo, "camp", "start", "x");
  round(repo, 1);
  expect(JSON.parse(fbs(repo, "camp", "start", "x").out.join("\n")).rounds).toHaveLength(1);
  expect(round(repo, 1).out).toEqual(["checkpoint"]);
  fbs(repo, "camp", "checkpoint", "x");
  fbs(repo, "camp", "start", "x");
  expect(round(repo, 1).out).toEqual(["blockers-only"]);
});

test("--unit counts rounds per unit under the feature's camp", () => {
  const repo = campRepo();
  // A unit record by hand: the camp only needs the feature to list it.
  for (const [unit, slug] of ["x-api", "x-ui"].entries()) {
    const rec = { slug, dir: `docs/features/2026-11-01-x/units/${slug}`, size: "big", approvals: {}, pr: null, unitOf: "x", unit: unit + 1 };
    writeFileSync(join(repo, ".git", "fbs", "features", `${slug}.json`), JSON.stringify(rec));
  }
  fbs(repo, "camp", "start", "x", "--auto-fix-rounds", "2");
  expect(round(repo, 1, "--unit", "x-api").out).toEqual(["continue"]);
  expect(round(repo, 1, "--unit", "x-ui").out).toEqual(["continue"]);
  expect(round(repo, 1, "--unit", "x-api").out).toEqual(["checkpoint"]);
  expect(fbs(repo, "camp", "checkpoint", "x", "--unit", "x-api").out).toEqual(["blockers-only"]);
  expect(round(repo, 1, "--unit", "x-ui").out).toEqual(["checkpoint"]);
  const state = show(repo, "--unit", "x-ui");
  expect(state.phase).toBe("checkpoint");
  expect(state.units).toEqual({ "x-api": "blockers-only", "x-ui": "checkpoint" });
  expect(state.rounds.map((r: { unit: string; number: number }) => `${r.unit}#${r.number}`)).toEqual(["x-api#1", "x-ui#1", "x-api#2", "x-ui#2"]);
  expect(round(repo, 1, "--unit", "x-db")).toEqual({ code: 1, out: ["error: x-db is not a unit of x"], err: [] });
});

test.each(["Round 1: fixed two things\n", '{"rounds":[{"n":1}]}', "[]"])("an old camp file %p counts as empty, with a note", (content) => {
  const repo = campRepo();
  mkdirSync(join(repo, ".git", "fbs", "pr"), { recursive: true });
  writeFileSync(campFile(repo), content);
  const shown = fbs(repo, "camp", "show", "x");
  expect(shown.code).toBe(0);
  expect(JSON.parse(shown.out.join("\n"))).toMatchObject({ autoFixRounds: 2, phase: "auto", rounds: [] });
  expect(shown.err).toEqual([`note: ${campFile(repo)} isn't a camp state fbs wrote; starting from an empty one`]);
  expect(readFileSync(campFile(repo), "utf8")).toBe(content);
  const recorded = round(repo, 1);
  expect(recorded.out).toEqual(["continue"]);
  expect(recorded.err).toHaveLength(1);
  expect(show(repo).rounds).toHaveLength(1);
});

test("round and show without a camp are refused, and a missing feature is an error", () => {
  const repo = campRepo();
  expect(round(repo, 1)).toEqual({ code: 1, out: ["error: no camp for x; start it with fbs camp start x"], err: [] });
  expect(existsSync(campFile(repo))).toBe(false);
  expect(fbs(repo, "camp", "start", "nope").out[0]).toStartWith("error: missing: ");
});

test.each([
  [["camp"], "unknown command: camp"],
  [["camp", "halt", "x"], "unknown command: camp halt x"], [["camp", "stop", "x", "--unit", "x-api"], "unknown command: camp stop x --unit x-api"],
  [["camp", "start"], "unknown command: camp start"],
  [["camp", "show", "x", "--auto-fix-rounds", "2"], "unknown command: camp show x --auto-fix-rounds 2"],
  [["camp", "start", "x", "--auto-fix-rounds", "0"], "camp start: --auto-fix-rounds takes a positive integer, not 0"],
  [["camp", "round", "x", "--in", "1", "--fixed", "1"], "camp round needs --in <n> --fixed <n> --declined <n> --followups <n> --asked <n>, each a non-negative integer; missing --declined --followups --asked"],
  [["camp", "round", "x", "--in", "1", "--fixed", "-1", "--declined", "0", "--followups", "0", "--asked", "x"], "camp round needs --in <n> --fixed <n> --declined <n> --followups <n> --asked <n>, each a non-negative integer; not a count: --fixed --asked"],
])("camp usage error %p", (args, message) => {
  const r = fbs(campRepo(), ...args);
  expect(r).toEqual({ code: 2, out: [], err: [message] });
});

const LANDED = { pr: 7, repo: "acme/app", commit: "a".repeat(40), at: "2026-11-01" };
const recordFile = (repo: string, slug: string) => join(repo, ".git", "fbs", "features", `${slug}.json`);

test("camp start is refused for a landed feature and leaves no camp file", () => {
  const repo = campRepo();
  const rec = JSON.parse(readFileSync(recordFile(repo, "x"), "utf8"));
  writeFileSync(recordFile(repo, "x"), JSON.stringify({ ...rec, landed: LANDED }));
  expect(fbs(repo, "camp", "start", "x")).toEqual({ code: 1, out: ["error: x has landed; there is nothing to camp"], err: [] });
  expect(existsSync(campFile(repo))).toBe(false);
});

test("camp start is refused once every unit of the stack has landed, not before", () => {
  const repo = campRepo();
  const unit = (slug: string, n: number, landed: boolean) =>
    writeFileSync(recordFile(repo, slug), JSON.stringify({ slug, dir: `docs/features/2026-11-01-x/units/${slug}`, size: "big", approvals: {}, pr: null, unitOf: "x", unit: n, ...(landed && { landed: LANDED }) }));
  unit("x-api", 1, true);
  unit("x-ui", 2, false);
  expect(fbs(repo, "camp", "start", "x").code).toBe(0);
  unit("x-ui", 2, true);
  expect(fbs(repo, "camp", "start", "x")).toEqual({ code: 1, out: ["error: x has landed; there is nothing to camp"], err: [] });
});

const followupsFile = (repo: string) => join(repo, ".git", "fbs", "pr", "x.followups.json");

test("camp stop removes the camp file, switching the guard off, and stopping again is fine", () => {
  const repo = campRepo();
  fbs(repo, "camp", "start", "x");
  expect(fbs(repo, "camp", "stop", "x")).toEqual({ code: 0, out: ["stopped"], err: [] });
  expect(existsSync(campFile(repo))).toBe(false);
  expect(campMarkers(join(repo, ".git"))).toEqual([]);
  expect(fbs(repo, "camp", "stop", "x")).toEqual({ code: 0, out: ["stopped"], err: [] });
});

test("follow-ups are numbered with their round, shown by camp show, outlive camp stop and take a filed link", () => {
  const repo = campRepo();
  fbs(repo, "camp", "start", "x");
  round(repo, 1);
  const first = fbs(repo, "camp", "followup", "x", "--thread", "thread:PRRT_a", "--summary", "Retry on 429", "--why", "the spec never asked for retries");
  expect(first.code).toBe(0);
  expect(JSON.parse(first.out[0])).toEqual({ number: 1, thread: "thread:PRRT_a", summary: "Retry on 429", why: "the spec never asked for retries", round: 2, at: "2026-11-01", status: "open" });
  fbs(repo, "camp", "followup", "x", "--thread", "issue:9", "--summary", "Rename the helper");
  expect(show(repo).followups.map((f: { number: number }) => f.number)).toEqual([1, 2]);
  fbs(repo, "camp", "stop", "x");
  expect(existsSync(followupsFile(repo))).toBe(true);
  const filed = fbs(repo, "camp", "followup", "x", "--filed", "2", "--link", "https://linear.app/t/ACM-9");
  expect(JSON.parse(filed.out[0])).toMatchObject({ number: 2, status: "filed", link: "https://linear.app/t/ACM-9" });
  expect(JSON.parse(readFileSync(followupsFile(repo), "utf8"))[1].link).toBe("https://linear.app/t/ACM-9");
  expect(fbs(repo, "camp", "followup", "x", "--filed", "3", "--link", "u")).toEqual({ code: 1, out: ["error: x has no follow-up 3; it has 2"], err: [] });
});

test("a follow-up with --unit records the unit and that unit's round, and needs a camp", () => {
  const repo = campRepo();
  const add = () => fbs(repo, "camp", "followup", "x", "--thread", "thread:5", "--summary", "s", "--unit", "x-api");
  writeFileSync(recordFile(repo, "x-api"), JSON.stringify({ slug: "x-api", dir: "docs/features/2026-11-01-x/units/x-api", size: "big", approvals: {}, pr: null, unitOf: "x", unit: 1 }));
  expect(add()).toEqual({ code: 1, out: ["error: no camp for x; start it with fbs camp start x"], err: [] });
  fbs(repo, "camp", "start", "x");
  round(repo, 1);
  expect(JSON.parse(add().out[0])).toMatchObject({ unit: "x-api", round: 1 });
});

test.each([
  [["--thread", "thread:5"], "camp followup takes --thread <key> --summary <text> [--why <text>] [--unit <unit slug>], --filed <n> --link <url>, or --declined <n>"],
  [["--filed", "1"], "camp followup takes --thread <key> --summary <text> [--why <text>] [--unit <unit slug>], --filed <n> --link <url>, or --declined <n>"],
  [["--thread", "thread:5", "--summary", "s", "--filed", "1", "--link", "u"], "camp followup takes --thread <key> --summary <text> [--why <text>] [--unit <unit slug>], --filed <n> --link <url>, or --declined <n>"],
  [["--thread", "PRRT_a", "--summary", "s"], "camp followup: --thread takes thread:<id>, thread:<node id> (PRRT_… or PRRC_…), issue:<id> or review:<id>, not PRRT_a"],
  [["--filed", "0", "--link", "u"], "camp followup: --filed takes a follow-up's number, not 0"],
])("camp followup usage error %p", (args, message) => {
  expect(fbs(campRepo(), "camp", "followup", "x", ...args)).toEqual({ code: 2, out: [], err: [message] });
});

test("a declined follow-up leaves openFollowups, so a later green doesn't propose it again", () => {
  const repo = campRepo();
  fbs(repo, "camp", "start", "x");
  for (const summary of ["a", "b", "c"]) fbs(repo, "camp", "followup", "x", "--thread", "thread:5", "--summary", summary);
  expect(JSON.parse(fbs(repo, "camp", "followup", "x", "--declined", "1").out[0])).toMatchObject({ number: 1, status: "declined" });
  fbs(repo, "camp", "followup", "x", "--filed", "3", "--link", "https://linear.app/t/ACM-3");
  const state = show(repo);
  expect(state.openFollowups.map((f: { summary: string }) => f.summary)).toEqual(["b"]);
  expect(state.followups.map((f: { status: string }) => f.status)).toEqual(["declined", "open", "filed"]);
  expect(fbs(repo, "camp", "followup", "x", "--declined", "1").code).toBe(0);
  expect(fbs(repo, "camp", "followup", "x", "--declined", "3")).toEqual({ code: 1, out: ["error: follow-up 3 of x is already filed"], err: [] });
  expect(fbs(repo, "camp", "followup", "x", "--filed", "1", "--link", "u")).toEqual({ code: 1, out: ["error: follow-up 1 of x is already declined"], err: [] });
});

test.each([[["--declined", "1", "--link", "u"]], [["--declined", "1", "--filed", "1"]], [["--declined", "x"]]])("camp followup --declined usage error %p", (args) => {
  const r = fbs(campRepo(), "camp", "followup", "x", ...args);
  expect(r.code).toBe(2);
  expect(r.out).toEqual([]);
});
