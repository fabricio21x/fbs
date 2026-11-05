import { defaultBranch } from "./branch";
import { commitOf, nonMergeCommits } from "./git";
import { readFeature } from "./status";

/** A check fbs can't run, such as on a feature with no recorded branch. */
export class CommitsRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`refused: ${reason}`);
    this.reason = reason;
  }
}

const TYPES = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];

const CONVENTIONAL = new RegExp(`^(${TYPES.join("|")})(\\([^()\\r\\n]+\\))?!?: \\S.*$`);

/**
 * `<type>[(<scope>)][!]: <description>` per Conventional Commits 1.0, with one of commitlint config-conventional's
 * lowercase types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test. So `Feat: x` fails.
 */
export function isConventionalSubject(subject: string): boolean {
  return CONVENTIONAL.test(subject);
}

/**
 * One line per non-merge commit on the feature's branch that isn't conventional; empty when all are. Commits reachable
 * from the parent branch (the default branch for an adopted one), origin's copy or the local one, are left out, so
 * merging it in brings none, even after the local parent was rewritten.
 */
export function commitProblems(cwd: string, slug: string): string[] {
  const { branch } = readFeature(cwd, slug);
  if (branch === undefined) throw new CommitsRefusedError(`no branch recorded for ${slug}`);
  const parent = branch.parent ?? defaultBranch(cwd);
  const parentRefs = parent === branch.name ? [] : [`refs/remotes/origin/${parent}`, `refs/heads/${parent}`].filter((ref) => commitOf(cwd, ref) !== null);
  return nonMergeCommits(cwd, branch.base, "HEAD", parentRefs)
    .filter(({ subject }) => !isConventionalSubject(subject))
    .map(({ sha, subject }) => `${sha.slice(0, 12)} ${subject}`);
}
