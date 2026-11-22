import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { changedPaths, commitOf, commitTree, currentBranch, fileInTree, headTree, isIgnored, isWorkTreeClean, mainWorktree, repoRoot, symlinksIn, type TreeChange, worktreeOf } from "./git";
import { assertToday, type DocKind, docsDir, documentsRecord, type FeatureRecord, isApprovalCurrent, isRepoPath, isUnit, plannedUnit, readFeature, type RolloutCriterion, type Size, sha256, updateFeature } from "./status";
import { normalizeLines } from "./text";
import { acceptanceCriteria, criterionBlocks, parseWorkUnits, unitSection } from "./work-units";

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
    const { rollout: _, ...rest } = rec;
    const rollout = rolloutCriteria(cwd, rec);
    return { ...rest, stamp: { tree, at: today, verdict: "pass", criteria: countCriteria(verdict), evidence: verdictPath, ...local }, ...(rollout.length > 0 && { rollout }) };
  });
}

/**
 * The spec's criteria marked `(rollout)` that the record is verified on (a unit's are the ones it covers), keeping the
 * outcome already recorded for one whose text is unchanged.
 */
function rolloutCriteria(cwd: string, rec: FeatureRecord): RolloutCriterion[] {
  const spec = join(docsDir(cwd, rec), "spec.md");
  if (!existsSync(spec)) return [];
  const covered = isUnit(rec) ? (plannedUnit(cwd, rec)?.covers ?? []) : null;
  return acceptanceCriteria(readFileSync(spec, "utf8")).flatMap(({ rollout, dropped, text }, i) => {
    const ac = i + 1;
    if (!rollout || dropped || (covered !== null && !covered.includes(ac))) return [];
    const plain = text.replace(/^\(rollout\)\s+/i, "");
    return [rec.rollout?.find((known) => known.ac === ac && known.text === plain) ?? { ac, text: plain }];
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
 * document in the feature's folder that verify doesn't read and isn't the stamp's verdict, or the agent's instructions;
 * null when the stamp already covers the tree.
 */
export function carryStamp(cwd: string, slug: string): Carried | null {
  let carried: Carried | null = null;
  updateFeature(cwd, slug, (rec) => {
    const { stamp } = rec;
    if (!stamp) throw new StampRefusedError(["no stamp to carry; verify first"]);
    if (rec.branch !== undefined && currentBranch(cwd) !== rec.branch.name) {
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
    else if (changes.length > 0) reasons.push(...uncarriable(cwd, { from: stamp.tree, to: tree, changes, dir: documentsRecord(cwd, rec).dir, evidence: stamp.evidence, unit: rec.unit ?? null }));
    if (headTree(cwd) !== tree) reasons.push("HEAD moved during the carry");
    if (reasons.length > 0 || changes === null) throw new StampRefusedError(reasons);

    if (tree === stamp.tree) return rec;
    carried = { from: stamp.tree, to: tree, paths: changes.map((change) => change.path) };
    return { ...rec, stamp: { ...stamp, tree, verifiedTree: stamp.verifiedTree ?? stamp.tree } };
  });
  return carried;
}

const NOT_A_PLAIN_FILE: Record<string, string> = { "100755": "an executable", "120000": "a symlink", "160000": "a submodule" };

interface CarryChanges {
  from: string;
  to: string;
  changes: TreeChange[];
  /** The feature's documents folder; a unit's is its feature's. */
  dir: string;
  evidence: string;
  /** The unit's number in its feature's stack; null for a feature. */
  unit: number | null;
}

/**
 * One reason per changed path a carry can't cover, and per symlink in `to` into the documents folder, the first few of
 * them and a count of the rest. Only plain .md and .html files carry, since nothing runs them.
 */
function uncarriable(cwd: string, { from, to, changes, dir, evidence, unit }: CarryChanges): string[] {
  const reasons = changes.flatMap(({ path, oldMode, newMode }) => {
    const why = (reason: string) => [`${path} changed: ${reason}`];
    const mode = newMode === "000000" ? oldMode : newMode;
    if (isAgentInstructions(path)) return mode === "100644" ? [] : why(NOT_A_PLAIN_FILE[mode] ?? `not a regular file (mode ${mode})`);
    if (!path.startsWith(`${dir}/`)) return why(`outside the feature's documents (${dir}/)`);
    if (path === evidence) return why("it is the stamp's verdict");
    const name = posix.basename(path).toLowerCase();
    if (VERIFY_INPUTS.includes(name)) {
      const plain = oldMode === "100644" && newMode === "100644";
      const reason = unit !== null && plain && [`${dir}/spec.md`, `${dir}/design.md`].includes(path) ? unitDocumentChange(cwd, from, to, dir, path, unit) : "verify reads it";
      return reason === null ? [] : why(reason);
    }
    if (mode !== "100644") return why(NOT_A_PLAIN_FILE[mode] ?? `not a regular file (mode ${mode})`);
    if (name.startsWith("afk")) return why("an afk file, which the afk flow runs");
    if (!name.endsWith(".md") && !name.endsWith(".html")) return why("not a plain document (only .md or .html files carry)");
    return [];
  });
  const links = resolvedLinks(cwd, to);
  reasons.push(...links.filter(({ at }) => reaches(at, dir)).map(({ path }) => `${path} is a symlink into the feature's documents (${dir}/): content outside them can depend on them`));
  const instructions = changes.map(({ path }) => path).filter(isAgentInstructions);
  for (const { path, at } of links.filter((link) => !isAgentInstructions(link.path))) {
    const target = instructions.find((changed) => reaches(at, changed));
    if (target !== undefined) reasons.push(`${path} is a symlink to ${target}, which changed: content outside the agent's instructions can depend on it`);
  }
  if (reasons.length <= MAX_PATH_REASONS) return reasons;
  return [...reasons.slice(0, MAX_PATH_REASONS), `${reasons.length - MAX_PATH_REASONS} more changed paths can't be carried`];
}

/** A file named exactly CLAUDE.md or AGENTS.md, at any depth: it instructs the agent, not the product. */
function isAgentInstructions(path: string): boolean {
  return ["CLAUDE.md", "AGENTS.md"].includes(posix.basename(path));
}

/**
 * Why a change to the feature's spec or design reaches what unit `unit` is verified on: its own section of the design,
 * or the criteria that section covers; null when it doesn't.
 */
function unitDocumentChange(cwd: string, from: string, to: string, dir: string, path: string, unit: number): string | null {
  const read = (tree: string, file: string) => {
    const found = fileInTree(cwd, tree, file);
    return found.kind === "file" ? found.content : null;
  };
  const [before, after] = [read(from, path), read(to, path)];
  if (before === null || after === null) return "verify reads it";
  if (path.endsWith("/design.md")) {
    const section = unitSection(before, unit);
    return section !== null && section === unitSection(after, unit) ? null : `it changes U${unit}'s section of the design, which verify reads`;
  }
  const covers = parseWorkUnits(read(to, `${dir}/design.md`) ?? "").units?.find((planned) => planned.number === unit)?.covers;
  if (covers === undefined) return "verify reads it";
  const [old, now] = [criterionBlocks(before), criterionBlocks(after)];
  const changed = covers.filter((ac) => old[ac - 1] === undefined || old[ac - 1] !== now[ac - 1]);
  return changed.length === 0 ? null : `it changes ${changed.map((ac) => `AC${ac}`).join(", ")}, which U${unit} covers`;
}

/** The symlinks in `tree`, each with its target resolved from the link's directory, lowercased. */
function resolvedLinks(cwd: string, tree: string): { path: string; at: string }[] {
  const root = repoRoot(cwd);
  return symlinksIn(cwd, tree).map(({ path, target }) => {
    const resolved = target.startsWith("/") ? posix.relative(root, target) : posix.normalize(posix.join(posix.dirname(path), target));
    // Lowercased, since a case-insensitive file system resolves Docs/ to docs/.
    return { path, at: (resolved.replace(/\/+$/, "") || ".").toLowerCase() };
  });
}

/** True when a link resolving to `at` reaches `path`: it is `path`, inside it or one of its parents. */
function reaches(at: string, path: string): boolean {
  const target = path.toLowerCase();
  return at === "." || at === target || at.startsWith(`${target}/`) || target.startsWith(`${at}/`);
}

/**
 * Why the stamp doesn't cover the work tree as it is now; empty when it does. A record whose branch isn't the one
 * checked out is judged on its branch's tip instead, the local one else origin's; a detached HEAD is judged on itself.
 */
export function stampProblems(cwd: string, rec: FeatureRecord): string[] {
  if (!rec.stamp) return ["missing: no stamp"];
  const problems: string[] = [];
  const checkedOut = currentBranch(cwd);
  const elsewhere = rec.branch !== undefined && checkedOut !== null && checkedOut !== rec.branch.name ? rec.branch.name : null;
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
