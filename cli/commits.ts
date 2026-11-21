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

/** A commit `fbs commits check` lists: its line, and whether it fails the check or only carries warnings. */
export interface CommitProblem {
  line: string;
  fails: boolean;
}

/**
 * One entry per non-merge commit on the feature's branch whose header isn't conventional or whose message breaks
 * commitlint config-conventional's rules (listed in brackets, warnings marked); empty when all pass. fixup!, squash!
 * and amend! commits are skipped, as commitlint skips them. Commits reachable from the parent branch (the default
 * branch for an adopted one), origin's copy or the local one, are left out, so merging it in brings none, even after
 * the local parent was rewritten.
 */
export function commitProblems(cwd: string, slug: string): CommitProblem[] {
  const { branch } = readFeature(cwd, slug);
  if (branch === undefined) throw new CommitsRefusedError(`no branch recorded for ${slug}`);
  const parent = branch.parent ?? defaultBranch(cwd);
  const parentRefs = parent === branch.name ? [] : [`refs/remotes/origin/${parent}`, `refs/heads/${parent}`].filter((ref) => commitOf(cwd, ref) !== null);
  return nonMergeCommits(cwd, branch.base, "HEAD", parentRefs).flatMap(({ sha, message }) => {
    const lines = message.split(/\r?\n/);
    const [header] = lines;
    if (/^(?:fixup|squash|amend)!/.test(header)) return [];
    const conventional = isConventionalSubject(header);
    const errors = messageErrors(lines, conventional);
    const warnings = lines.length > 1 && lines[1].trim() !== "" ? ["warning: no blank line after the header"] : [];
    const listed = [...errors, ...warnings];
    if (conventional && listed.length === 0) return [];
    return [{ line: `${sha.slice(0, 12)} ${header}${listed.length === 0 ? "" : ` [${listed.join("; ")}]`}`, fails: !conventional || errors.length > 0 }];
  });
}

const MAX_LINE = 100;

/** The config-conventional errors past the header's form: header-trim, header-max-length, subject-case, subject-full-stop, body and footer max-line-length. */
function messageErrors([header, ...rest]: string[], conventional: boolean): string[] {
  const errors: string[] = [];
  if (header !== header.trim()) errors.push("header has spaces around it");
  if (header.length > MAX_LINE) errors.push(`header is ${header.length} characters, over ${MAX_LINE}`);
  const subject = conventional ? header.slice(header.indexOf(": ") + 2) : "";
  // Sentence, start, pascal and upper case all start with a capital, which is what config-conventional's subject-case forbids.
  if (/^\p{Lu}/u.test(subject)) errors.push("subject starts with a capital letter");
  if (subject.trimEnd().endsWith(".")) errors.push("subject ends with a full stop");
  for (const [i, line] of rest.entries()) if (line.length > MAX_LINE) errors.push(`line ${i + 2} is ${line.length} characters, over ${MAX_LINE}`);
  return errors;
}
