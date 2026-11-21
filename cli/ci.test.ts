import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CiRefusedError, ciEvidence } from "./ci";
import type { GhRunner } from "./github";
import { initFeature, updateFeature } from "./status";
import { isolatedGitEnv } from "./test-env";

let repo: string;
let sha: string;
let tree: string;

function git(...args: string[]): string {
  const identity = ["-c", "user.name=fbs", "-c", "user.email=fbs@example.com", "-c", "commit.gpgsign=false"];
  const result = Bun.spawnSync(["git", ...identity, ...args], { cwd: repo, env: isolatedGitEnv(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function writeConfig(verify: unknown): void {
  mkdirSync(join(repo, ".fbs"), { recursive: true });
  writeFileSync(join(repo, ".fbs/config.json"), JSON.stringify({ verify }));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "fbs-ci-"));
  git("init", "-q", "-b", "main");
  writeConfig({ ciEvidence: true, ciWorkflows: ["CI", "Typecheck"] });
  writeFileSync(join(repo, ".gitignore"), ".fbs/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("switch", "-q", "-c", "feature/x");
  initFeature(repo, "x", "mid", "2026-10-21");
  updateFeature(repo, "x", (rec) => ({ ...rec, pr: 7, repo: "acme/app", branch: { name: "feature/x", parent: "main", base: git("rev-parse", "HEAD") } }));
  sha = git("rev-parse", "HEAD");
  tree = git("rev-parse", "HEAD^{tree}");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

interface Run {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at?: string;
  head_sha?: string;
}

const url = (id: number) => `https://github.com/acme/app/actions/runs/${id}`;

/** A gh that answers the runs query from `rounds`, one per call, repeating the last; it records each call. */
function fakeGh(...rounds: Run[][]): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push(args);
    const runs = rounds[Math.min(calls.length - 1, rounds.length - 1)];
    const workflow_runs = runs.map((run) => ({ head_sha: sha, created_at: "2026-10-21T10:00:00Z", html_url: url(run.id), ...run }));
    return { code: 0, stdout: JSON.stringify({ workflow_runs }), stderr: "" };
  };
  return { gh, calls };
}

const clock = () => {
  let now = 0;
  return { now: () => now, sleep: (ms: number) => void (now += ms) };
};

const once = { wait: false };

test("green runs of every required workflow on the exact head are the evidence, with the sha, the tree and each run's url", () => {
  const { gh, calls } = fakeGh([
    { id: 1, name: "CI", status: "completed", conclusion: "success" },
    { id: 2, name: "Typecheck", status: "completed", conclusion: "success" },
    { id: 3, name: "Deploy preview", status: "completed", conclusion: "failure" },
  ]);
  expect(ciEvidence(repo, "x", gh, clock(), once)).toEqual({
    sha,
    tree,
    verdict: "evidence",
    runs: [
      { workflow: "CI", state: "success", url: url(1) },
      { workflow: "Typecheck", state: "success", url: url(2) },
    ],
  });
  expect(calls[0]).toEqual(["api", `repos/acme/app/actions/runs?head_sha=${sha}&per_page=100`]);
});

test("a failed or skipped required run is refused, a running one is a wait, a missing one is missing", () => {
  const verdict = (runs: Run[]) => ciEvidence(repo, "x", fakeGh(runs).gh, clock(), once);
  const ci = { id: 1, name: "CI", status: "completed", conclusion: "success" };
  expect(verdict([ci, { id: 2, name: "Typecheck", status: "completed", conclusion: "failure" }])).toMatchObject({ verdict: "refused", runs: [{ state: "success" }, { workflow: "Typecheck", state: "failed", conclusion: "failure", url: url(2) }] });
  expect(verdict([ci, { id: 2, name: "Typecheck", status: "completed", conclusion: "skipped" }])).toMatchObject({ verdict: "refused", runs: [{ state: "success" }, { state: "skipped" }] });
  expect(verdict([ci, { id: 2, name: "Typecheck", status: "in_progress", conclusion: null }])).toMatchObject({ verdict: "wait", runs: [{ state: "success" }, { state: "running" }] });
  expect(verdict([ci])).toMatchObject({ verdict: "refused", runs: [{ state: "success" }, { workflow: "Typecheck", state: "missing" }] });
});

test("only runs on the exact head count, and the newest run of a workflow decides", () => {
  const { gh } = fakeGh([
    { id: 1, name: "CI", status: "completed", conclusion: "failure", created_at: "2026-10-21T09:00:00Z" },
    { id: 4, name: "CI", status: "completed", conclusion: "success", created_at: "2026-10-21T11:00:00Z" },
    { id: 2, name: "Typecheck", status: "completed", conclusion: "success", head_sha: "f".repeat(40) },
  ]);
  expect(ciEvidence(repo, "x", gh, clock(), once)).toMatchObject({ verdict: "refused", runs: [{ state: "success", url: url(4) }, { workflow: "Typecheck", state: "missing" }] });
});

test("--wait polls until every required workflow has finished, a missing one counting as not started yet", () => {
  const ci = (status: string, conclusion: string | null) => ({ id: 1, name: "CI", status, conclusion });
  const tc = { id: 2, name: "Typecheck", status: "completed", conclusion: "success" };
  const { gh, calls } = fakeGh([], [ci("queued", null)], [ci("in_progress", null), tc], [ci("completed", "success"), tc]);
  expect(ciEvidence(repo, "x", gh, clock(), { wait: true }).verdict).toBe("evidence");
  expect(calls).toHaveLength(4);
});

test("--wait stops at its timeout and reports what it saw", () => {
  const { gh } = fakeGh([{ id: 1, name: "CI", status: "in_progress", conclusion: null }]);
  expect(ciEvidence(repo, "x", gh, clock(), { wait: true }).verdict).toBe("wait");
});

test("it refuses with ciEvidence off, before a PR exists, and off the feature's branch", () => {
  const refused = () => {
    try {
      ciEvidence(repo, "x", fakeGh([]).gh, clock(), once);
    } catch (e) {
      if (e instanceof CiRefusedError) return e.reason;
      throw e;
    }
    throw new Error("not refused");
  };
  git("switch", "-q", "main");
  expect(refused()).toBe("x's branch feature/x is not checked out; check it out first");
  git("switch", "-q", "feature/x");
  updateFeature(repo, "x", ({ repo: _, ...rec }) => ({ ...rec, pr: null }));
  expect(refused()).toBe("x has no PR yet: CI evidence counts only once the PR exists, so run the suite locally");
  writeConfig({ ciEvidence: false });
  expect(refused()).toBe("verify.ciEvidence is off in .fbs/config.json: run the suite locally");
});
