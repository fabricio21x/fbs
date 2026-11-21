import { projectConfig } from "./config";
import { commitOf, currentBranch, headTree } from "./git";
import { GhError, type GhRunner } from "./github";
import { readFeature } from "./status";
import type { Clock } from "./watch-pr";

/** CI can't stand in for the local suite here; the reason says why. */
export class CiRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`refused: ${reason}`);
    this.reason = reason;
  }
}

export type RunState = "success" | "running" | "missing" | "skipped" | "failed";

export interface RequiredRun {
  workflow: string;
  state: RunState;
  url?: string;
  /** How a failed run concluded: failure, cancelled, timed_out and so on. */
  conclusion?: string;
}

/** `evidence` only when every required workflow has a green run on `sha`. */
export interface CiEvidence {
  sha: string;
  tree: string;
  verdict: "evidence" | "wait" | "refused";
  runs: RequiredRun[];
}

const INTERVAL_MS = 30_000;
const TIMEOUT_MS = 60 * 60_000;

/**
 * Whether CI's runs on the feature branch's exact head stand in for the local suite: the newest run of each workflow
 * `verify.ciWorkflows` names must have concluded `success`. With `wait`, polls until none is running or missing, or the
 * timeout.
 */
export function ciEvidence(cwd: string, slug: string, gh: GhRunner, clock: Clock, options: { wait: boolean }): CiEvidence {
  const { verify } = projectConfig(cwd);
  if (verify?.ciEvidence !== true || verify.ciWorkflows === undefined) throw new CiRefusedError("verify.ciEvidence is off in .fbs/config.json: run the suite locally");
  const rec = readFeature(cwd, slug);
  if (rec.branch === undefined || currentBranch(cwd) !== rec.branch.name) throw new CiRefusedError(`${slug}'s branch ${rec.branch?.name ?? "(none recorded)"} is not checked out; check it out first`);
  if (rec.pr === null || rec.repo === undefined) throw new CiRefusedError(`${slug} has no PR yet: CI evidence counts only once the PR exists, so run the suite locally`);
  const sha = commitOf(cwd, "HEAD") as string;
  const tree = headTree(cwd);
  const required = verify.ciWorkflows;
  const deadline = clock.now() + TIMEOUT_MS;
  for (;;) {
    const runs = requiredRuns(gh, cwd, rec.repo, sha, required);
    const has = (...states: RunState[]) => runs.some(({ state }) => states.includes(state));
    const verdict = has("failed", "skipped") ? "refused" : has("running") ? "wait" : has("missing") ? "refused" : "evidence";
    if (!options.wait || has("failed", "skipped") || !has("running", "missing") || clock.now() >= deadline) return { sha, tree, verdict, runs };
    clock.sleep(INTERVAL_MS);
  }
}

interface WorkflowRun {
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  id: number;
}

/** The newest run on `sha` of each required workflow, as a state. */
function requiredRuns(gh: GhRunner, cwd: string, repo: string, sha: string, required: string[]): RequiredRun[] {
  const result = gh(["api", `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`], cwd);
  if (result.code !== 0) throw new GhError(`gh api actions/runs failed: ${result.stderr.split("\n")[0] || `exit ${result.code}`}`);
  let runs: WorkflowRun[];
  try {
    runs = (JSON.parse(result.stdout) as { workflow_runs: WorkflowRun[] }).workflow_runs;
  } catch {
    throw new GhError("gh api actions/runs printed invalid JSON");
  }
  if (!Array.isArray(runs)) throw new GhError("gh api actions/runs printed no workflow_runs");
  return required.map((workflow): RequiredRun => {
    const newest = runs
      .filter((run) => run.name === workflow && run.head_sha === sha)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)[0];
    if (newest === undefined) return { workflow, state: "missing" };
    const url = newest.html_url;
    if (newest.status !== "completed") return { workflow, state: "running", url };
    if (newest.conclusion === "success") return { workflow, state: "success", url };
    if (newest.conclusion === "skipped") return { workflow, state: "skipped", url };
    return { workflow, state: "failed", url, conclusion: newest.conclusion ?? "unknown" };
  });
}
