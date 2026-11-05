import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class NotAGitRepoError extends Error {}

/** A git command that failed inside a repo, such as reading HEAD before the first commit. */
export class GitError extends Error {}

let gitBinary = "git";

/** Use this git executable instead of resolving `git` from PATH. */
export function setGitBinary(path: string): void {
  gitBinary = path;
}

function runGit(cwd: string, args: string[], env: Record<string, string> = {}): { ok: boolean; exitCode: number; stdout: string; stderr: string } {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    // A replace ref would let a stamped tree's hash stand for other content.
    result = Bun.spawnSync([gitBinary, ...args], { cwd, env: { ...envWithoutRepoOverrides(), GIT_NO_REPLACE_OBJECTS: "1", ...env }, stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new NotAGitRepoError(`cannot run git in ${cwd}: ${firstLine((e as Error).message)}`);
  }
  return { ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout?.toString() ?? "", stderr: result.stderr?.toString() ?? "" };
}

/** The stdout of `git <args>` in `cwd`; a failing command throws. */
export function gitOutput(cwd: string, args: string[]): string {
  const result = runGit(cwd, args);
  if (!result.ok) throw new GitError(`git ${args[0]} failed in ${cwd}: ${firstLine(result.stderr)}`);
  return result.stdout;
}

function revParse(cwd: string, args: string[]): string {
  const result = runGit(cwd, ["rev-parse", ...args]);
  if (!result.ok) throw new NotAGitRepoError(`not a git repository: ${cwd}: ${firstLine(result.stderr)}`);
  return result.stdout.trim();
}

const REPO_OVERRIDES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];

// The repo always comes from cwd, so vars that point git at another repo are dropped.
export function envWithoutRepoOverrides(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !REPO_OVERRIDES.includes(key)) env[key] = value;
  }
  return env;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0];
}

export function repoRoot(cwd: string): string {
  return revParse(cwd, ["--show-toplevel"]);
}

export function gitCommonDir(cwd: string): string {
  return revParse(cwd, ["--path-format=absolute", "--git-common-dir"]);
}

/** True when git ignores `path`, relative to the repo root; a tracked path never is. A trailing `/` asks about a directory, which needn't exist. */
export function isIgnored(cwd: string, path: string): boolean {
  const root = repoRoot(cwd);
  const result = runGit(root, ["check-ignore", "-q", "--", path]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new GitError(`cannot tell whether git ignores ${path} in ${root}: ${firstLine(result.stderr)}`);
}

/** The main worktree's root: the first one `git worktree list` names. */
export function mainWorktree(cwd: string): string {
  const [first, second] = gitOutput(cwd, ["worktree", "list", "--porcelain"]).split("\n");
  if (!first.startsWith("worktree ")) throw new GitError(`cannot find the main worktree of ${cwd}`);
  if (second === "bare") throw new GitError("local documents need a main worktree; this repo is bare");
  return first.slice("worktree ".length);
}

/** The root to read `path` from: the main worktree's when git ignores it, since a linked worktree has no copy of it; else this worktree's. */
export function rootFor(cwd: string, path: string): string {
  return isIgnored(cwd, path) ? mainWorktree(cwd) : repoRoot(cwd);
}

/** The tree hash of HEAD, which a commit rewrite that keeps the content keeps too. */
export function headTree(cwd: string): string {
  const result = runGit(cwd, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (!result.ok) throw new GitError(`cannot read the tree of HEAD in ${cwd}: ${firstLine(result.stderr)}`);
  return result.stdout.trim();
}

/** True when `git status` shows nothing: no staged, unstaged or untracked changes. */
export function isWorkTreeClean(cwd: string): boolean {
  // No optional locks, so a check never contends with git in another worktree; the explicit modes override config that hides untracked files or submodule changes.
  const result = runGit(cwd, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"]);
  if (!result.ok) throw new GitError(`cannot read the status of ${cwd}: ${firstLine(result.stderr)}`);
  return result.stdout === "";
}

/** The tracked paths in the index, relative to the repo root. */
export function trackedFiles(cwd: string): string[] {
  const result = runGit(cwd, ["ls-files", "-z", "--full-name"]);
  if (!result.ok) throw new GitError(`cannot list the tracked files of ${cwd}: ${firstLine(result.stderr)}`);
  return result.stdout.split("\0").filter((path) => path !== "");
}

/** The user's own excludes file: the global core.excludesFile, else git's XDG default; null when there is none. */
function userExcludesFile(cwd: string): string | null {
  // --global only: a core.excludesFile set in the repo's own config could hide anything.
  const configured = runGit(cwd, ["config", "--global", "--path", "--get", "core.excludesFile"]).stdout.trim();
  const path = configured !== "" ? configured : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git", "ignore");
  return existsSync(path) ? path : null;
}

/**
 * Untracked paths that neither a `.gitignore` nor the user's excludes file covers; `.git/info/exclude` hides nothing
 * here, except Claude Code's agent worktrees under `.claude/worktrees/`, which implement excludes there.
 */
export function untrackedNotIgnored(cwd: string): string[] {
  const excludes = userExcludesFile(cwd);
  // --no-empty-directory, or a `.claude/` holding only excluded worktrees is listed as an untracked directory.
  const args = ["ls-files", "-z", "--others", "--directory", "--no-empty-directory", "--exclude-per-directory=.gitignore", "--exclude=/.claude/worktrees/", ...(excludes === null ? [] : [`--exclude-from=${excludes}`])];
  const result = runGit(cwd, args);
  if (!result.ok) throw new GitError(`cannot list the untracked files of ${cwd}: ${firstLine(result.stderr)}`);
  return result.stdout.split("\0").filter((path) => path !== "");
}

/** Move the checked-out branch, index and work tree to `commit`. */
export function resetHard(cwd: string, commit: string): void {
  const result = runGit(cwd, ["reset", "--quiet", "--hard", commit]);
  if (!result.ok) throw new GitError(`cannot reset ${cwd} to ${commit}: ${firstLine(result.stderr)}`);
}

export type TreeFile = { kind: "file"; content: string } | { kind: "absent" } | { kind: "not-a-file" };

/** The regular file at `path`, relative to the repo root, in `tree`; a symlink, directory or submodule is not a file. */
export function fileInTree(cwd: string, tree: string, path: string): TreeFile {
  const listing = runGit(cwd, ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", tree, "--", path]);
  if (!listing.ok) throw new GitError(`cannot list ${path} in ${tree}: ${firstLine(listing.stderr)}`);
  const entry = listing.stdout.split("\0")[0];
  if (entry === "") return { kind: "absent" };
  const [mode, type, hash] = entry.split("\t")[0].split(" ");
  if (type !== "blob" || mode === "120000") return { kind: "not-a-file" };
  const blob = runGit(cwd, ["cat-file", "blob", hash]);
  if (!blob.ok) throw new GitError(`cannot read ${path} in ${tree}: ${firstLine(blob.stderr)}`);
  return { kind: "file", content: blob.stdout };
}

/** The branch `origin/HEAD` points at, such as `main`; null when the remote's HEAD isn't known locally. */
export function originDefaultBranch(cwd: string): string | null {
  const result = runGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  return result.ok ? result.stdout.trim().replace(/^origin\//, "") : null;
}

/** The checked-out branch; null on a detached HEAD. */
export function currentBranch(cwd: string): string | null {
  const result = runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.ok ? result.stdout.trim() : null;
}

// Messages that are parsed are read in the C locale.
const C_LOCALE = { LC_ALL: "C" };

/**
 * Fetch `branch` from origin into `origin/<branch>`, never prompting for credentials.
 * False when origin has no such branch, and a stale `origin/<branch>` is then removed.
 */
export function fetchOriginBranch(cwd: string, branch: string): boolean {
  const remoteRef = `refs/remotes/origin/${branch}`;
  const result = runGit(cwd, ["fetch", "--quiet", "origin", "--", `+refs/heads/${branch}:${remoteRef}`], { ...C_LOCALE, GIT_TERMINAL_PROMPT: "0" });
  if (result.ok) return true;
  if (!result.stderr.includes("couldn't find remote ref")) throw new GitError(`cannot fetch ${branch} from origin: ${firstLine(result.stderr)}`);
  runGit(cwd, ["update-ref", "-d", remoteRef]);
  return false;
}

export type PushOutcome = "pushed" | "forced" | "rejected";

/**
 * Push `commit` to origin's `branch`, never prompting for credentials. With `lease`, origin's branch
 * is overwritten only while it is at that commit. "rejected" when origin's branch has commits the push would drop
 * or isn't at `lease`; any other failure is thrown.
 */
export function pushBranch(cwd: string, branch: string, commit: string, lease: string | null): PushOutcome {
  const ref = `refs/heads/${branch}`;
  const force = lease === null ? [] : [`--force-with-lease=${ref}:${lease}`];
  const result = runGit(cwd, ["push", "--porcelain", ...force, "origin", `${commit}:${ref}`], { ...C_LOCALE, GIT_TERMINAL_PROMPT: "0" });
  const lines = result.stdout.split("\n");
  if (!result.ok) {
    if (lines.some((line) => /^!\t[^\t]*\t\[rejected\]/.test(line))) return "rejected";
    throw new GitError(`cannot push ${branch} to origin: ${firstLine(result.stderr)}`);
  }
  return lines.some((line) => line.startsWith("+\t")) ? "forced" : "pushed";
}

/** Delete origin's `branch` only while it is at `lease`; false when the lease failed: it moved or is gone. */
export function deleteOriginBranch(cwd: string, branch: string, lease: string): boolean {
  const ref = `refs/heads/${branch}`;
  const result = runGit(cwd, ["push", "--porcelain", `--force-with-lease=${ref}:${lease}`, "origin", `:${ref}`], { ...C_LOCALE, GIT_TERMINAL_PROMPT: "0" });
  if (result.ok) return true;
  if (result.stdout.split("\n").some((line) => /^!\t[^\t]*\t\[rejected\]/.test(line))) return false;
  throw new GitError(`cannot delete ${branch} on origin: ${firstLine(result.stderr)}`);
}

export function renameBranch(cwd: string, from: string, to: string): void {
  const result = runGit(cwd, ["branch", "--move", "--", from, to], C_LOCALE);
  if (!result.ok) throw new GitError(`cannot rename ${from} to ${to}: ${firstLine(result.stderr)}`);
}

/** Fetch `commit` from origin by its hash, never prompting for credentials; false when origin can't serve it. */
export function fetchCommit(cwd: string, commit: string): boolean {
  return runGit(cwd, ["fetch", "--quiet", "origin", commit], { ...C_LOCALE, GIT_TERMINAL_PROMPT: "0" }).ok;
}

/** Fetch `branch` from origin so its commits are readable here. */
export function fetchBranch(cwd: string, branch: string): void {
  if (!fetchOriginBranch(cwd, branch)) throw new GitError(`cannot fetch ${branch} from origin: origin has no branch ${branch}`);
}

export function hasRemote(cwd: string, name: string): boolean {
  return runGit(cwd, ["config", "--get", `remote.${name}.url`]).ok;
}

/** The commit `ref` points at; null when there is none. */
export function commitOf(cwd: string, ref: string): string | null {
  const result = runGit(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  return result.ok ? result.stdout.trim() : null;
}

/** The number of commits in `from..to`. */
export function commitsBetween(cwd: string, from: string, to: string): number {
  const result = runGit(cwd, ["rev-list", "--count", "--end-of-options", `${from}..${to}`]);
  if (!result.ok) throw new GitError(`cannot count ${from}..${to}: ${firstLine(result.stderr)}`);
  return Number(result.stdout.trim());
}

/** The number of non-merge commits `tip` has that none of `excluded` holds. */
export function commitsBeyond(cwd: string, tip: string, excluded: string[]): number {
  const result = runGit(cwd, ["rev-list", "--count", "--no-merges", "--end-of-options", tip, ...excluded.map((ref) => `^${ref}`)]);
  if (!result.ok) throw new GitError(`cannot count the commits of ${tip}: ${firstLine(result.stderr)}`);
  return Number(result.stdout.trim());
}

/** The best common ancestor of `a` and `b`; null when they share none. */
export function mergeBase(cwd: string, a: string, b: string): string | null {
  const result = runGit(cwd, ["merge-base", "--end-of-options", a, b]);
  return result.ok ? result.stdout.trim() : null;
}

/**
 * Switch to the branch `name`, or create it at `startPoint` without an upstream.
 * Returns the uncommitted files that block the switch, empty once switched.
 */
export function switchBranch(cwd: string, name: string, startPoint?: string): string[] {
  const args = startPoint === undefined ? ["switch", "--quiet", name] : ["switch", "--quiet", "--no-track", "-c", name, startPoint];
  const result = runGit(cwd, args, C_LOCALE);
  if (result.ok) return [];
  if (!result.stderr.includes("would be overwritten")) throw new GitError(`cannot switch to ${name}: ${firstLine(result.stderr)}`);
  return result.stderr
    .split("\n")
    .filter((line) => line.startsWith("\t"))
    .map((line) => line.trim());
}

/** The paths `git status` shows as staged, unstaged or untracked. */
export function uncommittedFiles(cwd: string): string[] {
  const result = runGit(cwd, ["--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=normal"]);
  if (!result.ok) throw new GitError(`cannot read the status of ${cwd}: ${firstLine(result.stderr)}`);
  const entries = result.stdout.split("\0");
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i] === "") continue;
    files.push(entries[i].slice(3));
    // A rename or copy is followed by its source path.
    if (/^[RC]|^.[RC]/.test(entries[i])) i++;
  }
  return files;
}

/**
 * Replay `upstream..branch` onto `onto`, leaving `branch` checked out; false on a conflict, after aborting
 * and going back to where HEAD was. Any other failure is undone the same way and thrown.
 */
export function rebaseOnto(cwd: string, onto: string, upstream: string, branch: string): boolean {
  const before = currentBranch(cwd);
  const beforeCommit = commitOf(cwd, "HEAD");
  const result = runGit(cwd, ["rebase", "--quiet", "--onto", onto, upstream, branch], C_LOCALE);
  if (result.ok) return true;
  runGit(cwd, ["rebase", "--abort"]);
  if (before !== null) runGit(cwd, ["switch", "--quiet", before]);
  else if (beforeCommit !== null) runGit(cwd, ["switch", "--quiet", "--detach", beforeCommit]);
  if (`${result.stdout}\n${result.stderr}`.includes("CONFLICT")) return false;
  throw new GitError(`cannot rebase ${branch} onto ${onto}: ${firstLine(result.stderr || result.stdout)}`);
}

/** Point the unborn `branch` at a new empty root commit; the index and work tree are left alone. */
export function makeEmptyRootCommit(cwd: string, branch: string, message: string): string {
  const tree = runGit(cwd, ["hash-object", "-t", "tree", "-w", "/dev/null"]);
  if (!tree.ok) throw new GitError(`cannot make the initial commit: ${firstLine(tree.stderr)}`);
  const commit = runGit(cwd, ["commit-tree", "-m", message, tree.stdout.trim()]);
  if (!commit.ok) throw new GitError(`cannot make the initial commit: ${commit.stderr.trim()}`);
  const sha = commit.stdout.trim();
  const update = runGit(cwd, ["update-ref", "-m", "fbs: initial commit", `refs/heads/${branch}`, sha, ""]);
  if (!update.ok) throw new GitError(`cannot make the initial commit: ${firstLine(update.stderr)}`);
  return sha;
}

/** Local and remote-tracking branch names, without `refs/heads/` or `refs/remotes/<remote>/`, each once. */
export function branchNames(cwd: string): string[] {
  const refs = gitOutput(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]).split("\n");
  const names = refs.flatMap((ref) => /^refs\/(?:heads|remotes\/[^/]+)\/(.+)$/.exec(ref)?.[1] ?? []);
  return [...new Set(names.filter((name) => name !== "HEAD"))];
}

/** The tree of `commit`; null when the commit isn't here. */
export function commitTree(cwd: string, commit: string): string | null {
  const result = runGit(cwd, ["rev-parse", "--verify", "--quiet", `${commit}^{tree}`]);
  return result.ok ? result.stdout.trim() : null;
}

/** A path that differs between two trees, with its mode on each side; `000000` where it is absent. */
export interface TreeChange {
  path: string;
  oldMode: string;
  newMode: string;
}

/** The paths that differ between the trees `from` and `to`, a rename as its two paths; null when `from` isn't a tree here. */
export function changedPaths(cwd: string, from: string, to: string): TreeChange[] | null {
  if (runGit(cwd, ["cat-file", "-t", from]).stdout.trim() !== "tree") return null;
  const result = runGit(cwd, ["diff-tree", "-r", "-z", "--no-renames", from, to]);
  if (!result.ok) throw new GitError(`cannot list the paths changed from ${from} to ${to}: ${firstLine(result.stderr)}`);
  const fields = result.stdout.split("\0");
  const changes: TreeChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode] = fields[i].slice(1).split(" ");
    changes.push({ path: fields[i + 1], oldMode, newMode });
  }
  return changes;
}

/** Every symlink in `tree`, with the target it holds. */
export function symlinksIn(cwd: string, tree: string): { path: string; target: string }[] {
  const listing = runGit(cwd, ["ls-tree", "-r", "-z", "--full-tree", tree]);
  if (!listing.ok) throw new GitError(`cannot list ${tree}: ${firstLine(listing.stderr)}`);
  return listing.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("120000 "))
    .map((entry) => {
      const [meta, path] = [entry.slice(0, entry.indexOf("\t")), entry.slice(entry.indexOf("\t") + 1)];
      const blob = runGit(cwd, ["cat-file", "blob", meta.split(" ")[2]]);
      if (!blob.ok) throw new GitError(`cannot read the symlink ${path} in ${tree}: ${firstLine(blob.stderr)}`);
      return { path, target: blob.stdout };
    });
}

/** The non-merge commits in `from..to` not reachable from any of `excluded`, oldest first, each with its subject line. */
export function nonMergeCommits(cwd: string, from: string, to: string, excluded: string[] = []): { sha: string; subject: string }[] {
  const revisions = [`${from}..${to}`, ...excluded.map((ref) => `^${ref}`)];
  // A signature check would print into the log, so it's off whatever the user's config says.
  const result = runGit(cwd, ["log", "--no-merges", "--reverse", "--no-show-signature", "--format=%H %s", "--end-of-options", ...revisions]);
  if (!result.ok) throw new GitError(`cannot list the commits in ${revisions.join(" ")}: ${firstLine(result.stderr)}`);
  return result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => ({ sha: line.slice(0, line.indexOf(" ")), subject: line.slice(line.indexOf(" ") + 1) }));
}

/** True when `ancestor` is reachable from `commit`, or is it. */
export function isAncestor(cwd: string, ancestor: string, commit: string): boolean {
  const result = runGit(cwd, ["merge-base", "--is-ancestor", "--end-of-options", ancestor, commit]);
  if (result.ok) return true;
  if (result.stderr.trim() === "") return false;
  throw new GitError(`cannot tell whether ${ancestor} is in ${commit}: ${firstLine(result.stderr)}`);
}

/** Add a worktree at `path` with a detached HEAD at `commit`. */
export function addDetachedWorktree(cwd: string, path: string, commit: string): void {
  const result = runGit(cwd, ["worktree", "add", "--quiet", "--detach", path, commit]);
  if (!result.ok) throw new GitError(`cannot add a worktree at ${path}: ${firstLine(result.stderr)}`);
}

export function removeWorktree(cwd: string, path: string): void {
  const result = runGit(cwd, ["worktree", "remove", "--force", path]);
  if (!result.ok) throw new GitError(`cannot remove the worktree at ${path}: ${firstLine(result.stderr)}`);
}

/** The worktree that has `branch` checked out; null when none has. */
export function worktreeOf(cwd: string, branch: string): string | null {
  let path: string | null = null;
  for (const line of gitOutput(cwd, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

/** Fast-forward the checked-out branch to `commit`. */
export function fastForward(cwd: string, commit: string): void {
  const result = runGit(cwd, ["merge", "--quiet", "--ff-only", "--end-of-options", commit], C_LOCALE);
  if (!result.ok) throw new GitError(`cannot fast-forward to ${commit}: ${firstLine(result.stderr)}`);
}

/**
 * Merge `ref` into HEAD with a default message and no hooks; `ours` records it as merged while keeping HEAD's tree.
 * False on a conflict, after aborting the merge; any other failure is aborted the same way and thrown.
 */
export function mergeInto(cwd: string, ref: string, strategy: "ours" | null = null): boolean {
  const args = ["merge", "--quiet", "--no-edit", "--no-verify", ...(strategy === null ? [] : ["-s", strategy]), "--end-of-options", ref];
  const result = runGit(cwd, args, C_LOCALE);
  if (result.ok) return true;
  runGit(cwd, ["merge", "--abort"]);
  if (`${result.stdout}\n${result.stderr}`.includes("CONFLICT")) return false;
  throw new GitError(`cannot merge ${ref}: ${firstLine(result.stderr || result.stdout)}`);
}

/** Move `ref` to `commit` only while it is at `old`; an empty `old` creates it. */
export function updateRef(cwd: string, ref: string, commit: string, old: string): void {
  const result = runGit(cwd, ["update-ref", ref, commit, old]);
  if (!result.ok) throw new GitError(`cannot move ${ref} to ${commit}: ${firstLine(result.stderr)}`);
}
