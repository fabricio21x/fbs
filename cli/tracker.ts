import { projectConfig, type Tracker } from "./config";
import { branchNames } from "./git";
import type { GhRunner } from "./github";

/** What `fbs tracker detect` found, for plan to propose a tracker setting; it decides nothing itself. */
export interface TrackerEvidence {
  config: Tracker | "unset";
  branchIds: { prefix: string; count: number; examples: string[] }[];
  /** Merged PRs whose body links each tracker; null when gh can't tell. */
  prLinks: { linear: number; github: number; jira: number } | null;
  /** How many issues `gh issue list` returns, at most 20; null when gh can't tell. */
  issues: number | null;
}

// A ticket id at the start of a branch name or of a path segment, as trackers name branches (`feature/acm-1-x`, `alex/acm-1-x`).
const BRANCH_ID = /(?:^|\/)([A-Za-z]+)-[0-9]+(?=$|[-_./])/g;
const LINKS = {
  linear: /linear\.app\/\S*\/issue\//i,
  github: /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#[0-9]+/i,
  jira: /atlassian\.net\/browse\//i,
};
const EXAMPLES = 3;

export function detectTracker(cwd: string, gh: GhRunner): TrackerEvidence {
  const { tracker } = projectConfig(cwd);
  return { config: tracker ?? "unset", branchIds: branchIds(branchNames(cwd)), prLinks: prLinks(cwd, gh), issues: issueCount(cwd, gh) };
}

function branchIds(names: string[]): TrackerEvidence["branchIds"] {
  const byPrefix = new Map<string, string[]>();
  for (const name of names) {
    const prefixes = new Set([...name.matchAll(BRANCH_ID)].map((match) => match[1].toLowerCase()).filter((prefix) => prefix !== "issue"));
    for (const prefix of prefixes) byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
  }
  return [...byPrefix]
    .map(([prefix, found]) => ({ prefix, count: found.length, examples: found.sort().slice(0, EXAMPLES) }))
    .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
}

function prLinks(cwd: string, gh: GhRunner): TrackerEvidence["prLinks"] {
  const prs = ghJson(gh, ["pr", "list", "--state", "merged", "--limit", "30", "--json", "body"], cwd);
  if (prs === null) return null;
  const bodies = prs.map((pr) => (typeof pr === "object" && pr !== null && "body" in pr && typeof pr.body === "string" ? pr.body : ""));
  const count = (pattern: RegExp) => bodies.filter((body) => pattern.test(body)).length;
  return { linear: count(LINKS.linear), github: count(LINKS.github), jira: count(LINKS.jira) };
}

function issueCount(cwd: string, gh: GhRunner): number | null {
  return ghJson(gh, ["issue", "list", "--state", "all", "--limit", "20", "--json", "number"], cwd)?.length ?? null;
}

/** The JSON array gh prints; null when gh is missing, fails or prints something else. */
function ghJson(gh: GhRunner, args: string[], cwd: string): unknown[] | null {
  const result = gh(args, cwd);
  if (result.code !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
