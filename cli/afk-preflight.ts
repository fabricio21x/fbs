import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitCommonDir, originDefaultBranch, repoRoot } from "./git";
import type { GhRunner } from "./github";

export interface Preflight {
  branch: string;
  merge_denied: boolean;
  push_denied: boolean;
  /** null when GitHub couldn't tell. */
  branch_protected: boolean | null;
  suggest: string[];
  cached: boolean;
}

/**
 * Does the user's setup deny merges and default-branch pushes, and is the default branch protected?
 * It reports and never fails the run; a known answer is recorded so it is asked once per repo.
 */
export function preflight(cwd: string, gh: GhRunner, userSettings: string, force: boolean): Preflight {
  const path = join(gitCommonDir(cwd), "fbs", "afk", "preflight.json");
  if (!force && existsSync(path)) {
    try {
      return { ...(JSON.parse(readFileSync(path, "utf8")) as Preflight), cached: true };
    } catch {}
  }
  const root = repoRoot(cwd);
  const denies = [userSettings, join(root, ".claude", "settings.json"), join(root, ".claude", "settings.local.json")].flatMap(denyRules);
  const repo = ghRepo(gh, root);
  const branch = originDefaultBranch(root) ?? repo?.branch ?? "main";
  const mergeDenied = denies.some((rule) => rule.includes("gh pr merge"));
  const pushDenied = denies.some((rule) => coversPush(rule, branch));
  const suggest = [...(mergeDenied ? [] : ["Bash(gh pr merge *)"]), ...(pushDenied ? [] : pushRules(branch))];
  const result: Preflight = { branch, merge_denied: mergeDenied, push_denied: pushDenied, branch_protected: repo === null ? null : branchProtected(gh, root, repo.name, branch), suggest, cached: false };
  if (result.branch_protected !== null) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(result)}\n`);
  }
  return result;
}

/** Deny rules for a push to `branch`, as `origin main` or `HEAD:main`, alone or followed by flags. */
export function pushRules(branch: string): string[] {
  return [`Bash(git push * ${branch})`, `Bash(git push * ${branch} *)`, `Bash(git push *:${branch})`, `Bash(git push *:${branch} *)`];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A wildcard deny rule that stops every `git push` (a bare `git push` doesn't), or one naming `branch` as a whole word. */
export function coversPush(rule: string, branch: string): boolean {
  const at = rule.indexOf("git push");
  if (at === -1) return false;
  const rest = rule.slice(at + "git push".length);
  if (/^(\s*\*|:\*)\s*\)?\s*$/.test(rest)) return true;
  return new RegExp(`(^|[\\s:(])${escape(branch)}([\\s)*]|$)`).test(rest);
}

/** The `permissions.deny` and `autoMode.hard_deny` entries of a settings file; none when it is missing or unreadable. */
function denyRules(path: string): string[] {
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (typeof settings !== "object" || settings === null) return [];
  const { permissions, autoMode } = settings as { permissions?: { deny?: unknown }; autoMode?: { hard_deny?: unknown } };
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  return [...list(permissions?.deny), ...list(autoMode?.hard_deny)];
}

function ghJson(gh: GhRunner, cwd: string, args: string[]): Record<string, unknown> | unknown[] | null {
  const result = gh(args, cwd);
  if (result.code !== 0) return null;
  try {
    const value = JSON.parse(result.stdout);
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}

function ghRepo(gh: GhRunner, cwd: string): { name: string; branch: string } | null {
  const raw = ghJson(gh, cwd, ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]) as { nameWithOwner?: unknown; defaultBranchRef?: { name?: unknown } } | null;
  if (typeof raw?.nameWithOwner !== "string" || typeof raw.defaultBranchRef?.name !== "string") return null;
  return { name: raw.nameWithOwner, branch: raw.defaultBranchRef.name };
}

function branchProtected(gh: GhRunner, cwd: string, repo: string, branch: string): boolean | null {
  const info = ghJson(gh, cwd, ["api", `repos/${repo}/branches/${branch}`]) as { protected?: unknown } | null;
  if (typeof info?.protected !== "boolean") return null;
  if (info.protected) return true;
  const rules = ghJson(gh, cwd, ["api", `repos/${repo}/rules/branches/${branch}`]);
  return Array.isArray(rules) ? rules.length > 0 : null;
}
