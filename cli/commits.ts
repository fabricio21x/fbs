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
 * One line per non-merge commit on the feature's branch whose header isn't conventional or whose message breaks
 * commitlint config-conventional's limits (listed in brackets); empty when all pass. Commits reachable
 * from the parent branch (the default branch for an adopted one), origin's copy or the local one, are left out, so
 * merging it in brings none, even after the local parent was rewritten.
 */
export function commitProblems(cwd: string, slug: string): string[] {
  const { branch } = readFeature(cwd, slug);
  if (branch === undefined) throw new CommitsRefusedError(`no branch recorded for ${slug}`);
  const parent = branch.parent ?? defaultBranch(cwd);
  const parentRefs = parent === branch.name ? [] : [`refs/remotes/origin/${parent}`, `refs/heads/${parent}`].filter((ref) => commitOf(cwd, ref) !== null);
  return nonMergeCommits(cwd, branch.base, "HEAD", parentRefs).flatMap(({ sha, message }) => {
    const [header] = message.split("\n");
    const limits = messageProblems(message);
    if (isConventionalSubject(header) && limits.length === 0) return [];
    return [`${sha.slice(0, 12)} ${header}${limits.length === 0 ? "" : ` [${limits.join("; ")}]`}`];
  });
}

const MAX_LINE = 100;

/** Where a message breaks commitlint config-conventional's header-max-length, body-leading-blank and body and footer max-line-length. */
function messageProblems(message: string): string[] {
  const [header, ...rest] = message.split("\n");
  const problems: string[] = [];
  if (header.length > MAX_LINE) problems.push(`header is ${header.length} characters, over ${MAX_LINE}`);
  if (rest.length > 0 && rest[0].trim() !== "") problems.push("no blank line after the header");
  for (const [i, line] of rest.entries()) if (line.length > MAX_LINE) problems.push(`line ${i + 2} is ${line.length} characters, over ${MAX_LINE}`);
  return problems;
}
