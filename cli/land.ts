import { rmSync } from "node:fs";
import { markLanded } from "./afk";
import { campMarkerPath, isSlug, type LandRequest, landTokenSlug, pendingLandRequest, REQUEST_TTL_MS, takeLandToken, writeLandRequest } from "./guard";
import { commitTree, fetchBranch, gitCommonDir } from "./git";
import { GhError, type GhRunner } from "./github";
import { plainFeaturesOn, type Restack, restackAbove, restackUnits } from "./stack";
import { type FeatureRecord, type OverCheck, featurePr, featureUnits, isUnit, nextToLand, readFeature, StatusError, type UnitRecord, updateFeature } from "./status";

export class LandRefusedError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super("land refused");
    this.reasons = reasons;
  }
}

/** What landing needs to know about the PR, read once from gh. */
export interface LandFacts {
  state: string;
  isDraft: boolean;
  mergeStateStatus: string;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  title: string;
  reviewDecision: string | null;
  author: string;
  checks: Check[];
}

/** A check on the PR's head: passed, still running, cancelled, or otherwise completed without passing (failed, timed out...). */
export interface Check {
  name: string;
  /** The GitHub Actions workflow a check run belongs to; a status has none. */
  workflow?: string;
  state: "passed" | "pending" | "failed" | "cancelled";
}

const isRed = (check: Check) => check.state === "failed" || check.state === "cancelled";
const sameCheck = (a: { name: string; workflow?: string }, b: { name: string; workflow?: string }) => a.name === b.name && a.workflow === b.workflow;
const label = (check: Check) => (check.workflow === undefined ? check.name : `${check.workflow} / ${check.name}`);

const MERGEABLE_STATES = ["CLEAN", "HAS_HOOKS"];
const PASSING = ["SUCCESS", "NEUTRAL", "SKIPPED"];
const FAILED_STATUSES = ["FAILURE", "ERROR"];

function ghJson(gh: GhRunner, cwd: string, args: string[]): unknown {
  const result = gh(args, cwd);
  if (result.code !== 0) throw new GhError(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim().split("\n")[0] ?? ""}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new GhError(`gh ${args.slice(0, 2).join(" ")} printed invalid JSON`);
  }
}

const FACT_FIELDS = "state,isDraft,mergeStateStatus,headRefOid,headRefName,baseRefName,title,reviewDecision,author,statusCheckRollup";

export function readLandFacts(gh: GhRunner, cwd: string, repo: string, pr: number): LandFacts {
  const raw = ghJson(gh, cwd, ["pr", "view", String(pr), "--repo", repo, "--json", FACT_FIELDS]) as Record<string, unknown>;
  const text = (key: string) => {
    if (typeof raw[key] !== "string") throw new GhError(`gh pr view answered without ${key}`);
    return raw[key] as string;
  };
  if (typeof raw.isDraft !== "boolean" || !Array.isArray(raw.statusCheckRollup)) throw new GhError("gh pr view answered without isDraft or statusCheckRollup");
  const author = raw.author as { login?: unknown } | null;
  return {
    state: text("state"),
    isDraft: raw.isDraft,
    mergeStateStatus: text("mergeStateStatus"),
    headRefOid: text("headRefOid"),
    headRefName: text("headRefName"),
    baseRefName: text("baseRefName"),
    title: text("title"),
    // gh prints an empty string when no review is required.
    reviewDecision: typeof raw.reviewDecision === "string" && raw.reviewDecision !== "" ? raw.reviewDecision : null,
    author: typeof author?.login === "string" ? author.login : "",
    checks: newestRuns(
      raw.statusCheckRollup.map((c: Record<string, unknown>) => {
        const started = Date.parse(String(c.startedAt));
        return { check: toCheck(c), at: started > 0 ? started : Number.POSITIVE_INFINITY };
      }),
    ),
  };
}

function toCheck(c: Record<string, unknown>): Check {
  if (c.__typename === "StatusContext") return { name: String(c.context), state: c.state === "SUCCESS" ? "passed" : FAILED_STATUSES.includes(String(c.state)) ? "failed" : "pending" };
  const named = { name: String(c.name), ...(typeof c.workflowName === "string" && c.workflowName !== "" && { workflow: c.workflowName }) };
  if (c.status !== "COMPLETED") return { ...named, state: "pending" };
  return { ...named, state: PASSING.includes(String(c.conclusion)) ? "passed" : c.conclusion === "CANCELLED" ? "cancelled" : "failed" };
}

/**
 * The rollup keeps every run of a check on the head, superseded ones included (a run cancelled when an edit re-triggered
 * its workflow); only the newest counts, as in `gh pr checks`. A run with no start time is queued, so the newest; a tie
 * keeps the one that didn't pass.
 */
function newestRuns(runs: { check: Check; at: number }[]): Check[] {
  const newest = new Map<string, { check: Check; at: number }>();
  for (const run of runs) {
    const key = `${run.check.workflow ?? ""}\0${run.check.name}`;
    const kept = newest.get(key);
    if (kept === undefined || run.at > kept.at || (run.at === kept.at && kept.check.state === "passed")) newest.set(key, run);
  }
  return [...newest.values()].map((run) => run.check);
}

/** What the base branch's protection and rulesets require of a merge: check names, and why --admin may not merge past them. */
interface Protection {
  required: string[];
  /** Every rule fbs doesn't understand, or that --admin would skip and fbs hasn't checked; empty when --admin overrides only checks. */
  problems: string[];
}

// Classic settings that can't block a squash merge fbs already checked: reviews and checks are verified, enforce_admins makes GitHub refuse --admin itself.
const CLASSIC_UNDERSTOOD = ["url", "required_status_checks", "required_pull_request_reviews", "enforce_admins", "required_linear_history", "allow_force_pushes", "allow_deletions", "block_creations", "allow_fork_syncing"];
const RULES_UNDERSTOOD = ["required_status_checks", "deletion", "non_fast_forward", "creation", "required_linear_history", "pull_request"];

/** Read the base branch's classic protection and rulesets; an allow-list, so a rule fbs doesn't know refuses --admin. */
function readProtection(gh: GhRunner, cwd: string, repo: string, base: string, reviewDecision: string | null): Protection {
  const required = new Set<string>();
  const problems: string[] = [];
  const reviewed = (what: string, parameters: Record<string, unknown>) => {
    const asks = [
      Number(parameters.required_approving_review_count ?? 0) > 0 && "approving reviews",
      (parameters.require_code_owner_review === true || parameters.require_code_owner_reviews === true) && "code owner review",
      parameters.require_last_push_approval === true && "approval of the last push",
    ].filter((ask): ask is string => typeof ask === "string");
    if (asks.length > 0 && reviewDecision !== "APPROVED") problems.push(`${what} requires ${asks.join(", ")} and the PR isn't approved`);
  };
  const classic = gh(["api", `repos/${repo}/branches/${base}/protection`], cwd);
  if (classic.code === 0) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(classic.stdout);
    } catch {
      throw new GhError(`cannot read the branch protection of ${base}`);
    }
    const checks = (p.required_status_checks ?? {}) as { contexts?: unknown; checks?: unknown };
    for (const context of [checks.contexts ?? []].flat() as unknown[]) if (typeof context === "string") required.add(context);
    for (const check of [checks.checks ?? []].flat() as { context?: unknown }[]) if (typeof check?.context === "string") required.add(check.context);
    if (p.required_pull_request_reviews) reviewed(`${base}'s branch protection`, p.required_pull_request_reviews as Record<string, unknown>);
    for (const [key, value] of Object.entries(p)) {
      const off = value === null || (typeof value === "object" && (value as { enabled?: unknown }).enabled === false);
      if (!off && !CLASSIC_UNDERSTOOD.includes(key)) problems.push(`${base}'s branch protection has ${key} on, which fbs doesn't merge past with --admin`);
    }
  } else if (!classic.stderr.includes("Branch not protected")) {
    throw new GhError(`cannot read the branch protection of ${base}`);
  }
  let ruleset: unknown;
  try {
    ruleset = ghJson(gh, cwd, ["api", `repos/${repo}/rules/branches/${base}`]);
  } catch {
    throw new GhError(`cannot read the rulesets of ${base}`);
  }
  for (const rule of Array.isArray(ruleset) ? (ruleset as { type?: unknown; parameters?: Record<string, unknown> }[]) : []) {
    const type = String(rule?.type);
    const parameters = rule?.parameters ?? {};
    if (!RULES_UNDERSTOOD.includes(type)) problems.push(`${base}'s ruleset has the rule ${type}, which fbs doesn't merge past with --admin`);
    if (type === "required_status_checks") {
      for (const check of [parameters.required_status_checks ?? []].flat() as { context?: unknown }[]) if (typeof check?.context === "string") required.add(check.context);
    }
    if (type === "pull_request") {
      if (parameters.required_review_thread_resolution === true) problems.push(`${base}'s ruleset requires conversation resolution, which fbs doesn't merge past with --admin`);
      reviewed(`${base}'s ruleset`, parameters);
    }
  }
  return { required: [...required], problems };
}

function ghLine(gh: GhRunner, cwd: string, args: string[]): string | null {
  const result = gh(args, cwd);
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * A landed feature; a landed unit also names itself and what restacking the unit above did (null when none has an open
 * PR stacked on it). `stacked`, present when there are any, is what restacking each other branch did: the units further
 * up the stack, each onto the one below, then the plain features stacked on the landed branch.
 */
export type LandResult = ({ pr: number; mergeCommit: string } | { pr: number; mergeCommit: string; slug: string; unit: number; restack: Restack | null }) & { stacked?: Restack[] };

/**
 * Land the feature's PR if everything holds; throws LandRefusedError with every reason otherwise. A feature with units
 * lands its next unit, and a unit lands only when it is the next: bottom-up.
 */
export function land(cwd: string, typed: string, gh: GhRunner, now: number, today: string): LandResult {
  if (!isSlug(typed)) throw new StatusError("bad-slug", `${JSON.stringify(typed)} must be lowercase words joined by single hyphens`);
  const commonDir = gitCommonDir(cwd);
  const slug = landTokenSlug(cwd, typed);
  // Taken before anything else, so each /fbs:land allows one attempt, refused or not.
  const token = takeLandToken(commonDir, slug, now);
  const { rec, problems } = localProblems(cwd, typed, slug);
  const local = token === null ? [`no fresh land token for ${slug}: the user types /fbs:land ${typed}`, ...problems] : problems;
  if (token !== null && rec.stamp && token.tree !== rec.stamp.tree) local.push(`${slug} was stamped again after the user typed /fbs:land; the user types it again`);
  if (local.length > 0) throw new LandRefusedError(local);
  const { pr, repo } = featurePr(cwd, slug);
  const stampTree = rec.stamp?.tree;
  const above = isUnit(rec) ? unitsOn(cwd, rec) : [];
  const stackedOn = plainFeaturesOn(cwd, rec);

  const facts = readLandFacts(gh, cwd, repo, pr);
  const reasons: string[] = [];
  if (facts.state !== "OPEN") reasons.push(`PR #${pr} is ${facts.state.toLowerCase()}`);
  if (facts.isDraft) reasons.push(`PR #${pr} is a draft`);
  // Only the user's land answer to a request made with --over-failing puts `over` in a token.
  const over = token?.over ?? [];
  const covered = (check: Check) => over.some((o) => o.state !== "missing" && sameCheck(o, check));
  const red = facts.checks.filter(isRed);
  // What the user's confirmation still applies to: red checks they confirmed, and confirmed missing ones still missing.
  const applied = over.filter((o) => (o.state === "missing" ? !facts.checks.some((c) => c.name === o.name) : red.some((c) => sameCheck(o, c))));
  const notPassed = facts.checks.filter((c) => c.state === "pending" || (isRed(c) && over.length === 0)).map(label);
  if (notPassed.length > 0) reasons.push(`checks not passed: ${notPassed.join(", ")}`);
  if (over.length > 0) for (const check of red.filter((c) => !covered(c))) reasons.push(`${label(check)} ${check.state === "cancelled" ? "was cancelled" : "failed"} and isn't in the list the user confirmed; request again`);
  if (facts.checks.length === 0) reasons.push(`no checks registered on the head of PR #${pr}`);
  const mergeable = applied.length > 0 ? [...MERGEABLE_STATES, "UNSTABLE", "BLOCKED"] : MERGEABLE_STATES;
  if (!mergeable.includes(facts.mergeStateStatus)) {
    reasons.push(`merge state is ${facts.mergeStateStatus}, not ${applied.length > 0 ? "CLEAN, HAS_HOOKS, or UNSTABLE or BLOCKED over the confirmed checks" : "CLEAN or HAS_HOOKS"}`);
  }

  const defaultBranch = ghLine(gh, cwd, ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  if (defaultBranch === null) throw new GhError(`cannot read the default branch of ${repo}`);
  if (facts.baseRefName !== defaultBranch) reasons.push(`PR #${pr} is based on ${facts.baseRefName}, not the default branch ${defaultBranch}`);

  fetchBranch(cwd, facts.headRefName);
  const headTree = commitTree(cwd, facts.headRefOid);
  if (headTree !== stampTree) reasons.push(`the PR head's tree ${headTree ?? "(missing)"} is not the stamped tree ${stampTree}; verify again`);

  const approval = approvalProblem(gh, cwd, repo, pr, facts);
  if (approval !== null) reasons.push(approval);
  // Only after fbs's own checks, approval included, held: --admin then overrides the confirmed checks and nothing else.
  const admin = reasons.length === 0 && applied.length > 0 && facts.mergeStateStatus === "BLOCKED";
  if (admin) reasons.push(...adminProblems(gh, cwd, repo, facts, over));
  if (reasons.length > 0) throw new LandRefusedError(reasons);

  // Without --subject, GitHub names a one-commit PR's squash after that commit instead of the PR title.
  const subject = `${facts.title} (#${pr})`;
  const merge = gh(["pr", "merge", String(pr), "--repo", repo, "--squash", ...(admin ? ["--admin"] : []), "--subject", subject, "--match-head-commit", facts.headRefOid], cwd);
  if (merge.code !== 0) throw new LandRefusedError([`gh pr merge failed: ${merge.stderr.trim().split("\n")[0] ?? ""}`]);
  const after = ghJson(gh, cwd, ["pr", "view", String(pr), "--repo", repo, "--json", "state,mergeCommit"]) as { state?: unknown; mergeCommit?: { oid?: unknown } | null };
  if (after.state !== "MERGED" || typeof after.mergeCommit?.oid !== "string") throw new LandRefusedError([`PR #${pr} is ${String(after.state).toLowerCase()} after gh pr merge, not merged`]);

  const commit = after.mergeCommit.oid;
  updateFeature(cwd, slug, (current) => ({ ...current, landed: { pr, repo, commit, at: today, head: facts.headRefOid, ...(applied.length > 0 && { over: applied }) } }));
  rmSync(campMarkerPath(commonDir, slug), { force: true });
  // The merge happened; a failure to mark the afk run must not report it as failed. `fbs afk stop` ends the run then.
  try {
    markLanded(cwd, slug, `PR #${pr} merged`, now);
  } catch {}
  const landed = { head: facts.headRefOid, squash: commit };
  const [restack = null, ...further] = restackUnits(cwd, gh, above, defaultBranch, landed);
  const stacked = [...further, ...stackedOn.map((feature) => restackAbove(cwd, gh, feature, defaultBranch, landed))];
  const extra = stacked.length > 0 ? { stacked } : {};
  if (!isUnit(rec)) return { pr, mergeCommit: commit, ...extra };
  try {
    if (featureUnits(cwd, rec.unitOf).every((unit) => unit.landed !== undefined)) rmSync(campMarkerPath(commonDir, rec.unitOf), { force: true });
  } catch {}
  return { pr, mergeCommit: commit, slug, unit: rec.unit, restack, ...extra };
}

/** The record `fbs land <typed>` lands, `slug`, and what refuses it before the token and GitHub are asked. */
function localProblems(cwd: string, typed: string, slug: string): { rec: FeatureRecord; problems: string[] } {
  const rec = readFeature(cwd, slug);
  if (slug === typed && !isUnit(rec) && featureUnits(cwd, slug).length > 0) throw new LandRefusedError([`no unit of ${slug} has an open PR`]);
  const problems: string[] = [];
  if (isUnit(rec)) {
    const next = nextToLand(cwd, rec.unitOf);
    if (rec.landed !== undefined) problems.push(`${slug} has landed already`);
    else if (next !== null && next.slug !== slug) problems.push(`land bottom-up: unit ${next.unit} of ${rec.unitOf}, ${next.slug}, lands before ${slug}`);
  }
  if (rec.pr === null) problems.push(`no PR recorded for ${slug}`);
  if (!rec.stamp) problems.push(`${slug} has no verify stamp`);
  return { rec, problems };
}

/**
 * Ask for a land: write the pending request the user's bare land answer turns into the land token (guardReply). A feature with
 * units requests its next unit. The model may write a request but never a token; the token binds the stamp the record
 * has when the user answers. With `overFailing`, the request also names the PR's checks that completed without passing,
 * which the user confirms with their answer; it refuses while any check still runs.
 */
export function requestLand(cwd: string, typed: string, now: number, session: string | null, overFailing?: GhRunner): LandRequest {
  if (!isSlug(typed)) throw new StatusError("bad-slug", `${JSON.stringify(typed)} must be lowercase words joined by single hyphens`);
  const slug = landTokenSlug(cwd, typed);
  const { rec, problems } = localProblems(cwd, typed, slug);
  if (!isUnit(rec) && rec.landed !== undefined) problems.push(`${slug} has landed already`);
  if (session === null || session === "") problems.push(`no Claude Code session ($CLAUDE_CODE_SESSION_ID is empty), so no answer can be matched to the request: the user types /fbs:land ${typed}`);
  // A request for another feature still waiting would be answered by an answer meant for it.
  const pending = pendingLandRequest(cwd, now);
  if (pending !== null && pending.slug !== slug) problems.push(`a land request for ${pending.slug} (PR #${pending.pr}) is waiting for the user's answer; ask again after it is answered or expires in ${Math.ceil((pending.at + REQUEST_TTL_MS - now) / 60_000)} min`);
  if (problems.length > 0 || rec.pr === null || !rec.stamp || session === null) throw new LandRefusedError(problems);
  const over = overFailing === undefined ? [] : redChecks(cwd, slug, overFailing);
  // The user may be reading the list already; a refresh may drop checks from it, never add one they weren't asked about.
  const key = (o: OverCheck) => `${o.name}\0${o.workflow ?? ""}\0${o.state}`;
  if (pending !== null && pending.slug === slug && over.some((o) => !(pending.over ?? []).some((p) => key(p) === key(o)))) {
    throw new LandRefusedError([`a land request for ${slug} with fewer failing checks is waiting for the user's answer; let it be answered or expire in ${Math.ceil((pending.at + REQUEST_TTL_MS - now) / 60_000)} min, then ask again`]);
  }
  const request = { slug, pr: rec.pr, tree: rec.stamp.tree, at: now, session, ...(over.length > 0 && { over }) };
  writeLandRequest(gitCommonDir(cwd), request);
  return request;
}

/**
 * The PR's checks that completed without passing, and the base branch's required checks that never ran (a workflow
 * cancelled before it made them); refuses while any check still runs, since it may still fail.
 */
function redChecks(cwd: string, slug: string, gh: GhRunner): OverCheck[] {
  const { pr, repo } = featurePr(cwd, slug);
  const { checks, baseRefName, reviewDecision } = readLandFacts(gh, cwd, repo, pr);
  const pending = checks.filter((c) => c.state === "pending").map(label);
  if (pending.length > 0) throw new LandRefusedError([`wait for ${pending.join(", ")} to finish`]);
  const over: OverCheck[] = [];
  for (const check of checks.filter(isRed)) {
    if (!over.some((o) => sameCheck(o, check))) over.push({ name: check.name, ...(check.workflow !== undefined && { workflow: check.workflow }), state: check.state as "failed" | "cancelled" });
  }
  let required: string[] = [];
  try {
    required = readProtection(gh, cwd, repo, baseRefName, reviewDecision).required;
  } catch (e) {
    // Without the protection the list misses only required checks that never ran; fbs land re-reads it before any --admin merge.
    if (!(e instanceof GhError)) throw e;
  }
  for (const name of required) if (!checks.some((c) => c.name === name)) over.push({ name, state: "missing" });
  return over;
}

/** Why --admin would override more than the user confirmed: not an admin, a rule fbs never overrides, or a required check that didn't run unconfirmed. */
function adminProblems(gh: GhRunner, cwd: string, repo: string, facts: LandFacts, over: OverCheck[]): string[] {
  const blocked = "merge state is BLOCKED over the confirmed checks";
  if (ghLine(gh, cwd, ["api", `repos/${repo}`, "--jq", ".permissions.admin"]) !== "true") return [`${blocked} and the gh user is not an admin of ${repo}, so it can't merge past them`];
  let protection: Protection;
  try {
    protection = readProtection(gh, cwd, repo, facts.baseRefName, facts.reviewDecision);
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    return [`${blocked}, and fbs ${e.message}, so --admin could override more than them`];
  }
  const problems = [...protection.problems];
  for (const name of protection.required) {
    if (!facts.checks.some((c) => c.name === name) && !over.some((o) => o.state === "missing" && o.name === name)) problems.push(`required check ${name} didn't run and isn't in the list the user confirmed; request again`);
  }
  return problems;
}

/** The unlanded units stacked on `unit`, lowest first: the one above when its PR is open, and each above that on the one below. */
function unitsOn(cwd: string, unit: UnitRecord): UnitRecord[] {
  const chain: UnitRecord[] = [];
  let below: UnitRecord = unit;
  for (const next of featureUnits(cwd, unit.unitOf).filter((other) => other.unit > unit.unit)) {
    const open = chain.length > 0 || (next.pr !== null && next.repo !== undefined);
    if (!open || next.landed !== undefined || next.branch === undefined || next.branch.parent !== below.branch?.name) break;
    chain.push(next);
    below = next;
  }
  return chain;
}

// A solo repo requires no review, so the user typing /fbs:land on their own PR is the approval.
function approvalProblem(gh: GhRunner, cwd: string, repo: string, pr: number, facts: LandFacts): string | null {
  if (facts.reviewDecision === "APPROVED") return null;
  if (facts.reviewDecision !== null) return `review decision is ${facts.reviewDecision}, not APPROVED`;
  const required = ghLine(gh, cwd, ["api", `repos/${repo}/branches/${facts.baseRefName}/protection/required_pull_request_reviews`, "--jq", ".required_approving_review_count"]);
  if (required !== null && Number(required) > 0) return `${facts.baseRefName} requires ${required} approving review(s) and the PR has none`;
  const viewer = ghLine(gh, cwd, ["api", "user", "--jq", ".login"]);
  if (viewer === null) throw new GhError("cannot read the authenticated gh user");
  if (facts.author !== viewer) return `PR #${pr} is by ${facts.author}, not ${viewer}, and has no approval`;
  return null;
}
