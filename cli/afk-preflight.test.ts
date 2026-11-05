import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coversPush, pushRules } from "./afk-preflight";
import type { GhResult, GhRunner } from "./github";
import { run } from "./main";
import { isolatedGitEnv } from "./test-env";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fbs-preflight-")));
  dirs.push(dir);
  return dir;
}

function repo(): string {
  const cwd = tempDir();
  const result = Bun.spawnSync(["git", "init", "-q", "-b", "fbs/x"], { cwd, env: isolatedGitEnv() });
  if (result.exitCode !== 0) throw new Error("git init failed");
  return cwd;
}

function fakeGh(options: { protectedField?: boolean | null; rules?: string | null } = {}) {
  const calls: string[] = [];
  const gh: GhRunner = (args): GhResult => {
    const line = args.join(" ");
    calls.push(line);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    if (line === "repo view --json nameWithOwner,defaultBranchRef") return ok(JSON.stringify({ nameWithOwner: "acme/app", defaultBranchRef: { name: "trunk" } }));
    if (line === "api repos/acme/app/branches/trunk") return options.protectedField === null ? { code: 1, stdout: "", stderr: "HTTP 502" } : ok(JSON.stringify({ name: "trunk", protected: options.protectedField ?? false }));
    if (line === "api repos/acme/app/rules/branches/trunk") return options.rules === null ? { code: 1, stdout: "", stderr: "HTTP 502" } : ok(options.rules ?? "[]");
    return { code: 1, stdout: "", stderr: `unexpected gh ${line}` };
  };
  return { gh, calls };
}

function preflight(cwd: string, gh: GhRunner, userSettings: string, ...args: string[]) {
  const out: string[] = [];
  const code = run(["afk", "preflight", ...args], { cwd, today: "2026-10-28", out: (l) => out.push(l), err: () => {} }, { gh, now: () => 0, sleep: () => {}, stdin: () => "" }, { judge: () => ({ pass: false, criteria: [], costUsd: 0, error: "unused" }), userSettings, sessionId: () => null });
  expect(code).toBe(0);
  expect(out).toHaveLength(1);
  return JSON.parse(out[0]);
}

describe("fbs afk preflight", () => {
  test("reports what is missing with the lines to add, records it and prints the record on later calls", () => {
    const cwd = repo();
    const { gh, calls } = fakeGh();
    expect(preflight(cwd, gh, join(cwd, "none.json"))).toEqual({ branch: "trunk", merge_denied: false, push_denied: false, branch_protected: false, suggest: ["Bash(gh pr merge *)", ...pushRules("trunk")], cached: false });
    const count = calls.length;
    expect(preflight(cwd, gh, join(cwd, "none.json"))).toMatchObject({ branch_protected: false, cached: true });
    expect(calls).toHaveLength(count);
    expect(preflight(cwd, gh, join(cwd, "none.json"), "--force")).toMatchObject({ cached: false });
    expect(calls.length).toBeGreaterThan(count);
  });

  test("reads the user's, the repo's and the local settings and sees protection or rulesets", () => {
    const cwd = repo();
    const settings = join(tempDir(), "settings.json");
    writeFileSync(settings, JSON.stringify({ permissions: { deny: ["Bash(gh pr merge:*)"] } }));
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ autoMode: { hard_deny: ["Bash(git push origin trunk)"] } }));
    expect(preflight(cwd, fakeGh({ rules: '[{"type":"pull_request"}]' }).gh, settings)).toEqual({ branch: "trunk", merge_denied: true, push_denied: true, branch_protected: true, suggest: [], cached: false });
    writeFileSync(join(cwd, ".claude", "settings.json"), "not json");
    expect(preflight(cwd, fakeGh({ protectedField: true }).gh, join(cwd, "missing.json"), "--force")).toMatchObject({ merge_denied: false, push_denied: true, branch_protected: true, suggest: ["Bash(gh pr merge *)"] });
  });

  test("an unknown protection is reported but not recorded", () => {
    const cwd = repo();
    expect(preflight(cwd, () => ({ code: 1, stdout: "", stderr: "no gh" }), join(cwd, "none.json"))).toEqual({ branch: "main", merge_denied: false, push_denied: false, branch_protected: null, suggest: ["Bash(gh pr merge *)", ...pushRules("main")], cached: false });
    expect(preflight(cwd, fakeGh({ protectedField: null }).gh, join(cwd, "none.json")).branch_protected).toBeNull();
    expect(preflight(cwd, fakeGh({ rules: null }).gh, join(cwd, "none.json")).branch_protected).toBeNull();
    expect(existsSync(join(cwd, ".git", "fbs", "afk", "preflight.json"))).toBe(false);
  });
});

describe("coversPush", () => {
  test.each([
    ["Bash(git push origin main)", true],
    ["Bash(git push origin main*)", true],
    ["Bash(git push origin HEAD:main)", true],
    ["Bash(git push * main *)", true],
    ["Bash(git push)", false],
    ["Bash(git push *)", true],
    ["Bash(git push:*)", true],
    ["Bash(git push origin domain-fix)", false],
    ["Bash(git push origin maintenance)", false],
    ["Bash(git push origin fbs/main-page)", false],
    ["Bash(git pull origin main)", false],
  ])("%p covers a push to main: %p", (rule, covers) => {
    expect(coversPush(rule, "main")).toBe(covers);
  });

  test("every suggested line covers the branch", () => {
    for (const rule of pushRules("main")) expect(coversPush(rule, "main")).toBe(true);
  });
});
