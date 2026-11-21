import { rmSync } from "node:fs";
import { markLanded } from "./afk";
import { campMarkerPath, freshToken, isSlug, type LandRequest, landTokenPath, landTokenSlug, pendingLandRequest, writeLandRequest } from "./guard";
import { commitTree, fetchBranch, gitCommonDir } from "./git";
import { GhError, type GhRunner, newestRuns } from "./github";
import { plainFeaturesOn, type Restack, restackAbove, restackUnits } from "./stack";
import { type FeatureRecord, type OverCheck, featurePr, featureUnits, isUnit, listFeatures, nextToLand, readFeature, StatusError, type UnitRecord, updateFeature } from "./status";

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
const UNKNOWN_REREADS = 5;
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
        const check = toCheck(c);
        const completed = check.state !== "pending";
        // gh's JSON has no run id, so a tie in start time goes to the run that completed last, or the one still going.
        const completedAt = Date.parse(typeof c.completedAt === "string" ? c.completedAt : "");
        const order = !completed ? Number.POSITIVE_INFINITY : completedAt > 0 ? completedAt : null;
        return { check, workflow: check.workflow ?? null, startedAt: typeof c.startedAt === "string" ? c.startedAt : null, completed, order, passed: check.state === "passed" };
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
  } else {
    // A free private repo can't have classic protection at all, so GitHub answers 403 "Upgrade to GitHub Pro".
    const unprotected = classic.stderr.includes("Branch not protected") || classic.stderr.includes("Upgrade to GitHub Pro");
    if (!unprotected) throw new GhError(`cannot read the branch protection of ${base}`);
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
export type LandResult = (({ pr: number; mergeCommit: string } | { pr: number; mergeCommit: string; slug: string; unit: number; restack: Restack | null }) & { stacked?: Restack[]; checks?: "none" }) | { stack: StackLanding };

/** One open PR of a GitHub stack, lowest first: whether fbs would land it (`reasons` when not), and its record's slug if fbs has one. */
export interface StackPr {
  pr: number;
  slug: string | null;
  ready: boolean;
  reasons?: string[];
}

/**
 * A PR in a GitHub stack with other open PRs isn't merged by fbs: GitHub merges the stack in one step and restacks what
 * is left, so the user runs `command`, which merges every PR up to `upTo`, the highest ready one with only ready PRs below.
 */
export interface StackLanding {
  number: number;
  prs: StackPr[];
  upTo: number;
  command: string;
}

/** A GitHub stack as its GraphQL `stack` field reads: its number, base, and every PR in it with its position. */
interface NativeStack {
  number: number;
  baseRefName: string;
  entries: { position: number; pr: number; state: string }[];
}

const STACK_QUERY = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){stack{number baseRefName entries(first:100){nodes{position pullRequest{number state}}}}}}}";

/**
 * The GitHub stack `pr` belongs to; null when it belongs to none, or the server has no stacks (an older GitHub Enterprise).
 * Any other failure throws: guessing "no stack" would merge one PR out of a stack.
 */
export function readNativeStack(gh: GhRunner, cwd: string, repo: string, pr: number): NativeStack | null {
  const [owner, name] = repo.split("/");
  const result = gh(["api", "graphql", "-f", `query=${STACK_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr}`], cwd);
  if (result.code !== 0) {
    if (/Field '(?:stack|entries)' doesn't exist|undefinedField/.test(result.stderr + result.stdout)) return null;
    throw new GhError(`cannot read whether PR #${pr} is in a GitHub stack: ${result.stderr.trim().split("\n")[0] ?? ""}`);
  }
  try {
    const stack = JSON.parse(result.stdout)?.data?.repository?.pullRequest?.stack;
    if (typeof stack?.number !== "number" || typeof stack.baseRefName !== "string" || !Array.isArray(stack.entries?.nodes)) return null;
    const entries = (stack.entries.nodes as { position?: unknown; pullRequest?: { number?: unknown; state?: unknown } | null }[])
      .filter((node) => typeof node?.position === "number" && typeof node.pullRequest?.number === "number")
      .map((node) => ({ position: node.position as number, pr: node.pullRequest?.number as number, state: String(node.pullRequest?.state) }))
      .sort((a, b) => a.position - b.position);
    return { number: stack.number, baseRefName: stack.baseRefName, entries };
  } catch {
    return null;
  }
}

/** The stack `pr` is in when it holds another open PR, the only case where landing it alone would split the stack. */
function openStack(gh: GhRunner, cwd: string, repo: string, pr: number): NativeStack | null {
  const stack = readNativeStack(gh, cwd, repo, pr);
  return stack !== null && stack.entries.filter((entry) => entry.state === "OPEN").length > 1 ? stack : null;
}

/** What fbs would check before merging each open PR of the stack, bottom-up; refuses when the bottom one isn't ready. */
function stackLanding(cwd: string, gh: GhRunner, repo: string, stack: NativeStack): StackLanding {
  const defaultBranch = ghLine(gh, cwd, ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  if (defaultBranch === null) throw new GhError(`cannot read the default branch of ${repo}`);
  if (stack.baseRefName !== defaultBranch) throw new LandRefusedError([`GitHub stack #${stack.number} is based on ${stack.baseRefName}, not the default branch ${defaultBranch}`]);
  const records = listFeatures(cwd, () => {}).filter((rec) => rec.pr !== null && rec.repo === repo && rec.landed === undefined);
  const prs: StackPr[] = stack.entries
    .filter((entry) => entry.state === "OPEN")
    .map(({ pr }) => {
      const rec = records.find((candidate) => candidate.pr === pr);
      if (rec === undefined) return { pr, slug: null, ready: false, reasons: ["it has no fbs record, so fbs hasn't verified it"] };
      // Every PR of a stack merges into its base, so each must meet the base's rules, not the branch below's.
      const facts = { ...readLandFacts(gh, cwd, repo, pr), baseRefName: defaultBranch };
      const reasons: string[] = [];
      if (facts.isDraft) reasons.push("it's a draft");
      const notPassed = facts.checks.filter((c) => c.state !== "passed").map(label);
      if (notPassed.length > 0) reasons.push(`checks not passed: ${notPassed.join(", ")}`);
      if (facts.checks.length === 0) {
        const none = noChecksProblem(gh, cwd, repo, pr, facts, []);
        if (none !== null) reasons.push(none);
      }
      fetchBranch(cwd, facts.headRefName);
      const headTree = commitTree(cwd, facts.headRefOid);
      if (headTree !== rec.stamp?.tree) reasons.push(`its head's tree ${headTree ?? "(missing)"} is not the stamped tree ${rec.stamp?.tree ?? "(none)"}; verify ${rec.slug} again`);
      const approval = approvalProblem(gh, cwd, repo, pr, facts);
      if (approval !== null) reasons.push(approval);
      return reasons.length === 0 ? { pr, slug: rec.slug, ready: true } : { pr, slug: rec.slug, ready: false, reasons };
    });
  const firstNotReady = prs.findIndex((p) => !p.ready);
  if (firstNotReady === 0) throw new LandRefusedError((prs[0].reasons ?? []).map((reason) => `PR #${prs[0].pr}: ${reason}`));
  const upTo = prs[firstNotReady === -1 ? prs.length - 1 : firstNotReady - 1].pr;
  return { number: stack.number, prs, upTo, command: `gh stack merge ${upTo} --squash` };
}

/** Why a PR with no checks at all can't land: the base requires some that never ran (and the user didn't confirm), or fbs can't tell. */
function noChecksProblem(gh: GhRunner, cwd: string, repo: string, pr: number, facts: LandFacts, over: OverCheck[]): string | null {
  let required: string[];
  try {
    required = readProtection(gh, cwd, repo, facts.baseRefName, facts.reviewDecision).required;
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    return `no checks ran on PR #${pr}, and fbs ${e.message}, so it can't tell whether ${facts.baseRefName} requires any`;
  }
  const unconfirmed = required.filter((name) => !over.some((o) => o.state === "missing" && o.name === name));
  return unconfirmed.length === 0 ? null : `no checks ran on PR #${pr}, and ${facts.baseRefName} requires ${unconfirmed.join(", ")}`;
}

/**
 * Land the feature's PR if everything holds; throws LandRefusedError with every reason otherwise. A feature with units
 * lands its next unit, and a unit lands only when it is the next: bottom-up.
 */
export function land(cwd: string, typed: string, gh: GhRunner, now: number, today: string, session: string | null = null, sleep: (ms: number) => void = () => {}): LandResult {
  if (!isSlug(typed)) throw new StatusError("bad-slug", `${JSON.stringify(typed)} must be lowercase words joined by single hyphens`);
  const commonDir = gitCommonDir(cwd);
  const slug = landTokenSlug(cwd, typed);
  // Used up only by a merge attempt: a refusal (a check still running) keeps the user's go for this verified tree.
  const token = freshToken(commonDir, slug, now);
  const { rec, problems } = localProblems(cwd, typed, slug);
  const local = token === null ? [`no fresh land token for ${slug}: the user asks you to land it (or types /fbs:land ${typed})`, ...problems] : problems;
  if (token !== null && rec.stamp && token.tree !== rec.stamp.tree) local.push(`${slug} was stamped again after the user asked to land it; ask them again`);
  if (token?.session !== undefined && token.session !== session) local.push(`the user asked to land ${slug} in another Claude Code session; ask them again here`);
  if (local.length > 0) throw new LandRefusedError(local);
  const { pr, repo } = featurePr(cwd, slug);
  const stack = openStack(gh, cwd, repo, pr);
  if (stack !== null) return { stack: stackLanding(cwd, gh, repo, stack) };
  const stampTree = rec.stamp?.tree;
  const above = isUnit(rec) ? unitsOn(cwd, rec) : [];
  const stackedOn = plainFeaturesOn(cwd, rec);

  let facts = readLandFacts(gh, cwd, repo, pr);
  // GitHub computes mergeability lazily, so UNKNOWN right after a push or a merge into the base usually settles in seconds.
  for (let reread = 0; reread < UNKNOWN_REREADS && facts.mergeStateStatus === "UNKNOWN"; reread++) {
    sleep(3000);
    facts = readLandFacts(gh, cwd, repo, pr);
  }
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
  // A repo with no CI, the base requiring no check, lands on the verify stamp alone: the head is the tree verify passed.
  const noChecks = facts.checks.length === 0;
  if (noChecks) {
    const none = noChecksProblem(gh, cwd, repo, pr, facts, over);
    if (none !== null) reasons.push(none);
  }
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
  rmSync(landTokenPath(commonDir, slug), { force: true });
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
  const extra = { ...(stacked.length > 0 && { stacked }), ...(noChecks && { checks: "none" as const }) };
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
 * Ask for a land: write the pending request the user's yes turns into the land token (guardReply). A feature with
 * units requests its next unit. The model may write a request but never a token; the token binds the stamp the record
 * has when the user answers. With `overFailing`, the request also names the PR's checks that completed without passing,
 * which the user confirms with their answer; it refuses while any check still runs.
 */
export function requestLand(cwd: string, typed: string, now: number, session: string | null, gh?: GhRunner, overFailing = false): LandRequest | { stack: StackLanding } {
  if (!isSlug(typed)) throw new StatusError("bad-slug", `${JSON.stringify(typed)} must be lowercase words joined by single hyphens`);
  const slug = landTokenSlug(cwd, typed);
  const { rec, problems } = localProblems(cwd, typed, slug);
  if (!isUnit(rec) && rec.landed !== undefined) problems.push(`${slug} has landed already`);
  if (session === null || session === "") problems.push(`no Claude Code session ($CLAUDE_CODE_SESSION_ID is empty), so no answer can be matched to the request: the user asks you to land it, or types /fbs:land ${typed}`);
  // A request for another feature still waiting would be answered by an answer meant for it.
  const pending = pendingLandRequest(cwd, now);
  if (pending !== null && pending.slug !== slug) problems.push(`a land request for ${pending.slug} (PR #${pending.pr}) is waiting for the user's answer; ask again after they reply`);
  if (problems.length > 0 || rec.pr === null || !rec.stamp || session === null) throw new LandRefusedError(problems);
  // Nothing to answer in a GitHub stack: the user merges it with GitHub's command, which needs no land token.
  const stack = gh === undefined || rec.repo === undefined ? null : openStack(gh, cwd, rec.repo, rec.pr);
  if (stack !== null && gh !== undefined && rec.repo !== undefined) return { stack: stackLanding(cwd, gh, rec.repo, stack) };
  const over = overFailing && gh !== undefined ? redChecks(cwd, slug, gh) : [];
  // The user may be reading the list already; a refresh may drop checks from it, never add one they weren't asked about.
  const key = (o: OverCheck) => `${o.name}\0${o.workflow ?? ""}\0${o.state}`;
  if (pending !== null && pending.slug === slug && over.some((o) => !(pending.over ?? []).some((p) => key(p) === key(o)))) {
    throw new LandRefusedError([`a land request for ${slug} with fewer failing checks is waiting for the user's answer; ask again after they reply`]);
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
