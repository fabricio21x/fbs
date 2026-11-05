import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { changedPaths, commitOf, commitTree, currentBranch, fileInTree, headTree, isIgnored, isWorkTreeClean, mainWorktree, repoRoot, symlinksIn, type TreeChange, worktreeOf } from "./git";
import { assertToday, type DocKind, documentsRecord, type FeatureRecord, isApprovalCurrent, isRepoPath, isUnit, readFeature, type Size, sha256, updateFeature } from "./status";
import { normalizeLines } from "./text";

export class StampRefusedError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super("stamp refused");
    this.reasons = reasons;
  }
}

const REQUIRED_APPROVALS: Record<Size, DocKind[]> = { tiny: [], bug: [], mid: ["spec"], big: ["spec", "design"] };

/** The number of verified acceptance criteria: lines that start with `- [x] ` under a `## Criteria` heading. */
export function countCriteria(verdict: string): number {
  let inCriteria = false;
  let count = 0;
  for (const { text } of normalizeLines(verdict)) {
    if (text.startsWith("## ")) inCriteria = text === "## Criteria";
    else if (inCriteria && text.startsWith("- [x] ")) count++;
  }
  return count;
}

function isPassing(verdict: string): boolean {
  return normalizeLines(verdict).some((line) => line.text === "Verdict: pass");
}

/**
 * Record a passing verdict for the committed tree; `verdictPath` is relative to the repo root. A tracked verdict is read
 * from that tree; one git ignores is read from the main worktree and bound by its sha256.
 */
export function setStamp(cwd: string, slug: string, verdictPath: string, today: string): FeatureRecord {
  assertToday(today);
  return updateFeature(cwd, slug, (rec) => {
    const tree = headTree(cwd);
    const reasons: string[] = [];
    if (!isWorkTreeClean(cwd)) reasons.push("uncommitted changes");
    reasons.push(...approvalProblems(cwd, rec));

    let verdict = "";
    let verdictSha256: string | null = null;
    if (!isRepoPath(verdictPath)) reasons.push(`verdict path ${verdictPath} must be relative to the repo root, inside the repo`);
    else if (isIgnored(cwd, verdictPath)) {
      const bytes = localVerdict(cwd, verdictPath);
      if (bytes === null) reasons.push(`local verdict file ${verdictPath} is not a regular file in ${mainWorktree(cwd)}`);
      else if (!isPassing(bytes.toString("utf8"))) reasons.push(`verdict file ${verdictPath} has no line "Verdict: pass"`);
      else {
        verdict = bytes.toString("utf8");
        verdictSha256 = sha256(bytes);
      }
    } else {
      const file = fileInTree(cwd, tree, verdictPath);
      if (file.kind === "absent") {
        const onDisk = existsSync(join(repoRoot(cwd), verdictPath));
        reasons.push(`verdict file ${verdictPath} ${onDisk ? "is not committed" : "does not exist"}`);
      } else if (file.kind === "not-a-file") reasons.push(`verdict file ${verdictPath} is not a regular file`);
      else if (!isPassing(file.content)) reasons.push(`verdict file ${verdictPath} has no line "Verdict: pass"`);
      else verdict = file.content;
    }
    if (headTree(cwd) !== tree) reasons.push("HEAD moved during stamping");
    if (reasons.length > 0) throw new StampRefusedError(reasons);

    const local = verdictSha256 !== null && { verdictSha256 };
    return { ...rec, stamp: { tree, at: today, verdict: "pass", criteria: countCriteria(verdict), evidence: verdictPath, ...local } };
  });
}

const VERIFY_INPUTS = ["spec.md", "design.md", "bug.md", "plan.md"];
const MAX_PATH_REASONS = 10;

export interface Carried {
  from: string;
  to: string;
  paths: string[];
}

/**
 * Move the stamp onto the committed tree without verifying again, when every path changed since the stamped tree is a
 * document in the feature's folder that verify doesn't read and isn't the stamp's verdict; null when the stamp already
 * covers the tree.
 */
export function carryStamp(cwd: string, slug: string): Carried | null {
  let carried: Carried | null = null;
  updateFeature(cwd, slug, (rec) => {
    const { stamp } = rec;
    if (!stamp) throw new StampRefusedError(["no stamp to carry; verify first"]);
    if (isUnit(rec) && rec.branch !== undefined && currentBranch(cwd) !== rec.branch.name) {
      const checkout = worktreeOf(cwd, rec.branch.name);
      const where = checkout === null ? "is not checked out; check it out first" : `is checked out in another worktree; run it in ${checkout}`;
      throw new StampRefusedError([`${slug}'s branch ${rec.branch.name} ${where}`]);
    }
    const tree = headTree(cwd);
    const reasons: string[] = [];
    if (!isWorkTreeClean(cwd)) reasons.push("uncommitted changes");
    reasons.push(...approvalProblems(cwd, rec));
    if (stamp.verdictSha256 !== undefined) {
      const bytes = localVerdict(cwd, stamp.evidence);
      if (bytes === null) reasons.push(`local verdict file ${stamp.evidence} is missing from ${mainWorktree(cwd)}`);
      else if (sha256(bytes) !== stamp.verdictSha256) reasons.push(`local verdict file ${stamp.evidence} changed since the stamp`);
    }
    const changes = tree === stamp.tree ? [] : changedPaths(cwd, stamp.tree, tree);
    if (changes === null) reasons.push(`the stamped tree ${stamp.tree} is not in this repo; verify again`);
    else if (changes.length > 0) reasons.push(...uncarriable(cwd, tree, changes, documentsRecord(cwd, rec).dir, stamp.evidence));
    if (headTree(cwd) !== tree) reasons.push("HEAD moved during the carry");
    if (reasons.length > 0 || changes === null) throw new StampRefusedError(reasons);

    if (tree === stamp.tree) return rec;
    carried = { from: stamp.tree, to: tree, paths: changes.map((change) => change.path) };
    return { ...rec, stamp: { ...stamp, tree, verifiedTree: stamp.verifiedTree ?? stamp.tree } };
  });
  return carried;
}

const NOT_A_PLAIN_FILE: Record<string, string> = { "100755": "an executable", "120000": "a symlink", "160000": "a submodule" };

/**
 * One reason per changed path a carry can't cover, and per symlink in `tree` into the documents folder, the first few of
 * them and a count of the rest. Only plain .md and .html files carry, since nothing runs them.
 */
function uncarriable(cwd: string, tree: string, changes: TreeChange[], dir: string, evidence: string): string[] {
  const reasons = changes.flatMap(({ path, oldMode, newMode }) => {
    const why = (reason: string) => [`${path} changed: ${reason}`];
    if (!path.startsWith(`${dir}/`)) return why(`outside the feature's documents (${dir}/)`);
    if (path === evidence) return why("it is the stamp's verdict");
    const name = posix.basename(path).toLowerCase();
    if (VERIFY_INPUTS.includes(name)) return why("verify reads it");
    const mode = newMode === "000000" ? oldMode : newMode;
    if (mode !== "100644") return why(NOT_A_PLAIN_FILE[mode] ?? `not a regular file (mode ${mode})`);
    if (name.startsWith("afk")) return why("an afk file, which the afk flow runs");
    if (!name.endsWith(".md") && !name.endsWith(".html")) return why("not a plain document (only .md or .html files carry)");
    return [];
  });
  reasons.push(...linksInto(cwd, tree, dir).map((link) => `${link} is a symlink into the feature's documents (${dir}/): content outside them can depend on them`));
  if (reasons.length <= MAX_PATH_REASONS) return reasons;
  return [...reasons.slice(0, MAX_PATH_REASONS), `${reasons.length - MAX_PATH_REASONS} more changed paths can't be carried`];
}

/** The symlinks in `tree` whose target, resolved from the link's directory, is `dir`, inside it or one of its parents. */
function linksInto(cwd: string, tree: string, dir: string): string[] {
  const root = repoRoot(cwd);
  const folder = dir.toLowerCase();
  return symlinksIn(cwd, tree).flatMap(({ path, target }) => {
    const resolved = target.startsWith("/") ? posix.relative(root, target) : posix.normalize(posix.join(posix.dirname(path), target));
    // Lowercased, since a case-insensitive file system resolves Docs/ to docs/.
    const at = (resolved.replace(/\/+$/, "") || ".").toLowerCase();
    const reaches = at === "." || at === folder || at.startsWith(`${folder}/`) || folder.startsWith(`${at}/`);
    return reaches ? [path] : [];
  });
}

/**
 * Why the stamp doesn't cover the work tree as it is now; empty when it does. A unit whose branch isn't checked out
 * is judged on its branch's tip instead, the local one else origin's.
 */
export function stampProblems(cwd: string, rec: FeatureRecord): string[] {
  if (!rec.stamp) return ["missing: no stamp"];
  const problems: string[] = [];
  const elsewhere = isUnit(rec) && rec.branch !== undefined && currentBranch(cwd) !== rec.branch.name ? rec.branch.name : null;
  if (elsewhere === null) {
    if (rec.stamp.tree !== headTree(cwd)) problems.push("stale: tree changed");
    if (!isWorkTreeClean(cwd)) problems.push("dirty: uncommitted changes");
  } else {
    const tip = [`refs/heads/${elsewhere}`, `refs/remotes/origin/${elsewhere}`].map((ref) => commitOf(cwd, ref)).find((commit) => commit !== null);
    if (tip === undefined) problems.push(`stale: branch ${elsewhere} is gone`);
    else if (commitTree(cwd, tip) !== rec.stamp.tree) problems.push("stale: tree changed");
  }
  if (rec.stamp.verdictSha256 !== undefined) {
    const bytes = localVerdict(cwd, rec.stamp.evidence);
    if (bytes === null) problems.push("missing: verdict file");
    else if (sha256(bytes) !== rec.stamp.verdictSha256) problems.push("stale: verdict changed");
  }
  problems.push(...approvalProblems(cwd, rec).map((problem) => `stale: ${problem}`));
  return problems;
}

/** A local verdict's bytes from the main worktree; null when it isn't a regular file there. */
function localVerdict(cwd: string, path: string): Buffer | null {
  const full = join(mainWorktree(cwd), path);
  return lstatSync(full, { throwIfNoEntry: false })?.isFile() ? readFileSync(full) : null;
}

/** The required approvals that are missing or no longer match their documents; a unit goes by its feature's. */
function approvalProblems(cwd: string, rec: FeatureRecord): string[] {
  const owner = documentsRecord(cwd, rec);
  return REQUIRED_APPROVALS[owner.size].flatMap((kind) => {
    if (!owner.approvals[kind]) return [`${kind} not approved`];
    return isApprovalCurrent(cwd, owner, kind) ? [] : [`${kind} changed since its approval`];
  });
}

export function checkStamp(cwd: string, slug: string): string[] {
  return stampProblems(cwd, readFeature(cwd, slug));
}
