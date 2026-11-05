import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBranch as defaultBranchOf } from "./branch";
import {
  addDetachedWorktree,
  commitOf,
  commitsBeyond,
  commitTree,
  fastForward,
  fetchCommit,
  fetchOriginBranch,
  gitCommonDir,
  hasRemote,
  isAncestor,
  isWorkTreeClean,
  mergeBase,
  mergeInto,
  pushBranch,
  rebaseOnto,
  removeWorktree,
  resetHard,
  updateRef,
  worktreeOf,
} from "./git";
import type { GhRunner } from "./github";
import { campMarkerPath } from "./guard";
import { type FeatureBranch, type FeatureRecord, featureUnits, isUnit, listFeatures, readFeature, type UnitRecord, updateFeature } from "./status";

/** A unit or feature that landed below: the PR head its merge took (null when unknown) and the squash commit on the default branch. */
export interface LandedBelow {
  head: string | null;
  squash: string;
}

/**
 * Why a unit couldn't be synced or restacked, for a skill to branch on; `reason` says it for a person. `gone`: its
 * branch or origin's default branch is missing; `missing-below`: the branch it stacks on is; `not-merged-yet`: the
 * squash commit isn't on origin's default branch; `error`: an unexpected git failure during land's restack.
 */
export type StopKind = "conflict" | "dirty" | "diverged" | "gone" | "missing-below" | "not-merged-yet" | "push-rejected" | "retarget-failed" | "error";

/** What the restack of a branch stacked on a moved one did; it never fails the land. `treeChanged` is against what was verified and reviewed: the stamp, else origin's tip before the restack. */
export type Restack = { slug: string; pr: number | null; done: true; treeChanged: boolean } | { slug: string; pr: number | null; done: false; kind: StopKind; reason: string };

type Stop = { kind: StopKind; reason: string };

/**
 * Where a restack moves a branch: its commits after `upstream` replayed onto `onto` (`label` names it), unless it holds
 * `holds` already. `parent` is recorded as its new parent; `retarget` is the branch its PR is retargeted to, if any.
 */
interface Move {
  onto: string;
  label: string;
  upstream: string;
  holds: string;
  parent: string;
  retarget: string | null;
}

/** A branch's tip before and after a restack, which the branch stacked on it rebases across. */
type Moved = { from: string; to: string };

/** A restacked branch: `stop` is set when it moved but something after the push failed, which doesn't stop a branch stacked on it. */
type Restacked = { rebased: string; retargeted: boolean; stop?: Stop };

/** The move onto origin's default branch for a branch whose parent landed; a stop when the squash isn't there yet. */
function ontoDefault(cwd: string, landed: LandedBelow, defaultBranch: string, base: string): Move | Stop {
  const main = `refs/remotes/origin/${defaultBranch}`;
  if (commitOf(cwd, landed.squash) === null || !isAncestor(cwd, landed.squash, main)) return { kind: "not-merged-yet", reason: `the squash commit ${landed.squash} isn't on origin's ${defaultBranch} yet` };
  // Without the landed head, the base the branch was cut at is the closest commit known to be below its own.
  const upstream = landed.head !== null && (commitOf(cwd, landed.head) !== null || fetchCommit(cwd, landed.head)) ? landed.head : base;
  return { onto: commitOf(cwd, main) as string, label: `origin/${defaultBranch}`, upstream, holds: landed.squash, parent: defaultBranch, retarget: defaultBranch };
}

/** The move onto the branch below, `parent`, after a restack moved it. */
function ontoMoved(below: Moved, parent: string): Move {
  return { onto: below.to, label: parent, upstream: below.from, holds: below.to, parent, retarget: null };
}

/**
 * Rebase `rec`'s branch, at `tip`, as `move` says, in a temporary worktree, so merges that brought fixes up from below
 * drop out and its PR lists only its own commits. Then push it with a lease on `remote`, origin's tip read before the
 * rebase, record its new base, retarget its PR and record its new parent. A branch never pushed and without a PR is only
 * recorded; fbs push pushes it later. The local branch follows when it is at or behind `tip`. A conflict or a refused push
 * leaves the branch, here and on origin, as it was.
 */
function restackBranch(cwd: string, gh: GhRunner, rec: FeatureRecord, move: Move, tip: string, remote: string | null, local: string | null): Restacked | Stop {
  const branch = rec.branch as NonNullable<FeatureRecord["branch"]>;
  const { name } = branch;
  const follows = local !== null && isAncestor(cwd, local, tip);
  const checkout = follows ? worktreeOf(cwd, name) : null;
  if (checkout !== null && !isWorkTreeClean(checkout)) return { kind: "dirty", reason: `${name} is checked out at ${checkout} with uncommitted changes; commit or stash them, then sync again` };

  let rebased = tip;
  if (!isAncestor(cwd, move.holds, tip)) {
    const result = inTempWorktree(cwd, tip, (work) => (rebaseOnto(work, move.onto, move.upstream, tip) ? (commitOf(work, "HEAD") as string) : null));
    if (result === null) return { kind: "conflict", reason: `rebasing ${name} onto ${move.label} conflicts; ${name} is left as it was, rebase it by hand` };
    rebased = result;
  }

  const published = rec.pr !== null || branch.pushed !== undefined;
  if (published && pushBranch(cwd, name, rebased, remote ?? "") === "rejected") return { kind: "push-rejected", reason: `origin's ${name} moved during the restack; nothing was pushed` };
  const problems: Stop[] = [];
  if (follows && rebased !== local) {
    if (checkout === null) updateRef(cwd, `refs/heads/${name}`, rebased, local as string);
    // A change made in the checkout while the rebase or push ran would be lost to the reset.
    else if (!isWorkTreeClean(checkout)) problems.push({ kind: "dirty", reason: `${checkout} changed during the restack, so ${name} there was left at its old tip; git stash, then git reset --hard origin/${name}, then git stash pop` });
    else resetHard(checkout, rebased);
  }
  const base = mergeBase(cwd, rebased, move.onto) as string;
  updateFeature(cwd, rec.slug, (current) => (current.branch?.name === name ? { ...current, branch: { ...current.branch, base, ...(published && { pushed: rebased }) } } : current));

  const retarget = move.retarget !== null && rec.pr !== null && rec.repo !== undefined && rec.landed === undefined;
  const edit = retarget ? gh(["pr", "edit", String(rec.pr), "--repo", rec.repo as string, "--base", move.retarget as string], cwd) : null;
  if (edit !== null && edit.code !== 0) {
    problems.unshift({ kind: "retarget-failed", reason: `pushed ${name}, but gh pr edit could not retarget PR #${rec.pr} to ${move.retarget}: ${edit.stderr.trim().split("\n")[0] ?? ""}` });
  } else {
    // The parent waits for the retarget: until it is recorded, the next sync takes this path again and retries it.
    updateFeature(cwd, rec.slug, (current) => (current.branch?.name === name ? { ...current, branch: { ...current.branch, parent: move.parent } } : current));
  }
  const stop = problems.length === 0 ? undefined : { kind: problems[0].kind, reason: problems.map((p) => p.reason).join("; ") };
  return { rebased, retargeted: retarget && edit?.code === 0, ...(stop && { stop }) };
}

/** Run `body` in a temporary worktree detached at `commit`, then remove it. */
export function inTempWorktree<T>(cwd: string, commit: string, body: (work: string) => T): T {
  const temp = mkdtempSync(join(tmpdir(), "fbs-stack-"));
  const work = join(temp, "work");
  try {
    addDetachedWorktree(cwd, work, commit);
    return body(work);
  } finally {
    try {
      removeWorktree(cwd, work);
    } catch {}
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Restack `rec` as `plan` says from its local tip when that holds origin's, else origin's, both read fresh. */
function restackFromOrigin(cwd: string, gh: GhRunner, rec: FeatureRecord, defaultBranch: string, plan: (base: string) => Move | Stop): { restack: Restack; moved: Moved | null } {
  const { slug, pr } = rec;
  const fail = (stop: Stop) => ({ restack: { slug, pr, done: false as const, ...stop }, moved: null });
  if (rec.branch === undefined) return fail({ kind: "gone", reason: `no branch recorded for ${slug}` });
  const { name } = rec.branch;
  try {
    if (!fetchOriginBranch(cwd, defaultBranch)) return fail({ kind: "gone", reason: `origin has no branch ${defaultBranch}` });
    const remote = fetchOriginBranch(cwd, name) ? commitOf(cwd, `refs/remotes/origin/${name}`) : null;
    const local = commitOf(cwd, `refs/heads/${name}`);
    if (remote === null && (rec.pr !== null || rec.branch.pushed !== undefined)) return fail({ kind: "gone", reason: `origin has no branch ${name}` });
    if (remote !== null && local !== null && !isAncestor(cwd, remote, local) && !isAncestor(cwd, local, remote)) {
      return fail({ kind: "diverged", reason: `diverged: ${name} and origin/${name} each have commits the other lacks; merge origin/${name} into it by hand, then sync again` });
    }
    const tip = remote !== null && (local === null || !isAncestor(cwd, remote, local)) ? remote : local;
    if (tip === null) return fail({ kind: "gone", reason: `branch ${name} is gone: not here and not on origin` });
    const move = plan(rec.branch.base);
    if ("kind" in move) return fail(move);
    const result = restackBranch(cwd, gh, rec, move, tip, remote, local);
    if ("kind" in result) return fail(result);
    const moved = { from: tip, to: result.rebased };
    if (result.stop !== undefined) return { restack: { slug, pr, done: false, ...result.stop }, moved };
    return { restack: { slug, pr, done: true, treeChanged: commitTree(cwd, result.rebased) !== (rec.stamp?.tree ?? commitTree(cwd, remote ?? tip)) }, moved };
  } catch (e) {
    return fail({ kind: "error", reason: (e as Error).message.split("\n")[0] });
  }
}

/** Restack a plain feature stacked on a branch that just landed onto the default branch, without touching the user's work. */
export function restackAbove(cwd: string, gh: GhRunner, rec: FeatureRecord, defaultBranch: string, landed: LandedBelow): Restack {
  return restackFromOrigin(cwd, gh, rec, defaultBranch, (base) => ontoDefault(cwd, landed, defaultBranch, base)).restack;
}

/**
 * Restack the units above one that just landed, lowest first: the first onto the default branch, each next onto the
 * one below it as restacked. It stops after the first unit it couldn't move; the ones above it are left as they were.
 */
export function restackUnits(cwd: string, gh: GhRunner, units: UnitRecord[], defaultBranch: string, landed: LandedBelow): Restack[] {
  const restacks: Restack[] = [];
  let below: Moved | null = null;
  for (const unit of units) {
    let step: { restack: Restack; moved: Moved | null };
    if (below === null) step = restackFromOrigin(cwd, gh, unit, defaultBranch, (base) => ontoDefault(cwd, landed, defaultBranch, base));
    else {
      const moved = below;
      step = restackFromOrigin(cwd, gh, unit, defaultBranch, () => ontoMoved(moved, unit.branch?.parent as string));
    }
    restacks.push(step.restack);
    if (step.moved === null) break;
    below = step.moved;
  }
  return restacks;
}

/** What `fbs stack sync` did to one unit. */
export interface SyncedUnit {
  slug: string;
  unit: number;
  fastForwarded: boolean;
  /** What the unit was merged with or rebased onto: the branch below it, or origin's default branch; null when it already held it. */
  merged: string | null;
  /** Against the unit's stamp, else origin's tip before the sync, else the local one. */
  treeChanged: boolean;
  retargeted: boolean;
  /** It has a PR or a recorded push and origin's copy isn't its tip. */
  pushNeeded: boolean;
  done: boolean;
  kind?: StopKind;
  reason?: string;
}

/**
 * A record whose PR sync found merged or closed without fbs land. `landed`: merged into the default branch, now recorded
 * as landed, with `stacked` what restacking each plain feature cut from its branch did; `closed`: closed unmerged, left
 * as it was; `merged-elsewhere`: merged into another branch, left as it was; `gh-failed`: gh couldn't tell, so nothing
 * was recorded.
 */
export interface Outside {
  slug: string;
  pr: number;
  kind: "landed" | "closed" | "merged-elsewhere" | "gh-failed";
  reason: string;
  stacked?: Restack[];
}

/** What `fbs stack sync` did; `restack` is set for a plain feature: what restacking it did, null when nothing was due. */
export interface SyncResult {
  units: SyncedUnit[];
  outside: Outside[];
  restack?: Restack | null;
}

/**
 * Keep every unlanded unit of a feature holding the tip of the unit below it, bottom-up; a unit's slug stands for its
 * feature. A unit whose PR was merged outside fbs land is recorded as landed first. A unit still stacked on a landed
 * unit is rebased onto the default branch, pushed and retargeted, and the units above it are rebased onto it in turn;
 * a unit whose parent is the default branch is only fast-forwarded. It stops at the first unit it can't sync, and
 * before the first unit with no branch yet. A feature without units is synced as a plain feature (syncPlain).
 */
export function syncStack(cwd: string, slug: string, gh: GhRunner, today: string): SyncResult {
  const rec = readFeature(cwd, slug);
  const feature = isUnit(rec) ? rec.unitOf : slug;
  const main = defaultBranchOf(cwd);
  if (featureUnits(cwd, feature).length === 0) return syncPlain(cwd, gh, rec, main, today);
  const outside = featureUnits(cwd, feature).flatMap((unit) => noticeLanding(cwd, gh, unit, main, today) ?? []);
  const units = featureUnits(cwd, feature);
  if (hasRemote(cwd, "origin")) {
    fetchOriginBranch(cwd, main);
    for (const unit of units) if (unit.landed === undefined && unit.branch !== undefined) fetchOriginBranch(cwd, unit.branch.name);
  }
  const synced: SyncedUnit[] = [];
  let below: FeatureRecord | null = null;
  let moved: Moved | null = null;
  const landedHeads = units.flatMap((unit) => (unit.landed?.head === undefined ? [] : [unit.landed.head]));
  for (const unit of units) {
    if (unit.landed !== undefined) {
      below = unit;
      continue;
    }
    if (unit.branch === undefined) break;
    const result = syncUnit(cwd, gh, unit, below, moved, main, landedHeads);
    synced.push(result.unit);
    if (!result.unit.done && result.moved === null) break;
    below = readFeature(cwd, unit.slug);
    moved = result.moved;
  }
  return { units: synced, outside };
}

/**
 * A plain feature: its own PR merged outside fbs land is recorded as landed first, restacking what was cut from it.
 * One cut from another feature's branch is, once that feature landed (by fbs land, or merged outside it and recorded
 * here), restacked onto the default branch as land would have. Otherwise there is nothing to do.
 */
function syncPlain(cwd: string, gh: GhRunner, rec: FeatureRecord, main: string, today: string): SyncResult {
  const own = noticeLanding(cwd, gh, rec, main, today);
  const nothing = { units: [], outside: own === null ? [] : [own], restack: null };
  const parentName = rec.branch?.parent;
  if (rec.landed !== undefined || own?.kind === "landed" || parentName === undefined || parentName === null || parentName === main) return nothing;
  const parent = listFeatures(cwd, () => {}).find((other) => other.slug !== rec.slug && other.branch?.name === parentName);
  if (parent === undefined) return nothing;
  const found = parent.landed === undefined ? noticeLanding(cwd, gh, parent, main, today) : null;
  const outside = [...nothing.outside, ...(found === null ? [] : [found])];
  const landed = readFeature(cwd, parent.slug).landed;
  if (landed === undefined) return { ...nothing, outside };
  const restack = found?.stacked?.find((other) => other.slug === rec.slug) ?? restackAbove(cwd, gh, rec, main, { head: landed.head ?? null, squash: landed.commit });
  return { units: [], outside, restack };
}

/**
 * Ask gh about `rec`'s PR when it hasn't landed; one merged into the default branch is recorded as landed `by:
 * "outside"`, its camp markers removed and the plain features cut from its branch restacked, as land does. Null when
 * there is no PR to ask about or it is open.
 */
function noticeLanding(cwd: string, gh: GhRunner, rec: FeatureRecord, main: string, today: string): Outside | null {
  if (rec.landed !== undefined || rec.pr === null || rec.repo === undefined) return null;
  const { slug, pr, repo } = rec;
  const note = (kind: Outside["kind"], reason: string): Outside => ({ slug, pr, kind, reason });
  const result = gh(["pr", "view", String(pr), "--repo", repo, "--json", "state,headRefOid,mergeCommit,baseRefName"], cwd);
  let view: { state?: unknown; headRefOid?: unknown; mergeCommit?: { oid?: unknown } | null; baseRefName?: unknown };
  try {
    if (result.code !== 0) throw new Error(result.stderr.trim().split("\n")[0] ?? "");
    view = JSON.parse(result.stdout);
  } catch (e) {
    return note("gh-failed", `gh pr view could not read PR #${pr}, so whether it was merged is unknown: ${(e as Error).message}`);
  }
  if (view.state === "CLOSED") return note("closed", `PR #${pr} was closed without merging; ${slug} is left as it was`);
  if (view.state !== "MERGED") return null;
  if (view.baseRefName !== main) return note("merged-elsewhere", `PR #${pr} was merged into ${String(view.baseRefName)}, not ${main}; ${slug} is left as it was`);
  const head = view.headRefOid;
  const commit = view.mergeCommit?.oid;
  if (typeof head !== "string" || typeof commit !== "string") return note("gh-failed", `gh pr view answered without the head or merge commit of PR #${pr}; nothing was recorded`);

  const dropped = rec.branch === undefined ? 0 : droppedCommits(cwd, rec.branch, head, main);
  updateFeature(cwd, slug, (current) => ({ ...current, landed: { pr, repo, commit, at: today, head, by: "outside" } }));
  const commonDir = gitCommonDir(cwd);
  rmSync(campMarkerPath(commonDir, slug), { force: true });
  if (isUnit(rec) && featureUnits(cwd, rec.unitOf).every((unit) => unit.landed !== undefined)) rmSync(campMarkerPath(commonDir, rec.unitOf), { force: true });
  const warning = dropped === 0 ? "" : `; warning: ${dropped} commit${dropped === 1 ? "" : "s"} on ${rec.branch?.name} ${dropped === 1 ? "isn't" : "aren't"} in the merged head, so ${dropped === 1 ? "it" : "they"} didn't land`;
  const landed = note("landed", `PR #${pr} was merged outside fbs land; recorded ${slug} as landed at ${commit}${warning}`);
  const stacked = plainFeaturesOn(cwd, rec).map((feature) => restackAbove(cwd, gh, feature, main, { head, squash: commit }));
  return stacked.length === 0 ? landed : { ...landed, stacked };
}

/**
 * The most commits the branch's local tip or its last fbs push has that neither the merged `head` nor origin's default
 * branch holds; merges, such as camp's of the default branch, don't count.
 */
function droppedCommits(cwd: string, branch: FeatureBranch, head: string, main: string): number {
  if (commitOf(cwd, head) === null && !fetchCommit(cwd, head)) return 0;
  const mainRef = `refs/remotes/origin/${main}`;
  const excluded = fetchOriginBranch(cwd, main) ? [head, mainRef] : [head];
  const tips = [commitOf(cwd, `refs/heads/${branch.name}`), branch.pushed ?? null].filter((tip): tip is string => tip !== null && commitOf(cwd, tip) !== null);
  return Math.max(0, ...tips.map((tip) => commitsBeyond(cwd, tip, excluded)));
}

/** The unlanded plain features, neither units nor split into units, whose branch was cut from `rec`'s. */
export function plainFeaturesOn(cwd: string, rec: FeatureRecord): FeatureRecord[] {
  const name = rec.branch?.name;
  if (name === undefined) return [];
  const all = listFeatures(cwd, () => {});
  const split = new Set(all.filter(isUnit).map((unit) => unit.unitOf));
  return all.filter((other) => !isUnit(other) && !split.has(other.slug) && other.landed === undefined && other.branch?.parent === name);
}

/** The ref for `branch`: origin's default branch first, any other branch's local tip first; null when neither exists. */
function branchRef(cwd: string, branch: string, main: string): { ref: string; label: string } | null {
  const refs = branch === main ? [`refs/remotes/origin/${main}`, `refs/heads/${main}`] : [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`];
  const ref = refs.find((candidate) => commitOf(cwd, candidate) !== null);
  return ref === undefined ? null : { ref, label: ref.replace(/^refs\/(heads|remotes)\//, "") };
}

/**
 * `movedBelow` is how this run restacked the unit below, which a unit stacked on it rebases across; `landedHeads` are the
 * pre-squash heads of the feature's landed units.
 */
function syncUnit(cwd: string, gh: GhRunner, unit: UnitRecord, below: FeatureRecord | null, movedBelow: Moved | null, main: string, landedHeads: string[]): { unit: SyncedUnit; moved: Moved | null } {
  const name = (unit.branch as NonNullable<UnitRecord["branch"]>).name;
  const result: SyncedUnit = { slug: unit.slug, unit: unit.unit, fastForwarded: false, merged: null, treeChanged: false, retargeted: false, pushNeeded: false, done: false };
  const stop = (kind: StopKind, reason: string) => ({ unit: { ...result, kind, reason }, moved: null });
  const ref = `refs/heads/${name}`;
  const remote = commitOf(cwd, `refs/remotes/origin/${name}`);
  let local = commitOf(cwd, ref);
  if (local === null && remote === null) return stop("gone", `branch ${name} is gone: not here and not on origin`);
  const startTree = unit.stamp?.tree ?? commitTree(cwd, (remote ?? local) as string);
  const checkout = worktreeOf(cwd, name);
  const dirty = `${name} is checked out at ${checkout} with uncommitted changes; commit or stash them, then sync again`;

  if (remote !== null && local !== remote) {
    if (local !== null && !isAncestor(cwd, local, remote)) {
      if (!isAncestor(cwd, remote, local)) return stop("diverged", `diverged: ${name} and origin/${name} each have commits the other lacks; merge origin/${name} into it by hand`);
    } else {
      if (local === null) updateRef(cwd, ref, remote, "");
      else if (checkout === null) updateRef(cwd, ref, remote, local);
      else if (!isWorkTreeClean(checkout)) return stop("dirty", dirty);
      else fastForward(checkout, remote);
      local = remote;
      result.fastForwarded = true;
    }
  }
  const tip = local as string;

  const parent = unit.branch?.parent ?? main;
  const onBelow = below?.branch !== undefined && parent === below.branch.name;
  let move: Move | Stop | null = null;
  if (onBelow && below?.landed !== undefined) move = ontoDefault(cwd, { head: below.landed.head ?? null, squash: below.landed.commit }, main, (unit.branch as NonNullable<UnitRecord["branch"]>).base);
  else if (onBelow && movedBelow !== null && movedBelow.from !== movedBelow.to) move = ontoMoved(movedBelow, parent);
  if (move !== null) {
    if ("kind" in move) return stop(move.kind, move.reason);
    const restacked = restackBranch(cwd, gh, unit, move, tip, remote, tip);
    if ("kind" in restacked) return stop(restacked.kind, restacked.reason);
    const moved = { from: tip, to: restacked.rebased };
    const after = { ...result, merged: restacked.rebased === tip ? null : move.label, treeChanged: commitTree(cwd, restacked.rebased) !== startTree, retargeted: restacked.retargeted };
    return { unit: restacked.stop === undefined ? { ...after, done: true } : { ...after, ...restacked.stop }, moved };
  }

  // The default branch moving under an open PR is camp's to merge; merging it here would stale every stamp in the stack.
  const holds = parent === main ? null : below !== null && below.landed === undefined ? (below.branch?.name ?? parent) : parent;
  const target = holds === null ? null : branchRef(cwd, holds, main);
  if (holds !== null && target === null) return stop("missing-below", `can't find the branch ${name} stacks on`);
  let synced = tip;
  if (target !== null && !isAncestor(cwd, target.ref, tip)) {
    // Merging a restacked unit into one still on its old tip would bring every pre-squash commit back into the PR.
    if (landedHeads.some((head) => commitOf(cwd, head) !== null && isAncestor(cwd, head, tip) && !isAncestor(cwd, head, target.ref))) {
      return stop("diverged", `${name} still holds the history ${target.label} had before it was restacked onto ${main}; rebase ${name} onto ${target.label} by hand`);
    }
    if (checkout !== null && !isWorkTreeClean(checkout)) return stop("dirty", dirty);
    const merge = (work: string) => (mergeInto(work, target.ref) ? (commitOf(work, "HEAD") as string) : null);
    const merged = checkout !== null ? merge(checkout) : inTempWorktree(cwd, tip, merge);
    if (merged === null) return stop("conflict", `merging ${target.label} into ${name} conflicts; ${name} is left as it was, merge it by hand`);
    if (checkout === null) updateRef(cwd, ref, merged, tip);
    synced = merged;
    result.merged = target.label;
  }
  result.treeChanged = commitTree(cwd, synced) !== startTree;
  result.pushNeeded = (unit.pr !== null || unit.branch?.pushed !== undefined) && commitOf(cwd, `refs/remotes/origin/${name}`) !== synced;
  return { unit: { ...result, done: true }, moved: null };
}
